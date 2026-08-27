import { cp, mkdir } from "node:fs/promises";

await mkdir(new URL("../dist/http/", import.meta.url), { recursive: true });
await cp(
  new URL("../src/http/public/", import.meta.url),
  new URL("../dist/http/public/", import.meta.url),
  { recursive: true },
);
