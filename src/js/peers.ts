import { setupHostChannel } from "./proxy/host";
import { SS } from "./signaling";
import { PEER_ID } from "./peerId";
export { PEER_ID };


type Peer = {
    id: string;
    conn: RTCPeerConnection;
};

export const Peers = {
    map: new Map<string, Peer>(),
    listeners: new Set<(peers: Map<string, Peer>) => void>(),

    onchange(listener: (peers: Map<string, Peer>) => void) {
        Peers.listeners.add(listener);
        return () => {
            Peers.listeners.delete(listener);
        };
    },

    notifyListeners() {
        for (const listener of Peers.listeners) {
            listener(Peers.map);
        }
    },
    set(peerId: string, peer: Peer) {
        Peers.map.set(peerId, peer);
        Peers.notifyListeners();
    },
    delete(peerId: string) {
        Peers.map.delete(peerId);
        Peers.notifyListeners();
    },
};

export function getConnection(peerId: string) {
    const peer = Peers.map.get(peerId);
    return peer?.conn;
}

export const STUN_SERVERS = [
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
    "stun:stun2.l.google.com:19302",
    "stun:stun3.l.google.com:19302",
    "stun:stun4.l.google.com:19302",
];

export function createConnection(peerId: string) {
    let pc = getConnection(peerId);
    if (pc) return pc;

    pc = new RTCPeerConnection({
        iceServers: [{ urls: STUN_SERVERS }],
    });

    Peers.set(peerId, { id: peerId, conn: pc });

    pc.ondatachannel = (event) => {
        const dc = event.channel;
        if (dc.label.startsWith("req-")) {
            setupHostChannel(dc);
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            SS.sendSignal({
                type: "ice_candidate",
                peer_id: peerId,
                candidate: event.candidate,
            });
        }
    };

    pc.onconnectionstatechange = () => {
        if (
            pc.connectionState === "disconnected" ||
            pc.connectionState === "failed" ||
            pc.connectionState === "closed"
        ) {
            Peers.delete(peerId);
        } else if (pc.connectionState === "connected") {
            Peers.notifyListeners();
        }
    };

    return pc;
}

export async function sendOffer(peerId: string): Promise<void> {
    if (currentRole !== "client") {
        console.warn(`[Peers] Cannot send offer: current role is "${currentRole}" (only clients can initiate)`);
        return;
    }
    const targetMeta = knownRoomPeers.get(peerId);
    if (targetMeta?.role !== "proxy") {
        console.warn(`[Peers] Cannot send offer to peer ${peerId}: target is not a proxy (role: ${targetMeta?.role})`);
        return;
    }

    const pc = createConnection(peerId);

    // Create initial control channel before offer to ensure m=application is in the SDP
    pc.createDataChannel("control", { ordered: true });

    const offer = await pc.createOffer();
    if (!offer.sdp) {
        throw new Error("[WebRTC] SDP is null");
    }
    await pc.setLocalDescription(offer);

    SS.sendSignal({
        type: "offer",
        peer_id: peerId,
        sdp: offer.sdp,
    });
}

export async function handleOffer(fromPeer: string, sdp: string): Promise<void> {
    const pc = createConnection(fromPeer);

    await pc.setRemoteDescription(
        new RTCSessionDescription({ type: "offer", sdp }),
    );

    const answer = await pc.createAnswer();
    if (!answer.sdp) {
        throw new Error("[WebRTC] SDP is null");
    }
    await pc.setLocalDescription(answer);

    SS.sendSignal({
        type: "answer",
        peer_id: fromPeer,
        sdp: answer.sdp,
    });
}

export type Role = "proxy" | "client";
export let currentRole: Role = "client";

export const knownRoomPeers = new Map<string, { role?: string }>();

function isServerPeer(metadata?: { role?: string }): boolean {
    return metadata?.role === "proxy";
}

function checkAndConnect() {
    if (currentRole !== "client") return;
    for (const [peerId, meta] of knownRoomPeers) {
        if (peerId === PEER_ID) continue;
        if (isServerPeer(meta) && !getConnection(peerId)) {
            sendOffer(peerId);
        }
    }
}

export function setRole(role: Role) {
    currentRole = role;

    if (currentRole === "proxy") {
        // If becoming a proxy, close any connections to other proxy hosts
        for (const [peerId, meta] of knownRoomPeers) {
            if (meta?.role === "proxy") {
                const pc = getConnection(peerId);
                if (pc) {
                    pc.close();
                    Peers.delete(peerId);
                }
            }
        }
    } else if (currentRole === "client") {
        checkAndConnect();
    }
}

SS.on("room_joined", (msg) => {
    knownRoomPeers.clear();
    for (const peer of msg.peers) {
        knownRoomPeers.set(peer.peer_id, peer.metadata || {});
    }
    checkAndConnect();
    Peers.notifyListeners();
});

SS.on("peer_joined", (msg) => {
    knownRoomPeers.set(msg.peer_id, msg.metadata || {});
    checkAndConnect();
    Peers.notifyListeners();
});

SS.on("peer_metadata_updated", (msg) => {
    knownRoomPeers.set(msg.peer_id, msg.metadata || {});
    checkAndConnect();
    Peers.notifyListeners();
});

SS.on("peer_left", (msg) => {
    knownRoomPeers.delete(msg.peer_id);
    const pc = getConnection(msg.peer_id);
    if (pc) {
        pc.close();
        Peers.delete(msg.peer_id);
    }
    Peers.notifyListeners();
});

SS.on("peer_offer", (msg) => {
    const fromMeta = knownRoomPeers.get(msg.from_peer);
    if (currentRole === "proxy" && fromMeta?.role === "proxy") {
        console.warn(`[Peers] Rejected offer from peer ${msg.from_peer}: both peers are proxy hosts`);
        return;
    }
    handleOffer(msg.from_peer, msg.sdp);
});

SS.on("peer_answer", async (msg) => {
    const { from_peer, sdp } = msg;
    const pc = getConnection(from_peer);
    if (!pc) return;

    await pc.setRemoteDescription(
        new RTCSessionDescription({ type: "answer", sdp }),
    );
});

SS.on("peer_ice_candidate", async (msg) => {
    const { from_peer, candidate } = msg;
    const pc = getConnection(from_peer);
    if (!pc) return;

    await pc.addIceCandidate(new RTCIceCandidate(candidate));
});
