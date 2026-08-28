import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  consequentialActions,
  InMemoryMissionRepository,
  JsonMissionRepository,
  MissionDomainError,
  MissionService,
  requiresHumanApproval,
} from "../dist/index.js";

function fixedClock() {
  return new Date("2026-08-26T16:00:00.000Z");
}

function domainError(code) {
  return (error) => error instanceof MissionDomainError && error.code === code;
}

test("action policy keeps discovery read-only and defaults unknown mutations to approval", () => {
  assert.deepEqual(consequentialActions, ["create_pull_request"]);
  assert.equal(requiresHumanApproval("inspect_repository"), false);
  assert.equal(requiresHumanApproval("run_sandbox_verification"), false);
  assert.equal(requiresHumanApproval("create_pull_request"), true);
  assert.equal(requiresHumanApproval("unclassified_remote_mutation"), true);
});

test("protected actions require a durable, matching, current approval", async () => {
  let now = new Date("2026-08-26T16:00:00.000Z");
  const service = new MissionService(
    new InMemoryMissionRepository(),
    () => now,
  );
  const mission = await service.createMission({
    id: "mission-approval-policy",
    objective: "Gate a remote delivery",
  });
  const evidence = await service.addEvidence(mission.id, {
    id: "evidence-approval-policy",
    kind: "test_result",
    result: "passed",
    source: "sandbox",
    summary: "The verified delivery checks passed.",
  });
  const request = await service.requestActionApproval(mission.id, {
    id: "approval-policy",
    action: "Open the verified delivery",
    actionType: "create_pull_request",
    target: "example/proof-board@main",
    rationale: "A remote repository mutation needs explicit human authorization.",
    expectedEffect: "Open a pull request containing the verified change.",
    evidenceIds: [evidence.id],
  });

  const persisted = await service.getState();
  assert.equal(persisted.approvals[0].actionType, "create_pull_request");
  assert.equal(
    persisted.approvals[0].rationale,
    "A remote repository mutation needs explicit human authorization.",
  );
  assert.deepEqual(persisted.approvals[0].evidenceIds, [evidence.id]);
  assert.equal(typeof persisted.approvals[0].expiresAt, "string");

  let executions = 0;
  const action = {
    action: "create_pull_request",
    target: "example/proof-board@main",
    expectedEffect: "Open a pull request containing the verified change.",
    approvalId: request.id,
  };
  await assert.rejects(
    service.executeProtectedAction(mission.id, { ...action, approvalId: undefined }, () => {
      executions += 1;
    }),
    domainError("approval_blocked"),
  );
  assert.equal(executions, 0);
  await assert.rejects(
    service.executeProtectedAction(mission.id, action, () => {
      executions += 1;
    }),
    domainError("approval_blocked"),
  );
  assert.equal(executions, 0);

  await service.decideApproval(mission.id, request.id, {
    decision: "rejected",
    decidedBy: "human-reviewer",
  });
  await assert.rejects(
    service.executeProtectedAction(mission.id, action, () => {
      executions += 1;
    }),
    domainError("approval_blocked"),
  );
  assert.equal(executions, 0);

  const approved = await service.requestActionApproval(mission.id, {
    id: "approval-policy-approved",
    action: "create_pull_request",
    target: action.target,
    rationale: "The verified evidence supports this remote change.",
    expectedEffect: action.expectedEffect,
    evidenceIds: [evidence.id],
  });
  await service.decideApproval(mission.id, approved.id, {
    decision: "approved",
    decidedBy: "human-reviewer",
  });
  const result = await service.executeProtectedAction(mission.id, {
    ...action,
    approvalId: approved.id,
  }, () => {
    executions += 1;
    return "executed";
  });
  assert.equal(result, "executed");
  assert.equal(executions, 1);

  const readOnlyResult = await service.executeProtectedAction(mission.id, {
    action: "inspect_repository",
    target: "example/proof-board@main",
    expectedEffect: "Read the pinned repository state.",
  }, () => "discovered");
  assert.equal(readOnlyResult, "discovered");

  now = new Date("2026-08-26T16:30:00.000Z");
  await assert.rejects(
    service.executeProtectedAction(mission.id, {
      action: "create_pull_request",
      target: action.target,
      expectedEffect: action.expectedEffect,
      approvalId: approved.id,
    }, () => {
      executions += 1;
    }),
    domainError("approval_blocked"),
  );
  assert.equal(executions, 1);
});

test("malformed approval requests fail before persistence", async () => {
  const service = new MissionService(new InMemoryMissionRepository(), fixedClock);
  const mission = await service.createMission({
    id: "mission-malformed-approval",
    objective: "Reject malformed approval input",
  });

  await assert.rejects(
    service.requestApproval(mission.id, {
      action: "create_pull_request",
      target: "example/proof-board@main",
      expectedEffect: "Open a pull request.",
      expiresAt: "not-a-timestamp",
    }),
    domainError("invalid_input"),
  );
  await assert.rejects(
    service.requestApproval(mission.id, {
      action: "create_pull_request",
      target: "example/proof-board@main",
      rationale: "",
      expectedEffect: "Open a pull request.",
    }),
    domainError("invalid_input"),
  );
  await assert.rejects(
    service.requestActionApproval(mission.id, {
      action: "create_pull_request",
      target: "example/proof-board@main",
      rationale: "A remote mutation needs explicit approval.",
      expectedEffect: "Open a pull request.",
    }),
    domainError("invalid_input"),
  );
  await assert.rejects(
    service.requestActionApproval(mission.id, {
      action: "create_pull_request",
      target: "example/proof-board@main",
      rationale: "A remote mutation needs explicit approval.",
      expectedEffect: "Open a pull request.",
      evidenceIds: [],
    }),
    domainError("invalid_input"),
  );
  assert.deepEqual((await service.getState()).approvals, []);
});

test("legacy evidence-less approvals load but cannot authorize protected actions", async () => {
  const service = new MissionService(new InMemoryMissionRepository(), fixedClock);
  const mission = await service.createMission({
    id: "mission-legacy-approval",
    objective: "Keep legacy approval state fail closed",
  });
  const evidence = await service.addEvidence(mission.id, {
    id: "evidence-legacy-approval",
    kind: "test_result",
    result: "passed",
    source: "sandbox",
    summary: "The delivery checks passed.",
  });
  const approval = await service.requestActionApproval(mission.id, {
    id: "approval-legacy-without-evidence",
    action: "create_pull_request",
    target: "example/proof-board@main",
    rationale: "A remote mutation needs explicit approval.",
    expectedEffect: "Open a pull request.",
    evidenceIds: [evidence.id],
  });
  await service.decideApproval(mission.id, approval.id, {
    decision: "approved",
    decidedBy: "human-reviewer",
  });

  const legacyState = await service.getState();
  legacyState.approvals[0].evidenceIds = [];
  const reloaded = new MissionService(new InMemoryMissionRepository(legacyState), fixedClock);
  let executions = 0;

  await assert.rejects(
    reloaded.executeProtectedAction(mission.id, {
      action: "create_pull_request",
      target: "example/proof-board@main",
      expectedEffect: "Open a pull request.",
      approvalId: approval.id,
    }, () => {
      executions += 1;
    }),
    domainError("approval_blocked"),
  );
  assert.equal(executions, 0);
});

test("work-item transitions enforce dependencies and a finite state machine", async () => {
  const service = new MissionService(new InMemoryMissionRepository(), fixedClock);
  const mission = await service.createMission({
    id: "mission-dependency-test",
    objective: "Verify dependency gating",
  });
  const foundation = await service.addWorkItem(mission.id, {
    id: "work-foundation",
    title: "Prepare foundation",
    purpose: "Create the prerequisite work.",
  });
  const dependent = await service.addWorkItem(mission.id, {
    id: "work-dependent",
    title: "Use foundation",
    purpose: "Only run after the prerequisite is complete.",
    dependsOn: [foundation.id],
  });

  await assert.rejects(
    service.transitionWorkItem(mission.id, dependent.id, "ready"),
    domainError("dependency_blocked"),
  );
  await assert.rejects(
    service.transitionWorkItem(mission.id, foundation.id, "complete"),
    domainError("invalid_transition"),
  );

  await service.transitionWorkItem(mission.id, foundation.id, "ready");
  await service.transitionWorkItem(mission.id, foundation.id, "in_progress");
  await service.transitionWorkItem(mission.id, foundation.id, "ready_for_review");
  await service.transitionWorkItem(mission.id, foundation.id, "complete");
  await service.transitionWorkItem(mission.id, dependent.id, "ready");

  assert.equal(await service.canStartWorkItem(mission.id, dependent.id), true);
  const state = await service.getState();
  assert.equal(state.workItems.find((item) => item.id === dependent.id).status, "ready");
  assert.equal(state.revision, 8);
});

test("mission lifecycle stores typed evidence, handoffs, approvals, and delivery", async () => {
  const service = new MissionService(new InMemoryMissionRepository(), fixedClock);
  const mission = await service.createMission({
    id: "mission-lifecycle-test",
    objective: "Deliver a verified change",
  });
  const workItem = await service.addWorkItem(mission.id, {
    id: "work-lifecycle",
    title: "Implement change",
    purpose: "Make and verify the requested change.",
    status: "ready",
    assignedRole: "implementer",
  });

  await service.transitionMission(mission.id, "planning");
  await service.transitionMission(mission.id, "executing");
  await service.transitionWorkItem(mission.id, workItem.id, "in_progress");
  await service.transitionWorkItem(mission.id, workItem.id, "ready_for_review");
  await service.transitionWorkItem(mission.id, workItem.id, "complete");
  const evidence = await service.addEvidence(mission.id, {
    id: "evidence-tests",
    workItemId: workItem.id,
    kind: "test_result",
    result: "passed",
    source: "sandbox",
    summary: "The focused test suite passed.",
  });
  const handoff = await service.recordHandoff(mission.id, {
    id: "handoff-lifecycle",
    workItemId: workItem.id,
    result: "done",
    summary: "The change is ready for independent verification.",
    testsRun: ["npm test"],
    filesChanged: ["src/domain.ts"],
    memoryImpact: "medium",
  });
  const approval = await service.requestApproval(mission.id, {
    id: "approval-delivery",
    action: "Open the verified delivery",
    target: "the configured repository",
    risk: "A remote change will be created.",
    expectedEffect: "Publish the verified patch for review.",
    evidenceIds: [evidence.id],
    executionContext: {
      sessionId: "session-delivery",
      turnId: "turn-approval",
      threadId: "thread-delivery",
      toolCallId: "call-create-pr",
      serverName: "github",
      toolName: "create_pull_request",
      repositoryOwner: "example",
      repositoryName: "proof-board",
      base: "main",
      head: "verified-delivery",
      title: "Publish the verified delivery",
      body: "Contains only the independently verified fixture change.",
    },
  });

  await service.transitionMission(mission.id, "awaiting_approval");
  await service.decideApproval(mission.id, approval.id, {
    decision: "approved",
    decidedBy: "human-reviewer",
  });
  await service.transitionMission(mission.id, "verifying");
  const delivery = await service.recordDelivery(mission.id, {
    id: "delivery-lifecycle",
    status: "delivered",
    reference: "https://github.com/example/proof-board/pull/1",
    verificationSummary: "Evidence and approval checks passed.",
    approvalId: approval.id,
    pullRequest: {
      number: 1,
      url: "https://github.com/example/proof-board/pull/1",
      repositoryOwner: "example",
      repositoryName: "proof-board",
      base: "main",
      head: "verified-delivery",
    },
    executionOrigin: {
      kind: "mcp",
      sessionId: "session-delivery",
      turnId: "turn-delivery-result",
      threadId: "thread-delivery",
      toolCallId: "call-create-pr",
    },
  });

  const state = await service.getState();
  assert.equal(state.missions[0].status, "delivered");
  assert.equal(state.evidence[0].result, "passed");
  assert.equal(state.handoffs[0].result, "done");
  assert.equal(state.approvals[0].decision, "approved");
  assert.equal(delivery.status, "delivered");
  assert.equal(delivery.pullRequest.number, 1);
  assert.equal(delivery.approvalId, approval.id);
  assert.equal(delivery.executionOrigin.turnId, "turn-delivery-result");
  assert.equal(handoff.memoryImpact, "medium");
});

test("JSON persistence restores mission state for a new service instance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-domain-"));
  const filePath = path.join(directory, "mission-state.json");
  try {
    const firstService = new MissionService(new JsonMissionRepository(filePath), fixedClock);
    const mission = await firstService.createMission({
      id: "mission-reconnect-test",
      objective: "Survive a process reconnect",
      repository: { owner: "example", name: "proof-board", ref: "main" },
    });
    const workItem = await firstService.addWorkItem(mission.id, {
      id: "work-reconnect",
      title: "Persist work",
      purpose: "Keep the mission state available after reconnect.",
      status: "ready",
    });
    await firstService.attachTrueforgeTurn(mission.id, "turn-reconnect");
    await firstService.attachTrueforgeSandbox(mission.id, "sandbox-reconnect");

    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(persisted.missions[0].id, mission.id);
    assert.equal(persisted.workItems[0].id, workItem.id);
    assert.equal(persisted.missions[0].trueforgeTurnId, "turn-reconnect");
    assert.equal(persisted.missions[0].trueforgeSandboxId, "sandbox-reconnect");

    const reconnectedService = new MissionService(
      new JsonMissionRepository(filePath),
      fixedClock,
    );
    const restored = await reconnectedService.getState();
    assert.equal(restored.missions[0].objective, "Survive a process reconnect");
    assert.equal(restored.workItems[0].status, "ready");
    assert.equal(restored.missions[0].trueforgeTurnId, "turn-reconnect");
    assert.equal(restored.missions[0].trueforgeSandboxId, "sandbox-reconnect");
    assert.equal(restored.revision, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
