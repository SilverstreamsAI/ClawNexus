import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { PricingCollector } from "../../src/pricing/collector.js";
import { registerPricingRoutes } from "../../src/api/pricing.js";
import type { PricingData, PricingModel } from "../../src/pricing/types.js";

function makeModel(overrides: Partial<PricingModel> = {}): PricingModel {
  return {
    id: overrides.id ?? "anthropic/claude-sonnet-4-5-20250929",
    name: overrides.name ?? "Claude Sonnet 4.5",
    provider: overrides.provider ?? "anthropic",
    pricing: overrides.pricing ?? {
      prompt: 3,
      completion: 15,
      image: 4.8,
      request: 0,
      unit: "$/MTok",
    },
    context_length: overrides.context_length ?? 200000,
    max_completion_tokens: overrides.max_completion_tokens ?? 16384,
    input_modalities: overrides.input_modalities ?? ["text", "image"],
    output_modalities: overrides.output_modalities ?? ["text"],
    created: overrides.created ?? 1717200000,
  };
}

function makePricingData(models?: PricingModel[]): PricingData {
  const m = models ?? [makeModel()];
  return {
    schema_version: "1",
    fetched_at: "2026-03-20T12:00:00Z",
    source: "openrouter",
    model_count: m.length,
    models: m,
  };
}

describe("Pricing API routes", () => {
  let app: FastifyInstance;
  let collector: PricingCollector;

  beforeEach(async () => {
    collector = new PricingCollector("/tmp/nonexistent-pricing-test");
    app = Fastify();
    registerPricingRoutes(app, collector);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  describe("GET /pricing", () => {
    it("returns 503 when data not available", async () => {
      const res = await app.inject({ method: "GET", url: "/pricing" });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("pricing_data_not_available");
    });

    it("returns full pricing data", async () => {
      const models = [
        makeModel({ id: "anthropic/claude-opus-4.6", provider: "anthropic" }),
        makeModel({ id: "openai/gpt-4o", provider: "openai" }),
      ];
      vi.spyOn(collector, "getData").mockReturnValue(makePricingData(models));

      const res = await app.inject({ method: "GET", url: "/pricing" });
      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.schema_version).toBe("1");
      expect(body.model_count).toBe(2);
      expect(body.models).toHaveLength(2);
    });

    it("filters by provider query param", async () => {
      const models = [
        makeModel({ id: "anthropic/claude-opus-4.6", provider: "anthropic" }),
        makeModel({ id: "openai/gpt-4o", provider: "openai" }),
        makeModel({ id: "anthropic/claude-sonnet-4-5-20250929", provider: "anthropic" }),
      ];
      vi.spyOn(collector, "getData").mockReturnValue(makePricingData(models));

      const res = await app.inject({ method: "GET", url: "/pricing?provider=anthropic" });
      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.model_count).toBe(2);
      expect(body.models.every((m: PricingModel) => m.provider === "anthropic")).toBe(true);
    });

    it("provider filter is case-insensitive", async () => {
      const models = [
        makeModel({ id: "anthropic/claude-opus-4.6", provider: "anthropic" }),
        makeModel({ id: "openai/gpt-4o", provider: "openai" }),
      ];
      vi.spyOn(collector, "getData").mockReturnValue(makePricingData(models));

      const res = await app.inject({ method: "GET", url: "/pricing?provider=Anthropic" });
      const body = res.json();
      expect(body.model_count).toBe(1);
    });

    it("returns empty models for non-existent provider", async () => {
      vi.spyOn(collector, "getData").mockReturnValue(makePricingData());

      const res = await app.inject({ method: "GET", url: "/pricing?provider=nonexistent" });
      expect(res.statusCode).toBe(200);
      expect(res.json().model_count).toBe(0);
      expect(res.json().models).toEqual([]);
    });
  });

  describe("GET /pricing/providers", () => {
    it("returns 503 when data not available", async () => {
      const res = await app.inject({ method: "GET", url: "/pricing/providers" });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("pricing_data_not_available");
    });

    it("returns deduplicated sorted provider list", async () => {
      const models = [
        makeModel({ id: "openai/gpt-4o", provider: "openai" }),
        makeModel({ id: "anthropic/claude-opus-4.6", provider: "anthropic" }),
        makeModel({ id: "anthropic/claude-sonnet-4-5-20250929", provider: "anthropic" }),
        makeModel({ id: "google/gemini-pro", provider: "google" }),
      ];
      vi.spyOn(collector, "getData").mockReturnValue(makePricingData(models));

      const res = await app.inject({ method: "GET", url: "/pricing/providers" });
      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.count).toBe(3);
      expect(body.providers).toEqual(["anthropic", "google", "openai"]);
    });
  });

  describe("GET /pricing/models/*", () => {
    it("returns 503 when data not available", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/pricing/models/anthropic/claude-opus-4.6",
      });
      expect(res.statusCode).toBe(503);
    });

    it("returns single model by id", async () => {
      const models = [
        makeModel({ id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6" }),
        makeModel({ id: "openai/gpt-4o", name: "GPT-4o" }),
      ];
      vi.spyOn(collector, "getData").mockReturnValue(makePricingData(models));

      const res = await app.inject({
        method: "GET",
        url: "/pricing/models/anthropic/claude-opus-4.6",
      });
      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.id).toBe("anthropic/claude-opus-4.6");
      expect(body.name).toBe("Claude Opus 4.6");
    });

    it("returns 404 for unknown model", async () => {
      vi.spyOn(collector, "getData").mockReturnValue(makePricingData());

      const res = await app.inject({
        method: "GET",
        url: "/pricing/models/unknown/model",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("Model not found");
    });

    it("works with URL-encoded model id", async () => {
      const models = [makeModel({ id: "anthropic/claude-opus-4.6" })];
      vi.spyOn(collector, "getData").mockReturnValue(makePricingData(models));

      const res = await app.inject({
        method: "GET",
        url: "/pricing/models/anthropic%2Fclaude-opus-4.6",
      });
      // URL-encoded slash becomes literal — wildcard should still catch it
      // Fastify decodes the path, so this resolves to anthropic/claude-opus-4.6
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe("anthropic/claude-opus-4.6");
    });
  });
});
