// Pricing API routes — serves LLM pricing data from PricingCollector

import type { FastifyInstance } from "fastify";
import type { PricingCollector } from "../pricing/collector.js";

export function registerPricingRoutes(
  app: FastifyInstance,
  collector: PricingCollector,
): void {
  // Full pricing data, optional ?provider= filter
  app.get<{ Querystring: { provider?: string } }>("/pricing", async (request, reply) => {
    const data = collector.getData();
    if (!data) {
      return reply.status(503).send({ error: "pricing_data_not_available" });
    }

    const { provider } = request.query;
    if (provider) {
      const filtered = data.models.filter(
        (m) => m.provider.toLowerCase() === provider.toLowerCase(),
      );
      return {
        ...data,
        model_count: filtered.length,
        models: filtered,
      };
    }

    return data;
  });

  // Distinct provider list
  app.get("/pricing/providers", async (_request, reply) => {
    const data = collector.getData();
    if (!data) {
      return reply.status(503).send({ error: "pricing_data_not_available" });
    }

    const providers = [...new Set(data.models.map((m) => m.provider))].sort();
    return { count: providers.length, providers };
  });

  // Single model by id (id contains "/", use wildcard param)
  app.get("/pricing/models/*", async (request, reply) => {
    const data = collector.getData();
    if (!data) {
      return reply.status(503).send({ error: "pricing_data_not_available" });
    }

    const modelId = (request.params as { "*": string })["*"];
    if (!modelId) {
      return reply.status(400).send({ error: "Missing model id" });
    }

    const model = data.models.find((m) => m.id === modelId);
    if (!model) {
      return reply.status(404).send({ error: "Model not found" });
    }

    return model;
  });
}
