import { BUFFER_LOW_THRESHOLD, CRLF, createDataChannelSink, parseRequestHead } from "./utils";
const encoder = new TextEncoder();

let targetHost = "http://localhost:4322";
let hostReqCounter = 0;


export function setTargetHost(host: string): void {
  targetHost = host.replace(/\/+$/, "");
}

export function getTargetHost(): string {
  return targetHost;
}

export function setupHostChannel(
  dc: RTCDataChannel,
): void {
  dc.binaryType = "arraybuffer";
  dc.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;

  let isHeaderParsed = false;
  let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;

  dc.onmessage = (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) return;
    const data = new Uint8Array(ev.data);

    if (!isHeaderParsed) {
      isHeaderParsed = true;

      const parsed = parseRequestHead(data);
      if (!parsed) {
        console.warn("[ProxyHost] Failed to parse request head, closing DataChannel");
        dc.close();
        return;
      }

      const { method, path, headers, hasBody } = parsed;

      if (!hasBody) {
        executeHostFetch(dc, targetHost, method, path, headers);
        return;
      }

      const bodyStream = new ReadableStream<Uint8Array>({
        start(c) { bodyController = c },
      });

      executeHostFetch(dc, targetHost, method, path, headers, bodyStream);
      return;
    }

    if (data.byteLength == 0) {
      bodyController?.close();
      bodyController = null;
      return;
    }

    bodyController?.enqueue(data);
  };

  dc.onclose = () => {
    bodyController?.error(new Error("RTCDataChannel closed unexpectedly"));
    bodyController = null;
  };
  dc.onerror = (err) => {
    console.error(`[ProxyHost] DataChannel (${dc.label}) error:`, err);
  };
}

async function executeHostFetch(
  dc: RTCDataChannel,
  targetHost: string,
  method: string,
  path: string,
  headers: Headers,
  body?: BodyInit,
): Promise<void> {
  try {
    const targetUrl = `${targetHost}${path}`;

    // Set Host header and rewrite Referer to target server so Vite / Astro dev server can resolve module references
    const fetchHeaders = new Headers(headers);
    fetchHeaders.delete("x-doot-has-body");
    try {
      const parsedHost = new URL(targetHost).host;
      fetchHeaders.set("Host", parsedHost);
    } catch { }

    const referer = fetchHeaders.get("referer");
    if (referer) {
      try {
        const refUrl = new URL(referer);
        // If referer contains /tunnel/:roomId/(.*), rewrite path to /$1
        const tunnelMatch = refUrl.pathname.match(/^\/tunnel\/[^\/]+(.*)$/);
        const refPath = tunnelMatch ? (tunnelMatch[1] || "/") : refUrl.pathname;
        fetchHeaders.set("Referer", `${targetHost}${refPath}${refUrl.search}`);
      } catch {
        fetchHeaders.set("Referer", `${targetHost}/`);
      }
    } else {
      // Provide targetHost as referer so Astro/Vite virtual modules have compile context
      fetchHeaders.set("Referer", `${targetHost}/`);
    }

    const startTime = performance.now();
    const localResponse = await fetch(targetUrl, {
      method,
      headers: fetchHeaders,
      body,
      // @ts-ignore
      duplex: body instanceof ReadableStream ? "half" : undefined,
    });

    const durationMs = Math.round(performance.now() - startTime);
    RequestLogs.add({
      id: String(++hostReqCounter),
      method,
      path,
      status: localResponse.status,
      time: new Date().toLocaleTimeString(),
      durationMs,
    });

    // HTTP/1.1 {status} {statusText}\r\n...
    const statusLine = `HTTP/1.1 ${localResponse.status} ${localResponse.statusText}`;
    const headerLines: string[] = [statusLine];

    localResponse.headers.forEach((v, k) => {
      const lower = k.toLowerCase();
      if (
        lower === "content-length" ||
        lower === "transfer-encoding" ||
        lower === "content-encoding"
      ) {
        return;
      }
      headerLines.push(`${k}: ${v}`);
    });

    const headerStr = headerLines.join(CRLF) + CRLF + CRLF;
    if (dc.readyState === "connecting") {
      await new Promise<void>((res) => {
        dc.onopen = () => res();
      });
    }

    if (dc.readyState === "open") {
      dc.send(encoder.encode(headerStr));
    }

    if (localResponse.body) {
      await localResponse.body.pipeTo(createDataChannelSink(dc));
    }

  } catch (err: any) {
    console.error("[ProxyHost] Fetch error connecting to target:", err);
    try {
      if (dc.readyState === "connecting") {
        await new Promise<void>((res) => {
          dc.onopen = () => res();
        });
      }
      if (dc.readyState === "open") {
        const currentOrigin = window.location.origin;
        const isCorsOrNetwork = err?.name === "TypeError" && err?.message === "Failed to fetch";
        const errorHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>502 Bad Gateway</title>
</head>
<body style="font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;padding:36px;background:#292d3e;color:#eef0f7;margin:0;line-height:1.5;">
  <h2 style="color:#f38ba8;margin:0 0 12px;font-size:20px;font-weight:600;">502 Bad Gateway</h2>
  <p style="margin:0 0 4px;font-size:14px;color:#eef0f7;">The Host failed to connect to local target server at <code style="font-family:ui-monospace,Menlo,monospace;background:#222436;padding:2px 6px;border-radius:4px;color:#89b4fa;">${targetHost}</code>.</p>
  <p style="color:#a3a8c2;font-size:13px;margin:0 0 16px;">Error: <code style="font-family:ui-monospace,Menlo,monospace;color:#f38ba8;">${err?.message || "Connection refused"}</code></p>
  ${isCorsOrNetwork ? `
  <div style="background:#323752;border:1px solid #40456866;border-radius:8px;padding:16px;margin:16px 0;max-width:640px;">
    <div style="color:#eef0f7;font-size:13px;font-weight:600;margin-bottom:8px;">CORS / Private Network Access Required</div>
    <p style="color:#a3a8c2;font-size:13px;margin:0 0 8px;">Because the host tab is on <code style="font-family:ui-monospace,Menlo,monospace;color:#89b4fa;">${currentOrigin}</code>, requests to localhost require CORS and Private Network Access headers on your local server:</p>
    <pre style="font-family:ui-monospace,Menlo,monospace;font-size:12px;background:#222436;border:1px solid #40456866;border-radius:6px;padding:10px 12px;color:#89b4fa;margin:0;overflow-x:auto;">Access-Control-Allow-Origin: ${currentOrigin}
Access-Control-Allow-Private-Network: true
Access-Control-Allow-Methods: *
Access-Control-Allow-Headers: *</pre>
  </div>` : ""}
  <p style="margin:20px 0 0;">
    <button style="padding:8px 16px;background:#89b4fa;color:#11111b;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;" onclick="window.location.reload()">Retry</button>
  </p>
  <script>
    const channel = new BroadcastChannel("doot_tunnel");
    channel.onmessage = (e) => {
      if (e.data?.type === "ready") {
        window.location.reload();
      }
    };
  </script>
</body>
</html>`;
        const bodyBuf = encoder.encode(errorHtml);
        const errHead = `HTTP/1.1 502 Bad Gateway${CRLF}Content-Type: text/html; charset=utf-8${CRLF}Content-Length: ${bodyBuf.byteLength}${CRLF}Connection: close${CRLF}${CRLF}`;
        dc.send(encoder.encode(errHead));
        dc.send(bodyBuf);
      }
    } catch { }
  } finally {
    dc.close();
  }
}

export interface RequestLogEntry {
  id: string;
  method: string;
  path: string;
  status: number;
  time: string;
  durationMs: number;
}

export const RequestLogs = {
  entries: [] as RequestLogEntry[],
  listeners: new Set<(logs: RequestLogEntry[]) => void>(),

  onchange(listener: (logs: RequestLogEntry[]) => void) {
    RequestLogs.listeners.add(listener);
    listener(RequestLogs.entries);
    return () => {
      RequestLogs.listeners.delete(listener);
    };
  },

  notifyListeners() {
    for (const listener of RequestLogs.listeners) {
      try {
        listener(RequestLogs.entries);
      } catch { }
    }
  },

  add(entry: RequestLogEntry) {
    RequestLogs.entries.unshift(entry);
    if (RequestLogs.entries.length > 50) {
      RequestLogs.entries.pop();
    }
    RequestLogs.notifyListeners();
  },

  clear() {
    RequestLogs.entries = [];
    RequestLogs.notifyListeners();
  },
};