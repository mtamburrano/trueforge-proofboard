import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryMissionRepository,
  MissionService,
  TrueForgeMissionRunner,
} from "../dist/index.js";

const LOCKED_FIXTURE_SHA = "590aa8a6d72c580f61fc1b19d33e9876bc0feb9b";
const SANDBOX_VERIFICATION_INTENT = "Run the requested verification command in the sandbox.";
const LOCKED_FIXTURE_PATCHES = {
  "src/index.ts": [
    "@@ -0,0 +1,11 @@",
    "+export const productName = \"TrueForge Proof Board\" as const;",
    "+",
    "+export const productThesis = \"Verified autonomous software delivery\" as const;",
    "+",
    "+export const deliveryStages = [\"Plan\", \"Execute\", \"Prove\", \"Approve\"] as const;",
    "+",
    "+export type DeliveryStage = (typeof deliveryStages)[number];",
    "+",
    "+export function getProductSummary(): string {",
    "+  return `${productName}: ${productThesis} — ${deliveryStages.join(\" → \")}`;",
    "+}",
  ].join("\n"),
  "test/index.test.js": [
    "@@ -0,0 +1,19 @@",
    "+import assert from \"node:assert/strict\";",
    "+import test from \"node:test\";",
    "+",
    "+import {",
    "+  deliveryStages,",
    "+  getProductSummary,",
    "+  productName,",
    "+  productThesis,",
    "+} from \"../dist/index.js\";",
    "+",
    "+test(\"exports the product identity and delivery thesis\", () => {",
    "+  assert.equal(productName, \"TrueForge Proof Board\");",
    "+  assert.equal(productThesis, \"Verified autonomous software delivery\");",
    "+  assert.deepEqual(deliveryStages, [\"Plan\", \"Execute\", \"Prove\", \"Approve\"]);",
    "+  assert.equal(",
    "+    getProductSummary(),",
    "+    \"TrueForge Proof Board: Verified autonomous software delivery — Plan → Execute → Prove → Approve\",",
    "+  );",
    "+});",
  ].join("\n"),
};

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

function contractReviewEvents(
  turnId = "turn-1",
  output = {
    outcome: "accepted",
    reviewer: "trueforge-contract-reviewer",
    summary: "The changed state satisfies the bounded contract.",
    finding: "No blocking findings.",
  },
) {
  return [
    {
      type: "turn.created",
      id: "event-review-turn-created",
      createdAt: "2026-08-26T16:00:00.000Z",
      threadId: null,
      turnId,
      state: { status: "running" },
    },
    {
      type: "model.message",
      id: "event-review-model",
      createdAt: "2026-08-26T16:00:01.000Z",
      threadId: "thread-review",
      content: typeof output === "string" ? output : JSON.stringify(output),
    },
    {
      type: "turn.done",
      id: "event-review-turn-done",
      createdAt: "2026-08-26T16:00:02.000Z",
      threadId: null,
      state: { status: "done", requiredActions: [] },
    },
  ];
}

function repositoryEvents(
  turnId = "turn-1",
  ref = "main",
  resourceRef = "refs/heads/main",
) {
  const repositoryArguments = JSON.stringify({
    owner: "owner",
    repo: "repo",
    path: "package.json",
    ref,
  });
  const argumentSplit = Math.ceil(repositoryArguments.length / 2);
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
      type: "model.message.delta",
      id: "event-model",
      createdAt: "2026-08-26T16:00:02.000Z",
      threadId: "thread-1",
      toolCalls: [{
        index: 0,
        id: "call-mcp",
        function: {
          name: "get_file_contents",
          arguments: repositoryArguments.slice(0, argumentSplit),
        },
      }],
    },
    {
      type: "model.message.delta",
      id: "event-model-arguments",
      createdAt: "2026-08-26T16:00:02.500Z",
      threadId: "thread-1",
      toolCalls: [{
        index: 0,
        function: {
          arguments: repositoryArguments.slice(argumentSplit),
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
            uri: `repo://owner/repo/${resourceRef}/contents/package.json`,
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

function lockedCommitEvents(
  turnId = "turn-1",
  {
    argumentsValue = {
      owner: "mtamburrano",
      repo: "trueforge-proofboard",
      sha: LOCKED_FIXTURE_SHA,
      detail: "full_patch",
    },
    sha = LOCKED_FIXTURE_SHA,
    patches = LOCKED_FIXTURE_PATCHES,
    responseContent,
    responseCallId = "call-commit",
    attempts,
  } = {},
) {
  const commitAttempts = attempts ?? [{
    callId: "call-commit",
    argumentsValue,
    sha,
    patches,
    responseContent,
    responseCallId,
  }];
  const attemptEvents = commitAttempts.flatMap((attempt, index) => {
    const commitArguments = JSON.stringify(attempt.argumentsValue);
    const argumentSplit = Math.ceil(commitArguments.length / 2);
    const commitPayload = {
      sha: attempt.sha,
      files: Object.entries(attempt.patches).map(([filename, patch]) => ({ filename, patch })),
    };
    const callId = attempt.callId ?? `call-commit-${index + 1}`;
    const responseCallIdForAttempt = attempt.responseCallId ?? callId;
    return [
      {
        type: "model.message.delta",
        id: `event-model-${index + 1}`,
        createdAt: "2026-08-26T16:00:02.000Z",
        threadId: "thread-1",
        toolCalls: [{
          index,
          id: callId,
          function: {
            name: "get_commit",
            arguments: commitArguments.slice(0, argumentSplit),
          },
        }],
      },
      {
        type: "model.message.delta",
        id: `event-model-${index + 1}-arguments`,
        createdAt: "2026-08-26T16:00:02.500Z",
        threadId: "thread-1",
        toolCalls: [{
          index,
          function: {
            arguments: commitArguments.slice(argumentSplit),
          },
        }],
      },
      {
        type: "tool.response",
        id: `event-tool-response-${index + 1}`,
        createdAt: "2026-08-26T16:00:03.000Z",
        threadId: "thread-1",
        toolCallId: responseCallIdForAttempt,
        content: attempt.responseContent ?? JSON.stringify(commitPayload),
      },
    ];
  });
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
    ...attemptEvents,
    {
      type: "turn.done",
      id: "event-turn-done",
      createdAt: "2026-08-26T16:00:04.000Z",
      threadId: null,
      state: { status: "done", requiredActions: [] },
    },
  ];
}

function sandboxEvents(
  turnId = "turn-1",
  exitCode = 0,
  requiredActions = [],
  {
    sandboxArguments = {
      intent: SANDBOX_VERIFICATION_INTENT,
      command: "node --test",
    },
    sandboxResult = {
      success: true,
      response: {
        exitCode,
        result: exitCode === 0 ? "all tests passed\n" : "test failed\n",
      },
    },
    includeSandboxCreated = true,
    sandboxId = "sandbox-1",
    includeSandboxCall = true,
    additionalSandboxCalls = [],
    responseCallId = "call-exec",
    responseContent,
    includeToolResponse = true,
    includeTurnDone = true,
    turnState = { status: "done", requiredActions },
  } = {},
) {
  const events = [
    {
      type: "turn.created",
      id: "event-turn-created",
      createdAt: "2026-08-26T16:00:00.000Z",
      threadId: null,
      turnId,
      state: { status: "running" },
    },
  ];
  if (includeSandboxCreated) {
    events.push({
      type: "sandbox.created",
      id: "event-sandbox",
      createdAt: "2026-08-26T16:00:01.000Z",
      threadId: null,
      sandboxId,
    });
  }
  if (includeSandboxCall) {
    events.push({
      type: "model.message",
      id: "event-model",
      createdAt: "2026-08-26T16:00:02.000Z",
      threadId: "thread-1",
      toolCalls: [
        {
          id: "call-exec",
          function: {
            name: "exec",
            arguments: JSON.stringify(sandboxArguments),
          },
        },
        ...additionalSandboxCalls.map((call) => ({
          id: call.callId,
          function: {
            name: call.toolName ?? "exec",
            arguments: JSON.stringify(call.argumentsValue),
          },
        })),
      ],
    });
  }
  if (includeToolResponse) {
    events.push({
      type: "tool.response",
      id: "event-tool-response",
      createdAt: "2026-08-26T16:00:03.000Z",
      threadId: "thread-1",
      toolCallId: responseCallId,
      content: responseContent ?? JSON.stringify(sandboxResult),
    });
  }
  if (includeTurnDone) {
    events.push({
      type: "turn.done",
      id: "event-turn-done",
      createdAt: "2026-08-26T16:00:04.000Z",
      threadId: null,
      state: turnState,
    });
  }
  return events;
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
  assert.equal(state.missions[0].trueforgeSandboxId, "sandbox-1");
  assert.equal(state.evidence.length, 6);
  assert.equal(state.evidence.every((item) => item.workItemId === workItem.id), true);
  const serializedState = JSON.stringify(state);
  assert.doesNotMatch(serializedState, /do-not-persist|This content should not be persisted/);
});

test("runner performs an independent bounded contract review", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client, calls } = fakeClient(contractReviewEvents);
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "google-gemini/test-model",
  });
  const mission = await runner.createMission({
    id: "mission-contract-review",
    objective: "Review a bounded implementation",
  });
  const workItem = await missions.addWorkItem(mission.id, {
    id: "work-contract-review",
    title: "Implement the stage transition helper",
    purpose: "Add the requested transition behavior to the verified source.",
    acceptanceCriteria: ["Plan advances to Execute and terminal Approve returns null."],
    requiredChecks: ["test"],
    assignedRole: "implementer",
    status: "ready",
  });

  const review = await runner.reviewContract({
    workItem,
    handoff: {},
    filesChanged: ["src/index.ts"],
    actualFilesChanged: ["src/index.ts"],
    actualDiff: "diff --git a/src/index.ts b/src/index.ts\n+export function getNextDeliveryStage(stage) {}",
    diffSummary: "src/index.ts changed.",
    checks: [{
      name: "test",
      command: "npm test",
      result: "passed",
      required: true,
      evidenceIds: ["evidence-test"],
      exitCode: 0,
    }],
    evidence: [],
  });

  assert.deepEqual(review, {
    outcome: "accepted",
    reviewer: "trueforge-contract-reviewer",
    summary: "The changed state satisfies the bounded contract.",
    finding: "No blocking findings.",
  });
  assert.equal(calls.turns.length, 1);
  const instruction = calls.turns[0].request.input[0].content;
  assert.match(instruction, /independent contract review/);
  assert.match(instruction, /acceptanceCriteria/);
  assert.match(instruction, /actualDiff/);
  assert.match(instruction, /src\/index\.ts/);
  assert.match(instruction, /Do not rely on implementer narration/);
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

test("pull request delivery pauses one exact TrueForge tool call and resumes only after approval", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const target = {
    owner: "mtamburrano",
    repo: "proofboard-demo-fixture",
    base: "main",
    head: "proofboard-verified-delivery",
    title: "Add the verified delivery-stage helper",
    body: "Verified delivery body.",
  };
  const { client, calls } = fakeClient((turnId) => {
    if (turnId === "turn-1") {
      const toolCall = {
        id: "call-create-pr",
        function: { name: "create_pull_request", arguments: JSON.stringify(target) },
      };
      const approval = {
        type: "tool.approval_required",
        id: "approval-event",
        createdAt: "2026-08-28T08:00:02.000Z",
        threadId: "thread-delivery",
        toolCalls: [{ id: "call-create-pr", sourceEventId: "message-create-pr" }],
      };
      return [
        {
          type: "turn.created",
          id: "turn-created-delivery",
          createdAt: "2026-08-28T08:00:00.000Z",
          turnId,
          threadId: null,
        },
        {
          type: "model.message",
          id: "message-create-pr",
          createdAt: "2026-08-28T08:00:01.000Z",
          threadId: "thread-delivery",
          toolCalls: [toolCall],
        },
        approval,
        {
          type: "turn.done",
          id: "turn-paused-delivery",
          createdAt: "2026-08-28T08:00:03.000Z",
          threadId: null,
          state: { status: "done", requiredActions: [approval] },
        },
      ];
    }
    return [
      {
        type: "turn.created",
        id: "turn-created-delivery-resume",
        createdAt: "2026-08-28T08:01:00.000Z",
        turnId,
        threadId: null,
      },
      {
        type: "tool.response",
        id: "response-create-pr",
        createdAt: "2026-08-28T08:01:01.000Z",
        threadId: "thread-delivery",
        toolCallId: "call-create-pr",
        content: JSON.stringify({
          isError: false,
          structuredContent: {
            number: 42,
            html_url: "https://github.com/mtamburrano/proofboard-demo-fixture/pull/42",
          },
        }),
      },
      {
        type: "turn.done",
        id: "turn-done-delivery-resume",
        createdAt: "2026-08-28T08:01:02.000Z",
        threadId: null,
        state: { status: "done", requiredActions: [] },
      },
    ];
  });
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "google-gemini/test-model",
    mcpServerName: "github",
    deliveryToolName: "create_pull_request",
    mcpServers: [{
      name: "github",
      enableTools: ["create_pull_request"],
      preloadTools: ["create_pull_request"],
      requireApprovalForTools: ["create_pull_request"],
    }],
  });
  const mission = await runner.createMission({
    id: "mission-delivery-approval",
    objective: "Open only the verified delivery pull request",
  });

  const pending = await runner.requestPullRequestApproval(mission.id, target);
  assert.deepEqual(pending, {
    sessionId: "session-created",
    turnId: "turn-1",
    threadId: "thread-delivery",
    toolCallId: "call-create-pr",
    serverName: "github",
    toolName: "create_pull_request",
    target,
  });
  assert.equal(calls.turns.length, 1);
  assert.match(calls.turns[0].request.input[0].content, /create_pull_request exactly once/);
  assert.match(calls.turns[0].request.input[0].content, /proofboard-demo-fixture/);
  assert.equal(
    (await missions.getState()).evidence.some((item) =>
      item.summary === "TrueForge paused for tool approval."
    ),
    true,
  );

  const delivered = await runner.resolvePullRequestApproval(mission.id, pending, "approved");
  assert.deepEqual(delivered, {
    number: 42,
    url: "https://github.com/mtamburrano/proofboard-demo-fixture/pull/42",
    sessionId: "session-created",
    turnId: "turn-2",
    threadId: "thread-delivery",
    toolCallId: "call-create-pr",
  });
  assert.deepEqual(calls.turns[1].request, {
    input: [{
      type: "user.tool_approval",
      threadId: "thread-delivery",
      toolCallId: "call-create-pr",
      approval: { status: "allow" },
    }],
    previousTurnId: "turn-1",
  });
});

test("rejecting or cancelling a TrueForge delivery approval returns no protected result", async () => {
  for (const decision of ["rejected", "cancelled"]) {
    let protectedOperations = 0;
    const missions = new MissionService(new InMemoryMissionRepository());
    const target = {
      owner: "mtamburrano",
      repo: "proofboard-demo-fixture",
      base: "main",
      head: "proofboard-verified-delivery",
      title: "Verified fixture delivery",
      body: "Verified fixture delivery body.",
    };
    const { client, calls } = fakeClient((turnId) => {
      if (turnId === "turn-1") {
        const approval = {
          type: "tool.approval_required",
          id: `approval-${decision}`,
          createdAt: "2026-08-28T08:00:02.000Z",
          threadId: "thread-denied-delivery",
          toolCalls: [{ id: "call-denied-pr", sourceEventId: "message-denied-pr" }],
        };
        return [
          { type: "turn.created", id: "turn-start", createdAt: "2026-08-28T08:00:00.000Z", turnId, threadId: null },
          {
            type: "model.message",
            id: "message-denied-pr",
            createdAt: "2026-08-28T08:00:01.000Z",
            threadId: "thread-denied-delivery",
            toolCalls: [{
              id: "call-denied-pr",
              function: { name: "create_pull_request", arguments: JSON.stringify(target) },
            }],
          },
          approval,
          { type: "turn.done", id: "turn-paused", createdAt: "2026-08-28T08:00:03.000Z", threadId: null, state: { status: "done", requiredActions: [approval] } },
        ];
      }
      const approvalInput = calls.turns.at(-1).request.input[0];
      if (approvalInput.approval.status === "allow") {
        protectedOperations += 1;
      }
      return [
        { type: "turn.created", id: "turn-denied-start", createdAt: "2026-08-28T08:01:00.000Z", turnId, threadId: null },
        { type: "turn.done", id: "turn-denied-done", createdAt: "2026-08-28T08:01:01.000Z", threadId: null, state: { status: "done", requiredActions: [] } },
      ];
    });
    const runner = new TrueForgeMissionRunner(missions, client, {
      model: "google-gemini/test-model",
      mcpServerName: "github",
      mcpServers: [{
        name: "github",
        enableTools: ["create_pull_request"],
        requireApprovalForTools: ["create_pull_request"],
      }],
    });
    const mission = await runner.createMission({
      id: `mission-${decision}-delivery`,
      objective: "Keep denied delivery fail closed",
    });
    const pending = await runner.requestPullRequestApproval(mission.id, target);
    const result = await runner.resolvePullRequestApproval(mission.id, pending, decision);

    assert.equal(result, null);
    assert.equal(protectedOperations, 0);
    assert.equal(calls.turns[1].request.input[0].approval.status, "deny");
    assert.match(calls.turns[1].request.input[0].approval.reason, new RegExp(decision));
  }
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

test("locked fixture inspection proves direct TrueForge get_commit content and expected patches", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client, calls } = fakeClient(lockedCommitEvents);
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "google-gemini/test-model",
    mcpServers: [{ name: "github", enableTools: ["get_file_contents", "get_commit"] }],
  });
  const mission = await runner.createMission({
    id: "mission-mcp-pinned-fixture",
    objective: "Inspect the locked repository fixture by commit",
    repository: {
      owner: "mtamburrano",
      name: "trueforge-proofboard",
      ref: LOCKED_FIXTURE_SHA,
    },
  });

  const inspection = await runner.inspectRepository({
    missionId: mission.id,
  });

  assert.equal(inspection.toolName, "get_commit");
  assert.equal(inspection.commitSha, LOCKED_FIXTURE_SHA);
  assert.deepEqual(inspection.patches, LOCKED_FIXTURE_PATCHES);
  assert.match(calls.turns[0].request.input[0].content, /get_commit with this exact JSON object/);
  assert.match(calls.turns[0].request.input[0].content, /"owner":"mtamburrano"/);
  assert.match(calls.turns[0].request.input[0].content, /"repo":"trueforge-proofboard"/);
  assert.match(calls.turns[0].request.input[0].content, new RegExp(LOCKED_FIXTURE_SHA));
  assert.match(calls.turns[0].request.input[0].content, /"detail":"full_patch"/);

  const state = await missions.getState();
  const proof = state.evidence.find((item) => item.id === inspection.evidenceId);
  const details = JSON.parse(proof.details);
  assert.deepEqual(details.arguments, {
    owner: "mtamburrano",
    repo: "trueforge-proofboard",
    sha: LOCKED_FIXTURE_SHA,
    detail: "full_patch",
  });
  assert.equal(details.commit_sha, LOCKED_FIXTURE_SHA);
  assert.deepEqual(details.patches, LOCKED_FIXTURE_PATCHES);
});

test("locked fixture inspection ignores a non-canonical attempt before a canonical call", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client } = fakeClient((turnId) => lockedCommitEvents(turnId, {
    attempts: [
      {
        callId: "call-non-canonical",
        argumentsValue: {
          owner: "mtambuarano",
          repo: "trueforge-proofboard",
          sha: LOCKED_FIXTURE_SHA,
          detail: "full_patch",
        },
        responseContent: "not-json",
        sha: "0000000000000000000000000000000000000000",
        patches: LOCKED_FIXTURE_PATCHES,
      },
      {
        callId: "call-canonical",
        argumentsValue: {
          owner: "mtamburrano",
          repo: "trueforge-proofboard",
          sha: LOCKED_FIXTURE_SHA,
          detail: "full_patch",
        },
        sha: LOCKED_FIXTURE_SHA,
        patches: LOCKED_FIXTURE_PATCHES,
      },
    ],
  }));
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "google-gemini/test-model",
    mcpServers: [{ name: "github", enableTools: ["get_commit"] }],
  });
  const mission = await runner.createMission({
    id: "mission-mcp-pinned-retry-success",
    objective: "Ignore a rejected read-only attempt and accept canonical provenance",
    repository: {
      owner: "mtamburrano",
      name: "trueforge-proofboard",
      ref: LOCKED_FIXTURE_SHA,
    },
  });

  const inspection = await runner.inspectRepository({ missionId: mission.id });

  assert.equal(inspection.commitSha, LOCKED_FIXTURE_SHA);
  assert.deepEqual(inspection.patches, LOCKED_FIXTURE_PATCHES);
  const state = await missions.getState();
  const proof = state.evidence.find((item) => item.id === inspection.evidenceId);
  assert.equal(proof.source, "mcp");
  assert.equal(proof.result, "passed");
});

test("locked fixture inspection rejects when no canonical get_commit call exists", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client } = fakeClient((turnId) => lockedCommitEvents(turnId, {
    attempts: [
      {
        callId: "call-non-canonical",
        argumentsValue: {
          owner: "mtambuarano",
          repo: "trueforge-proofboard",
          sha: LOCKED_FIXTURE_SHA,
          detail: "full_patch",
        },
        sha: LOCKED_FIXTURE_SHA,
        patches: LOCKED_FIXTURE_PATCHES,
      },
    ],
  }));
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "google-gemini/test-model",
    mcpServers: [{ name: "github", enableTools: ["get_commit"] }],
  });
  const mission = await runner.createMission({
    id: "mission-mcp-pinned-arguments-failure",
    objective: "Reject a non-canonical locked fixture inspection",
    repository: {
      owner: "mtamburrano",
      name: "trueforge-proofboard",
      ref: LOCKED_FIXTURE_SHA,
    },
  });

  await assert.rejects(
    runner.inspectRepository({ missionId: mission.id }),
    /Expected exactly one canonical get_commit MCP call, found 0/,
  );
  const state = await missions.getState();
  assert.equal(state.missions[0].status, "blocked");
  assert.equal(
    state.evidence.some((item) => item.source === "mcp" && item.result === "passed"),
    false,
  );
});

test("locked fixture inspection rejects multiple canonical get_commit calls", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const canonicalArguments = {
    owner: "mtamburrano",
    repo: "trueforge-proofboard",
    sha: LOCKED_FIXTURE_SHA,
    detail: "full_patch",
  };
  const { client } = fakeClient((turnId) => lockedCommitEvents(turnId, {
    attempts: [
      {
        callId: "call-canonical-1",
        argumentsValue: canonicalArguments,
        sha: LOCKED_FIXTURE_SHA,
        patches: LOCKED_FIXTURE_PATCHES,
      },
      {
        callId: "call-canonical-2",
        argumentsValue: canonicalArguments,
        sha: LOCKED_FIXTURE_SHA,
        patches: LOCKED_FIXTURE_PATCHES,
      },
    ],
  }));
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "google-gemini/test-model",
    mcpServers: [{ name: "github", enableTools: ["get_commit"] }],
  });
  const mission = await runner.createMission({
    id: "mission-mcp-pinned-multiple-canonical-failure",
    objective: "Reject ambiguous canonical repository provenance",
    repository: {
      owner: "mtamburrano",
      name: "trueforge-proofboard",
      ref: LOCKED_FIXTURE_SHA,
    },
  });

  await assert.rejects(
    runner.inspectRepository({ missionId: mission.id }),
    /Expected exactly one canonical get_commit MCP call, found 2/,
  );
  const state = await missions.getState();
  assert.equal(state.missions[0].status, "blocked");
  assert.equal(
    state.evidence.some((item) => item.source === "mcp" && item.result === "passed"),
    false,
  );
});

test("locked fixture inspection rejects a wrong SHA or expected patch", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client } = fakeClient((turnId) => lockedCommitEvents(turnId, {
    sha: "0000000000000000000000000000000000000000",
    patches: {
      ...LOCKED_FIXTURE_PATCHES,
      "src/index.ts": `${LOCKED_FIXTURE_PATCHES["src/index.ts"]}\n+tampered`,
    },
  }));
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "google-gemini/test-model",
    mcpServers: [{ name: "github", enableTools: ["get_commit"] }],
  });
  const mission = await runner.createMission({
    id: "mission-mcp-pinned-result-failure",
    objective: "Reject an unverified locked fixture result",
    repository: {
      owner: "mtamburrano",
      name: "trueforge-proofboard",
      ref: LOCKED_FIXTURE_SHA,
    },
  });

  await assert.rejects(
    runner.inspectRepository({ missionId: mission.id }),
    /get_commit MCP response did not contain the pinned SHA and expected file patches/,
  );
  const state = await missions.getState();
  assert.equal(state.missions[0].status, "blocked");
  assert.equal(
    state.evidence.some((item) => item.source === "mcp" && item.result === "passed"),
    false,
  );
});

test("locked fixture inspection rejects malformed, error, and uncorrelated responses", async () => {
  const cases = [
    {
      label: "malformed",
      options: { responseContent: "not-json" },
      error: /get_commit MCP response was not a JSON object/,
    },
    {
      label: "non-object",
      options: { responseContent: JSON.stringify(["not a commit"]) },
      error: /get_commit MCP response was not a JSON object/,
    },
    {
      label: "error",
      options: { responseContent: JSON.stringify({ isError: true }) },
      error: /get_commit MCP returned an error result/,
    },
    {
      label: "uncorrelated",
      options: { responseCallId: "different-call" },
      error: /get_commit MCP call has no structured response/,
    },
  ];

  for (const fixture of cases) {
    const missions = new MissionService(new InMemoryMissionRepository());
    const { client } = fakeClient((turnId) => lockedCommitEvents(turnId, fixture.options));
    const runner = new TrueForgeMissionRunner(missions, client, {
      model: "google-gemini/test-model",
      mcpServers: [{ name: "github", enableTools: ["get_commit"] }],
    });
    const mission = await runner.createMission({
      id: `mission-mcp-pinned-${fixture.label}-failure`,
      objective: "Reject an invalid locked fixture response",
      repository: {
        owner: "mtamburrano",
        name: "trueforge-proofboard",
        ref: LOCKED_FIXTURE_SHA,
      },
    });

    await assert.rejects(
      runner.inspectRepository({ missionId: mission.id }),
      fixture.error,
      fixture.label,
    );
    const state = await missions.getState();
    assert.equal(state.missions[0].status, "blocked", fixture.label);
    assert.equal(
      state.evidence.some((item) => item.source === "mcp" && item.result === "passed"),
      false,
      fixture.label,
    );
  }
});

test("repository inspection does not double-prefix canonical Git refs", async () => {
  const canonicalRef = "refs/heads/main";
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client } = fakeClient((turnId) => repositoryEvents(
    turnId,
    canonicalRef,
    canonicalRef,
  ));
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "google-gemini/test-model",
    mcpServers: [{ name: "github", enableTools: ["get_file_contents"] }],
  });
  const mission = await runner.createMission({
    id: "mission-mcp-canonical-ref",
    objective: "Inspect a repository with a canonical branch ref",
    repository: { owner: "owner", name: "repo", ref: canonicalRef },
  });

  const inspection = await runner.inspectRepository({
    missionId: mission.id,
    path: "package.json",
  });

  assert.equal(
    inspection.resourceUri,
    "repo://owner/repo/refs/heads/main/contents/package.json",
  );
});

test("repository inspection rejects a text-only MCP response without resource provenance", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client } = fakeClient((turnId) => {
    const events = repositoryEvents(turnId);
    events.find((event) => event.type === "tool.response").content =
      "successfully downloaded text file (SHA: fixture-blob-sha)";
    return events;
  });
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "google-gemini/test-model",
    mcpServers: [{ name: "github", enableTools: ["get_file_contents"] }],
  });
  const mission = await runner.createMission({
    id: "mission-mcp-text-only-response",
    objective: "Reject repository content without a structured provenance resource",
    repository: { owner: "owner", name: "repo", ref: "main" },
  });

  await assert.rejects(
    runner.inspectRepository({ missionId: mission.id, path: "package.json" }),
    /get_file_contents MCP response was not a JSON object/,
  );
  const state = await missions.getState();
  assert.equal(state.missions[0].status, "blocked");
  assert.equal(
    state.evidence.some((item) => item.source === "mcp" && item.result === "passed"),
    false,
  );
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
  const instruction = calls.turns[0].request.input[0].content;
  const argumentsMatch = instruction.match(/this JSON object: (\{[^}]+\})\./);
  assert.ok(argumentsMatch);
  assert.deepEqual(JSON.parse(argumentsMatch[1]), {
    intent: SANDBOX_VERIFICATION_INTENT,
    command: "node --test",
  });
  const state = await missions.getState();
  const proof = state.evidence.find((item) => item.id === verification.evidenceId);
  assert.equal(proof.source, "sandbox");
  assert.equal(proof.result, "passed");
  assert.match(proof.details, /"intent":"Run the requested verification command in the sandbox\."/);
  assert.match(proof.details, /"exit_code":0/);
  assert.match(proof.details, /all tests passed/);
});

test("sandbox verification resumes the persisted sandbox without creating another one", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client, calls } = fakeClient((turnId) => sandboxEvents(turnId, 0, [], {
    includeSandboxCreated: false,
  }));
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "google-gemini/test-model",
  });
  const mission = await runner.createMission({
    id: "mission-sandbox-continuity",
    objective: "Reuse the implementation sandbox for verification",
  });
  await missions.attachTrueforgeTurn(mission.id, "implementation-turn");
  await missions.attachTrueforgeSandbox(mission.id, "sandbox-1");

  const verification = await runner.runSandboxVerification({
    missionId: mission.id,
    command: "node --test",
  });

  assert.equal(calls.turns[0].request.previousTurnId, "implementation-turn");
  assert.equal(verification.sandboxId, "sandbox-1");
  const state = await missions.getState();
  assert.equal(state.missions[0].trueforgeSandboxId, "sandbox-1");
  assert.equal(state.missions[0].trueforgeTurnId, "turn-1");
});

test("sandbox verification fails closed when a persisted sandbox has no predecessor turn", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client, calls } = fakeClient((turnId) => sandboxEvents(turnId, 0, [], {
    includeSandboxCreated: false,
  }));
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "google-gemini/test-model",
  });
  const mission = await runner.createMission({
    id: "mission-sandbox-without-turn",
    objective: "Reject unverifiable sandbox continuation",
    trueforgeSandboxId: "sandbox-1",
  });

  await assert.rejects(
    runner.runSandboxVerification({ missionId: mission.id, command: "node --test" }),
    /no durable predecessor turn/,
  );
  assert.equal(calls.turns.length, 0);
  const state = await missions.getState();
  assert.equal(state.missions[0].trueforgeSandboxId, "sandbox-1");
  assert.equal(
    state.evidence.some((item) => item.source === "sandbox" && item.result === "passed"),
    false,
  );
});

test("sandbox continuity rejects a replacement sandbox identity", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client } = fakeClient((turnId) => sandboxEvents(turnId, 0, [], {
    sandboxId: "sandbox-2",
  }));
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "google-gemini/test-model",
  });
  const mission = await runner.createMission({
    id: "mission-sandbox-replacement",
    objective: "Reject a changed sandbox identity",
  });
  await missions.attachTrueforgeTurn(mission.id, "implementation-turn");
  await missions.attachTrueforgeSandbox(mission.id, "sandbox-1");

  await assert.rejects(
    runner.runSandboxVerification({ missionId: mission.id, command: "node --test" }),
    /different from the persisted mission sandbox/,
  );
  const state = await missions.getState();
  assert.equal(state.missions[0].trueforgeSandboxId, "sandbox-1");
  assert.equal(
    state.evidence.some((item) => item.source === "sandbox" && item.result === "passed"),
    false,
  );
});

test("sandbox verification rejects incomplete or non-canonical proof", async () => {
  const cases = [
    {
      label: "missing intent",
      options: { sandboxArguments: { command: "node --test" } },
      error: /Expected exactly one canonical exec sandbox call, found 0/,
    },
    {
      label: "wrong intent",
      options: {
        sandboxArguments: {
          intent: "Run an unrelated command.",
          command: "node --test",
        },
      },
      error: /Expected exactly one canonical exec sandbox call, found 0/,
    },
    {
      label: "wrong command",
      options: {
        sandboxArguments: {
          intent: SANDBOX_VERIFICATION_INTENT,
          command: "npm test",
        },
      },
      error: /Expected exactly one canonical exec sandbox call, found 0/,
    },
    {
      label: "extra argument",
      options: {
        sandboxArguments: {
          intent: SANDBOX_VERIFICATION_INTENT,
          command: "node --test",
          cwd: "/tmp",
        },
      },
      error: /Expected exactly one canonical exec sandbox call, found 0/,
    },
    {
      label: "missing sandbox creation",
      options: { includeSandboxCreated: false },
      error: /did not record sandbox creation/,
    },
    {
      label: "no canonical exec call",
      options: { includeSandboxCall: false },
      error: /Expected exactly one canonical exec sandbox call, found 0/,
    },
    {
      label: "multiple canonical exec calls",
      options: {
        additionalSandboxCalls: [{
          callId: "call-exec-2",
          argumentsValue: {
            intent: SANDBOX_VERIFICATION_INTENT,
            command: "node --test",
          },
        }],
      },
      error: /Expected exactly one canonical exec sandbox call, found 2/,
    },
    {
      label: "uncorrelated response",
      options: { responseCallId: "call-other" },
      error: /exec sandbox call has no structured response/,
    },
    {
      label: "malformed response",
      options: { responseContent: "not-json" },
      error: /exec sandbox response was not a JSON object/,
    },
    {
      label: "success is not true",
      options: {
        sandboxResult: {
          success: "true",
          response: { exitCode: 0, result: "all tests passed\n" },
        },
      },
      error: /exec sandbox execution did not return success: true/,
    },
    {
      label: "missing response object",
      options: {
        sandboxResult: { success: true, response: "all tests passed\n" },
      },
      error: /exec sandbox response did not include a response object/,
    },
    {
      label: "invalid exit code",
      options: {
        sandboxResult: {
          success: true,
          response: { exitCode: "0", result: "all tests passed\n" },
        },
      },
      error: /non-numeric exit code/,
    },
    {
      label: "non-zero exit code",
      exitCode: 1,
      error: /exec sandbox command exited with code 1/,
    },
    {
      label: "non-string result",
      options: {
        sandboxResult: {
          success: true,
          response: { exitCode: 0, result: { output: "all tests passed" } },
        },
      },
      error: /exec sandbox response did not include string output/,
    },
    {
      label: "missing terminal turn",
      options: { includeTurnDone: false },
      error: /did not record a completed sandbox turn/,
    },
    {
      label: "incomplete terminal status",
      options: { turnState: { status: "running", requiredActions: [] } },
      error: /sandbox turn did not finish successfully/,
    },
    {
      label: "missing required actions",
      options: { turnState: { status: "done" } },
      error: /sandbox turn did not include required actions/,
    },
  ];

  for (const [index, fixture] of cases.entries()) {
    const missions = new MissionService(new InMemoryMissionRepository());
    const { client } = fakeClient((turnId) => sandboxEvents(
      turnId,
      fixture.exitCode ?? 0,
      [],
      fixture.options,
    ));
    const runner = new TrueForgeMissionRunner(missions, client, {
      model: "google-gemini/test-model",
    });
    const mission = await runner.createMission({
      id: `mission-sandbox-negative-${index}`,
      objective: `Reject ${fixture.label} sandbox proof`,
    });

    await assert.rejects(
      runner.runSandboxVerification({ missionId: mission.id, command: "node --test" }),
      (error) => {
        assert.equal(error.operation, "run sandbox verification", fixture.label);
        assert.match(error.message, fixture.error, fixture.label);
        return true;
      },
    );
    const state = await missions.getState();
    assert.equal(state.missions[0].status, "blocked", fixture.label);
    assert.equal(
      state.evidence.some((item) => item.source === "sandbox" && item.result === "passed"),
      false,
      fixture.label,
    );
  }
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
