import {
  type Signal,
  type ControlMessage,
  SIGNAL_SERVER_URL,
  STUN_SERVERS,
  isValidSignal,
} from "./protocol";

export { SIGNAL_SERVER_URL };

export interface ConnectionCallbacks {
  onPeerJoined?: (peerId: string) => void;
  onPeerLeft?: (peerId: string) => void;
  onChannelState?: (isOpen: boolean) => void;
  onConnectionState?: (state: RTCPeerConnectionState) => void;
  onControlMessage?: (msg: ControlMessage | string) => void;
  onTransferChunk?: (chunk: ArrayBuffer) => void;
}

export class ConnectionManager {
  private peerId: string;
  private roomId: string;
  private callbacks: ConnectionCallbacks;
  private socket: WebSocket | null = null;
  private peerConnection: { peer_id: string; conn: RTCPeerConnection } | null =
    null;
  private controlChannel: RTCDataChannel | null = null;
  private transferChannel: RTCDataChannel | null = null;

  constructor(
    peerId: string,
    roomId: string,
    callbacks: ConnectionCallbacks = {},
  ) {
    this.peerId = peerId;
    this.roomId = roomId;
    this.callbacks = callbacks;
  }

  public connect(): void {
    this.socket = new WebSocket(`${SIGNAL_SERVER_URL}?peer_id=${this.peerId}`);

    this.socket.onopen = () => {
      this.sendSignal({ type: "join", room_id: this.roomId });
    };

    this.socket.onmessage = async (event: MessageEvent<Signal>) => {
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

      await this.handleSignal(message);
    };

    this.socket.onclose = () => {
      console.warn("[Signaling] Server disconnected. Reconnecting in 3s...");
      setTimeout(() => this.connect(), 3000);
    };
  }

  public sendControl(msg: ControlMessage | string): void {
    if (this.controlChannel && this.controlChannel.readyState === "open") {
      const payload = typeof msg === "string" ? msg : JSON.stringify(msg);
      this.controlChannel.send(payload);
    }
  }

  public getTransferChannel(): RTCDataChannel | null {
    return this.transferChannel;
  }

  public isReady(): boolean {
    return (
      this.controlChannel !== null &&
      this.controlChannel.readyState === "open" &&
      this.transferChannel !== null &&
      this.transferChannel.readyState === "open"
    );
  }

  private sendSignal(payload: any): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private async handleSignal(message: Signal): Promise<void> {
    switch (message.type) {
      case "room_joined":
        if (message.peers.length > 0) {
          const first = message.peers[0];
          const peerId = typeof first === "string" ? first : first?.peer_id;
          if (peerId) {
            this.callbacks.onPeerJoined?.(peerId);
          }
        }
        break;

      case "peer_joined":
        this.callbacks.onPeerJoined?.(message.peer_id);
        await this.handleInitiatorHandshake(message.peer_id);
        break;

      case "peer_offer":
        this.callbacks.onPeerJoined?.(message.from_peer);
        await this.handleReceiverHandshake(message.from_peer, message.sdp);
        break;

      case "peer_answer":
        if (
          this.peerConnection &&
          this.peerConnection.peer_id === message.from_peer
        ) {
          await this.peerConnection.conn.setRemoteDescription(
            new RTCSessionDescription({ type: "answer", sdp: message.sdp }),
          );
        }
        break;

      case "peer_ice_candidate":
        if (this.peerConnection) {
          try {
            await this.peerConnection.conn.addIceCandidate(
              new RTCIceCandidate(message.candidate),
            );
          } catch (err) {
            console.error("[WebRTC] ICE candidate error:", err);
          }
        }
        break;

      case "peer_left":
        this.callbacks.onPeerLeft?.(message.peer_id);
        this.closePeerConnection(message.peer_id);
        break;
    }
  }

  private createPeerConnection(remotePeerId: string): {
    peer_id: string;
    conn: RTCPeerConnection;
  } {
    if (this.peerConnection) return this.peerConnection;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: STUN_SERVERS }],
    });

    this.peerConnection = { peer_id: remotePeerId, conn: pc };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal({
          type: "ice_candidate",
          peer_id: remotePeerId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      this.callbacks.onConnectionState?.(pc.connectionState);
    };

    return this.peerConnection;
  }

  private async handleInitiatorHandshake(remotePeerId: string): Promise<void> {
    const peerConn = this.createPeerConnection(remotePeerId);
    const pc = peerConn.conn;

    const ctrl = pc.createDataChannel("control", { ordered: true });
    this.setupControlChannel(ctrl);

    const trans = pc.createDataChannel("transfer", { ordered: true });
    this.setupTransferChannel(trans);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.sendSignal({
      type: "offer",
      peer_id: remotePeerId,
      sdp: offer.sdp,
    });
  }

  private async handleReceiverHandshake(
    fromPeer: string,
    sdp: string,
  ): Promise<void> {
    const peerConn = this.createPeerConnection(fromPeer);
    const pc = peerConn.conn;

    pc.ondatachannel = (event) => {
      if (event.channel.label === "control") {
        this.setupControlChannel(event.channel);
      } else if (event.channel.label === "transfer") {
        this.setupTransferChannel(event.channel);
      }
    };

    await pc.setRemoteDescription(
      new RTCSessionDescription({ type: "offer", sdp }),
    );
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.sendSignal({
      type: "answer",
      peer_id: fromPeer,
      sdp: answer.sdp,
    });
  }

  private setupControlChannel(channel: RTCDataChannel): void {
    this.controlChannel = channel;

    channel.onopen = () => this.checkReadiness();
    channel.onclose = () => this.checkReadiness();

    channel.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const msg = JSON.parse(event.data) as ControlMessage;
        this.callbacks.onControlMessage?.(msg);
      } catch {
        this.callbacks.onControlMessage?.(event.data);
      }
    };
  }

  private setupTransferChannel(channel: RTCDataChannel): void {
    this.transferChannel = channel;
    this.transferChannel.binaryType = "arraybuffer";
    this.transferChannel.bufferedAmountLowThreshold = 512 * 1024;

    channel.onopen = () => this.checkReadiness();
    channel.onclose = () => this.checkReadiness();

    channel.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (event.data instanceof ArrayBuffer) {
        this.callbacks.onTransferChunk?.(event.data);
      }
    };
  }

  private checkReadiness(): void {
    this.callbacks.onChannelState?.(this.isReady());
  }

  private closePeerConnection(remotePeerId: string): void {
    if (this.peerConnection && this.peerConnection.peer_id === remotePeerId) {
      this.controlChannel?.close();
      this.controlChannel = null;
      this.transferChannel?.close();
      this.transferChannel = null;
      this.peerConnection.conn.close();
      this.peerConnection = null;
      this.callbacks.onChannelState?.(false);
    }
  }
}
