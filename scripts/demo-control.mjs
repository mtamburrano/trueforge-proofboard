import { pathToFileURL } from "node:url";

import {
  resetDemoState,
  resolveDemoPreflightConfig,
  runDemoPreflight,
  createTrueForgeClient,
} from "../dist/index.js";

function printUsage() {
  console.log("Usage: npm run demo:reset");
  console.log("       npm run demo:preflight [-- --dry-run]");
  console.log("See docs/demo-runbook.md for the manual provider validation sequence.");
}

function preflightDryRun(config) {
  console.log(JSON.stringify({
    mode: "dry-run",
    external_calls: false,
    external_mutations: 0,
    trueforge: { base_url: config.baseUrl, model: config.model },
    github_mcp: {
      server: config.githubServer,
      checks: ["configured server", "authorization", "required tools"],
    },
    fixture: config.fixture,
    delivery_collision_checks: ["owned branch", "owned pull request"],
    daytona: {
      direct_credential_configured: config.daytonaApiKeyConfigured,
      readiness: "metadata only",
    },
    note: "Use npm run demo:preflight without --dry-run for bounded read-only checks.",
  }, null, 2));
}

function createLivePreflightAdapters(config, environment) {
  const token = environment.TRUEFORGE_TOKEN?.trim();
  const client = createTrueForgeClient({
    baseUrl: config.baseUrl,
    timeoutInSeconds: 5,
    ...(token === undefined || token.length === 0 ? {} : { token }),
  });

  return {
    trueforge: {
      getCapabilities: () => client.server.getCapabilities(),
      listModels: () => client.models.list(),
      listConfiguredMcpServers: () => client.settings.mcpServers.list(),
      listMcpTools: (serverName) => client.mcpServers.listTools(serverName),
      getSandboxProvider: () => client.settings.sandboxProviders.get(),
    },
    github: createReadOnlyGitHubAdapter(environment),
  };
}

function createReadOnlyGitHubAdapter(environment) {
  const apiBase = (environment.GITHUB_API_URL?.trim() || "https://api.github.com")
    .replace(/\/+$/, "");
  const token = environment.GITHUB_TOKEN?.trim();

  async function readJson(apiPath, { allowNotFound = false } = {}) {
    const headers = {
      accept: "application/vnd.github+json",
      "user-agent": "trueforge-proofboard-demo-preflight",
      ...(token === undefined || token.length === 0
        ? {}
        : { authorization: `Bearer ${token}` }),
    };
    const response = await fetch(`${apiBase}${apiPath}`, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (allowNotFound && response.status === 404) {
      return { exists: false };
    }
    if (!response.ok) {
      throw new Error(`GitHub read returned HTTP ${response.status}.`);
    }
    return response.json();
  }

  return {
    getCommit: ({ owner, repository, sha }) =>
      readJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${encodeURIComponent(sha)}`),
    getDeliveryBranch: async ({ owner, repository, branch }) => {
      const payload = await readJson(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/ref/heads/${encodeURIComponent(branch)}`,
        { allowNotFound: true },
      );
      return payload.exists === false ? payload : { exists: true, ...payload };
    },
    listDeliveryPullRequests: ({ owner, repository, base, head }) =>
      readJson(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}&per_page=10`,
      ),
  };
}

async function run() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || rest.includes("--help") || command === "--help") {
    printUsage();
    return;
  }

  const config = resolveDemoPreflightConfig(process.env);
  if (command === "reset") {
    const result = await resetDemoState({
      statePath: config.statePath,
      rootDirectory: process.cwd(),
    });
    console.log(JSON.stringify({
      mode: "local-reset",
      state_path: result.statePath,
      external_calls: false,
      external_mutations: 0,
      mission_count: result.state.missions.length,
      work_item_statuses: result.state.workItems.map((item) => ({ id: item.id, status: item.status })),
      evidence_count: result.state.evidence.length,
      session_ids: result.state.missions
        .map((mission) => mission.trueforgeSessionId)
        .filter((sessionId) => sessionId !== undefined),
    }, null, 2));
    return;
  }

  if (command !== "preflight") {
    throw new Error(`Unknown demo control command: ${command}`);
  }
  if (rest.includes("--dry-run")) {
    preflightDryRun(config);
    return;
  }

  const report = await runDemoPreflight({
    config,
    adapters: createLivePreflightAdapters(config, process.env),
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(`Demo control failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export { createLivePreflightAdapters, createReadOnlyGitHubAdapter, run };
