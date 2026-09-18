import { PEER_ID } from "./peerId";
import { SS, type SignalingServer } from "./signaling";

export const STUN_SERVERS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:stun2.l.google.com:19302",
  "stun:stun3.l.google.com:19302",
  "stun:stun4.l.google.com:19302",
];

type Peer = {
  id: string;
  conn: RTCPeerConnection;
};

function getConnection(peerId: string) {
  const peer = Peers.get(peerId);
  return peer ? peer.conn : null;
}

const Peers = new Map<string, Peer>();

type mode = "server" | "normal";

export type PeerManager = {
  mode: mode;
  signaling: SignalingServer;
  createConnection(peerId: string): RTCPeerConnection;
  sendOffer(peerId: string): Promise<void>;
  handleOffer(fromPeer: string, sdp: string): Promise<void>;
};

export function PeerManager(
  mode: mode,
  signaling: SignalingServer = SS,
): PeerManager {
  const peerManager: PeerManager = {
    mode,
    signaling,

    createConnection(peerId: string) {
      let pc = getConnection(peerId);
      if (pc) return pc;

      pc = new RTCPeerConnection({
        iceServers: [{ urls: STUN_SERVERS }],
      });

      Peers.set(peerId, { id: peerId, conn: pc });

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          signaling.sendSignal({
            type: "ice_candidate",
            peer_id: peerId,
            candidate: event.candidate,
          });
        }
      };

      pc.onconnectionstatechange = () => {
        // Connection state changes can be handled here
      };

      return pc;
    },

    async sendOffer(peerId: string): Promise<void> {
      const pc = this.createConnection(peerId);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const exp = pc.createDataChannel("experiment", { ordered: true });
      setupExpChannel(exp);

      // const trans = pc.createDataChannel("transfer", { ordered: true });
      // this.setupTransferChannel(trans);

      if (offer.sdp) {
        signaling.sendSignal({
          type: "offer",
          peer_id: PEER_ID,
          sdp: offer.sdp,
        });
      }
    },

    async handleOffer(fromPeer: string, sdp: string): Promise<void> {
      if (mode == "normal" && Peers.size >= 1) {
        return;
      }
      const pc = this.createConnection(fromPeer);

      // pc.ondatachannel = (event) => {
      //   if (event.channel.label === "control") {
      //     this.setupControlChannel(event.channel);
      //   } else if (event.channel.label === "transfer") {
      //     this.setupTransferChannel(event.channel);
      //   }
      // };

      await pc.setRemoteDescription(
        new RTCSessionDescription({ type: "offer", sdp }),
      );
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      if (answer.sdp) {
        signaling.sendSignal({
          type: "answer",
          peer_id: fromPeer,
          sdp: answer.sdp,
        });
      }
    },
  };

  signaling.on("peer_offer", (msg) => {
    peerManager.handleOffer(msg.from_peer, msg.sdp);
  });

  signaling.on("peer_answer", async (msg) => {
    const { from_peer, sdp } = msg;
    const pc = getConnection(from_peer);
    if (!pc) return;

    await pc.setRemoteDescription(
      new RTCSessionDescription({ type: "answer", sdp }),
    );
  });

  signaling.on("peer_ice_candidate", async (msg) => {
    const { from_peer, candidate } = msg;
    const pc = getConnection(from_peer);
    if (!pc) return;

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error("[WebRTC] ICE candidate error:", err);
    }
  });

  signaling.on("peer_left", (msg) => {
    const { peer_id } = msg;
    const pc = getConnection(peer_id);
    if (pc) {
      pc.close();
      Peers.delete(peer_id);
    }
  });

  return peerManager;
}

export const PeerMan = PeerManager("normal", SS);

function setupExpChannel(channel: RTCDataChannel) {
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = 512 * 1024;

  channel.onopen = () => {
    console.log("[EXP] Open");
  };
  channel.onclose = () => {
    console.log("[EXP] Close");
  };

  channel.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    if (event.data instanceof ArrayBuffer) {
      console.log("[EXP] Received chunk of size", event.data.byteLength);
    }
  };
}
