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
  PRIMARY_DELIVERY_FIXTURE,
  PRIMARY_VERIFIED_DELIVERY_PATCHES,
  PRIMARY_MISSION_ID,
  PRIMARY_MISSION_OBJECTIVE,
  PRIMARY_SANDBOX_REPOSITORY_ROOT,
  PRIMARY_VERIFICATION_COMMAND,
  TrueForgeIntegrationError,
  createMissionHttpApp,
  resolveMissionRuntimeConfig,
} from "../dist/index.js";

class TestMissionRunner {
  constructor(
    missions,
    {
      failSandbox = false,
      secretInspectionError = false,
      createGate,
      inspectionRepository = PRIMARY_DELIVERY_FIXTURE,
      deliveryHeadSha = "8bb22a62b3714f699204cb0d5c440fcb7f0a09e1",
      deliveryHeadPatches = PRIMARY_VERIFIED_DELIVERY_PATCHES,
    } = {},
  ) {
    this.missions = missions;
    this.failSandbox = failSandbox;
    this.secretInspectionError = secretInspectionError;
    this.createGate = createGate;
    this.inspectionRepository = inspectionRepository;
    this.deliveryHeadSha = deliveryHeadSha;
    this.deliveryHeadPatches = deliveryHeadPatches;
    this.sandboxInputs = [];
    this.operationLog = [];
    this.turnInputs = [];
    this.deliveryCalls = { requested: [], resolved: [], protectedOperations: 0 };
    this.calls = { create: 0, inspect: 0, headInspect: 0, turn: 0, sandbox: 0 };
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
    this.operationLog.push("inspect");
    this.calls.inspect += 1;
    await this.missions.attachTrueforgeTurn(input.missionId, "test-inspection-turn");
    if (this.secretInspectionError) {
      throw new TrueForgeIntegrationError(
        "inspect repository",
        "Provider unavailable: Authorization: Bearer live-token API_KEY=live-key PASSWORD=live-password",
      );
    }
    const target = this.inspectionRepository;
    const resourceUri = `repo://${target.owner}/${target.repository}/sha/${target.baselineSha}`;
    const evidence = await this.missions.addEvidence(input.missionId, {
      workItemId: input.workItemId,
      kind: "tool_result",
      result: "passed",
      source: "mcp",
      summary: "Repository commit and expected patches were verified.",
      details: JSON.stringify({
        server: "github",
        tool: "get_commit",
        provenance_kind: "baseline",
        arguments: {
          owner: target.owner,
          repo: target.repository,
          sha: target.baselineRef,
          detail: "full_patch",
        },
        repository_owner: target.owner,
        repository_name: target.repository,
        requested_ref: target.baselineRef,
        uri: resourceUri,
        commit_sha: target.baselineSha,
        content_hash: "fixture-content-hash",
        token: "must-not-reach-browser",
        authorization: "Bearer must-not-reach-browser",
      }),
      executionOrigin: {
        kind: "mcp",
        sessionId: "test-session-durable",
        turnId: "test-inspection-turn",
      },
    });
    return {
      evidenceId: evidence.id,
      resourceUri,
      contentHash: "fixture-content-hash",
      commitSha: target.baselineSha,
      patches: {
        "src/index.ts": "@@ verified source",
        "test/index.test.js": "@@ verified focused tests",
      },
    };
  }

  async inspectDeliveryHead(input) {
    this.operationLog.push("head-inspect");
    this.calls.headInspect += 1;
    const target = input.target;
    const resourceUri = `repo://${target.owner}/${target.repo}/sha/${this.deliveryHeadSha}`;
    const evidence = await this.missions.addEvidence(input.missionId, {
      kind: "tool_result",
      result: "passed",
      source: "mcp",
      summary: `The changed delivery head was verified at ${this.deliveryHeadSha}.`,
      details: JSON.stringify({
        server: "github",
        tool: "get_commit",
        provenance_kind: "delivery_head",
        arguments: {
          owner: target.owner,
          repo: target.repo,
          sha: target.head,
          detail: "full_patch",
        },
        repository_owner: target.owner,
        repository_name: target.repo,
        requested_ref: target.head,
        baseline_sha: PRIMARY_DELIVERY_FIXTURE.baselineSha,
        uri: resourceUri,
        commit_sha: this.deliveryHeadSha,
        patches: this.deliveryHeadPatches,
        content_hash: "verified-delivery-head-content-hash",
      }),
      executionOrigin: {
        kind: "mcp",
        sessionId: "test-session-durable",
        turnId: "test-delivery-head-turn",
      },
    });
    return {
      evidenceId: evidence.id,
      resourceUri,
      contentHash: "verified-delivery-head-content-hash",
      commitSha: this.deliveryHeadSha,
      patches: this.deliveryHeadPatches,
    };
  }

  async runTurn(missionId, _instruction, options) {
    this.operationLog.push("execute");
    this.calls.turn += 1;
    this.turnInputs.push({ instruction: _instruction, options });
    const turnId = `test-turn-${this.calls.turn}`;
    await this.missions.attachTrueforgeTurn(missionId, turnId);
    await this.missions.attachTrueforgeSandbox(missionId, "test-sandbox-durable");
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
      turnId,
      events: [],
      mission: await this.missions.getMission(missionId),
    };
  }

  async proveImplementation(input) {
    this.operationLog.push("prove");
    this.calls.sandbox += 1;
    this.sandboxInputs.push(input);
    const origin = { kind: "sandbox", sessionId: "test-session-durable" };
    if (this.failSandbox) {
      await this.missions.addEvidence(input.missionId, {
        workItemId: input.workItemId,
        kind: "test_result",
        result: "failed",
        source: "sandbox",
        summary: "Independent final-state proof failed.",
        details: JSON.stringify({ command: PRIMARY_VERIFICATION_COMMAND, exit_code: 1 }),
      });
      throw new TrueForgeIntegrationError(
        "prove implementation",
        "Independent authoritative test exited with code 1.",
      );
    }
    const workItem = await this.missions.getWorkItem(input.missionId, input.workItemId);
    const filesChanged = workItem.allowedFiles ?? [];
    const diffOutput = filesChanged.map((file) =>
      `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1,2 @@\n before\n+after`
    ).join("\n");
    const diff = await this.missions.addEvidence(input.missionId, {
      workItemId: input.workItemId,
      kind: "diff_summary",
      result: "passed",
      source: "sandbox",
      summary: "Independent proof captured the actual final diff.",
      details: JSON.stringify({ command: "git diff", output: diffOutput, changed_files: filesChanged }),
      executionOrigin: origin,
    });
    const typecheck = await this.missions.addEvidence(input.missionId, {
      workItemId: input.workItemId,
      kind: "typecheck_result",
      result: "passed",
      source: "sandbox",
      summary: "Independent typecheck passed.",
      executionOrigin: origin,
    });
    const tests = await this.missions.addEvidence(input.missionId, {
      workItemId: input.workItemId,
      kind: "test_result",
      result: "passed",
      source: "sandbox",
      summary: "Independent tests passed.",
      executionOrigin: origin,
    });
    return {
      filesChanged,
      diffSummary: diffOutput,
      checks: [
        { name: "typecheck", command: "npm run typecheck", result: "passed", required: true, evidenceIds: [typecheck.id], exitCode: 0 },
        { name: "test", command: PRIMARY_VERIFICATION_COMMAND, result: "passed", required: true, evidenceIds: [tests.id], exitCode: 0 },
      ],
      evidenceIds: [diff.id, typecheck.id, tests.id],
      decisions: [],
      openQuestions: [],
      executionOrigin: origin,
    };
  }

  async runSandboxVerification(input) {
    this.operationLog.push("verify-sandbox");
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

  async reviewContract() {
    return {
      outcome: "accepted",
      reviewer: "test-independent-reviewer",
      summary: "Independent review accepted the measured implementation.",
      finding: "The actual diff and authoritative checks satisfy the bounded contract.",
    };
  }

  async requestPullRequestApproval(missionId, target) {
    this.deliveryCalls.requested.push({ missionId, target });
    return {
      sessionId: "test-session-durable",
      turnId: "test-delivery-approval-turn",
      threadId: "test-delivery-thread",
      toolCallId: "test-create-pull-request-call",
      serverName: "github",
      toolName: "create_pull_request",
      target: { ...target },
    };
  }

  async resolvePullRequestApproval(missionId, pending, decision) {
    this.deliveryCalls.resolved.push({ missionId, pending, decision });
    if (decision !== "approved") {
      return null;
    }
    this.deliveryCalls.protectedOperations += 1;
    return {
      number: 73,
      url: "https://github.com/mtamburrano/proofboard-demo-fixture/pull/73",
      headSha: pending.target.headSha,
      sessionId: pending.sessionId,
      turnId: "test-delivery-result-turn",
      threadId: pending.threadId,
      toolCallId: pending.toolCallId,
    };
  }
}

function testApp(repository = new InMemoryMissionRepository(), options = {}) {
  const { planner, verifier, ...runnerOptions } = options;
  const missions = new MissionService(repository);
  const runner = new TestMissionRunner(missions, runnerOptions);
  return {
    missions,
    runner,
    app: createMissionHttpApp({ missions, runner, planner, verifier }),
  };
}

async function json(response) {
  const payload = await response.json();
  assert.equal(response.headers.get("cache-control"), "no-store");
  return payload;
}

async function authorizeTicket(app, ticketId, actor = "test-operator") {
  const current = await json(await app.request("/api/mission"));
  const ticket = current.mission.tickets.find((item) => item.id === ticketId);
  assert.ok(ticket, `Ticket ${ticketId} should exist before authorization.`);
  const response = await app.request(`/api/mission/tickets/${ticketId}/status`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "ready",
      actor,
      expected_revision: current.mission.revision,
    }),
  });
  assert.equal(response.status, 200);
  return json(response);
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
  assert.match(scriptBody, /Execution/);
  assert.match(scriptBody, /onRunStart/);
  assert.match(scriptBody, /clearMessage\(\)/);
  assert.match(scriptBody, /Approve exact action/);
  assert.match(scriptBody, /Rejected\. The protected repository operation was not executed/);
  assert.match(scriptBody, /Cancelled\. The protected repository operation was not executed/);
  assert.match(scriptBody, /Waiting for correlated remote result evidence/);
  assert.match(scriptBody, /Delivered pull request/);
  assert.match(scriptBody, /Copy diagnostic snapshot/);

  const style = await app.request("/public/style.css");
  assert.equal(style.status, 200);
  const styleBody = await style.text();
  assert.match(styleBody, /--color-primary: #5fd9cd/);
  assert.match(styleBody, /evidence-card\[data-source="mcp"\]/);
  assert.match(styleBody, /evidence-card\[data-result="failed"\]/);
  assert.match(styleBody, /approval-actions/);
  assert.match(styleBody, /delivery-card/);
  assert.match(styleBody, /diagnostics-panel/);

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

test("blocked missions expose one safe diagnostic snapshot with exact tool failure context", async () => {
  const { app, missions } = testApp();
  await app.request("/api/mission", { method: "POST" });
  const exactReason = "Expected exactly one canonical get_commit MCP call, found 0.";
  await missions.addEvidence(PRIMARY_MISSION_ID, {
    workItemId: "primary-inspect",
    kind: "tool_result",
    result: "failed",
    source: "mcp",
    summary: "MCP repository inspection failed; no repository finding was accepted.",
    details: JSON.stringify({
      failure_layer: "tool",
      failure_category: "mcp",
      reason: exactReason,
      tool_calls: [{
        id: "diagnostic-call",
        name: "get_commit",
        arguments: { owner: "mtamburrano", repo: "wrong-repository" },
      }],
      tool_responses: [{
        event_id: "diagnostic-response",
        tool_call_id: "diagnostic-call",
        content: { isError: true, token: "must-not-reach-browser" },
      }],
    }),
    executionOrigin: {
      kind: "mcp",
      sessionId: "diagnostic-session",
      turnId: "diagnostic-turn",
      toolCallId: "diagnostic-call",
    },
  });
  await missions.transitionWorkItem(PRIMARY_MISSION_ID, "primary-inspect", "blocked");
  await missions.transitionMission(PRIMARY_MISSION_ID, "blocked");

  const response = await app.request("/api/mission");
  assert.equal(response.status, 200);
  const payload = await json(response);
  const diagnostics = payload.mission.diagnostics;
  assert.equal(diagnostics.version, 1);
  assert.equal(diagnostics.mission.status, "blocked");
  assert.equal(diagnostics.workItems[0].status, "blocked");
  assert.equal(diagnostics.failedEvidence[0].reason, exactReason);
  assert.equal(diagnostics.failures.some((failure) =>
    failure.layer === "tool" && failure.category === "mcp" && failure.reason === exactReason
  ), true);
  assert.equal(diagnostics.trueforge.sessionId, "test-session-durable");
  assert.equal(diagnostics.trueforge.turnId, undefined);
  assert.equal(diagnostics.failedEvidence[0].origin.sessionId, "diagnostic-session");
  assert.equal(diagnostics.failedEvidence[0].origin.turnId, "diagnostic-turn");
  assert.equal(diagnostics.events.some((event) =>
    event.type === "tool.call" && event.toolCallId === "diagnostic-call"
  ), true);
  assert.equal(diagnostics.events.some((event) => event.type === "tool.response"), true);

  const diagnosticsRoute = await json(await app.request("/api/mission/diagnostics"));
  assert.deepEqual(diagnosticsRoute.diagnostics, diagnostics);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /must-not-reach-browser/);
  assert.doesNotMatch(serialized, /details/);
});

test("run mission executes only the human-authorized queue ticket and preserves continuity", async () => {
  const { app, runner } = testApp();

  await app.request("/api/mission", { method: "POST" });
  const initial = await json(await app.request("/api/mission"));
  const inspectTicket = initial.mission.tickets.find((item) => item.assignedRole === "planner");
  assert.equal(inspectTicket.status, "backlog");

  await authorizeTicket(app, inspectTicket.id);
  const response = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(response.status, 200);
  const inspected = await json(response);
  assert.equal(inspected.mission.mission.status, "executing");
  assert.equal(inspected.mission.tickets.find((item) => item.id === inspectTicket.id).status, "done");
  const implementTicket = inspected.mission.tickets.find((item) => item.assignedRole === "implementer");
  assert.equal(implementTicket.status, "backlog");
  assert.equal(inspected.mission.approvals.length, 0);
  assert.deepEqual(runner.operationLog, ["inspect"]);
  assert.equal(runner.calls.inspect, 1);
  assert.equal(runner.calls.turn, 0);

  await authorizeTicket(app, implementTicket.id);
  const implementationResponse = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(implementationResponse.status, 200);
  const implemented = await json(implementationResponse);
  const implementedTicket = implemented.mission.tickets.find((item) => item.id === implementTicket.id);
  assert.equal(implementedTicket.status, "proving");
  assert.equal(implementedTicket.claim.owner, "trueforge-worker");
  assert.equal(implementedTicket.claim.trueforgeSessionId, "test-session-durable");
  assert.equal(implementedTicket.executionAuthorization.authorizedBy, "test-operator");
  assert.equal(implemented.mission.mission.execution.sandboxId, "test-sandbox-durable");
  assert.equal(implemented.mission.approvals.length, 0);
  assert.deepEqual(runner.operationLog, ["inspect", "execute"]);
  assert.deepEqual(runner.calls, { create: 1, inspect: 1, headInspect: 0, turn: 1, sandbox: 0 });
  assert.deepEqual(runner.turnInputs.map((input) => input.options.workItemId), [implementTicket.id]);
  assert.equal(runner.turnInputs[0].options.previousTurnId, "test-inspection-turn");
  assert.match(runner.turnInputs[0].instruction, /Verified repository facts: mtamburrano\/proofboard-demo-fixture at full commit/);
  assert.match(runner.turnInputs[0].instruction, /Allowed files: src\/index\.ts, test\/index\.test\.js/);
  assert.match(runner.turnInputs[0].instruction, new RegExp(PRIMARY_SANDBOX_REPOSITORY_ROOT.replaceAll("/", "\\/")));
  assert.match(runner.turnInputs[0].instruction, /real persistent sandbox/i);
  assert.match(runner.turnInputs[0].instruction, /Do not push, open a pull request, or perform any other remote mutation/i);
  const serialized = JSON.stringify(implemented);
  assert.doesNotMatch(serialized, /must-not-reach-browser|provider_secret/);
});

test("run mission requires an explicit Ready authorization and performs no provider call otherwise", async () => {
  const { app, runner } = testApp();
  await app.request("/api/mission", { method: "POST" });

  const response = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(response.status, 400);
  const payload = await json(response);
  assert.match(payload.message, /No ticket is Ready|Backlog.*Ready/i);
  assert.equal(payload.mission.mission.status, "draft");
  assert.equal(payload.mission.tickets.find((item) => item.assignedRole === "planner").status, "backlog");
  assert.deepEqual(runner.calls, { create: 1, inspect: 0, headInspect: 0, turn: 0, sandbox: 0 });
  assert.equal(runner.deliveryCalls.requested.length, 0);
});

test("repository execution failure blocks the authorized ticket with bounded public diagnostics", async () => {
  const { app, runner } = testApp(new InMemoryMissionRepository(), { secretInspectionError: true });
  await app.request("/api/mission", { method: "POST" });
  const initial = await json(await app.request("/api/mission"));
  const inspectTicket = initial.mission.tickets.find((item) => item.assignedRole === "planner");
  await authorizeTicket(app, inspectTicket.id);

  const response = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(response.status, 502);
  const payload = await json(response);
  assert.match(payload.message, /Repository inspection failed/);
  assert.equal(payload.mission.mission.status, "blocked");
  assert.equal(payload.mission.tickets.find((item) => item.id === inspectTicket.id).status, "blocked");
  assert.equal(runner.calls.inspect, 1);
  assert.equal(runner.deliveryCalls.requested.length, 0);

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(
    serialized,
    /live-token|live-key|live-password|Bearer|API_KEY|live-secret/i,
  );
});

test("a blocked queue does not silently retry or resurrect the failed execution", async () => {
  const { app, runner } = testApp(new InMemoryMissionRepository(), { secretInspectionError: true });
  await app.request("/api/mission", { method: "POST" });
  const initial = await json(await app.request("/api/mission"));
  const inspectTicket = initial.mission.tickets.find((item) => item.assignedRole === "planner");
  await authorizeTicket(app, inspectTicket.id);
  assert.equal((await app.request("/api/mission/run", { method: "POST" })).status, 502);

  runner.secretInspectionError = false;
  const retry = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(retry.status, 400);
  const payload = await json(retry);
  assert.equal(payload.mission.mission.status, "blocked");
  assert.equal(runner.calls.inspect, 1);
});

test("the primary controller leaves review and remote delivery for later authorized queue stages", async () => {
  const reviewed = [];
  const verifier = {
    review(context) {
      reviewed.push(context);
      return {
        outcome: "accepted",
        reviewer: "test-reviewer",
        summary: "accepted",
        finding: "accepted",
      };
    },
  };
  const { app, runner, missions } = testApp(new InMemoryMissionRepository(), { verifier });
  await app.request("/api/mission", { method: "POST" });
  const initial = await json(await app.request("/api/mission"));
  const inspectTicket = initial.mission.tickets.find((item) => item.assignedRole === "planner");
  await authorizeTicket(app, inspectTicket.id);
  await app.request("/api/mission/run", { method: "POST" });

  const planned = await json(await app.request("/api/mission"));
  const implementTicket = planned.mission.tickets.find((item) => item.assignedRole === "implementer");
  await authorizeTicket(app, implementTicket.id);
  const response = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(response.status, 200);
  const state = await missions.getState();
  assert.equal(state.workItems.find((item) => item.id === implementTicket.id).status, "proving");
  assert.equal(reviewed.length, 0);
  assert.equal(state.handoffs.length, 0);
  assert.equal(state.reviews.length, 0);
  assert.equal(state.approvals.length, 0);
  assert.equal(runner.deliveryCalls.requested.length, 0);
});

test("Mission Control defaults to Alibaba Qwen and accepts an explicit model selector", () => {
  assert.equal(DEFAULT_TRUEFORGE_MODEL, "alibaba/qwen3-8-max");
  assert.equal(resolveMissionRuntimeConfig({}).model, DEFAULT_TRUEFORGE_MODEL);
  assert.equal(
    resolveMissionRuntimeConfig({ TRUEFORGE_MODEL: "openai/gpt-5-4-mini" }).model,
    "openai/gpt-5-4-mini",
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
    await first.app.request("/api/mission", { method: "POST" });
    const initial = await json(await first.app.request("/api/mission"));
    const inspectTicket = initial.mission.tickets.find((item) => item.assignedRole === "planner");
    await authorizeTicket(first.app, inspectTicket.id);
    const run = await first.app.request("/api/mission/run", { method: "POST" });
    assert.equal(run.status, 200);
    const before = await json(run);

    const second = testApp(new JsonMissionRepository(filePath));
    const after = await json(await second.app.request("/api/mission"));
    assert.equal(after.mission.mission.id, before.mission.mission.id);
    assert.equal(after.mission.mission.status, "executing");
    assert.equal(after.mission.revision, before.mission.revision);
    assert.deepEqual(after.mission.evidence, before.mission.evidence);
    assert.equal(after.mission.tickets.find((item) => item.id === inspectTicket.id).status, "done");
    assert.equal(second.runner.calls.create, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
