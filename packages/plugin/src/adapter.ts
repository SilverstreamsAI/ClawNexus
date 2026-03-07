import { startDaemon } from "clawnexus";
import type { DaemonHandle } from "clawnexus";

export type DaemonMode = "embedded" | "external" | "stopped";

export interface AdapterConfig {
  port: number;
  host: string;
  autoStart: boolean;
}

export interface AdapterState {
  mode: DaemonMode;
  port: number;
  host: string;
  handle: DaemonHandle | null;
  error: string | null;
}

export class DaemonAdapter {
  private mode: DaemonMode = "stopped";
  private handle: DaemonHandle | null = null;
  private error: string | null = null;
  private readonly config: AdapterConfig;

  constructor(config: AdapterConfig) {
    this.config = config;
  }

  async probeExisting(): Promise<boolean> {
    const url = `http://${this.config.host}:${this.config.port}/health`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    if (!this.config.autoStart) {
      this.mode = "stopped";
      return;
    }

    const existing = await this.probeExisting();
    if (existing) {
      this.mode = "external";
      return;
    }

    try {
      this.handle = await startDaemon({
        port: this.config.port,
        host: this.config.host,
      });
      this.mode = "embedded";
    } catch (err: unknown) {
      if (isAddrInUse(err)) {
        this.mode = "external";
        this.error = "Port in use — attached to existing daemon";
        return;
      }
      this.mode = "stopped";
      this.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.mode === "embedded" && this.handle) {
      await this.handle.app.close();
      this.handle = null;
    }
    this.mode = "stopped";
  }

  getState(): AdapterState {
    return {
      mode: this.mode,
      port: this.config.port,
      host: this.config.host,
      handle: this.handle,
      error: this.error,
    };
  }
}

function isAddrInUse(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EADDRINUSE";
}
