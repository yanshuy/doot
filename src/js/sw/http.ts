const CRLF = "\r\n";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type UserAgentInfo = {
  origin?: string;
  userAgent?: string;
};

export async function serializeRequest(
  req: Request,
  info?: UserAgentInfo,
): Promise<ArrayBuffer> {
  const url = new URL(req.url);
  url.hash = "";

  const origin = info?.origin || (typeof location !== "undefined" ? location.origin : "");
  const userAgent = info?.userAgent || (typeof navigator !== "undefined" ? navigator.userAgent : "");

  const body = await req.arrayBuffer();

  const requestLine = `${req.method} ${url.toString()} HTTP/1.1`;
  const headerFields: string[] = [];
  req.headers.forEach((v, k) => {
    headerFields.push(`${k}: ${v}`);
  });

  const extra: [string, unknown][] = [
    ["Host", url.host],
    ["Origin", origin],
    ["User-Agent", userAgent],
    ["Content-Length", body.byteLength],
    ["Sec-Fetch-Dest", req.destination],
    ["Sec-Fetch-Mode", req.mode],
    ["Doot-Tunnel-Redirect", req.redirect],
  ];
  if (req.referrer && req.referrer !== "about:client") {
    extra.push(["Referer", req.referrer]);
  }
  extra.forEach(([k, v]) => {
    if (!req.headers.has(k) && v !== undefined && v !== null && v !== "") {
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

export function deserializeRequest(serialized: ArrayBuffer): {
  method: string;
  url: string;
  headers: Headers;
  body: Uint8Array | null;
} {
  const arr = new Uint8Array(serialized);
  const match = findHeaderEnd(arr);
  if (!match) {
    throw new Error("Invalid HTTP request header format");
  }

  const headerBytes = arr.subarray(0, match.index);
  const bodyBytes = arr.subarray(match.index + match.length);

  const headerStr = decoder.decode(headerBytes);
  const lines = headerStr.split(/\r?\n/);
  const requestLine = lines[0] || "";
  const headerFieldLines = lines.slice(1);

  const [method, urlStr] = requestLine.split(" ");
  const headers = new Headers();

  for (const line of headerFieldLines) {
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx !== -1) {
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      headers.append(key, val);
    }
  }

  return {
    method: method || "GET",
    url: urlStr || "/",
    headers,
    body: bodyBytes.byteLength > 0 ? bodyBytes : null,
  };
}

export async function serializeResponse(res: Response): Promise<ArrayBuffer> {
  const statusLine = `HTTP/1.1 ${res.status} ${res.statusText || "OK"}`;
  const headerFields: string[] = [];

  const bodyBuffer = await res.arrayBuffer();

  res.headers.forEach((v, k) => {
    const lower = k.toLowerCase();
    // Strip headers that could conflict with decompressed body length or decoding
    if (lower === "content-encoding" || lower === "transfer-encoding" || lower === "content-length") {
      return;
    }
    headerFields.push(`${k}: ${v}`);
  });

  headerFields.push(`Content-Length: ${bodyBuffer.byteLength}`);

  const headerStr = statusLine + CRLF + headerFields.join(CRLF) + CRLF + CRLF;
  const header = encoder.encode(headerStr);

  const out = new Uint8Array(header.byteLength + bodyBuffer.byteLength);
  out.set(header, 0);
  out.set(new Uint8Array(bodyBuffer), header.byteLength);

  return out.buffer;
}

export function deserializeResponse(serialized: ArrayBuffer): Response {
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

function findHeaderEnd(arr: Uint8Array): { index: number; length: number } | null {
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

function parseHeader(header: string) {
  const lines = header.split(/\r?\n/);
  const requestLine = lines[0] || "";
  const headerFieldLines = lines.slice(1);

  const parts = requestLine.trim().split(" ");
  const status = parseInt(parts[1], 10) || 200;
  const statusText = parts.slice(2).join(" ") || "OK";

  const headersList: [string, string][] = [];
  for (const line of headerFieldLines) {
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx !== -1) {
      headersList.push([line.slice(0, colonIdx).trim(), line.slice(colonIdx + 1).trim()]);
    }
  }

  return { status, statusText, headersList };
}
