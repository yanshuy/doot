import { PEER_ID } from "./peerId";

const SIGNAL_SERVER_HOST = "toucan-driven-admittedly.ngrok-free.app";
const protocol = "wss";

export const SIGNAL_SERVER_URL = `${protocol}://${SIGNAL_SERVER_HOST}/yo`;

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

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export type SignalingServer = {
  socket: WebSocket;
  joinRoom: (roomId: string, metadata?: any) => void;
  sendSignal: (payload: SendSignal) => void;
  on<T extends Signal["type"]>(type: T, handler: SignalHandler<T>): () => void;
  off<T extends Signal["type"]>(type: T, handler: SignalHandler<T>): void;
  onConnectionChange: (handler: (status: ConnectionStatus) => void) => () => void;
  isConnected: () => boolean;
};

export function SignalServer(peerId: string): SignalingServer {
  let socket: WebSocket;
  let currentRoom: { roomId: string; metadata?: any } | null = null;
  const listeners = new Map<string, Set<(msg: any) => void>>();
  const statusListeners = new Set<(status: ConnectionStatus) => void>();
  const sendQueue: SendSignal[] = [];

  function setStatus(status: ConnectionStatus) {
    statusListeners.forEach((fn) => fn(status));
  }

  function connect() {
    setStatus("connecting");
    socket = new WebSocket(`${SIGNAL_SERVER_URL}?peer_id=${peerId}`);
    server.socket = socket;

    socket.onopen = () => {
      setStatus("connected");
      if (currentRoom) {
        socket.send(JSON.stringify({ type: "join", room_id: currentRoom.roomId, metadata: currentRoom.metadata }));
      }
      while (sendQueue.length > 0) {
        const payload = sendQueue.shift();
        if (payload) {
          socket.send(JSON.stringify(payload));
        }
      }
    };

    socket.onclose = () => {
      setStatus("disconnected");
      setTimeout(connect, 3000);
    };

    socket.onerror = () => {
      setStatus("disconnected");
    };

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

      const handlers = listeners.get(message.type);
      if (handlers) {
        handlers.forEach((handler) => handler(message));
      }
    };
  }

  const server: SignalingServer = {
    // @ts-ignore
    socket: null,

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
      currentRoom = { roomId, metadata };
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

    onConnectionChange(handler: (status: ConnectionStatus) => void) {
      statusListeners.add(handler);
      if (socket) {
        if (socket.readyState === WebSocket.OPEN) {
          handler("connected");
        } else if (socket.readyState === WebSocket.CONNECTING) {
          handler("connecting");
        } else {
          handler("disconnected");
        }
      }
      return () => {
        statusListeners.delete(handler);
      };
    },

    isConnected() {
      return socket?.readyState === WebSocket.OPEN;
    },
  };

  connect();
  return server;
}

export const SS = SignalServer(PEER_ID);