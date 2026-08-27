import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  InMemoryMissionRepository,
  DEFAULT_TRUEFORGE_MODEL,
  JsonMissionRepository,
  MissionService,
  PRIMARY_MISSION_ID,
  PRIMARY_MISSION_OBJECTIVE,
  PRIMARY_VERIFICATION_COMMAND,
  TrueForgeIntegrationError,
  createMissionHttpApp,
  resolveMissionRuntimeConfig,
} from "../dist/index.js";

class TestMissionRunner {
  constructor(
    missions,
    { failSandbox = false, secretInspectionError = false, createGate } = {},
  ) {
    this.missions = missions;
    this.failSandbox = failSandbox;
    this.secretInspectionError = secretInspectionError;
    this.createGate = createGate;
    this.sandboxInputs = [];
    this.calls = { create: 0, inspect: 0, turn: 0, sandbox: 0 };
  }

  async createMission(input) {
    this.calls.create += 1;
    if (this.createGate !== undefined) {
      await this.createGate;
    }
    return this.missions.createMission({
      ...input,
      trueforgeSessionId: "test-session-durable",
    });
  }

  async inspectRepository(input) {
    this.calls.inspect += 1;
    if (this.secretInspectionError) {
      throw new TrueForgeIntegrationError(
        "inspect repository",
        "Provider unavailable: Authorization: Bearer live-token API_KEY=live-key PASSWORD=live-password",
      );
    }
    const evidence = await this.missions.addEvidence(input.missionId, {
      workItemId: input.workItemId,
      kind: "tool_result",
      result: "passed",
      source: "mcp",
      summary: "Repository commit and expected patches were verified.",
      details: JSON.stringify({
        server: "github",
        tool: "get_commit",
        commit_sha: "590aa8a6d72c580f61fc1b19d33e9876bc0feb9b",
        content_hash: "fixture-content-hash",
        token: "must-not-reach-browser",
        authorization: "Bearer must-not-reach-browser",
      }),
    });
    return { evidenceId: evidence.id };
  }

  async runTurn(missionId, _instruction, options) {
    this.calls.turn += 1;
    await this.missions.attachTrueforgeTurn(missionId, `test-turn-${this.calls.turn}`);
    await this.missions.addEvidence(missionId, {
      workItemId: options.workItemId,
      kind: "tool_result",
      result: "passed",
      source: "trueforge",
      summary: "TrueForge turn finished with status done.",
      details: JSON.stringify({ event_type: "turn.done", provider_secret: "hidden" }),
    });
    return {
      sessionId: "test-session-durable",
      turnId: `test-turn-${this.calls.turn}`,
      events: [],
      mission: await this.missions.getMission(missionId),
    };
  }

  async runSandboxVerification(input) {
    this.calls.sandbox += 1;
    this.sandboxInputs.push(input);
    if (this.failSandbox) {
      await this.missions.addEvidence(input.missionId, {
        workItemId: input.workItemId,
        kind: "test_result",
        result: "failed",
        source: "sandbox",
        summary: "Sandbox verification failed; the command was not accepted as passing.",
        details: JSON.stringify({
          tool: "exec",
          command: input.command,
          exit_code: 1,
          output: "one focused assertion failed",
          apiKey: "must-not-reach-browser",
        }),
      });
      throw new TrueForgeIntegrationError(
        "run sandbox verification",
        "Sandbox verification command exited with code 1.",
      );
    }
    const evidence = await this.missions.addEvidence(input.missionId, {
      workItemId: input.workItemId,
      kind: "test_result",
      result: "passed",
      source: "sandbox",
      summary: "Sandbox exec completed the verification command with exit code 0.",
      details: JSON.stringify({
        tool: "exec",
        command: input.command,
        exit_code: 0,
        output: "typecheck passed\nall tests passed",
        secret: "must-not-reach-browser",
      }),
    });
    return { evidenceId: evidence.id };
  }
}

function testApp(repository = new InMemoryMissionRepository(), options) {
  const missions = new MissionService(repository);
  const runner = new TestMissionRunner(missions, options);
  return { missions, runner, app: createMissionHttpApp({ missions, runner }) };
}

async function json(response) {
  const payload = await response.json();
  assert.equal(response.headers.get("cache-control"), "no-store");
  return payload;
}

test("initial mission route and static application assets load", async () => {
  const { app } = testApp();

  const page = await app.request("/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  const pageBody = await page.text();
  assert.match(pageBody, /MISSION CONTROL/);
  assert.match(pageBody, /run-state\.js[\s\S]+app\.js/);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);

  const script = await app.request("/public/app.js");
  assert.equal(script.status, 200);
  const scriptBody = await script.text();
  assert.match(scriptBody, /Create primary mission/);
  assert.match(scriptBody, /data-source=/);
  assert.match(scriptBody, /data-result=/);
  assert.match(scriptBody, /Runtime narration never appears in this panel/);

  const style = await app.request("/public/style.css");
  assert.equal(style.status, 200);
  const styleBody = await style.text();
  assert.match(styleBody, /--color-primary: #5fd9cd/);
  assert.match(styleBody, /evidence-card\[data-source="mcp"\]/);
  assert.match(styleBody, /evidence-card\[data-result="failed"\]/);

  const runState = await app.request("/public/run-state.js");
  assert.equal(runState.status, 200);
  assert.match(await runState.text(), /createRunCoordinator/);
});

test("create or open is idempotent and returns durable structured mission state", async () => {
  const { app, runner } = testApp();

  const empty = await json(await app.request("/api/mission"));
  assert.equal(empty.mission, null);

  const createdResponse = await app.request("/api/mission", { method: "POST" });
  assert.equal(createdResponse.status, 201);
  const created = await json(createdResponse);
  assert.equal(created.mission.mission.id, PRIMARY_MISSION_ID);
  assert.equal(created.mission.mission.objective, PRIMARY_MISSION_OBJECTIVE);
  assert.equal(created.mission.mission.execution.connected, true);
  assert.deepEqual(created.mission.lanes.map((lane) => lane.label), [
    "Plan",
    "Execute",
    "Prove",
    "Approve",
  ]);
  assert.equal(created.mission.progress.total, 1);

  const opened = await json(await app.request("/api/mission", { method: "POST" }));
  assert.equal(opened.mission.mission.id, created.mission.mission.id);
  assert.equal(opened.mission.revision, created.mission.revision);
  assert.equal(runner.calls.create, 1);
});

test("cross-origin browser state changes are rejected while same-origin changes remain valid", async () => {
  const { app, runner } = testApp();

  const rejected = await json(await app.request("/api/mission", {
    method: "POST",
    headers: { Origin: "https://attacker.example" },
  }));
  assert.equal(rejected.error, "cross_origin");
  assert.equal(runner.calls.create, 0);
  assert.equal((await json(await app.request("/api/mission"))).mission, null);

  const acceptedResponse = await app.request("/api/mission", {
    method: "POST",
    headers: { Origin: "http://mission.local" },
  });
  assert.equal(acceptedResponse.status, 201);
  assert.equal(runner.calls.create, 1);
});

test("concurrent primary mission creation shares one durable create operation", async () => {
  let releaseCreate;
  const createGate = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  const { app, runner } = testApp(new InMemoryMissionRepository(), { createGate });

  const first = app.request("/api/mission", { method: "POST" });
  while (runner.calls.create === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const second = app.request("/api/mission", { method: "POST" });
  assert.equal(runner.calls.create, 1);
  releaseCreate();

  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.status, 201);
  assert.equal(secondResponse.status, 201);
  const [firstPayload, secondPayload] = await Promise.all([
    json(firstResponse),
    json(secondResponse),
  ]);
  assert.equal(firstPayload.mission.mission.id, PRIMARY_MISSION_ID);
  assert.equal(secondPayload.mission.mission.id, PRIMARY_MISSION_ID);
  assert.equal(firstPayload.mission.revision, secondPayload.mission.revision);
  assert.equal(runner.calls.create, 1);
});

test("API maps persisted proof separately from runtime narration and redacts secrets", async () => {
  const { app, missions } = testApp();
  await app.request("/api/mission", { method: "POST" });
  await missions.persistWorkGraph(PRIMARY_MISSION_ID, {
    items: [
      {
        id: "primary-inspect",
        title: "Inspect the repository",
        purpose: "Establish verified repository facts.",
        acceptanceCriteria: ["Repository inspection is durably correlated."],
        dependsOn: [],
        assignedRole: "planner",
      },
      {
        id: "primary-verify",
        title: "Verify the delivery",
        purpose: "Capture independent sandbox proof.",
        acceptanceCriteria: ["Sandbox verification is durably correlated."],
        dependsOn: ["primary-inspect"],
        assignedRole: "reviewer",
      },
    ],
  });
  await missions.addEvidence(PRIMARY_MISSION_ID, {
    workItemId: "primary-inspect",
    kind: "tool_result",
    result: "passed",
    source: "mcp",
    summary: "Durable repository fact from the test state.",
    details: JSON.stringify({
      server: "github",
      tool: "get_commit",
      commit_sha: "durable-commit",
      token: "browser-secret",
      nested: { authorization: "browser-secret" },
    }),
  });
  await missions.addEvidence(PRIMARY_MISSION_ID, {
    workItemId: "primary-verify",
    kind: "test_result",
    result: "failed",
    source: "sandbox",
    summary: "Durable failed command from the test state.",
    details: JSON.stringify({
      command: "npm test",
      exit_code: 1,
      output: "assertion failed",
      apiKey: "browser-secret",
    }),
  });
  await missions.addEvidence(PRIMARY_MISSION_ID, {
    kind: "reviewer_finding",
    result: "passed",
    source: "agent",
    summary: "Free-form narration claims everything passed.",
    details: JSON.stringify({ secret: "browser-secret" }),
  });

  const payload = await json(await app.request("/api/mission"));
  assert.deepEqual(payload.mission.evidence.map((item) => item.source).sort(), ["mcp", "sandbox"]);
  assert.equal(payload.mission.evidence.find((item) => item.source === "mcp").metadata.commitSha, "durable-commit");
  assert.equal(payload.mission.evidence.find((item) => item.source === "sandbox").metadata.exitCode, 1);
  assert.equal(payload.mission.activity.some((item) => item.category === "narration"), true);
  assert.equal(payload.mission.evidence.some((item) => item.summary.includes("Free-form")), false);
  assert.equal(payload.mission.progress.verification, "failed");

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /browser-secret|apiKey|authorization|token/);
  assert.doesNotMatch(serialized, /details/);
});

test("run mission uses the runtime adapters and exposes passed proof", async () => {
  const { app, runner } = testApp();

  const response = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(response.status, 200);
  const payload = await json(response);
  assert.equal(payload.mission.mission.status, "verifying");
  assert.equal(payload.mission.progress.complete, 3);
  assert.equal(payload.mission.progress.verification, "passed");
  assert.deepEqual(payload.mission.evidence.map((item) => item.source).sort(), ["mcp", "sandbox"]);
  assert.deepEqual(runner.calls, { create: 1, inspect: 1, turn: 1, sandbox: 1 });
  assert.equal(runner.sandboxInputs[0].command, PRIMARY_VERIFICATION_COMMAND);
  assert.match(runner.sandboxInputs[0].command, /node --input-type=module -e/);
  assert.match(runner.sandboxInputs[0].command, /--loader/);
  assert.match(runner.sandboxInputs[0].command, /--test\", \"test\/index\.test\.js/);
  assert.match(runner.sandboxInputs[0].command, /getNextDeliveryStage/);

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /must-not-reach-browser|provider_secret/);
});

test("failed sandbox proof remains visibly failed and blocks the mission", async () => {
  const { app } = testApp(new InMemoryMissionRepository(), { failSandbox: true });

  const response = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(response.status, 502);
  const payload = await json(response);
  assert.equal(payload.mission.mission.status, "blocked");
  assert.equal(payload.mission.progress.verification, "failed");
  const sandbox = payload.mission.evidence.find((item) => item.source === "sandbox");
  assert.equal(sandbox.result, "failed");
  assert.equal(sandbox.metadata.exitCode, 1);
  assert.equal(payload.mission.evidence.some(
    (item) => item.source === "sandbox" && item.result === "passed",
  ), false);
});

test("a successful retry uses current proof while preserving historical failure", async () => {
  const { app, runner } = testApp(new InMemoryMissionRepository(), { failSandbox: true });

  const failedResponse = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(failedResponse.status, 502);
  const failed = await json(failedResponse);
  assert.equal(failed.mission.mission.status, "blocked");
  assert.equal(failed.mission.progress.verification, "failed");

  runner.failSandbox = false;
  const retryResponse = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(retryResponse.status, 200);
  const retried = await json(retryResponse);
  assert.equal(retried.mission.mission.status, "verifying");
  assert.equal(retried.mission.progress.verification, "passed");
  assert.equal(retried.mission.progress.failedEvidence, 1);
  assert.deepEqual(
    retried.mission.evidence
      .filter((item) => item.source === "sandbox")
      .map((item) => item.result)
      .sort(),
    ["failed", "passed"],
  );
  assert.deepEqual(runner.calls, { create: 1, inspect: 1, turn: 1, sandbox: 2 });
});

test("integration errors expose bounded public text without upstream secrets", async () => {
  const { app } = testApp(new InMemoryMissionRepository(), { secretInspectionError: true });

  const response = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(response.status, 502);
  const payload = await json(response);
  assert.match(payload.message, /Repository inspection failed/);
  assert.equal(payload.mission.mission.status, "blocked");

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(
    serialized,
    /live-token|live-key|live-password|Authorization|Bearer|API_KEY|PASSWORD/i,
  );
});

test("Mission Control defaults to Alibaba Qwen and accepts an explicit model selector", () => {
  assert.equal(DEFAULT_TRUEFORGE_MODEL, "alibaba/qwen3-7-plus");
  assert.equal(resolveMissionRuntimeConfig({}).model, DEFAULT_TRUEFORGE_MODEL);
  assert.equal(
    resolveMissionRuntimeConfig({ TRUEFORGE_MODEL: "custom/provider-model" }).model,
    "custom/provider-model",
  );
  assert.equal(
    resolveMissionRuntimeConfig({ TRUEFORGE_MODEL: "  " }).model,
    DEFAULT_TRUEFORGE_MODEL,
  );
  assert.throws(
    () => resolveMissionRuntimeConfig({ TRUEFORGE_UI_PORT: "invalid" }),
    /valid TCP port/,
  );
  assert.equal(resolveMissionRuntimeConfig({ TRUEFORGE_UI_HOST: "localhost" }).host, "localhost");
  assert.equal(resolveMissionRuntimeConfig({ TRUEFORGE_UI_HOST: "[::1]" }).host, "[::1]");
  assert.throws(
    () => resolveMissionRuntimeConfig({ TRUEFORGE_UI_HOST: "0.0.0.0" }),
    /loopback address/,
  );
});

test("a fresh service recovers the same mission and evidence from isolated JSON state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-http-test-"));
  const filePath = path.join(directory, "mission-state.json");
  try {
    const first = testApp(new JsonMissionRepository(filePath));
    const run = await first.app.request("/api/mission/run", { method: "POST" });
    assert.equal(run.status, 200);
    const before = await json(run);

    const second = testApp(new JsonMissionRepository(filePath));
    const after = await json(await second.app.request("/api/mission"));
    assert.equal(after.mission.mission.id, before.mission.mission.id);
    assert.equal(after.mission.mission.status, "verifying");
    assert.equal(after.mission.revision, before.mission.revision);
    assert.deepEqual(after.mission.evidence, before.mission.evidence);
    assert.equal(second.runner.calls.create, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
