import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { PricingCollector } from "../../src/pricing/collector.js";
import type { PricingData, OpenRouterModel } from "../../src/pricing/types.js";

function makeOpenRouterModel(overrides: Partial<OpenRouterModel> = {}): OpenRouterModel {
  return {
    id: overrides.id ?? "anthropic/claude-sonnet-4-5-20250929",
    name: overrides.name ?? "Claude Sonnet 4.5",
    pricing: overrides.pricing ?? {
      prompt: "0.000003",
      completion: "0.000015",
      image: "0.0048",
      request: "0",
    },
    context_length: overrides.context_length ?? 200000,
    top_provider: overrides.top_provider ?? { max_completion_tokens: 16384 },
    architecture: overrides.architecture ?? {
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
    },
    created: overrides.created ?? 1717200000,
  };
}

function makeOpenRouterResponse(models?: OpenRouterModel[]) {
  return { data: models ?? [makeOpenRouterModel()] };
}

describe("PricingCollector", () => {
  let tmpDir: string;
  let collector: PricingCollector;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-pricing-"));
    collector = new PricingCollector(tmpDir);
  });

  afterEach(async () => {
    collector.stop();
    vi.restoreAllMocks();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("getData() returns null before start", () => {
    expect(collector.getData()).toBeNull();
  });

  it("fetches models from OpenRouter on start", async () => {
    const models = [
      makeOpenRouterModel({ id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6" }),
      makeOpenRouterModel({ id: "openai/gpt-4o", name: "GPT-4o" }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => makeOpenRouterResponse(models),
      }),
    );

    await collector.start();

    const data = collector.getData();
    expect(data).not.toBeNull();
    expect(data!.schema_version).toBe("1");
    expect(data!.source).toBe("openrouter");
    expect(data!.model_count).toBe(2);
    expect(data!.models).toHaveLength(2);
    expect(data!.models[0].id).toBe("anthropic/claude-opus-4.6");
    expect(data!.models[1].id).toBe("openai/gpt-4o");
  });

  it("converts $/token to $/MTok correctly", async () => {
    const model = makeOpenRouterModel({
      pricing: { prompt: "0.000005", completion: "0.000025", image: "0", request: "0" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => makeOpenRouterResponse([model]),
      }),
    );

    await collector.start();

    const m = collector.getData()!.models[0];
    expect(m.pricing.prompt).toBe(5);
    expect(m.pricing.completion).toBe(25);
    expect(m.pricing.image).toBe(0);
    expect(m.pricing.request).toBe(0);
    expect(m.pricing.unit).toBe("$/MTok");
  });

  it("extracts provider from model id", async () => {
    const models = [
      makeOpenRouterModel({ id: "anthropic/claude-opus-4.6" }),
      makeOpenRouterModel({ id: "google/gemini-pro" }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => makeOpenRouterResponse(models),
      }),
    );

    await collector.start();

    const data = collector.getData()!;
    expect(data.models[0].provider).toBe("anthropic");
    expect(data.models[1].provider).toBe("google");
  });

  it("writes pricing.json to disk", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => makeOpenRouterResponse(),
      }),
    );

    await collector.start();

    const filePath = path.join(tmpDir, "pricing.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const raw = JSON.parse(await fs.promises.readFile(filePath, "utf-8")) as PricingData;
    expect(raw.schema_version).toBe("1");
    expect(raw.models).toHaveLength(1);
  });

  it("loads existing pricing.json on start", async () => {
    // Write a pricing.json before starting
    const existing: PricingData = {
      schema_version: "1",
      fetched_at: "2026-01-01T00:00:00Z",
      source: "openrouter",
      model_count: 1,
      models: [
        {
          id: "test/cached-model",
          name: "Cached Model",
          provider: "test",
          pricing: { prompt: 1, completion: 2, image: 0, request: 0, unit: "$/MTok" },
          context_length: 4096,
          max_completion_tokens: null,
          input_modalities: ["text"],
          output_modalities: ["text"],
          created: 0,
        },
      ],
    };
    await fs.promises.writeFile(path.join(tmpDir, "pricing.json"), JSON.stringify(existing));

    // Fetch will fail — should still have cached data
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const errors: unknown[] = [];
    collector.on("error", (err) => errors.push(err));

    await collector.start();

    const data = collector.getData();
    expect(data).not.toBeNull();
    expect(data!.models[0].id).toBe("test/cached-model");
  });

  it("does not overwrite data on fetch failure", async () => {
    // First: successful fetch
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeOpenRouterResponse(),
    });
    vi.stubGlobal("fetch", mockFetch);

    await collector.start();
    expect(collector.getData()).not.toBeNull();
    const originalFetchedAt = collector.getData()!.fetched_at;

    // Now make fetch fail for the next call
    mockFetch.mockRejectedValue(new Error("timeout"));

    // Manually trigger a second collect by restarting (stop + start will re-collect)
    collector.stop();

    // Create a new collector to simulate interval fetch failure
    const collector2 = new PricingCollector(tmpDir);
    // Suppress error events
    collector2.on("error", () => {});
    await collector2.start();
    collector2.stop();

    // The disk file should still be the original (collector2 loaded it, then failed to overwrite)
    const data = collector2.getData();
    expect(data).not.toBeNull();
    expect(data!.fetched_at).toBe(originalFetchedAt);
  });

  it("emits collected event on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () =>
          makeOpenRouterResponse([makeOpenRouterModel(), makeOpenRouterModel({ id: "b/m" })]),
      }),
    );

    const events: unknown[] = [];
    collector.on("collected", (info) => events.push(info));

    await collector.start();

    expect(events).toHaveLength(1);
    expect((events[0] as { model_count: number }).model_count).toBe(2);
  });

  it("emits error event on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fail")));

    const errors: unknown[] = [];
    collector.on("error", (err) => errors.push(err));

    await collector.start();

    expect(errors).toHaveLength(1);
  });

  it("handles missing pricing fields gracefully", async () => {
    const model: OpenRouterModel = {
      id: "test/no-pricing",
      name: "No Pricing",
      // no pricing, no top_provider, no architecture
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => makeOpenRouterResponse([model]),
      }),
    );

    await collector.start();

    const m = collector.getData()!.models[0];
    expect(m.pricing.prompt).toBe(0);
    expect(m.pricing.completion).toBe(0);
    expect(m.context_length).toBe(0);
    expect(m.max_completion_tokens).toBeNull();
    expect(m.input_modalities).toEqual(["text"]);
    expect(m.output_modalities).toEqual(["text"]);
  });

  it("handles unexpected response shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ unexpected: true }), // no data array
      }),
    );

    const errors: unknown[] = [];
    collector.on("error", (err) => errors.push(err));

    await collector.start();

    expect(collector.getData()).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it("handles non-ok HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    const errors: unknown[] = [];
    collector.on("error", (err) => errors.push(err));

    await collector.start();

    expect(collector.getData()).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it("stop() prevents further interval fetches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => makeOpenRouterResponse(),
      }),
    );

    await collector.start();
    collector.stop();

    // Double stop should be safe
    collector.stop();
  });

  it("start() stops previous timer before restarting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => makeOpenRouterResponse(),
      }),
    );

    await collector.start();
    await collector.start(); // double start — should not leak timers
    collector.stop();
  });

  it("ignores corrupted pricing.json on disk", async () => {
    await fs.promises.writeFile(path.join(tmpDir, "pricing.json"), "not json!");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => makeOpenRouterResponse(),
      }),
    );

    await collector.start();

    expect(collector.getData()).not.toBeNull();
  });

  it("ignores pricing.json with wrong schema_version", async () => {
    const old = {
      schema_version: "99",
      fetched_at: "2020-01-01T00:00:00Z",
      source: "openrouter",
      model_count: 0,
      models: [],
    };
    await fs.promises.writeFile(path.join(tmpDir, "pricing.json"), JSON.stringify(old));

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fail")));

    const errors: unknown[] = [];
    collector.on("error", (err) => errors.push(err));

    await collector.start();

    // Should not have loaded old data
    expect(collector.getData()).toBeNull();
  });

  it("populates fetched_at timestamp", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => makeOpenRouterResponse(),
      }),
    );

    await collector.start();

    const data = collector.getData()!;
    expect(data.fetched_at).toBeDefined();
    // Should be a valid ISO timestamp
    expect(new Date(data.fetched_at).getTime()).toBeGreaterThan(0);
  });

  it("preserves model metadata fields", async () => {
    const model = makeOpenRouterModel({
      id: "anthropic/claude-opus-4.6",
      name: "Claude Opus 4.6",
      context_length: 200000,
      top_provider: { max_completion_tokens: 32000 },
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      created: 1717200000,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => makeOpenRouterResponse([model]),
      }),
    );

    await collector.start();

    const m = collector.getData()!.models[0];
    expect(m.context_length).toBe(200000);
    expect(m.max_completion_tokens).toBe(32000);
    expect(m.input_modalities).toEqual(["text", "image"]);
    expect(m.output_modalities).toEqual(["text"]);
    expect(m.created).toBe(1717200000);
  });
});
