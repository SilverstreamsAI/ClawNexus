// PricingCollector — periodically fetches LLM pricing from OpenRouter
// Pattern: EventEmitter + setInterval (same as HealthChecker)

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { PricingData, PricingModel, OpenRouterModel } from "./types.js";

const OPENROUTER_API = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT = 30_000;
const COLLECT_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const CLAWNEXUS_DIR = path.join(os.homedir(), ".clawnexus");

/** Convert $/token string to $/MTok number */
function toMTok(perToken: string | undefined): number {
  if (!perToken) return 0;
  const n = parseFloat(perToken);
  if (isNaN(n)) return 0;
  return Math.round(n * 1e6 * 1e6) / 1e6; // $/token * 1M = $/MTok, round to 6 decimals
}

function transformModel(raw: OpenRouterModel): PricingModel {
  const parts = raw.id.split("/");
  return {
    id: raw.id,
    name: raw.name,
    provider: parts[0] ?? "unknown",
    pricing: {
      prompt: toMTok(raw.pricing?.prompt),
      completion: toMTok(raw.pricing?.completion),
      image: toMTok(raw.pricing?.image),
      request: toMTok(raw.pricing?.request),
      unit: "$/MTok",
    },
    context_length: raw.context_length ?? 0,
    max_completion_tokens: raw.top_provider?.max_completion_tokens ?? null,
    input_modalities: raw.architecture?.input_modalities ?? ["text"],
    output_modalities: raw.architecture?.output_modalities ?? ["text"],
    created: raw.created ?? 0,
  };
}

export class PricingCollector extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private data: PricingData | null = null;
  private readonly dataDir: string;
  private readonly filePath: string;

  constructor(dataDir?: string) {
    super();
    this.dataDir = dataDir ?? CLAWNEXUS_DIR;
    this.filePath = path.join(this.dataDir, "pricing.json");
  }

  async start(): Promise<void> {
    this.stop();

    // Load existing data from disk
    await this.loadFromDisk();

    // Fetch immediately (awaited so caller knows initial data is ready), then schedule
    await this.collect();

    this.timer = setInterval(() => {
      this.collect().catch((err) => this.emit("error", err));
    }, COLLECT_INTERVAL);

    this.emit("started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getData(): PricingData | null {
    return this.data;
  }

  private async loadFromDisk(): Promise<void> {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = await fs.promises.readFile(this.filePath, "utf-8");
        const parsed = JSON.parse(raw) as PricingData;
        if (parsed.schema_version === "1" && Array.isArray(parsed.models)) {
          this.data = parsed;
        }
      }
    } catch {
      // Corrupted file — ignore, will be overwritten on next fetch
    }
  }

  private async collect(): Promise<void> {
    try {
      const res = await fetch(OPENROUTER_API, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
        headers: { "User-Agent": "clawnexus-daemon" },
      });

      if (!res.ok) {
        throw new Error(`OpenRouter API returned ${res.status}`);
      }

      const body = (await res.json()) as { data?: OpenRouterModel[] };
      const rawModels = body.data;
      if (!Array.isArray(rawModels)) {
        throw new Error("Unexpected response: missing data array");
      }

      const models = rawModels.map(transformModel);
      const pricingData: PricingData = {
        schema_version: "1",
        fetched_at: new Date().toISOString(),
        source: "openrouter",
        model_count: models.length,
        models,
      };

      this.data = pricingData;

      // Atomic write: tmp + rename
      await fs.promises.mkdir(this.dataDir, { recursive: true });
      const tmpPath = this.filePath + ".tmp";
      await fs.promises.writeFile(tmpPath, JSON.stringify(pricingData, null, 2), "utf-8");
      await fs.promises.rename(tmpPath, this.filePath);

      this.emit("collected", { model_count: models.length });
      console.log(`[clawnexus] [Pricing] Collected ${models.length} models from OpenRouter`);
    } catch (err) {
      // Don't overwrite existing data on failure
      this.emit("error", err);
      console.log(`[clawnexus] [Pricing] Fetch failed (non-fatal): ${err}`);
    }
  }
}
