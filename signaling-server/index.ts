import {
  INVALID_MESSAGE,
  INVALID_JSON,
  INTERNAL_ERROR,
  MESSAGE_TOO_LARGE,
} from "./src/errors";
import {
  HandleMessage,
  ParseMessage,
  PublishMessage,
  SendMessage,
  Signal,
} from "./src/messages";
import { ActivePeers, Rooms, Metrics, type PeerState } from "./src/state";

export const MAX_MESSAGE_SIZE = 64 * 1024; // 64 KB limit

console.log("Signaling Server running on ws://localhost:3333");
Bun.serve<PeerState>({
  port: 3333,
  fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path == "/hi") {
      return new Response("Hello!!", { status: 200 });
    } else if (path == "/yo") {
      Metrics.totalConnectRequests++;
      console.log(`[Connect Request] Total received: ${Metrics.totalConnectRequests}, Total active connections: ${ActivePeers.size}`);

      let peer_id = url.searchParams.get("peer_id");
      if (peer_id == null) {
        return new Response("peer_id id missing", { status: 400 });
      }
      if (!isValidUUID(peer_id)) {
        return new Response("peer_id must be a valid UUID.", {
          status: 400,
        });
      }

      const success = server.upgrade(req, {
        data: { id: peer_id, rooms: new Set<string>() },
      });

      return success
        ? undefined
        : new Response("WebSocket upgrade failed", { status: 400 });
    } else {
      return new Response(null, { status: 404 });
    }
  },
  websocket: {
    maxPayloadLength: MAX_MESSAGE_SIZE,
    open(ws) {
      const { id } = ws.data;

      const prev_ws = ActivePeers.get(id);
      if (prev_ws && prev_ws != ws) {
        prev_ws.close(4001, "Replaced by new connection");
      }

      ActivePeers.set(id, ws);
    },

    message(ws, rawData) {
      if (typeof rawData != "string") {
        SendMessage(ws, Signal("error", { code: INVALID_MESSAGE }));
        return;
      }

      if (rawData.length > MAX_MESSAGE_SIZE) {
        SendMessage(
          ws,
          Signal("error", {
            code: MESSAGE_TOO_LARGE,
            message: `Message size exceeds ${MAX_MESSAGE_SIZE} bytes limit`,
          }),
        );
        return;
      }

      try {
        let message = JSON.parse(rawData);

        let result = ParseMessage(message);
        if (result.ok) {
          HandleMessage(ws, result.result);
        } else {
          SendMessage(ws, Signal("error", { code: INVALID_MESSAGE, message: result.result }));
        }
      } catch (err) {
        console.error(`Peer: ${ws.data.id}:`, err);
        SendMessage(ws, Signal("error", { code: INTERNAL_ERROR }));
      }
    },

    close(ws) {
      onClose(ws);
    },
  },
});

function onClose(ws: Bun.ServerWebSocket<PeerState>) {
  const { id, rooms } = ws.data;

  if (ActivePeers.get(id) === ws) {
    ActivePeers.delete(id);
  }

  for (const room_id of rooms) {
    ws.unsubscribe(room_id);

    const peers = Rooms.get(room_id);
    if (peers) {
      peers.delete(id);
      if (peers.size === 0) {
        Rooms.delete(room_id);
      }
    }

    const msg = Signal("peer_left", { peer_id: id, room_id });
    PublishMessage(ws, room_id, msg);
  }
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(id: string): boolean {
  return UUID_REGEX.test(id);
}
