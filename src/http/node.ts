import { createServer } from "node:http";

export const MAX_NODE_HTTP_BODY_BYTES = 1_048_576;

export interface MissionNodeHttpApp {
  fetch(request: Request): Promise<Response>;
}

export interface MissionNodeHttpServerOptions {
  host: string;
  port: number;
  maxBodyBytes?: number;
  /** Additional browser origins that are explicitly trusted by the local listener. */
  allowedOrigins?: string[];
}

interface IncomingHttpRequest extends AsyncIterable<Uint8Array> {
  headers: Record<string, string | string[] | undefined>;
}

interface NodeHttpResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(data?: Uint8Array | string): void;
}

class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds the ${maxBytes}-byte limit.`);
    this.name = "RequestBodyTooLargeError";
  }
}

export function createMissionNodeServer(
  app: MissionNodeHttpApp,
  options: MissionNodeHttpServerOptions,
) {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_NODE_HTTP_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("maxBodyBytes must be a positive safe integer.");
  }
  const configuredOrigins = normalizeAllowedOrigins(options.allowedOrigins ?? []);

  const server = createServer(async (request, response) => {
    try {
      const listenerOrigin = trustedListenerOrigin(server, options);
      const trustedOrigins = [listenerOrigin, ...configuredOrigins];
      const authority = normalizeHostHeader(request.headers.host);
      const trustedOrigin = authority === null
        ? null
        : trustedOrigins.find((origin) => new URL(origin).host === authority) ?? null;
      if (trustedOrigin === null) {
        writeJsonError(
          response,
          400,
          "invalid_host",
          "The request Host is not an allowed local application origin.",
        );
        return;
      }
      const method = (request.method ?? "GET").toUpperCase();
      const target = `/${(request.url ?? "/").replace(/^\/+/, "")}`;
      const url = new URL(target, trustedOrigin).toString();
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) {
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
      }
      const body = isBodylessMethod(method)
        ? undefined
        : await readIncomingBody(request, maxBodyBytes);
      const requestInit: RequestInit = { method, headers };
      if (body !== undefined) {
        requestInit.body = body as unknown as BodyInit;
      }

      const result = await app.fetch(new Request(url, requestInit));
      response.statusCode = result.status;
      result.headers.forEach((value, name) => response.setHeader(name, value));
      response.end(new Uint8Array(await result.arrayBuffer()));
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        writeJsonError(response, 413, "request_too_large", error.message);
        return;
      }
      response.statusCode = 500;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("Mission Control could not serve this request.");
    }
  });
  return server;
}

function normalizeAllowedOrigins(origins: string[]): string[] {
  return origins.map((value, index) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`allowedOrigins[${index}] must be a non-empty HTTP origin.`);
    }
    let parsed: URL;
    try {
      parsed = new URL(value.trim());
    } catch {
      throw new Error(`allowedOrigins[${index}] must be a valid HTTP origin.`);
    }
    if (
      parsed.protocol !== "http:" ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== "/" ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      throw new Error(`allowedOrigins[${index}] must be a valid HTTP origin without credentials or a path.`);
    }
    return parsed.origin;
  });
}

function trustedListenerOrigin(
  server: { address(): string | { port: number } | null },
  options: Pick<MissionNodeHttpServerOptions, "host" | "port">,
): string {
  const address = server.address();
  const port = typeof address === "object" && address !== null
    ? address.port
    : options.port;
  const host = options.host.trim();
  const formattedHost = host.includes(":") && !host.startsWith("[")
    ? `[${host}]`
    : host;
  return new URL(`http://${formattedHost}:${port}`).origin;
}

function normalizeHostHeader(value: string | string[] | undefined): string | null {
  if (value === undefined || Array.isArray(value) || value.trim().length === 0) {
    return null;
  }
  const text = value.trim();
  if (/[\s/?#]/.test(text)) {
    return null;
  }
  try {
    const parsed = new URL(`http://${text}`);
    return parsed.host;
  } catch {
    return null;
  }
}

function isBodylessMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

async function readIncomingBody(
  request: IncomingHttpRequest,
  maxBodyBytes: number,
): Promise<Uint8Array | undefined> {
  const contentLength = declaredContentLength(request.headers["content-length"]);
  if (contentLength !== undefined && contentLength > maxBodyBytes) {
    throw new RequestBodyTooLargeError(maxBodyBytes);
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    if (chunk.byteLength > maxBodyBytes - totalBytes) {
      throw new RequestBodyTooLargeError(maxBodyBytes);
    }
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
  }
  if (totalBytes === 0) return undefined;

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function declaredContentLength(value: string | string[] | undefined): number | undefined {
  const text = Array.isArray(value) ? value[0] : value;
  if (text === undefined || !/^\d+$/.test(text.trim())) return undefined;
  const length = Number(text);
  return Number.isSafeInteger(length) ? length : Number.POSITIVE_INFINITY;
}

function writeJsonError(
  response: NodeHttpResponse,
  statusCode: number,
  error: string,
  message: string,
): void {
  response.statusCode = statusCode;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ error, message }));
}
