import { createServer } from "node:http";

import { MissionService } from "../domain.js";
import { JsonMissionRepository } from "../persistence.js";
import {
  TrueForgeMissionRunner,
  createTrueForgeClient,
} from "../trueforge.js";
import { resolveMissionRuntimeConfig } from "./config.js";
import { createMissionHttpApp } from "./server.js";

const { host, port, statePath, baseUrl, model, githubServer } =
  resolveMissionRuntimeConfig(process.env);

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
    dynamicSubAgents: true,
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
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) {
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
    }
    const result = await app.fetch(new Request(url, { method, headers }));
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
