import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryMissionRepository,
  MissionService,
  TrueForgeIntegrationError,
  TrueForgeMissionRunner,
} from "../dist/index.js";

const NOW = () => new Date("2026-08-29T16:00:00.000Z");
const BASELINE_SHA = "88e53b07691d5ed3d327f5d47179e99c64e672af";

function fakeStream(events) {
  return {
    async *withMetadata() {
      for (const event of events) {
        yield { data: event };
      }
    },
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

function fakeClient(eventFactory = (turnId) => [
  {
    type: "turn.created",
    id: `${turnId}-created`,
    turnId,
    threadId: null,
    state: { status: "running" },
  },
  {
    type: "turn.done",
    id: `${turnId}-done`,
    threadId: null,
    state: { status: "done", requiredActions: [] },
  },
]) {
  const calls = { creates: [], gets: [], turns: [] };
  const client = {
    sessions: {
      async create(request) {
        calls.creates.push(request);
        return { data: { id: "session-created" } };
      },
      async get(sessionId) {
        calls.gets.push(sessionId);
        return { data: { id: sessionId } };
      },
      async createTurnStream(sessionId, request) {
        const turnId = `turn-${calls.turns.length + 1}`;
        const events = eventFactory(turnId);
        calls.turns.push({ sessionId, request, events });
        return fakeStream(events);
      },
    },
  };
  return { client, calls };
}

async function authorizedWorkItem(missions, missionId, id) {
  const item = await missions.addWorkItem(missionId, {
    id,
    title: "Execute the authorized ticket",
    purpose: "Run the bounded implementation in the persistent TrueForge sandbox.",
    acceptanceCriteria: ["The turn completes against the configured repository."],
    allowedFiles: ["src/index.ts"],
  });
  await missions.moveWorkItemByHuman(missionId, id, "ready", { actor: "operator" });
  return item;
}

function runnerConfig() {
  return {
    model: "openai/gpt-5-4-mini",
    mcpServers: [{ name: "github", enableTools: ["get_commit"] }],
  };
}

test("a Ready ticket claims once, creates one real session, and reconnects only for its owner", async () => {
  const missions = new MissionService(new InMemoryMissionRepository(), NOW);
  const mission = await missions.createMission({
    id: "mission-queue-execution-claim",
    objective: "Execute one authorized ticket.",
    repository: { owner: "mtamburrano", name: "proofboard-demo-fixture", ref: BASELINE_SHA },
  });
  const item = await authorizedWorkItem(missions, mission.id, "ticket-claim-once");
  const { client, calls } = fakeClient();
  const runner = new TrueForgeMissionRunner(missions, client, runnerConfig());

  const claimed = await runner.claimReadyWorkItem(mission.id, item.id, "trueforge-worker");
  assert.equal(claimed.status, "in_progress");
  assert.equal(claimed.claim.owner, "trueforge-worker");
  assert.equal(claimed.claim.trueforgeSessionId, "session-created");
  assert.equal((await missions.getMission(mission.id)).trueforgeSessionId, "session-created");
  assert.equal(calls.creates.length, 1);

  const reconnected = await runner.claimReadyWorkItem(mission.id, item.id, "trueforge-worker");
  assert.equal(reconnected.claim.trueforgeSessionId, "session-created");
  assert.equal(calls.creates.length, 1);
  assert.deepEqual(calls.gets, ["session-created"]);

  await assert.rejects(
    runner.claimReadyWorkItem(mission.id, item.id, "another-worker"),
    (error) => error instanceof TrueForgeIntegrationError && /different execution owner/.test(error.message),
  );
});

test("implementation turns bind the emitted sandbox to the claimed ticket and continue the same turn chain", async () => {
  const missions = new MissionService(new InMemoryMissionRepository(), NOW);
  const mission = await missions.createMission({
    id: "mission-queue-execution-continuity",
    objective: "Execute in the exact persisted sandbox.",
    repository: { owner: "mtamburrano", name: "proofboard-demo-fixture", ref: BASELINE_SHA },
    trueforgeSessionId: "session-existing",
  });
  const item = await authorizedWorkItem(missions, mission.id, "ticket-sandbox-binding");
  const { client, calls } = fakeClient((turnId) => [
    {
      type: "turn.created",
      id: `${turnId}-created`,
      turnId,
      threadId: null,
      state: { status: "running" },
    },
    {
      type: "sandbox.created",
      id: `${turnId}-sandbox`,
      turnId,
      threadId: null,
      sandboxId: "sandbox-persisted",
    },
    {
      type: "turn.done",
      id: `${turnId}-done`,
      threadId: null,
      state: { status: "done", requiredActions: [] },
    },
  ]);
  const runner = new TrueForgeMissionRunner(missions, client, runnerConfig());
  await runner.claimReadyWorkItem(mission.id, item.id, "trueforge-worker");

  const first = await runner.runTurn(mission.id, "Implement the bounded ticket.", {
    workItemId: item.id,
  });
  assert.equal(first.sessionId, "session-existing");
  assert.equal(first.turnId, "turn-1");
  let persisted = await missions.getWorkItem(mission.id, item.id);
  assert.equal(persisted.claim.trueforgeSessionId, "session-existing");
  assert.equal(persisted.claim.trueforgeSandboxId, "sandbox-persisted");
  assert.equal((await missions.getMission(mission.id)).trueforgeSandboxId, "sandbox-persisted");

  const second = await runner.runTurn(mission.id, "Continue the bounded ticket.", {
    workItemId: item.id,
  });
  assert.equal(second.turnId, "turn-2");
  assert.equal(calls.turns.length, 2);
  assert.equal(calls.turns[1].request.previousTurnId, "turn-1");
  persisted = await missions.getWorkItem(mission.id, item.id);
  assert.equal(persisted.claim.trueforgeSandboxId, "sandbox-persisted");
  assert.deepEqual(calls.creates, []);
});
