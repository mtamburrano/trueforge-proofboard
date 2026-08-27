import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  InMemoryMissionRepository,
  JsonMissionRepository,
  MissionDomainError,
  MissionService,
} from "../dist/index.js";

const ORIGIN = {
  kind: "trueforge",
  sessionId: "session-review",
  turnId: "turn-review",
  threadId: "thread-implementer",
};

function fixedClock() {
  return new Date("2026-08-27T14:00:00.000Z");
}

function domainError(code) {
  return (error) => error instanceof MissionDomainError && error.code === code;
}

async function reviewFixture({ repository = new InMemoryMissionRepository(), includeDiff = true } = {}) {
  const missions = new MissionService(repository, fixedClock);
  const mission = await missions.createMission({
    id: "mission-reviewer",
    objective: "Review a delegated implementation independently.",
    trueforgeSessionId: ORIGIN.sessionId,
  });
  const workItem = await missions.addWorkItem(mission.id, {
    id: "work-reviewer",
    title: "Implement and independently verify the change",
    purpose: "Keep implementation completion behind an independent review.",
    acceptanceCriteria: ["The changed state is reviewed with passing checks."],
    requiredChecks: ["typecheck", "test"],
    assignedRole: "implementer",
    status: "ready",
  });
  await missions.transitionWorkItem(mission.id, workItem.id, "in_progress");
  await missions.startWorkItemDelegation(mission.id, workItem.id, {
    owner: "bounded-implementer",
    threadId: ORIGIN.threadId,
    turnId: ORIGIN.turnId,
  });
  await missions.completeWorkItemDelegation(mission.id, workItem.id, {
    threadId: ORIGIN.threadId,
    turnId: ORIGIN.turnId,
  });

  const typecheck = await missions.addEvidence(mission.id, {
    id: "evidence-review-typecheck",
    workItemId: workItem.id,
    kind: "typecheck_result",
    result: "passed",
    source: "trueforge",
    summary: "The typecheck passed in the delegated execution.",
    executionOrigin: { ...ORIGIN, toolCallId: "call-review-typecheck" },
  });
  const tests = await missions.addEvidence(mission.id, {
    id: "evidence-review-test",
    workItemId: workItem.id,
    kind: "test_result",
    result: "passed",
    source: "trueforge",
    summary: "The tests passed in the delegated execution.",
    executionOrigin: { ...ORIGIN, toolCallId: "call-review-test" },
  });
  const evidenceIds = [typecheck.id, tests.id];
  if (includeDiff) {
    const diff = await missions.addEvidence(mission.id, {
      id: "evidence-review-diff",
      workItemId: workItem.id,
      kind: "diff_summary",
      result: "passed",
      source: "trueforge",
      summary: "The delegated execution returned the changed-file diff.",
      executionOrigin: { ...ORIGIN, toolCallId: "call-review-diff" },
    });
    evidenceIds.push(diff.id);
  }
  const handoff = await missions.recordHandoff(mission.id, {
    id: includeDiff ? "handoff-review-ready" : "handoff-review-insufficient",
    workItemId: workItem.id,
    result: "done",
    summary: "The implementer returned structured completion facts.",
    filesChanged: ["src/index.ts", "test/index.test.js"],
    testsRun: ["npm run typecheck", "npm test"],
    decisions: [],
    openQuestions: [],
    memoryImpact: "medium",
    diffSummary: "src/index.ts and test/index.test.js changed.",
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
    evidenceIds,
    executionOrigin: { ...ORIGIN },
  });
  await missions.transitionWorkItem(mission.id, workItem.id, "ready_for_review");
  return { missions, mission, workItem, handoff, evidenceIds };
}

test("review-ready work cannot complete from implementer proof alone", async () => {
  const { missions, mission, workItem } = await reviewFixture();

  await assert.rejects(
    missions.transitionWorkItem(mission.id, workItem.id, "complete"),
    domainError("invalid_transition"),
  );
  assert.equal((await missions.getWorkItem(mission.id, workItem.id)).status, "ready_for_review");
});

test("independent review rejects an apparently successful handoff without diff evidence", async () => {
  const { missions, mission, workItem } = await reviewFixture({ includeDiff: false });

  await assert.rejects(
    missions.getReviewContext(mission.id, workItem.id),
    domainError("invalid_transition"),
  );
  await assert.rejects(
    missions.reviewWorkItem(mission.id, {
      workItemId: workItem.id,
      outcome: "accepted",
      reviewer: "independent-verifier",
      summary: "The implementation appears complete.",
      finding: "The changed state could not be independently verified.",
    }),
    domainError("invalid_transition"),
  );
  const state = await missions.getState();
  assert.equal(state.reviews.length, 0);
  assert.equal(state.workItems[0].status, "ready_for_review");
});

test("independent review accepts adequate proof and persists the reviewed state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-review-"));
  const filePath = path.join(directory, "mission-state.json");
  try {
    const first = await reviewFixture({ repository: new JsonMissionRepository(filePath) });
    const context = await first.missions.getReviewContext(first.mission.id, first.workItem.id);
    assert.deepEqual(context.filesChanged, ["src/index.ts", "test/index.test.js"]);
    assert.equal(context.handoff.id, first.handoff.id);
    assert.deepEqual(context.evidence.map((item) => item.id), first.evidenceIds);
    assert.deepEqual(context.checks.map((check) => check.result), ["passed", "passed"]);

    const review = await first.missions.reviewWorkItem(first.mission.id, {
      workItemId: first.workItem.id,
      outcome: "accepted",
      reviewer: "independent-verifier",
      summary: "The changed state and required checks are independently verified.",
      finding: "No blocking findings.",
    });
    assert.equal(review.outcome, "accepted");
    assert.equal((await first.missions.getWorkItem(first.mission.id, first.workItem.id)).status, "complete");

    const second = new MissionService(new JsonMissionRepository(filePath), fixedClock);
    const restored = await second.getState();
    assert.equal(restored.reviews.length, 1);
    assert.equal(restored.reviews[0].handoffId, first.handoff.id);
    assert.equal(restored.reviews[0].findingEvidenceId.length > 0, true);
    assert.equal(restored.workItems[0].status, "complete");
    assert.equal((await second.getEvidence(first.mission.id, review.findingEvidenceId)).source, "reviewer");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("changes requested returns work to ready while preserving prior attempts and findings", async () => {
  const { missions, mission, workItem, handoff, evidenceIds } = await reviewFixture();

  const review = await missions.reviewWorkItem(mission.id, {
    workItemId: workItem.id,
    outcome: "changes_requested",
    reviewer: "independent-verifier",
    summary: "The implementation needs a correction before acceptance.",
    finding: "The transition helper must handle an unknown stage explicitly.",
  });
  const state = await missions.getState();
  assert.equal(state.workItems[0].status, "ready");
  assert.equal(state.handoffs.length, 1);
  assert.equal(state.handoffs[0].id, handoff.id);
  assert.deepEqual(state.evidence.slice(0, evidenceIds.length).map((item) => item.id), evidenceIds);
  assert.equal(state.reviews.length, 1);
  assert.equal(state.reviews[0].id, review.id);
  assert.equal(state.evidence.at(-1).id, review.findingEvidenceId);

  await missions.transitionWorkItem(mission.id, workItem.id, "in_progress");
  assert.equal((await missions.getWorkItem(mission.id, workItem.id)).status, "in_progress");
});

test("reviewer can block with a durable finding", async () => {
  const { missions, mission, workItem } = await reviewFixture();

  const review = await missions.reviewWorkItem(mission.id, {
    workItemId: workItem.id,
    outcome: "blocked",
    reviewer: "independent-verifier",
    summary: "The implementation is blocked pending clarification.",
    finding: "The acceptance contract is contradictory and needs a product decision.",
  });
  assert.equal(review.outcome, "blocked");
  assert.equal((await missions.getWorkItem(mission.id, workItem.id)).status, "blocked");
  const finding = await missions.getEvidence(mission.id, review.findingEvidenceId);
  assert.equal(finding.result, "failed");
  assert.match(finding.summary, /contradictory/);
});
