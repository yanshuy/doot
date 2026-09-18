// public/sw.js - P2P Network Interceptor Service Worker (Client Window Tracking)

const CRLF = "\r\n";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let requestId = 1;
const responseResolvers = new Map();
const TUNNEL_PREFIX = "/tunnel";
const P2P_TUNNEL_PREFIX = "/p2p-tunnel";

// Track window client IDs that belong to the tunneled application
const tunneledClientIds = new Set();

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(self.clients.claim());
});

async function isTunneledClient(clientId) {
  if (!clientId) return false;
  if (tunneledClientIds.has(clientId)) return true;
  try {
    const client = await self.clients.get(clientId);
    if (
      client &&
      (client.url.includes(TUNNEL_PREFIX) || client.url.includes(P2P_TUNNEL_PREFIX))
    ) {
      tunneledClientIds.add(clientId);
      return true;
    }
  } catch (e) {}
  return false;
}

self.addEventListener("fetch", (ev) => {
  // Prevent loopback if host proxy fetch originates from the same browser context
  if (ev.request.headers.has("X-Doot-Loopback")) {
    return;
  }

  const url = new URL(ev.request.url);

  // 1. External origins bypass
  if (url.origin !== self.location.origin) {
    return;
  }

  // 2. Doot controller pages and service worker script bypass
  if (
    url.pathname.startsWith("/proxy") ||
    url.pathname.startsWith("/room") ||
    url.pathname === "/sw.js" ||
    url.pathname === "/" ||
    url.pathname === "/index.html"
  ) {
    return;
  }

  // 3. Top-level Document Navigation
  if (ev.request.mode === "navigate") {
    ev.respondWith(
      (async () => {
        const isExplicitTunnelPath =
          url.pathname.startsWith(TUNNEL_PREFIX) ||
          url.pathname.startsWith(P2P_TUNNEL_PREFIX);

        const isFromTunneledTab =
          ev.clientId && (await isTunneledClient(ev.clientId));

        const isFromTunneledReferrer =
          ev.request.referrer &&
          (ev.request.referrer.includes(TUNNEL_PREFIX) ||
            ev.request.referrer.includes(P2P_TUNNEL_PREFIX)) &&
          !ev.request.referrer.includes("/proxy") &&
          !ev.request.referrer.includes("/room");

        if (isExplicitTunnelPath || isFromTunneledTab || isFromTunneledReferrer) {
          if (ev.resultingClientId) {
            tunneledClientIds.add(ev.resultingClientId);
          }
          return await tunnelRequest(ev);
        }

        // Pass through standard Doot navigation
        return await fetch(ev.request);
      })()
    );
    return;
  }

  // 4. Sub-resources (CSS, JS, images, fonts, API calls)
  ev.respondWith(
    (async () => {
      // Check if the request was initiated by a tunneled window tab
      if (ev.clientId && (await isTunneledClient(ev.clientId))) {
        return await tunnelRequest(ev);
      }

      // Check if the URL explicitly targets the tunnel prefix
      if (
        url.pathname.startsWith(TUNNEL_PREFIX) ||
        url.pathname.startsWith(P2P_TUNNEL_PREFIX)
      ) {
        if (ev.clientId) {
          tunneledClientIds.add(ev.clientId);
        }
        return await tunnelRequest(ev);
      }

      // Referrer fallback for sub-resources
      if (
        ev.request.referrer &&
        (ev.request.referrer.includes(TUNNEL_PREFIX) ||
          ev.request.referrer.includes(P2P_TUNNEL_PREFIX)) &&
        !ev.request.referrer.includes("/proxy") &&
        !ev.request.referrer.includes("/room")
      ) {
        if (ev.clientId) {
          tunneledClientIds.add(ev.clientId);
        }
        return await tunnelRequest(ev);
      }

      // Pass through local Doot assets
      return await fetch(ev.request);
    })()
  );
});

self.addEventListener("message", (ev) => {
  if (ev.data && ev.data.type === "response") {
    const { id, serialized } = ev.data;
    const res = deserializeResponse(serialized);

    const resolve = responseResolvers.get(id);
    if (!resolve) {
      return;
    }

    resolve(res);
    responseResolvers.delete(id);
  }
});

async function getTunnelClient() {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  // Find the /proxy tab which is running the P2P Proxy Manager
  return clients.find((c) => {
    try {
      const url = new URL(c.url);
      return url.pathname.startsWith("/proxy");
    } catch (e) {
      return false;
    }
  });
}

async function tunnelRequest(ev) {
  const tc = await getTunnelClient();
  if (!tc) {
    return new Response(
      "<!DOCTYPE html><html><head><title>503 Service Unavailable</title></head><body style=\"font-family:system-ui,sans-serif;padding:2rem;background:#0f111a;color:#e2e8f0;\">" +
        "<h1 style=\"color:#f87171;\">503: Service Unavailable</h1>" +
        "<p>No active P2P Proxy controller tab found. Please open the <a href=\"/proxy\" style=\"color:#60a5fa;\">Proxy Control Page</a>.</p></body></html>",
      { status: 503, headers: new Headers({ "Content-Type": "text/html; charset=utf-8" }) }
    );
  }

  const { method, url, headers } = ev.request;
  const headersList = [];
  headers.forEach((value, key) => {
    headersList.push([key, value]);
  });
  const hasBody = ev.request.body !== null;
  const serialized = await serializeRequest(ev.request);

  const currentId = requestId++;
  const resPromise = new Promise((resolve) => {
    // Timeout safeguard: Never hang a request indefinitely
    const timer = setTimeout(() => {
      responseResolvers.delete(currentId);
      resolve(
        new Response(
          "<!DOCTYPE html><html><head><title>504 Gateway Timeout</title></head><body style=\"font-family:system-ui,sans-serif;padding:2rem;background:#0f111a;color:#e2e8f0;\">" +
            "<h1 style=\"color:#f87171;\">504: Gateway Timeout</h1>" +
            "<p>P2P Host did not respond in time over WebRTC. Make sure your Proxy Host is active and connected in the room.</p></body></html>",
          { status: 504, headers: new Headers({ "Content-Type": "text/html; charset=utf-8" }) }
        )
      );
    }, 15000);

    responseResolvers.set(currentId, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });

  tc.postMessage(
    {
      type: "request",
      id: currentId,
      method,
      url,
      headersList,
      hasBody,
      serialized,
    },
    [serialized]
  );

  return await resPromise;
}

async function serializeRequest(req) {
  const url = new URL(req.url);
  url.hash = "";

  const body = await req.arrayBuffer();
  const requestLine = `${req.method} ${url.toString()} HTTP/1.1`;
  const headerFields = [];
  req.headers.forEach((v, k) => {
    headerFields.push(`${k}: ${v}`);
  });

  const extra = [
    ["Host", url.host],
    ["Origin", self.location.origin],
    ["User-Agent", self.navigator.userAgent],
    ["Content-Length", body.byteLength],
  ];
  extra.forEach(([k, v]) => {
    if (!req.headers.has(k)) {
      headerFields.push(`${k}: ${v}`);
    }
  });

  const headerStr = requestLine + CRLF + headerFields.join(CRLF) + CRLF + CRLF;
  const header = encoder.encode(headerStr);

  const out = new Uint8Array(header.byteLength + body.byteLength);
  out.set(header, 0);
  out.set(new Uint8Array(body), header.byteLength);

  return out.buffer;
}

function deserializeResponse(serialized) {
  const arr = new Uint8Array(serialized);
  const match = findHeaderEnd(arr);
  if (!match) {
    return Response.error();
  }

  const header = arr.subarray(0, match.index);
  const body = arr.subarray(match.index + match.length);

  const headerStr = decoder.decode(header);
  const { status, statusText, headersList } = parseHeader(headerStr);

  const headers = new Headers();
  for (const [k, v] of headersList) {
    const lower = k.toLowerCase();
    if (lower === "content-encoding" || lower === "transfer-encoding") {
      continue;
    }
    try {
      headers.append(k, v);
    } catch (e) {}
  }

  return new Response(body, {
    status,
    statusText,
    headers,
  });
}

function findHeaderEnd(arr) {
  for (let i = 0; i < arr.length - 1; i++) {
    if (
      i <= arr.length - 4 &&
      arr[i] === 13 &&
      arr[i + 1] === 10 &&
      arr[i + 2] === 13 &&
      arr[i + 3] === 10
    ) {
      return { index: i, length: 4 };
    }
    if (arr[i] === 10 && arr[i + 1] === 10) {
      return { index: i, length: 2 };
    }
  }
  return null;
}

function parseHeader(header) {
  const lines = header.split(/\r?\n/);
  const requestLine = lines[0] || "";
  const headerFieldLines = lines.slice(1);

  const parts = requestLine.trim().split(" ");
  const status = parseInt(parts[1], 10) || 200;
  const statusText = parts.slice(2).join(" ") || "OK";

  const headersList = [];
  for (const line of headerFieldLines) {
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx !== -1) {
      headersList.push([line.slice(0, colonIdx).trim(), line.slice(colonIdx + 1).trim()]);
    }
  }

  return { status, statusText, headersList };
}
