export interface FileMetadata {
  id: string;
  name: string;
  size: number;
  type: string;
  lastModified?: number;
}

export type ControlMessage =
  | { type: "manifest_offer"; files: FileMetadata[] }
  | { type: "manifest_revoke"; fileIds: string[] }
  | { type: "request_file"; fileId: string; offset?: number }
  | { type: "file_start"; fileId: string; name: string; size: number; mime: string; offset?: number }
  | { type: "file_ready"; fileId: string }
  | { type: "file_end"; fileId: string }
  | { type: "transfer_cancel"; fileId: string }
  | { type: "transfer_error"; fileId: string; error: string };

export interface TransferProgress {
  fileId: string;
  filename: string;
  bytesTransferred: number;
  totalBytes: number;
  progress: number; // 0.0 to 1.0
  speedBps: number; // Bytes per second
  direction: "sending" | "receiving";
}
export const SIGNAL_SERVER_URL = import.meta.env.PUBLIC_SIGNAL_URL
  ? `wss://${import.meta.env.PUBLIC_SIGNAL_URL}/yo`
  : "ws://localhost:3333/yo";
export const STUN_SERVERS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:stun2.l.google.com:19302",
  "stun:stun3.l.google.com:19302",
  "stun:stun4.l.google.com:19302",
];

export type Signal =
  | { type: "room_joined"; room_id: string; peers: string[] }
  | { type: "peer_joined"; room_id: string; peer_id: string }
  | { type: "peer_left"; room_id: string; peer_id: string }
  | { type: "peer_offer"; from_peer: string; sdp: string }
  | { type: "peer_answer"; from_peer: string; sdp: string }
  | { type: "peer_ice_candidate"; from_peer: string; candidate: any }
  | { type: "error"; code: number };


export function isValidSignal(json: any): json is Signal {
  if (!json || typeof json !== "object" || typeof json.type !== "string") {
    return false;
  }

  switch (json.type) {
    case "room_joined":
      return typeof json.room_id === "string" && Array.isArray(json.peers);

    case "peer_joined":
    case "peer_left":
      return typeof json.room_id === "string" && typeof json.peer_id === "string";

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

export interface WebRTCEvents {
  onPeerJoined?: (peerId: string) => void;
  onPeerLeft?: (peerId: string) => void;
  onChannelState?: (isOpen: boolean) => void;
  onConnectionState?: (state: RTCPeerConnectionState) => void;
  onMessage?: (data: string) => void; // debug chat
  onRemoteManifest?: (files: FileMetadata[]) => void;
  onTransferProgress?: (progress: TransferProgress) => void;
  onFileReceived?: (file: File) => void;
}