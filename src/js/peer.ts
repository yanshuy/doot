import { SS, type SignalingServer } from "./signaling";

const Rooms = new Map<string, Room>();

type Peer = {
  id: string;
  peerConns: any[];
  connect: () => void;
};

function Peer(peerId: string): Peer {
  const peer: Peer = {
    id: peerId,
    peerConns: [],

    connect() {},
  };
  return peer;
}

type Room = {
  id: string;
  peers: Peer[];
  addPeers: (peers: string[]) => void;
};

function Room(roomId: string, signaling: SignalingServer = SS): Room {
  signaling.joinRoom(roomId);

  const room: Room = {
    id: roomId,
    peers: [],

    addPeers(peerIds: string[]) {
      const peers = peerIds.map((id) => Peer(id));
      room.peers = peers;
    },
  };
  Rooms.set(roomId, room);
  return room;
}

SS.on("peer_joined", (msg) => {
  const { room_id, peer_id } = msg;
  const room = Rooms.get(room_id);
  if (room) {
    const peer = Peer(peer_id);
    room.peers.push(peer);
  }
});

SS.on("room_joined", (msg) => {
  const { room_id, peers } = msg;
  const room = Rooms.get(room_id);
  const peerIds = peers.map((p) => (typeof p === "string" ? p : p.peer_id));
  room?.addPeers(peerIds);
});
