"""
Recipe API — ingestion upload, status polling, review, confirm, and list endpoints.

Ingest flow:
  POST /ingest              → upload images, queue job, return job_id
  GET  /ingest/{id}/status  → poll for QUEUED / PROCESSING / REVIEW / COMPLETE / FAILED
  GET  /ingest/{id}/review  → fetch parsed recipe draft for user confirmation
  POST /ingest/confirm/{id} → submit confirmed (possibly edited) recipe → insert to DB
"""
import json
import logging
import urllib.parse
import uuid
from pathlib import Path

from arq import create_pool
from arq.connections import RedisSettings
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models.ingest import IngestJob, IngestStatus, LlmOutput
from app.models.recipe import Recipe
from app.schemas.ingest import (
    IngestConfirmRequest,
    IngestReviewPayload,
    IngestStatusResponse,
    UrlImportRequest,
)
from app.schemas.recipe import Recipe as RecipeSchema, RecipeCreate, RecipeSummary, RecipeUpdate
from pydantic import BaseModel
from app.services.images import crop_image, rotate_image, save_manual_photo
from app.services.ingestion import (
    confirm_recipe,
    save_images,
    run_url_ingestion,
    DuplicateRecipeError,
    _URL_IMPORT_PLACEHOLDER,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/recipes", tags=["recipes"])

_RECIPES_DIR = Path("/data/recipes")


def _redis_settings() -> RedisSettings:
    parsed = urllib.parse.urlparse(settings.redis_url)
    return RedisSettings(
        host=parsed.hostname or "localhost",
        port=parsed.port or 6379,
        password=parsed.password,
        database=int(parsed.path.lstrip("/") or "0"),
    )


# ── Ingest ────────────────────────────────────────────────────────────────────

@router.post("/ingest", status_code=status.HTTP_202_ACCEPTED)
async def ingest_recipe(
    images: list[UploadFile] = File(..., description="1 or 2 recipe card images (JPEG/PNG)"),
    kit_brand: str = Form("auto", description="Meal kit brand hint: auto, hellofresh, gousto, dinnerly, everyplate, mindfulchef"),
    db: AsyncSession = Depends(get_db),
):
    """
    Upload recipe card image(s). Saves images to disk, creates an IngestJob,
    and enqueues background LLM processing. Returns the job_id for polling.
    """
    if not images:
        raise HTTPException(status_code=400, detail="At least one image is required")
    if len(images) > 2:
        raise HTTPException(status_code=400, detail="Maximum 2 images per recipe card")

    # Create the DB record first to get a job_id for the image directory name
    job = IngestJob(image_dir="")  # placeholder; updated after images are saved
    db.add(job)
    await db.flush()

    job_dir = await save_images(images, job.id, _RECIPES_DIR)
    job.image_dir = str(job_dir)
    await db.commit()

    # Enqueue the arq background task
    try:
        pool = await create_pool(_redis_settings())
        await pool.enqueue_job("task_process_ingest_job", str(job.id), kit_brand=kit_brand)
        await pool.aclose()
    except Exception as exc:
        logger.error(
            "failed to enqueue ingest job",
            extra={"job_id": str(job.id), "error": str(exc)},
        )
        job.status = IngestStatus.FAILED
        job.error_message = f"Queue error: {exc}"
        await db.commit()
        raise HTTPException(status_code=503, detail="Job queue unavailable") from exc

    logger.info("ingest job queued", extra={"job_id": str(job.id)})
    return {"job_id": str(job.id)}


@router.get("/ingest/{job_id}/status", response_model=IngestStatusResponse)
async def get_ingest_status(
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """Poll the processing status of an ingest job."""
    job = await db.get(IngestJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Ingest job not found")
    return IngestStatusResponse(
        job_id=job.id,
        status=job.status,
        error_message=job.error_message,
    )


@router.get("/ingest/pending", response_model=list[IngestStatusResponse])
async def get_pending_ingest_jobs(db: AsyncSession = Depends(get_db)):
    """Return all ingest jobs currently waiting for user review."""
    stmt = select(IngestJob).where(IngestJob.status == IngestStatus.REVIEW).order_by(IngestJob.created_at.desc())
    jobs = (await db.execute(stmt)).scalars().all()
    return [IngestStatusResponse(job_id=j.id, status=j.status, error_message=j.error_message) for j in jobs]


@router.delete("/ingest/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
async def dismiss_ingest_job(
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """Discard a pending ingest job without saving the recipe."""
    job = await db.get(IngestJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Ingest job not found")
    if job.status not in (IngestStatus.REVIEW, IngestStatus.FAILED):
        raise HTTPException(
            status_code=409,
            detail=f"Cannot dismiss a job with status {job.status.value!r}",
        )
    await db.delete(job)
    await db.commit()


@router.get("/ingest/{job_id}/review", response_model=IngestReviewPayload)
async def get_ingest_review(
    job_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Return the parsed recipe draft for user review.
    Only available once the job status is 'review'.
    """
    job = await db.get(IngestJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Ingest job not found")
    if job.status != IngestStatus.REVIEW:
        raise HTTPException(
            status_code=409,
            detail=f"Job is not ready for review (current status: {job.status.value!r})",
        )

    stmt = (
        select(LlmOutput)
        .where(LlmOutput.ingest_job_id == job_id)
        .order_by(LlmOutput.created_at.desc())
        .limit(1)
    )
    llm_out = (await db.execute(stmt)).scalar_one_or_none()
    if llm_out is None:
        raise HTTPException(status_code=500, detail="LLM output not found for job")

    parsed = llm_out.parsed_result
    unresolved = parsed.get("unresolved_ingredients", [])

    raw_nutrition = parsed.get("nutrition")
    nutrition = None
    if raw_nutrition and any(raw_nutrition.get(k) is not None for k in ("calories_kcal", "protein_g", "fat_g", "carbs_g")):
        from app.schemas.recipe import NutritionEstimate
        nutrition_data = {k: raw_nutrition.get(k) for k in NutritionEstimate.model_fields}
        # Ensure source is set to "card" for LLM-extracted card nutrition
        if not nutrition_data.get("source"):
            nutrition_data["source"] = "card"
        nutrition = NutritionEstimate(**nutrition_data)

    recipe_create = RecipeCreate(
        title=parsed.get("title", ""),
        cooking_time_mins=parsed.get("cooking_time_mins"),
        hello_fresh_style=parsed.get("card_style") or parsed.get("hello_fresh_style"),
        base_servings=parsed.get("base_servings", 2),
        mood_tags=parsed.get("mood_tags", []),
        nutrition=nutrition,
        ingredients=[
            {
                "raw_name": ing["raw_name"],
                "quantity": ing["quantity"],
                "unit": ing.get("unit"),
                "ingredient_id": ing.get("ingredient_id"),
            }
            for ing in parsed.get("ingredients", [])
        ],
        steps=[
            {
                "order": step["order"],
                "text": step["text"],
                "timer_seconds": step.get("timer_seconds"),
            }
            for step in parsed.get("steps", [])
        ],
    )

    raw_llm_response = None
    user_id = getattr(request.state, "user_id", None)
    if user_id and llm_out is not None:
        from app.models.user import User
        caller = await db.get(User, user_id)
        if caller and caller.is_admin:
            raw_llm_response = json.dumps(llm_out.raw_llm_response, indent=2)

    # Stage-2 self-review warnings emitted by the ingestion LLM.
    # Defensively filter to dicts that have the two required fields — the
    # LLM occasionally returns malformed entries we don't want to surface.
    raw_warnings = parsed.get("warnings") or []
    warnings = [
        w for w in raw_warnings
        if isinstance(w, dict) and isinstance(w.get("field"), str) and isinstance(w.get("reason"), str)
    ]

    return IngestReviewPayload(
        job_id=job_id,
        parsed_recipe=recipe_create,
        unresolved_ingredients=unresolved,
        warnings=warnings,
        source_url=parsed.get("source_url"),
        raw_llm_response=raw_llm_response,
    )


@router.post(
    "/ingest/confirm/{job_id}",
    response_model=RecipeSchema,
    status_code=status.HTTP_201_CREATED,
)
async def confirm_ingest(
    job_id: uuid.UUID,
    body: IngestConfirmRequest,
    db: AsyncSession = Depends(get_db),
    force: bool = False,
):
    """
    Confirm the parsed recipe (optionally edited) and insert it into the database.
    Pass ?force=true to save even if a near-duplicate image is detected.
    """
    try:
        recipe = await confirm_recipe(job_id=job_id, recipe_data=body.recipe, db=db, force=force)
    except DuplicateRecipeError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "DUPLICATE_RECIPE",
                "duplicate_recipe_id": str(exc.recipe_id),
                "duplicate_recipe_title": exc.recipe_title,
            },
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    # Queue nutrition estimation only if the card didn't already provide it.
    # Card-extracted nutrition (source="card") is always preferred; estimation
    # (source="estimated") is a best-effort fallback using the ingredient list.
    if recipe.nutrition_estimate is None:
        try:
            arq_pool = await create_pool(_redis_settings())
            await arq_pool.enqueue_job("task_estimate_nutrition", str(recipe.id))
            await arq_pool.aclose()
        except Exception:  # nosec B110 — nutrition estimation is best-effort; never fail a recipe confirm
            pass

    return recipe


@router.post("/import-url", status_code=status.HTTP_202_ACCEPTED)
async def import_recipe_from_url(
    body: UrlImportRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    Import a recipe from a URL.

    Fetches the page, passes it to the LLM for extraction, normalises ingredients,
    and creates an IngestJob in REVIEW status. Returns { job_id } for the existing
    review/confirm flow. The request blocks until LLM processing completes (~5–10s).
    """
    import uuid as _uuid
    from redis.asyncio import Redis
    from app.config import settings as _settings
    from app.models.ingest import IngestJob as IngestJobModel, IngestSourceType, IngestStatus

    job_id = _uuid.uuid4()
    job = IngestJobModel(
        id=job_id,
        status=IngestStatus.QUEUED,
        image_dir=_URL_IMPORT_PLACEHOLDER,
        source_type=IngestSourceType.IMPORTED,
    )
    db.add(job)
    await db.commit()

    redis_client = Redis.from_url(_settings.redis_url, decode_responses=False)
    try:
        await run_url_ingestion(job_id=job_id, url=body.url, db=db, redis_client=redis_client)
    finally:
        await redis_client.aclose()

    await db.refresh(job)
    if job.status == IngestStatus.FAILED:
        raise HTTPException(
            status_code=422,
            detail=job.error_message or "URL import failed",
        )

    return {"job_id": str(job_id)}


# ── Recipe list / detail ──────────────────────────────────────────────────────

@router.get("", response_model=list[RecipeSummary])
async def list_recipes(
    db: AsyncSession = Depends(get_db),
    skip: int = 0,
    limit: int = 50,
):
    """List all recipes (lightweight summary cards), newest first."""
    from app.services.cooking import get_recipe_stats
    stmt = select(Recipe).order_by(Recipe.created_at.desc()).offset(skip).limit(limit)
    rows = (await db.execute(stmt)).scalars().all()
    results = []
    for recipe in rows:
        summary = RecipeSummary.model_validate(recipe)
        stats = await get_recipe_stats(recipe.id, db)
        summary.last_cooked_at = stats["last_cooked_at"]
        results.append(summary)
    return results



@router.patch("/{recipe_id}/ingredients/{ri_id}/resolve", response_model=None)
async def resolve_recipe_ingredient(
    recipe_id: uuid.UUID,
    ri_id: uuid.UUID,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """
    Link an unresolved RecipeIngredient to a canonical Ingredient.

    Also appends the ingredient's raw_name to ingredient.aliases so future
    ingestion scans will match it at Layer 1 (exact lookup) automatically.

    Body: { "ingredient_id": "<uuid>" }
    """
    from app.models.recipe import RecipeIngredient as RI
    from app.models.ingredient import Ingredient

    ri = await db.get(RI, ri_id)
    if ri is None or ri.recipe_id != recipe_id:
        raise HTTPException(status_code=404, detail="RecipeIngredient not found")

    ingredient_id = body.get("ingredient_id")
    if not ingredient_id:
        raise HTTPException(status_code=422, detail="ingredient_id is required")

    try:
        canonical_id = uuid.UUID(str(ingredient_id))
    except ValueError:
        raise HTTPException(status_code=422, detail="ingredient_id must be a valid UUID")

    ingredient = await db.get(Ingredient, canonical_id)
    if ingredient is None:
        raise HTTPException(status_code=404, detail="Ingredient not found")

    # Link the RecipeIngredient
    ri.ingredient_id = canonical_id

    # Add raw_name as an alias so the normaliser auto-matches future scans
    normalised_raw = ri.raw_name.strip().lower()
    existing_aliases = [a.lower() for a in (ingredient.aliases or [])]
    if normalised_raw not in existing_aliases and normalised_raw != ingredient.canonical_name.lower():
        ingredient.aliases = list(ingredient.aliases or []) + [ri.raw_name.strip()]
        logger.info(
            "alias added to ingredient",
            extra={"alias": ri.raw_name, "canonical": ingredient.canonical_name},
        )

    await db.commit()
    await db.refresh(ri)

    logger.info(
        "recipe ingredient resolved",
        extra={
            "ri_id": str(ri_id),
            "ingredient_id": str(canonical_id),
            "canonical_name": ingredient.canonical_name,
            "raw_name": ri.raw_name,
        },
    )
    return {"id": str(ri.id), "ingredient_id": str(ri.ingredient_id), "raw_name": ri.raw_name}

@router.get("/{recipe_id}", response_model=RecipeSchema)
async def get_recipe(
    recipe_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """Fetch a single recipe with full ingredients and steps."""
    from sqlalchemy.orm import selectinload
    stmt = (
        select(Recipe)
        .options(selectinload(Recipe.ingredients), selectinload(Recipe.steps))
        .where(Recipe.id == recipe_id)
    )
    recipe = (await db.execute(stmt)).scalar_one_or_none()
    if recipe is None:
        raise HTTPException(status_code=404, detail="Recipe not found")

    # Count how many scanned images exist so the frontend can show a flip button
    image_count = 1
    if recipe.hero_image_path:
        img_dir = Path(recipe.hero_image_path).parent
        if img_dir.exists():
            image_count = len(list(img_dir.glob("image_*")))

    from app.services.cooking import get_recipe_stats
    stats = await get_recipe_stats(recipe_id, db)

    result = RecipeSchema.model_validate(recipe)
    result.image_count = image_count
    result.total_cooks = stats["total_cooks"]
    result.average_rating = stats["average_rating"]
    result.recent_notes = stats["recent_notes"]
    result.last_cooked_at = stats["last_cooked_at"]
    return result


@router.put("/{recipe_id}", response_model=RecipeSchema)
async def update_recipe(
    recipe_id: uuid.UUID,
    body: RecipeUpdate,
    db: AsyncSession = Depends(get_db),
):
    """
    Update an existing recipe. Currently supports updating the ingredients list.
    Replaces all existing ingredients with the provided list and triggers the normaliser.
    """
    from sqlalchemy.orm import selectinload
    from app.models.recipe import RecipeIngredient as RI
    from app.services.normaliser import resolve_ingredient

    from app.models.recipe import Step as StepModel

    # Verify recipe exists
    stmt = (
        select(Recipe)
        .options(selectinload(Recipe.ingredients), selectinload(Recipe.steps))
        .where(Recipe.id == recipe_id)
    )
    recipe = (await db.execute(stmt)).scalar_one_or_none()
    if recipe is None:
        raise HTTPException(status_code=404, detail="Recipe not found")

    if body.ingredients is not None:
        # Delete existing ingredients and replace
        await db.execute(RI.__table__.delete().where(RI.recipe_id == recipe_id))
        new_ingredients = []
        for ing_update in body.ingredients:
            # Re-run the normaliser against the new string.
            # We skip LLM here for speed; if it's a completely new ingredient
            # it will be added as unresolved and matched later if the user adds an alias.
            match_result = await resolve_ingredient(
                raw_name=ing_update.raw_name,
                db=db,
                use_llm=False
            )

            db_ing = RI(
                recipe_id=recipe_id,
                ingredient_id=match_result.ingredient.id if match_result.ingredient else None,
                raw_name=ing_update.raw_name,
                quantity=ing_update.quantity,
                unit=ing_update.unit,
                servings_quantities=ing_update.servings_quantities,
            )
            new_ingredients.append(db_ing)
            db.add(db_ing)
        logger.info("recipe ingredients updated", extra={"recipe_id": str(recipe_id), "count": len(new_ingredients)})

    if body.steps is not None:
        # Delete existing steps and replace
        await db.execute(StepModel.__table__.delete().where(StepModel.recipe_id == recipe_id))
        for step_update in body.steps:
            db.add(StepModel(
                recipe_id=recipe_id,
                order=step_update.order,
                text=step_update.text,
                timer_seconds=step_update.timer_seconds,
            ))
        logger.info("recipe steps updated", extra={"recipe_id": str(recipe_id), "count": len(body.steps)})

    await db.flush()
    await db.commit()

    # Re-fetch with fresh relationships
    stmt2 = (
        select(Recipe)
        .options(selectinload(Recipe.ingredients), selectinload(Recipe.steps))
        .where(Recipe.id == recipe_id)
    )
    recipe = (await db.execute(stmt2)).scalar_one()

    image_count = 1
    if recipe.hero_image_path:
        img_dir = Path(recipe.hero_image_path).parent
        if img_dir.exists():
            image_count = len(list(img_dir.glob("image_*")))

    result = RecipeSchema.model_validate(recipe)
    result.image_count = image_count
    return result


@router.get("/{recipe_id}/steps/{step_order}/image")
async def get_step_crop_image(
    recipe_id: uuid.UUID,
    step_order: int,
    db: AsyncSession = Depends(get_db),
):
    """Serve the cropped image for a recipe step, if available."""
    from app.models.recipe import Step as StepModel
    stmt = select(StepModel).where(
        StepModel.recipe_id == recipe_id,
        StepModel.order == step_order,
    )
    step = (await db.execute(stmt)).scalar_one_or_none()
    if step is None or not step.image_crop_path:
        raise HTTPException(status_code=404, detail="Step crop image not found")
    crop_path = Path(step.image_crop_path)
    if not crop_path.exists():
        raise HTTPException(status_code=404, detail="Step crop image file not found")
    return FileResponse(str(crop_path), media_type="image/jpeg")


@router.post("/{recipe_id}/steps/{step_order}/rotate")
async def rotate_step_image(
    recipe_id: uuid.UUID,
    step_order: int,
    db: AsyncSession = Depends(get_db),
):
    """Rotate a step crop image by 90 degrees clockwise."""
    from app.models.recipe import Step as StepModel
    stmt = select(StepModel).where(
        StepModel.recipe_id == recipe_id,
        StepModel.order == step_order,
    )
    step = (await db.execute(stmt)).scalar_one_or_none()
    if step is None or not step.image_crop_path:
        raise HTTPException(status_code=404, detail="Step crop image not found")
    crop_path = Path(step.image_crop_path)
    if not crop_path.exists():
        raise HTTPException(status_code=404, detail="Step crop image file not found")
    success = await rotate_image(crop_path)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to rotate image")
    return {"status": "ok"}


@router.post("/{recipe_id}/estimate-nutrition", status_code=status.HTTP_202_ACCEPTED)
async def trigger_nutrition_estimate(
    recipe_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """
    Manually trigger (or re-trigger) nutrition estimation for a recipe.
    Enqueues an arq background task and returns immediately.
    """
    recipe = await db.get(Recipe, recipe_id)
    if recipe is None:
        raise HTTPException(status_code=404, detail="Recipe not found")
    arq_pool = await create_pool(_redis_settings())
    await arq_pool.enqueue_job("task_estimate_nutrition", str(recipe_id))
    await arq_pool.aclose()
    return {"queued": True}


@router.delete("/{recipe_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_recipe(
    recipe_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """Permanently delete a recipe and its associated images."""
    from app.models.plan import MealPlanEntry
    from app.models.pantry import PantryReservation

    recipe = await db.get(Recipe, recipe_id)
    if recipe is None:
        raise HTTPException(status_code=404, detail="Recipe not found")

    # Remove pantry reservations that reference this recipe
    res_stmt = select(PantryReservation).where(PantryReservation.recipe_id == recipe_id)
    for res in (await db.execute(res_stmt)).scalars().all():
        await db.delete(res)

    # Remove meal plan entries that reference this recipe
    entry_stmt = select(MealPlanEntry).where(MealPlanEntry.recipe_id == recipe_id)
    for entry in (await db.execute(entry_stmt)).scalars().all():
        await db.delete(entry)

    await db.flush()

    # Delete image directory if it exists
    if recipe.hero_image_path:
        image_dir = Path(recipe.hero_image_path).parent
        if image_dir.exists() and image_dir.is_dir():
            import shutil
            shutil.rmtree(image_dir, ignore_errors=True)

    await db.delete(recipe)
    await db.commit()
    logger.info("recipe deleted", extra={"recipe_id": str(recipe_id)})


@router.get("/{recipe_id}/image")
async def get_recipe_image(
    recipe_id: uuid.UUID,
    index: int = 0,
    db: AsyncSession = Depends(get_db),
):
    """
    Serve a scanned recipe card image by index.
    index=0 → front (hero), index=1 → back of card.
    """
    recipe = await db.get(Recipe, recipe_id)
    if recipe is None or not recipe.hero_image_path:
        raise HTTPException(status_code=404, detail="Image not found")

    if index == 0:
        path = Path(recipe.hero_image_path)
    else:
        # Derive the image directory from hero_image_path and find the nth image
        img_dir = Path(recipe.hero_image_path).parent
        all_images = sorted(img_dir.glob("image_*"))
        if index >= len(all_images):
            all_images = sorted(img_dir.glob("manual_hero_*")) + all_images
            if index >= len(all_images):
                raise HTTPException(status_code=404, detail=f"Image index {index} not found")
        path = all_images[index]

    if not path.exists():
        raise HTTPException(status_code=404, detail="Image file not found")
    return FileResponse(path)


@router.post("/{recipe_id}/photo/rotate")
async def rotate_recipe_photo(
    recipe_id: uuid.UUID,
    index: int = 0,
    db: AsyncSession = Depends(get_db),
):
    """Rotate a recipe photo by 90 degrees clockwise."""
    recipe = await db.get(Recipe, recipe_id)
    if recipe is None or not recipe.hero_image_path:
        raise HTTPException(status_code=404, detail="Recipe or image not found")

    if index == 0:
        image_path = Path(recipe.hero_image_path)
    else:
        img_dir = Path(recipe.hero_image_path).parent
        all_images = sorted(img_dir.glob("image_*"))
        if index >= len(all_images):
            raise HTTPException(status_code=404, detail="Image index not found")
        image_path = all_images[index]

    success = await rotate_image(image_path)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to rotate image")

    return {"status": "ok"}


class CropRequest(BaseModel):
    x: float
    y: float
    width: float
    height: float


def _resolve_image_path(recipe: Recipe, index: int) -> Path:
    """Return the image file path for the given index, or raise HTTPException."""
    if not recipe.hero_image_path:
        raise HTTPException(status_code=404, detail="Recipe has no images")
    if index == 0:
        return Path(recipe.hero_image_path)
    img_dir = Path(recipe.hero_image_path).parent
    all_images = sorted(img_dir.glob("image_*"))
    if index >= len(all_images):
        raise HTTPException(status_code=404, detail=f"Image index {index} not found")
    return all_images[index]


@router.post("/{recipe_id}/photo/crop")
async def crop_recipe_photo(
    recipe_id: uuid.UUID,
    body: CropRequest,
    index: int = 0,
    db: AsyncSession = Depends(get_db),
):
    """Crop a recipe photo using fractional coordinates (0.0–1.0)."""
    recipe = await db.get(Recipe, recipe_id)
    if recipe is None:
        raise HTTPException(status_code=404, detail="Recipe not found")
    image_path = _resolve_image_path(recipe, index)
    success = await crop_image(image_path, body.x, body.y, body.width, body.height)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to crop image")
    return {"status": "ok"}


@router.post("/{recipe_id}/photo/auto-crop")
async def auto_crop_recipe_photo(
    recipe_id: uuid.UUID,
    index: int = 0,
    db: AsyncSession = Depends(get_db),
):
    """Use Claude vision to auto-crop a recipe card photo down to just the food image."""
    recipe = await db.get(Recipe, recipe_id)
    if recipe is None:
        raise HTTPException(status_code=404, detail="Recipe not found")
    image_path = _resolve_image_path(recipe, index)

    from app.services.bedrock import call_auto_crop_llm
    try:
        crop = await call_auto_crop_llm(image_path)
    except Exception as exc:
        logger.error("auto_crop LLM failed", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Auto-crop failed: {exc}")

    success = await crop_image(image_path, crop["x"], crop["y"], crop["width"], crop["height"])
    if not success:
        raise HTTPException(status_code=500, detail="Failed to apply crop")
    return {"status": "ok", "crop": crop}


@router.post("/{recipe_id}/photo")
async def upload_recipe_photo(
    recipe_id: uuid.UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    """Upload a new hero photo for a recipe."""
    recipe = await db.get(Recipe, recipe_id)
    if recipe is None:
        raise HTTPException(status_code=404, detail="Recipe not found")

    # If no hero exists (manual recipe), create the directory
    if recipe.hero_image_path:
        recipe_dir = Path(recipe.hero_image_path).parent
    else:
        recipe_dir = _RECIPES_DIR / str(recipe_id)

    path = await save_manual_photo(recipe_id, file, recipe_dir)
    if not path:
        raise HTTPException(status_code=500, detail="Failed to save image")

    recipe.hero_image_path = str(path)
    await db.commit()

    return {"status": "ok", "hero_image_path": str(path)}
