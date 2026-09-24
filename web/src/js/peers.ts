import { setupHostChannel } from "./proxy/host";
import { SS } from "./signaling";
import { PEER_ID } from "./peerId";
export { PEER_ID };

export type Role = "proxy" | "client";
export let currentRole: Role = "client";

export interface PeerState {
    id: string;
    role?: Role;
    username?: string;
    target_host?: string;
    conn?: RTCPeerConnection;
    [key: string]: any;
}

export const Peers = {
    map: new Map<string, PeerState>(),
    listeners: new Set<(peers: Map<string, PeerState>) => void>(),

    onchange(listener: (peers: Map<string, PeerState>) => void) {
        Peers.listeners.add(listener);
        return () => {
            Peers.listeners.delete(listener);
        };
    },

    notify() {
        for (const listener of Peers.listeners) {
            try {
                listener(Peers.map);
            } catch (err) {
                console.error("[Peers] Listener error:", err);
            }
        }
    },

    get(peerId: string): PeerState | undefined {
        return Peers.map.get(peerId);
    },

    setMeta(peerId: string, metadata: Partial<PeerState>) {
        const existing = Peers.map.get(peerId) || { id: peerId };
        Object.assign(existing, metadata);
        Peers.map.set(peerId, existing);
        Peers.notify();
    },

    setConn(peerId: string, conn: RTCPeerConnection) {
        const existing = Peers.map.get(peerId) || { id: peerId };
        existing.conn = conn;
        Peers.map.set(peerId, existing);
        Peers.notify();
    },

    delete(peerId: string) {
        const peer = Peers.map.get(peerId);
        if (peer?.conn) {
            peer.conn.close();
        }
        Peers.map.delete(peerId);
        Peers.notify();
    },

    clear() {
        for (const peer of Peers.map.values()) {
            if (peer.conn) {
                peer.conn.close();
            }
        }
        Peers.map.clear();
        Peers.notify();
    },
};

export let selectedHostPeerId: string | null = null;

export function getConnection(peerId: string): RTCPeerConnection | undefined {
    return Peers.map.get(peerId)?.conn;
}

export const STUN_SERVERS = [
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
    "stun:stun2.l.google.com:19302",
    "stun:stun3.l.google.com:19302",
    "stun:stun4.l.google.com:19302",
];

export function createConnection(peerId: string): RTCPeerConnection {
    let pc = getConnection(peerId);
    if (pc) return pc;

    pc = new RTCPeerConnection({
        iceServers: [{ urls: STUN_SERVERS }],
    });

    Peers.setConn(peerId, pc);

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
            const peer = Peers.map.get(peerId);
            if (peer) {
                peer.conn = undefined;
            }
            Peers.notify();
        } else if (pc.connectionState === "connected") {
            Peers.notify();
        }
    };

    return pc;
}

export async function sendOffer(peerId: string): Promise<void> {
    if (currentRole !== "client") {
        console.warn(`[Peers] Cannot send offer: current role is "${currentRole}" (only clients can initiate)`);
        return;
    }
    const targetPeer = Peers.map.get(peerId);
    if (targetPeer?.role !== "proxy") {
        console.warn(`[Peers] Cannot send offer to peer ${peerId}: target is not a proxy (role: ${targetPeer?.role})`);
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

export function selectHost(peerId: string | null) {
    if (selectedHostPeerId === peerId) return;

    // Disconnect from previous host connection if switching
    if (selectedHostPeerId) {
        const oldPc = getConnection(selectedHostPeerId);
        if (oldPc) {
            oldPc.close();
            const oldPeer = Peers.map.get(selectedHostPeerId);
            if (oldPeer) oldPeer.conn = undefined;
        }
    }

    selectedHostPeerId = peerId;
    if (selectedHostPeerId && currentRole === "client") {
        sendOffer(selectedHostPeerId);
    }
    Peers.notify();
}

function checkAndConnect() {
    if (currentRole !== "client") return;

    // If client selected a specific host peer, connect to that one
    if (selectedHostPeerId) {
        if (!getConnection(selectedHostPeerId) && Peers.map.has(selectedHostPeerId)) {
            sendOffer(selectedHostPeerId);
        }
        return;
    }
}

export function setRole(role: Role) {
    currentRole = role;

    if (currentRole === "proxy") {
        // If becoming a proxy, close any connections to other proxy hosts
        for (const [peerId, peer] of Peers.map) {
            if (peer.role === "proxy" && peer.conn) {
                peer.conn.close();
                peer.conn = undefined;
            }
        }
        Peers.notify();
    } else if (currentRole === "client") {
        checkAndConnect();
    }
}

SS.on("room_joined", (msg) => {
    Peers.clear();
    for (const peer of msg.peers) {
        Peers.setMeta(peer.peer_id, {
            id: peer.peer_id,
            role: peer.metadata?.role,
            username: peer.metadata?.username,
            target_host: peer.metadata?.target_host,
            ...peer.metadata,
        });
    }
    checkAndConnect();
});

SS.on("peer_joined", (msg) => {
    Peers.setMeta(msg.peer_id, {
        id: msg.peer_id,
        role: msg.metadata?.role,
        username: msg.metadata?.username,
        target_host: msg.metadata?.target_host,
        ...msg.metadata,
    });
    checkAndConnect();
});

SS.on("peer_metadata_updated", (msg) => {
    Peers.setMeta(msg.peer_id, {
        role: msg.metadata?.role,
        username: msg.metadata?.username,
        target_host: msg.metadata?.target_host,
        ...msg.metadata,
    });
    checkAndConnect();
});

SS.on("peer_left", (msg) => {
    if (selectedHostPeerId === msg.peer_id) {
        selectedHostPeerId = null;
    }
    Peers.delete(msg.peer_id);
});

SS.on("peer_offer", (msg) => {
    const fromMeta = Peers.map.get(msg.from_peer);
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
