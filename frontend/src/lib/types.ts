export interface Ingredient {
  id: string;
  canonical_name: string;
  category: string;
  dimension: string;
  typical_unit: string;
  count_to_mass_g?: number;
}

export interface RecipeIngredient {
  id: string;
  recipe_id: string;
  ingredient_id: string | null;
  raw_name: string;
  quantity: number;
  unit?: string;
  normalized_quantity?: number;
  normalized_unit?: string;
  servings_quantities?: Record<string, number>;
}

export interface Step {
  id: string;
  recipe_id: string;
  order: number;
  text: string;
  timer_seconds?: number;
  image_description?: string | null;
  image_crop_path?: string | null;
}

export interface NutritionEstimate {
  calories_kcal?: number | null;
  protein_g?: number | null;
  fat_g?: number | null;
  saturates_g?: number | null;
  carbs_g?: number | null;
  sugars_g?: number | null;
  fibre_g?: number | null;
  salt_g?: number | null;
  per_servings?: number | null;
  /** "card" = extracted from printed nutrition panel; "estimated" = LLM estimate from ingredients */
  source?: 'card' | 'estimated' | null;
}

export interface Recipe {
  id: string;
  title: string;
  hero_image_path?: string;
  image_count: number;
  cooking_time_mins?: number;
  base_servings: number;
  source_type: string;
  source_url?: string | null;
  mood_tags: string[];
  created_at: string;
  ingredients: RecipeIngredient[];
  steps: Step[];
  total_cooks: number;
  average_rating?: number | null;
  recent_notes: string[];
  last_cooked_at?: string | null;
  nutrition_estimate?: NutritionEstimate | null;
}

export interface RecipeSummary {
  id: string;
  title: string;
  hero_image_path?: string;
  cooking_time_mins?: number;
  mood_tags: string[];
  last_cooked_at?: string | null;
}

export interface ReceiptItem {
  raw_name: string;
  quantity: number;
  unit: string | null;
  ingredient_id: string | null;
  resolved: boolean;
}

export interface ReceiptIngestResponse {
  items: ReceiptItem[];
  unresolved_count: number;
}

export interface PantryItem {
  id: string;
  ingredient_id: string;
  quantity: number;
  unit: string;
  confidence: number;
  decay_rate: number;
  last_confirmed_at: string;
  last_used_at?: string;
  expires_at?: string | null;
}

export interface PantryAvailability {
  pantry_item_id: string;
  ingredient: Ingredient;
  total_quantity: number;
  reserved_quantity: number;
  available_quantity: number;
  confidence: number;
  unit: string;
  expires_at?: string | null;
}

export interface IngredientMatchDetail {
  substitute_used?: string | null;
  ingredient_id?: string;
  raw_name: string;
  required_qty: number;
  required_unit?: string;
  available_qty: number;
  score: number;
  confidence: number;
}

export interface RecipeMatchResult {
  recipe: RecipeSummary;
  score: number;
  category: 'cook_now' | 'almost_there' | 'planner';
  hard_missing: IngredientMatchDetail[];
  partial: IngredientMatchDetail[];
  low_confidence: IngredientMatchDetail[];
  full: IngredientMatchDetail[];
  urgency_score: number;
  at_risk_ingredients: string[];
}

export interface MealPlanEntry {
  id: string;
  meal_plan_id: string;
  day_of_week: number;
  recipe_id: string;
  servings?: number;
  recipe: RecipeSummary;
}

export interface MealPlan {
  id: string;
  week_start: string;
  created_at: string;
  entries: MealPlanEntry[];
}

export interface Collection {
  id: string;
  name: string;
  colour: string;
  created_at: string;
  recipe_count: number;
}

export interface ShoppingListItem {
  ingredient_id?: string;
  canonical_name: string;
  quantity: number;
  unit: string;
  rounded_quantity: number;
  rounded_unit: string;
  is_unresolved?: boolean;
}

export interface ShoppingList {
  zones: Record<string, ShoppingListItem[]>;
  text_export: string;
  whatsapp_url: string;
}

export interface IngestStatusResponse {
  job_id: string;
  status: 'queued' | 'processing' | 'review' | 'complete' | 'failed';
  error_message?: string;
}

export interface IngestWarning {
  // raw_name of the ingredient the warning refers to; null for whole-recipe warnings
  ingredient: string | null;
  // one of: quantity | unit | servings_quantities.{2,3,4} | base_servings | ingredients | nutrition | cooking_time_mins
  field: string;
  // the suspect value as the LLM saw it
  value: unknown;
  // one-sentence explanation, ideally naming the suspected real value
  reason: string;
}

export interface IngestReviewPayload {
  job_id: string;
  parsed_recipe: any;
  unresolved_ingredients: string[];
  warnings?: IngestWarning[];
  source_url?: string | null;
  raw_llm_response?: string | null;
}

export interface UserProfile {
  id: string;
  username: string;
  display_name: string;
  email?: string | null;
  household_id: string;
  is_admin: boolean;
  force_password_change: boolean;
  created_at: string;
}

export interface HouseholdInfo {
  id: string;
  name: string;
  invite_code: string;
  member_count: number;
}
