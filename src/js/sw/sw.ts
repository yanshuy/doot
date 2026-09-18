import { deserializeResponse, serializeRequest } from "./http";

const sw = self as unknown as ServiceWorkerGlobalScope & typeof globalThis;

sw.addEventListener("install", () => {
  sw.skipWaiting();
});

sw.addEventListener("activate", (ev) => {
  ev.waitUntil(sw.clients.claim());
});

let requestId = 1;
const responseResolvers = new Map<number, (value: Response) => void>();
const TUNNEL_PREFIX = "/tunnel";
const P2P_TUNNEL_PREFIX = "/p2p-tunnel";

// Track window client IDs that belong to the tunneled application
const tunneledClientIds = new Set<string>();

async function isTunneledClient(clientId?: string): Promise<boolean> {
  if (!clientId) return false;
  if (tunneledClientIds.has(clientId)) return true;
  try {
    const client = await sw.clients.get(clientId);
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

sw.addEventListener("fetch", (ev) => {
  // Prevent loopback if host proxy fetch originates from the same browser context
  if (ev.request.headers.has("X-Doot-Loopback")) {
    return;
  }

  const url = new URL(ev.request.url);

  // 1. External origins bypass
  if (url.origin !== sw.location.origin) {
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

sw.addEventListener("message", (ev) => {
  if (ev.data && ev.data.type === "response") {
    const { id, serialized } = ev.data as {
      id: number;
      serialized: ArrayBuffer;
    };
    const res = deserializeResponse(serialized);

    const resolve = responseResolvers.get(id);
    if (!resolve) {
      console.warn(`[SW] Received response with unknown id ${id}`);
      return;
    }

    resolve(res);
    responseResolvers.delete(id);
  }
});

async function getTunnelClient() {
  const clients = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
  return clients.find((client) => {
    try {
      const url = new URL(client.url);
      return url.pathname.startsWith("/proxy");
    } catch (e) {
      return false;
    }
  });
}

async function tunnelRequest(ev: FetchEvent): Promise<Response> {
  const tc = await getTunnelClient();
  if (!tc) {
    return new Response(
      "<!DOCTYPE html><html><head><title>503 Service Unavailable</title></head><body style=\"font-family:system-ui,sans-serif;padding:2rem;background:#0f111a;color:#e2e8f0;\">" +
        "<h1 style=\"color:#f87171;\">503: Service Unavailable</h1>" +
        "<p>No active P2P Proxy controller tab found. Please open the <a href=\"/proxy\" style=\"color:#60a5fa;\">Proxy Control Page</a>.</p></body></html>",
      { status: 503, headers: new Headers({ "Content-Type": "text/html; charset=utf-8" }) },
    );
  }

  const { method, url, headers } = ev.request;
  const headersList: [string, string][] = [];
  headers.forEach((value, key) => {
    headersList.push([key, value]);
  });
  const hasBody = ev.request.body !== null;
  const serialized = await serializeRequest(ev.request);

  const currentId = requestId++;
  const resPromise = new Promise<Response>((resolve) => {
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
    [serialized],
  );

  return await resPromise;
}
