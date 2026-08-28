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
  TrueForgeIntegrationError,
  TrueForgeMissionRunner,
  DELEGATED_WORKSPACE_TREE_SNAPSHOT_COMMAND,
  buildDelegatedWorkspaceDeltaCommand,
} from "../dist/index.js";
import {
  persistWorkspaceStart,
  workspaceDeltaEvidenceDetails,
} from "./delegated-proof-fixture.js";

const ORIGIN = {
  kind: "trueforge",
  sessionId: "session-handoff",
  turnId: "turn-handoff",
  threadId: "thread-handoff",
};

function fixedClock() {
  return new Date("2026-08-27T13:00:00.000Z");
}

function domainError(code) {
  return (error) => error instanceof MissionDomainError && error.code === code;
}

async function delegatedFixture(repository = new InMemoryMissionRepository()) {
  const missions = new MissionService(repository, fixedClock);
  const mission = await missions.createMission({
    id: "mission-implementation-handoff",
    objective: "Capture a verified implementation handoff.",
    trueforgeSessionId: ORIGIN.sessionId,
  });
  const workItem = await missions.addWorkItem(mission.id, {
    id: "work-implementation-handoff",
    title: "Implement the change",
    purpose: "Apply and prove the bounded code change.",
    acceptanceCriteria: ["The change is implemented and checked."],
    requiredChecks: ["typecheck", "test"],
    assignedRole: "implementer",
    allowedFiles: ["src/index.ts", "test/index.test.js"],
    status: "ready",
  });
  await missions.transitionWorkItem(mission.id, workItem.id, "in_progress");
  await persistWorkspaceStart(missions, mission.id, workItem.id, {
    sessionId: ORIGIN.sessionId,
    turnId: ORIGIN.turnId,
    threadId: ORIGIN.threadId,
  });
  await missions.completeWorkItemDelegation(mission.id, workItem.id, {
    threadId: ORIGIN.threadId,
    turnId: ORIGIN.turnId,
  });
  return { missions, mission, workItem };
}

async function addEvidence(missions, missionId, id, kind, result, toolCallId, origin = ORIGIN) {
  return missions.addEvidence(missionId, {
    id,
    workItemId: "work-implementation-handoff",
    kind,
    result,
    source: "trueforge",
    summary: `${kind} ${result}`,
    ...(kind === "diff_summary" ? {
      details: JSON.stringify({
        command: "git diff",
        output: "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1,2 @@\n before\n+after\ndiff --git a/test/index.test.js b/test/index.test.js\n--- a/test/index.test.js\n+++ b/test/index.test.js\n@@ -1 +1,2 @@\n before\n+after",
      }),
    } : {}),
    ...(kind === "file_change" ? {
      details: workspaceDeltaEvidenceDetails(),
      executionOrigin: {
        kind: "trueforge",
        sessionId: ORIGIN.sessionId,
        turnId: "turn-workspace-delta",
        toolCallId,
      },
    } : {}),
    ...(kind === "file_change" ? {} : { executionOrigin: { ...origin, toolCallId } }),
  });
}

function validHandoff(evidenceIds, result = "done") {
  return {
    id: result === "done" ? "handoff-valid" : "handoff-partial",
    workItemId: "work-implementation-handoff",
    result,
    summary: "Structured implementation facts from the delegated execution.",
    filesChanged: ["src/index.ts", "test/index.test.js"],
    testsRun: ["npm run typecheck", "npm test"],
    decisions: ["Kept the public identity exports unchanged."],
    openQuestions: [],
    memoryImpact: "medium",
    diffSummary: "src/index.ts and test/index.test.js changed.",
    checks: [
      {
        name: "typecheck",
        command: "npm run typecheck",
        result: "passed",
        required: true,
        evidenceIds: [evidenceIds.typecheck],
        exitCode: 0,
      },
      {
        name: "test",
        command: "npm test",
        result: "passed",
        required: true,
        evidenceIds: [evidenceIds.test],
        exitCode: 0,
      },
    ],
    evidenceIds: [
      evidenceIds.typecheck,
      evidenceIds.test,
      ...(evidenceIds.manifest === undefined ? [] : [evidenceIds.manifest]),
      evidenceIds.diff,
    ],
    executionOrigin: { ...ORIGIN },
  };
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

const WORKSPACE_TREE = "a".repeat(40);
const WORKSPACE_END_TREE = "b".repeat(40);
const WORKSPACE_SNAPSHOT_INTENT =
  "Capture the coordinator-owned workspace tree before delegated implementation starts.";
const WORKSPACE_DELTA_INTENT =
  "Capture the coordinator-owned current work-item and cumulative mission workspace deltas after delegated implementation.";

function coordinatorEvents(command, output, turnId, intent = WORKSPACE_SNAPSHOT_INTENT) {
  const callId = `${turnId}-call`;
  return [
    { type: "turn.created", id: `${turnId}-created`, turnId, threadId: null, state: { status: "running" } },
    {
      type: "model.message",
      id: `${turnId}-model`,
      threadId: null,
      toolCalls: [{
        id: callId,
        function: { name: "exec", arguments: JSON.stringify({ intent, command }) },
      }],
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

function workspaceDeltaFixture() {
  return JSON.parse(workspaceDeltaEvidenceDetails({
    startTreeRef: WORKSPACE_TREE,
    missionStartTreeRef: WORKSPACE_TREE,
    endTreeRef: WORKSPACE_END_TREE,
  }));
}

function delegatedExecutionEvents({ proofThreadId = ORIGIN.threadId } = {}) {
  const response = (id, callId, output) => ({
    type: "tool.response",
    id,
    createdAt: "2026-08-27T13:00:02.000Z",
    threadId: proofThreadId,
    toolCallId: callId,
    content: JSON.stringify({
      success: true,
      response: { exitCode: 0, result: output },
    }),
  });
  return [
    {
      type: "turn.created",
      id: "event-turn",
      createdAt: "2026-08-27T13:00:01.000Z",
      threadId: null,
      turnId: "turn-handoff",
      state: { status: "running" },
    },
    {
      type: "thread.created",
      id: "event-thread",
      createdAt: "2026-08-27T13:00:01.100Z",
      threadId: "thread-handoff",
      agentInfo: {
        type: "dynamic",
        name: "bounded-implementer",
        input: "Work Packet: bounded implementation",
      },
    },
    {
      type: "model.message",
      id: "event-model",
      createdAt: "2026-08-27T13:00:01.500Z",
      threadId: proofThreadId,
      toolCalls: [
        { id: "call-checks", function: { name: "exec", arguments: JSON.stringify({ command: "npm run typecheck && npm test" }) } },
        { id: "call-manifest", function: { name: "exec", arguments: JSON.stringify({ command: "git status --porcelain=v1 -z --untracked-files=all" }) } },
        { id: "call-diff", function: { name: "exec", arguments: JSON.stringify({ command: "git diff" }) } },
      ],
    },
    response("event-check-response", "call-checks", "typecheck passed\ntests passed\n"),
    response("event-manifest-response", "call-manifest", " M src/index.ts\u0000 M test/index.test.js\u0000"),
    response("event-diff-response", "call-diff", "diff --git a/src/index.ts b/src/index.ts\nindex 1111111..2222222 100644\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1,2 @@\n export const value = 1;\n+export const next = 2;\ndiff --git a/test/index.test.js b/test/index.test.js\nindex 3333333..4444444 100644\n--- a/test/index.test.js\n+++ b/test/index.test.js\n@@ -1 +1,2 @@\n test(\"value\", () => {});\n+test(\"next\", () => {});") ,
    {
      type: "thread.done",
      id: "event-thread-done",
      createdAt: "2026-08-27T13:00:03.000Z",
      threadId: "thread-handoff",
      state: {
        status: "done",
        output: {
          type: "model.message",
          content: JSON.stringify({
            decisions: ["Kept the change limited to the verified files."],
            openQuestions: [],
          }),
        },
      },
    },
    {
      type: "turn.done",
      id: "event-turn-done",
      createdAt: "2026-08-27T13:00:04.000Z",
      threadId: null,
      state: { status: "done", requiredActions: [] },
    },
  ];
}

test("delegated code work cannot reach review without a structured handoff", async () => {
  const { missions, mission, workItem } = await delegatedFixture();

  await assert.rejects(
    missions.transitionWorkItem(mission.id, workItem.id, "ready_for_review"),
    domainError("invalid_transition"),
  );
  await assert.rejects(
    missions.recordHandoff(mission.id, {
      id: "handoff-narration-only",
      workItemId: workItem.id,
      result: "done",
      summary: "The agent says the implementation is complete.",
      filesChanged: ["src/index.ts"],
      testsRun: ["npm test"],
    }),
    domainError("invalid_input"),
  );
  const state = await missions.getState();
  assert.equal(state.handoffs.length, 0);
  assert.equal(state.workItems.find((item) => item.id === workItem.id).status, "in_progress");
});

test("failed required checks remain durable but cannot produce a successful handoff", async () => {
  const { missions, mission, workItem } = await delegatedFixture();
  const typecheck = await addEvidence(
    missions,
    mission.id,
    "evidence-failed-typecheck",
    "typecheck_result",
    "failed",
    "call-typecheck",
  );
  const testEvidence = await addEvidence(
    missions,
    mission.id,
    "evidence-passed-test",
    "test_result",
    "passed",
    "call-test",
  );
  const diff = await addEvidence(
    missions,
    mission.id,
    "evidence-diff",
    "diff_summary",
    "passed",
    "call-diff",
  );
  const manifest = await addEvidence(
    missions,
    mission.id,
    "evidence-manifest",
    "file_change",
    "passed",
    "call-manifest",
  );

  await assert.rejects(
    missions.recordHandoff(mission.id, {
      ...validHandoff({ typecheck: typecheck.id, test: testEvidence.id, diff: diff.id, manifest: manifest.id }, "done"),
      id: "handoff-failed-required",
      checks: [
        {
          name: "typecheck",
          command: "npm run typecheck",
          result: "failed",
          required: true,
          evidenceIds: [typecheck.id],
          exitCode: 1,
        },
        {
          name: "test",
          command: "npm test",
          result: "passed",
          required: true,
          evidenceIds: [testEvidence.id],
          exitCode: 0,
        },
      ],
    }),
    domainError("invalid_input"),
  );

  const partial = await missions.recordHandoff(mission.id, {
    ...validHandoff({ typecheck: typecheck.id, test: testEvidence.id, diff: diff.id, manifest: manifest.id }, "partial"),
    id: "handoff-partial",
    checks: [
      {
        name: "typecheck",
        command: "npm run typecheck",
        result: "failed",
        required: true,
        evidenceIds: [typecheck.id],
        exitCode: 1,
      },
      {
        name: "test",
        command: "npm test",
        result: "passed",
        required: true,
        evidenceIds: [testEvidence.id],
        exitCode: 0,
      },
    ],
  });
  assert.equal(partial.result, "partial");
  await assert.rejects(
    missions.transitionWorkItem(mission.id, workItem.id, "ready_for_review"),
    domainError("invalid_transition"),
  );
  assert.equal((await missions.getEvidence(mission.id, typecheck.id)).result, "failed");
});

test("valid handoffs correlate every check and origin, then survive reconnect", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-handoff-"));
  const filePath = path.join(directory, "mission-state.json");
  try {
    const first = await delegatedFixture(new JsonMissionRepository(filePath));
    const evidenceIds = {
      typecheck: (await addEvidence(first.missions, first.mission.id, "evidence-typecheck", "typecheck_result", "passed", "call-typecheck")).id,
      test: (await addEvidence(first.missions, first.mission.id, "evidence-test", "test_result", "passed", "call-test")).id,
      diff: (await addEvidence(first.missions, first.mission.id, "evidence-diff-valid", "diff_summary", "passed", "call-diff")).id,
      manifest: (await addEvidence(first.missions, first.mission.id, "evidence-manifest-valid", "file_change", "passed", "call-manifest")).id,
    };
    const handoff = await first.missions.recordHandoff(
      first.mission.id,
      validHandoff(evidenceIds),
    );
    assert.deepEqual(handoff.executionOrigin, ORIGIN);
    await first.missions.transitionWorkItem(first.mission.id, first.workItem.id, "ready_for_review");
    const review = await first.missions.reviewWorkItem(first.mission.id, {
      workItemId: first.workItem.id,
      outcome: "accepted",
      reviewer: "independent-verifier",
      summary: "The changed state and required checks are independently verified.",
      finding: "No blocking findings.",
    });
    assert.equal(review.outcome, "accepted");

    const second = new MissionService(new JsonMissionRepository(filePath), fixedClock);
    const restored = await second.getState();
    assert.equal(restored.workItems[0].status, "complete");
    assert.equal((await second.listHandoffs(first.mission.id))[0].id, handoff.id);
    assert.equal((await second.getEvidence(first.mission.id, evidenceIds.test)).executionOrigin.toolCallId, "call-test");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a structured handoff cannot authorize a diff outside the explicit file scope", async () => {
  const { missions, mission, workItem } = await delegatedFixture();
  const typecheck = await addEvidence(
    missions,
    mission.id,
    "evidence-scope-typecheck",
    "typecheck_result",
    "passed",
    "call-scope-typecheck",
  );
  const tests = await addEvidence(
    missions,
    mission.id,
    "evidence-scope-test",
    "test_result",
    "passed",
    "call-scope-test",
  );
  const diff = await missions.addEvidence(mission.id, {
    id: "evidence-scope-diff",
    workItemId: workItem.id,
    kind: "diff_summary",
    result: "passed",
    source: "trueforge",
    summary: "The delegated execution returned an out-of-scope diff.",
    details: JSON.stringify({
      command: "git diff",
      output: [
        "diff --git a/src/index.ts b/src/index.ts",
        "@@ -1 +1,2 @@",
        "+after",
        "diff --git a/README.md b/README.md",
        "@@ -1 +1,2 @@",
        "+out of scope",
      ].join("\n"),
    }),
    executionOrigin: { ...ORIGIN, toolCallId: "call-scope-diff" },
  });
  const manifest = await missions.addEvidence(mission.id, {
    id: "evidence-scope-manifest",
    workItemId: workItem.id,
    kind: "file_change",
    result: "passed",
    source: "trueforge",
    summary: "The delegated execution returned the complete changed-file manifest.",
    details: workspaceDeltaEvidenceDetails({
      currentFiles: ["src/index.ts", "README.md"],
      cumulativeFiles: ["src/index.ts", "README.md"],
    }),
    executionOrigin: {
      kind: "trueforge",
      sessionId: ORIGIN.sessionId,
      turnId: "turn-workspace-delta",
      toolCallId: "call-scope-manifest",
    },
  });

  await assert.rejects(
    missions.recordHandoff(mission.id, {
      ...validHandoff({ typecheck: typecheck.id, test: tests.id, diff: diff.id, manifest: manifest.id }),
      id: "handoff-out-of-scope",
      filesChanged: ["src/index.ts", "README.md"],
    }),
    (error) => domainError("invalid_input")(error) && /outside.*scope|README\.md/i.test(error.message),
  );
  const state = await missions.getState();
  assert.equal(state.handoffs.length, 0);
  assert.equal(state.evidence.find((item) => item.id === diff.id).result, "passed");
});

test("uncorrelated evidence is rejected atomically while prior history is preserved", async () => {
  const { missions, mission, workItem } = await delegatedFixture();
  const other = await missions.addWorkItem(mission.id, {
    id: "work-other",
    title: "Other work",
    purpose: "Provide an unrelated evidence target.",
    acceptanceCriteria: ["The unrelated item exists."],
    assignedRole: "reviewer",
  });
  const prior = await missions.addEvidence(mission.id, {
    id: "evidence-prior",
    workItemId: workItem.id,
    kind: "tool_result",
    result: "informational",
    source: "trueforge",
    summary: "Prior runtime history.",
    executionOrigin: { ...ORIGIN, toolCallId: "call-prior" },
  });
  const unrelated = await missions.addEvidence(mission.id, {
    id: "evidence-unrelated",
    workItemId: other.id,
    kind: "diff_summary",
    result: "passed",
    source: "trueforge",
    summary: "Evidence for another work item.",
    executionOrigin: { ...ORIGIN, toolCallId: "call-other" },
  });
  await assert.rejects(
    missions.recordHandoff(mission.id, {
      ...validHandoff({ typecheck: prior.id, test: prior.id, diff: unrelated.id }),
      id: "handoff-uncorrelated",
    }),
    domainError("invalid_input"),
  );
  const state = await missions.getState();
  assert.equal(state.evidence.some((item) => item.id === prior.id), true);
  assert.equal(state.evidence.some((item) => item.id === unrelated.id), true);
  assert.equal(state.handoffs.length, 0);
});

test("cross-thread proof is rejected while a prior valid handoff remains durable", async () => {
  const { missions, mission, workItem } = await delegatedFixture();
  const priorIds = {
    typecheck: (await addEvidence(missions, mission.id, "evidence-prior-typecheck", "typecheck_result", "passed", "call-prior-typecheck")).id,
    test: (await addEvidence(missions, mission.id, "evidence-prior-test", "test_result", "passed", "call-prior-test")).id,
    diff: (await addEvidence(missions, mission.id, "evidence-prior-diff", "diff_summary", "passed", "call-prior-diff")).id,
    manifest: (await addEvidence(missions, mission.id, "evidence-prior-manifest", "file_change", "passed", "call-prior-manifest")).id,
  };
  const prior = await missions.recordHandoff(mission.id, {
    ...validHandoff(priorIds),
    id: "handoff-prior-valid",
  });

  const retryOrigin = {
    kind: "trueforge",
    sessionId: ORIGIN.sessionId,
    turnId: "turn-retry",
    threadId: "thread-retry",
  };
  const parentOrigin = { ...retryOrigin, threadId: "thread-parent" };
  await missions.startWorkItemDelegation(mission.id, workItem.id, {
    owner: "bounded-implementer",
    threadId: retryOrigin.threadId,
    turnId: retryOrigin.turnId,
    startTreeRef: "b".repeat(40),
    missionStartTreeRef: "a".repeat(40),
  });
  await missions.completeWorkItemDelegation(mission.id, workItem.id, {
    threadId: retryOrigin.threadId,
    turnId: retryOrigin.turnId,
  });
  const retryIds = {
    typecheck: (await addEvidence(missions, mission.id, "evidence-retry-typecheck", "typecheck_result", "passed", "call-retry-typecheck", parentOrigin)).id,
    test: (await addEvidence(missions, mission.id, "evidence-retry-test", "test_result", "passed", "call-retry-test", parentOrigin)).id,
    diff: (await addEvidence(missions, mission.id, "evidence-retry-diff", "diff_summary", "passed", "call-retry-diff", parentOrigin)).id,
    manifest: (await addEvidence(missions, mission.id, "evidence-retry-manifest", "file_change", "passed", "call-retry-manifest", parentOrigin)).id,
  };
  const childRuntime = await addEvidence(
    missions,
    mission.id,
    "evidence-retry-child-runtime",
    "tool_result",
    "informational",
    "call-retry-child",
    retryOrigin,
  );

  await assert.rejects(
    missions.recordHandoff(mission.id, {
      ...validHandoff(retryIds),
      id: "handoff-retry-cross-thread",
      evidenceIds: [...Object.values(retryIds), childRuntime.id],
      executionOrigin: retryOrigin,
    }),
    (error) => domainError("invalid_input")(error) && /different execution thread/.test(error.message),
  );

  const state = await missions.getState();
  assert.deepEqual(state.handoffs.map((handoff) => handoff.id), [prior.id]);
  assert.equal(state.evidence.some((evidence) => evidence.id === retryIds.diff), true);
  assert.equal(state.workItems[0].delegation.threadId, retryOrigin.threadId);
});

test("TrueForge derives a structured handoff only from delegated tool responses", async () => {
  const missions = new MissionService(new InMemoryMissionRepository(), fixedClock);
  let turnNumber = 0;
  const client = {
    sessions: {
      async create() {
        return { data: { id: ORIGIN.sessionId } };
      },
      async get(sessionId) {
        return { data: { id: sessionId } };
      },
      async update(sessionId, request) {
        return { data: { id: sessionId }, request };
      },
      async createTurnStream() {
        const current = turnNumber++;
        if (current === 0) {
          return fakeStream(coordinatorEvents(
            DELEGATED_WORKSPACE_TREE_SNAPSHOT_COMMAND,
            `TRUEFORGE_WORKSPACE_TREE ${WORKSPACE_TREE}\n`,
            "turn-workspace-start",
          ));
        }
        if (current === 2) {
          const delta = workspaceDeltaFixture();
          return fakeStream(coordinatorEvents(
            buildDelegatedWorkspaceDeltaCommand(WORKSPACE_TREE, WORKSPACE_TREE),
            delta.output,
            "turn-workspace-delta",
            WORKSPACE_DELTA_INTENT,
          ));
        }
        return fakeStream(delegatedExecutionEvents());
      },
    },
  };
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "alibaba/qwen3-7-plus",
    dynamicSubAgents: true,
  });
  const mission = await runner.createMission({
    id: "mission-runner-handoff",
    objective: "Derive a handoff from execution evidence.",
  });
  const workItem = await missions.addWorkItem(mission.id, {
    id: "work-runner-handoff",
    title: "Implement the change",
    purpose: "Run bounded code work through a native subagent.",
    acceptanceCriteria: ["The change is checked."],
    requiredChecks: ["typecheck", "test"],
    assignedRole: "implementer",
    allowedFiles: ["src/index.ts", "test/index.test.js"],
    status: "ready",
  });
  await missions.transitionWorkItem(mission.id, workItem.id, "in_progress");
  const result = await runner.runTurn(
    mission.id,
    "Implement the bounded change.",
    { workItemId: workItem.id, delegateToSubagent: true },
  );

  assert.deepEqual(result.implementationHandoff.filesChanged, ["src/index.ts", "test/index.test.js"]);
  assert.deepEqual(result.implementationHandoff.checks.map((check) => check.result), ["passed", "passed"]);
  assert.equal(result.implementationHandoff.executionOrigin.threadId, ORIGIN.threadId);
  assert.match(result.implementationHandoff.diffSummary, /diff --git a\/src\/index\.ts/);
  const handoff = await missions.recordHandoff(mission.id, {
    workItemId: workItem.id,
    result: "done",
    summary: "Derived structured handoff.",
    filesChanged: result.implementationHandoff.filesChanged,
    testsRun: [...new Set(result.implementationHandoff.checks.map((check) => check.command))],
    decisions: result.implementationHandoff.decisions,
    openQuestions: result.implementationHandoff.openQuestions,
    memoryImpact: "medium",
    diffSummary: result.implementationHandoff.diffSummary,
    checks: result.implementationHandoff.checks,
    evidenceIds: result.implementationHandoff.evidenceIds,
    executionOrigin: result.implementationHandoff.executionOrigin,
  });
  await missions.transitionWorkItem(mission.id, workItem.id, "ready_for_review");
  assert.equal(handoff.result, "done");
});

test("coordinator-thread checks and diff cannot prove delegated completion", async () => {
  const missions = new MissionService(new InMemoryMissionRepository(), fixedClock);
  let turnNumber = 0;
  const client = {
    sessions: {
      async create() {
        return { data: { id: ORIGIN.sessionId } };
      },
      async get(sessionId) {
        return { data: { id: sessionId } };
      },
      async update(sessionId, request) {
        return { data: { id: sessionId }, request };
      },
      async createTurnStream() {
        const current = turnNumber++;
        if (current === 0) {
          return fakeStream(coordinatorEvents(
            DELEGATED_WORKSPACE_TREE_SNAPSHOT_COMMAND,
            `TRUEFORGE_WORKSPACE_TREE ${WORKSPACE_TREE}\n`,
            "turn-workspace-start",
          ));
        }
        if (current === 2) {
          const delta = workspaceDeltaFixture();
          return fakeStream(coordinatorEvents(
            buildDelegatedWorkspaceDeltaCommand(WORKSPACE_TREE, WORKSPACE_TREE),
            delta.output,
            "turn-workspace-delta",
            WORKSPACE_DELTA_INTENT,
          ));
        }
        return fakeStream(delegatedExecutionEvents({ proofThreadId: "thread-parent" }));
      },
    },
  };
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "alibaba/qwen3-7-plus",
    dynamicSubAgents: true,
  });
  const mission = await runner.createMission({
    id: "mission-parent-proof",
    objective: "Reject proof produced outside the delegated thread.",
  });
  const workItem = await missions.addWorkItem(mission.id, {
    id: "work-parent-proof",
    title: "Implement through the child",
    purpose: "Require child-thread proof.",
    acceptanceCriteria: ["The child produces correlated checks and a diff."],
    requiredChecks: ["typecheck", "test"],
    assignedRole: "implementer",
    allowedFiles: ["src/index.ts", "test/index.test.js"],
    status: "ready",
  });
  await missions.transitionWorkItem(mission.id, workItem.id, "in_progress");

  await assert.rejects(
    runner.runTurn(
      mission.id,
      "Implement the bounded change.",
      { workItemId: workItem.id, delegateToSubagent: true },
    ),
    (error) => error instanceof TrueForgeIntegrationError &&
      /observed exit-preserving|was blocked/i.test(error.message),
  );
  const state = await missions.getState();
  assert.equal(state.workItems[0].delegation.status, "completed");
  assert.equal(state.workItems[0].status, "blocked");
  assert.equal(state.evidence.some((item) => item.kind === "diff_summary"), false);
  assert.equal(state.evidence.some((item) =>
    item.result === "failed" && item.summary.startsWith("Delegated implementation evidence failed:"),
  ), true);
});
