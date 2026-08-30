declare module "node:crypto" {
  export function randomUUID(): string;
}

declare module "node:fs/promises" {
  export function readFile(path: string | URL, encoding: "utf8"): Promise<string>;
  export function writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  export function mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
  export function lstat(path: string): Promise<FileStats>;
  export function open(path: string, flags: string): Promise<FileHandle>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function unlink(path: string): Promise<void>;
}

interface FileHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

interface FileStats {
  isSymbolicLink(): boolean;
}

declare module "node:path" {
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
}

declare module "node:http" {
  interface IncomingMessage extends AsyncIterable<Uint8Array> {
    method?: string;
    url?: string;
    headers: { host?: string; [name: string]: string | string[] | undefined };
  }

  interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(data?: Uint8Array | string): void;
  }

  interface Server {
    address(): string | { port: number } | null;
    listen(port: number, host: string, callback: () => void): void;
  }

  export function createServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  ): Server;
}

declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
  cwd(): string;
  versions: { node: string };
};
