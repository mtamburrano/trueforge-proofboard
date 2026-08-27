import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  JsonMissionRepository,
  MissionDomainError,
  MissionService,
  TrueForgeMissionRunner,
} from "../dist/index.js";

export const M2_FIXTURE = Object.freeze({
  missionId: "mission-m2-dependent-loop",
  malformedMissionId: "mission-m2-malformed-loop",
  sessionId: "session-m2-dependent-loop",
  repository: { owner: "fixture", name: "proof-board", ref: "m2-reset" },
  graph: {
    items: [
      {
        id: "m2-root",
        title: "Complete the foundation change",
        purpose: "Run the first bounded implementation in the dependency chain.",
        acceptanceCriteria: ["The foundation change has a structured handoff and review."],
        dependsOn: [],
        assignedRole: "implementer",
        requiredChecks: ["typecheck", "test"],
      },
      {
        id: "m2-dependent",
        title: "Complete the dependent change",
        purpose: "Run only after the foundation has passed independent review.",
        acceptanceCriteria: ["The dependent change unlocks only after reviewed completion."],
        dependsOn: ["m2-root"],
        assignedRole: "implementer",
        requiredChecks: ["typecheck", "test"],
      },
      {
        id: "m2-terminal",
        title: "Complete the terminal change",
        purpose: "Run only after the dependent change has passed independent review.",
        acceptanceCriteria: ["The terminal change runs after the complete dependency chain."],
        dependsOn: ["m2-dependent"],
        assignedRole: "implementer",
        requiredChecks: ["typecheck", "test"],
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

function delegatedEvents(attempt, { malformedCompletion = false } = {}) {
  const turnId = `turn-m2-${attempt}`;
  const threadId = `thread-m2-${attempt}`;
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
          id: `call-diff-${attempt}`,
          function: {
            name: "exec",
            arguments: JSON.stringify({ command: "git diff --stat" }),
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
      `event-diff-response-${attempt}`,
      `call-diff-${attempt}`,
      ` ${sourceFile}       | 2 ++\n ${testFile} | 1 +\n 2 files changed, 3 insertions(+)`,
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
  const calls = { create: [], get: [], turns: [] };
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
        async createTurnStream(requestedSessionId, request) {
          const attempt = `turn-${calls.turns.length + 1}`;
          calls.turns.push({ sessionId: requestedSessionId, request });
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
    sessionId: "session-m2-malformed-loop",
    malformedCompletion: true,
  });
  const runner = runnerFor(missions, client);
  const mission = await runner.createMission({
    id: M2_FIXTURE.malformedMissionId,
    objective: "Keep malformed delegated completion from unlocking a dependent.",
    repository: M2_FIXTURE.repository,
  });
  await missions.transitionMission(mission.id, "planning");
  await missions.transitionMission(mission.id, "executing");
  await missions.persistWorkGraph(mission.id, {
    items: [
      {
        ...M2_FIXTURE.graph.items[0],
        id: "m2-malformed-root",
      },
      {
        ...M2_FIXTURE.graph.items[1],
        id: "m2-malformed-dependent",
        dependsOn: ["m2-malformed-root"],
      },
    ],
  });
  await missions.transitionWorkItem(mission.id, "m2-malformed-root", "in_progress");
  await assert.rejects(
    runner.runTurn(mission.id, "Return a malformed delegated completion.", {
      workItemId: "m2-malformed-root",
      delegateToSubagent: true,
    }),
    (error) => /malformed|uncorrelated|interrupted/i.test(error.message),
  );
  const state = await missions.getState();
  const root = state.workItems.find((item) => item.id === "m2-malformed-root");
  assert.equal(root.delegation.status, "interrupted");
  assert.equal(await missions.canStartWorkItem(mission.id, "m2-malformed-dependent"), false);
  await assert.rejects(
    missions.transitionWorkItem(mission.id, "m2-malformed-dependent", "ready"),
    domainError("dependency_blocked"),
  );
  assert.equal(state.handoffs.filter((handoff) => handoff.missionId === mission.id).length, 0);
  assert.equal(calls.turns.length, 1);
  return {
    missionId: mission.id,
    rootDelegationStatus: root.delegation.status,
    dependentStatus: state.workItems.find((item) => item.id === "m2-malformed-dependent").status,
    handoffCount: state.handoffs.filter((handoff) => handoff.missionId === mission.id).length,
  };
}

export async function runM2Integration() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-m2-reset-"));
  const statePath = path.join(directory, "mission-state.json");
  try {
    const repository = new JsonMissionRepository(statePath);
    let missions = new MissionService(repository, fixedClock);
    const { client, calls } = fakeClient({ sessionId: M2_FIXTURE.sessionId });
    let runner = runnerFor(missions, client);
    const mission = await runner.createMission({
      id: M2_FIXTURE.missionId,
      objective: "Exercise a reviewed dependency chain with deterministic retry history.",
      repository: M2_FIXTURE.repository,
    });
    await missions.transitionMission(mission.id, "planning");
    await missions.transitionMission(mission.id, "executing");
    await missions.persistWorkGraph(mission.id, M2_FIXTURE.graph);

    assert.equal(await missions.canStartWorkItem(mission.id, "m2-root"), true);
    assert.equal(await missions.canStartWorkItem(mission.id, "m2-dependent"), false);
    await assert.rejects(
      missions.transitionWorkItem(mission.id, "m2-dependent", "ready"),
      domainError("dependency_blocked"),
    );

    await runImplementation(missions, runner, mission.id, "m2-root", "root-1");
    assert.equal(await missions.canStartWorkItem(mission.id, "m2-dependent"), false);
    await missions.reviewWorkItem(mission.id, {
      workItemId: "m2-root",
      outcome: "accepted",
      reviewer: "independent-verifier",
      summary: "The root changed state and required checks are independently verified.",
      finding: "No blocking findings for the foundation change.",
    });
    assert.equal((await missions.getWorkItem(mission.id, "m2-root")).status, "complete");

    missions = new MissionService(repository, fixedClock);
    runner = runnerFor(missions, client);
    assert.equal(await missions.canStartWorkItem(mission.id, "m2-dependent"), false);
    await missions.transitionWorkItem(mission.id, "m2-dependent", "ready");
    assert.equal(await missions.canStartWorkItem(mission.id, "m2-dependent"), true);
    await runImplementation(missions, runner, mission.id, "m2-dependent", "dependent-1");
    const firstDependentHandoffCount = (await missions.listHandoffs(mission.id, "m2-dependent")).length;
    const firstDependentEvidenceCount = (await missions.listEvidence(mission.id, "m2-dependent")).length;
    await missions.reviewWorkItem(mission.id, {
      workItemId: "m2-dependent",
      outcome: "changes_requested",
      reviewer: "independent-verifier",
      summary: "The dependent implementation needs a correction.",
      finding: "The first attempt did not satisfy the dependent acceptance contract.",
    });
    assert.equal((await missions.getWorkItem(mission.id, "m2-dependent")).status, "ready");
    assert.equal(await missions.canStartWorkItem(mission.id, "m2-terminal"), false);
    await assert.rejects(
      missions.transitionWorkItem(mission.id, "m2-terminal", "ready"),
      domainError("dependency_blocked"),
    );
    assert.equal((await missions.listHandoffs(mission.id, "m2-dependent")).length, firstDependentHandoffCount);
    assert.equal((await missions.listEvidence(mission.id, "m2-dependent")).length, firstDependentEvidenceCount + 1);

    missions = new MissionService(repository, fixedClock);
    runner = runnerFor(missions, client);
    await runImplementation(missions, runner, mission.id, "m2-dependent", "dependent-2");
    await missions.reviewWorkItem(mission.id, {
      workItemId: "m2-dependent",
      outcome: "accepted",
      reviewer: "independent-verifier",
      summary: "The corrected dependent implementation is independently verified.",
      finding: "No blocking findings for the corrected dependent change.",
    });
    assert.equal(await missions.canStartWorkItem(mission.id, "m2-terminal"), false);

    await missions.transitionWorkItem(mission.id, "m2-terminal", "ready");
    assert.equal(await missions.canStartWorkItem(mission.id, "m2-terminal"), true);
    await runImplementation(missions, runner, mission.id, "m2-terminal", "terminal-1");
    await missions.reviewWorkItem(mission.id, {
      workItemId: "m2-terminal",
      outcome: "accepted",
      reviewer: "independent-verifier",
      summary: "The terminal implementation is independently verified.",
      finding: "No blocking findings for the terminal change.",
    });
    await missions.transitionMission(mission.id, "verifying");

    const malformed = await runMalformedScenario(repository);
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
        .every((handoff) => handoff.executionOrigin?.threadId?.startsWith("thread-m2-")),
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
      summary: {
        resetFixture: "fresh temporary JSON state; removed after the run",
        missionId: mission.id,
        missionStatus: restoredMission.status,
        completedWorkItems: restoredItems.map((item) => item.id),
        dependentUnlockedAfterReviewedCompletion: true,
        changesRequestedPreservedHistory: true,
        malformedDelegationDidNotUnlockDependent: malformed.rootDelegationStatus === "interrupted" &&
          malformed.dependentStatus === "backlog",
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
  runM2Integration()
    .then((result) => console.log(JSON.stringify(result.summary, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
