import { DaemonAdapter } from "./adapter.js";

interface PluginConfig {
  port?: number;
  host?: string;
  autoStart?: boolean;
}

interface PluginLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
}

interface PluginServiceContext {
  config: unknown;
  stateDir: string;
  logger: PluginLogger;
}

interface OpenClawPluginApi {
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  registerService: (service: {
    id: string;
    start: (ctx: PluginServiceContext) => void | Promise<void>;
    stop?: (ctx: PluginServiceContext) => void | Promise<void>;
  }) => void;
}

export default function clawnexusPlugin(api: OpenClawPluginApi): void {
  const pluginConfig = (api.pluginConfig ?? {}) as PluginConfig;

  const adapter = new DaemonAdapter({
    port: pluginConfig.port ?? 17890,
    host: pluginConfig.host ?? "127.0.0.1",
    autoStart: pluginConfig.autoStart ?? true,
  });

  api.registerService({
    id: "clawnexus-daemon",
    start: async () => {
      api.logger.info("ClawNexus daemon starting...");
      await adapter.start();
      const state = adapter.getState();
      if (state.mode === "embedded") {
        api.logger.info(`ClawNexus daemon running on ${state.host}:${state.port}`);
      } else if (state.mode === "external") {
        api.logger.info("ClawNexus daemon already running externally, attached.");
      }
    },
    stop: async () => {
      await adapter.stop();
      api.logger.info("ClawNexus daemon stopped.");
    },
  });
}
