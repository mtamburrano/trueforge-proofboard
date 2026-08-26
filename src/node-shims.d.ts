declare module "node:crypto" {
  export function randomUUID(): string;
}

declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  export function mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function unlink(path: string): Promise<void>;
}

declare module "node:path" {
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
}
