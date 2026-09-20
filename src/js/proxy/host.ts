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

      const { method, path, headers, contentLength, isChunked } = parsed;
      const hasBody = (contentLength && contentLength > 0) || isChunked;

      if (!hasBody || method === "GET" || method === "HEAD") {
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
        const errorHtml = `<!DOCTYPE html><html><body style="font-family:system-ui,-apple-system,sans-serif;padding:36px;background:#181825;color:#cdd6f4;">` +
          `<h2 style="color:#f38ba8;margin-top:0;">502 Bad Gateway</h2>` +
          `<p>The Host failed to connect to local target server at <code>${targetHost}</code>.</p>` +
          `<p style="color:#a6adc8;font-size:13px;">Error: <code>${err?.message || "Connection refused"}</code></p>` +
          `<p style="margin-top:24px;"><button style="padding:8px 16px;background:#89b4fa;color:#11111b;border:none;border-radius:6px;cursor:pointer;font-weight:600;" onclick="window.location.reload()">Retry</button></p>` +
          `</body></html>`;
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