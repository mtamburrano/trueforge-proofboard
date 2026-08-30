import { MissionService } from "../domain.js";
import { JsonMissionRepository } from "../persistence.js";
import {
  TrueForgeMissionRunner,
  createTrueForgeClient,
} from "../trueforge.js";
import { createDaytonaSandboxExecutor } from "../daytona.js";
import { resolveMissionRuntimeConfig } from "./config.js";
import { createMissionNodeServer } from "./node.js";
import { createMissionHttpApp } from "./server.js";

const { host, port, statePath, baseUrl, model, githubServer } =
  resolveMissionRuntimeConfig(process.env);
const daytonaApiKey = process.env.DAYTONA_API_KEY?.trim();
const daytonaApiUrl = process.env.DAYTONA_API_URL?.trim();
const sandboxExecutor = daytonaApiKey === undefined || daytonaApiKey.length === 0
  ? undefined
  : createDaytonaSandboxExecutor({
      apiKey: daytonaApiKey,
      ...(daytonaApiUrl === undefined || daytonaApiUrl.length === 0
        ? {}
        : { apiUrl: daytonaApiUrl }),
    });

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
    deliveryToolName: "create_pull_request",
    ...(sandboxExecutor === undefined ? {} : { sandboxExecutor }),
    mcpServers: [{
      name: githubServer,
      enableTools: ["get_file_contents", "get_commit", "push_files", "create_pull_request", "pull_request_read", "search_pull_requests"],
      preloadTools: ["get_file_contents", "get_commit", "push_files", "create_pull_request", "pull_request_read", "search_pull_requests"],
      requireApprovalForTools: ["push_files", "create_pull_request"],
    }],
  },
);
const app = createMissionHttpApp({
  missions,
  runner,
  semanticVerifier: runner,
  model,
});

const server = createMissionNodeServer(app, { host, port });

server.listen(port, host, () => {
  console.log(`TrueForge Mission Control listening on http://${host}:${port}`);
});
