import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  deliveryStages,
  getProductSummary,
  productName,
  productThesis,
} from "../dist/index.js";
import {
  collectEvidence,
  readConfiguredSandboxProvider,
} from "../scripts/trueforge-smoke.mjs";

test("exports the product identity and delivery thesis", () => {
  assert.equal(productName, "TrueForge Proof Board");
  assert.equal(productThesis, "Verified autonomous software delivery");
  assert.deepEqual(deliveryStages, ["Plan", "Execute", "Prove", "Approve"]);
  assert.equal(
    getProductSummary(),
    "TrueForge Proof Board: Verified autonomous software delivery — Plan → Execute → Prove → Approve",
  );
});

test("TrueForge smoke dry-run is local and contains the expected evidence contract", () => {
  const result = spawnSync(process.execPath, ["scripts/trueforge-smoke.mjs", "--dry-run"], {
    encoding: "utf8",
    env: {
      ...process.env,
      TRUEFORGE_MODEL: "google-gemini/test-model",
      TRUEFORGE_GITHUB_SERVER: "github-test",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"external_calls": false/);
  assert.match(result.stdout, /"tool": "get_file_contents"/);
  assert.match(result.stdout, /daytona \(checked from TrueForge settings during live run\)/);
  assert.match(result.stdout, /TRUEFORGE_DAYTONA_OK/);
});

test("TrueForge smoke evidence preserves IDs and proves the configured Daytona provider", async () => {
  const providerClient = {
    settings: {
      sandboxProviders: {
        get: async () => ({
          data: {
            data: {
              manifest: { type: "daytona" },
              status: "ready",
            },
          },
        }),
      },
    },
  };
  const provider = await readConfiguredSandboxProvider(providerClient);
  const config = {
    baseUrl: "http://localhost:8790",
    model: "google-gemini/test-model",
    githubServer: "github",
    githubOwner: "owner",
    githubRepo: "repo",
    githubRef: "main",
    githubPath: "package.json",
    command: "printf 'TRUEFORGE_DAYTONA_OK\\n'",
  };
  const githubArgs = JSON.stringify({
    owner: config.githubOwner,
    repo: config.githubRepo,
    path: config.githubPath,
    ref: config.githubRef,
  });
  const events = [
    { type: "turn.done", state: { status: "done", requiredActions: [] } },
    { type: "mcp.initialize", mcpServers: [{ name: "github" }] },
    {
      type: "model.message",
      id: "message-github",
      toolCalls: [{ id: "call-github", function: { name: "get_file_contents", arguments: githubArgs } }],
    },
    {
      type: "tool.response",
      id: "response-github",
      toolCallId: "call-github",
      content: JSON.stringify({ path: "package.json", sha: "fixture-sha", content: "{}" }),
    },
    { type: "sandbox.created", id: "sandbox-created", sandboxId: "sandbox-fixture" },
    {
      type: "model.message",
      id: "message-sandbox",
      toolCalls: [{
        id: "call-sandbox",
        function: { name: "sandbox_exec", arguments: JSON.stringify({ command: config.command }) },
      }],
    },
    {
      type: "tool.response",
      id: "response-sandbox",
      toolCallId: "call-sandbox",
      content: JSON.stringify({ stdout: "TRUEFORGE_DAYTONA_OK\\n", exit_code: 0 }),
    },
  ];

  const evidence = collectEvidence(events, config, "session-fixture", "turn-fixture", provider);
  assert.equal(evidence.trueforge.session_id, "session-fixture");
  assert.equal(evidence.trueforge.turn_id, "turn-fixture");
  assert.equal(evidence.sandbox.provider.type, "daytona");
  assert.equal(evidence.sandbox.tool_response.exit_code, 0);
  assert.match(evidence.sandbox.tool_response.stdout, /TRUEFORGE_DAYTONA_OK/);
});

test("TrueForge smoke rejects a non-Daytona configured provider", async () => {
  const providerClient = {
    settings: {
      sandboxProviders: {
        get: async () => ({ data: { data: { manifest: { type: "e2b" } } } }),
      },
    },
  };

  await assert.rejects(
    () => readConfiguredSandboxProvider(providerClient),
    /not Daytona/,
  );
});
