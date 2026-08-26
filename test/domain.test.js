import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  InMemoryMissionRepository,
  JsonMissionRepository,
  MissionDomainError,
  MissionService,
} from "../dist/index.js";

function fixedClock() {
  return new Date("2026-08-26T16:00:00.000Z");
}

function domainError(code) {
  return (error) => error instanceof MissionDomainError && error.code === code;
}

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
    reference: "https://example.test/review/1",
    verificationSummary: "Evidence and approval checks passed.",
  });

  const state = await service.getState();
  assert.equal(state.missions[0].status, "delivered");
  assert.equal(state.evidence[0].result, "passed");
  assert.equal(state.handoffs[0].result, "done");
  assert.equal(state.approvals[0].decision, "approved");
  assert.equal(delivery.status, "delivered");
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

    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(persisted.missions[0].id, mission.id);
    assert.equal(persisted.workItems[0].id, workItem.id);

    const reconnectedService = new MissionService(
      new JsonMissionRepository(filePath),
      fixedClock,
    );
    const restored = await reconnectedService.getState();
    assert.equal(restored.missions[0].objective, "Survive a process reconnect");
    assert.equal(restored.workItems[0].status, "ready");
    assert.equal(restored.revision, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
