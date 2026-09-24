import { describe, it, expect, beforeEach } from "bun:test";
import { ParseMessage, HandleMessage, Signal } from "../src/messages";
import { Rooms, ActivePeers, type PeerState } from "../src/state";

describe("Signaling Server - Message Parsing", () => {
  it("should parse join message with arbitrary metadata", () => {
    const raw = {
      type: "join",
      room_id: "test-room",
      metadata: {
        customField: "hello",
        tags: [1, 2, 3],
        nested: { a: true },
      },
    };
    const result = ParseMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({
        type: "join",
        room_id: "test-room",
        metadata: {
          customField: "hello",
          tags: [1, 2, 3],
          nested: { a: true },
        },
      });
    }
  });

  it("should parse join message without metadata", () => {
    const raw = {
      type: "join",
      room_id: "test-room",
    };
    const result = ParseMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({
        type: "join",
        room_id: "test-room",
        metadata: undefined,
      });
    }
  });

  it("should parse update_metadata message with arbitrary payload", () => {
    const raw = {
      type: "update_metadata",
      room_id: "test-room",
      metadata: {
        customState: "active",
        count: 42,
      },
    };
    const result = ParseMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({
        type: "update_metadata",
        room_id: "test-room",
        metadata: {
          customState: "active",
          count: 42,
        },
      });
    }
  });

  it("should reject update_metadata when metadata field is missing", () => {
    const raw = {
      type: "update_metadata",
      room_id: "test-room",
    };
    const result = ParseMessage(raw);
    expect(result.ok).toBe(false);
  });
});

describe("Signaling Server - Message Handling & Broadcasts", () => {
  beforeEach(() => {
    Rooms.clear();
    ActivePeers.clear();
  });

  function createMockWs(id: string, initialMetadata?: any) {
    const sent: any[] = [];
    const published: { topic: string; message: any }[] = [];
    const subscriptions = new Set<string>();

    const ws = {
      data: {
        id,
        rooms: new Set<string>(),
        metadata: initialMetadata,
      } as PeerState,
      send(data: string) {
        sent.push(JSON.parse(data));
      },
      publish(topic: string, data: string) {
        published.push({ topic, message: JSON.parse(data) });
      },
      subscribe(topic: string) {
        subscriptions.add(topic);
      },
      unsubscribe(topic: string) {
        subscriptions.delete(topic);
      },
    } as unknown as Bun.ServerWebSocket<PeerState>;

    ActivePeers.set(id, ws);
    return { ws, sent, published, subscriptions };
  }

  it("A. room_joined should return list of existing peers with their metadata", () => {
    const peer1 = createMockWs("peer-1-host");
    const peer2 = createMockWs("peer-2-client");

    // Peer 1 joins as proxy host
    HandleMessage(peer1.ws, {
      type: "join",
      room_id: "room-abc",
      metadata: {
        role: "proxy",
        name: "Host Alpha",
        target_host: "http://localhost:8080",
      },
    });

    expect(peer1.sent.length).toBe(1);
    expect(peer1.sent[0]).toEqual({
      type: "room_joined",
      room_id: "room-abc",
      peers: [],
    });

    // Peer 2 joins as client
    HandleMessage(peer2.ws, {
      type: "join",
      room_id: "room-abc",
      metadata: {
        role: "client",
        name: "Client Beta",
      },
    });

    expect(peer2.sent.length).toBe(1);
    expect(peer2.sent[0]).toEqual({
      type: "room_joined",
      room_id: "room-abc",
      peers: [
        {
          peer_id: "peer-1-host",
          metadata: {
            role: "proxy",
            name: "Host Alpha",
            target_host: "http://localhost:8080",
          },
        },
      ],
    });
  });

  it("B. peer_joined should broadcast to existing peers in room with metadata", () => {
    const peer1 = createMockWs("peer-1-host");
    const peer2 = createMockWs("peer-2-client");

    // Peer 1 joins
    HandleMessage(peer1.ws, {
      type: "join",
      room_id: "room-xyz",
      metadata: {
        role: "proxy",
      },
    });

    // Peer 2 joins
    HandleMessage(peer2.ws, {
      type: "join",
      room_id: "room-xyz",
      metadata: {
        role: "client",
        name: "New Client",
      },
    });

    expect(peer2.published.length).toBe(1);
    expect(peer2.published[0]).toEqual({
      topic: "room-xyz",
      message: {
        type: "peer_joined",
        room_id: "room-xyz",
        peer_id: "peer-2-client",
        metadata: {
          role: "client",
          name: "New Client",
        },
      },
    });
  });

  it("C. peer_metadata_updated should broadcast when a peer toggles their role/metadata", () => {
    const peer1 = createMockWs("peer-1");

    // Peer 1 joins
    HandleMessage(peer1.ws, {
      type: "join",
      room_id: "room-toggle",
      metadata: {
        role: "client",
      },
    });

    // Peer 1 updates metadata to proxy host
    HandleMessage(peer1.ws, {
      type: "update_metadata",
      room_id: "room-toggle",
      metadata: {
        role: "proxy",
        name: "Toggled Host",
        target_host: "http://localhost:4321",
      },
    });

    expect(peer1.ws.data.metadata).toEqual({
      role: "proxy",
      name: "Toggled Host",
      target_host: "http://localhost:4321",
    });

    // Last published message on topic room-toggle
    const lastPublished = peer1.published[peer1.published.length - 1];
    expect(lastPublished).toEqual({
      topic: "room-toggle",
      message: {
        type: "peer_metadata_updated",
        room_id: "room-toggle",
        peer_id: "peer-1",
        metadata: {
          role: "proxy",
          name: "Toggled Host",
          target_host: "http://localhost:4321",
        },
      },
    });
  });
});

describe("Signaling Server - E2E WebSocket Server", () => {
  let server: any;
  const PORT = 3399;

  beforeEach(() => {
    Rooms.clear();
    ActivePeers.clear();
  });

  it("should handle join, room_joined, peer_joined, and update_metadata over WebSocket", async () => {
    // Spin up server on test port
    const { INVALID_MESSAGE, INTERNAL_ERROR } = await import("../src/errors");

    server = Bun.serve<PeerState>({
      port: PORT,
      fetch(req, srv) {
        const url = new URL(req.url);
        const peer_id = url.searchParams.get("peer_id");
        if (!peer_id) return new Response("missing peer_id", { status: 400 });
        const success = srv.upgrade(req, {
          data: { id: peer_id, rooms: new Set<string>() },
        });
        return success ? undefined : new Response("failed", { status: 400 });
      },
      websocket: {
        open(ws) {
          ActivePeers.set(ws.data.id, ws);
        },
        message(ws, rawData) {
          if (typeof rawData !== "string") return;
          const parsed = ParseMessage(JSON.parse(rawData));
          if (parsed.ok) {
            HandleMessage(ws, parsed.result);
          }
        },
        close(ws) {
          ActivePeers.delete(ws.data.id);
          for (const room_id of ws.data.rooms) {
            const peers = Rooms.get(room_id);
            if (peers) {
              peers.delete(ws.data.id);
              if (peers.size === 0) Rooms.delete(room_id);
            }
            ws.publish(room_id, JSON.stringify(Signal("peer_left", { room_id, peer_id: ws.data.id })));
          }
        },
      },
    });

    try {
      const p1Messages: any[] = [];
      const p2Messages: any[] = [];

      const ws1 = new WebSocket(`ws://localhost:${PORT}?peer_id=11111111-1111-1111-1111-111111111111`);
      const ws1Open = new Promise<void>((res) => (ws1.onopen = () => res()));
      ws1.onmessage = (e) => p1Messages.push(JSON.parse(e.data));

      await ws1Open;

      // Peer 1 joins as proxy
      ws1.send(
        JSON.stringify({
          type: "join",
          room_id: "test-e2e-room",
          metadata: {
            role: "proxy",
            name: "Server Host",
            target_host: "http://localhost:3000",
          },
        })
      );

      // Wait a moment for room_joined
      await new Promise((r) => setTimeout(r, 50));
      expect(p1Messages).toHaveLength(1);
      expect(p1Messages[0]).toEqual({
        type: "room_joined",
        room_id: "test-e2e-room",
        peers: [],
      });

      // Peer 2 joins
      const ws2 = new WebSocket(`ws://localhost:${PORT}?peer_id=22222222-2222-2222-2222-222222222222`);
      const ws2Open = new Promise<void>((res) => (ws2.onopen = () => res()));
      ws2.onmessage = (e) => p2Messages.push(JSON.parse(e.data));

      await ws2Open;

      ws2.send(
        JSON.stringify({
          type: "join",
          room_id: "test-e2e-room",
          metadata: {
            role: "client",
            name: "Client 2",
          },
        })
      );

      await new Promise((r) => setTimeout(r, 50));

      // Peer 2 should have received room_joined with peer 1's metadata
      expect(p2Messages).toHaveLength(1);
      expect(p2Messages[0]).toEqual({
        type: "room_joined",
        room_id: "test-e2e-room",
        peers: [
          {
            peer_id: "11111111-1111-1111-1111-111111111111",
            metadata: {
              role: "proxy",
              name: "Server Host",
              target_host: "http://localhost:3000",
            },
          },
        ],
      });

      // Peer 1 should have received peer_joined with peer 2's metadata
      expect(p1Messages).toHaveLength(2);
      expect(p1Messages[1]).toEqual({
        type: "peer_joined",
        room_id: "test-e2e-room",
        peer_id: "22222222-2222-2222-2222-222222222222",
        metadata: {
          role: "client",
          name: "Client 2",
        },
      });

      // Peer 2 updates metadata to proxy
      ws2.send(
        JSON.stringify({
          type: "update_metadata",
          room_id: "test-e2e-room",
          metadata: {
            role: "proxy",
            name: "Promoted Client",
            target_host: "http://localhost:5000",
          },
        })
      );

      await new Promise((r) => setTimeout(r, 50));

      // Peer 1 should receive peer_metadata_updated
      expect(p1Messages).toHaveLength(3);
      expect(p1Messages[2]).toEqual({
        type: "peer_metadata_updated",
        room_id: "test-e2e-room",
        peer_id: "22222222-2222-2222-2222-222222222222",
        metadata: {
          role: "proxy",
          name: "Promoted Client",
          target_host: "http://localhost:5000",
        },
      });

      ws1.close();
      ws2.close();
    } finally {
      server.stop(true);
    }
  });

  it("should reject messages exceeding MAX_MESSAGE_SIZE", async () => {
    const { MESSAGE_TOO_LARGE } = await import("../src/errors");

    server = Bun.serve<PeerState>({
      port: PORT,
      fetch(req, srv) {
        const url = new URL(req.url);
        const peer_id = url.searchParams.get("peer_id");
        if (!peer_id) return new Response("missing peer_id", { status: 400 });
        const success = srv.upgrade(req, {
          data: { id: peer_id, rooms: new Set<string>() },
        });
        return success ? undefined : new Response("failed", { status: 400 });
      },
      websocket: {
        maxPayloadLength: 64 * 1024,
        open(ws) {
          ActivePeers.set(ws.data.id, ws);
        },
        message(ws, rawData) {
          if (typeof rawData !== "string") return;
          if (rawData.length > 64 * 1024) {
            ws.send(JSON.stringify(Signal("error", { code: MESSAGE_TOO_LARGE, message: "message too large" })));
            return;
          }
          const parsed = ParseMessage(JSON.parse(rawData));
          if (parsed.ok) {
            HandleMessage(ws, parsed.result);
          }
        },
        close(ws) {
          ActivePeers.delete(ws.data.id);
        },
      },
    });

    try {
      const messages: any[] = [];
      const ws = new WebSocket(`ws://localhost:${PORT}?peer_id=33333333-3333-3333-3333-333333333333`);
      await new Promise<void>((res) => (ws.onopen = () => res()));
      ws.onmessage = (e) => messages.push(JSON.parse(e.data));

      // Send payload within size limit but with huge arbitrary metadata (10KB)
      const hugeString = "a".repeat(10 * 1024);
      ws.send(
        JSON.stringify({
          type: "join",
          room_id: "test-huge-room",
          metadata: {
            blob: hugeString,
          },
        })
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("room_joined");
      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
    } finally {
      server.stop(true);
    }
  });
});

