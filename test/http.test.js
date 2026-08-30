import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request as nodeHttpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  InMemoryMissionRepository,
  DEFAULT_TRUEFORGE_MODEL,
  JsonMissionRepository,
  MissionService,
  PRIMARY_DELIVERY_FIXTURE,
  PRIMARY_VERIFIED_DELIVERY_ARTIFACT,
  PRIMARY_VERIFIED_DELIVERY_FILES,
  PRIMARY_VERIFIED_DELIVERY_PATCHES,
  PRIMARY_MISSION_ID,
  PRIMARY_MISSION_OBJECTIVE,
  PRIMARY_SANDBOX_REPOSITORY_ROOT,
  PRIMARY_VERIFICATION_COMMAND,
  IMPLEMENTATION_PROOF_MODE,
  TrueForgeIntegrationError,
  createMissionHttpApp,
  createMissionNodeServer,
  resolveMissionRuntimeConfig,
} from "../dist/index.js";

class TestMissionRunner {
  constructor(
    missions,
    {
      failSandbox = false,
      sandboxInfrastructureFailure = false,
      secretInspectionError = false,
      createGate,
      reconciliationResult = "found",
      inspectionRepository = PRIMARY_DELIVERY_FIXTURE,
      deliveryHeadSha = "8bb22a62b3714f699204cb0d5c440fcb7f0a09e1",
      deliveryHeadPatches = PRIMARY_VERIFIED_DELIVERY_PATCHES,
      proofMode = IMPLEMENTATION_PROOF_MODE,
    } = {},
  ) {
    this.missions = missions;
    this.failSandbox = failSandbox;
    this.sandboxInfrastructureFailure = sandboxInfrastructureFailure;
    this.secretInspectionError = secretInspectionError;
    this.createGate = createGate;
    this.reconciliationResult = reconciliationResult;
    this.inspectionRepository = inspectionRepository;
    this.deliveryHeadSha = deliveryHeadSha;
    this.deliveryHeadPatches = deliveryHeadPatches;
    this.proofMode = proofMode;
    this.sandboxInputs = [];
    this.operationLog = [];
    this.turnInputs = [];
    this.deliveryCalls = { requested: [], resolved: [], reconciled: [], protectedOperations: 0, lifecycle: [] };
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
      workItemId: input.workItemId,
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
    if (options.workItemId !== undefined) {
      await this.missions.attachWorkItemExecution(missionId, options.workItemId, {
        trueforgeSessionId: "test-session-durable",
        trueforgeSandboxId: "test-sandbox-durable",
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
    if (this.failSandbox || this.sandboxInfrastructureFailure) {
      await this.missions.addEvidence(input.missionId, {
        workItemId: input.workItemId,
        kind: "test_result",
        result: "failed",
        source: "sandbox",
        summary: "Independent final-state proof failed.",
        details: JSON.stringify({
          command: PRIMARY_VERIFICATION_COMMAND,
          exit_code: 1,
          ...(this.sandboxInfrastructureFailure
            ? {
                proof_mode: IMPLEMENTATION_PROOF_MODE,
                phase: "deterministic-proof",
                failure_class: "infrastructure",
                failure_reason_category: "network",
                retryable: true,
              }
            : {}),
        }),
      });
      throw new TrueForgeIntegrationError(
        "prove implementation",
        "Independent authoritative test exited with code 1.",
        this.sandboxInfrastructureFailure
          ? {
              failureClass: "infrastructure",
              failureCategory: "network",
              retryable: true,
            }
          : undefined,
      );
    }
    const workItem = await this.missions.getWorkItem(input.missionId, input.workItemId);
    const filesChanged = workItem.allowedFiles ?? [];
    const isPrimaryArtifact = filesChanged.length === Object.keys(PRIMARY_VERIFIED_DELIVERY_FILES).length &&
      filesChanged.every((file) => Object.prototype.hasOwnProperty.call(PRIMARY_VERIFIED_DELIVERY_FILES, file));
    const diffOutput = isPrimaryArtifact
      ? Object.entries(PRIMARY_VERIFIED_DELIVERY_PATCHES).map(([file, patch]) =>
          `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${patch}`
        ).join("\n")
      : filesChanged.map((file) =>
          `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1,2 @@\n before\n+after`
        ).join("\n");
    const diff = await this.missions.addEvidence(input.missionId, {
      workItemId: input.workItemId,
      kind: "diff_summary",
      result: "passed",
      source: "sandbox",
      summary: "Independent proof captured the actual final diff.",
      details: JSON.stringify({
        proof_mode: this.proofMode,
        command: "git diff",
        output: diffOutput,
        changed_files: filesChanged,
        ...(isPrimaryArtifact
          ? {
              provenance_kind: "implementation_artifact",
              artifact_hash: PRIMARY_VERIFIED_DELIVERY_ARTIFACT.contentHash,
              delivery_artifact: PRIMARY_VERIFIED_DELIVERY_ARTIFACT,
            }
          : {}),
      }),
      executionOrigin: origin,
    });
    const typecheck = await this.missions.addEvidence(input.missionId, {
      workItemId: input.workItemId,
      kind: "typecheck_result",
      result: "passed",
      source: "sandbox",
      summary: "Independent typecheck passed.",
      details: JSON.stringify({
        proof_mode: this.proofMode,
        command: "npm run typecheck",
        exit_code: 0,
        output: "typecheck passed",
      }),
      executionOrigin: origin,
    });
    const tests = await this.missions.addEvidence(input.missionId, {
      workItemId: input.workItemId,
      kind: "test_result",
      result: "passed",
      source: "sandbox",
      summary: "Independent tests passed.",
      details: JSON.stringify({
        proof_mode: this.proofMode,
        command: PRIMARY_VERIFICATION_COMMAND,
        exit_code: 0,
        output: "all tests passed",
      }),
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
      ...(isPrimaryArtifact ? { deliveryArtifact: PRIMARY_VERIFIED_DELIVERY_ARTIFACT } : {}),
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
    const artifactDelivery = target.artifact !== undefined;
    return {
      sessionId: "test-session-durable",
      turnId: "test-delivery-approval-turn",
      threadId: "test-delivery-thread",
      toolCallId: artifactDelivery ? "test-push-files-call" : "test-create-pull-request-call",
      serverName: "github",
      toolName: artifactDelivery ? "push_files" : "create_pull_request",
      target: { ...target },
    };
  }

  async resolvePullRequestApproval(missionId, pending, decision, workItemId) {
    this.deliveryCalls.resolved.push({ missionId, pending, decision, workItemId });
    if (decision !== "approved") {
      return null;
    }
    this.deliveryCalls.protectedOperations += 1;
    const lifecycleState = await this.missions.getState();
    const implementation = lifecycleState.workItems.find((item) => item.assignedRole === "implementer");
    this.deliveryCalls.lifecycle.push({
      missionStatus: lifecycleState.missions.find((item) => item.id === missionId)?.status,
      workItemStatus: implementation?.status,
    });
    const result = {
      number: 73,
      url: "https://github.com/mtamburrano/proofboard-demo-fixture/pull/73",
      headSha: pending.target.artifact === undefined
        ? pending.target.headSha
        : this.deliveryHeadSha,
      sessionId: pending.sessionId,
      turnId: "test-delivery-result-turn",
      threadId: pending.threadId,
      toolCallId: pending.toolCallId,
    };
    if (pending.target.artifact !== undefined) {
      await this.recordPublishedArtifactReadback(missionId, pending, workItemId);
    }
    await this.missions.addEvidence(missionId, {
      ...(workItemId === undefined ? {} : { workItemId }),
      kind: "tool_result",
      result: "passed",
      source: "mcp",
      summary: "MCP verified pull request #73 after creation.",
      details: JSON.stringify({
        server: "github",
        tool: "pull_request_read",
        repository_owner: "mtamburrano",
        repository_name: "proofboard-demo-fixture",
        base: "main",
        head: "proofboard-verified-delivery",
        head_sha: result.headSha,
        pull_request_number: result.number,
        pull_request_url: result.url,
      }),
      executionOrigin: {
        kind: "mcp",
        sessionId: result.sessionId,
        turnId: result.turnId,
        threadId: result.threadId,
        toolCallId: "test-pull-request-read-call",
      },
    });
    return result;
  }

  async reconcilePullRequestApproval(missionId, pending, workItemId, knownPullRequest) {
    this.deliveryCalls.reconciled.push({ missionId, pending, workItemId, knownPullRequest });
    if (this.reconciliationResult === null) {
      return null;
    }
    if (pending.target.artifact !== undefined) {
      await this.recordPublishedArtifactReadback(missionId, pending, workItemId);
    }
    return {
      number: 73,
      url: "https://github.com/mtamburrano/proofboard-demo-fixture/pull/73",
      headSha: pending.target.artifact === undefined
        ? pending.target.headSha
        : this.deliveryHeadSha,
      sessionId: pending.sessionId,
      turnId: "test-reconciliation-turn",
      threadId: pending.threadId,
      toolCallId: pending.toolCallId,
    };
  }

  async recordPublishedArtifactReadback(missionId, pending, workItemId) {
    const artifact = pending.target.artifact;
    if (artifact === undefined) {
      return;
    }
    await this.missions.addEvidence(missionId, {
      ...(workItemId === undefined ? {} : { workItemId }),
      kind: "tool_result",
      result: "passed",
      source: "mcp",
      summary: `MCP verified published artifact at ${this.deliveryHeadSha}.`,
      details: JSON.stringify({
        server: "github",
        tool: "get_commit",
        provenance_kind: "delivery_head",
        arguments: {
          owner: pending.target.owner,
          repo: pending.target.repo,
          sha: pending.target.head,
          detail: "full_patch",
          perPage: 100,
        },
        repository_owner: pending.target.owner,
        repository_name: pending.target.repo,
        requested_ref: pending.target.head,
        baseline_sha: artifact.baselineSha,
        uri: `repo://${pending.target.owner}/${pending.target.repo}/sha/${this.deliveryHeadSha}`,
        commit_sha: this.deliveryHeadSha,
        patches: artifact.patches,
        artifact_hash: artifact.contentHash,
        content_hash: "verified-published-artifact-content-hash",
      }),
      executionOrigin: {
        kind: "mcp",
        sessionId: pending.sessionId,
        turnId: "test-delivery-head-turn",
      },
    });
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

async function listenOnIsolatedSocket(server) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-node-http-"));
  const socketPath = path.join(directory, "mission.sock");
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    socketPath,
    async close() {
      await closeNodeServer(server);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function closeNodeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

function requestOverSocket(socketPath, { requestPath, method = "GET", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = nodeHttpRequest({
      socketPath,
      path: requestPath,
      method,
      agent: false,
      headers: { connection: "close", ...headers },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

function socketJson(response) {
  assert.equal(response.headers["cache-control"], "no-store");
  return JSON.parse(response.body);
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

async function reachDeliveryApproval(app) {
  await app.request("/api/mission", { method: "POST" });
  let current = await json(await app.request("/api/mission"));
  const inspectTicket = current.mission.tickets.find((item) => item.assignedRole === "planner");
  await authorizeTicket(app, inspectTicket.id);
  const inspected = await json(await app.request("/api/mission/run", { method: "POST" }));
  const implementTicket = inspected.mission.tickets.find((item) => item.assignedRole === "implementer");
  await authorizeTicket(app, implementTicket.id);
  await app.request("/api/mission/run", { method: "POST" });
  const provedResponse = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(provedResponse.status, 200);
  const proved = await json(provedResponse);
  const approval = proved.mission.approvals.find((item) => item.decision === "pending");
  assert.ok(approval, "A passed current attempt should create a pending delivery approval.");
  return { implementTicket, approval, proved };
}

async function decideDelivery(app, approval, decision, actor = "delivery-operator") {
  const current = await json(await app.request("/api/mission"));
  const response = await app.request(`/api/mission/approvals/${approval.id}`, {
    method: "POST",
    body: JSON.stringify({
      decision,
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
  assert.match(pageBody, /PROOF BOARD/);
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

test("the real Node HTTP bridge forwards browser JSON bodies and rejects malformed JSON", async () => {
  const { app } = testApp();
  await app.request("/api/mission", { method: "POST" });
  const server = createMissionNodeServer(app, {
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: ["http://mission.local"],
  });
  const isolatedServer = await listenOnIsolatedSocket(server);
  const origin = "http://mission.local";

  try {
    const initialResponse = await requestOverSocket(isolatedServer.socketPath, {
      requestPath: "/api/mission",
      headers: { host: "mission.local" },
    });
    assert.equal(initialResponse.status, 200);
    const initial = socketJson(initialResponse);
    const hostileResponse = await requestOverSocket(isolatedServer.socketPath, {
      requestPath: "/api/mission",
      method: "POST",
      headers: {
        host: "attacker.example",
        origin: "http://attacker.example",
      },
    });
    assert.equal(hostileResponse.status, 400);
    assert.equal(socketJson(hostileResponse).error, "invalid_host");
    assert.equal((await json(await app.request("/api/mission"))).mission.mission.status, "draft");
    const ignoredBody = "{}";
    const bodylessGetResponse = await requestOverSocket(isolatedServer.socketPath, {
      requestPath: "/api/mission",
      headers: {
        host: "mission.local",
        "content-length": String(Buffer.byteLength(ignoredBody)),
      },
      body: ignoredBody,
    });
    assert.equal(bodylessGetResponse.status, 200);
    const bodylessHeadResponse = await requestOverSocket(isolatedServer.socketPath, {
      requestPath: "/api/mission",
      method: "HEAD",
      headers: {
        host: "mission.local",
        "content-length": String(Buffer.byteLength(ignoredBody)),
      },
      body: ignoredBody,
    });
    assert.equal(bodylessHeadResponse.status, 404);
    const ticket = initial.mission.tickets.find((item) => item.status === "backlog");
    assert.ok(ticket, "The local fixture should expose a Backlog ticket.");

    const requestPath = `/api/mission/tickets/${encodeURIComponent(ticket.id)}/status`;
    const transitionBody = JSON.stringify({
      status: "ready",
      actor: "browser-operator",
      expected_revision: initial.mission.revision,
    });
    const transitionResponse = await requestOverSocket(isolatedServer.socketPath, {
      requestPath,
      method: "PATCH",
      headers: {
        host: "mission.local",
        "content-type": "application/json",
        origin,
        "content-length": String(Buffer.byteLength(transitionBody)),
      },
      body: transitionBody,
    });
    assert.equal(transitionResponse.status, 200);
    const transitioned = socketJson(transitionResponse);
    assert.equal(transitioned.ticket.id, ticket.id);
    assert.equal(transitioned.ticket.status, "ready");
    assert.equal(transitioned.ticket.executionAuthorization.authorizedBy, "browser-operator");

    const malformedBody = "{\"status\":\"backlog\"";
    const malformedResponse = await requestOverSocket(isolatedServer.socketPath, {
      requestPath,
      method: "PATCH",
      headers: {
        host: "mission.local",
        "content-type": "application/json",
        origin,
        "content-length": String(Buffer.byteLength(malformedBody)),
      },
      body: malformedBody,
    });
    assert.equal(malformedResponse.status, 400);
    const malformed = socketJson(malformedResponse);
    assert.match(malformed.message, /valid JSON/);

    const afterMalformed = await json(await app.request("/api/mission"));
    const persistedTicket = afterMalformed.mission.tickets.find((item) => item.id === ticket.id);
    assert.equal(persistedTicket.status, "ready");
    assert.equal(persistedTicket.executionAuthorization.authorizedBy, "browser-operator");
  } finally {
    await isolatedServer.close();
  }
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
  assert.equal(payload.mission.activity.find((item) => item.category === "repository").actor, "GitHub MCP read");
  assert.equal(payload.mission.activity.find((item) => item.category === "sandbox").actor, "Proof Board verification · Daytona sandbox");
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

test("run mission performs deterministic proof and independent review after coding", async () => {
  const { app, runner, missions } = testApp();

  await app.request("/api/mission", { method: "POST" });
  let current = await json(await app.request("/api/mission"));
  const inspectTicket = current.mission.tickets.find((item) => item.assignedRole === "planner");
  await authorizeTicket(app, inspectTicket.id);
  await app.request("/api/mission/run", { method: "POST" });

  current = await json(await app.request("/api/mission"));
  const implementTicket = current.mission.tickets.find((item) => item.assignedRole === "implementer");
  await authorizeTicket(app, implementTicket.id);
  await app.request("/api/mission/run", { method: "POST" });

  const proofResponse = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(proofResponse.status, 200);
  const proved = await json(proofResponse);
  const provedTicket = proved.mission.tickets.find((item) => item.id === implementTicket.id);
  assert.equal(provedTicket.status, "awaiting_approval");
  assert.equal(provedTicket.attempts[0].status, "awaiting_approval");
  assert.equal(provedTicket.claim.trueforgeSessionId, "test-session-durable");
  assert.equal(provedTicket.claim.trueforgeSandboxId, "test-sandbox-durable");
  assert.equal(proved.mission.mission.status, "awaiting_approval");
  assert.equal(proved.mission.approvals.length, 1);
  assert.equal(proved.mission.approvals[0].workItemId, implementTicket.id);
  assert.equal(proved.mission.approvals[0].attempt, 1);
  assert.deepEqual(runner.operationLog, ["inspect", "execute", "prove"]);
  assert.equal(runner.calls.sandbox, 1);
  assert.equal(runner.calls.headInspect, 0);

  const state = await missions.getState();
  assert.equal(state.handoffs.length, 1);
  assert.equal(state.handoffs[0].attempt, 1);
  assert.equal(state.reviews.length, 1);
  assert.equal(state.reviews[0].outcome, "accepted");
  assert.equal(state.reviews[0].attempt, 1);
  assert.equal(state.evidence.some((item) =>
    item.workItemId === implementTicket.id && item.source === "sandbox" && item.attempt === 1
  ), true);
});

test("proof infrastructure failure retries Proving without another coding turn", async () => {
  const { app, runner, missions } = testApp(new InMemoryMissionRepository(), {
    sandboxInfrastructureFailure: true,
  });

  await app.request("/api/mission", { method: "POST" });
  let current = await json(await app.request("/api/mission"));
  const inspectTicket = current.mission.tickets.find((item) => item.assignedRole === "planner");
  await authorizeTicket(app, inspectTicket.id);
  await app.request("/api/mission/run", { method: "POST" });

  current = await json(await app.request("/api/mission"));
  const implementTicket = current.mission.tickets.find((item) => item.assignedRole === "implementer");
  await authorizeTicket(app, implementTicket.id);
  await app.request("/api/mission/run", { method: "POST" });

  const failedProof = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(failedProof.status, 200);
  const proving = await json(failedProof);
  const provingTicket = proving.mission.tickets.find((item) => item.id === implementTicket.id);
  assert.equal(provingTicket.status, "proving");
  assert.equal(provingTicket.attempt, 1);
  assert.equal(proving.mission.approvals.length, 0);
  assert.equal(proving.mission.handoffs.length, 0);
  assert.equal(proving.mission.reviews.length, 0);
  assert.equal(runner.calls.turn, 1);
  assert.equal(runner.calls.sandbox, 1);

  const failedState = await missions.getState();
  const retryEvidence = failedState.evidence.find((item) =>
    item.workItemId === implementTicket.id &&
    item.source === "system" &&
    item.result === "failed" &&
    JSON.parse(item.details).retryable === true,
  );
  assert.ok(retryEvidence, "A retryable proof failure must be durably recorded.");
  assert.equal(JSON.parse(retryEvidence.details).failure_class, "infrastructure");

  runner.sandboxInfrastructureFailure = false;
  const recoveredProof = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(recoveredProof.status, 200);
  const recovered = await json(recoveredProof);
  const recoveredTicket = recovered.mission.tickets.find((item) => item.id === implementTicket.id);
  assert.equal(recoveredTicket.status, "awaiting_approval");
  assert.equal(recoveredTicket.attempt, 1);
  assert.equal(recoveredTicket.claim.trueforgeSessionId, "test-session-durable");
  assert.equal(recoveredTicket.claim.trueforgeSandboxId, "test-sandbox-durable");
  assert.equal(runner.calls.turn, 1);
  assert.equal(runner.calls.sandbox, 2);
  assert.equal(recovered.mission.handoffs.length, 1);
  assert.equal(recovered.mission.reviews.length, 1);
  assert.equal(recovered.mission.approvals.length, 1);
  assert.equal((await missions.getState()).evidence.some((item) => item.id === retryEvidence.id), true);
});

test("delivery approval refuses a green handoff without the direct proof marker", async () => {
  const { app, runner, missions } = testApp(new InMemoryMissionRepository(), {
    proofMode: "coordinator_turn",
  });

  await app.request("/api/mission", { method: "POST" });
  let current = await json(await app.request("/api/mission"));
  const inspectTicket = current.mission.tickets.find((item) => item.assignedRole === "planner");
  await authorizeTicket(app, inspectTicket.id);
  const inspected = await json(await app.request("/api/mission/run", { method: "POST" }));
  const implementTicket = inspected.mission.tickets.find((item) => item.assignedRole === "implementer");
  await authorizeTicket(app, implementTicket.id);
  await app.request("/api/mission/run", { method: "POST" });

  const proofResponse = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(proofResponse.status, 502);
  const failed = await json(proofResponse);
  const failedTicket = failed.mission.tickets.find((item) => item.id === implementTicket.id);
  assert.equal(failedTicket.status, "blocked");
  assert.equal(failed.mission.approvals.length, 0);
  assert.equal(runner.calls.sandbox, 1);
  assert.equal(runner.calls.headInspect, 0);
  assert.equal((await missions.getState()).missions[0].status, "blocked");
});

test("proof findings require human reauthorization and reuse the same execution binding", async () => {
  const { app, runner, missions } = testApp(new InMemoryMissionRepository(), { failSandbox: true });

  await app.request("/api/mission", { method: "POST" });
  let current = await json(await app.request("/api/mission"));
  const inspectTicket = current.mission.tickets.find((item) => item.assignedRole === "planner");
  await authorizeTicket(app, inspectTicket.id);
  await app.request("/api/mission/run", { method: "POST" });

  current = await json(await app.request("/api/mission"));
  const implementTicket = current.mission.tickets.find((item) => item.assignedRole === "implementer");
  await authorizeTicket(app, implementTicket.id);
  await app.request("/api/mission/run", { method: "POST" });

  const failedProof = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(failedProof.status, 200);
  const changesRequested = await json(failedProof);
  const failedTicket = changesRequested.mission.tickets.find((item) => item.id === implementTicket.id);
  assert.equal(failedTicket.status, "changes_requested");
  assert.equal(failedTicket.attempts[0].status, "changes_requested");
  assert.equal(failedTicket.claim.trueforgeSandboxId, "test-sandbox-durable");
  assert.match(failedTicket.requestedChanges[0], /exited with code 1/i);
  assert.equal(changesRequested.mission.handoffs.length, 0);
  assert.equal(changesRequested.mission.reviews.length, 0);

  const automaticRetry = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(automaticRetry.status, 400);
  assert.equal(runner.calls.turn, 1);
  assert.equal(runner.calls.sandbox, 1);

  await authorizeTicket(app, implementTicket.id, "repair-operator");
  runner.failSandbox = false;
  const reworkExecution = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(reworkExecution.status, 200);
  const reworkProving = await json(reworkExecution);
  const reworkTicket = reworkProving.mission.tickets.find((item) => item.id === implementTicket.id);
  assert.equal(reworkTicket.status, "proving");
  assert.equal(reworkTicket.attempt, 2);
  assert.equal(reworkTicket.attempts[0].retiredBy, "repair-operator");
  assert.equal(reworkTicket.attempts[1].claim.trueforgeSessionId, "test-session-durable");
  assert.equal(reworkTicket.attempts[1].claim.trueforgeSandboxId, "test-sandbox-durable");
  assert.match(runner.turnInputs[1].instruction, /Requested rework findings:.*exited with code 1/i);

  const reworkProof = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(reworkProof.status, 200);
  const reworkComplete = await json(reworkProof);
  const reworked = reworkComplete.mission.tickets.find((item) => item.id === implementTicket.id);
  assert.equal(reworked.status, "awaiting_approval");
  assert.equal(reworked.attempts[1].status, "awaiting_approval");
  assert.equal(reworkComplete.mission.mission.status, "awaiting_approval");
  assert.equal(reworkComplete.mission.approvals.length, 1);
  assert.equal(reworkComplete.mission.approvals[0].attempt, 2);
  assert.equal(runner.calls.sandbox, 2);
  assert.equal(runner.calls.headInspect, 0);

  const state = await missions.getState();
  assert.equal(state.handoffs.length, 1);
  assert.equal(state.handoffs[0].attempt, 2);
  assert.equal(state.reviews.length, 1);
  assert.equal(state.reviews[0].attempt, 2);
  assert.equal(state.evidence.some((item) =>
    item.workItemId === implementTicket.id && item.source === "sandbox" && item.attempt === 2
  ), true);
});

test("Changes Requested stays inert across JSON reconnect before a new authorized attempt", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-rework-reconnect-"));
  const filePath = path.join(directory, "state.json");
  let reviewCalls = 0;
  const verifier = {
    review() {
      reviewCalls += 1;
      return reviewCalls === 1
        ? {
            outcome: "changes_requested",
            reviewer: "test-reviewer",
            summary: "The first attempt needs one bounded correction.",
            finding: "The first attempt does not satisfy the measured contract.",
          }
        : {
            outcome: "accepted",
            reviewer: "test-reviewer",
            summary: "The corrected attempt satisfies the measured contract.",
            finding: "The corrected attempt is independently verified.",
          };
    },
  };

  try {
    const first = testApp(new JsonMissionRepository(filePath), { verifier });
    await first.app.request("/api/mission", { method: "POST" });
    let current = await json(await first.app.request("/api/mission"));
    const inspectTicket = current.mission.tickets.find((item) => item.assignedRole === "planner");
    await authorizeTicket(first.app, inspectTicket.id);
    const inspected = await json(await first.app.request("/api/mission/run", { method: "POST" }));
    const implementTicket = inspected.mission.tickets.find((item) => item.assignedRole === "implementer");
    await authorizeTicket(first.app, implementTicket.id);
    await first.app.request("/api/mission/run", { method: "POST" });

    const requested = await json(await first.app.request("/api/mission/run", { method: "POST" }));
    const requestedTicket = requested.mission.tickets.find((item) => item.id === implementTicket.id);
    assert.equal(requestedTicket.status, "changes_requested");
    assert.equal(requestedTicket.attempts[0].status, "changes_requested");
    assert.equal(requested.mission.reviews.length, 1);
    assert.equal(requested.mission.handoffs.length, 1);

    const restoredMissions = new MissionService(new JsonMissionRepository(filePath));
    const restoredRunner = new TestMissionRunner(restoredMissions);
    const restoredApp = createMissionHttpApp({ missions: restoredMissions, runner: restoredRunner, verifier });
    current = await json(await restoredApp.request("/api/mission"));
    const restoredTicket = current.mission.tickets.find((item) => item.id === implementTicket.id);
    assert.equal(restoredTicket.status, "changes_requested");
    assert.equal(restoredTicket.attempts[0].retiredAt, undefined);
    assert.equal(restoredTicket.claim.trueforgeSessionId, "test-session-durable");
    assert.equal(restoredTicket.claim.trueforgeSandboxId, "test-sandbox-durable");
    assert.equal(current.mission.mission.execution.resumed, true);

    const inert = await restoredApp.request("/api/mission/run", { method: "POST" });
    assert.equal(inert.status, 400);
    assert.equal(restoredRunner.calls.turn, 0);
    assert.equal(restoredRunner.calls.sandbox, 0);

    const reauthorized = await restoredApp.request(`/api/mission/tickets/${implementTicket.id}/status`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "ready",
        actor: "reconnect-operator",
        expected_revision: current.mission.revision,
      }),
    });
    assert.equal(reauthorized.status, 200);

    const reworkExecution = await json(await restoredApp.request("/api/mission/run", { method: "POST" }));
    const reworkTicket = reworkExecution.mission.tickets.find((item) => item.id === implementTicket.id);
    assert.equal(reworkTicket.status, "proving");
    assert.equal(reworkTicket.attempt, 2);
    assert.equal(reworkTicket.attempts[0].retiredBy, "reconnect-operator");
    assert.equal(reworkTicket.attempts[1].claim.trueforgeSessionId, "test-session-durable");
    assert.equal(reworkTicket.attempts[1].claim.trueforgeSandboxId, "test-sandbox-durable");
    assert.equal(restoredRunner.turnInputs[0].options.previousTurnId, "test-turn-1");

    const reworkProof = await json(await restoredApp.request("/api/mission/run", { method: "POST" }));
    const completedTicket = reworkProof.mission.tickets.find((item) => item.id === implementTicket.id);
    assert.equal(completedTicket.status, "awaiting_approval");
    assert.equal(completedTicket.attempts[1].status, "awaiting_approval");
    assert.equal(reworkProof.mission.approvals.at(-1).attempt, 2);
    assert.equal(reworkProof.mission.reviews.length, 2);
    assert.equal(reworkProof.mission.reviews.at(-1).outcome, "accepted");
    assert.equal(restoredRunner.calls.turn, 1);
    assert.equal(restoredRunner.calls.sandbox, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stale approval revision cannot overwrite a newer durable decision", async () => {
  const { app, runner, missions } = testApp();
  const { implementTicket, approval, proved } = await reachDeliveryApproval(app);
  await missions.addEvidence(PRIMARY_MISSION_ID, {
    kind: "tool_result",
    result: "informational",
    source: "system",
    summary: "A newer reconnect state was observed before the operator clicked approve.",
  });

  const response = await app.request(`/api/mission/approvals/${approval.id}`, {
    method: "POST",
    body: JSON.stringify({
      decision: "approved",
      actor: "stale-operator",
      expected_revision: proved.mission.revision,
    }),
  });
  assert.equal(response.status, 409);
  const payload = await json(response);
  assert.equal(payload.mission.approvals.find((item) => item.id === approval.id).decision, "pending");
  assert.equal(payload.mission.tickets.find((item) => item.id === implementTicket.id).status, "awaiting_approval");
  assert.equal(runner.deliveryCalls.protectedOperations, 0);
  assert.equal(runner.deliveryCalls.resolved.length, 0);
});

test("a reconnect resumes a durably completed implementation turn without replaying it", async () => {
  const repository = new InMemoryMissionRepository();
  const first = testApp(repository);
  await first.app.request("/api/mission", { method: "POST" });
  let current = await json(await first.app.request("/api/mission"));
  const inspectTicket = current.mission.tickets.find((item) => item.assignedRole === "planner");
  await authorizeTicket(first.app, inspectTicket.id);
  const inspected = await json(await first.app.request("/api/mission/run", { method: "POST" }));
  const implementTicket = inspected.mission.tickets.find((item) => item.assignedRole === "implementer");
  await authorizeTicket(first.app, implementTicket.id);
  const executed = await first.app.request("/api/mission/run", { method: "POST" });
  assert.equal(executed.status, 200);

  const snapshot = await repository.load();
  const persistedTicket = snapshot.workItems.find((item) => item.id === implementTicket.id);
  persistedTicket.status = "in_progress";
  persistedTicket.attempts.at(-1).status = "in_progress";
  await repository.save(snapshot);

  const restoredMissions = new MissionService(repository);
  const restoredRunner = new TestMissionRunner(restoredMissions);
  const restoredApp = createMissionHttpApp({ missions: restoredMissions, runner: restoredRunner });
  const resumed = await restoredApp.request("/api/mission/run", { method: "POST" });
  assert.equal(resumed.status, 200);
  const payload = await json(resumed);
  const resumedTicket = payload.mission.tickets.find((item) => item.id === implementTicket.id);
  assert.equal(resumedTicket.status, "proving");
  assert.equal(resumedTicket.attempts.length, 1);
  assert.equal(restoredRunner.calls.turn, 0);
});

test("approved delivery advances the same attempt through read-back before Done", async () => {
  const { app, runner, missions } = testApp();
  const { implementTicket, approval } = await reachDeliveryApproval(app);

  const delivered = await decideDelivery(app, approval, "approved", "release-operator");
  const ticket = delivered.mission.tickets.find((item) => item.id === implementTicket.id);
  const persistedApproval = delivered.mission.approvals.find((item) => item.id === approval.id);
  const delivery = delivered.mission.delivery[0];

  assert.equal(delivered.mission.mission.status, "delivered");
  assert.equal(ticket.status, "done");
  assert.equal(ticket.attempts[0].status, "done");
  assert.equal(persistedApproval.decision, "approved");
  assert.equal(persistedApproval.decidedBy, "release-operator");
  assert.equal(typeof persistedApproval.decidedAt, "string");
  assert.equal(delivery.approvalId, approval.id);
  assert.equal(delivery.workItemId, implementTicket.id);
  assert.equal(delivery.attempt, 1);
  assert.deepEqual(delivery.pullRequest, {
    number: 73,
    url: "https://github.com/mtamburrano/proofboard-demo-fixture/pull/73",
    repositoryOwner: "mtamburrano",
    repositoryName: "proofboard-demo-fixture",
    base: "main",
    head: "proofboard-verified-delivery",
    headSha: "8bb22a62b3714f699204cb0d5c440fcb7f0a09e1",
  });
  assert.deepEqual(runner.deliveryCalls.lifecycle, [{
    missionStatus: "verifying",
    workItemStatus: "delivering",
  }]);
  assert.equal(runner.deliveryCalls.protectedOperations, 1);
  assert.equal(runner.deliveryCalls.resolved[0].workItemId, implementTicket.id);

  const state = await missions.getState();
  const readback = state.evidence.find((item) =>
    item.source === "mcp" && item.details?.includes('"tool":"pull_request_read"'),
  );
  assert.equal(readback.workItemId, implementTicket.id);
  assert.equal(readback.attempt, 1);
  assert.equal(delivered.mission.progress.execution, "passed");
  assert.equal(delivered.mission.progress.verification, "passed");
});

test("a reconnect reconciles a durable delivery intent without replaying create_pull_request", async () => {
  const repository = new InMemoryMissionRepository();
  const first = testApp(repository);
  const { implementTicket, approval } = await reachDeliveryApproval(first.app);
  const context = approval.executionContext;
  await first.missions.decideApproval(PRIMARY_MISSION_ID, approval.id, {
    decision: "approved",
    decidedBy: "release-operator",
  });
  await first.missions.transitionSystemWorkItem(PRIMARY_MISSION_ID, implementTicket.id, "delivering", {
    trigger: "approval",
  });
  await first.missions.transitionMission(PRIMARY_MISSION_ID, "verifying");
  const intent = await first.missions.recordDeliveryAttempt(PRIMARY_MISSION_ID, {
    approvalId: approval.id,
    workItemId: implementTicket.id,
    attempt: approval.attempt,
    expectedEffect: approval.expectedEffect,
    target: {
      repositoryOwner: context.repositoryOwner,
      repositoryName: context.repositoryName,
      base: context.base,
      head: context.head,
      artifact: PRIMARY_VERIFIED_DELIVERY_ARTIFACT,
      title: context.title,
      body: context.body,
    },
  });
  assert.equal(intent.created, true);

  const restoredMissions = new MissionService(repository);
  const restoredRunner = new TestMissionRunner(restoredMissions);
  const restoredApp = createMissionHttpApp({ missions: restoredMissions, runner: restoredRunner });
  const response = await restoredApp.request("/api/mission/run", { method: "POST" });
  assert.equal(response.status, 200);
  const delivered = await json(response);
  assert.equal(delivered.mission.mission.status, "delivered");
  assert.equal(restoredRunner.deliveryCalls.protectedOperations, 0);
  assert.equal(restoredRunner.deliveryCalls.resolved.length, 0);
  assert.equal(restoredRunner.deliveryCalls.reconciled.length, 1);
  assert.equal(restoredRunner.deliveryCalls.reconciled[0].knownPullRequest, undefined);
  const state = await restoredMissions.getState();
  assert.equal(state.deliveryAttempts.length, 1);
  assert.equal(state.deliveryAttempts[0].status, "completed");
  assert.equal(state.deliveryAttempts[0].pullRequest.number, 73);
});

test("a missing reconciled pull request fails closed without replaying the protected mutation", async () => {
  const repository = new InMemoryMissionRepository();
  const first = testApp(repository);
  const { implementTicket, approval } = await reachDeliveryApproval(first.app);
  const context = approval.executionContext;
  await first.missions.decideApproval(PRIMARY_MISSION_ID, approval.id, {
    decision: "approved",
    decidedBy: "release-operator",
  });
  await first.missions.transitionSystemWorkItem(PRIMARY_MISSION_ID, implementTicket.id, "delivering", {
    trigger: "approval",
  });
  await first.missions.transitionMission(PRIMARY_MISSION_ID, "verifying");
  await first.missions.recordDeliveryAttempt(PRIMARY_MISSION_ID, {
    approvalId: approval.id,
    workItemId: implementTicket.id,
    attempt: approval.attempt,
    expectedEffect: approval.expectedEffect,
    target: {
      repositoryOwner: context.repositoryOwner,
      repositoryName: context.repositoryName,
      base: context.base,
      head: context.head,
      artifact: PRIMARY_VERIFIED_DELIVERY_ARTIFACT,
      title: context.title,
      body: context.body,
    },
  });

  const restoredMissions = new MissionService(repository);
  const restoredRunner = new TestMissionRunner(restoredMissions, { reconciliationResult: null });
  const restoredApp = createMissionHttpApp({ missions: restoredMissions, runner: restoredRunner });
  const response = await restoredApp.request("/api/mission/run", { method: "POST" });
  assert.equal(response.status, 502);
  assert.equal(restoredRunner.deliveryCalls.protectedOperations, 0);
  assert.equal(restoredRunner.deliveryCalls.resolved.length, 0);
  const state = await restoredMissions.getState();
  assert.equal(state.missions[0].status, "blocked");
  assert.equal(state.deliveryAttempts[0].status, "pending");
  assert.equal(state.deliveries.length, 0);
});

test("rejecting or cancelling delivery blocks the ticket without a protected operation", async () => {
  for (const decision of ["rejected", "cancelled"]) {
    const { app, runner } = testApp();
    const { implementTicket, approval } = await reachDeliveryApproval(app);
    const result = await decideDelivery(app, approval, decision, `${decision}-operator`);
    const ticket = result.mission.tickets.find((item) => item.id === implementTicket.id);
    const persistedApproval = result.mission.approvals.find((item) => item.id === approval.id);

    assert.equal(result.mission.mission.status, "blocked");
    assert.equal(ticket.status, "blocked");
    assert.equal(persistedApproval.decision, decision);
    assert.equal(persistedApproval.decidedBy, `${decision}-operator`);
    assert.equal(result.mission.delivery.length, 0);
    assert.equal(runner.deliveryCalls.protectedOperations, 0);
    assert.equal(runner.deliveryCalls.resolved.length, 1);
    assert.equal(runner.deliveryCalls.resolved[0].decision, decision);
    assert.equal((await app.request("/api/mission/run", { method: "POST" })).status, 400);
    assert.equal(runner.deliveryCalls.protectedOperations, 0);
  }
});

test("an approval cannot deliver after the current ticket enters Changes Requested", async () => {
  const repository = new InMemoryMissionRepository();
  const first = testApp(repository);
  const { implementTicket, approval } = await reachDeliveryApproval(first.app);
  const snapshot = await repository.load();
  const currentTicket = snapshot.workItems.find((item) => item.id === implementTicket.id);
  const currentAttempt = currentTicket.attempts.at(-1);
  currentTicket.status = "changes_requested";
  currentTicket.requestedChanges = ["A newer proof finding requires rework."];
  currentAttempt.status = "changes_requested";
  await repository.save(snapshot);

  const restoredMissions = new MissionService(repository);
  const restoredRunner = new TestMissionRunner(restoredMissions);
  const restoredApp = createMissionHttpApp({ missions: restoredMissions, runner: restoredRunner });
  const response = await restoredApp.request(`/api/mission/approvals/${approval.id}`, {
    method: "POST",
    body: JSON.stringify({ decision: "approved", actor: "stale-operator" }),
  });
  assert.equal(response.status, 502);
  const persisted = await restoredMissions.getState();
  assert.equal(persisted.approvals.find((item) => item.id === approval.id).decision, "pending");
  assert.equal(persisted.workItems.find((item) => item.id === implementTicket.id).status, "changes_requested");
  assert.equal(restoredRunner.deliveryCalls.protectedOperations, 0);
});

test("approval and delivery correlation survive a JSON reconnect", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-delivery-reconnect-"));
  const filePath = path.join(directory, "state.json");
  try {
    const first = testApp(new JsonMissionRepository(filePath));
    const { implementTicket, approval } = await reachDeliveryApproval(first.app);

    const restoredMissions = new MissionService(new JsonMissionRepository(filePath));
    const restoredRunner = new TestMissionRunner(restoredMissions);
    const restoredApp = createMissionHttpApp({ missions: restoredMissions, runner: restoredRunner });
    const restored = await json(await restoredApp.request("/api/mission"));
    const restoredTicket = restored.mission.tickets.find((item) => item.id === implementTicket.id);
    const restoredApproval = restored.mission.approvals.find((item) => item.id === approval.id);
    assert.equal(restoredTicket.status, "awaiting_approval");
    assert.equal(restoredTicket.attempt, 1);
    assert.equal(restoredTicket.claim.trueforgeSessionId, "test-session-durable");
    assert.equal(restoredTicket.claim.trueforgeSandboxId, "test-sandbox-durable");
    assert.equal(restoredApproval.workItemId, implementTicket.id);
    assert.equal(restoredApproval.attempt, 1);
    assert.equal(restoredApproval.decision, "pending");

    const pendingRun = await restoredApp.request("/api/mission/run", { method: "POST" });
    assert.equal(pendingRun.status, 200);
    const pendingState = await json(pendingRun);
    assert.equal(pendingState.mission.mission.status, "awaiting_approval");
    assert.equal(restoredRunner.calls.headInspect, 0);
    assert.equal(restoredRunner.deliveryCalls.protectedOperations, 0);

    const delivered = await decideDelivery(restoredApp, restoredApproval, "approved", "reconnect-operator");
    assert.equal(delivered.mission.mission.status, "delivered");
    assert.equal(delivered.mission.delivery[0].workItemId, implementTicket.id);
    assert.equal(delivered.mission.delivery[0].attempt, 1);
    assert.equal(delivered.mission.approvals[0].decidedBy, "reconnect-operator");
    assert.equal(restoredRunner.deliveryCalls.protectedOperations, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a restart resumes from persisted pull-request read-back without repeating protected delivery", async () => {
  const repository = new InMemoryMissionRepository();
  const first = testApp(repository);
  const { implementTicket, approval } = await reachDeliveryApproval(first.app);
  const context = approval.executionContext;
  await first.missions.decideApproval(PRIMARY_MISSION_ID, approval.id, {
    decision: "approved",
    decidedBy: "release-operator",
  });
  await first.missions.transitionSystemWorkItem(PRIMARY_MISSION_ID, implementTicket.id, "delivering", {
    trigger: "approval",
  });
  await first.missions.transitionMission(PRIMARY_MISSION_ID, "verifying");
  await first.missions.addEvidence(PRIMARY_MISSION_ID, {
    workItemId: implementTicket.id,
    kind: "tool_result",
    result: "passed",
    source: "mcp",
    summary: "MCP verified the published artifact before the controller restarted.",
    details: JSON.stringify({
      server: "github",
      tool: "get_commit",
      provenance_kind: "delivery_head",
      arguments: {
        owner: context.repositoryOwner,
        repo: context.repositoryName,
        sha: context.head,
        detail: "full_patch",
        perPage: 100,
      },
      repository_owner: context.repositoryOwner,
      repository_name: context.repositoryName,
      requested_ref: context.head,
      baseline_sha: PRIMARY_VERIFIED_DELIVERY_ARTIFACT.baselineSha,
      uri: `repo://${context.repositoryOwner}/${context.repositoryName}/sha/8bb22a62b3714f699204cb0d5c440fcb7f0a09e1`,
      commit_sha: "8bb22a62b3714f699204cb0d5c440fcb7f0a09e1",
      patches: PRIMARY_VERIFIED_DELIVERY_ARTIFACT.patches,
      artifact_hash: PRIMARY_VERIFIED_DELIVERY_ARTIFACT.contentHash,
    }),
    executionOrigin: {
      kind: "mcp",
      sessionId: context.sessionId,
      turnId: "restart-delivery-head-turn",
    },
  });
  await first.missions.addEvidence(PRIMARY_MISSION_ID, {
    workItemId: implementTicket.id,
    kind: "tool_result",
    result: "passed",
    source: "mcp",
    summary: "MCP verified the pull request before the controller restarted.",
    details: JSON.stringify({
      server: "github",
      tool: "pull_request_read",
      repository_owner: context.repositoryOwner,
      repository_name: context.repositoryName,
      base: context.base,
      head: context.head,
      head_sha: "8bb22a62b3714f699204cb0d5c440fcb7f0a09e1",
      pull_request_number: 73,
      pull_request_url: "https://github.com/mtamburrano/proofboard-demo-fixture/pull/73",
    }),
    executionOrigin: {
      kind: "mcp",
      sessionId: context.sessionId,
      turnId: "restart-readback-turn",
      threadId: context.threadId,
      toolCallId: "restart-readback-call",
    },
  });

  const restoredMissions = new MissionService(repository);
  const restoredRunner = new TestMissionRunner(restoredMissions);
  const restoredApp = createMissionHttpApp({ missions: restoredMissions, runner: restoredRunner });
  const response = await restoredApp.request("/api/mission/run", { method: "POST" });
  assert.equal(response.status, 200);
  const delivered = await json(response);
  assert.equal(delivered.mission.mission.status, "delivered");
  assert.equal(delivered.mission.delivery[0].approvalId, approval.id);
  assert.equal(delivered.mission.delivery[0].attempt, 1);
  assert.equal(restoredRunner.deliveryCalls.protectedOperations, 0);
  assert.equal(restoredRunner.deliveryCalls.resolved.length, 0);
});

test("a semantic changes-requested review stops the queue without automatic repair", async () => {
  const reviewed = [];
  const verifier = {
    review(context) {
      reviewed.push(context);
      return {
        outcome: "changes_requested",
        reviewer: "test-reviewer",
        summary: "The measured implementation needs a contract correction.",
        finding: "The measured diff does not satisfy the acceptance criteria.",
      };
    },
  };
  const { app, runner, missions } = testApp(new InMemoryMissionRepository(), { verifier });

  await app.request("/api/mission", { method: "POST" });
  let current = await json(await app.request("/api/mission"));
  const inspectTicket = current.mission.tickets.find((item) => item.assignedRole === "planner");
  await authorizeTicket(app, inspectTicket.id);
  await app.request("/api/mission/run", { method: "POST" });
  current = await json(await app.request("/api/mission"));
  const implementTicket = current.mission.tickets.find((item) => item.assignedRole === "implementer");
  await authorizeTicket(app, implementTicket.id);
  await app.request("/api/mission/run", { method: "POST" });

  const reviewResponse = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(reviewResponse.status, 200);
  const changesRequested = await json(reviewResponse);
  const ticket = changesRequested.mission.tickets.find((item) => item.id === implementTicket.id);
  assert.equal(ticket.status, "changes_requested");
  assert.deepEqual(ticket.requestedChanges, ["The measured diff does not satisfy the acceptance criteria."]);
  assert.equal(reviewed.length, 1);
  assert.equal(reviewed[0].actualFilesChanged.length > 0, true);
  assert.equal((await missions.getState()).reviews[0].outcome, "changes_requested");
  assert.equal(runner.calls.sandbox, 1);
  assert.equal((await app.request("/api/mission/run", { method: "POST" })).status, 400);
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

test("HTTP renders durable rework history and rejects stale authorization revisions", async () => {
  const { app, missions } = testApp();
  await app.request("/api/mission", { method: "POST" });
  const initial = await json(await app.request("/api/mission"));
  const ticket = initial.mission.tickets.find((item) => item.assignedRole === "planner");
  await authorizeTicket(app, ticket.id);
  await missions.claimWorkItem(PRIMARY_MISSION_ID, ticket.id, {
    owner: "proof-worker",
    trueforgeSessionId: "test-session-durable",
    trueforgeSandboxId: "sandbox-rework",
  });
  await missions.transitionSystemWorkItem(PRIMARY_MISSION_ID, ticket.id, "proving", {
    trigger: "execution",
  });
  await missions.transitionSystemWorkItem(PRIMARY_MISSION_ID, ticket.id, "changes_requested", {
    trigger: "proof",
    reason: "The deterministic proof needs one more bounded assertion.",
  });

  const changesRequested = await json(await app.request("/api/mission"));
  const repairTicket = changesRequested.mission.tickets.find((item) => item.id === ticket.id);
  assert.equal(repairTicket.status, "changes_requested");
  assert.equal(repairTicket.attempt, 1);
  assert.deepEqual(repairTicket.requestedChanges, ["The deterministic proof needs one more bounded assertion."]);
  assert.equal(repairTicket.attempts[0].claim.trueforgeSandboxId, "sandbox-rework");
  assert.equal(repairTicket.attempts[0].status, "changes_requested");

  const stale = await app.request(`/api/mission/tickets/${ticket.id}/status`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "ready",
      actor: "repair-operator",
      expected_revision: changesRequested.mission.revision - 1,
    }),
  });
  assert.equal(stale.status, 409);
  const stillBlocked = await json(await app.request("/api/mission"));
  assert.equal(stillBlocked.mission.tickets.find((item) => item.id === ticket.id).status, "changes_requested");

  const authorized = await app.request(`/api/mission/tickets/${ticket.id}/status`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "ready",
      actor: "repair-operator",
      expected_revision: stillBlocked.mission.revision,
    }),
  });
  assert.equal(authorized.status, 200);
  const authorizedPayload = await json(authorized);
  assert.equal(authorizedPayload.ticket.status, "ready");
  assert.equal(authorizedPayload.ticket.attempts[0].retiredBy, "repair-operator");
  assert.equal(authorizedPayload.ticket.attempts[0].claim.trueforgeSessionId, "test-session-durable");
});
