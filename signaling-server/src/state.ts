export type PeerId = string;

export type PeerState = {
  id: PeerId;
  rooms: Set<string>;
  metadata?: unknown;
};

export const Rooms = new Map<string, Set<PeerId>>();
export const ActivePeers = new Map<PeerId, Bun.ServerWebSocket<PeerState>>();

export const Metrics = {
  totalConnectRequests: 0,
};



