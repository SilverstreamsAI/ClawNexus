// Pricing data types — LLM model pricing from OpenRouter

export interface PricingModel {
  id: string; // "anthropic/claude-opus-4.6"
  name: string;
  provider: string; // split("/")[0]
  pricing: {
    prompt: number;
    completion: number;
    image: number;
    request: number;
    unit: string; // "$/MTok"
  };
  context_length: number;
  max_completion_tokens: number | null;
  input_modalities: string[];
  output_modalities: string[];
  created: number;
}

export interface PricingData {
  schema_version: string;
  fetched_at: string;
  source: string;
  model_count: number;
  models: PricingModel[];
}

/** Raw model shape from OpenRouter /api/v1/models */
export interface OpenRouterModel {
  id: string;
  name: string;
  pricing?: {
    prompt?: string;
    completion?: string;
    image?: string;
    request?: string;
  };
  context_length?: number;
  top_provider?: {
    max_completion_tokens?: number | null;
  };
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  created?: number;
}
