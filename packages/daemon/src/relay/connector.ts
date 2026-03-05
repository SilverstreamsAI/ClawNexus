import { WebSocket } from "ws";
import { EventEmitter } from "node:events";
import type {
  ClientMessage,
  RelayMessage,
  RelayState,
  RelayRoom,
  RelayStatus,
} from "./types.js";
import { generateKeyPair, deriveSessionKey, encrypt, decrypt } from "./crypto.js";
import type { KeyPair } from "./crypto.js";

const RECONNECT_DELAY = 3_000;
const PING_INTERVAL = 25_000;

export interface RelayConnectorOptions {
  relayUrl: string;
  clawId: string;
  authToken: string;
  /** Auto-accept incoming connections (default: true) */
  autoAccept?: boolean;
}

export class RelayConnector extends EventEmitter {
  private ws: WebSocket | null = null;
  private state: RelayState = "disconnected";
  private rooms = new Map<string, RelayRoom>();
  private keyPair: KeyPair;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly options: RelayConnectorOptions) {
    super();
    this.keyPair = generateKeyPair();
  }

  /** Connect to the relay and REGISTER this claw_id. */
  connect(): void {
    if (this.state !== "disconnected") return;
    this.closed = false;
    this.state = "connecting";

    this.ws = new WebSocket(this.options.relayUrl);

    this.ws.on("open", () => {
      this.send({
        type: "REGISTER",
        claw_id: this.options.clawId,
        auth_token: this.options.authToken,
      });
      this.startPing();
    });

    this.ws.on("message", (raw) => {
      let msg: RelayMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      this.handleMessage(msg);
    });

    this.ws.on("close", () => {
      this.cleanup();
      if (!this.closed) this.scheduleReconnect();
    });

    this.ws.on("error", () => {
      this.cleanup();
      if (!this.closed) this.scheduleReconnect();
    });
  }

  /** Disconnect and stop reconnecting. */
  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.cleanup();
  }

  /** Initiate a connection to a remote claw_id through the relay. */
  join(targetClawId: string): void {
    this.send({
      type: "JOIN",
      claw_id: this.options.clawId,
      target_claw_id: targetClawId,
      auth_token: this.options.authToken,
    });
  }

  /** Send an encrypted message to a peer in a room. */
  sendData(roomId: string, plaintext: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room || !room.session_key) return false;

    const payload = encrypt(room.session_key, plaintext);
    this.send({ type: "DATA", room_id: roomId, payload });
    return true;
  }

  /** Disconnect a specific room. */
  disconnectRoom(roomId: string): void {
    this.rooms.delete(roomId);
  }

  /** Get current relay status. */
  getStatus(): RelayStatus {
    return {
      state: this.state,
      relay_url: this.state !== "disconnected" ? this.options.relayUrl : null,
      claw_id: this.options.clawId,
      rooms: Array.from(this.rooms.values()).map((r) => ({
        room_id: r.room_id,
        peer_claw_id: r.peer_claw_id,
        state: r.state,
      })),
    };
  }

  private handleMessage(msg: RelayMessage): void {
    switch (msg.type) {
      case "REGISTERED":
        this.state = "registered";
        this.emit("registered", msg.claw_id);
        break;

      case "INCOMING": {
        // A peer wants to connect
        const room: RelayRoom = {
          room_id: msg.room_id,
          peer_claw_id: msg.from_claw_id,
          state: "pending",
        };
        this.rooms.set(msg.room_id, room);

        if (this.options.autoAccept !== false) {
          this.send({ type: "ACCEPT", room_id: msg.room_id });
        }
        this.emit("incoming", room);
        break;
      }

      case "JOINED": {
        const room = this.rooms.get(msg.room_id);
        if (room) {
          room.state = "active";
          // Send our public key for ECDH
          this.send({
            type: "DATA",
            room_id: msg.room_id,
            payload: JSON.stringify({
              _type: "KEY_EXCHANGE",
              pubkey: this.keyPair.publicKey.toString("base64"),
            }),
          });
        } else {
          // We are the initiator — create room entry
          this.rooms.set(msg.room_id, {
            room_id: msg.room_id,
            peer_claw_id: "", // will be known after key exchange
            state: "active",
          });
          // Send our public key
          this.send({
            type: "DATA",
            room_id: msg.room_id,
            payload: JSON.stringify({
              _type: "KEY_EXCHANGE",
              pubkey: this.keyPair.publicKey.toString("base64"),
            }),
          });
        }
        this.emit("joined", msg.room_id);
        break;
      }

      case "DATA": {
        const room = this.rooms.get(msg.room_id);
        if (!room) break;

        // Check if this is a key exchange message (unencrypted)
        try {
          const parsed = JSON.parse(msg.payload);
          if (parsed._type === "KEY_EXCHANGE" && parsed.pubkey) {
            const remotePubKey = Buffer.from(parsed.pubkey, "base64");
            room.session_key = deriveSessionKey(
              this.keyPair.privateKey,
              remotePubKey,
            );
            this.emit("key_exchanged", msg.room_id);
            break;
          }
        } catch {
          // Not JSON — treat as encrypted data
        }

        // Decrypt and emit
        if (room.session_key) {
          try {
            const plaintext = decrypt(room.session_key, msg.payload);
            this.emit("data", msg.room_id, plaintext);
          } catch {
            this.emit("error", new Error("Failed to decrypt message"));
          }
        }
        break;
      }

      case "PEER_LEFT": {
        this.rooms.delete(msg.room_id);
        this.emit("peer_left", msg.room_id);
        break;
      }

      case "ERROR":
        this.emit("relay_error", msg.code, msg.message);
        break;

      case "PONG":
        // heartbeat response, no action needed
        break;
    }
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ type: "PING" });
    }, PING_INTERVAL);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private cleanup(): void {
    this.stopPing();
    this.state = "disconnected";
    this.rooms.clear();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY);
  }
}
