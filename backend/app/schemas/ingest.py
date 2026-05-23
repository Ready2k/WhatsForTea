import uuid
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel

from app.models.ingest import IngestSourceType, IngestStatus
from app.schemas.recipe import RecipeCreate


class IngestWarning(BaseModel):
    """A single Stage-2 self-review warning emitted by the ingestion LLM.

    Surfaces likely extraction errors (e.g. a 10x quantity inflation, a
    misread decimal) to the user in the ingest review screen. The LLM
    must not modify the underlying value — it only flags it here.
    """
    # raw_name of the ingredient the warning refers to; null for whole-recipe warnings
    ingredient: Optional[str] = None
    # one of: quantity | unit | servings_quantities.{2,3,4} | base_servings | ingredients | nutrition | cooking_time_mins
    field: str
    # the suspect value as the LLM saw it (number, string, dict, or null)
    value: Optional[Any] = None
    # one-sentence explanation, ideally naming the suspected real value
    reason: str


class IngestJobCreate(BaseModel):
    source_type: IngestSourceType = IngestSourceType.HELLOFRESH


class IngestJob(BaseModel):
    id: uuid.UUID
    status: IngestStatus
    image_dir: str
    source_type: IngestSourceType
    error_message: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class IngestStatusResponse(BaseModel):
    """Polling response for GET /api/v1/recipes/ingest/{job_id}/status"""
    job_id: uuid.UUID
    status: IngestStatus
    error_message: Optional[str] = None


class IngestReviewPayload(BaseModel):
    """
    The parsed recipe draft shown to the user for review.
    Returned when ingest_job.status == 'review'.
    """
    job_id: uuid.UUID
    parsed_recipe: RecipeCreate
    # List of raw ingredient names that could not be auto-resolved
    unresolved_ingredients: list[str] = []
    # Stage-2 self-review warnings emitted by the ingestion LLM; flags
    # likely extraction errors (e.g. 10x quantity inflation) for the user
    # to confirm or correct in the review screen.
    warnings: list[IngestWarning] = []
    # Set for URL imports; null for image-scanned cards
    source_url: Optional[str] = None
    # Raw LLM response — only populated for household admins, null otherwise
    raw_llm_response: Optional[str] = None


class IngestConfirmRequest(BaseModel):
    """Body for POST /api/v1/recipes/ingest/confirm/{job_id}"""
    # The user-confirmed (possibly edited) recipe data
    recipe: RecipeCreate


class UrlImportRequest(BaseModel):
    """Body for POST /api/v1/recipes/import-url"""
    url: str
