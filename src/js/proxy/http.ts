export const REQUEST_BODY_START = "REQUEST_BODY_START";
export const PROXY_REQUEST_START = "PROXY_REQUEST_START";
export const PROXY_RESPONSE_PLACEHOLDER = "PROXY_RESPONSE_PLACEHOLDER";

export const REQUEST_BODY_CHUNK = "REQUEST_BODY_CHUNK";
export const REQUEST_END = "REQUEST_END";
export const REQUEST_ERROR = "REQUEST_ERROR";

export const RESPONSE_HEADER = "RESPONSE_HEADER";
export const RESPONSE_BODY_CHUNK = "RESPONSE_BODY_CHUNK";
export const RESPONSE_END = "RESPONSE_END";
export const RESPONSE_ERROR = "RESPONSE_ERROR";

export const CRLF = "\r\n";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface RequestHead {
  method: string;
  path: string;
  headers: Headers;
  contentLength?: number;
  isChunked: boolean;
}

function parseRawHead(data: Uint8Array): { startLine: string; headers: Headers } | null {
  let headerEndIndex = -1;
  for (let i = data.length - 4; i >= 0; i--) {
    if (
      data[i] === 13 &&
      data[i + 1] === 10 &&
      data[i + 2] === 13 &&
      data[i + 3] === 10
    ) {
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
        line.slice(colonIdx + 1).trim(),
      );
    }
  }

  return { startLine: lines[0], headers };
}

export function parseRequestHead(data: Uint8Array): RequestHead | null {
  const parsed = parseRawHead(data);
  if (!parsed) return null;

  const [method, path] = parsed.startLine.split(" ");
  if (!method || !path) return null;

  const contentLengthStr = parsed.headers.get("content-length");
  const contentLength = contentLengthStr ? parseInt(contentLengthStr, 10) : undefined;
  const isChunked = parsed.headers.get("transfer-encoding") === "chunked";

  return {
    method,
    path,
    headers: parsed.headers,
    contentLength,
    isChunked,
  };
}

export interface ResponseHead {
  status: number;
  statusText: string;
  headers: Headers;
}

export function parseResponseHead(data: Uint8Array<ArrayBuffer>): ResponseHead | null {
  const parsed = parseRawHead(data);
  if (!parsed) return null;

  const [_, statusStr, ...statusParts] = parsed.startLine.split(" ");
  const status = parseInt(statusStr, 10);
  const statusText = statusParts.join(" ");

  return {
    status,
    statusText,
    headers: parsed.headers,
  };
}

export function serializeRequestHeader(req: Request, overridePath?: string): Uint8Array<ArrayBuffer> {
  const url = new URL(req.url);
  const pathToSend = overridePath ?? `${url.pathname}${url.search}`;
  const requestLine = `${req.method} ${pathToSend} HTTP/1.1`;
  const headerFields: string[] = [];

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

export function deserializeRequest(serialized: ArrayBuffer): {
  method: string;
  url: string;
  headers: Headers;
  body: Uint8Array | null;
} {
  const parsed = parseRequestHead(new Uint8Array(serialized));
  return {
    method: parsed?.method || "GET",
    url: parsed?.path || "/",
    headers: parsed?.headers || new Headers(),
    body: null,
  };
}

export async function serializeResponse(res: Response): Promise<ArrayBuffer> {
  const statusLine = `HTTP/1.1 ${res.status} ${res.statusText || "OK"}`;
  const headerFields: string[] = [];

  const bodyBuffer = await res.arrayBuffer();

  res.headers.forEach((v, k) => {
    const lower = k.toLowerCase();
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
  const parsed = parseResponseHead(new Uint8Array(serialized) as Uint8Array<ArrayBuffer>);
  if (!parsed) {
    return Response.error();
  }

  return new Response(null, {
    status: parsed.status,
    statusText: parsed.statusText,
    headers: parsed.headers,
  });
}