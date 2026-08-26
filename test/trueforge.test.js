import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryMissionRepository,
  MissionService,
  TrueForgeMissionRunner,
} from "../dist/index.js";

function fakeEvents(turnId = "turn-1") {
  return [
    {
      type: "turn.created",
      id: "event-turn-created",
      createdAt: "2026-08-26T16:00:00.000Z",
      threadId: null,
      turnId,
      state: { status: "running" },
    },
    {
      type: "mcp.initialize",
      id: "event-mcp",
      createdAt: "2026-08-26T16:00:01.000Z",
      threadId: "thread-1",
      mcpServers: [{ name: "github" }],
    },
    {
      type: "model.message",
      id: "event-model",
      createdAt: "2026-08-26T16:00:02.000Z",
      threadId: "thread-1",
      toolCalls: [{ id: "call-1" }],
      content: "This content should not be persisted as evidence.",
    },
    {
      type: "sandbox.created",
      id: "event-sandbox",
      createdAt: "2026-08-26T16:00:03.000Z",
      threadId: null,
      sandboxId: "sandbox-1",
    },
    {
      type: "tool.response",
      id: "event-tool-response",
      createdAt: "2026-08-26T16:00:04.000Z",
      threadId: "thread-1",
      toolCallId: "call-1",
      content: JSON.stringify({ secret: "do-not-persist" }),
    },
    {
      type: "turn.done",
      id: "event-turn-done",
      createdAt: "2026-08-26T16:00:05.000Z",
      threadId: null,
      state: { status: "done", requiredActions: [] },
    },
  ];
}

function repositoryEvents(turnId = "turn-1") {
  return [
    {
      type: "turn.created",
      id: "event-turn-created",
      createdAt: "2026-08-26T16:00:00.000Z",
      threadId: null,
      turnId,
      state: { status: "running" },
    },
    {
      type: "mcp.initialize",
      id: "event-mcp",
      createdAt: "2026-08-26T16:00:01.000Z",
      threadId: "thread-1",
      mcpServers: [{ name: "github" }],
    },
    {
      type: "model.message",
      id: "event-model",
      createdAt: "2026-08-26T16:00:02.000Z",
      threadId: "thread-1",
      toolCalls: [{
        id: "call-mcp",
        function: {
          name: "get_file_contents",
          arguments: JSON.stringify({
            owner: "owner",
            repo: "repo",
            path: "package.json",
            ref: "main",
          }),
        },
      }],
    },
    {
      type: "tool.response",
      id: "event-tool-response",
      createdAt: "2026-08-26T16:00:03.000Z",
      threadId: "thread-1",
      toolCallId: "call-mcp",
      content: JSON.stringify({
        isError: false,
        content: [{
          type: "resource",
          resource: {
            uri: "repo://owner/repo/refs/heads/main/contents/package.json",
            mimeType: "application/json",
            text: JSON.stringify({ name: "fixture" }),
          },
        }],
      }),
    },
    {
      type: "turn.done",
      id: "event-turn-done",
      createdAt: "2026-08-26T16:00:04.000Z",
      threadId: null,
      state: { status: "done", requiredActions: [] },
    },
  ];
}

function sandboxEvents(turnId = "turn-1", exitCode = 0, requiredActions = []) {
  return [
    {
      type: "turn.created",
      id: "event-turn-created",
      createdAt: "2026-08-26T16:00:00.000Z",
      threadId: null,
      turnId,
      state: { status: "running" },
    },
    {
      type: "sandbox.created",
      id: "event-sandbox",
      createdAt: "2026-08-26T16:00:01.000Z",
      threadId: null,
      sandboxId: "sandbox-1",
    },
    {
      type: "model.message",
      id: "event-model",
      createdAt: "2026-08-26T16:00:02.000Z",
      threadId: "thread-1",
      toolCalls: [{
        id: "call-exec",
        function: {
          name: "exec",
          arguments: JSON.stringify({ command: "node --test" }),
        },
      }],
    },
    {
      type: "tool.response",
      id: "event-tool-response",
      createdAt: "2026-08-26T16:00:03.000Z",
      threadId: "thread-1",
      toolCallId: "call-exec",
      content: JSON.stringify({
        success: true,
        response: {
          exitCode,
          result: exitCode === 0 ? "all tests passed\n" : "test failed\n",
        },
      }),
    },
    {
      type: "turn.done",
      id: "event-turn-done",
      createdAt: "2026-08-26T16:00:04.000Z",
      threadId: null,
      state: { status: "done", requiredActions },
    },
  ];
}

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

function fakeClient(eventFactory = fakeEvents) {
  const calls = { create: [], get: [], turns: [] };
  const client = {
    sessions: {
      async create(request) {
        calls.create.push(request);
        return { data: { id: "session-created" } };
      },
      async get(sessionId) {
        calls.get.push(sessionId);
        return { data: { id: sessionId } };
      },
      async createTurnStream(sessionId, request) {
        calls.turns.push({ sessionId, request });
        const turnId = `turn-${calls.turns.length}`;
        return fakeStream(eventFactory(turnId));
      },
    },
  };
  return { client, calls };
}

test("runner creates a TrueForge session and maps safe runtime evidence", async () => {
  const repository = new InMemoryMissionRepository();
  const missions = new MissionService(repository, () => new Date("2026-08-26T16:00:00.000Z"));
  const { client, calls } = fakeClient();
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "google-gemini/test-model",
    mcpServers: [{ name: "github", enableTools: ["get_file_contents"] }],
  });

  const mission = await runner.createMission({
    id: "mission-trueforge-test",
    objective: "Inspect a repository safely",
  });
  const workItem = await missions.addWorkItem(mission.id, {
    id: "work-trueforge-test",
    title: "Inspect repository",
    purpose: "Collect repository facts through MCP.",
    status: "ready",
  });
  const result = await runner.runTurn(mission.id, "Inspect the repository.", {
    workItemId: workItem.id,
  });

  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].agent.spec.config.dynamicSubAgents.enabled, false);
  assert.equal(calls.create[0].agent.spec.config.sandbox.enabled, true);
  assert.equal(result.sessionId, "session-created");
  assert.equal(result.turnId, "turn-1");
  assert.equal(result.events.length, 6);

  const state = await missions.getState();
  assert.equal(state.missions[0].trueforgeSessionId, "session-created");
  assert.equal(state.missions[0].trueforgeTurnId, "turn-1");
  assert.equal(state.evidence.length, 6);
  assert.equal(state.evidence.every((item) => item.workItemId === workItem.id), true);
  const serializedState = JSON.stringify(state);
  assert.doesNotMatch(serializedState, /do-not-persist|This content should not be persisted/);
});

test("runner does not mark a done turn as passed while required actions remain", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client } = fakeClient((turnId) => {
    const events = fakeEvents(turnId);
    events[events.length - 1].state = {
      status: "done",
      requiredActions: [{ type: "tool.approval_required" }],
    };
    return events;
  });
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "google-gemini/test-model",
  });
  const mission = await runner.createMission({
    id: "mission-pending-required-action",
    objective: "Keep pending TrueForge actions visible as unresolved",
  });

  await runner.runTurn(mission.id, "Continue the bounded turn.");

  const state = await missions.getState();
  const completion = state.evidence.find((item) => item.summary.startsWith("TrueForge turn finished"));
  assert.equal(completion.result, "failed");
  assert.match(completion.summary, /required action/);
});

test("runner resumes the persisted session after a reconnect", async () => {
  const repository = new InMemoryMissionRepository();
  const { client, calls } = fakeClient();
  const config = { model: "google-gemini/test-model" };
  const firstService = new MissionService(repository);
  const firstRunner = new TrueForgeMissionRunner(firstService, client, config);
  const mission = await firstRunner.createMission({
    id: "mission-reconnect-trueforge",
    objective: "Resume the same execution session",
  });

  const reconnectedService = new MissionService(repository);
  const reconnectedRunner = new TrueForgeMissionRunner(reconnectedService, client, config);
  const binding = await reconnectedRunner.resumeMission(mission.id);
  const result = await reconnectedRunner.runTurn(mission.id, "Continue the bounded inspection.", {
    previousTurnId: "turn-from-before-reconnect",
  });

  assert.deepEqual(binding, { sessionId: "session-created", created: false });
  assert.deepEqual(calls.get, ["session-created", "session-created"]);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.turns[0].sessionId, "session-created");
  assert.equal(calls.turns[0].request.previousTurnId, "turn-from-before-reconnect");
  assert.equal(result.mission.trueforgeSessionId, "session-created");
});

test("runner can attach an existing TrueForge session without creating another", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client, calls } = fakeClient();
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "google-gemini/test-model",
  });

  const mission = await runner.createMission({
    id: "mission-attach-trueforge",
    objective: "Use an existing execution session",
    trueforgeSessionId: "session-existing",
  });

  assert.equal(mission.trueforgeSessionId, "session-existing");
  assert.deepEqual(calls.create, []);
  assert.deepEqual(calls.get, ["session-existing"]);
});

test("repository inspection proves the MCP call and returned file resource", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client, calls } = fakeClient(repositoryEvents);
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "google-gemini/test-model",
    mcpServers: [{ name: "github", enableTools: ["get_file_contents"] }],
  });
  const mission = await runner.createMission({
    id: "mission-mcp-inspection",
    objective: "Inspect the selected repository fixture",
    repository: { owner: "owner", name: "repo", ref: "main" },
  });

  const inspection = await runner.inspectRepository({
    missionId: mission.id,
    path: "package.json",
  });

  assert.equal(inspection.resourceUri, "repo://owner/repo/refs/heads/main/contents/package.json");
  assert.deepEqual(JSON.parse(inspection.content), { name: "fixture" });
  assert.equal(inspection.contentBytes, inspection.content.length);
  assert.equal(calls.turns.length, 1);
  assert.match(
    calls.turns[0].request.input[0].content,
    /get_file_contents exactly once.*owner.*repo.*package\.json/s,
  );
  const state = await missions.getState();
  const proof = state.evidence.find((item) => item.id === inspection.evidenceId);
  assert.equal(proof.source, "mcp");
  assert.equal(proof.result, "passed");
  assert.equal(state.missions[0].status, "draft");
});

test("failed MCP verification is durable and blocks the mission", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client } = fakeClient();
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "google-gemini/test-model",
    mcpServers: [{ name: "github", enableTools: ["get_file_contents"] }],
  });
  const mission = await runner.createMission({
    id: "mission-mcp-failure",
    objective: "Reject unverified repository findings",
    repository: { owner: "owner", name: "repo", ref: "main" },
  });

  await assert.rejects(
    runner.inspectRepository({ missionId: mission.id, path: "package.json" }),
    /Expected exactly one get_file_contents MCP call/,
  );
  const state = await missions.getState();
  assert.equal(state.missions[0].status, "blocked");
  assert.equal(
    state.evidence.some((item) => item.source === "mcp" && item.result === "failed"),
    true,
  );
});

test("sandbox verification persists the command, output summary, and exit status", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client, calls } = fakeClient(sandboxEvents);
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "google-gemini/test-model",
  });
  const mission = await runner.createMission({
    id: "mission-sandbox-verification",
    objective: "Run a bounded repository verification",
  });

  const verification = await runner.runSandboxVerification({
    missionId: mission.id,
    command: "node --test",
  });

  assert.equal(verification.toolName, "exec");
  assert.equal(verification.exitCode, 0);
  assert.match(verification.stdout, /all tests passed/);
  assert.equal(calls.turns[0].request.input[0].content.includes("node --test"), true);
  const state = await missions.getState();
  const proof = state.evidence.find((item) => item.id === verification.evidenceId);
  assert.equal(proof.source, "sandbox");
  assert.equal(proof.result, "passed");
  assert.match(proof.details, /"exit_code":0/);
  assert.match(proof.details, /all tests passed/);
});

test("nonzero sandbox execution is recorded as failure and blocks the mission", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client } = fakeClient((turnId) => sandboxEvents(turnId, 1));
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "google-gemini/test-model",
  });
  const mission = await runner.createMission({
    id: "mission-sandbox-failure",
    objective: "Reject a failing verification command",
  });

  await assert.rejects(
    runner.runSandboxVerification({
      missionId: mission.id,
      command: "node --test",
    }),
    (error) => {
      assert.equal(error.operation, "run sandbox verification");
      assert.match(error.message, /exited with code 1/);
      return true;
    },
  );
  const state = await missions.getState();
  assert.equal(state.missions[0].status, "blocked");
  assert.equal(
    state.evidence.some((item) => item.source === "sandbox" && item.result === "failed"),
    true,
  );
  assert.equal(
    state.evidence.some((item) => item.source === "sandbox" && item.result === "passed"),
    false,
  );
});

test("sandbox verification rejects a done turn with pending required actions", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client } = fakeClient((turnId) => sandboxEvents(
    turnId,
    0,
    [{ type: "tool.approval_required" }],
  ));
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "google-gemini/test-model",
  });
  const mission = await runner.createMission({
    id: "mission-sandbox-pending-action",
    objective: "Reject sandbox proof while approval remains pending",
  });

  await assert.rejects(
    runner.runSandboxVerification({ missionId: mission.id, command: "node --test" }),
    (error) => {
      assert.equal(error.operation, "run sandbox verification");
      assert.match(error.message, /paused with required actions/);
      return true;
    },
  );
  const state = await missions.getState();
  assert.equal(state.missions[0].status, "blocked");
  assert.equal(
    state.evidence.some((item) => item.source === "sandbox" && item.result === "passed"),
    false,
  );
});

test("sandbox verification requires the canonical exec tool", async () => {
  const cases = [
    {
      id: "mission-sandbox-configured-tool",
      config: { sandboxToolName: "sandbox_exec" },
      input: {},
    },
    {
      id: "mission-sandbox-input-tool",
      config: {},
      input: { toolName: "sandbox_exec" },
    },
  ];

  for (const fixture of cases) {
    const missions = new MissionService(new InMemoryMissionRepository());
    const { client, calls } = fakeClient(sandboxEvents);
    const runner = new TrueForgeMissionRunner(missions, client, {
      model: "google-gemini/test-model",
      ...fixture.config,
    });
    const mission = await runner.createMission({
      id: fixture.id,
      objective: "Reject a non-canonical sandbox execution tool",
    });

    await assert.rejects(
      runner.runSandboxVerification({
        missionId: mission.id,
        command: "node --test",
        ...fixture.input,
      }),
      (error) => {
        assert.equal(error.operation, "run sandbox verification");
        assert.match(error.message, /canonical TrueForge exec tool/);
        return true;
      },
    );
    assert.equal(calls.turns.length, 0);
  }
});
