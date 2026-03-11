import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CardFetcher } from "../../src/a2a/fetcher.js";
import { RegistryStore } from "../../src/registry/store.js";
import { makeInstance } from "../fixtures.js";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cardfetcher-test-"));
}

describe("CardFetcher", () => {
  let store: RegistryStore;
  let fetcher: CardFetcher;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    store = new RegistryStore(tmpDir);
    await store.init();
    fetcher = new CardFetcher(store, {
      refreshIntervalMs: 60_000, // long interval so timer doesn't fire in tests
      fetchTimeoutMs: 1000,
      staleMs: 5 * 60 * 1000,
    });
  });

  afterEach(async () => {
    fetcher.stop();
    await store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("shouldSkip logic", () => {
    it("skips is_self instances", async () => {
      const fetchSpy = vi.spyOn(fetcher, "fetchCard");
      fetcher.start();

      const inst = makeInstance({ is_self: true, address: "127.0.0.1" });
      store.upsert(inst);

      // Give event loop a tick
      await new Promise((r) => setTimeout(r, 50));
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("skips offline instances", async () => {
      const fetchSpy = vi.spyOn(fetcher, "fetchCard");
      fetcher.start();

      const inst = makeInstance({ status: "offline", address: "192.168.1.200" });
      store.upsert(inst);

      await new Promise((r) => setTimeout(r, 50));
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("skips instances with fresh remote_card", async () => {
      const fetchSpy = vi.spyOn(fetcher, "fetchCard");
      fetcher.start();

      const inst = makeInstance({
        address: "192.168.1.201",
        remote_card: {
          skills: [{ id: "test", name: "Test", description: "test", tags: ["general"] }],
          card_url: "http://192.168.1.201:17890/.well-known/agent-card.json",
          fetched_at: new Date().toISOString(),
        },
      });
      store.upsert(inst);

      await new Promise((r) => setTimeout(r, 50));
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("fetchCard", () => {
    it("returns null on network error", async () => {
      const inst = makeInstance({ address: "192.168.1.254" });
      const result = await fetcher.fetchCard(inst);
      expect(result).toBeNull();
    });

    it("returns null on non-200 response", async () => {
      // Mock fetch to return 404
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      try {
        const inst = makeInstance({ address: "192.168.1.100" });
        const result = await fetcher.fetchCard(inst);
        expect(result).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns null on invalid JSON structure", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ name: "test" }), // no skills array
      });

      try {
        const inst = makeInstance({ address: "192.168.1.100" });
        const result = await fetcher.fetchCard(inst);
        expect(result).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("parses a valid Agent Card response", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          name: "remote-bot",
          skills: [
            { id: "web_search", name: "Web Search", description: "Search the web", tags: ["web"] },
            { id: "code_run", name: "Code Run", description: "Execute code", tags: ["code"] },
          ],
          capabilities: {
            streaming: true,
            pushNotifications: false,
            stateTransitionHistory: false,
          },
          defaultInputModes: ["text/plain", "application/json"],
          defaultOutputModes: ["text/plain"],
        }),
      });

      try {
        const inst = makeInstance({ address: "192.168.1.100" });
        const result = await fetcher.fetchCard(inst);

        expect(result).not.toBeNull();
        expect(result!.skills).toHaveLength(2);
        expect(result!.skills[0].id).toBe("web_search");
        expect(result!.capabilities?.streaming).toBe(true);
        expect(result!.input_modes).toEqual(["text/plain", "application/json"]);
        expect(result!.card_url).toBe("http://192.168.1.100:17890/.well-known/agent-card.json");
        expect(result!.fetched_at).toBeTruthy();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("infinite loop prevention", () => {
    it("does not re-fetch when upsert is triggered by CardFetcher itself", async () => {
      let fetchCount = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        fetchCount++;
        return {
          ok: true,
          json: async () => ({
            name: "bot",
            skills: [{ id: "test", name: "Test", description: "test", tags: ["general"] }],
            capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
            defaultInputModes: ["text/plain"],
            defaultOutputModes: ["text/plain"],
          }),
        };
      });

      try {
        fetcher.start();
        const inst = makeInstance({ address: "192.168.1.150" });
        store.upsert(inst);

        // Wait for fetch + potential re-trigger
        await new Promise((r) => setTimeout(r, 200));

        // Should only fetch once (the guard prevents re-entry)
        expect(fetchCount).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("determineCardUrl", () => {
    it("uses port 17890 for non-TLS instances", () => {
      const inst = makeInstance({ address: "192.168.1.50", tls: false });
      expect(fetcher.determineCardUrl(inst)).toBe(
        "http://192.168.1.50:17890/.well-known/agent-card.json",
      );
    });

    it("uses https for TLS instances", () => {
      const inst = makeInstance({ address: "10.0.0.1", tls: true });
      expect(fetcher.determineCardUrl(inst)).toBe(
        "https://10.0.0.1:17890/.well-known/agent-card.json",
      );
    });
  });

  describe("start() idempotency", () => {
    it("calling start() twice does not register duplicate listeners or timers", async () => {
      const fetchSpy = vi.spyOn(fetcher, "fetchCard").mockResolvedValue(null);
      fetcher.start();
      fetcher.start(); // second call should be a no-op

      const inst = makeInstance({ address: "192.168.1.60" });
      store.upsert(inst);

      await new Promise((r) => setTimeout(r, 50));
      // fetchCard called at most once (not twice due to duplicate listener)
      expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(1);
    });
  });

  describe("stale card re-fetch", () => {
    it("re-fetches instances whose remote_card is older than staleMs", async () => {
      const shortStaleMs = 100;
      const shortFetcher = new CardFetcher(store, {
        refreshIntervalMs: 60_000,
        fetchTimeoutMs: 1000,
        staleMs: shortStaleMs,
      });

      const originalFetch = globalThis.fetch;
      let fetchCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        fetchCount++;
        return {
          ok: true,
          json: async () => ({
            name: "bot",
            skills: [{ id: "s1", name: "S1", description: "d", tags: ["general"] }],
          }),
        };
      });

      try {
        const staleCard = makeInstance({
          address: "192.168.1.70",
          remote_card: {
            skills: [{ id: "old", name: "Old", description: "old", tags: ["general"] }],
            card_url: "http://192.168.1.70:17890/.well-known/agent-card.json",
            fetched_at: new Date(Date.now() - shortStaleMs - 100).toISOString(), // older than staleMs
          },
        });
        store.upsert(staleCard);

        await shortFetcher.refreshAll();
        expect(fetchCount).toBe(1);
      } finally {
        shortFetcher.stop();
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("fetch during instance removal", () => {
    it("does not crash when instance is removed before fetch completes", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        // Simulate instance removed mid-flight
        store.remove(store.networkKey("192.168.1.80", 18789));
        return {
          ok: true,
          json: async () => ({
            name: "bot",
            skills: [{ id: "s1", name: "S1", description: "d", tags: ["general"] }],
          }),
        };
      });

      try {
        const inst = makeInstance({ address: "192.168.1.80" });
        store.upsert(inst);

        // refreshAll should complete without throwing
        await expect(fetcher.refreshAll()).resolves.toBeUndefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("refreshAll", () => {
    it("only refreshes stale cards", async () => {
      const originalFetch = globalThis.fetch;
      let fetchUrls: string[] = [];
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        fetchUrls.push(url);
        return {
          ok: true,
          json: async () => ({
            name: "bot",
            skills: [{ id: "s1", name: "S1", description: "d", tags: ["general"] }],
          }),
        };
      });

      try {
        // Instance with fresh card — should be skipped
        const fresh = makeInstance({
          address: "192.168.1.10",
          remote_card: {
            skills: [{ id: "old", name: "Old", description: "old", tags: ["general"] }],
            card_url: "http://192.168.1.10:17890/.well-known/agent-card.json",
            fetched_at: new Date().toISOString(),
          },
        });
        store.upsert(fresh);

        // Instance without card — should be fetched
        const stale = makeInstance({ address: "192.168.1.20" });
        store.upsert(stale);

        // Self instance — should be skipped
        const self = makeInstance({ address: "127.0.0.1", is_self: true });
        store.upsert(self);

        await fetcher.refreshAll();

        // Only the stale instance should have been fetched
        expect(fetchUrls).toHaveLength(1);
        expect(fetchUrls[0]).toContain("192.168.1.20");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
