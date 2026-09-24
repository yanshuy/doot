import { openDB, type IDBPDatabase } from "idb";
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
import { ProxyHubRequiredHtml, BadGatewayHtml } from "./templates";

import {
  TUNNEL_PARAM,
  getClientRoom,
  saveClientRoom,
  extractTunnel,
} from "./roomRegistry";

const sw = self as unknown as ServiceWorkerGlobalScope & typeof globalThis;

sw.addEventListener("install", () => {
  sw.skipWaiting();
});

sw.addEventListener("activate", (ev) => {
  ev.waitUntil(sw.clients.claim());
});

//control message
export const PROXY_REQUEST_START = "PROXY_REQUEST_START";

async function getProxyClient(roomId: string): Promise<Client | null> {
  const clients = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
  const client = clients.find((c) => {
    const u = new URL(c.url);
    return u.pathname.startsWith("/proxy") && u.searchParams.get("name") == roomId;
  })
  return client || null;
}


sw.addEventListener("fetch", (ev) => {
  const url = new URL(ev.request.url);
  if (url.origin != sw.location.origin) return;

  // Not intercept the service worker script itself
  if (url.pathname == "/sw.js") return;

  ev.respondWith(handleFetch(ev, url));
});

async function handleFetch(ev: FetchEvent, url: URL): Promise<Response> {
  let roomId: string | null = null;
  let targetPath: string = url.pathname + url.search;

  const tunnel = extractTunnel(url);
  if (tunnel) {
    roomId = tunnel.roomId;
    targetPath = tunnel.targetPath;
  } else if (ev.clientId) {
    roomId = await getClientRoom(ev.clientId);
  }

  if (!roomId) {
    return fetch(ev.request);
  }

  const targetClientId = ev.resultingClientId || ev.clientId;
  if (targetClientId) {
    saveClientRoom(targetClientId, roomId);
  }

  if (ev.request.mode == "navigate" && !url.searchParams.has(TUNNEL_PARAM)) {
    const nextUrl = new URL(url.toString());
    nextUrl.searchParams.set(TUNNEL_PARAM, roomId);
    return Response.redirect(nextUrl.toString(), 302);
  }

  const proxyClient = await getProxyClient(roomId);

  if (!proxyClient) {
    const proxyUrl = `${url.origin}/proxy?name=${encodeURIComponent(roomId)}&mode=client`;
    return new Response(ProxyHubRequiredHtml(roomId, proxyUrl), {
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

  if (body) {
    readLoop(body.getReader(), localPort);
  }

  return responsePromise(localPort, body);
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
        case RESPONSE_HEADER: {
          const data = new Uint8Array(event.data.buffer);
          const parsed = parseResponseHead(data);
          if (parsed) {
            resolve(
              new Response(responseStream, {
                status: parsed.status,
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
            new Response(BadGatewayHtml(), {
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

