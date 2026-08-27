import { createServer } from "node:http";

import { MissionService } from "../domain.js";
import { JsonMissionRepository } from "../persistence.js";
import {
  TrueForgeMissionRunner,
  createTrueForgeClient,
} from "../trueforge.js";
import { createMissionHttpApp } from "./server.js";

const host = process.env.TRUEFORGE_UI_HOST ?? "127.0.0.1";
const port = Number(process.env.TRUEFORGE_UI_PORT ?? "8787");
const statePath = process.env.TRUEFORGE_MISSION_STATE ?? ".trueforge/mission-state.json";
const baseUrl = process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790";
const model = process.env.TRUEFORGE_MODEL ?? "google-gemini/gemini-3.6-flash";
const githubServer = process.env.TRUEFORGE_GITHUB_SERVER ?? "github";

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("TRUEFORGE_UI_PORT must be a valid TCP port.");
}

const missions = new MissionService(new JsonMissionRepository(statePath));
const runner = new TrueForgeMissionRunner(
  missions,
  createTrueForgeClient({
    baseUrl,
    ...(process.env.TRUEFORGE_TOKEN === undefined
      ? {}
      : { token: process.env.TRUEFORGE_TOKEN }),
  }),
  {
    model,
    mcpServerName: githubServer,
    repositoryToolName: "get_commit",
    sandboxToolName: "exec",
    mcpServers: [{
      name: githubServer,
      enableTools: ["get_file_contents", "get_commit"],
      preloadTools: ["get_file_contents", "get_commit"],
    }],
  },
);
const app = createMissionHttpApp({ missions, runner });

const server = createServer(async (request, response) => {
  try {
    const method = request.method ?? "GET";
    const url = `http://${request.headers.host ?? `${host}:${port}`}${request.url ?? "/"}`;
    const result = await app.fetch(new Request(url, { method }));
    response.statusCode = result.status;
    result.headers.forEach((value, name) => response.setHeader(name, value));
    response.end(new Uint8Array(await result.arrayBuffer()));
  } catch {
    response.statusCode = 500;
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.end("Mission Control could not serve this request.");
  }
});

server.listen(port, host, () => {
  console.log(`TrueForge Mission Control listening on http://${host}:${port}`);
});
