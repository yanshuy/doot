"use strict";
(() => {
  // src/js/proxy/http.ts
  var REQUEST_BODY_CHUNK = "REQUEST_BODY_CHUNK";
  var REQUEST_END = "REQUEST_END";
  var REQUEST_ERROR = "REQUEST_ERROR";
  var RESPONSE_HEADER = "RESPONSE_HEADER";
  var RESPONSE_BODY_CHUNK = "RESPONSE_BODY_CHUNK";
  var RESPONSE_END = "RESPONSE_END";
  var RESPONSE_ERROR = "RESPONSE_ERROR";
  var CRLF = "\r\n";
  var encoder = new TextEncoder();
  var decoder = new TextDecoder();
  function parseRawHead(data) {
    let headerEndIndex = -1;
    for (let i = data.length - 4; i >= 0; i--) {
      if (data[i] === 13 && data[i + 1] === 10 && data[i + 2] === 13 && data[i + 3] === 10) {
        headerEndIndex = i;
        break;
      }
    }
    if (headerEndIndex === -1) {
      return null;
    }
    const headStr = decoder.decode(data.subarray(0, headerEndIndex));
    const lines = headStr.split(CRLF);
    if (lines.length < 1 || !lines[0]) return null;
    const headers = new Headers();
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const colonIdx = line.indexOf(":");
      if (colonIdx !== -1) {
        headers.append(
          line.slice(0, colonIdx).trim(),
          line.slice(colonIdx + 1).trim()
        );
      }
    }
    return { startLine: lines[0], headers };
  }
  function parseResponseHead(data) {
    const parsed = parseRawHead(data);
    if (!parsed) return null;
    const [_, statusStr, ...statusParts] = parsed.startLine.split(" ");
    const status = parseInt(statusStr, 10);
    const statusText = statusParts.join(" ");
    return {
      status,
      statusText,
      headers: parsed.headers
    };
  }
  function serializeRequestHeader(req, overridePath) {
    const url = new URL(req.url);
    const pathToSend = overridePath ?? `${url.pathname}${url.search}`;
    const requestLine = `${req.method} ${pathToSend} HTTP/1.1`;
    const headerFields = [];
    req.headers.forEach((val, key) => {
      const lower = key.toLowerCase();
      if (lower === "host" || lower === "origin") {
        return;
      }
      headerFields.push(`${key}: ${val}`);
    });
    const headerStr = requestLine + CRLF + headerFields.join(CRLF) + CRLF + CRLF;
    return encoder.encode(headerStr);
  }

  // src/js/sw/templates.ts
  function getConnectingPromptHtml(roomId, proxyUrl) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Proxy Hub Required - Doot</title>
</head>
<body style="font-family:system-ui,-apple-system,sans-serif;padding:36px;background:#292d3e;color:#eef0f7;margin:0;line-height:1.4;">
  <h2 style="color:#89b4fa;margin:0 0 12px;font-size:20px;font-weight:600;">Proxy Hub Required</h2>
  <p style="margin:0 0 4px;font-size:14px;color:#eef0f7;">No active WebRTC peer bridge was found in this browser.</p>
  <p style="color:#a3a8c2;font-size:13px;margin:0 0 20px;">Open the client proxy hub in another tab to connect.</p>
  <p style="margin:0;">
    <a style="display:inline-block;padding:8px 16px;background:#89b4fa;color:#11111b;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;text-decoration:none;" href="${proxyUrl}" target="_blank" rel="noreferrer">Open Proxy Client Hub</a>
  </p>
  <script>
    const channel = new BroadcastChannel("doot_tunnel");
    channel.onmessage = (e) => {
      if (e.data?.type === "ready" && (!e.data.roomId || e.data.roomId === "${roomId}")) {
        window.location.reload();
      }
    };
  <\/script>
</body>
</html>`;
  }
  function getBadGatewayHtml(message) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>502 Bad Gateway</title>
</head>
<body style="font-family:system-ui,-apple-system,sans-serif;padding:36px;background:#292d3e;color:#eef0f7;margin:0;line-height:1.4;">
  <h2 style="color:#f38ba8;margin:0 0 12px;font-size:20px;font-weight:600;">502 Bad Gateway</h2>
  <p style="margin:0 0 4px;font-size:14px;color:#eef0f7;">The proxy request over WebRTC failed or the local server refused the connection.</p>
  <p style="color:#a3a8c2;font-size:13px;margin:0 0 20px;">${message || "Make sure your local application is running and the host tab is active."}</p>
  <p style="margin:0;">
    <button style="padding:8px 16px;background:#89b4fa;color:#11111b;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;" onclick="window.location.reload()">Retry</button>
  </p>
  <script>
    const channel = new BroadcastChannel("doot_tunnel");
    channel.onmessage = (e) => {
      if (e.data?.type === "ready") {
        window.location.reload();
      }
    };
  <\/script>
</body>
</html>`;
  }

  // src/js/sw/sw.ts
  var PROXY_RESPONSE_PLACEHOLDER = "PROXY_RESPONSE_PLACEHOLDER";
  var PROXY_REQUEST_START = "PROXY_REQUEST_START";
  var REQUEST_BODY_START = "REQUEST_BODY_START";
  var sw = self;
  async function getProxyClient(roomId) {
    const clients = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
    return clients.find((c) => {
      try {
        const u = new URL(c.url);
        return u.pathname === "/proxy" && (u.searchParams.get("name") === roomId || u.searchParams.get("room") === roomId);
      } catch {
        return false;
      }
    }) || null;
  }
  sw.addEventListener("install", () => {
    sw.skipWaiting();
  });
  sw.addEventListener("activate", (ev) => {
    ev.waitUntil(sw.clients.claim());
  });
  function parseTunnelRoute(url) {
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
    if (url.pathname === "/sw.js") return;
    ev.respondWith(handleFetch(ev, url));
  });
  async function handleFetch(ev, url) {
    let roomId = null;
    let targetPath = null;
    const tunnelRoute = parseTunnelRoute(url);
    if (tunnelRoute) {
      roomId = tunnelRoute.roomId;
      targetPath = tunnelRoute.targetPath;
    } else {
      if (ev.clientId) {
        try {
          const client = await sw.clients.get(ev.clientId);
          if (client) {
            const clientRoute = parseTunnelRoute(new URL(client.url));
            if (clientRoute) {
              roomId = clientRoute.roomId;
              targetPath = url.pathname + url.search;
            }
          }
        } catch {
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
          } catch {
          }
        }
      }
    }
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
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }
    return tunnelRequest(ev, proxyClient, targetPath);
  }
  async function tunnelRequest(ev, proxyClient, targetPath) {
    const headBytes = serializeRequestHeader(ev.request, targetPath);
    const msgChannel = new MessageChannel();
    const localPort = msgChannel.port1;
    const remotePort = msgChannel.port2;
    const body = ev.request.body;
    proxyClient.postMessage(
      {
        type: PROXY_REQUEST_START,
        head: headBytes.buffer,
        hasBody: body != null
      },
      [remotePort, headBytes.buffer]
    );
    return responsePromise(localPort, body);
  }
  function responsePromise(port, body) {
    return new Promise((resolve, reject) => {
      let streamController = null;
      const responseStream = new ReadableStream({
        start(controller) {
          streamController = controller;
        }
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
                  headers: parsed.headers
                })
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
                headers: { "Content-Type": "text/html; charset=utf-8" }
              })
            );
            break;
          }
        }
      };
      port.start();
    });
  }
  async function readLoop(reader, localPort) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          localPort.postMessage({ type: REQUEST_END });
          break;
        }
        localPort.postMessage(
          { type: REQUEST_BODY_CHUNK, buffer: value.buffer },
          [value.buffer]
        );
      }
    } catch (e) {
      localPort.postMessage({ type: REQUEST_ERROR });
    }
  }
})();
