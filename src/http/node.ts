import { createServer } from "node:http";

export const MAX_NODE_HTTP_BODY_BYTES = 1_048_576;

export interface MissionNodeHttpApp {
  fetch(request: Request): Promise<Response>;
}

export interface MissionNodeHttpServerOptions {
  host: string;
  port: number;
  maxBodyBytes?: number;
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

  return createServer(async (request, response) => {
    try {
      const method = (request.method ?? "GET").toUpperCase();
      const authority = request.headers.host ?? `${options.host}:${options.port}`;
      const target = `/${(request.url ?? "/").replace(/^\/+/, "")}`;
      const url = new URL(target, `http://${authority}`).toString();
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
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ error, message }));
}
