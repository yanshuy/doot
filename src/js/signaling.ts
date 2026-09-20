import { PEER_ID } from "./peerId";

const SIGNAL_SERVER_ORIGIN = "localhost:3333";

const proto = window.location.protocol === "https:" ? "wss" : "ws";
export const SIGNAL_SERVER_URL = `${proto}://${SIGNAL_SERVER_ORIGIN}/yo`;

export interface PeerInfo {
  peer_id: string;
  metadata?: {
    role?: "proxy" | "client";
    name?: string;
    target_host?: string;
    [key: string]: any;
  };
}

export type Signal =
  | { type: "room_joined"; room_id: string; peers: PeerInfo[] }
  | { type: "peer_joined"; room_id: string; peer_id: string; metadata?: any }
  | { type: "peer_metadata_updated"; room_id: string; peer_id: string; metadata: any }
  | { type: "peer_left"; room_id: string; peer_id: string }
  | { type: "peer_offer"; from_peer: string; sdp: string }
  | { type: "peer_answer"; from_peer: string; sdp: string }
  | { type: "peer_ice_candidate"; from_peer: string; candidate: any }
  | { type: "error"; code: number };

function isValidSignal(json: any): json is Signal {
  if (!json || typeof json !== "object" || typeof json.type !== "string") {
    return false;
  }

  switch (json.type) {
    case "room_joined":
      return typeof json.room_id === "string" && Array.isArray(json.peers);

    case "peer_joined":
    case "peer_left":
      return (
        typeof json.room_id === "string" && typeof json.peer_id === "string"
      );

    case "peer_metadata_updated":
      return (
        typeof json.room_id === "string" &&
        typeof json.peer_id === "string" &&
        typeof json.metadata === "object"
      );

    case "peer_offer":
    case "peer_answer":
      return typeof json.from_peer === "string" && typeof json.sdp === "string";

    case "peer_ice_candidate":
      return (
        typeof json.from_peer === "string" &&
        json.candidate !== undefined &&
        json.candidate !== null
      );

    case "error":
      return typeof json.code === "number";

    default:
      return false;
  }
}

export type SendSignal =
  | { type: "join"; room_id: string; metadata?: any }
  | { type: "update_metadata"; room_id: string; metadata: any }
  | { type: "offer"; peer_id: string; sdp: string }
  | { type: "answer"; peer_id: string; sdp: string }
  | { type: "ice_candidate"; peer_id: string; candidate: any };

export type SignalHandler<T extends Signal["type"]> = (
  message: Extract<Signal, { type: T }>,
) => void;

export type SignalingServer = {
  socket: WebSocket;
  joinRoom: (roomId: string, metadata?: any) => void;
  sendSignal: (payload: SendSignal) => void;
  on<T extends Signal["type"]>(type: T, handler: SignalHandler<T>): () => void;
  off<T extends Signal["type"]>(type: T, handler: SignalHandler<T>): void;
};

export function SignalServer(peerId: string): SignalingServer {
  const socket = new WebSocket(`${SIGNAL_SERVER_URL}?peer_id=${peerId}`);
  const listeners = new Map<string, Set<(msg: any) => void>>();
  const sendQueue: SendSignal[] = [];

  socket.onopen = () => {
    while (sendQueue.length > 0) {
      const payload = sendQueue.shift();
      if (payload) {
        socket.send(JSON.stringify(payload));
      }
    }
  };

  function handleSignal(message: Signal) {
    const handlers = listeners.get(message.type);
    if (handlers) {
      handlers.forEach((handler) => handler(message));
    }
  }

  socket.onmessage = async (event: MessageEvent<Signal>) => {
    if (typeof event.data !== "string") return;

    let message: Signal;

    try {
      const json = JSON.parse(event.data);
      if (!isValidSignal(json)) {
        console.warn("[Signaling] Discarded invalid message schema:", json);
        return;
      }
      message = json;
    } catch (err) {
      console.error("[Signaling] JSON parse error:", err);
      return;
    }

    handleSignal(message);
  };

  const server: SignalingServer = {
    socket,

    sendSignal(payload: SendSignal) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
      } else if (socket.readyState === WebSocket.CONNECTING) {
        sendQueue.push(payload);
      } else {
        console.warn("[Signaling] Cannot send signal, socket state:", socket.readyState);
      }
    },

    joinRoom(roomId: string, metadata?: any) {
      this.sendSignal({ type: "join", room_id: roomId, metadata });
    },

    on<T extends Signal["type"]>(type: T, handler: SignalHandler<T>) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type)!.add(handler);
      return () => {
        listeners.get(type)?.delete(handler);
      };
    },

    off<T extends Signal["type"]>(type: T, handler: SignalHandler<T>) {
      listeners.get(type)?.delete(handler);
    },
  };

  return server;
}

export const SS = SignalServer(PEER_ID);