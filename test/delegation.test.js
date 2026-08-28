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
  buildWorkPacket,
  DELEGATED_WORKSPACE_TREE_SNAPSHOT_COMMAND,
  buildDelegatedWorkspaceDeltaCommand,
} from "../dist/index.js";
import { workspaceDeltaEvidenceDetails } from "./delegated-proof-fixture.js";

function fixedClock() {
  return new Date("2026-08-27T12:00:00.000Z");
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

function workspaceDeltaFixture() {
  return JSON.parse(workspaceDeltaEvidenceDetails({
    startTreeRef: WORKSPACE_TREE,
    missionStartTreeRef: WORKSPACE_TREE,
    endTreeRef: WORKSPACE_END_TREE,
  }));
}

function delegatedEvents({ malformedCompletion = false, includeThread = true, threadError } = {}) {
  const events = [
    {
      type: "turn.created",
      id: "event-turn-created",
      createdAt: "2026-08-27T12:00:01.000Z",
      threadId: null,
      turnId: "turn-delegated",
      state: { status: "running" },
    },
  ];
  if (includeThread) {
    events.push({
      type: "thread.created",
      id: "event-thread-created",
      createdAt: "2026-08-27T12:00:02.000Z",
      threadId: "thread-subagent",
      title: "Bounded implementer",
      parent: { threadId: "thread-main", toolCallId: "call-delegate" },
      agentInfo: {
        type: "dynamic",
        name: "bounded-implementer",
        input: "Work Packet: implement the requested bounded change.",
      },
    });
    events.push({
      type: "model.message",
      id: "event-proof-model",
      createdAt: "2026-08-27T12:00:02.500Z",
      threadId: "thread-subagent",
      toolCalls: [
        {
          id: "call-proof-checks",
          function: {
            name: "exec",
            arguments: JSON.stringify({ command: "npm run typecheck && npm test" }),
          },
        },
        {
          id: "call-proof-manifest",
          function: {
            name: "exec",
            arguments: JSON.stringify({ command: "git status --porcelain=v1 -z --untracked-files=all" }),
          },
        },
        {
          id: "call-proof-diff",
          function: { name: "exec", arguments: JSON.stringify({ command: "git diff" }) },
        },
      ],
    });
    events.push({
      type: "tool.response",
      id: "event-proof-checks-response",
      createdAt: "2026-08-27T12:00:02.600Z",
      threadId: "thread-subagent",
      toolCallId: "call-proof-checks",
      content: JSON.stringify({
        success: true,
        response: {
          exitCode: 0,
          result: "typecheck passed\ntests passed\n",
        },
      }),
    });
    events.push({
      type: "tool.response",
      id: "event-proof-manifest-response",
      createdAt: "2026-08-27T12:00:02.650Z",
      threadId: "thread-subagent",
      toolCallId: "call-proof-manifest",
      content: JSON.stringify({
        success: true,
        response: {
          exitCode: 0,
          result: " M src/index.ts\u0000 M test/index.test.js\u0000",
        },
      }),
    });
    events.push({
      type: "tool.response",
      id: "event-proof-diff-response",
      createdAt: "2026-08-27T12:00:02.700Z",
      threadId: "thread-subagent",
      toolCallId: "call-proof-diff",
      content: JSON.stringify({
        success: true,
        response: {
          exitCode: 0,
          result: "diff --git a/src/index.ts b/src/index.ts\n@@ -1 +1,2 @@\n+export const changed = true;\ndiff --git a/test/index.test.js b/test/index.test.js\n@@ -1 +1,2 @@\n+test(\"changed\", () => {});",
        },
      }),
    });
    events.push({
      type: "thread.done",
      id: "event-thread-done",
      createdAt: "2026-08-27T12:00:03.000Z",
      threadId: "thread-subagent",
      title: "Bounded implementer",
      state: malformedCompletion
        ? { status: "done" }
        : threadError === undefined
        ? {
            status: "done",
            output: {
              type: "model.message",
              id: "event-subagent-output",
              createdAt: "2026-08-27T12:00:03.000Z",
              threadId: "thread-subagent",
              content: "The bounded work completed.",
            },
          }
        : { status: "error", error: threadError },
    });
  }
  events.push({
    type: "turn.done",
    id: "event-turn-done",
    createdAt: "2026-08-27T12:00:04.000Z",
    threadId: null,
    state: { status: "done", requiredActions: [] },
  });
  return events;
}

function fakeClient(events) {
  const calls = { create: [], turns: [] };
  let turnNumber = 0;
  return {
    calls,
    client: {
      sessions: {
        async create(request) {
          calls.create.push(request);
          return { data: { id: "session-delegated" } };
        },
        async get(sessionId) {
          return { data: { id: sessionId } };
        },
        async createTurnStream(sessionId, request) {
          calls.turns.push({ sessionId, request });
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
            ));
          }
          return fakeStream(events);
        },
      },
    },
  };
}

async function delegatedFixture({ events = delegatedEvents(), repository = new InMemoryMissionRepository() } = {}) {
  const missions = new MissionService(repository, fixedClock);
  const { client, calls } = fakeClient(events);
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "alibaba/qwen3-7-plus",
    dynamicSubAgents: true,
  });
  const mission = await runner.createMission({
    id: "mission-delegation",
    objective: "Implement src/index.ts through a bounded native subagent.",
    repository: { owner: "owner", name: "repo", ref: "fixture" },
  });
  const workItem = await missions.addWorkItem(mission.id, {
    id: "work-delegated",
    title: "Implement bounded change",
    purpose: "Apply the requested change after inspection.",
    acceptanceCriteria: ["The bounded change is complete."],
    assignedRole: "implementer",
    allowedFiles: ["src/index.ts", "test/index.test.js"],
    status: "ready",
  });
  await missions.transitionWorkItem(mission.id, workItem.id, "in_progress");
  return { calls, missions, mission, runner, workItem };
}

test("native dynamic delegation sends a bounded durable Work Packet and persists ownership", async () => {
  const { calls, missions, mission, runner, workItem } = await delegatedFixture();
  const dependency = await missions.addEvidence(mission.id, {
    id: "evidence-dependency",
    workItemId: workItem.id,
    kind: "tool_result",
    result: "passed",
    source: "mcp",
    summary: "The scoped repository fact passed.",
    details: "must not enter the packet",
  });

  const result = await runner.runTurn(
    mission.id,
    "Apply the requested bounded change.",
    { workItemId: workItem.id, delegateToSubagent: true },
  );

  assert.equal(result.turnId, "turn-delegated");
  assert.equal(calls.create[0].agent.spec.config.dynamicSubAgents.enabled, true);
  const prompt = calls.turns[1].request.input[0].content;
  assert.match(prompt, /Work Packet:/);
  assert.match(prompt, /Implement src\/index\.ts/);
  assert.match(prompt, /allowedFiles/);
  assert.match(prompt, /may modify only these explicitly allowed repository files/);
  assert.match(prompt, /coordinator independently captures the complete current work-item delta/i);
  assert.match(prompt, /git diff -- <allowed file>/);
  assert.match(prompt, /The bounded change is complete/);
  assert.doesNotMatch(prompt, /must not enter the packet/);
  assert.equal(dependency.id, "evidence-dependency");

  const state = await missions.getState();
  const persisted = state.workItems.find((item) => item.id === workItem.id);
  assert.deepEqual(persisted.delegation, {
    owner: "bounded-implementer",
    threadId: "thread-subagent",
    status: "completed",
    startedAt: "2026-08-27T12:00:00.000Z",
    updatedAt: "2026-08-27T12:00:00.000Z",
    turnId: "turn-delegated",
    startTreeRef: WORKSPACE_TREE,
    missionStartTreeRef: WORKSPACE_TREE,
  });
  assert.equal(persisted.status, "in_progress");
});

test("delegation state survives an isolated JSON reconnect", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-delegation-"));
  const filePath = path.join(directory, "mission-state.json");
  try {
    const first = await delegatedFixture({ repository: new JsonMissionRepository(filePath) });
    await first.runner.runTurn(first.mission.id, "Delegate the bounded change.", {
      workItemId: first.workItem.id,
      delegateToSubagent: true,
    });
    const second = new MissionService(new JsonMissionRepository(filePath));
    const restored = (await second.getState()).workItems.find((item) => item.id === first.workItem.id);
    assert.equal(restored.delegation.threadId, "thread-subagent");
    assert.equal(restored.delegation.status, "completed");
    assert.equal(restored.delegation.owner, "bounded-implementer");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed or missing native subagent completion fails closed", async () => {
  const malformed = await delegatedFixture({ events: delegatedEvents({ malformedCompletion: true }) });
  await assert.rejects(
    malformed.runner.runTurn(malformed.mission.id, "Delegate the bounded change.", {
      workItemId: malformed.workItem.id,
      delegateToSubagent: true,
    }),
    (error) => error instanceof TrueForgeIntegrationError &&
      /malformed|uncorrelated|interrupted/i.test(error.message),
  );
  let state = await malformed.missions.getState();
  let item = state.workItems.find((candidate) => candidate.id === malformed.workItem.id);
  assert.equal(item.status, "in_progress");
  assert.equal(item.delegation.status, "interrupted");

  const missing = await delegatedFixture({ events: delegatedEvents({ includeThread: false }) });
  await assert.rejects(
    missing.runner.runTurn(missing.mission.id, "Delegate the bounded change.", {
      workItemId: missing.workItem.id,
      delegateToSubagent: true,
    }),
    (error) => error instanceof TrueForgeIntegrationError &&
      /did not create a native dynamic subagent/.test(error.message),
  );
  state = await missing.missions.getState();
  item = state.workItems.find((candidate) => candidate.id === missing.workItem.id);
  assert.equal(item.status, "in_progress");
  assert.equal(item.delegation, undefined);
});

test("native subagent error reasons remain durable and visible", async () => {
  const reason = "Agent loop stopped after the sandbox runtime reported npm was unavailable.";
  const failed = await delegatedFixture({
    events: delegatedEvents({ threadError: reason }),
  });

  await assert.rejects(
    failed.runner.runTurn(failed.mission.id, "Delegate the bounded change.", {
      workItemId: failed.workItem.id,
      delegateToSubagent: true,
    }),
    (error) => error instanceof TrueForgeIntegrationError && error.message.includes(reason),
  );

  const state = await failed.missions.getState();
  const item = state.workItems.find((candidate) => candidate.id === failed.workItem.id);
  assert.equal(item.delegation.status, "failed");
  assert.equal(item.delegation.error, reason);
  const threadFailure = state.evidence.find((evidence) =>
    evidence.summary.includes(reason)
  );
  assert.ok(threadFailure, "the concrete thread error should be recorded as runtime evidence");
  assert.match(threadFailure.details, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Work Packets contain only scoped durable state and domain delegation enforces readiness", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const mission = await missions.createMission({
    id: "mission-packet-scope",
    objective: "Keep delegated context narrow",
  });
  const root = await missions.addWorkItem(mission.id, {
    id: "packet-root",
    title: "Root",
    purpose: "Prerequisite",
    acceptanceCriteria: ["Root is complete."],
    assignedRole: "planner",
  });
  const child = await missions.addWorkItem(mission.id, {
    id: "packet-child",
    title: "Child",
    purpose: "Delegated child",
    acceptanceCriteria: ["Child is complete."],
    dependsOn: [root.id],
    assignedRole: "implementer",
    allowedFiles: ["src/index.ts"],
  });
  const packet = buildWorkPacket(mission, child, {
    workItems: (await missions.getState()).workItems,
    evidence: [
      {
        id: "unrelated-evidence",
        missionId: mission.id,
        kind: "tool_result",
        result: "passed",
        source: "agent",
        summary: "Unrelated mission note",
        createdAt: new Date().toISOString(),
      },
    ],
  });
  assert.deepEqual(packet.workItem.dependencies, [{ id: root.id, status: "backlog" }]);
  assert.deepEqual(packet.evidence, []);
  await assert.rejects(
    missions.transitionWorkItem(mission.id, child.id, "ready"),
    (error) => error instanceof MissionDomainError && error.code === "dependency_blocked",
  );
  await missions.transitionWorkItem(mission.id, root.id, "ready");
  await missions.transitionWorkItem(mission.id, root.id, "in_progress");
  await missions.transitionWorkItem(mission.id, root.id, "ready_for_review");
  await missions.transitionWorkItem(mission.id, root.id, "complete");
  await missions.transitionWorkItem(mission.id, child.id, "ready");
  await missions.transitionWorkItem(mission.id, child.id, "in_progress");
  await missions.attachTrueforgeWorkspaceBaseline(mission.id, WORKSPACE_TREE);
  const started = await missions.startWorkItemDelegation(mission.id, child.id, {
    owner: "bounded-implementer",
    threadId: "thread-child",
    startTreeRef: WORKSPACE_TREE,
    missionStartTreeRef: WORKSPACE_TREE,
  });
  assert.equal(started.delegation.status, "running");
});
