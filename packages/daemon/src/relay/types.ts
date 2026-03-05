// --- Client → Relay ---

export interface JoinMessage {
  type: "JOIN";
  claw_id: string;
  target_claw_id: string;
  auth_token: string;
}

export interface RegisterMessage {
  type: "REGISTER";
  claw_id: string;
  auth_token: string;
}

export interface AcceptMessage {
  type: "ACCEPT";
  room_id: string;
}

export interface RejectMessage {
  type: "REJECT";
  room_id: string;
}

export interface DataMessage {
  type: "DATA";
  room_id: string;
  payload: string;
}

export interface PingMessage {
  type: "PING";
}

export type ClientMessage =
  | JoinMessage
  | RegisterMessage
  | AcceptMessage
  | RejectMessage
  | DataMessage
  | PingMessage;

// --- Relay → Client ---

export interface RegisteredMessage {
  type: "REGISTERED";
  claw_id: string;
}

export interface JoinedMessage {
  type: "JOINED";
  room_id: string;
}

export interface IncomingMessage {
  type: "INCOMING";
  room_id: string;
  from_claw_id: string;
  from_pubkey: string;
}

export interface RelayDataMessage {
  type: "DATA";
  room_id: string;
  payload: string;
}

export interface PeerLeftMessage {
  type: "PEER_LEFT";
  room_id: string;
}

export interface ErrorMessage {
  type: "ERROR";
  code: string;
  message: string;
}

export interface PongMessage {
  type: "PONG";
}

export type RelayMessage =
  | RegisteredMessage
  | JoinedMessage
  | IncomingMessage
  | RelayDataMessage
  | PeerLeftMessage
  | ErrorMessage
  | PongMessage;

// --- Relay connection state ---

export type RelayState = "disconnected" | "connecting" | "registered" | "joined";

export interface RelayRoom {
  room_id: string;
  peer_claw_id: string;
  state: "pending" | "active";
  session_key?: Buffer;   // AES-256-GCM key from ECDH
}

export interface RelayStatus {
  state: RelayState;
  relay_url: string | null;
  claw_id: string | null;
  rooms: Array<{
    room_id: string;
    peer_claw_id: string;
    state: string;
  }>;
}
