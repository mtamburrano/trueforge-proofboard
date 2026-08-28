import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildDelegatedWorkspaceDeltaCommand,
  DELEGATED_WORKSPACE_TREE_SNAPSHOT_COMMAND,
  JsonMissionRepository,
  MissionDomainError,
  MissionService,
  TrueForgeMissionRunner,
} from "../dist/index.js";

export const DELEGATED_DELIVERY_FIXTURE = Object.freeze({
  missionId: "mission-proof-loop-dependent-loop",
  malformedMissionId: "mission-proof-loop-malformed-loop",
  uncorrelatedMissionId: "mission-proof-loop-uncorrelated-loop",
  blockedReviewMissionId: "mission-proof-loop-blocked-review-loop",
  sessionId: "session-proof-loop-dependent-loop",
  repository: { owner: "fixture", name: "proof-board", ref: "proof-loop-reset" },
  graph: {
    items: [
      {
        id: "proof-loop-root",
        title: "Complete the foundation change",
        purpose: "Run the first bounded implementation in the dependency chain.",
        acceptanceCriteria: ["The foundation change has a structured handoff and review."],
        dependsOn: [],
        assignedRole: "implementer",
        requiredChecks: ["typecheck", "test"],
        allowedFiles: ["src/turn-1.ts", "test/turn-1.test.js"],
      },
      {
        id: "proof-loop-dependent",
        title: "Complete the dependent change",
        purpose: "Run only after the foundation has passed independent review.",
        acceptanceCriteria: ["The dependent change unlocks only after reviewed completion."],
        dependsOn: ["proof-loop-root"],
        assignedRole: "implementer",
        requiredChecks: ["typecheck", "test"],
        allowedFiles: [
          "src/turn-2.ts",
          "test/turn-2.test.js",
          "src/turn-3.ts",
          "test/turn-3.test.js",
        ],
      },
      {
        id: "proof-loop-terminal",
        title: "Complete the terminal change",
        purpose: "Run only after the dependent change has passed independent review.",
        acceptanceCriteria: ["The terminal change runs after the complete dependency chain."],
        dependsOn: ["proof-loop-dependent"],
        assignedRole: "implementer",
        requiredChecks: ["typecheck", "test"],
        allowedFiles: ["src/turn-4.ts", "test/turn-4.test.js"],
      },
    ],
  },
});

function fixedClock() {
  return new Date("2026-08-27T15:00:00.000Z");
}

function fakeStream(events) {
  return {
    async *withMetadata() {
      for (const event of events) {
        yield { data: event };
      }
    },
  };
}

const WORKSPACE_BASELINE_TREE = "a".repeat(40);

function treeRefForAttempt(attempt) {
  return String.fromCharCode("a".charCodeAt(0) + attempt - 1).repeat(40);
}

function coordinatorEvents(command, output, turnId) {
  const callId = `${turnId}-call`;
  return [
    { type: "turn.created", id: `${turnId}-created`, turnId, threadId: null, state: { status: "running" } },
    {
      type: "model.message",
      id: `${turnId}-model`,
      threadId: null,
      toolCalls: [{ id: callId, function: { name: "exec", arguments: JSON.stringify({ command }) } }],
    },
    {
      type: "tool.response",
      id: `${turnId}-response`,
      threadId: null,
      toolCallId: callId,
      content: JSON.stringify({ success: true, response: { exitCode: 0, result: output } }),
    },
    { type: "turn.done", id: `${turnId}-done`, threadId: null, state: { status: "done", requiredActions: [] } },
  ];
}

function workspaceDeltaOutput(startTreeRef, missionStartTreeRef, endTreeRef, currentFiles, cumulativeFiles) {
  const statusOutput = (files) => files.map((file) => `M\t${file}`).join("\n");
  return [
    `TRUEFORGE_WORKSPACE_DELTA start=${startTreeRef} mission_start=${missionStartTreeRef} end=${endTreeRef}`,
    "TRUEFORGE_WORKSPACE_DELTA current_begin",
    statusOutput(currentFiles),
    "TRUEFORGE_WORKSPACE_DELTA current_end",
    "TRUEFORGE_WORKSPACE_DELTA cumulative_begin",
    statusOutput(cumulativeFiles),
    "TRUEFORGE_WORKSPACE_DELTA cumulative_end",
    "",
  ].join("\n");
}

function delegatedEvents(attempt, { malformedCompletion = false } = {}) {
  const turnId = `turn-proof-loop-${attempt}`;
  const threadId = `thread-proof-loop-${attempt}`;
  const sourceFile = `src/${attempt}.ts`;
  const testFile = `test/${attempt}.test.js`;
  const response = (id, callId, output) => ({
    type: "tool.response",
    id,
    createdAt: "2026-08-27T15:00:02.000Z",
    threadId,
    toolCallId: callId,
    content: JSON.stringify({
      success: true,
      response: { exitCode: 0, result: output },
    }),
  });
  const events = [
    {
      type: "turn.created",
      id: `event-turn-${attempt}`,
      createdAt: "2026-08-27T15:00:01.000Z",
      threadId: null,
      turnId,
      state: { status: "running" },
    },
    {
      type: "thread.created",
      id: `event-thread-${attempt}`,
      createdAt: "2026-08-27T15:00:01.100Z",
      threadId,
      agentInfo: {
        type: "dynamic",
        name: "bounded-implementer",
        input: "Work Packet: execute one bounded fixture item.",
      },
    },
    {
      type: "model.message",
      id: `event-model-${attempt}`,
      createdAt: "2026-08-27T15:00:01.500Z",
      threadId,
      toolCalls: [
        {
          id: `call-check-${attempt}`,
          function: {
            name: "exec",
            arguments: JSON.stringify({ command: "npm run typecheck && npm test" }),
          },
        },
        {
          id: `call-manifest-${attempt}`,
          function: {
            name: "exec",
            arguments: JSON.stringify({ command: "git status --porcelain=v1 -z --untracked-files=all" }),
          },
        },
        {
          id: `call-diff-${attempt}`,
          function: {
            name: "exec",
            arguments: JSON.stringify({ command: "git diff" }),
          },
        },
      ],
    },
    response(
      `event-check-response-${attempt}`,
      `call-check-${attempt}`,
      "typecheck passed\ntests passed\n",
    ),
    response(
      `event-manifest-response-${attempt}`,
      `call-manifest-${attempt}`,
      ` M ${sourceFile}\u0000 M ${testFile}\u0000`,
    ),
    response(
      `event-diff-response-${attempt}`,
      `call-diff-${attempt}`,
      `diff --git a/${sourceFile} b/${sourceFile}\nindex 1111111..2222222 100644\n--- a/${sourceFile}\n+++ b/${sourceFile}\n@@ -1 +1,2 @@\n export const before = true;\n+export const after = true;\ndiff --git a/${testFile} b/${testFile}\nindex 3333333..4444444 100644\n--- a/${testFile}\n+++ b/${testFile}\n@@ -1 +1,2 @@\n test(\"before\", () => {});\n+test(\"after\", () => {});`,
    ),
    {
      type: "thread.done",
      id: `event-thread-done-${attempt}`,
      createdAt: "2026-08-27T15:00:03.000Z",
      threadId,
      state: malformedCompletion
        ? { status: "done" }
        : {
            status: "done",
            output: {
              type: "model.message",
              id: `event-subagent-output-${attempt}`,
              createdAt: "2026-08-27T15:00:03.000Z",
              threadId,
              content: JSON.stringify({
                decisions: ["Kept the fixture change within the bounded work item."],
                openQuestions: [],
              }),
            },
          },
    },
    {
      type: "turn.done",
      id: `event-turn-done-${attempt}`,
      createdAt: "2026-08-27T15:00:04.000Z",
      threadId: null,
      state: { status: "done", requiredActions: [] },
    },
  ];
  return events;
}

function fakeClient({ sessionId, malformedCompletion = false }) {
  const calls = { create: [], get: [], updates: [], turns: [] };
  let turnNumber = 0;
  return {
    calls,
    client: {
      sessions: {
        async create(request) {
          calls.create.push(request);
          return { data: { id: sessionId } };
        },
        async get(requestedSessionId) {
          calls.get.push(requestedSessionId);
          return { data: { id: requestedSessionId } };
        },
        async update(requestedSessionId, request) {
          calls.updates.push({ sessionId: requestedSessionId, request });
          return { data: { id: requestedSessionId } };
        },
        async createTurnStream(requestedSessionId, request) {
          const currentTurnNumber = turnNumber++;
          const attemptNumber = Math.floor(currentTurnNumber / 3) + 1;
          const attempt = `turn-${attemptNumber}`;
          calls.turns.push({ sessionId: requestedSessionId, request });
          if (currentTurnNumber % 3 === 0) {
            const startTreeRef = treeRefForAttempt(attemptNumber);
            return fakeStream(coordinatorEvents(
              DELEGATED_WORKSPACE_TREE_SNAPSHOT_COMMAND,
              `TRUEFORGE_WORKSPACE_TREE ${startTreeRef}\n`,
              `turn-proof-loop-start-${attemptNumber}`,
            ));
          }
          if (currentTurnNumber % 3 === 2) {
            const startTreeRef = treeRefForAttempt(attemptNumber);
            const endTreeRef = treeRefForAttempt(attemptNumber + 1);
            const currentFiles = [`src/${attempt}.ts`, `test/${attempt}.test.js`];
            const cumulativeFiles = Array.from({ length: attemptNumber }, (_, index) => {
              const fileAttempt = `turn-${index + 1}`;
              return [`src/${fileAttempt}.ts`, `test/${fileAttempt}.test.js`];
            }).flat();
            const command = buildDelegatedWorkspaceDeltaCommand(startTreeRef, WORKSPACE_BASELINE_TREE);
            return fakeStream(coordinatorEvents(
              command,
              workspaceDeltaOutput(
                startTreeRef,
                WORKSPACE_BASELINE_TREE,
                endTreeRef,
                currentFiles,
                cumulativeFiles,
              ),
              `turn-proof-loop-delta-${attemptNumber}`,
            ));
          }
          return fakeStream(delegatedEvents(attempt, { malformedCompletion }));
        },
      },
    },
  };
}

function runnerFor(missions, client) {
  return new TrueForgeMissionRunner(missions, client, {
    model: "alibaba/qwen3-7-plus",
    dynamicSubAgents: true,
  });
}

function domainError(code) {
  return (error) => error instanceof MissionDomainError && error.code === code;
}

async function recordHandoff(missions, missionId, workItemId, execution) {
  const draft = execution.implementationHandoff;
  assert.ok(draft, "The deterministic delegated turn must produce a structured handoff.");
  return missions.recordHandoff(missionId, {
    workItemId,
    result: "done",
    summary: "The fixture implementation returned structured completion facts.",
    filesChanged: draft.filesChanged,
    testsRun: [...new Set(draft.checks.map((check) => check.command))],
    decisions: draft.decisions,
    openQuestions: draft.openQuestions,
    memoryImpact: "medium",
    diffSummary: draft.diffSummary,
    checks: draft.checks,
    evidenceIds: draft.evidenceIds,
    executionOrigin: draft.executionOrigin,
  });
}

async function runImplementation(missions, runner, missionId, workItemId, attempt) {
  const before = await missions.getWorkItem(missionId, workItemId);
  assert.equal(before.status, "ready");
  await missions.transitionWorkItem(missionId, workItemId, "in_progress");
  const execution = await runner.runTurn(
    missionId,
    `Run deterministic fixture attempt ${attempt}.`,
    { workItemId, delegateToSubagent: true },
  );
  await recordHandoff(missions, missionId, workItemId, execution);
  await missions.transitionWorkItem(missionId, workItemId, "ready_for_review");
}

async function runMalformedScenario(repository) {
  const missions = new MissionService(repository, fixedClock);
  const { client, calls } = fakeClient({
    sessionId: "session-proof-loop-malformed-loop",
    malformedCompletion: true,
  });
  const runner = runnerFor(missions, client);
  const mission = await runner.createMission({
    id: DELEGATED_DELIVERY_FIXTURE.malformedMissionId,
    objective: "Keep malformed delegated completion from unlocking a dependent.",
    repository: DELEGATED_DELIVERY_FIXTURE.repository,
  });
  await missions.transitionMission(mission.id, "planning");
  await missions.transitionMission(mission.id, "executing");
  await missions.persistWorkGraph(mission.id, {
    items: [
      {
        ...DELEGATED_DELIVERY_FIXTURE.graph.items[0],
        id: "proof-loop-malformed-root",
        allowedFiles: ["src/turn-1.ts", "test/turn-1.test.js"],
      },
      {
        ...DELEGATED_DELIVERY_FIXTURE.graph.items[1],
        id: "proof-loop-malformed-dependent",
        dependsOn: ["proof-loop-malformed-root"],
      },
    ],
  });
  await missions.transitionWorkItem(mission.id, "proof-loop-malformed-root", "in_progress");
  await assert.rejects(
    runner.runTurn(mission.id, "Return a malformed delegated completion.", {
      workItemId: "proof-loop-malformed-root",
      delegateToSubagent: true,
    }),
    (error) => /malformed|uncorrelated|interrupted/i.test(error.message),
  );
  const state = await missions.getState();
  const root = state.workItems.find((item) => item.id === "proof-loop-malformed-root");
  assert.equal(root.delegation.status, "interrupted");
  assert.equal(await missions.canStartWorkItem(mission.id, "proof-loop-malformed-dependent"), false);
  await assert.rejects(
    missions.transitionWorkItem(mission.id, "proof-loop-malformed-dependent", "ready"),
    domainError("dependency_blocked"),
  );
  assert.equal(state.handoffs.filter((handoff) => handoff.missionId === mission.id).length, 0);
  assert.equal(calls.turns.length, 2);
  return {
    missionId: mission.id,
    rootDelegationStatus: root.delegation.status,
    dependentStatus: state.workItems.find((item) => item.id === "proof-loop-malformed-dependent").status,
    handoffCount: state.handoffs.filter((handoff) => handoff.missionId === mission.id).length,
  };
}

function twoNodeScenarioGraph(prefix, rootAttempt = "turn-1") {
  return {
    items: [
      {
        ...DELEGATED_DELIVERY_FIXTURE.graph.items[0],
        id: `${prefix}-root`,
        allowedFiles: [`src/${rootAttempt}.ts`, `test/${rootAttempt}.test.js`],
      },
      {
        ...DELEGATED_DELIVERY_FIXTURE.graph.items[1],
        id: `${prefix}-dependent`,
        dependsOn: [`${prefix}-root`],
      },
    ],
  };
}

async function runUncorrelatedEvidenceScenario(repository) {
  const missions = new MissionService(repository, fixedClock);
  const { client } = fakeClient({ sessionId: "session-proof-loop-uncorrelated-loop" });
  const runner = runnerFor(missions, client);
  const mission = await runner.createMission({
    id: DELEGATED_DELIVERY_FIXTURE.uncorrelatedMissionId,
    objective: "Keep cross-thread proof from unlocking a dependent.",
    repository: DELEGATED_DELIVERY_FIXTURE.repository,
  });
  await missions.transitionMission(mission.id, "planning");
  await missions.transitionMission(mission.id, "executing");
  await missions.persistWorkGraph(mission.id, twoNodeScenarioGraph("proof-loop-uncorrelated"));
  await missions.transitionWorkItem(mission.id, "proof-loop-uncorrelated-root", "in_progress");
  const execution = await runner.runTurn(
    mission.id,
    "Produce valid child execution history before the forged proof attempt.",
    { workItemId: "proof-loop-uncorrelated-root", delegateToSubagent: true },
  );
  const draft = execution.implementationHandoff;
  assert.ok(draft);
  const childHistoryIds = [...draft.evidenceIds];
  const forged = await missions.addEvidence(mission.id, {
    workItemId: "proof-loop-uncorrelated-root",
    kind: "typecheck_result",
    result: "passed",
    source: "trueforge",
    summary: "A parent-thread check must not prove delegated work.",
    executionOrigin: {
      kind: "trueforge",
      sessionId: draft.executionOrigin.sessionId,
      turnId: draft.executionOrigin.turnId,
      threadId: "thread-parent-forged-proof",
      toolCallId: "call-parent-forged-proof",
    },
  });
  const forgedChecks = draft.checks.map((check, index) => index === 0
    ? { ...check, evidenceIds: [forged.id] }
    : check);
  await assert.rejects(
    missions.recordHandoff(mission.id, {
      workItemId: "proof-loop-uncorrelated-root",
      result: "done",
      summary: "This handoff must be rejected because one required check is cross-thread.",
      filesChanged: draft.filesChanged,
      testsRun: [...new Set(forgedChecks.map((check) => check.command))],
      decisions: draft.decisions,
      openQuestions: draft.openQuestions,
      memoryImpact: "medium",
      diffSummary: draft.diffSummary,
      checks: forgedChecks,
      evidenceIds: [...new Set([...draft.evidenceIds, forged.id])],
      executionOrigin: draft.executionOrigin,
    }),
    (error) => domainError("invalid_input")(error) && /different execution thread/.test(error.message),
  );
  const state = await missions.getState();
  assert.equal(childHistoryIds.every((id) => state.evidence.some((item) => item.id === id)), true);
  assert.equal(state.evidence.some((item) => item.id === forged.id), true);
  assert.equal(state.handoffs.some((item) => item.missionId === mission.id), false);
  assert.equal(await missions.canStartWorkItem(mission.id, "proof-loop-uncorrelated-dependent"), false);
  await assert.rejects(
    missions.transitionWorkItem(mission.id, "proof-loop-uncorrelated-dependent", "ready"),
    domainError("dependency_blocked"),
  );
  return {
    missionId: mission.id,
    retainedEvidenceCount: state.evidence.filter((item) => item.missionId === mission.id).length,
    dependentStatus: state.workItems.find((item) => item.id === "proof-loop-uncorrelated-dependent").status,
    handoffCount: state.handoffs.filter((item) => item.missionId === mission.id).length,
  };
}

async function runBlockedReviewScenario(repository) {
  const missions = new MissionService(repository, fixedClock);
  const { client } = fakeClient({ sessionId: "session-proof-loop-blocked-review-loop" });
  const runner = runnerFor(missions, client);
  const mission = await runner.createMission({
    id: DELEGATED_DELIVERY_FIXTURE.blockedReviewMissionId,
    objective: "Keep a blocked review from unlocking a dependent.",
    repository: DELEGATED_DELIVERY_FIXTURE.repository,
  });
  await missions.transitionMission(mission.id, "planning");
  await missions.transitionMission(mission.id, "executing");
  await missions.persistWorkGraph(mission.id, twoNodeScenarioGraph("proof-loop-blocked", "turn-1"));
  await runImplementation(missions, runner, mission.id, "proof-loop-blocked-root", "blocked-root");
  const historyBeforeReview = {
    handoffs: (await missions.listHandoffs(mission.id, "proof-loop-blocked-root")).length,
    evidence: (await missions.listEvidence(mission.id, "proof-loop-blocked-root")).length,
  };
  const review = await missions.reviewWorkItem(mission.id, {
    workItemId: "proof-loop-blocked-root",
    outcome: "blocked",
    reviewer: "independent-verifier",
    summary: "Independent verification blocked the fixture attempt.",
    finding: "The bounded content diff exposes an unresolved compatibility risk.",
  });
  assert.equal((await missions.getWorkItem(mission.id, "proof-loop-blocked-root")).status, "blocked");
  assert.equal(await missions.canStartWorkItem(mission.id, "proof-loop-blocked-dependent"), false);
  await assert.rejects(
    missions.transitionWorkItem(mission.id, "proof-loop-blocked-dependent", "ready"),
    domainError("dependency_blocked"),
  );
  const state = await missions.getState();
  assert.equal(state.handoffs.filter((item) => item.missionId === mission.id).length, historyBeforeReview.handoffs);
  assert.equal(
    state.evidence.filter((item) => item.missionId === mission.id && item.workItemId === "proof-loop-blocked-root").length,
    historyBeforeReview.evidence + 1,
  );
  return {
    missionId: mission.id,
    reviewOutcome: review.outcome,
    rootStatus: state.workItems.find((item) => item.id === "proof-loop-blocked-root").status,
    dependentStatus: state.workItems.find((item) => item.id === "proof-loop-blocked-dependent").status,
    handoffCount: state.handoffs.filter((item) => item.missionId === mission.id).length,
  };
}

export async function runDelegatedDeliveryIntegration() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-proof-loop-reset-"));
  const statePath = path.join(directory, "mission-state.json");
  try {
    const repository = new JsonMissionRepository(statePath);
    let missions = new MissionService(repository, fixedClock);
    const { client, calls } = fakeClient({ sessionId: DELEGATED_DELIVERY_FIXTURE.sessionId });
    let runner = runnerFor(missions, client);
    const mission = await runner.createMission({
      id: DELEGATED_DELIVERY_FIXTURE.missionId,
      objective: "Exercise a reviewed dependency chain with deterministic retry history.",
      repository: DELEGATED_DELIVERY_FIXTURE.repository,
    });
    await missions.transitionMission(mission.id, "planning");
    await missions.transitionMission(mission.id, "executing");
    await missions.persistWorkGraph(mission.id, DELEGATED_DELIVERY_FIXTURE.graph);

    assert.equal(await missions.canStartWorkItem(mission.id, "proof-loop-root"), true);
    assert.equal(await missions.canStartWorkItem(mission.id, "proof-loop-dependent"), false);
    await assert.rejects(
      missions.transitionWorkItem(mission.id, "proof-loop-dependent", "ready"),
      domainError("dependency_blocked"),
    );

    await runImplementation(missions, runner, mission.id, "proof-loop-root", "root-1");
    assert.equal(await missions.canStartWorkItem(mission.id, "proof-loop-dependent"), false);
    await missions.reviewWorkItem(mission.id, {
      workItemId: "proof-loop-root",
      outcome: "accepted",
      reviewer: "independent-verifier",
      summary: "The root changed state and required checks are independently verified.",
      finding: "No blocking findings for the foundation change.",
    });
    assert.equal((await missions.getWorkItem(mission.id, "proof-loop-root")).status, "complete");

    missions = new MissionService(repository, fixedClock);
    runner = runnerFor(missions, client);
    assert.equal(await missions.canStartWorkItem(mission.id, "proof-loop-dependent"), false);
    await missions.transitionWorkItem(mission.id, "proof-loop-dependent", "ready");
    assert.equal(await missions.canStartWorkItem(mission.id, "proof-loop-dependent"), true);
    await runImplementation(missions, runner, mission.id, "proof-loop-dependent", "dependent-1");
    const firstDependentHandoffCount = (await missions.listHandoffs(mission.id, "proof-loop-dependent")).length;
    const firstDependentEvidenceCount = (await missions.listEvidence(mission.id, "proof-loop-dependent")).length;
    await missions.reviewWorkItem(mission.id, {
      workItemId: "proof-loop-dependent",
      outcome: "changes_requested",
      reviewer: "independent-verifier",
      summary: "The dependent implementation needs a correction.",
      finding: "The first attempt did not satisfy the dependent acceptance contract.",
    });
    assert.equal((await missions.getWorkItem(mission.id, "proof-loop-dependent")).status, "ready");
    assert.equal(await missions.canStartWorkItem(mission.id, "proof-loop-terminal"), false);
    await assert.rejects(
      missions.transitionWorkItem(mission.id, "proof-loop-terminal", "ready"),
      domainError("dependency_blocked"),
    );
    assert.equal((await missions.listHandoffs(mission.id, "proof-loop-dependent")).length, firstDependentHandoffCount);
    assert.equal((await missions.listEvidence(mission.id, "proof-loop-dependent")).length, firstDependentEvidenceCount + 1);

    missions = new MissionService(repository, fixedClock);
    runner = runnerFor(missions, client);
    await runImplementation(missions, runner, mission.id, "proof-loop-dependent", "dependent-2");
    await missions.reviewWorkItem(mission.id, {
      workItemId: "proof-loop-dependent",
      outcome: "accepted",
      reviewer: "independent-verifier",
      summary: "The corrected dependent implementation is independently verified.",
      finding: "No blocking findings for the corrected dependent change.",
    });
    assert.equal(await missions.canStartWorkItem(mission.id, "proof-loop-terminal"), false);

    await missions.transitionWorkItem(mission.id, "proof-loop-terminal", "ready");
    assert.equal(await missions.canStartWorkItem(mission.id, "proof-loop-terminal"), true);
    await runImplementation(missions, runner, mission.id, "proof-loop-terminal", "terminal-1");
    await missions.reviewWorkItem(mission.id, {
      workItemId: "proof-loop-terminal",
      outcome: "accepted",
      reviewer: "independent-verifier",
      summary: "The terminal implementation is independently verified.",
      finding: "No blocking findings for the terminal change.",
    });
    await missions.transitionMission(mission.id, "verifying");

    const malformed = await runMalformedScenario(repository);
    const uncorrelated = await runUncorrelatedEvidenceScenario(repository);
    const blockedReview = await runBlockedReviewScenario(repository);
    const reconnected = new MissionService(repository, fixedClock);
    const restored = await reconnected.getState();
    const restoredMission = restored.missions.find((item) => item.id === mission.id);
    const restoredItems = restored.workItems.filter((item) => item.missionId === mission.id);
    assert.equal(restoredMission.status, "verifying");
    assert.deepEqual(restoredItems.map((item) => item.status), ["complete", "complete", "complete"]);
    assert.equal(restoredItems.every((item) => item.delegation?.status === "completed"), true);
    assert.equal(restored.handoffs.filter((item) => item.missionId === mission.id).length, 4);
    assert.equal(restored.reviews.filter((item) => item.missionId === mission.id).length, 4);
    assert.equal(
      restored.evidence.filter((item) => item.missionId === mission.id && item.kind === "reviewer_finding").length,
      4,
    );
    assert.equal(
      restored.handoffs
        .filter((item) => item.missionId === mission.id)
        .every((handoff) => handoff.executionOrigin?.threadId?.startsWith("thread-proof-loop-")),
      true,
    );
    assert.equal(
      restored.handoffs
        .filter((item) => item.missionId === mission.id)
        .every((handoff) => handoff.checks?.every((check) => check.result === "passed")),
      true,
    );
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(persisted, restored);

    return {
      state: restored,
      malformed,
      uncorrelated,
      blockedReview,
      summary: {
        resetFixture: "fresh temporary JSON state; removed after the run",
        missionId: mission.id,
        missionStatus: restoredMission.status,
        completedWorkItems: restoredItems.map((item) => item.id),
        dependentUnlockedAfterReviewedCompletion: true,
        changesRequestedPreservedHistory: true,
        malformedDelegationDidNotUnlockDependent: malformed.rootDelegationStatus === "interrupted" &&
          malformed.dependentStatus === "backlog",
        uncorrelatedEvidenceDidNotUnlockDependent: uncorrelated.handoffCount === 0 &&
          uncorrelated.dependentStatus === "backlog",
        blockedReviewDidNotUnlockDependent: blockedReview.reviewOutcome === "blocked" &&
          blockedReview.dependentStatus === "backlog",
        handoffCount: restored.handoffs.filter((item) => item.missionId === mission.id).length,
        reviewCount: restored.reviews.filter((item) => item.missionId === mission.id).length,
        evidenceCount: restored.evidence.filter((item) => item.missionId === mission.id).length,
        nativeTurnCount: calls.turns.length,
        remoteMutations: 0,
      },
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runDelegatedDeliveryIntegration()
    .then((result) => console.log(JSON.stringify(result.summary, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
