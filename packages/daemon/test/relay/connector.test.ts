import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted state — vi.hoisted ensures these exist before vi.mock factories run
// ---------------------------------------------------------------------------
const { getLastWs, setLastWs } = vi.hoisted(() => {
  let _lastWs: unknown = null;
  return {
    getLastWs: () => _lastWs as {
      url: string;
      readyState: number;
      sent: string[];
      emit(event: string, ...args: unknown[]): boolean;
      send(data: string): void;
      close(): void;
    },
    setLastWs: (ws: unknown) => { _lastWs = ws; },
  };
});

// Mock crypto (no top-level variable references)
vi.mock("../../src/relay/crypto.js", () => ({
  generateKeyPair: vi.fn(() => ({
    publicKey: Buffer.alloc(44, 1),
    privateKey: Buffer.alloc(48, 2),
  })),
  deriveSessionKey: vi.fn(() => Buffer.alloc(32, 3)),
  encrypt: vi.fn((_key: Buffer, plaintext: string) => `encrypted:${plaintext}`),
  decrypt: vi.fn((_key: Buffer, encoded: string) => `decrypted:${encoded}`),
}));

// Mock ws — class defined entirely inline, uses dynamic import for EventEmitter
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class MockWS extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    sent: string[] = [];
    url: string;
    constructor(url: string) {
      super();
      this.url = url;
      setLastWs(this);
      queueMicrotask(() => this.emit("open"));
    }
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {
      this.readyState = 3;
      queueMicrotask(() => this.emit("close"));
    }
  }
  return { WebSocket: MockWS };
});

import { RelayConnector } from "../../src/relay/connector.js";

const fakePublicKey = Buffer.alloc(44, 1);

describe("RelayConnector", () => {
  let connector: RelayConnector;
  const opts = {
    relayUrl: "wss://test-relay.example.com",
    clawId: "test.id.claw",
    authToken: "tok123",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    connector = new RelayConnector(opts);
  });

  afterEach(() => {
    connector.disconnect();
    vi.useRealTimers();
  });

  it("connect() creates WebSocket and sends REGISTER on open", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);

    const ws = getLastWs();
    expect(ws.url).toBe(opts.relayUrl);
    const sent = JSON.parse(ws.sent[0]);
    expect(sent).toEqual({
      type: "REGISTER",
      claw_id: opts.clawId,
      auth_token: opts.authToken,
    });
  });

  it("connect() when already connected is a no-op", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);
    const firstWs = getLastWs();
    connector.connect();
    expect(getLastWs()).toBe(firstWs);
  });

  it("disconnect() closes WebSocket and stops reconnect", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);

    connector.disconnect();
    await vi.advanceTimersByTimeAsync(0);

    expect(getLastWs().readyState).toBe(3);
    expect(connector.getStatus().state).toBe("disconnected");
  });

  it("join() sends JOIN message", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);

    connector.join("peer.id.claw");
    const sent = getLastWs().sent.map((s) => JSON.parse(s));
    const joinMsg = sent.find((m) => m.type === "JOIN");
    expect(joinMsg).toEqual({
      type: "JOIN",
      claw_id: opts.clawId,
      target_claw_id: "peer.id.claw",
      auth_token: opts.authToken,
    });
  });

  it("sendData() with active room + session key encrypts and sends", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);

    simulateIncoming("room-1", "peer.id.claw");
    simulateJoined("room-1");
    simulateKeyExchange("room-1");

    const ok = connector.sendData("room-1", "hello");
    expect(ok).toBe(true);
    const dataMsgs = getLastWs()
      .sent.map((s) => JSON.parse(s))
      .filter((m) => m.type === "DATA" && m.payload === "encrypted:hello");
    expect(dataMsgs.length).toBe(1);
  });

  it("sendData() without session key returns false", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(connector.sendData("nonexistent", "hello")).toBe(false);
  });

  it("getStatus() returns correct state and rooms", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);

    simulateMessage({ type: "REGISTERED", claw_id: opts.clawId });
    const status = connector.getStatus();
    expect(status.state).toBe("registered");
    expect(status.relay_url).toBe(opts.relayUrl);
    expect(status.claw_id).toBe(opts.clawId);
    expect(status.rooms).toEqual([]);
  });

  it("updateAuthToken() updates options", () => {
    connector.updateAuthToken("new-token");
    connector.connect();
  });

  it("handleMessage(REGISTERED) emits 'registered' and sets state", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);

    const handler = vi.fn();
    connector.on("registered", handler);

    simulateMessage({ type: "REGISTERED", claw_id: opts.clawId });
    expect(handler).toHaveBeenCalledWith(opts.clawId);
    expect(connector.getStatus().state).toBe("registered");
  });

  it("handleMessage(INCOMING) creates room, auto-accepts, emits 'incoming'", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);

    const handler = vi.fn();
    connector.on("incoming", handler);

    simulateIncoming("room-1", "peer.id.claw");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        room_id: "room-1",
        peer_claw_id: "peer.id.claw",
        state: "pending",
      }),
    );

    const sent = getLastWs().sent.map((s) => JSON.parse(s));
    const acceptMsg = sent.find((m) => m.type === "ACCEPT");
    expect(acceptMsg).toEqual({ type: "ACCEPT", room_id: "room-1" });
  });

  it("handleMessage(INCOMING) with autoAccept=false creates room but no ACCEPT sent", async () => {
    connector.disconnect();
    connector = new RelayConnector({ ...opts, autoAccept: false });
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);

    simulateIncoming("room-1", "peer.id.claw");

    const sent = getLastWs().sent.map((s) => JSON.parse(s));
    const acceptMsg = sent.find((m) => m.type === "ACCEPT");
    expect(acceptMsg).toBeUndefined();
  });

  it("handleMessage(JOINED) marks room active and sends KEY_EXCHANGE", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);

    simulateIncoming("room-1", "peer.id.claw");
    simulateJoined("room-1");

    const sent = getLastWs().sent.map((s) => JSON.parse(s));
    const keyExMsg = sent.find((m) => {
      if (m.type !== "DATA") return false;
      try {
        const p = JSON.parse(m.payload);
        return p._type === "KEY_EXCHANGE";
      } catch {
        return false;
      }
    });
    expect(keyExMsg).toBeDefined();
  });

  it("handleMessage(JOINED) for initiator (no existing room) creates room entry", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);

    connector.join("peer.id.claw");

    const handler = vi.fn();
    connector.on("joined", handler);
    simulateMessage({ type: "JOINED", room_id: "room-new" });
    expect(handler).toHaveBeenCalledWith("room-new");

    const status = connector.getStatus();
    expect(status.rooms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ room_id: "room-new", peer_claw_id: "peer.id.claw" }),
      ]),
    );
  });

  it("handleMessage(DATA) with KEY_EXCHANGE derives session key", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);

    simulateIncoming("room-1", "peer.id.claw");
    simulateJoined("room-1");

    const handler = vi.fn();
    connector.on("key_exchanged", handler);
    simulateKeyExchange("room-1");
    expect(handler).toHaveBeenCalledWith("room-1");
  });

  it("handleMessage(DATA) with encrypted data decrypts and emits 'data'", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);

    simulateIncoming("room-1", "peer.id.claw");
    simulateJoined("room-1");
    simulateKeyExchange("room-1");

    const handler = vi.fn();
    connector.on("data", handler);
    simulateMessage({ type: "DATA", room_id: "room-1", payload: "some-encrypted-data" });
    expect(handler).toHaveBeenCalledWith("room-1", "decrypted:some-encrypted-data");
  });

  it("handleMessage(DATA) with no session key drops message", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);

    simulateIncoming("room-1", "peer.id.claw");

    const handler = vi.fn();
    connector.on("data", handler);
    simulateMessage({ type: "DATA", room_id: "room-1", payload: "some-data" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("handleMessage(PEER_LEFT) removes room and emits 'peer_left'", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);

    simulateIncoming("room-1", "peer.id.claw");
    expect(connector.getStatus().rooms.length).toBe(1);

    const handler = vi.fn();
    connector.on("peer_left", handler);
    simulateMessage({ type: "PEER_LEFT", room_id: "room-1" });
    expect(handler).toHaveBeenCalledWith("room-1");
    expect(connector.getStatus().rooms.length).toBe(0);
  });

  it("handleMessage(ERROR) emits 'relay_error'", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);

    const handler = vi.fn();
    connector.on("relay_error", handler);
    simulateMessage({ type: "ERROR", code: "AUTH_FAILED", message: "bad token" });
    expect(handler).toHaveBeenCalledWith("AUTH_FAILED", "bad token");
  });

  it("handleMessage(PONG) is a no-op", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);
    simulateMessage({ type: "PONG" });
  });

  it("WebSocket close triggers cleanup and scheduleReconnect", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);

    getLastWs().emit("close");
    expect(connector.getStatus().state).toBe("disconnected");

    const oldWs = getLastWs();
    await vi.advanceTimersByTimeAsync(3000);
    expect(getLastWs()).not.toBe(oldWs);
  });

  it("WebSocket error triggers cleanup and scheduleReconnect", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);

    getLastWs().emit("error", new Error("fail"));
    expect(connector.getStatus().state).toBe("disconnected");
  });

  it("invalid JSON message is ignored", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);
    getLastWs().emit("message", "not json {{{");
  });

  it("disconnectRoom() removes room from map", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);

    simulateIncoming("room-1", "peer.id.claw");
    expect(connector.getStatus().rooms.length).toBe(1);

    connector.disconnectRoom("room-1");
    expect(connector.getStatus().rooms.length).toBe(0);
  });

  it("ping interval fires and sends PING", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);

    const sentBefore = getLastWs().sent.length;
    await vi.advanceTimersByTimeAsync(25_000);

    const newMsgs = getLastWs()
      .sent.slice(sentBefore)
      .map((s) => JSON.parse(s));
    const pings = newMsgs.filter((m) => m.type === "PING");
    expect(pings.length).toBeGreaterThanOrEqual(1);
  });

  it("DATA with no matching room is dropped", async () => {
    connector.connect();
    await vi.advanceTimersByTimeAsync(0);

    const handler = vi.fn();
    connector.on("data", handler);
    simulateMessage({ type: "DATA", room_id: "nonexistent", payload: "data" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("getStatus() returns null relay_url when disconnected", () => {
    const status = connector.getStatus();
    expect(status.state).toBe("disconnected");
    expect(status.relay_url).toBeNull();
  });

  // --- Helpers ---

  function simulateMessage(msg: Record<string, unknown>): void {
    getLastWs().emit("message", JSON.stringify(msg));
  }

  function simulateIncoming(roomId: string, from: string): void {
    simulateMessage({
      type: "INCOMING",
      room_id: roomId,
      from_claw_id: from,
      from_pubkey: "pk",
    });
  }

  function simulateJoined(roomId: string): void {
    simulateMessage({ type: "JOINED", room_id: roomId });
  }

  function simulateKeyExchange(roomId: string): void {
    simulateMessage({
      type: "DATA",
      room_id: roomId,
      payload: JSON.stringify({
        _type: "KEY_EXCHANGE",
        pubkey: fakePublicKey.toString("base64"),
      }),
    });
  }
});
