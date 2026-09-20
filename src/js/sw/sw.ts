import {
  REQUEST_BODY_CHUNK,
  REQUEST_END,
  REQUEST_ERROR,

  RESPONSE_HEADER,
  RESPONSE_BODY_CHUNK,
  RESPONSE_END,
  RESPONSE_ERROR,

  parseResponseHead,
  serializeRequestHeader,
} from "../proxy/http";
import { getConnectingPromptHtml, getBadGatewayHtml } from "./templates";

//control message
export const PROXY_RESPONSE_PLACEHOLDER = "PROXY_RESPONSE_PLACEHOLDER";
export const PROXY_REQUEST_START = "PROXY_REQUEST_START";
export const REQUEST_BODY_START = "REQUEST_BODY_START";

const sw = self as unknown as ServiceWorkerGlobalScope & typeof globalThis;

async function getProxyClient(roomId: string): Promise<Client | null> {
  const clients = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
  return (
    clients.find((c) => {
      try {
        const u = new URL(c.url);
        const path = u.pathname.replace(/\/+$/, "");
        return path === "/proxy" && u.searchParams.get("name") === roomId;
      } catch {
        return false;
      }
    }) || null
  );
}

sw.addEventListener("install", () => {
  sw.skipWaiting();
});

sw.addEventListener("activate", (ev) => {
  ev.waitUntil(sw.clients.claim());
});

// Parses ?doot_tunnel=roomId and returns targetPath
export function parseTunnelRoute(
  url: URL,
): { roomId: string; targetPath: string } | null {
  const queryRoom = url.searchParams.get("doot_tunnel");
  if (queryRoom) {
    const cleanParams = new URLSearchParams(url.search);
    cleanParams.delete("doot_tunnel");
    const queryStr = cleanParams.toString();
    const targetPath = url.pathname + (queryStr ? `?${queryStr}` : "");
    return { roomId: queryRoom, targetPath };
  }
  return null;
}

sw.addEventListener("fetch", (ev) => {
  const url = new URL(ev.request.url);
  if (url.origin != sw.location.origin) return;

  // Never intercept the service worker script itself
  if (url.pathname === "/sw.js") return;

  ev.respondWith(handleFetch(ev, url));
});

async function handleFetch(ev: FetchEvent, url: URL): Promise<Response> {
  let roomId: string | null = null;
  let targetPath: string | null = null;

  const tunnelRoute = parseTunnelRoute(url);
  if (tunnelRoute) {
    roomId = tunnelRoute.roomId;
    targetPath = tunnelRoute.targetPath;
  } else {
    if (ev.clientId) {
      const client = await sw.clients.get(ev.clientId);
      if (client) {
        const clientRoute = parseTunnelRoute(new URL(client.url));
        if (clientRoute) {
          roomId = clientRoute.roomId;
          targetPath = url.pathname + url.search;
        }
      }
    }

    if (!roomId) {
      const referer = ev.request.headers.get("referer");
      if (referer) {
        try {
          const refRoute = parseTunnelRoute(new URL(referer));
          if (refRoute) {
            roomId = refRoute.roomId;
            targetPath = url.pathname + url.search;
          }
        } catch { }
      }
    }
  }

  // Not a tunnel request or from a tunneled page
  if (!roomId || !targetPath) {
    return fetch(ev.request);
  }

  if (ev.request.mode === "navigate" && !url.searchParams.has("doot_tunnel")) {
    const nextUrl = new URL(url.toString());
    nextUrl.searchParams.set("doot_tunnel", roomId);
    return Response.redirect(nextUrl.toString(), 302);
  }

  const proxyClient = await getProxyClient(roomId);

  if (!proxyClient) {
    const proxyUrl = `${url.origin}/proxy?name=${encodeURIComponent(roomId)}&mode=client`;
    return new Response(getConnectingPromptHtml(roomId, proxyUrl), {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return tunnelRequest(ev, proxyClient, targetPath);
}

async function tunnelRequest(
  ev: FetchEvent,
  proxyClient: Client,
  targetPath: string,
): Promise<Response> {
  const headBytes = serializeRequestHeader(ev.request, targetPath);
  const msgChannel = new MessageChannel();
  const localPort = msgChannel.port1;
  const remotePort = msgChannel.port2;
  const body = ev.request.body;

  proxyClient.postMessage(
    {
      type: PROXY_REQUEST_START,
      head: headBytes.buffer,
      hasBody: body != null,
    },
    [remotePort, headBytes.buffer],
  );

  return responsePromise(localPort, body);
}

function responsePromise(
  port: MessagePort,
  body: ReadableStream<Uint8Array<ArrayBuffer>> | null,
) {
  return new Promise<Response>((resolve, reject) => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

    const responseStream = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller },
    });

    port.onmessage = (event) => {
      switch (event.data.type) {
        case REQUEST_BODY_START: {
          if (body) {
            const reader = body.getReader();
            readLoop(reader, port);
          }
          break;
        }

        case RESPONSE_HEADER: {
          const data = new Uint8Array(event.data.buffer);
          const parsed = parseResponseHead(data);
          if (parsed) {
            resolve(
              new Response(responseStream, {
                status: parsed.status,
                statusText: parsed.statusText,
                headers: parsed.headers,
              }),
            );
          }
          break;
        }

        case RESPONSE_BODY_CHUNK: {
          streamController?.enqueue(new Uint8Array(event.data.buffer));
          break;
        }

        case RESPONSE_END: {
          streamController?.close();
          port.close();
          break;
        }

        case RESPONSE_ERROR: {
          if (streamController) {
            streamController.error(new Error("P2P Stream Error"));
          }
          port.close();
          resolve(
            new Response(getBadGatewayHtml(), {
              status: 502,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            }),
          );
          break;
        }
      }
    };
    port.start();
  });
}

async function readLoop(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  localPort: MessagePort,
) {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        localPort.postMessage({ type: REQUEST_END });
        break;
      }
      localPort.postMessage(
        { type: REQUEST_BODY_CHUNK, buffer: value.buffer },
        [value.buffer],
      );
    }
  } catch (e) {
    localPort.postMessage({ type: REQUEST_ERROR });
  }
}
