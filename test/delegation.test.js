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
} from "../dist/index.js";

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

function delegatedEvents({ malformedCompletion = false, includeThread = true } = {}) {
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
      type: "thread.done",
      id: "event-thread-done",
      createdAt: "2026-08-27T12:00:03.000Z",
      threadId: "thread-subagent",
      title: "Bounded implementer",
      state: malformedCompletion
        ? { status: "done" }
        : {
            status: "done",
            output: {
              type: "model.message",
              id: "event-subagent-output",
              createdAt: "2026-08-27T12:00:03.000Z",
              threadId: "thread-subagent",
              content: "The bounded work completed.",
            },
          },
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
  const prompt = calls.turns[0].request.input[0].content;
  assert.match(prompt, /Work Packet:/);
  assert.match(prompt, /Implement src\/index\.ts/);
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
  const started = await missions.startWorkItemDelegation(mission.id, child.id, {
    owner: "bounded-implementer",
    threadId: "thread-child",
  });
  assert.equal(started.delegation.status, "running");
});
