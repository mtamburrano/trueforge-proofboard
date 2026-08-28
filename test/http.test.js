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
  PRIMARY_VERIFICATION_COMMAND,
  TrueForgeIntegrationError,
  createMissionHttpApp,
  resolveMissionRuntimeConfig,
} from "../dist/index.js";
import { workspaceDeltaEvidenceDetails } from "./delegated-proof-fixture.js";

class TestMissionRunner {
  constructor(
    missions,
    {
      failSandbox = false,
      sandboxPreparationError = false,
      secretInspectionError = false,
      createGate,
      structuredHandoff = false,
      inspectionRepository = PRIMARY_DELIVERY_FIXTURE,
      deliveryHeadSha = "8bb22a62b3714f699204cb0d5c440fcb7f0a09e1",
      deliveryHeadPatches = PRIMARY_VERIFIED_DELIVERY_PATCHES,
    } = {},
  ) {
    this.missions = missions;
    this.failSandbox = failSandbox;
    this.sandboxPreparationError = sandboxPreparationError;
    this.secretInspectionError = secretInspectionError;
    this.createGate = createGate;
    this.structuredHandoff = structuredHandoff;
    this.inspectionRepository = inspectionRepository;
    this.deliveryHeadSha = deliveryHeadSha;
    this.deliveryHeadPatches = deliveryHeadPatches;
    this.sandboxInputs = [];
    this.preparationInputs = [];
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
    this.operationLog.push("delegate");
    this.calls.turn += 1;
    this.turnInputs.push({ instruction: _instruction, options });
    const turnId = `test-turn-${this.calls.turn}`;
    const threadId = `test-thread-${options.workItemId}`;
    const treeRef = "a".repeat(40);
    const endTreeRef = "b".repeat(40);
    await this.missions.attachTrueforgeTurn(missionId, turnId);
    if (this.structuredHandoff) {
      await this.missions.attachTrueforgeWorkspaceBaseline(missionId, treeRef);
      await this.missions.startWorkItemDelegation(missionId, options.workItemId, {
        owner: "bounded-test-implementer",
        threadId,
        turnId,
        startTreeRef: treeRef,
        missionStartTreeRef: treeRef,
      });
    }
    await this.missions.addEvidence(missionId, {
      workItemId: options.workItemId,
      kind: "tool_result",
      result: "passed",
      source: "trueforge",
      summary: "TrueForge turn finished with status done.",
      details: JSON.stringify({ event_type: "turn.done", provider_secret: "hidden" }),
    });
    let implementationHandoff;
    if (this.structuredHandoff) {
      const origin = {
        kind: "trueforge",
        sessionId: "test-session-durable",
        turnId,
        threadId,
      };
      const typecheck = await this.missions.addEvidence(missionId, {
        workItemId: options.workItemId,
        kind: "typecheck_result",
        result: "passed",
        source: "trueforge",
        summary: "Delegated typecheck passed.",
        executionOrigin: { ...origin, toolCallId: `call-typecheck-${this.calls.turn}` },
      });
      const tests = await this.missions.addEvidence(missionId, {
        workItemId: options.workItemId,
        kind: "test_result",
        result: "passed",
        source: "trueforge",
        summary: "Delegated tests passed.",
        executionOrigin: { ...origin, toolCallId: `call-test-${this.calls.turn}` },
      });
      const diff = await this.missions.addEvidence(missionId, {
        workItemId: options.workItemId,
        kind: "diff_summary",
        result: "passed",
        source: "trueforge",
        summary: "Delegated content diff captured.",
        details: JSON.stringify({
          command: "git diff",
          output: "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1,2 @@\n before\n+after",
        }),
        executionOrigin: { ...origin, toolCallId: `call-diff-${this.calls.turn}` },
      });
      const manifest = await this.missions.addEvidence(missionId, {
        workItemId: options.workItemId,
        kind: "file_change",
        result: "passed",
        source: "trueforge",
        summary: "Delegated complete changed-file manifest captured.",
        details: workspaceDeltaEvidenceDetails({
          startTreeRef: treeRef,
          missionStartTreeRef: treeRef,
          endTreeRef,
          currentFiles: ["src/index.ts"],
          cumulativeFiles: ["src/index.ts"],
        }),
        executionOrigin: {
          kind: "trueforge",
          sessionId: "test-session-durable",
          turnId: `test-proof-delta-${this.calls.turn}`,
          threadId: "main",
          toolCallId: `call-manifest-${this.calls.turn}`,
        },
      });
      await this.missions.completeWorkItemDelegation(missionId, options.workItemId, {
        threadId,
        turnId,
      });
      implementationHandoff = {
        filesChanged: ["src/index.ts"],
        diffSummary: "src/index.ts changed.",
        checks: [
          {
            name: "typecheck",
            command: "npm run typecheck",
            result: "passed",
            required: true,
            evidenceIds: [typecheck.id],
            exitCode: 0,
          },
          {
            name: "test",
            command: "npm test",
            result: "passed",
            required: true,
            evidenceIds: [tests.id],
            exitCode: 0,
          },
        ],
        evidenceIds: [typecheck.id, tests.id, manifest.id, diff.id],
        decisions: [],
        openQuestions: [],
        executionOrigin: origin,
      };
    }
    return {
      sessionId: "test-session-durable",
      turnId,
      events: [],
      mission: await this.missions.getMission(missionId),
      ...(implementationHandoff === undefined ? {} : { implementationHandoff }),
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

  async prepareSandbox(input) {
    this.operationLog.push("prepare-sandbox");
    this.preparationInputs.push(input);
    if (this.sandboxPreparationError) {
      await this.missions.addEvidence(input.missionId, {
        kind: "tool_result",
        result: "failed",
        source: "sandbox",
        summary: "Sandbox toolchain readiness failed; coding delegation did not start.",
        details: JSON.stringify({
          command: "sandbox toolchain readiness",
          reason: "Node.js >=20 and npm are required before coding delegation.",
        }),
      });
      throw new TrueForgeIntegrationError(
        "prepare sandbox",
        "Sandbox toolchain readiness failed: Node.js >=20 and npm are required before coding delegation.",
      );
    }
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

test("run mission uses the runtime adapters and exposes passed proof", async () => {
  const { app, runner } = testApp();

  const response = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(response.status, 200);
  const payload = await json(response);
  assert.equal(payload.mission.mission.status, "awaiting_approval");
  assert.equal(payload.mission.progress.complete, 4);
  assert.equal(payload.mission.progress.execution, "passed");
  assert.equal(payload.mission.progress.verification, "passed");
  assert.deepEqual(payload.mission.evidence.map((item) => item.source).sort(), ["mcp", "mcp", "sandbox"]);
  assert.equal(payload.mission.approvals.length, 1);
  assert.equal(payload.mission.approvals[0].actionType, "create_pull_request");
  assert.equal(
    payload.mission.approvals[0].target,
    "mtamburrano/proofboard-demo-fixture base=main head=proofboard-verified-delivery@8bb22a62b3714f699204cb0d5c440fcb7f0a09e1",
  );
  assert.match(payload.mission.approvals[0].expectedEffect, /proofboard-demo-fixture/);
  assert.match(payload.mission.approvals[0].rationale, /human/);
  assert.equal(payload.mission.approvals[0].evidenceIds.length > 0, true);
  assert.equal(payload.mission.approvals[0].executionContext.sessionId, "test-session-durable");
  assert.equal(payload.mission.approvals[0].executionContext.toolCallId, "test-create-pull-request-call");
  assert.equal(payload.mission.approvals[0].executionContext.headSha, "8bb22a62b3714f699204cb0d5c440fcb7f0a09e1");
  assert.notEqual(
    payload.mission.approvals[0].executionContext.headSha,
    PRIMARY_DELIVERY_FIXTURE.baselineSha,
  );
  assert.equal(runner.deliveryCalls.requested.length, 1);
  assert.equal(runner.deliveryCalls.protectedOperations, 0);
  assert.deepEqual(runner.preparationInputs, [{ missionId: PRIMARY_MISSION_ID }]);
  assert.deepEqual(runner.operationLog.slice(0, 4), [
    "inspect",
    "prepare-sandbox",
    "delegate",
    "delegate",
  ]);
  assert.deepEqual(runner.calls, { create: 1, inspect: 1, headInspect: 1, turn: 2, sandbox: 1 });
  assert.deepEqual(
    runner.turnInputs.map((input) => input.options.workItemId),
    ["primary-implement-1-src-index-ts", "primary-implement-2-test-index-test-js"],
  );
  assert.match(runner.turnInputs[0].instruction, /src\/index\.ts/);
  assert.match(
    runner.turnInputs[0].instruction,
    /Changes for this work item remain limited to src\/index\.ts/,
  );
  assert.match(runner.turnInputs[0].instruction, /Allowed files for this work item: src\/index\.ts/);
  assert.match(runner.turnInputs[1].instruction, /test\/index\.test\.js/);
  assert.match(
    runner.turnInputs[1].instruction,
    /Changes for this work item remain limited to test\/index\.test\.js/,
  );
  assert.match(runner.turnInputs[1].instruction, /Allowed files for this work item: test\/index\.test\.js/);
  assert.equal(runner.sandboxInputs[0].command, PRIMARY_VERIFICATION_COMMAND);
  assert.match(runner.sandboxInputs[0].command, /node --input-type=module -e/);
  assert.match(runner.sandboxInputs[0].command, /--loader/);
  assert.match(runner.sandboxInputs[0].command, /--test\", \"test\/index\.test\.js/);
  assert.match(runner.sandboxInputs[0].command, /getNextDeliveryStage/);

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /must-not-reach-browser|provider_secret/);
});

test("unrelated repository evidence cannot authorize the configured delivery target", async () => {
  const { app, runner } = testApp(new InMemoryMissionRepository(), {
    inspectionRepository: {
      owner: "mtamburrano",
      repository: "trueforge-proofboard",
      baselineRef: PRIMARY_DELIVERY_FIXTURE.baselineRef,
      baselineSha: PRIMARY_DELIVERY_FIXTURE.baselineSha,
    },
  });

  const response = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(response.status, 502);
  const payload = await json(response);
  assert.equal(payload.mission.mission.status, "blocked");
  assert.equal(payload.mission.approvals.length, 0);
  assert.equal(runner.deliveryCalls.requested.length, 0);
  assert.equal(runner.deliveryCalls.protectedOperations, 0);
});

test("an unchanged baseline head cannot authorize delivery", async () => {
  const { app, runner } = testApp(new InMemoryMissionRepository(), {
    deliveryHeadSha: PRIMARY_DELIVERY_FIXTURE.baselineSha,
  });

  const response = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(response.status, 502);
  const payload = await json(response);
  assert.equal(payload.mission.approvals.length, 0);
  assert.equal(runner.calls.headInspect, 1);
  assert.equal(runner.deliveryCalls.requested.length, 0);
});

test("a delivery head whose diff differs from verified work cannot authorize delivery", async () => {
  const { app, runner } = testApp(new InMemoryMissionRepository(), {
    deliveryHeadPatches: {
      ...PRIMARY_VERIFIED_DELIVERY_PATCHES,
      "src/index.ts": `${PRIMARY_VERIFIED_DELIVERY_PATCHES["src/index.ts"]}\n+unverified change`,
    },
  });

  const response = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(response.status, 502);
  const payload = await json(response);
  assert.equal(payload.mission.approvals.length, 0);
  assert.equal(runner.calls.headInspect, 1);
  assert.equal(runner.deliveryCalls.requested.length, 0);
});

test("a persisted approval cannot outlive the repository provenance that authorized it", async () => {
  const initial = testApp();
  const run = await json(await initial.app.request("/api/mission/run", { method: "POST" }));
  const approval = run.mission.approvals[0];
  const staleState = await initial.missions.getState();
  const repositoryProof = staleState.evidence.find((item) => item.source === "mcp");
  const details = JSON.parse(repositoryProof.details);
  details.repository_name = "unrelated-repository";
  details.arguments.repo = "unrelated-repository";
  repositoryProof.details = JSON.stringify(details);

  const recovered = testApp(new InMemoryMissionRepository(staleState));
  const response = await recovered.app.request(`/api/mission/approvals/${approval.id}`, {
    method: "POST",
    body: JSON.stringify({ decision: "approved" }),
  });
  assert.equal(response.status, 502);
  const payload = await json(response);
  assert.equal(payload.mission.approvals[0].decision, "pending");
  assert.equal(payload.mission.delivery.length, 0);
  assert.equal(recovered.runner.deliveryCalls.protectedOperations, 0);
});

test("rejecting or cancelling the exact pending delivery invokes no protected operation", async () => {
  for (const decision of ["rejected", "cancelled"]) {
    const { app, runner } = testApp();
    const run = await json(await app.request("/api/mission/run", { method: "POST" }));
    const approval = run.mission.approvals[0];

    const response = await app.request(`/api/mission/approvals/${approval.id}`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
    assert.equal(response.status, 200);
    const payload = await json(response);
    assert.equal(payload.mission.mission.status, "blocked");
    assert.equal(payload.mission.approvals[0].decision, decision);
    assert.equal(payload.mission.delivery.length, 0);
    assert.equal(runner.deliveryCalls.protectedOperations, 0);
    assert.equal(runner.deliveryCalls.resolved.length, 1);
    assert.equal(runner.deliveryCalls.resolved[0].decision, decision);
    assert.equal(
      runner.deliveryCalls.resolved[0].pending.toolCallId,
      "test-create-pull-request-call",
    );

    const recovered = await json(await app.request("/api/mission"));
    assert.equal(recovered.mission.approvals[0].decision, decision);
    assert.equal(recovered.mission.delivery.length, 0);
  }
});

test("approving the exact pending delivery records one correlated pull request result", async () => {
  const { app, missions, runner } = testApp();
  const run = await json(await app.request("/api/mission/run", { method: "POST" }));
  const approval = run.mission.approvals[0];

  const response = await app.request(`/api/mission/approvals/${approval.id}`, {
    method: "POST",
    body: JSON.stringify({ decision: "approved" }),
  });
  assert.equal(response.status, 200);
  const payload = await json(response);
  assert.equal(payload.mission.mission.status, "delivered");
  assert.equal(payload.mission.approvals[0].decision, "approved");
  assert.equal(payload.mission.delivery.length, 1);
  assert.equal(payload.mission.delivery[0].reference, "https://github.com/mtamburrano/proofboard-demo-fixture/pull/73");
  assert.deepEqual(payload.mission.delivery[0].pullRequest, {
    number: 73,
    url: "https://github.com/mtamburrano/proofboard-demo-fixture/pull/73",
    repositoryOwner: "mtamburrano",
    repositoryName: "proofboard-demo-fixture",
    base: "main",
    head: "proofboard-verified-delivery",
    headSha: "8bb22a62b3714f699204cb0d5c440fcb7f0a09e1",
  });
  assert.equal(payload.mission.delivery[0].executionOrigin.sessionId, "test-session-durable");
  assert.equal(payload.mission.delivery[0].executionOrigin.turnId, "test-delivery-result-turn");
  assert.equal(payload.mission.delivery[0].executionOrigin.toolCallId, "test-create-pull-request-call");
  assert.equal(runner.deliveryCalls.protectedOperations, 1);
  assert.equal(runner.deliveryCalls.resolved.length, 1);

  const state = await missions.getState();
  const deliveryEvidence = state.evidence.find((item) =>
    item.summary.includes("created pull request #73")
  );
  assert.equal(deliveryEvidence.result, "passed");
  assert.equal(deliveryEvidence.executionOrigin.sessionId, "test-session-durable");
  assert.equal(deliveryEvidence.executionOrigin.turnId, "test-delivery-result-turn");
  assert.equal(deliveryEvidence.executionOrigin.toolCallId, "test-create-pull-request-call");
  assert.equal(state.deliveries[0].approvalId, approval.id);

  const replay = await app.request(`/api/mission/approvals/${approval.id}`, {
    method: "POST",
    body: JSON.stringify({ decision: "approved" }),
  });
  assert.equal(replay.status, 400);
  assert.equal(runner.deliveryCalls.protectedOperations, 1);
});

test("a moved delivery head leaves the approval pending and invokes no protected operation", async () => {
  const { app, runner } = testApp();
  const run = await json(await app.request("/api/mission/run", { method: "POST" }));
  const approval = run.mission.approvals[0];
  runner.deliveryHeadSha = "9cc33b73c4825f7aa5d3b1ce6c5510fc8e1b20f2";

  const response = await app.request(`/api/mission/approvals/${approval.id}`, {
    method: "POST",
    body: JSON.stringify({ decision: "approved" }),
  });
  assert.equal(response.status, 502);
  const payload = await json(response);
  assert.equal(payload.mission.approvals[0].decision, "pending");
  assert.equal(payload.mission.delivery.length, 0);
  assert.equal(runner.deliveryCalls.protectedOperations, 0);
  assert.equal(runner.deliveryCalls.resolved.length, 0);
  assert.equal(runner.calls.headInspect, 2);
});

test("failed sandbox proof remains visibly failed and blocks the mission", async () => {
  const { app } = testApp(new InMemoryMissionRepository(), { failSandbox: true });

  const response = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(response.status, 502);
  const payload = await json(response);
  assert.equal(payload.mission.mission.status, "blocked");
  assert.equal(payload.mission.progress.execution, "passed");
  assert.equal(payload.mission.progress.verification, "failed");
  const sandbox = payload.mission.evidence.find((item) => item.source === "sandbox");
  assert.equal(sandbox.result, "failed");
  assert.equal(sandbox.metadata.exitCode, 1);
  assert.equal(payload.mission.evidence.some(
    (item) => item.source === "sandbox" && item.result === "passed",
  ), false);
});

test("sandbox readiness failure blocks before delegation and stays distinct from verification", async () => {
  const { app, runner } = testApp(new InMemoryMissionRepository(), {
    sandboxPreparationError: true,
  });

  const response = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(response.status, 502);
  const payload = await json(response);
  assert.equal(payload.mission.mission.status, "blocked");
  assert.equal(payload.mission.progress.execution, "failed");
  assert.equal(payload.mission.progress.verification, "not_started");
  assert.match(payload.message, /Node\.js >=20 and npm are required/);
  assert.equal(runner.turnInputs.length, 0);
  assert.deepEqual(runner.operationLog, ["inspect", "prepare-sandbox"]);
  assert.equal(
    payload.mission.evidence.some((item) =>
      item.source === "sandbox" && item.result === "failed" &&
      /toolchain readiness failed/.test(item.summary)
    ),
    true,
  );
});

test("a readiness retry preserves history and reaches coding without a stale execution failure", async () => {
  const { app, runner } = testApp(new InMemoryMissionRepository(), {
    sandboxPreparationError: true,
  });

  const failed = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(failed.status, 502);
  runner.sandboxPreparationError = false;

  const retried = await json(await app.request("/api/mission/run", { method: "POST" }));
  assert.equal(retried.mission.mission.status, "awaiting_approval");
  assert.equal(retried.mission.progress.execution, "passed");
  assert.equal(retried.mission.progress.verification, "passed");
  assert.equal(retried.mission.progress.failedEvidence, 1);
  assert.equal(runner.turnInputs.length, 2);
  assert.equal(runner.preparationInputs.length, 2);
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
  const retried = await json(retryResponse);
  assert.equal(retryResponse.status, 200, JSON.stringify(retried));
  assert.equal(retried.mission.mission.status, "awaiting_approval");
  assert.equal(retried.mission.progress.verification, "passed");
  assert.equal(retried.mission.progress.failedEvidence, 1);
  assert.deepEqual(
    retried.mission.evidence
      .filter((item) => item.source === "sandbox")
      .map((item) => item.result)
      .sort(),
    ["failed", "passed"],
  );
  assert.deepEqual(runner.calls, { create: 1, inspect: 1, headInspect: 1, turn: 2, sandbox: 2 });
});

test("the primary controller persists every injected verifier outcome with review history", async () => {
  const planner = {
    plan() {
      return {
        items: [
          {
            id: "primary-inspect",
            title: "Inspect the verified repository",
            purpose: "Establish the repository facts required for bounded implementation.",
            acceptanceCriteria: ["The repository inspection is correlated and persisted."],
            dependsOn: [],
            assignedRole: "planner",
          },
          {
            id: "controller-implement",
            title: "Implement the bounded source change",
            purpose: "Apply the requested change only to src/index.ts.",
            acceptanceCriteria: ["The source change satisfies the requested behavior."],
            dependsOn: ["primary-inspect"],
            assignedRole: "implementer",
            requiredChecks: ["typecheck", "test"],
            allowedFiles: ["src/index.ts"],
          },
          {
            id: "controller-verify",
            title: "Verify the bounded source change",
            purpose: "Run independent verification after implementation review.",
            acceptanceCriteria: ["The independent verification passes."],
            dependsOn: ["controller-implement"],
            assignedRole: "reviewer",
          },
        ],
      };
    },
  };
  const decisions = [
    { outcome: "accepted", expectedStatus: "complete" },
    { outcome: "changes_requested", expectedStatus: "ready" },
    { outcome: "blocked", expectedStatus: "blocked" },
  ];

  for (const scenario of decisions) {
    const contexts = [];
    const verifier = {
      review(context) {
        contexts.push(context);
        return {
          outcome: scenario.outcome,
          reviewer: "injected-independent-verifier",
          summary: `Injected verifier returned ${scenario.outcome}.`,
          finding: `Durable ${scenario.outcome} finding.`,
        };
      },
    };
    const { app, missions } = testApp(new InMemoryMissionRepository(), {
      planner,
      verifier,
      structuredHandoff: true,
    });

    const response = await app.request("/api/mission/run", { method: "POST" });
    assert.equal(response.status === 200, scenario.outcome === "accepted");
    const state = await missions.getState();
    const implementation = state.workItems.find((item) => item.id === "controller-implement");
    assert.equal(implementation.status, scenario.expectedStatus);
    assert.equal(contexts.length, 1);
    assert.deepEqual(contexts[0].actualFilesChanged, ["src/index.ts"]);
    assert.equal(state.reviews.length, 1);
    assert.equal(state.reviews[0].outcome, scenario.outcome);
    assert.equal(state.handoffs.length, 1);
    assert.equal(state.handoffs[0].result, "done");
    assert.equal(
      state.evidence.some((item) => item.id === state.reviews[0].findingEvidenceId),
      true,
    );
  }
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
    assert.equal(after.mission.mission.status, "awaiting_approval");
    assert.equal(after.mission.revision, before.mission.revision);
    assert.deepEqual(after.mission.evidence, before.mission.evidence);
    assert.equal(second.runner.calls.create, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
