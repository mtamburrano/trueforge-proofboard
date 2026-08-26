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
  agentSpec,
  collectEvidence,
  readConfiguredSandboxProvider,
  sandboxArguments,
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
  assert.match(result.stdout, /Run the requested verification command in the sandbox/);
  assert.match(result.stdout, /TRUEFORGE_DAYTONA_OK/);
});

test("TrueForge smoke agent instructions use the pinned exec argument pair", () => {
  const config = smokeConfig();
  const requests = [...agentSpec(config).instructions.matchAll(/exactly once with (\{[^}]+\})\./g)]
    .map((match) => JSON.parse(match[1]));

  assert.deepEqual(requests[1], sandboxArguments(config));
});

function smokeConfig() {
  return {
    baseUrl: "http://localhost:8790",
    model: "google-gemini/test-model",
    githubServer: "github",
    githubOwner: "owner",
    githubRepo: "repo",
    githubRef: "main",
    githubPath: "package.json",
    command: "printf 'TRUEFORGE_DAYTONA_OK\\n'",
  };
}

function githubFileResult(config) {
  return {
    content: [
      { type: "text", text: "successfully downloaded text file (SHA: fixture-sha)" },
      {
        type: "resource",
        resource: {
          uri: `repo://${config.githubOwner}/${config.githubRepo}/refs/heads/${config.githubRef}/contents/${config.githubPath}`,
          mimeType: "application/json",
          text: "{}",
        },
      },
    ],
  };
}

function sandboxExecResult() {
  return {
    success: true,
    response: {
      exitCode: 0,
      result: "TRUEFORGE_DAYTONA_OK\\n",
    },
  };
}

function evidenceFixture(options = {}) {
  const config = smokeConfig();
  const {
    githubArguments = {
      owner: config.githubOwner,
      repo: config.githubRepo,
      path: config.githubPath,
      ref: config.githubRef,
    },
    githubResult = githubFileResult(config),
    sandboxToolName = "exec",
    sandboxArguments: sandboxCallArguments = sandboxArguments(config),
    sandboxResult = sandboxExecResult(),
  } = options;

  return {
    config,
    events: [
      { type: "turn.done", state: { status: "done", requiredActions: [] } },
      { type: "mcp.initialize", mcpServers: [{ name: "github" }] },
      {
        type: "model.message",
        id: "message-github",
        toolCalls: [{
          id: "call-github",
          function: { name: "get_file_contents", arguments: JSON.stringify(githubArguments) },
        }],
      },
      {
        type: "tool.response",
        id: "response-github",
        toolCallId: "call-github",
        content: JSON.stringify(githubResult),
      },
      { type: "sandbox.created", id: "sandbox-created", sandboxId: "sandbox-fixture" },
      {
        type: "model.message",
        id: "message-sandbox",
        toolCalls: [{
          id: "call-sandbox",
          function: {
            name: sandboxToolName,
            arguments: JSON.stringify(sandboxCallArguments),
          },
        }],
      },
      {
        type: "tool.response",
        id: "response-sandbox",
        toolCallId: "call-sandbox",
        content: JSON.stringify(sandboxResult),
      },
    ],
  };
}

const daytonaProvider = {
  type: "daytona",
  status: "ready",
  status_reason: null,
  source: "settings.sandboxProviders.get",
};

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
  const { config, events } = evidenceFixture();

  const evidence = collectEvidence(events, config, "session-fixture", "turn-fixture", provider);
  assert.equal(evidence.trueforge.session_id, "session-fixture");
  assert.equal(evidence.trueforge.turn_id, "turn-fixture");
  assert.equal(evidence.sandbox.provider.type, "daytona");
  assert.equal(evidence.sandbox.tool_call.name, "exec");
  assert.deepEqual(evidence.sandbox.tool_call.arguments, sandboxArguments(config));
  assert.equal(evidence.sandbox.tool_response.exit_code, 0);
  assert.match(evidence.sandbox.tool_response.stdout, /TRUEFORGE_DAYTONA_OK/);
  assert.equal(
    evidence.mcp.tool_response.metadata.uri,
    "repo://owner/repo/refs/heads/main/contents/package.json",
  );
});

test("TrueForge smoke rejects non-exact GitHub repository arguments", () => {
  const config = smokeConfig();
  const expected = {
    owner: config.githubOwner,
    repo: config.githubRepo,
    path: config.githubPath,
    ref: config.githubRef,
  };
  const cases = [
    { label: "superstring value", githubArguments: { ...expected, repo: `${expected.repo}-suffix` } },
    { label: "wrong field", githubArguments: { owner: expected.owner, repository: expected.repo, path: expected.path, ref: expected.ref } },
    { label: "string payload", githubArguments: JSON.stringify(expected) },
  ];

  for (const fixture of cases) {
    const { events } = evidenceFixture(fixture);
    assert.throws(
      () => collectEvidence(events, config, "session-fixture", "turn-fixture", daytonaProvider),
      /get_file_contents MCP argument|arguments were not a JSON object/,
      fixture.label,
    );
  }
});

test("TrueForge smoke rejects MCP errors and non-file success payloads", () => {
  const cases = [
    {
      label: "MCP error",
      githubResult: { isError: true, content: [{ type: "text", text: "permission denied" }] },
      error: /GitHub MCP returned an error result/,
    },
    {
      label: "text-only success",
      githubResult: { isError: false, content: [{ type: "text", text: JSON.stringify({ path: "package.json" }) }] },
      error: /structured file resource/,
    },
    {
      label: "wrong resource",
      githubResult: {
        content: [{
          type: "resource",
          resource: { uri: "repo://owner/other-repo/contents/package.json", text: "{}" },
        }],
      },
      error: /unexpected repository path/,
    },
  ];

  for (const fixture of cases) {
    const { config, events } = evidenceFixture(fixture);
    assert.throws(
      () => collectEvidence(events, config, "session-fixture", "turn-fixture", daytonaProvider),
      fixture.error,
      fixture.label,
    );
  }
});

test("TrueForge smoke requires the canonical exec tool and exact command", () => {
  const cases = [
    {
      label: "non-canonical sandbox tool",
      sandboxToolName: "sandbox_exec",
      error: /canonical Daytona exec call/,
    },
    {
      label: "modified command",
      sandboxArguments: {
        ...sandboxArguments(smokeConfig()),
        command: "printf 'TRUEFORGE_DAYTONA_OK\\n' && echo extra",
      },
      error: /canonical Daytona exec call/,
    },
  ];

  for (const fixture of cases) {
    const { config, events } = evidenceFixture(fixture);
    assert.throws(
      () => collectEvidence(events, config, "session-fixture", "turn-fixture", daytonaProvider),
      fixture.error,
      fixture.label,
    );
  }
});

test("TrueForge smoke requires required actions to be present on the terminal turn", () => {
  const { config, events } = evidenceFixture();
  events[0].state = { status: "done" };

  assert.throws(
    () => collectEvidence(events, config, "session-fixture", "turn-fixture", daytonaProvider),
    /turn\.done did not include required actions/,
  );
});

test("TrueForge smoke rejects malformed sandbox execution results", () => {
  const marker = "TRUEFORGE_DAYTONA_OK\\n";
  const cases = [
    {
      label: "success is not exactly true",
      sandboxResult: { success: "true", response: { exitCode: 0, result: marker } },
      error: /success: true/,
    },
    {
      label: "sandbox reported failure",
      sandboxResult: { success: false, error: "command failed" },
      error: /success: true/,
    },
    {
      label: "missing exit code",
      sandboxResult: { success: true, response: { result: marker } },
      error: /non-numeric exitCode/,
    },
    {
      label: "null exit code",
      sandboxResult: { success: true, response: { exitCode: null, result: marker } },
      error: /non-numeric exitCode/,
    },
    {
      label: "string exit code",
      sandboxResult: { success: true, response: { exitCode: "0", result: marker } },
      error: /non-numeric exitCode/,
    },
    {
      label: "marker outside response result",
      sandboxResult: {
        success: true,
        response: { exitCode: 0, result: "ordinary output" },
        stderr: marker,
        metadata: { marker },
      },
      error: /smoke marker in response.result/,
    },
    {
      label: "missing response result",
      sandboxResult: { success: true, response: { exitCode: 0 } },
      error: /string response.result/,
    },
  ];

  for (const fixture of cases) {
    const { config, events } = evidenceFixture(fixture);
    assert.throws(
      () => collectEvidence(events, config, "session-fixture", "turn-fixture", daytonaProvider),
      fixture.error,
      fixture.label,
    );
  }
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
