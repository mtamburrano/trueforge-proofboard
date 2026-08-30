import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEMO_PREFLIGHT_REQUIRED_MCP_TOOLS,
  DEFAULT_TRUEFORGE_MODEL,
  JsonMissionRepository,
  PRIMARY_DELIVERY_FIXTURE,
  resetDemoState,
  runDemoPreflight,
} from "../dist/index.js";
import { createReadOnlyGitHubAdapter } from "../scripts/demo-control.mjs";

function fixedClock() {
  return new Date("2026-08-30T12:00:00.000Z");
}

function config(directory, overrides = {}) {
  return {
    baseUrl: "http://localhost:8790",
    model: DEFAULT_TRUEFORGE_MODEL,
    githubServer: "github",
    statePath: path.join(directory, ".trueforge", "mission-state.json"),
    daytonaApiKeyConfigured: true,
    fixture: PRIMARY_DELIVERY_FIXTURE,
    ...overrides,
  };
}

function passingAdapters({ calls = [], branch = { exists: false }, pullRequests = [] } = {}) {
  return {
    trueforge: {
      getCapabilities: async () => {
        calls.push("trueforge.capabilities");
        return { data: { data: { sandbox: {}, settings: {}, skill: {} } } };
      },
      listModels: async () => {
        calls.push("trueforge.models");
        return { data: { data: [{ name: DEFAULT_TRUEFORGE_MODEL }] } };
      },
      listConfiguredMcpServers: async () => {
        calls.push("trueforge.mcp-servers");
        return { data: { data: [{ name: "github", authStatus: { status: "authenticated" } }] } };
      },
      listMcpTools: async () => {
        calls.push("trueforge.mcp-tools");
        return { data: { data: DEMO_PREFLIGHT_REQUIRED_MCP_TOOLS.map((name) => ({ name })) } };
      },
      getSandboxProvider: async () => {
        calls.push("trueforge.sandbox-provider");
        return { data: { data: { manifest: { type: "daytona" }, status: "ready" } } };
      },
    },
    github: {
      getCommit: async ({ owner, repository, sha }) => {
        calls.push("github.commit");
        return {
          sha,
          url: `https://api.github.com/repos/${owner}/${repository}/commits/${sha}`,
          html_url: `https://github.com/${owner}/${repository}/commit/${sha}`,
          commit: {
            url: `https://api.github.com/repos/${owner}/${repository}/git/commits/${sha}`,
            message: "fixture baseline",
          },
          author: null,
          committer: null,
          parents: [],
          files: [],
        };
      },
      getDeliveryBranch: async () => {
        calls.push("github.branch");
        return branch;
      },
      listDeliveryPullRequests: async () => {
        calls.push("github.pull-requests");
        return pullRequests;
      },
    },
  };
}

test("local demo reset atomically restores the exact queue baseline and preserves unrelated files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-demo-reset-"));
  const statePath = path.join(directory, ".trueforge", "mission-state.json");
  const unrelatedPath = path.join(directory, "unrelated.txt");
  try {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ stale: true }), "utf8");
    await writeFile(unrelatedPath, "must remain untouched\n", "utf8");

    const result = await resetDemoState({
      statePath,
      rootDirectory: directory,
      clock: fixedClock,
    });
    const persisted = await new JsonMissionRepository(statePath).load();

    assert.deepEqual(persisted, result.state);
    assert.equal(result.state.revision, 3);
    assert.deepEqual(result.state.missions.map((mission) => ({
      id: mission.id,
      status: mission.status,
      repository: mission.repository,
      hasSession: mission.trueforgeSessionId !== undefined,
      hasTurn: mission.trueforgeTurnId !== undefined,
      hasSandbox: mission.trueforgeSandboxId !== undefined,
    })), [{
      id: "primary-mission",
      status: "draft",
      repository: {
        owner: PRIMARY_DELIVERY_FIXTURE.owner,
        name: PRIMARY_DELIVERY_FIXTURE.repository,
        ref: PRIMARY_DELIVERY_FIXTURE.baselineSha,
      },
      hasSession: false,
      hasTurn: false,
      hasSandbox: false,
    }]);
    assert.deepEqual(result.state.workItems.map((item) => ({ id: item.id, status: item.status })), [
      { id: "primary-inspect", status: "backlog" },
    ]);
    assert.equal(result.state.evidence.length, 0);
    assert.equal(result.state.handoffs.length, 0);
    assert.equal(result.state.reviews.length, 0);
    assert.equal(result.state.approvals.length, 0);
    assert.equal(result.state.deliveries.length, 0);
    assert.equal(result.state.deliveryAttempts.length, 0);
    assert.equal(await readFile(unrelatedPath, "utf8"), "must remain untouched\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("demo reset refuses a state path that could overwrite an unrelated local resource", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-demo-reset-guard-"));
  try {
    await assert.rejects(
      resetDemoState({
        statePath: path.join(directory, "unrelated.json"),
        rootDirectory: directory,
        clock: fixedClock,
      }),
      /only permits \.trueforge\/mission-state\.json/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded preflight passes with deterministic read-only adapters and performs no mutations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-demo-preflight-"));
  try {
    const calls = [];
    const report = await runDemoPreflight({
      config: config(directory),
      adapters: passingAdapters({ calls }),
      timeoutMs: 100,
    });

    assert.equal(report.ok, true);
    assert.equal(report.mode, "bounded-read-only");
    assert.equal(report.externalMutations, 0);
    assert.equal(report.manualQueueRunRequired, true);
    assert.equal(report.maxReadCalls, 8);
    assert.deepEqual(report.checks.map((check) => check.status), Array(13).fill("passed"));
    assert.equal(new Set(calls).size, 8);
    assert.deepEqual(calls.sort(), [
      "github.branch",
      "github.commit",
      "github.pull-requests",
      "trueforge.capabilities",
      "trueforge.mcp-servers",
      "trueforge.mcp-tools",
      "trueforge.models",
      "trueforge.sandbox-provider",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("baseline preflight accepts the real GitHub REST commit shape and exact requested target", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-demo-preflight-commit-"));
  try {
    let request;
    const adapters = passingAdapters();
    adapters.github.getCommit = async (input) => {
      request = input;
      return {
        sha: input.sha,
        url: `https://api.github.com/repos/${input.owner}/${input.repository}/commits/${input.sha}`,
        html_url: `https://github.com/${input.owner}/${input.repository}/commit/${input.sha}`,
        commit: {
          url: `https://api.github.com/repos/${input.owner}/${input.repository}/git/commits/${input.sha}`,
          message: "fixture baseline",
        },
        author: null,
        committer: null,
        parents: [],
        files: [],
      };
    };

    const report = await runDemoPreflight({ config: config(directory), adapters, timeoutMs: 100 });
    const check = report.checks.find((item) => item.id === "github-baseline");

    assert.equal(report.ok, true);
    assert.equal(check.status, "passed");
    assert.deepEqual(request, {
      owner: PRIMARY_DELIVERY_FIXTURE.owner,
      repository: PRIMARY_DELIVERY_FIXTURE.repository,
      sha: PRIMARY_DELIVERY_FIXTURE.baselineSha,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preflight fails closed on a stale owned branch or pull request", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-demo-preflight-stale-"));
  try {
    const report = await runDemoPreflight({
      config: config(directory),
      adapters: passingAdapters({
        branch: { exists: true },
        pullRequests: [{
          number: 41,
          state: "open",
          html_url: "https://github.com/mtamburrano/proofboard-demo-fixture/pull/41",
          head: {
            ref: PRIMARY_DELIVERY_FIXTURE.head,
            repo: { full_name: "mtamburrano/proofboard-demo-fixture" },
          },
          base: { ref: PRIMARY_DELIVERY_FIXTURE.base },
        }],
      }),
      timeoutMs: 100,
    });

    assert.equal(report.ok, false);
    assert.match(report.checks.find((check) => check.id === "delivery-branch-clean").summary, /stale owned delivery branch/);
    assert.match(report.checks.find((check) => check.id === "delivery-pr-clean").summary, /stale owned delivery pull request/);
    assert.equal(report.checks.every((check) => check.mutating === false), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("historical closed delivery pull requests do not poison repeat preflight runs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-demo-preflight-history-"));
  try {
    const adapters = passingAdapters({
      pullRequests: [{
        number: 41,
        state: "closed",
        closed_at: "2026-08-30T10:00:00.000Z",
        merged_at: null,
        html_url: "https://github.com/mtamburrano/proofboard-demo-fixture/pull/41",
        head: {
          ref: PRIMARY_DELIVERY_FIXTURE.head,
          repo: { full_name: "mtamburrano/proofboard-demo-fixture" },
        },
        base: { ref: PRIMARY_DELIVERY_FIXTURE.base },
      }],
    });

    const reports = await Promise.all([
      runDemoPreflight({ config: config(directory), adapters, timeoutMs: 100 }),
      runDemoPreflight({ config: config(directory), adapters, timeoutMs: 100 }),
    ]);

    assert.deepEqual(reports.map((report) => report.ok), [true, true]);
    assert.deepEqual(
      reports.map((report) => report.checks.find((check) => check.id === "delivery-pr-clean").status),
      ["passed", "passed"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live GitHub collision lookup requests open pull requests only", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const adapter = createReadOnlyGitHubAdapter({});
    const result = await adapter.listDeliveryPullRequests({
      owner: PRIMARY_DELIVERY_FIXTURE.owner,
      repository: PRIMARY_DELIVERY_FIXTURE.repository,
      base: PRIMARY_DELIVERY_FIXTURE.base,
      head: PRIMARY_DELIVERY_FIXTURE.head,
    });

    assert.deepEqual(result, []);
    assert.ok(requestedUrl);
    const parsed = new URL(requestedUrl);
    assert.equal(parsed.searchParams.get("state"), "open");
    assert.equal(parsed.searchParams.get("head"), `${PRIMARY_DELIVERY_FIXTURE.owner}:${PRIMARY_DELIVERY_FIXTURE.head}`);
    assert.equal(parsed.searchParams.get("base"), PRIMARY_DELIVERY_FIXTURE.base);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preflight does not invoke MCP tools after a missing or unauthorized configured server", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-demo-preflight-mcp-"));
  try {
    const calls = [];
    const adapters = passingAdapters({ calls });
    adapters.trueforge.listConfiguredMcpServers = async () => {
      calls.push("trueforge.mcp-servers");
      return { data: { data: [] } };
    };
    adapters.trueforge.listMcpTools = async () => {
      throw new Error("must not be called");
    };

    const report = await runDemoPreflight({ config: config(directory), adapters, timeoutMs: 100 });

    assert.equal(report.ok, false);
    assert.equal(calls.includes("trueforge.mcp-tools"), false);
    assert.equal(report.checks.find((check) => check.id === "trueforge-mcp-server").status, "failed");
    assert.equal(report.checks.find((check) => check.id === "trueforge-mcp-tools").status, "failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preflight fails closed when direct Daytona proof credentials are not configured", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-demo-preflight-daytona-"));
  try {
    const report = await runDemoPreflight({
      config: config(directory, { daytonaApiKeyConfigured: false }),
      adapters: passingAdapters(),
      timeoutMs: 100,
    });
    const check = report.checks.find((item) => item.id === "local-daytona-credential");

    assert.equal(report.ok, false);
    assert.equal(check.status, "failed");
    assert.match(check.summary, /DAYTONA_API_KEY/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preflight timeouts are bounded and reported as failures", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-demo-preflight-timeout-"));
  try {
    const adapters = passingAdapters();
    adapters.trueforge.getCapabilities = () => new Promise(() => {});

    const report = await runDemoPreflight({ config: config(directory), adapters, timeoutMs: 10 });
    const check = report.checks.find((item) => item.id === "trueforge-reachable");

    assert.equal(report.ok, false);
    assert.equal(check.status, "failed");
    assert.match(check.summary, /exceeded the 10ms read-only timeout/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preflight dry-run stays provider-free even with an unreachable TrueForge URL", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/demo-control.mjs", "preflight", "--dry-run"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        TRUEFORGE_BASE_URL: "http://127.0.0.1:1",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"external_calls": false/);
  assert.match(result.stdout, /bounded read-only checks/);
});
