import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  IMPLEMENTATION_PROOF_MODE,
  JsonMissionRepository,
  MissionService,
  PRIMARY_DELIVERY_FIXTURE,
  PRIMARY_DELIVERY_TARGET,
  PRIMARY_MISSION_ID,
  PRIMARY_VERIFIED_DELIVERY_ARTIFACT,
  PRIMARY_VERIFIED_DELIVERY_FILES,
  PRIMARY_VERIFIED_DELIVERY_PATCHES,
  PRIMARY_VERIFICATION_COMMAND,
  TrueForgeIntegrationError,
  createMissionHttpApp,
} from "../dist/index.js";

const SESSION_ID = "queue-safety-session";
const SANDBOX_ID = "queue-safety-sandbox";
const DELIVERY_HEAD_SHA = "8bb22a62b3714f699204cb0d5c440fcb7f0a09e1";
const MISMATCHED_HEAD_SHA = "9cc33b73c4825f800315dc6e6a5510dc8b1f10f2";
const FIXED_NOW = () => new Date("2099-01-01T00:00:00.000Z");

function createSharedHarness({
  proofFailuresRemaining = 0,
  infrastructureFailuresRemaining = 0,
  deliveryHeadShaSequence = [DELIVERY_HEAD_SHA],
  deliveryResultHeadSha = DELIVERY_HEAD_SHA,
} = {}) {
  return {
    proofFailuresRemaining,
    infrastructureFailuresRemaining,
    deliveryHeadShaSequence: [...deliveryHeadShaSequence],
    deliveryResultHeadSha,
    calls: {
      create: 0,
      inspect: 0,
      headInspect: 0,
      turn: 0,
      proof: 0,
      requestedApprovals: 0,
      resolvedApprovals: [],
      protectedOperations: 0,
      protectedOperationStates: [],
    },
    turns: [],
    proofs: [],
    headInspections: [],
    remoteMutations: 0,
  };
}

class QueueSafetyRunner {
  constructor(missions, shared) {
    this.missions = missions;
    this.shared = shared;
  }

  async createMission(input) {
    this.shared.calls.create += 1;
    return this.missions.createMission({
      ...input,
      trueforgeSessionId: SESSION_ID,
    });
  }

  async inspectRepository(input) {
    this.shared.calls.inspect += 1;
    const target = PRIMARY_DELIVERY_FIXTURE;
    const resourceUri = `repo://${target.owner}/${target.repository}/sha/${target.baselineSha}`;
    const evidence = await this.missions.addEvidence(input.missionId, {
      workItemId: input.workItemId,
      kind: "tool_result",
      result: "passed",
      source: "mcp",
      summary: "The pinned repository baseline was verified by the read-only connector.",
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
        content_hash: "queue-safety-baseline-content",
      }),
      executionOrigin: {
        kind: "mcp",
        sessionId: SESSION_ID,
        turnId: "queue-safety-inspection-turn",
        toolCallId: "queue-safety-baseline-call",
      },
    });
    return {
      evidenceId: evidence.id,
      resourceUri,
      contentHash: "queue-safety-baseline-content",
      commitSha: target.baselineSha,
      patches: {
        "src/index.ts": "@@ verified source",
        "test/index.test.js": "@@ verified focused tests",
      },
    };
  }

  async runTurn(missionId, instruction, options) {
    this.shared.calls.turn += 1;
    const turnId = `queue-safety-turn-${this.shared.calls.turn}`;
    this.shared.turns.push({
      turnId,
      instruction,
      options: { ...options },
    });
    await this.missions.attachTrueforgeTurn(missionId, turnId);
    if (options.workItemId !== undefined) {
      await this.missions.attachTrueforgeSandbox(missionId, SANDBOX_ID);
      await this.missions.attachWorkItemExecution(missionId, options.workItemId, {
        trueforgeSessionId: SESSION_ID,
        trueforgeSandboxId: SANDBOX_ID,
      });
    }
    await this.missions.addEvidence(missionId, {
      workItemId: options.workItemId,
      kind: "tool_result",
      result: "passed",
      source: "trueforge",
      summary: "TrueForge turn finished with status done.",
      details: JSON.stringify({ event_type: "turn.done", turn_id: turnId }),
      executionOrigin: {
        kind: "trueforge",
        sessionId: SESSION_ID,
        turnId,
        threadId: "main",
        toolCallId: `${turnId}-call`,
      },
    });
    return {
      sessionId: SESSION_ID,
      turnId,
      events: [],
      mission: await this.missions.getMission(missionId),
    };
  }

  async proveImplementation(input) {
    this.shared.calls.proof += 1;
    this.shared.proofs.push({
      workItemId: input.workItemId,
      attempt: (await this.missions.getWorkItem(input.missionId, input.workItemId)).attempt,
    });
    const proofAttempt = (await this.missions.getWorkItem(input.missionId, input.workItemId)).attempt;
    const proofOrigin = {
      kind: "sandbox",
      sessionId: SESSION_ID,
      turnId: `queue-safety-proof-turn-${proofAttempt}`,
      threadId: `queue-safety-proof-thread-${proofAttempt}`,
      toolCallId: `queue-safety-proof-call-${proofAttempt}`,
    };
    if (this.shared.infrastructureFailuresRemaining > 0) {
      this.shared.infrastructureFailuresRemaining -= 1;
      await this.missions.addEvidence(input.missionId, {
        workItemId: input.workItemId,
        kind: "tool_result",
        result: "failed",
        source: "sandbox",
        summary: "The direct proof provider was temporarily unavailable.",
        details: JSON.stringify({
          proof_mode: IMPLEMENTATION_PROOF_MODE,
          failure_layer: "tool",
          failure_category: "sandbox",
          failure_class: "infrastructure",
          failure_reason_category: "network",
          retryable: true,
          reason: "provider connection failed",
        }),
        executionOrigin: proofOrigin,
      });
      throw new TrueForgeIntegrationError(
        "prove implementation",
        "Direct proof provider connection failed.",
        {
          failureClass: "infrastructure",
          failureCategory: "network",
          retryable: true,
        },
      );
    }
    if (this.shared.proofFailuresRemaining > 0) {
      this.shared.proofFailuresRemaining -= 1;
      await this.missions.addEvidence(input.missionId, {
        workItemId: input.workItemId,
        kind: "test_result",
        result: "failed",
        source: "sandbox",
        summary: "The direct sandbox proof exited with code 1.",
        details: JSON.stringify({
          proof_mode: IMPLEMENTATION_PROOF_MODE,
          command: PRIMARY_VERIFICATION_COMMAND,
          exit_code: 1,
          output: "one bounded assertion failed",
        }),
        executionOrigin: proofOrigin,
      });
      throw new TrueForgeIntegrationError(
        "prove implementation",
        "Direct sandbox proof exited with code 1.",
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
    const finalFileContents = isPrimaryArtifact
      ? PRIMARY_VERIFIED_DELIVERY_FILES
      : Object.fromEntries(filesChanged.map((file) => [file, "before\nafter\n"]));
    const parsedPatches = isPrimaryArtifact
      ? PRIMARY_VERIFIED_DELIVERY_PATCHES
      : Object.fromEntries(filesChanged.map((file) => [file, "@@ -1 +1,2 @@\n before\n+after"]));
    const status = await this.missions.addEvidence(input.missionId, {
      workItemId: input.workItemId,
      kind: "file_change",
      result: "passed",
      source: "sandbox",
      summary: "The direct sandbox proof measured the complete final workspace status.",
      details: JSON.stringify({
        proof_mode: IMPLEMENTATION_PROOF_MODE,
        complete_changed_files: true,
        command: "git status --porcelain=v1 -z --untracked-files=all",
        exit_code: 0,
        changed_files: filesChanged,
        sandbox_id: SANDBOX_ID,
      }),
      executionOrigin: proofOrigin,
    });
    const diff = await this.missions.addEvidence(input.missionId, {
      workItemId: input.workItemId,
      kind: "diff_summary",
      result: "passed",
      source: "sandbox",
      summary: "The direct sandbox proof captured the actual final content diff.",
      details: JSON.stringify({
        proof_mode: IMPLEMENTATION_PROOF_MODE,
        command: "git diff -- src/index.ts test/index.test.js",
        output: diffOutput,
        changed_files: filesChanged,
        parsed_patches: parsedPatches,
        final_file_contents: finalFileContents,
        final_file_content_commands: filesChanged.slice().sort().map((file) => ({
          file,
          command: `cat /tmp/proofboard-workspace/${file}`,
        })),
        baseline_sha: PRIMARY_DELIVERY_FIXTURE.baselineSha,
        sandbox_id: SANDBOX_ID,
        ...(isPrimaryArtifact
          ? {
              provenance_kind: "implementation_artifact",
              artifact_hash: PRIMARY_VERIFIED_DELIVERY_ARTIFACT.contentHash,
              delivery_artifact: PRIMARY_VERIFIED_DELIVERY_ARTIFACT,
            }
          : {}),
      }),
      executionOrigin: proofOrigin,
    });
    const typecheck = await this.missions.addEvidence(input.missionId, {
      workItemId: input.workItemId,
      kind: "typecheck_result",
      result: "passed",
      source: "sandbox",
      summary: "The direct sandbox typecheck passed.",
      details: JSON.stringify({
        proof_mode: IMPLEMENTATION_PROOF_MODE,
        command: "npm run typecheck",
        exit_code: 0,
        output: "typecheck passed",
        sandbox_id: SANDBOX_ID,
      }),
      executionOrigin: proofOrigin,
    });
    const tests = await this.missions.addEvidence(input.missionId, {
      workItemId: input.workItemId,
      kind: "test_result",
      result: "passed",
      source: "sandbox",
      summary: "The direct sandbox test suite passed.",
      details: JSON.stringify({
        proof_mode: IMPLEMENTATION_PROOF_MODE,
        command: PRIMARY_VERIFICATION_COMMAND,
        exit_code: 0,
        output: "all tests passed",
        sandbox_id: SANDBOX_ID,
      }),
      executionOrigin: proofOrigin,
    });
    return {
      filesChanged,
      diffSummary: diffOutput,
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
          command: PRIMARY_VERIFICATION_COMMAND,
          result: "passed",
          required: true,
          evidenceIds: [tests.id],
          exitCode: 0,
        },
      ],
      evidenceIds: [status.id, diff.id, typecheck.id, tests.id],
      decisions: [],
      openQuestions: [],
      ...(isPrimaryArtifact ? { deliveryArtifact: PRIMARY_VERIFIED_DELIVERY_ARTIFACT } : {}),
      executionOrigin: proofOrigin,
    };
  }

  async inspectDeliveryHead(input) {
    this.shared.calls.headInspect += 1;
    const sequenceIndex = this.shared.calls.headInspect - 1;
    const sequence = this.shared.deliveryHeadShaSequence;
    const headSha = sequence[Math.min(sequenceIndex, sequence.length - 1)] ?? DELIVERY_HEAD_SHA;
    this.shared.headInspections.push({ headSha, target: { ...input.target } });
    const resourceUri = `repo://${input.target.owner}/${input.target.repo}/sha/${headSha}`;
    const evidence = await this.missions.addEvidence(input.missionId, {
      workItemId: input.workItemId,
      kind: "tool_result",
      result: "passed",
      source: "mcp",
      summary: `The delivery head was verified at ${headSha}.`,
      details: JSON.stringify({
        server: "github",
        tool: "get_commit",
        provenance_kind: "delivery_head",
        arguments: {
          owner: input.target.owner,
          repo: input.target.repo,
          sha: input.target.head,
          detail: "full_patch",
        },
        repository_owner: input.target.owner,
        repository_name: input.target.repo,
        requested_ref: input.target.head,
        baseline_sha: PRIMARY_DELIVERY_FIXTURE.baselineSha,
        uri: resourceUri,
        commit_sha: headSha,
        patches: PRIMARY_VERIFIED_DELIVERY_PATCHES,
        content_hash: `queue-safety-head-${headSha}`,
      }),
      executionOrigin: {
        kind: "mcp",
        sessionId: SESSION_ID,
        turnId: `queue-safety-head-turn-${this.shared.calls.headInspect}`,
        threadId: "main",
        toolCallId: `queue-safety-head-call-${this.shared.calls.headInspect}`,
      },
    });
    return {
      evidenceId: evidence.id,
      resourceUri,
      contentHash: `queue-safety-head-${headSha}`,
      commitSha: headSha,
      patches: PRIMARY_VERIFIED_DELIVERY_PATCHES,
    };
  }

  async requestPullRequestApproval(missionId, target) {
    this.shared.calls.requestedApprovals += 1;
    const artifactDelivery = target.artifact !== undefined;
    return {
      sessionId: SESSION_ID,
      turnId: "queue-safety-approval-turn",
      threadId: "queue-safety-approval-thread",
      toolCallId: artifactDelivery ? "queue-safety-push-files-call" : "queue-safety-create-pr-call",
      serverName: "github",
      toolName: artifactDelivery ? "push_files" : "create_pull_request",
      target: { ...target },
    };
  }

  async resolvePullRequestApproval(missionId, pending, decision, workItemId) {
    const state = await this.missions.getState();
    const approval = state.approvals.find((item) => item.workItemId === workItemId);
    this.shared.calls.resolvedApprovals.push({
      missionId,
      decision,
      approvalDecision: approval?.decision,
    });
    if (decision !== "approved") {
      return null;
    }
    assert.equal(approval?.decision, "approved", "protected resolution must follow persisted approval");
    this.shared.calls.protectedOperations += 1;
    const implementation = state.workItems.find((item) => item.id === workItemId);
    this.shared.calls.protectedOperationStates.push({
      approvalDecision: approval?.decision,
      missionStatus: state.missions.find((item) => item.id === missionId)?.status,
      workItemStatus: implementation?.status,
    });
    const result = {
      number: 73,
      url: "https://github.com/mtamburrano/proofboard-demo-fixture/pull/73",
      headSha: this.shared.deliveryResultHeadSha,
      sessionId: pending.sessionId,
      turnId: "queue-safety-delivery-result-turn",
      threadId: pending.threadId,
      toolCallId: pending.toolCallId,
    };
    if (pending.target.artifact !== undefined) {
      await this.recordPublishedArtifactReadback(missionId, pending, workItemId);
    }
    await this.missions.addEvidence(missionId, {
      workItemId,
      kind: "tool_result",
      result: "passed",
      source: "mcp",
      summary: "The pull request read-back returned a structured result.",
      details: JSON.stringify({
        server: "github",
        tool: "pull_request_read",
        repository_owner: PRIMARY_DELIVERY_TARGET.owner,
        repository_name: PRIMARY_DELIVERY_TARGET.repo,
        base: PRIMARY_DELIVERY_TARGET.base,
        head: PRIMARY_DELIVERY_TARGET.head,
        head_sha: result.headSha,
        pull_request_number: result.number,
        pull_request_url: result.url,
      }),
      executionOrigin: {
        kind: "mcp",
        sessionId: result.sessionId,
        turnId: result.turnId,
        threadId: result.threadId,
        toolCallId: "queue-safety-readback-call",
      },
    });
    return result;
  }

  async recordPublishedArtifactReadback(missionId, pending, workItemId) {
    const artifact = pending.target.artifact;
    if (artifact === undefined) {
      return;
    }
    const publishedHeadSha = this.shared.deliveryHeadShaSequence[0] ?? DELIVERY_HEAD_SHA;
    await this.missions.addEvidence(missionId, {
      workItemId,
      kind: "tool_result",
      result: "passed",
      source: "mcp",
      summary: `The published artifact branch was independently read back at ${publishedHeadSha}.`,
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
        uri: `repo://${pending.target.owner}/${pending.target.repo}/sha/${publishedHeadSha}`,
        commit_sha: publishedHeadSha,
        patches: artifact.patches,
        artifact_hash: artifact.contentHash,
        content_hash: "queue-safety-published-artifact-content",
      }),
      executionOrigin: {
        kind: "mcp",
        sessionId: pending.sessionId,
        turnId: "queue-safety-published-artifact-turn",
      },
    });
  }
}

function acceptedVerifier() {
  return {
    review() {
      return {
        outcome: "accepted",
        reviewer: "queue-safety-independent-reviewer",
        summary: "The measured implementation satisfies the bounded contract.",
        finding: "The current attempt has no unresolved contract findings.",
      };
    },
  };
}

function sequencedVerifier(outcomes) {
  let index = 0;
  return {
    review() {
      const outcome = outcomes[Math.min(index++, outcomes.length - 1)];
      return outcome === "changes_requested"
        ? {
            outcome,
            reviewer: "queue-safety-independent-reviewer",
            summary: "The measured implementation needs bounded rework.",
            finding: "The first attempt does not satisfy the measured contract.",
          }
        : {
            outcome: "accepted",
            reviewer: "queue-safety-independent-reviewer",
            summary: "The corrected attempt satisfies the bounded contract.",
            finding: "The corrected attempt has no unresolved contract findings.",
          };
    },
  };
}

function testApp(repository, shared, verifier = acceptedVerifier()) {
  const missions = new MissionService(repository, FIXED_NOW);
  const runner = new QueueSafetyRunner(missions, shared);
  return {
    missions,
    runner,
    app: createMissionHttpApp({ missions, runner, verifier }),
  };
}

async function json(response) {
  const payload = await response.json();
  assert.equal(response.headers.get("cache-control"), "no-store");
  return payload;
}

async function missionView(app) {
  return (await json(await app.request("/api/mission"))).mission;
}

function ticketFor(mission, assignedRole) {
  const ticket = mission.tickets.find((item) => item.assignedRole === assignedRole);
  assert.ok(ticket, `Expected a ${assignedRole} ticket.`);
  return ticket;
}

async function authorize(app, ticketId, actor) {
  const current = await missionView(app);
  const response = await app.request(`/api/mission/tickets/${ticketId}/status`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "ready",
      actor,
      expected_revision: current.revision,
    }),
  });
  assert.equal(response.status, 200);
  return json(response);
}

async function runMission(app, expectedStatus = 200) {
  const response = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(response.status, expectedStatus);
  return json(response);
}

async function createPrimary(app) {
  const response = await app.request("/api/mission", { method: "POST" });
  assert.equal(response.status, 201);
  return json(response);
}

async function preparePendingApproval(app) {
  await createPrimary(app);
  let current = await missionView(app);
  const inspectTicket = ticketFor(current, "planner");
  await authorize(app, inspectTicket.id, "queue-operator");
  current = (await runMission(app)).mission;
  const implementation = ticketFor(current, "implementer");
  await authorize(app, implementation.id, "queue-operator");
  current = (await runMission(app)).mission;
  assert.equal(ticketFor(current, "implementer").status, "proving");
  current = (await runMission(app)).mission;
  const approval = current.approvals.find((item) => item.decision === "pending");
  assert.ok(approval, "A green current attempt must create a pending approval.");
  return {
    mission: current,
    implementation: ticketFor(current, "implementer"),
    approval,
  };
}

async function decide(app, approval, decision, expectedRevision, actor = "delivery-operator") {
  const response = await app.request(`/api/mission/approvals/${approval.id}`, {
    method: "POST",
    body: JSON.stringify({
      decision,
      actor,
      ...(expectedRevision === undefined ? {} : { expected_revision: expectedRevision }),
    }),
  });
  return { response, payload: await json(response) };
}

async function runSemanticReworkRecoveryScenario(directory) {
  const statePath = path.join(directory, "semantic-rework.json");
  const repository = new JsonMissionRepository(statePath);
  const shared = createSharedHarness();
  const verifier = sequencedVerifier(["changes_requested", "accepted"]);
  const first = testApp(repository, shared, verifier);

  const unauthorized = await first.app.request("/api/mission/run", { method: "POST" });
  assert.equal(unauthorized.status, 400);
  assert.equal(shared.calls.inspect, 0);
  await createPrimary(first.app);
  let current = await missionView(first.app);
  const inspectTicket = ticketFor(current, "planner");
  const forbidden = await first.app.request(`/api/mission/tickets/${inspectTicket.id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status: "proving", actor: "queue-operator" }),
  });
  assert.equal(forbidden.status, 400);
  await authorize(first.app, inspectTicket.id, "queue-operator");

  const duplicatePlannerRuns = await Promise.all([
    first.app.request("/api/mission/run", { method: "POST" }),
    first.app.request("/api/mission/run", { method: "POST" }),
  ]);
  assert.deepEqual(duplicatePlannerRuns.map((response) => response.status), [200, 200]);
  assert.equal(shared.calls.inspect, 1);
  current = await missionView(first.app);
  const implementation = ticketFor(current, "implementer");
  await authorize(first.app, implementation.id, "queue-operator");

  const claimState = await missionView(first.app);
  const duplicateClaims = await Promise.all([
    first.app.request(`/api/mission/tickets/${implementation.id}/claim`, {
      method: "POST",
      body: JSON.stringify({ owner: "queue-worker", expected_revision: claimState.revision }),
    }),
    first.app.request(`/api/mission/tickets/${implementation.id}/claim`, {
      method: "POST",
      body: JSON.stringify({ owner: "queue-worker", expected_revision: claimState.revision }),
    }),
  ]);
  assert.equal(duplicateClaims.filter((response) => response.status === 200).length, 1);
  assert.equal(duplicateClaims.filter((response) => response.status === 409).length, 1);

  const duplicateExecutionRuns = await Promise.all([
    first.app.request("/api/mission/run", { method: "POST" }),
    first.app.request("/api/mission/run", { method: "POST" }),
  ]);
  assert.deepEqual(duplicateExecutionRuns.map((response) => response.status), [200, 200]);
  assert.equal(shared.calls.turn, 1);
  current = await missionView(first.app);
  assert.equal(ticketFor(current, "implementer").status, "proving");

  current = (await runMission(first.app)).mission;
  const requested = ticketFor(current, "implementer");
  assert.equal(requested.status, "changes_requested");
  assert.equal(requested.attempt, 1);
  assert.equal(current.approvals.length, 0);
  assert.equal(current.handoffs.length, 1);
  assert.equal(current.reviews.length, 1);
  assert.equal(current.reviews[0].outcome, "changes_requested");
  const firstHandoff = structuredClone(current.handoffs[0]);
  const firstReview = structuredClone(current.reviews[0]);
  const firstAttemptEvidence = structuredClone(
    current.evidence.filter((item) => item.workItemId === implementation.id && item.attempt === 1),
  );
  const firstTurnId = shared.turns[0].turnId;

  const reconnectMissions = new MissionService(new JsonMissionRepository(statePath), FIXED_NOW);
  const reconnectRunner = new QueueSafetyRunner(reconnectMissions, shared);
  const reconnectApp = createMissionHttpApp({
    missions: reconnectMissions,
    runner: reconnectRunner,
    verifier,
  });
  current = await missionView(reconnectApp);
  const recovered = ticketFor(current, "implementer");
  assert.equal(recovered.id, implementation.id);
  assert.equal(recovered.status, "changes_requested");
  assert.equal(recovered.attempts[0].claim.trueforgeSessionId, SESSION_ID);
  assert.equal(recovered.attempts[0].claim.trueforgeSandboxId, SANDBOX_ID);
  const inertRunCalls = { turn: shared.calls.turn, proof: shared.calls.proof };
  await runMission(reconnectApp, 400);
  assert.deepEqual(
    { turn: shared.calls.turn, proof: shared.calls.proof },
    inertRunCalls,
  );
  const forbiddenRework = await reconnectApp.request(`/api/mission/tickets/${implementation.id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status: "in_progress", actor: "reconnect-operator" }),
  });
  assert.equal(forbiddenRework.status, 400);
  const staleRework = await reconnectApp.request(`/api/mission/tickets/${implementation.id}/status`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "ready",
      actor: "reconnect-operator",
      expected_revision: current.revision - 1,
    }),
  });
  assert.equal(staleRework.status, 409);
  current = await missionView(reconnectApp);
  await authorize(reconnectApp, implementation.id, "reconnect-operator");

  current = (await runMission(reconnectApp)).mission;
  const reworkInProgress = ticketFor(current, "implementer");
  assert.equal(reworkInProgress.status, "proving");
  assert.equal(reworkInProgress.attempt, 2);
  assert.equal(reworkInProgress.attempts[0].retiredBy, "reconnect-operator");
  assert.equal(reworkInProgress.attempts[1].claim.trueforgeSessionId, SESSION_ID);
  assert.equal(reworkInProgress.attempts[1].claim.trueforgeSandboxId, SANDBOX_ID);
  assert.equal(shared.turns[1].options.previousTurnId, firstTurnId);
  assert.match(shared.turns[1].instruction, /Requested rework findings:/);

  current = (await runMission(reconnectApp)).mission;
  const reworkAwaitingApproval = ticketFor(current, "implementer");
  assert.equal(reworkAwaitingApproval.status, "awaiting_approval");
  assert.equal(reworkAwaitingApproval.attempt, 2);
  assert.equal(reworkAwaitingApproval.attempts.length, 2);
  assert.equal(current.handoffs.length, 2);
  assert.equal(current.reviews.length, 2);
  assert.deepEqual(current.handoffs[0], firstHandoff);
  assert.deepEqual(current.reviews[0], firstReview);
  assert.deepEqual(
    current.evidence.filter((item) => item.workItemId === implementation.id && item.attempt === 1),
    firstAttemptEvidence,
  );
  const approval = current.approvals.at(-1);
  assert.equal(approval.attempt, 2);
  assert.equal(current.mission.status, "awaiting_approval");
  assert.equal(shared.calls.protectedOperations, 0);
  assert.equal(shared.remoteMutations, 0);

  const staleApprovalRevision = current.revision;
  await reconnectMissions.addEvidence(PRIMARY_MISSION_ID, {
    kind: "tool_result",
    result: "informational",
    source: "system",
    summary: "A reconnect observed newer durable state before approval.",
  });
  const staleApproval = await decide(
    reconnectApp,
    approval,
    "approved",
    staleApprovalRevision,
    "stale-operator",
  );
  assert.equal(staleApproval.response.status, 409);
  assert.equal(staleApproval.payload.mission.approvals.at(-1).decision, "pending");
  assert.equal(shared.calls.protectedOperations, 0);

  const pendingReconnectMissions = new MissionService(new JsonMissionRepository(statePath), FIXED_NOW);
  const pendingReconnectRunner = new QueueSafetyRunner(pendingReconnectMissions, shared);
  const pendingReconnectApp = createMissionHttpApp({
    missions: pendingReconnectMissions,
    runner: pendingReconnectRunner,
    verifier,
  });
  const beforePendingRun = shared.calls.headInspect;
  current = await missionView(pendingReconnectApp);
  const pendingRun = await runMission(pendingReconnectApp);
  assert.equal(pendingRun.mission.mission.status, "awaiting_approval");
  assert.equal(shared.calls.headInspect, beforePendingRun);
  assert.equal(shared.calls.protectedOperations, 0);

  const delivered = await decide(
    pendingReconnectApp,
    approval,
    "approved",
    pendingRun.mission.revision,
    "release-operator",
  );
  assert.equal(delivered.response.status, 200);
  assert.equal(delivered.payload.mission.mission.status, "delivered");
  assert.equal(ticketFor(delivered.payload.mission, "implementer").status, "done");
  assert.equal(delivered.payload.mission.delivery[0].attempt, 2);
  assert.equal(delivered.payload.mission.delivery[0].workItemId, implementation.id);
  assert.equal(delivered.payload.mission.approvals.at(-1).decision, "approved");
  assert.equal(shared.calls.protectedOperations, 1);
  assert.deepEqual(shared.calls.protectedOperationStates, [{
    approvalDecision: "approved",
    missionStatus: "verifying",
    workItemStatus: "delivering",
  }]);
  assert.equal(shared.remoteMutations, 0);

  const finalState = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(finalState.missions.find((item) => item.id === PRIMARY_MISSION_ID).status, "delivered");
  const finalReconnectMissions = new MissionService(new JsonMissionRepository(statePath), FIXED_NOW);
  const finalReconnectApp = createMissionHttpApp({
    missions: finalReconnectMissions,
    runner: new QueueSafetyRunner(finalReconnectMissions, shared),
    verifier,
  });
  const finalReconnect = await missionView(finalReconnectApp);
  assert.equal(finalReconnect.mission.status, "delivered");
  assert.equal(ticketFor(finalReconnect, "implementer").status, "done");
  assert.equal(finalReconnect.delivery[0].attempt, 2);

  return {
    flow: "semantic review changes requested → reconnect → human reauthorization → verified delivery",
    status: finalReconnect.mission.status,
    attempt: finalReconnect.tickets.find((item) => item.id === implementation.id).attempt,
    handoffs: finalReconnect.handoffs.length,
    reviews: finalReconnect.reviews.length,
    protectedOperations: shared.calls.protectedOperations,
    remoteMutations: shared.remoteMutations,
  };
}

async function runProofFailureScenario(directory) {
  const statePath = path.join(directory, "proof-failure.json");
  const shared = createSharedHarness({ proofFailuresRemaining: 1 });
  const first = testApp(new JsonMissionRepository(statePath), shared);
  const prepared = await preparePendingApprovalButStopAtProof(first.app);
  const failed = await runMission(first.app);
  const failedTicket = ticketFor(failed.mission, "implementer");
  assert.equal(failedTicket.status, "changes_requested");
  assert.equal(failedTicket.attempt, 1);
  assert.equal(failed.mission.approvals.length, 0);
  assert.equal(failed.mission.handoffs.length, 0);
  assert.equal(failed.mission.reviews.length, 0);
  assert.equal(shared.calls.proof, 1);
  const noAutomaticRetry = await first.app.request("/api/mission/run", { method: "POST" });
  assert.equal(noAutomaticRetry.status, 400);
  assert.equal(shared.calls.proof, 1);
  assert.equal(shared.calls.protectedOperations, 0);

  const reconnectMissions = new MissionService(new JsonMissionRepository(statePath), FIXED_NOW);
  const reconnectApp = createMissionHttpApp({
    missions: reconnectMissions,
    runner: new QueueSafetyRunner(reconnectMissions, shared),
    verifier: acceptedVerifier(),
  });
  const current = await missionView(reconnectApp);
  const implementation = ticketFor(current, "implementer");
  await authorize(reconnectApp, implementation.id, "proof-recovery-operator");
  const rework = await runMission(reconnectApp);
  assert.equal(ticketFor(rework.mission, "implementer").attempt, 2);
  assert.equal(shared.calls.turn, 2);
  assert.equal(shared.remoteMutations, 0);
  return {
    flow: "failed direct proof → inert Changes Requested → explicit rework",
    status: ticketFor(rework.mission, "implementer").status,
    attempts: ticketFor(rework.mission, "implementer").attempt,
    proofCalls: shared.calls.proof,
    remoteMutations: shared.remoteMutations,
    preparedStatus: prepared.status,
  };
}

async function runProofInfrastructureRetryScenario(directory) {
  const statePath = path.join(directory, "proof-infrastructure-retry.json");
  const shared = createSharedHarness({ infrastructureFailuresRemaining: 1 });
  const first = testApp(new JsonMissionRepository(statePath), shared);
  const prepared = await preparePendingApprovalButStopAtProof(first.app);
  const failed = await runMission(first.app);
  const failedTicket = ticketFor(failed.mission, "implementer");
  assert.equal(failedTicket.status, "proving");
  assert.equal(failedTicket.attempt, 1);
  assert.equal(failed.mission.approvals.length, 0);
  assert.equal(failed.mission.handoffs.length, 0);
  assert.equal(failed.mission.reviews.length, 0);
  assert.equal(shared.calls.turn, 1);
  assert.equal(shared.calls.proof, 1);

  const failedState = await first.missions.getState();
  const retryFinding = failedState.evidence.find((item) =>
    item.workItemId === failedTicket.id &&
    item.source === "system" &&
    item.result === "failed" &&
    JSON.parse(item.details).retryable === true,
  );
  assert.ok(retryFinding, "The provider failure must survive as durable retry evidence.");
  const failedEvidenceCount = failedState.evidence.length;

  const reconnectMissions = new MissionService(new JsonMissionRepository(statePath), FIXED_NOW);
  const reconnectApp = createMissionHttpApp({
    missions: reconnectMissions,
    runner: new QueueSafetyRunner(reconnectMissions, shared),
    verifier: acceptedVerifier(),
  });
  const reconnected = await missionView(reconnectApp);
  const reconnectedTicket = ticketFor(reconnected, "implementer");
  assert.equal(reconnectedTicket.status, "proving");
  assert.equal(reconnectedTicket.claim.trueforgeSessionId, SESSION_ID);
  assert.equal(reconnectedTicket.claim.trueforgeSandboxId, SANDBOX_ID);

  const recovered = await runMission(reconnectApp);
  const recoveredTicket = ticketFor(recovered.mission, "implementer");
  assert.equal(recoveredTicket.status, "awaiting_approval");
  assert.equal(recoveredTicket.attempt, 1);
  assert.equal(shared.calls.turn, 1);
  assert.equal(shared.calls.proof, 2);
  assert.equal(recovered.mission.handoffs.length, 1);
  assert.equal(recovered.mission.reviews.length, 1);
  assert.equal(recovered.mission.approvals.length, 1);
  const recoveredState = await reconnectMissions.getState();
  assert.ok(recoveredState.evidence.length > failedEvidenceCount);
  assert.equal(recoveredState.evidence.some((item) => item.id === retryFinding.id), true);

  return {
    flow: "proof infrastructure failure → reconnect → Proving retry without coding",
    status: recoveredTicket.status,
    attempts: recoveredTicket.attempt,
    codingTurns: shared.calls.turn,
    proofCalls: shared.calls.proof,
    evidencePreserved: true,
    preparedStatus: prepared.status,
  };
}

async function preparePendingApprovalButStopAtProof(app) {
  await createPrimary(app);
  let current = await missionView(app);
  const inspectTicket = ticketFor(current, "planner");
  await authorize(app, inspectTicket.id, "queue-operator");
  current = (await runMission(app)).mission;
  const implementation = ticketFor(current, "implementer");
  await authorize(app, implementation.id, "queue-operator");
  current = (await runMission(app)).mission;
  assert.equal(ticketFor(current, "implementer").status, "proving");
  return {
    status: ticketFor(current, "implementer").status,
  };
}

async function runOlderEvidenceAndCurrentFindingScenarios(directory) {
  const sourcePath = path.join(directory, "approval-source.json");
  const shared = createSharedHarness();
  const source = testApp(new JsonMissionRepository(sourcePath), shared);
  const prepared = await preparePendingApproval(source.app);
  const sourceState = await source.missions.getState();
  const currentApproval = sourceState.approvals.at(-1);
  const implementation = sourceState.workItems.find((item) => item.assignedRole === "implementer");
  const priorEvidence = sourceState.evidence.find((item) =>
    item.workItemId === implementation.id && item.attempt === 1 && item.source === "trueforge",
  );
  assert.ok(priorEvidence, "The approval fixture must contain prior attempt evidence.");

  const staleEvidencePath = path.join(directory, "approval-stale-evidence.json");
  const staleEvidenceState = structuredClone(sourceState);
  staleEvidenceState.approvals.at(-1).evidenceIds = [priorEvidence.id];
  await writeFile(staleEvidencePath, JSON.stringify(staleEvidenceState), "utf8");
  const staleMissions = new MissionService(new JsonMissionRepository(staleEvidencePath), FIXED_NOW);
  const staleShared = createSharedHarness();
  const staleRunner = new QueueSafetyRunner(staleMissions, staleShared);
  const staleApp = createMissionHttpApp({
    missions: staleMissions,
    runner: staleRunner,
    verifier: acceptedVerifier(),
  });
  const staleResult = await decide(staleApp, currentApproval, "approved");
  assert.equal(staleResult.response.status, 502);
  assert.match(staleResult.payload.message, /stale|current/i);
  assert.equal(staleShared.calls.protectedOperations, 0);
  assert.equal((await missionView(staleApp)).approvals.at(-1).decision, "pending");

  const findingPath = path.join(directory, "approval-current-finding.json");
  const findingState = structuredClone(sourceState);
  findingState.evidence.push({
    id: "queue-safety-current-finding",
    missionId: PRIMARY_MISSION_ID,
    workItemId: implementation.id,
    attempt: implementation.attempt,
    kind: "reviewer_finding",
    result: "failed",
    source: "reviewer",
    summary: "A late independent review finding remains unresolved.",
    createdAt: FIXED_NOW().toISOString(),
  });
  findingState.revision += 1;
  await writeFile(findingPath, JSON.stringify(findingState), "utf8");
  const findingMissions = new MissionService(new JsonMissionRepository(findingPath), FIXED_NOW);
  const findingShared = createSharedHarness();
  const findingRunner = new QueueSafetyRunner(findingMissions, findingShared);
  const findingApp = createMissionHttpApp({
    missions: findingMissions,
    runner: findingRunner,
    verifier: acceptedVerifier(),
  });
  const findingResult = await decide(findingApp, currentApproval, "approved");
  assert.equal(findingResult.response.status, 502);
  assert.match(findingResult.payload.message, /unresolved|finding/i);
  assert.equal(findingShared.calls.protectedOperations, 0);

  return {
    flow: "current-attempt correlation rejects prior evidence and late findings",
    staleEvidenceBlocked: staleResult.response.status === 502,
    currentFindingBlocked: findingResult.response.status === 502,
    protectedOperations: staleShared.calls.protectedOperations + findingShared.calls.protectedOperations,
    preparedStatus: prepared.implementation.status,
  };
}

async function runRejectedApprovalScenario(directory) {
  const statePath = path.join(directory, "rejected-approval.json");
  const shared = createSharedHarness();
  const fixture = testApp(new JsonMissionRepository(statePath), shared);
  const prepared = await preparePendingApproval(fixture.app);
  const result = await decide(fixture.app, prepared.approval, "rejected");
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.mission.mission.status, "blocked");
  assert.equal(ticketFor(result.payload.mission, "implementer").status, "blocked");
  assert.equal(result.payload.mission.delivery.length, 0);
  assert.equal(shared.calls.protectedOperations, 0);
  assert.equal(shared.calls.resolvedApprovals.at(-1).decision, "rejected");
  assert.equal(shared.remoteMutations, 0);
  return {
    flow: "rejected approval",
    status: result.payload.mission.mission.status,
    protectedOperations: shared.calls.protectedOperations,
    remoteMutations: shared.remoteMutations,
  };
}

async function runReadbackMismatchScenario(directory) {
  const statePath = path.join(directory, "readback-mismatch.json");
  const shared = createSharedHarness({ deliveryResultHeadSha: MISMATCHED_HEAD_SHA });
  const fixture = testApp(new JsonMissionRepository(statePath), shared);
  const prepared = await preparePendingApproval(fixture.app);
  const result = await decide(fixture.app, prepared.approval, "approved");
  assert.equal(result.response.status, 502);
  assert.match(result.payload.message, /head does not match|published branch|delivery/i);
  assert.equal(result.payload.mission.mission.status, "blocked");
  assert.equal(ticketFor(result.payload.mission, "implementer").status, "blocked");
  assert.equal(result.payload.mission.delivery.length, 0);
  assert.equal(shared.calls.protectedOperations, 1);
  assert.equal(shared.remoteMutations, 0);
  return {
    flow: "approved delivery read-back mismatch",
    status: result.payload.mission.mission.status,
    protectedOperations: shared.calls.protectedOperations,
    remoteMutations: shared.remoteMutations,
  };
}

export async function runQueueSafetyRecoveryIntegration() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-queue-safety-"));
  try {
    const semanticRework = await runSemanticReworkRecoveryScenario(directory);
    const proofFailure = await runProofFailureScenario(directory);
    const proofInfrastructureRetry = await runProofInfrastructureRetryScenario(directory);
    const staleCorrelation = await runOlderEvidenceAndCurrentFindingScenarios(directory);
    const rejectedApproval = await runRejectedApprovalScenario(directory);
    const readbackMismatch = await runReadbackMismatchScenario(directory);
    const summary = {
      temporaryState: "isolated temporary JSON repositories; removed after the run",
      semanticRework,
      proofFailure,
      proofInfrastructureRetry,
      staleCorrelation,
      rejectedApproval,
      readbackMismatch,
      remoteMutations: [
        semanticRework.remoteMutations,
        proofFailure.remoteMutations,
        proofInfrastructureRetry.remoteMutations ?? 0,
        rejectedApproval.remoteMutations,
        readbackMismatch.remoteMutations,
      ].reduce((total, count) => total + count, 0),
    };
    assert.equal(summary.remoteMutations, 0);
    return summary;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runQueueSafetyRecoveryIntegration()
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
