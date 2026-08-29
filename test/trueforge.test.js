import assert from "node:assert/strict";
import test from "node:test";

import {
  COORDINATOR_TRUEFORGE_ITERATION_LIMIT,
  DEFAULT_TRUEFORGE_ITERATION_LIMIT,
  InMemoryMissionRepository,
  MAX_TRUEFORGE_ITERATION_LIMIT,
  MissionService,
  PRIMARY_VERIFIED_DELIVERY_PATCHES,
  PRIMARY_SANDBOX_REPOSITORY_ROOT,
  SANDBOX_SETUP_EXEC_LIMIT,
  SANDBOX_SETUP_ITERATION_LIMIT,
  SANDBOX_TOOLCHAIN_PROOF_COMMAND,
  SANDBOX_TOOLCHAIN_READINESS_COMMAND,
  SANDBOX_TOOLCHAIN_READINESS_INTENT,
  TrueForgeIntegrationError,
  TrueForgeMissionRunner,
  buildCoordinatorAgentSpec,
  buildMissionAgentSpec,
  createDaytonaSandboxExecutor,
  DaytonaSandboxExecutionError,
  resolveDaytonaSandboxId,
} from "../dist/index.js";

const LOCKED_FIXTURE_SHA = "590aa8a6d72c580f61fc1b19d33e9876bc0feb9b";
const LOCKED_FIXTURE_REF = LOCKED_FIXTURE_SHA;
const VERIFIED_DELIVERY_HEAD_SHA = "8bb22a62b3714f699204cb0d5c440fcb7f0a09e1";
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
      repo: "proofboard-demo-fixture",
      sha: LOCKED_FIXTURE_REF,
      detail: "full_patch",
      perPage: 100,
    },
    sha = LOCKED_FIXTURE_SHA,
    patches = LOCKED_FIXTURE_PATCHES,
    responseContent,
    responseCallId = "call-commit",
    attempts,
    turnState = { status: "done", requiredActions: [] },
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
      state: turnState,
    },
  ];
}

function zeroToolEvents(
  turnId = "turn-1",
  {
    content = "I completed the turn without invoking a tool.",
    includeSandboxCreated = false,
    sandboxId = "sandbox-1",
    turnState = { status: "done", requiredActions: [] },
  } = {},
) {
  const events = [
    {
      type: "turn.created",
      id: `${turnId}-created`,
      createdAt: "2026-08-29T08:00:00.000Z",
      threadId: null,
      turnId,
      state: { status: "running" },
    },
  ];
  if (includeSandboxCreated) {
    events.push({
      type: "sandbox.created",
      id: `${turnId}-sandbox`,
      createdAt: "2026-08-29T08:00:00.500Z",
      threadId: null,
      sandboxId,
    });
  }
  events.push(
    {
      type: "model.message",
      id: `${turnId}-model`,
      createdAt: "2026-08-29T08:00:01.000Z",
      threadId: "main",
      content,
    },
    {
      type: "turn.done",
      id: `${turnId}-done`,
      createdAt: "2026-08-29T08:00:02.000Z",
      threadId: null,
      state: turnState,
    },
  );
  return events;
}

function pullRequestReadbackEvents(
  turnId = "turn-4",
  {
    number = 42,
    url = "https://github.com/mtamburrano/proofboard-demo-fixture/pull/42",
    owner = "mtamburrano",
    repo = "proofboard-demo-fixture",
    base = "main",
    head = "proofboard-verified-delivery",
    headSha = VERIFIED_DELIVERY_HEAD_SHA,
    includeHeadSha = true,
  } = {},
) {
  const readback = {
    number,
    html_url: url,
    base: {
      ref: base,
      repo: { full_name: `${owner}/${repo}` },
    },
    head: {
      ref: head,
      ...(includeHeadSha ? { sha: headSha } : {}),
      repo: { full_name: `${owner}/${repo}` },
    },
  };
  return [
    {
      type: "turn.created",
      id: "event-readback-turn-created",
      createdAt: "2026-08-28T08:01:03.000Z",
      threadId: null,
      turnId,
      state: { status: "running" },
    },
    {
      type: "mcp.initialize",
      id: "event-readback-mcp",
      createdAt: "2026-08-28T08:01:04.000Z",
      threadId: "thread-readback",
      mcpServers: [{ name: "github" }],
    },
    {
      type: "model.message",
      id: "event-readback-call",
      createdAt: "2026-08-28T08:01:05.000Z",
      threadId: "thread-readback",
      toolCalls: [{
        id: "call-readback-pr",
        function: {
          name: "pull_request_read",
          arguments: JSON.stringify({
            method: "get",
            owner,
            repo,
            pullNumber: number,
          }),
        },
      }],
    },
    {
      type: "tool.response",
      id: "event-readback-response",
      createdAt: "2026-08-28T08:01:06.000Z",
      threadId: "thread-readback",
      toolCallId: "call-readback-pr",
      content: JSON.stringify({
        isError: false,
        structuredContent: readback,
      }),
    },
    {
      type: "turn.done",
      id: "event-readback-turn-done",
      createdAt: "2026-08-28T08:01:07.000Z",
      threadId: null,
      state: { status: "done", requiredActions: [] },
    },
  ];
}

function pullRequestSearchEvents(
  turnId = "turn-2",
  items = [{ number: 42, html_url: "https://github.com/mtamburrano/proofboard-demo-fixture/pull/42" }],
) {
  return [
    {
      type: "turn.created",
      id: `${turnId}-created`,
      createdAt: "2026-08-28T08:01:03.000Z",
      threadId: null,
      turnId,
      state: { status: "running" },
    },
    {
      type: "mcp.initialize",
      id: `${turnId}-mcp`,
      createdAt: "2026-08-28T08:01:04.000Z",
      threadId: "thread-reconcile",
      mcpServers: [{ name: "github" }],
    },
    {
      type: "model.message",
      id: `${turnId}-message`,
      createdAt: "2026-08-28T08:01:05.000Z",
      threadId: "thread-reconcile",
      toolCalls: [{
        id: `${turnId}-search-call`,
        function: {
          name: "search_pull_requests",
          arguments: JSON.stringify({
            query: "repo:mtamburrano/proofboard-demo-fixture is:pr head:mtamburrano:proofboard-verified-delivery base:main",
            owner: "mtamburrano",
            repo: "proofboard-demo-fixture",
            page: 1,
            perPage: 100,
          }),
        },
      }],
    },
    {
      type: "tool.response",
      id: `${turnId}-response`,
      createdAt: "2026-08-28T08:01:06.000Z",
      threadId: "thread-reconcile",
      toolCallId: `${turnId}-search-call`,
      content: JSON.stringify({ isError: false, structuredContent: { items } }),
    },
    {
      type: "turn.done",
      id: `${turnId}-done`,
      createdAt: "2026-08-28T08:01:07.000Z",
      threadId: null,
      state: { status: "done", requiredActions: [] },
    },
  ];
}

function deliveryApprovalEvents(turnId, target, readbackOptions = {}) {
  if (turnId === "turn-1") {
    const toolArguments = { ...target };
    delete toolArguments.headSha;
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
        toolCalls: [{
          id: "call-create-pr",
          function: { name: "create_pull_request", arguments: JSON.stringify(toolArguments) },
        }],
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
  if (turnId === "turn-2") {
    return lockedCommitEvents(turnId, {
      argumentsValue: {
        owner: target.owner,
        repo: target.repo,
        sha: target.head,
        detail: "full_patch",
        perPage: 100,
      },
      sha: target.headSha,
      patches: PRIMARY_VERIFIED_DELIVERY_PATCHES,
    });
  }
  if (turnId === "turn-3") {
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
            id: "PR_kwDOExample42",
            url: "https://github.com/mtamburrano/proofboard-demo-fixture/pull/42",
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
  }
  if (turnId === "turn-4") {
    return pullRequestReadbackEvents(turnId, {
      ...readbackOptions,
      owner: target.owner,
      repo: target.repo,
      base: target.base,
      head: target.head,
    });
  }
  throw new Error(`Unexpected delivery turn ${turnId}.`);
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
    execThreadId = "main",
    responseThreadId = "main",
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
      threadId: execThreadId,
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
      threadId: responseThreadId,
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

function fakeClient(eventFactory = fakeEvents, { passAgentSpec = false } = {}) {
  const calls = { create: [], get: [], updates: [], turns: [] };
  let activeAgentSpec;
  const client = {
    sessions: {
      async create(request) {
        calls.create.push(request);
        activeAgentSpec = request.agent.spec;
        return { data: { id: "session-created" } };
      },
      async get(sessionId) {
        calls.get.push(sessionId);
        return { data: { id: sessionId } };
      },
      async update(sessionId, request) {
        calls.updates.push({ sessionId, request });
        activeAgentSpec = request.agent.spec;
        return { data: { id: sessionId } };
      },
      async createTurnStream(sessionId, request) {
        const turnId = `turn-${calls.turns.length + 1}`;
        const turnCall = { sessionId, request, agentSpec: activeAgentSpec, events: [] };
        calls.turns.push(turnCall);
        const events = passAgentSpec
          ? eventFactory(turnId, activeAgentSpec)
          : eventFactory(turnId);
        turnCall.events = events;
        return fakeStream(events);
      },
    },
  };
  return { client, calls };
}

function fakeSandboxExecutor(commands, outputs, sandboxId) {
  const calls = [];
  return {
    calls,
    async execute(request) {
      const index = calls.length;
      assert.equal(request.sandboxId, sandboxId);
      assert.equal(request.command, commands[index]);
      calls.push(request);
      return {
        sandboxId,
        exitCode: 0,
        stdout: outputs[index],
      };
    },
  };
}

function sandboxSetupEvents(
  turnId,
  {
    commands = ["apt-get update", "apt-get install -y nodejs npm"],
    exitCodes = [1, 0],
    outputs = exitCodes.map((exitCode) => exitCode === 0 ? "setup complete\n" : "setup failed\n"),
    intents = commands.map((command) => `Prepare the sandbox with ${command}.`),
    execThreadId = "main",
    responseThreadId = "main",
    sandboxId = "sandbox-1",
    turnState,
  } = {},
) {
  assert.equal(commands.length, exitCodes.length);
  assert.equal(commands.length, outputs.length);
  assert.equal(commands.length, intents.length);
  const events = [
    {
      type: "turn.created",
      id: `${turnId}-created`,
      createdAt: "2026-08-26T16:00:00.000Z",
      threadId: null,
      turnId,
      state: { status: "running" },
    },
    {
      type: "sandbox.created",
      id: `${turnId}-sandbox`,
      createdAt: "2026-08-26T16:00:01.000Z",
      threadId: null,
      sandboxId,
    },
  ];
  commands.forEach((command, index) => {
    const callId = `${turnId}-setup-call-${index + 1}`;
    events.push(
      {
        type: "model.message",
        id: `${turnId}-model-${index + 1}`,
        createdAt: `2026-08-26T16:00:0${index + 2}.000Z`,
        threadId: execThreadId,
        toolCalls: [{
          id: callId,
          function: {
            name: "exec",
            arguments: JSON.stringify({ intent: intents[index], command }),
          },
        }],
      },
      {
        type: "tool.response",
        id: `${turnId}-response-${index + 1}`,
        createdAt: `2026-08-26T16:00:0${index + 3}.000Z`,
        threadId: responseThreadId,
        toolCallId: callId,
        content: JSON.stringify({
          success: true,
          response: {
            exitCode: exitCodes[index],
            result: outputs[index],
          },
        }),
      },
    );
  });
  events.push({
    type: "turn.done",
    id: `${turnId}-done`,
    createdAt: "2026-08-26T16:00:05.000Z",
    threadId: null,
    state: turnState ?? { status: "done", requiredActions: [] },
  });
  return events;
}

function sandboxToolchainProofEvents(
  turnId,
  {
    intent = SANDBOX_TOOLCHAIN_READINESS_INTENT,
    nodeVersion = "v22.14.0",
    npmVersion = "10.9.2",
    turnState,
    execThreadId = "main",
    responseThreadId = "main",
    sandboxId = "sandbox-1",
  } = {},
) {
  const command = SANDBOX_TOOLCHAIN_PROOF_COMMAND;

  assert.equal(command, SANDBOX_TOOLCHAIN_READINESS_COMMAND);
  assert.match(command, /node --version/);
  assert.match(command, /npm --version/);
  assert.doesNotMatch(command, /apt-get|nodesource|curl/);

  return sandboxEvents(turnId, 0, [], {
    sandboxArguments: {
      intent,
      command,
    },
    sandboxResult: {
      success: true,
      response: {
        exitCode: 0,
        result: `TRUEFORGE_TOOLCHAIN_PROOF node=${nodeVersion} npm=${npmVersion}\n`,
      },
    },
    includeSandboxCreated: false,
    sandboxId,
    execThreadId,
    responseThreadId,
    ...(turnState === undefined ? {} : { turnState }),
  });
}

function sandboxInstructionArguments(request) {
  const content = request?.input?.[0]?.content;
  assert.equal(typeof content, "string");
  const match = content.match(
    /Call the sandbox tool exec exactly once with this JSON object: (\{[\s\S]*?\})\./,
  );
  assert.ok(match, content);
  return JSON.parse(match[1]);
}

test("runner creates a TrueForge session and maps safe runtime evidence", async () => {
  const repository = new InMemoryMissionRepository();
  const missions = new MissionService(repository, () => new Date("2026-08-26T16:00:00.000Z"));
  const { client, calls } = fakeClient();
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
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

test("runner provisions a missing Debian 12 sandbox toolchain before delegated work", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client, calls } = fakeClient((turnId, agentSpec) =>
    agentSpec?.config?.iterationLimit === SANDBOX_SETUP_ITERATION_LIMIT
      ? sandboxSetupEvents(turnId)
      : sandboxToolchainProofEvents(turnId),
  { passAgentSpec: true });
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
  });
  const mission = await runner.createMission({
    id: "mission-sandbox-preparation",
    objective: "Prepare the sandbox before coding delegation",
  });

  const result = await runner.prepareSandbox({ missionId: mission.id });

  assert.equal(result.nodeVersion, "v22.14.0");
  assert.equal(result.npmVersion, "10.9.2");
  assert.equal(result.sandboxId, "sandbox-1");
  assert.equal(calls.turns.length, 2);
  assert.equal(calls.updates.length, 4);
  assert.equal(calls.updates[0].sessionId, "session-created");
  assert.equal(
    calls.updates[0].request.agent.spec.config.iterationLimit,
    SANDBOX_SETUP_ITERATION_LIMIT,
  );
  assert.equal(calls.updates[0].request.agent.spec.mcpServers.length, 0);
  assert.equal(calls.updates[0].request.agent.spec.model.params.parallel_tool_calls, false);
  assert.equal(calls.updates[0].request.agent.spec.config.dynamicSubAgents.enabled, false);
  assert.equal(
    calls.updates[1].request.agent.spec.config.iterationLimit,
    DEFAULT_TRUEFORGE_ITERATION_LIMIT,
  );
  assert.equal(
    calls.updates[2].request.agent.spec.config.iterationLimit,
    COORDINATOR_TRUEFORGE_ITERATION_LIMIT,
  );
  assert.equal(calls.updates[1].request.agent.spec.model.params, undefined);
  assert.match(calls.turns[0].request.input[0].content, /before any coding delegation/);
  assert.match(calls.turns[0].request.input[0].content, /bounded setup\/mutation/);
  assert.match(calls.turns[0].request.input[0].content, /separate budget of at most 4 sequential exec calls/);
  assert.match(calls.turns[0].request.input[0].content, /model-iteration budget for this phase is 5/);
  assert.match(calls.turns[0].request.input[0].content, /Debian 12\/bookworm/);
  assert.match(calls.turns[0].request.input[0].content, /NodeSource 22\.x/);
  assert.match(calls.turns[0].request.input[0].content, /do not treat a successful setup command or narration as proof/);
  assert.doesNotMatch(calls.turns[0].request.input[0].content, /TRUEFORGE_TOOLCHAIN_PROOF/);
  assert.match(calls.turns[1].request.input[0].content, /TRUEFORGE_TOOLCHAIN_PROOF/);
  assert.deepEqual(sandboxInstructionArguments(calls.turns[1].request), {
    intent: SANDBOX_TOOLCHAIN_READINESS_INTENT,
    command: SANDBOX_TOOLCHAIN_PROOF_COMMAND,
  });
  const state = await missions.getState();
  const readiness = state.evidence.find((item) => item.id === result.evidenceId);
  assert.equal(readiness.source, "sandbox");
  assert.equal(readiness.result, "passed");
  assert.match(readiness.summary, /Node\.js v22\.14\.0 and npm 10\.9\.2/);
});

test("bounded sandbox setup accepts a paraphrased exec intent before exact proof", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const paraphrasedIntent =
    "Provision the sandbox runtime and confirm it is usable before delegated work.";
  const { client, calls } = fakeClient((turnId, agentSpec) => {
    if (agentSpec?.config?.iterationLimit === SANDBOX_SETUP_ITERATION_LIMIT) {
      assert.equal(agentSpec?.model?.params?.parallel_tool_calls, false);
      return sandboxSetupEvents(turnId, {
        intents: [paraphrasedIntent, paraphrasedIntent],
      });
    }
    assert.equal(agentSpec?.config?.iterationLimit, COORDINATOR_TRUEFORGE_ITERATION_LIMIT);
    return sandboxToolchainProofEvents(turnId);
  }, { passAgentSpec: true });
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
  });
  const mission = await runner.createMission({
    id: "mission-sandbox-paraphrased-intent",
    objective: "Accept valid readiness provenance with model wording variation",
  });

  const result = await runner.prepareSandbox({ missionId: mission.id });

  assert.equal(result.nodeVersion, "v22.14.0");
  assert.equal(result.npmVersion, "10.9.2");
  assert.equal(calls.turns.length, 2);
  const setupExecCalls = calls.turns[0].events
    .flatMap((event) => event.type === "model.message" ? event.toolCalls ?? [] : [])
    .filter((call) => call.function?.name === "exec");
  assert.equal(setupExecCalls.length, 2);
  assert.equal(JSON.parse(setupExecCalls[0].function.arguments).intent, paraphrasedIntent);
  assert.equal(JSON.parse(setupExecCalls[1].function.arguments).intent, paraphrasedIntent);
  assert.deepEqual(sandboxInstructionArguments(calls.turns[1].request), {
    intent: SANDBOX_TOOLCHAIN_READINESS_INTENT,
    command: SANDBOX_TOOLCHAIN_PROOF_COMMAND,
  });
  assert.deepEqual(
    calls.updates.map((update) => update.request.agent.spec.config.iterationLimit),
    [
      SANDBOX_SETUP_ITERATION_LIMIT,
      DEFAULT_TRUEFORGE_ITERATION_LIMIT,
      COORDINATOR_TRUEFORGE_ITERATION_LIMIT,
      DEFAULT_TRUEFORGE_ITERATION_LIMIT,
    ],
  );
});

test("sandbox proof failure blocks without a corrective repair turn and restores the normal agent", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client, calls } = fakeClient((turnId, agentSpec) => {
    if (agentSpec?.config?.iterationLimit === SANDBOX_SETUP_ITERATION_LIMIT) {
      return sandboxSetupEvents(turnId);
    }
    return sandboxToolchainProofEvents(turnId, { nodeVersion: "v18.20.4" });
  }, { passAgentSpec: true });
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
  });
  const mission = await runner.createMission({
    id: "mission-sandbox-proof-failure",
    objective: "Block an unverifiable toolchain proof",
  });

  await assert.rejects(
    runner.prepareSandbox({ missionId: mission.id }),
    /requires Node\.js >=20|readiness failed/i,
  );
  assert.equal(calls.turns.length, 2);
  assert.deepEqual(
    calls.updates.map((update) => update.request.agent.spec.config.iterationLimit),
    [
      SANDBOX_SETUP_ITERATION_LIMIT,
      DEFAULT_TRUEFORGE_ITERATION_LIMIT,
      COORDINATOR_TRUEFORGE_ITERATION_LIMIT,
      DEFAULT_TRUEFORGE_ITERATION_LIMIT,
    ],
  );
  const state = await missions.getState();
  const failure = state.evidence.find((item) =>
    item.result === "failed" && item.summary.includes("Sandbox toolchain readiness failed"),
  );
  assert.ok(failure);
  assert.match(failure.details, /deterministic-proof/);
  assert.match(failure.details, /failed postcondition/);
});

test("sandbox setup budget exhaustion fails closed before deterministic proof", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const setupCommands = ["echo setup-1", "echo setup-2", "echo setup-3", "echo setup-4"];
  const { client, calls } = fakeClient((turnId, agentSpec) => {
    assert.equal(agentSpec?.config?.iterationLimit, SANDBOX_SETUP_ITERATION_LIMIT);
    return sandboxSetupEvents(turnId, {
      commands: setupCommands,
      exitCodes: [0, 0, 0, 0],
      turnState: {
        status: "error",
        message: "TrueForge iteration limit reached during bounded setup.",
        requiredActions: [],
      },
    });
  }, { passAgentSpec: true });
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
  });
  const mission = await runner.createMission({
    id: "mission-sandbox-setup-budget",
    objective: "Reject setup that exhausts its bounded runtime",
  });

  await assert.rejects(
    runner.prepareSandbox({ missionId: mission.id }),
    /budget exhaustion|bounded setup/i,
  );
  assert.equal(calls.turns.length, 1);
  assert.deepEqual(
    calls.updates.map((update) => update.request.agent.spec.config.iterationLimit),
    [SANDBOX_SETUP_ITERATION_LIMIT, DEFAULT_TRUEFORGE_ITERATION_LIMIT],
  );
  const state = await missions.getState();
  const failure = state.evidence.find((item) =>
    item.result === "failed" && item.summary.includes("Sandbox toolchain readiness failed"),
  );
  assert.ok(failure);
  assert.match(failure.details, /bounded-setup/);
  assert.match(failure.details, /observed_exec_count.*4/);
  assert.match(failure.details, /model iteration budget exhaustion|iteration limit/i);
});

test("bounded setup accepts its four-exec maximum with a separate completion iteration", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const setupCommands = Array.from(
    { length: SANDBOX_SETUP_EXEC_LIMIT },
    (_, index) => `echo setup-${index + 1}`,
  );
  const { client, calls } = fakeClient((turnId, agentSpec) => {
    if (agentSpec?.config?.iterationLimit === SANDBOX_SETUP_ITERATION_LIMIT) {
      return sandboxSetupEvents(turnId, {
        commands: setupCommands,
        exitCodes: [1, 0, 0, 0],
      });
    }
    assert.equal(agentSpec?.config?.iterationLimit, COORDINATOR_TRUEFORGE_ITERATION_LIMIT);
    return sandboxToolchainProofEvents(turnId);
  }, { passAgentSpec: true });
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
  });
  const mission = await runner.createMission({
    id: "mission-sandbox-setup-max-exec-boundary",
    objective: "Accept a setup turn at its independent exec maximum",
  });

  const result = await runner.prepareSandbox({ missionId: mission.id });

  assert.equal(result.nodeVersion, "v22.14.0");
  assert.equal(calls.turns.length, 2);
  assert.equal(calls.turns[0].events.filter((event) => event.type === "tool.response").length, SANDBOX_SETUP_EXEC_LIMIT);
  assert.deepEqual(
    calls.updates.map((update) => update.request.agent.spec.config.iterationLimit),
    [SANDBOX_SETUP_ITERATION_LIMIT, DEFAULT_TRUEFORGE_ITERATION_LIMIT, COORDINATOR_TRUEFORGE_ITERATION_LIMIT, DEFAULT_TRUEFORGE_ITERATION_LIMIT],
  );
  const setupEvidence = (await missions.getState()).evidence.find((item) =>
    item.summary.includes("Bounded sandbox toolchain setup completed"),
  );
  assert.ok(setupEvidence);
  assert.match(setupEvidence.details, /"observed_exec_count":4/);
});

test("Debian 12 setup guidance recovers from stock Node 18 before independent proof", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const setupCommands = [
    "node --version && npm --version",
    "apt-get update && apt-get install -y ca-certificates curl gnupg",
    "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
    "node --version && npm --version",
  ];
  const { client, calls } = fakeClient((turnId, agentSpec) =>
    agentSpec?.config?.iterationLimit === SANDBOX_SETUP_ITERATION_LIMIT
      ? sandboxSetupEvents(turnId, {
          commands: setupCommands,
          exitCodes: [0, 0, 0, 0],
          outputs: [
            "v18.20.4\n10.8.2\n",
            "apt prerequisites installed\n",
            "NodeSource 22.x configured\n",
            "v22.14.0\n10.9.2\n",
          ],
        })
      : sandboxToolchainProofEvents(turnId),
  { passAgentSpec: true });
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
  });
  const mission = await runner.createMission({
    id: "mission-sandbox-debian-12-node18-recovery",
    objective: "Recover a Debian 12 stock Node.js runtime before coding",
  });

  const result = await runner.prepareSandbox({ missionId: mission.id });

  assert.equal(result.nodeVersion, "v22.14.0");
  assert.equal(result.npmVersion, "10.9.2");
  assert.equal(calls.turns.length, 2);
  const setupInstruction = calls.turns[0].request.input[0].content;
  assert.match(setupInstruction, /Debian 12\/bookworm/);
  assert.match(setupInstruction, /stock apt nodejs is Node\.js 18/);
  assert.match(setupInstruction, /NodeSource 22\.x/);
  assert.match(setupInstruction, /Inspect both versions again after installation/);
  assert.match(setupInstruction, /narration as proof/);
  assert.deepEqual(sandboxInstructionArguments(calls.turns[1].request), {
    intent: SANDBOX_TOOLCHAIN_READINESS_INTENT,
    command: SANDBOX_TOOLCHAIN_PROOF_COMMAND,
  });
});

test("coordinator sandbox readiness and verification require root main call and response threads", async () => {
  const cases = [
    {
      label: "readiness child exec",
      operation: "readiness",
      options: { execThreadId: "thread-subagent" },
    },
    {
      label: "readiness child response",
      operation: "readiness",
      options: { responseThreadId: "thread-subagent" },
    },
    {
      label: "verification child exec",
      operation: "verification",
      options: { execThreadId: "thread-subagent" },
    },
    {
      label: "verification child response",
      operation: "verification",
      options: { responseThreadId: "thread-subagent" },
    },
  ];

  for (const [index, fixture] of cases.entries()) {
    const missions = new MissionService(new InMemoryMissionRepository());
    const { client } = fakeClient((turnId, agentSpec) => fixture.operation === "readiness"
      ? agentSpec?.config?.iterationLimit === SANDBOX_SETUP_ITERATION_LIMIT
        ? sandboxSetupEvents(turnId, fixture.options)
        : sandboxToolchainProofEvents(turnId)
      : sandboxEvents(turnId, 0, [], fixture.options),
    { passAgentSpec: true });
    const runner = new TrueForgeMissionRunner(missions, client, {
      model: "openai/gpt-5-4-mini",
    });
    const mission = await runner.createMission({
      id: `mission-sandbox-root-thread-${index}`,
      objective: `Reject ${fixture.label}`,
    });

    await assert.rejects(
      fixture.operation === "readiness"
        ? runner.prepareSandbox({ missionId: mission.id })
        : runner.runSandboxVerification({ missionId: mission.id, command: "node --test" }),
      (error) => {
        assert.match(error.message, /root(?: coordinator)?[- ]thread|root.*thread|coordinator-owned exec sandbox call/i, fixture.label);
        return true;
      },
    );
    const state = await missions.getState();
    assert.equal(
      state.evidence.some((item) => item.source === "sandbox" && item.result === "passed"),
      false,
      fixture.label,
    );
  }
});

test("coordinator sandbox turns are runtime-bounded and stop cleanly after the canonical exec", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client, calls } = fakeClient((turnId, agentSpec) => {
    const isBounded =
      agentSpec?.config?.iterationLimit === COORDINATOR_TRUEFORGE_ITERATION_LIMIT &&
      agentSpec?.model?.params?.parallel_tool_calls === false;
    if (!isBounded) {
      return sandboxEvents(turnId, 0, [], {
        additionalSandboxCalls: [
          { callId: "call-inspect", argumentsValue: { intent: "inspect", command: "git status" } },
          { callId: "call-edit", argumentsValue: { intent: "edit", command: "sed -n '1,20p' src/index.ts" } },
          { callId: "call-test", argumentsValue: { intent: "test", command: "npm test" } },
          { callId: "call-install", argumentsValue: { intent: "install", command: "npm install" } },
          { callId: "call-later", argumentsValue: { intent: "inspect", command: "git diff" } },
        ],
      });
    }
    return sandboxEvents(turnId, 0, [], {
      turnState: {
        status: "error",
        message: "TrueForge iteration limit reached after the sandbox operation.",
      },
    });
  }, { passAgentSpec: true });
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
  });
  const mission = await runner.createMission({
    id: "mission-runtime-bounded-coordinator",
    objective: "Prove the coordinator sandbox runtime boundary",
  });

  const verification = await runner.runSandboxVerification({
    missionId: mission.id,
    command: "node --test",
  });

  assert.equal(verification.exitCode, 0);
  assert.equal(calls.turns.length, 1);
  const coordinatorTurn = calls.turns[0];
  assert.ok(coordinatorTurn);
  const executableCalls = coordinatorTurn.events
    .filter((event) => event.type === "model.message")
    .flatMap((event) => event.toolCalls ?? [])
    .filter((call) => call.function?.name === "exec");
  assert.equal(executableCalls.length, 1);
  assert.equal(calls.updates.length, 2);
  assert.equal(calls.updates[0].sessionId, "session-created");
  assert.equal(calls.updates[1].sessionId, "session-created");
  assert.equal(
    calls.updates[0].request.agent.spec.config.iterationLimit,
    COORDINATOR_TRUEFORGE_ITERATION_LIMIT,
  );
  assert.equal(calls.updates[0].request.agent.spec.model.params.parallel_tool_calls, false);
  assert.equal(
    calls.updates[1].request.agent.spec.config.iterationLimit,
    DEFAULT_TRUEFORGE_ITERATION_LIMIT,
  );
  assert.equal(calls.updates[1].request.agent.spec.model.params, undefined);
  const state = await missions.getState();
  assert.equal(state.missions[0].trueforgeSessionId, "session-created");
  assert.equal(state.missions[0].trueforgeSandboxId, "sandbox-1");
  const completionEvidence = state.evidence.find((item) =>
    item.summary.includes("one-iteration sandbox proof boundary"),
  );
  assert.ok(completionEvidence);
  assert.equal(completionEvidence.result, "informational");
});

test("mission agent specs use a bounded non-twelve default iteration limit", () => {
  assert.equal(DEFAULT_TRUEFORGE_ITERATION_LIMIT, 64);
  assert.equal(
    buildMissionAgentSpec({ model: "openai/gpt-5-4-mini" }).config.iterationLimit,
    DEFAULT_TRUEFORGE_ITERATION_LIMIT,
  );
  assert.equal(
    buildMissionAgentSpec({ model: "openai/gpt-5-4-mini", iterationLimit: 24 }).config.iterationLimit,
    24,
  );
  assert.throws(
    () => buildMissionAgentSpec({ model: "openai/gpt-5-4-mini", iterationLimit: MAX_TRUEFORGE_ITERATION_LIMIT + 1 }),
    /between 1 and 1024/,
  );
});

test("deterministic coordinator policy supports exactly four models without inert tool forcing", () => {
  const cases = [
    {
      model: "alibaba/qwen3-8-max",
      params: { enable_thinking: false, parallel_tool_calls: false },
    },
    {
      model: "alibaba/qwen3-7-flash",
      params: { enable_thinking: false, parallel_tool_calls: false },
    },
    {
      model: "openai/gpt-5-4-mini",
      params: { parallel_tool_calls: false },
    },
    {
      model: "openai/gpt-5-6-luna",
      params: { parallel_tool_calls: false },
    },
  ];
  for (const { model, params } of cases) {
    for (const surface of ["repository-read", "sandbox-exec"]) {
      const spec = buildCoordinatorAgentSpec({ model }, surface);
      assert.deepEqual(spec.model.params, params);
      assert.equal(spec.model.params.tool_choice, undefined);
      assert.equal(spec.model.params.toolChoice, undefined);
    }
    assert.equal(buildMissionAgentSpec({ model }).model.params, undefined);
  }
});

test("the dotted GPT-5.4 Mini FQN fails before mission execution", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client, calls } = fakeClient();
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5.4-mini",
  });

  await assert.rejects(
    runner.createMission({
      id: "mission-unvalidated-coordinator-model",
      objective: "Reject the upstream model-id spelling as a TrueForge FQN",
    }),
    (error) => {
      assert.equal(error.code, "invalid_input");
      assert.match(error.message, /deterministic coordinator model policy is not validated/);
      assert.match(error.message, /Add an exact documented provider\/model policy/);
      return true;
    },
  );
  assert.equal(calls.create.length, 0);
  assert.equal(calls.get.length, 0);
  assert.equal((await missions.getState()).missions.length, 0);
});

test("repository-read coordinator retries one completed zero-tool turn on the same session and predecessor chain", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client, calls } = fakeClient((turnId) =>
    turnId === "turn-1" ? zeroToolEvents(turnId) : lockedCommitEvents(turnId),
  );
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "alibaba/qwen3-7-flash",
    mcpServers: [{ name: "github", enableTools: ["get_commit"] }],
  });
  const mission = await runner.createMission({
    id: "mission-retry-zero-tool-repository-read",
    objective: "Recover one omitted deterministic repository read",
    repository: {
      owner: "mtamburrano",
      name: "proofboard-demo-fixture",
      ref: LOCKED_FIXTURE_REF,
    },
  });

  const inspection = await runner.inspectRepository({ missionId: mission.id });

  assert.equal(inspection.commitSha, LOCKED_FIXTURE_SHA);
  assert.equal(calls.turns.length, 2);
  assert.equal(calls.turns[0].request.previousTurnId, undefined);
  assert.equal(calls.turns[1].request.previousTurnId, "turn-1");
  assert.match(calls.turns[1].request.input[0].content, /previous coordinator turn emitted no tool call/i);
  assert.match(calls.turns[1].request.input[0].content, /full_patch/);
  assert.equal(calls.updates.length, 2);
  assert.equal(calls.updates[0].sessionId, "session-created");
  assert.equal(calls.updates[1].sessionId, "session-created");
  assert.equal(calls.turns[0].agentSpec, calls.turns[1].agentSpec);
  assert.equal((await missions.getState()).missions[0].trueforgeTurnId, "turn-2");
});

test("sandbox proof retries twice after consecutive zero-tool omissions and preserves continuity", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client, calls } = fakeClient((turnId) =>
    turnId === "turn-1" || turnId === "turn-2"
      ? zeroToolEvents(turnId, { includeSandboxCreated: true })
      : sandboxEvents(turnId),
  );
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-6-luna",
  });
  const mission = await runner.createMission({
    id: "mission-retry-zero-tool-sandbox-proof",
    objective: "Recover one omitted deterministic sandbox proof",
  });

  const verification = await runner.runSandboxVerification({
    missionId: mission.id,
    command: "node --test",
  });

  assert.equal(verification.exitCode, 0);
  assert.equal(calls.turns.length, 3);
  assert.deepEqual(
    calls.turns.map((turn) => turn.request.previousTurnId),
    [undefined, "turn-1", "turn-2"],
  );
  assert.deepEqual(calls.turns.map((turn) => turn.sessionId), [
    "session-created",
    "session-created",
    "session-created",
  ]);
  assert.deepEqual(
    calls.turns.map((turn) => turn.events.find((event) => event.type === "sandbox.created")?.sandboxId),
    ["sandbox-1", "sandbox-1", "sandbox-1"],
  );
  assert.equal(
    calls.turns[0].events.some((event) => event.type === "model.message" && (event.toolCalls ?? []).length > 0),
    false,
  );
  assert.equal(
    calls.turns[1].events.some((event) => event.type === "model.message" && (event.toolCalls ?? []).length > 0),
    false,
  );
  assert.match(calls.turns[1].request.input[0].content, /previous coordinator turn emitted no tool call/i);
  assert.match(calls.turns[2].request.input[0].content, /previous coordinator turn emitted no tool call/i);
  assert.match(calls.turns[1].request.input[0].content, /node --test/);
  assert.equal(calls.updates.length, 2);
  assert.equal((await missions.getState()).missions[0].trueforgeSandboxId, "sandbox-1");
  const finalExecCalls = calls.turns[2].events
    .filter((event) => event.type === "model.message")
    .flatMap((event) => event.toolCalls ?? [])
    .filter((call) => call.function?.name === "exec");
  assert.equal(finalExecCalls.length, 1);
  assert.deepEqual(JSON.parse(finalExecCalls[0].function.arguments), {
    intent: SANDBOX_VERIFICATION_INTENT,
    command: "node --test",
  });
});

test("zero-tool coordinator recovery stops after three completed attempts", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client, calls } = fakeClient((turnId) => zeroToolEvents(turnId));
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
    mcpServers: [{ name: "github", enableTools: ["get_commit"] }],
  });
  const mission = await runner.createMission({
    id: "mission-retry-zero-tool-limit",
    objective: "Bound repeated omitted deterministic repository reads",
    repository: {
      owner: "mtamburrano",
      name: "proofboard-demo-fixture",
      ref: LOCKED_FIXTURE_REF,
    },
  });

  await assert.rejects(
    runner.inspectRepository({ missionId: mission.id }),
    /TrueForge did not record MCP initialization/,
  );

  assert.equal(calls.turns.length, 3);
  assert.deepEqual(
    calls.turns.map((turn) => turn.request.previousTurnId),
    [undefined, "turn-1", "turn-2"],
  );
  assert.match(calls.turns[1].request.input[0].content, /previous coordinator turn emitted no tool call/i);
  assert.match(calls.turns[2].request.input[0].content, /previous coordinator turn emitted no tool call/i);
  assert.equal(calls.updates.length, 2);
});

test("normal implementer and reviewer turns remain agentic for a validated model", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client, calls } = fakeClient(contractReviewEvents);
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "alibaba/qwen3-8-max",
    dynamicSubAgents: true,
  });
  const mission = await runner.createMission({
    id: "mission-agentic-model-agnostic",
    objective: "Keep normal implementation and review turns agentic",
  });

  await runner.runTurn(mission.id, "Implement the bounded change.");
  const workItem = await missions.addWorkItem(mission.id, {
    id: "work-agentic-model-agnostic",
    title: "Implement the bounded change",
    purpose: "Keep the normal implementation and review paths model-agnostic.",
    acceptanceCriteria: ["The bounded change is implemented."],
    requiredChecks: ["test"],
    assignedRole: "implementer",
    status: "ready",
  });
  await runner.reviewContract({
    workItem,
    handoff: {},
    filesChanged: ["src/index.ts"],
    actualFilesChanged: ["src/index.ts"],
    actualDiff: "diff --git a/src/index.ts b/src/index.ts\n+export const boundedChange = true;",
    diffSummary: "src/index.ts changed.",
    checks: [],
    evidence: [],
  });

  assert.equal(calls.create[0].agent.spec.model.params, undefined);
  assert.equal(calls.turns.length, 2);
  assert.equal(calls.turns[0].agentSpec.model.params, undefined);
  assert.equal(calls.turns[1].agentSpec.model.params.parallel_tool_calls, false);
  assert.deepEqual(calls.turns[1].agentSpec.mcpServers, []);
  assert.equal(calls.turns[1].agentSpec.config.sandbox.enabled, false);
});

test("runner performs an independent bounded contract review", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client, calls } = fakeClient(contractReviewEvents);
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
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
  assert.equal(calls.updates.length, 2);
  assert.deepEqual(
    calls.updates.map((update) => update.request.agent.spec.config.iterationLimit),
    [COORDINATOR_TRUEFORGE_ITERATION_LIMIT, DEFAULT_TRUEFORGE_ITERATION_LIMIT],
  );
  assert.equal(calls.updates[0].request.agent.spec.model.params.parallel_tool_calls, false);
  assert.equal(calls.updates[1].request.agent.spec.model.params, undefined);
  assert.deepEqual(calls.updates[0].request.agent.spec.mcpServers, []);
  assert.equal(calls.updates[0].request.agent.spec.config.sandbox.enabled, false);
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
    model: "openai/gpt-5-4-mini",
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
  const config = { model: "openai/gpt-5-4-mini" };
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
    headSha: VERIFIED_DELIVERY_HEAD_SHA,
    title: "Add the verified delivery-stage helper",
    body: "Verified delivery body.",
  };
  const { client, calls } = fakeClient((turnId) =>
    deliveryApprovalEvents(turnId, target)
  );
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
    mcpServerName: "github",
    deliveryToolName: "create_pull_request",
    mcpServers: [{
      name: "github",
      enableTools: ["create_pull_request", "get_commit", "pull_request_read", "search_pull_requests"],
      preloadTools: ["create_pull_request", "get_commit", "pull_request_read", "search_pull_requests"],
      requireApprovalForTools: ["create_pull_request"],
    }],
  });
  const mission = await runner.createMission({
    id: "mission-delivery-approval",
    objective: "Open only the verified delivery pull request",
    repository: {
      owner: target.owner,
      name: target.repo,
      ref: LOCKED_FIXTURE_REF,
    },
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
    headSha: VERIFIED_DELIVERY_HEAD_SHA,
    sessionId: "session-created",
    turnId: "turn-3",
    threadId: "thread-delivery",
    toolCallId: "call-create-pr",
  });
  assert.match(calls.turns[1].request.input[0].content, /get_commit with this exact JSON object/);
  assert.deepEqual(calls.turns[2].request, {
    input: [{
      type: "user.tool_approval",
      threadId: "thread-delivery",
      toolCallId: "call-create-pr",
      approval: { status: "allow" },
    }],
    previousTurnId: "turn-1",
  });
  assert.match(calls.turns[3].request.input[0].content, /pull_request_read exactly once/);
  assert.match(calls.turns[3].request.input[0].content, /"pullNumber":42/);
  assert.equal(calls.turns[3].request.previousTurnId, "turn-3");
  const readbackEvidence = (await missions.getState()).evidence.find((item) =>
    item.summary === "MCP verified pull request #42 after creation."
  );
  assert.ok(readbackEvidence);
  assert.equal(JSON.parse(readbackEvidence.details).head_sha, VERIFIED_DELIVERY_HEAD_SHA);
  assert.equal(JSON.parse(readbackEvidence.details).base, target.base);
  assert.equal(JSON.parse(readbackEvidence.details).head, target.head);
  assert.equal(calls.turns.length, 4);
});

test("reconciliation searches read-only and verifies one exact approved pull request", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const target = {
    owner: "mtamburrano",
    repo: "proofboard-demo-fixture",
    base: "main",
    head: "proofboard-verified-delivery",
    headSha: VERIFIED_DELIVERY_HEAD_SHA,
    title: "Verified fixture delivery",
    body: "Verified fixture delivery body.",
  };
  const { client, calls } = fakeClient((turnId) => {
    if (turnId === "turn-1") return deliveryApprovalEvents(turnId, target);
    if (turnId === "turn-2") return pullRequestSearchEvents(turnId);
    if (turnId === "turn-3") {
      return pullRequestReadbackEvents(turnId, {
        owner: target.owner,
        repo: target.repo,
        base: target.base,
        head: target.head,
        headSha: target.headSha,
      });
    }
    throw new Error(`Unexpected reconciliation turn ${turnId}.`);
  });
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
    mcpServerName: "github",
    deliveryToolName: "create_pull_request",
    mcpServers: [{
      name: "github",
      enableTools: ["create_pull_request", "get_commit", "pull_request_read", "search_pull_requests"],
      preloadTools: ["create_pull_request", "get_commit", "pull_request_read", "search_pull_requests"],
      requireApprovalForTools: ["create_pull_request"],
    }],
  });
  const mission = await runner.createMission({
    id: "mission-delivery-reconciliation",
    objective: "Adopt an already-created exact delivery pull request",
    repository: { owner: target.owner, name: target.repo, ref: LOCKED_FIXTURE_REF },
  });
  const pending = await runner.requestPullRequestApproval(mission.id, target);
  const result = await runner.reconcilePullRequestApproval(mission.id, pending);

  assert.deepEqual(result, {
    number: 42,
    url: "https://github.com/mtamburrano/proofboard-demo-fixture/pull/42",
    headSha: VERIFIED_DELIVERY_HEAD_SHA,
    sessionId: "session-created",
    turnId: "turn-2",
    threadId: "thread-delivery",
    toolCallId: "call-create-pr",
  });
  assert.match(calls.turns[1].request.input[0].content, /search_pull_requests exactly once/);
  assert.match(calls.turns[1].request.input[0].content, /head:mtamburrano:proofboard-verified-delivery/);
  assert.equal(calls.turns[2].request.previousTurnId, "turn-2");
  assert.equal(calls.turns.length, 3);
});

test("reconciliation rejects missing or ambiguous search results before any create retry", async () => {
  const target = {
    owner: "mtamburrano",
    repo: "proofboard-demo-fixture",
    base: "main",
    head: "proofboard-verified-delivery",
    headSha: VERIFIED_DELIVERY_HEAD_SHA,
    title: "Verified fixture delivery",
    body: "Verified fixture delivery body.",
  };
  for (const [label, items, expected] of [
    ["missing", [], /No pull request matched/],
    ["ambiguous", [
      { number: 42, html_url: "https://github.com/mtamburrano/proofboard-demo-fixture/pull/42" },
      { number: 43, html_url: "https://github.com/mtamburrano/proofboard-demo-fixture/pull/43" },
    ], /More than one pull request matched/],
  ]) {
    const missions = new MissionService(new InMemoryMissionRepository());
    const { client, calls } = fakeClient((turnId) => {
      if (turnId === "turn-1") return deliveryApprovalEvents(turnId, target);
      if (turnId === "turn-2") return pullRequestSearchEvents(turnId, items);
      throw new Error(`Unexpected failed reconciliation turn ${turnId}.`);
    });
    const runner = new TrueForgeMissionRunner(missions, client, {
      model: "openai/gpt-5-4-mini",
      mcpServerName: "github",
      deliveryToolName: "create_pull_request",
      mcpServers: [{
        name: "github",
        enableTools: ["create_pull_request", "get_commit", "pull_request_read", "search_pull_requests"],
        requireApprovalForTools: ["create_pull_request"],
      }],
    });
    const mission = await runner.createMission({
      id: `mission-delivery-reconciliation-${label}`,
      objective: "Fail closed on an unsafe reconciliation result",
      repository: { owner: target.owner, name: target.repo, ref: LOCKED_FIXTURE_REF },
    });
    const pending = await runner.requestPullRequestApproval(mission.id, target);
    await assert.rejects(
      runner.reconcilePullRequestApproval(mission.id, pending),
      expected,
      label,
    );
    assert.equal(calls.turns.length, 2, label);
  }
});

test("post-create pull request read-back rejects a missing or mismatched head SHA", async () => {
  for (const [label, readbackOptions] of [
    ["missing", { includeHeadSha: false }],
    ["mismatched", { headSha: "9cc33b73c4825f7aa5d3b1ce6c5510fc8e1b20f2" }],
  ]) {
    const missions = new MissionService(new InMemoryMissionRepository());
    const target = {
      owner: "mtamburrano",
      repo: "proofboard-demo-fixture",
      base: "main",
      head: "proofboard-verified-delivery",
      headSha: VERIFIED_DELIVERY_HEAD_SHA,
      title: "Verified fixture delivery",
      body: "Verified fixture delivery body.",
    };
    const { client, calls } = fakeClient((turnId) =>
      deliveryApprovalEvents(turnId, target, readbackOptions)
    );
    const runner = new TrueForgeMissionRunner(missions, client, {
      model: "openai/gpt-5-4-mini",
      mcpServerName: "github",
      deliveryToolName: "create_pull_request",
      mcpServers: [{
        name: "github",
        enableTools: ["create_pull_request", "get_commit", "pull_request_read", "search_pull_requests"],
        preloadTools: ["create_pull_request", "get_commit", "pull_request_read", "search_pull_requests"],
        requireApprovalForTools: ["create_pull_request"],
      }],
    });
    const mission = await runner.createMission({
      id: `mission-readback-${label}`,
      objective: "Reject an unverified created pull request",
      repository: {
        owner: target.owner,
        name: target.repo,
        ref: LOCKED_FIXTURE_REF,
      },
    });
    const pending = await runner.requestPullRequestApproval(mission.id, target);

    await assert.rejects(
      runner.resolvePullRequestApproval(mission.id, pending, "approved"),
      /post-create pull request read-back did not prove the approved repository, base, head, and SHA/,
    );
    const state = await missions.getState();
    assert.equal(state.deliveries.length, 0);
    assert.equal(
      state.evidence.some((item) =>
        item.summary === "MCP pull request read-back failed; delivery was not accepted."
      ),
      true,
    );
    assert.equal(calls.turns.length, 4);
  }
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
      headSha: VERIFIED_DELIVERY_HEAD_SHA,
      title: "Verified fixture delivery",
      body: "Verified fixture delivery body.",
    };
    const { client, calls } = fakeClient((turnId) => {
      if (turnId === "turn-1") {
        const toolArguments = { ...target };
        delete toolArguments.headSha;
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
              function: { name: "create_pull_request", arguments: JSON.stringify(toolArguments) },
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
      model: "openai/gpt-5-4-mini",
      mcpServerName: "github",
      mcpServers: [{
        name: "github",
        enableTools: ["create_pull_request", "get_commit", "pull_request_read", "search_pull_requests"],
        requireApprovalForTools: ["create_pull_request"],
      }],
    });
    const mission = await runner.createMission({
      id: `mission-${decision}-delivery`,
      objective: "Keep denied delivery fail closed",
      repository: {
        owner: target.owner,
        name: target.repo,
        ref: LOCKED_FIXTURE_REF,
      },
    });
    const pending = await runner.requestPullRequestApproval(mission.id, target);
    const result = await runner.resolvePullRequestApproval(mission.id, pending, decision);

    assert.equal(result, null);
    assert.equal(protectedOperations, 0);
    assert.equal(calls.turns[1].request.input[0].approval.status, "deny");
    assert.match(calls.turns[1].request.input[0].approval.reason, new RegExp(decision));
  }
});

test("a delivery-head race blocks the approval allow before any protected operation", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const target = {
    owner: "mtamburrano",
    repo: "proofboard-demo-fixture",
    base: "main",
    head: "proofboard-verified-delivery",
    headSha: VERIFIED_DELIVERY_HEAD_SHA,
    title: "Verified fixture delivery",
    body: "Verified delivery body.",
  };
  let allowCalls = 0;
  const { client, calls } = fakeClient((turnId) => {
    if (turnId === "turn-1") {
      const toolArguments = { ...target };
      delete toolArguments.headSha;
      const approval = {
        type: "tool.approval_required",
        id: "approval-race",
        createdAt: "2026-08-28T08:00:02.000Z",
        threadId: "thread-race-delivery",
        toolCalls: [{ id: "call-race-pr", sourceEventId: "message-race-pr" }],
      };
      return [
        { type: "turn.created", id: "turn-race-start", createdAt: "2026-08-28T08:00:00.000Z", turnId, threadId: null },
        {
          type: "model.message",
          id: "message-race-pr",
          createdAt: "2026-08-28T08:00:01.000Z",
          threadId: "thread-race-delivery",
          toolCalls: [{
            id: "call-race-pr",
            function: { name: "create_pull_request", arguments: JSON.stringify(toolArguments) },
          }],
        },
        approval,
        { type: "turn.done", id: "turn-race-paused", createdAt: "2026-08-28T08:00:03.000Z", threadId: null, state: { status: "done", requiredActions: [approval] } },
      ];
    }
    const input = calls.turns.at(-1)?.request.input?.[0];
    if (input?.type === "user.tool_approval" && input.approval.status === "allow") {
      allowCalls += 1;
    }
    return lockedCommitEvents(turnId, {
      argumentsValue: {
        owner: target.owner,
        repo: target.repo,
        sha: target.head,
        detail: "full_patch",
        perPage: 100,
      },
      sha: "9cc33b73c4825f7aa5d3b1ce6c5510fc8e1b20f2",
      patches: PRIMARY_VERIFIED_DELIVERY_PATCHES,
    });
  });
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
    mcpServerName: "github",
    deliveryToolName: "create_pull_request",
    mcpServers: [{
      name: "github",
      enableTools: ["create_pull_request", "get_commit", "pull_request_read", "search_pull_requests"],
      preloadTools: ["create_pull_request", "get_commit", "pull_request_read", "search_pull_requests"],
      requireApprovalForTools: ["create_pull_request"],
    }],
  });
  const mission = await runner.createMission({
    id: "mission-delivery-race",
    objective: "Block a moved delivery head",
    repository: {
      owner: target.owner,
      name: target.repo,
      ref: LOCKED_FIXTURE_REF,
    },
  });

  const pending = await runner.requestPullRequestApproval(mission.id, target);
  await assert.rejects(
    runner.resolvePullRequestApproval(mission.id, pending, "approved"),
    /delivery head changed after approval/i,
  );
  assert.equal(calls.turns.length, 2);
  assert.equal(allowCalls, 0);
});

test("runner can attach an existing TrueForge session without creating another", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client, calls } = fakeClient();
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
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
    model: "openai/gpt-5-4-mini",
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
  assert.deepEqual(calls.updates[0].request.agent.spec.mcpServers, [{
    name: "github",
    enableTools: ["get_file_contents"],
    preload: true,
  }]);
  assert.deepEqual(calls.updates[1].request.agent.spec.mcpServers, [
    { name: "github", enableTools: ["get_file_contents"] },
  ]);
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
    model: "openai/gpt-5-4-mini",
    mcpServers: [{ name: "github", enableTools: ["get_file_contents", "get_commit"] }],
  });
  const mission = await runner.createMission({
    id: "mission-mcp-pinned-fixture",
    objective: "Inspect the locked repository fixture by commit",
    repository: {
      owner: "mtamburrano",
      name: "proofboard-demo-fixture",
      ref: LOCKED_FIXTURE_REF,
    },
  });

  const inspection = await runner.inspectRepository({
    missionId: mission.id,
  });

  assert.equal(inspection.toolName, "get_commit");
  assert.equal(inspection.commitSha, LOCKED_FIXTURE_SHA);
  assert.deepEqual(inspection.patches, LOCKED_FIXTURE_PATCHES);
  assert.match(calls.turns[0].request.input[0].content, /mtamburrano\/proofboard-demo-fixture/);
  assert.match(calls.turns[0].request.input[0].content, new RegExp(LOCKED_FIXTURE_REF));
  assert.match(calls.turns[0].request.input[0].content, /full_patch/);

  const state = await missions.getState();
  const proof = state.evidence.find((item) => item.id === inspection.evidenceId);
  const details = JSON.parse(proof.details);
  assert.deepEqual(details.arguments, {
    owner: "mtamburrano",
    repo: "proofboard-demo-fixture",
    sha: LOCKED_FIXTURE_REF,
    detail: "full_patch",
    perPage: 100,
  });
  assert.equal(details.commit_sha, LOCKED_FIXTURE_SHA);
  assert.deepEqual(details.patches, LOCKED_FIXTURE_PATCHES);
});

test("locked fixture inspection accepts safe page-one pagination after an iteration-limit stop", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const liveArguments = {
    detail: "full_patch",
    owner: "mtamburrano",
    page: 1,
    perPage: 100,
    repo: "proofboard-demo-fixture",
    sha: LOCKED_FIXTURE_SHA,
  };
  const iterationLimitMessage = "TrueForge iteration limit reached after the canonical repository read.";
  const { client, calls } = fakeClient((turnId, agentSpec) => {
    assert.equal(agentSpec?.config?.iterationLimit, COORDINATOR_TRUEFORGE_ITERATION_LIMIT);
    assert.equal(agentSpec?.model?.params?.parallel_tool_calls, false);
    return lockedCommitEvents(turnId, {
      argumentsValue: liveArguments,
      turnState: {
        status: "error",
        message: iterationLimitMessage,
        requiredActions: [],
      },
    });
  }, { passAgentSpec: true });
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
    mcpServers: [{ name: "github", enableTools: ["get_commit"] }],
  });
  const mission = await runner.createMission({
    id: "mission-mcp-safe-page-one",
    objective: "Accept the exact pinned repository read with safe page-one pagination",
    repository: {
      owner: "mtamburrano",
      name: "proofboard-demo-fixture",
      ref: LOCKED_FIXTURE_REF,
    },
  });

  const inspection = await runner.inspectRepository({ missionId: mission.id });

  assert.equal(inspection.commitSha, LOCKED_FIXTURE_SHA);
  assert.deepEqual(inspection.patches, LOCKED_FIXTURE_PATCHES);
  assert.equal(calls.turns.length, 1);
  const observedCalls = calls.turns[0].events
    .filter((event) => event.type === "model.message.delta")
    .flatMap((event) => event.toolCalls ?? [])
    .filter((call) => call.function?.name === "get_commit");
  assert.equal(observedCalls.length, 1);
  const observedArguments = calls.turns[0].events
    .filter((event) => event.type === "model.message.delta")
    .flatMap((event) => event.toolCalls ?? [])
    .filter((call) => call.index === 0)
    .map((call) => call.function?.arguments ?? "")
    .join("");
  assert.deepEqual(JSON.parse(observedArguments), liveArguments);
  const completion = calls.turns[0].events.find((event) => event.type === "turn.done");
  assert.deepEqual(completion?.state, {
    status: "error",
    message: iterationLimitMessage,
    requiredActions: [],
  });
  const state = await missions.getState();
  const proof = state.evidence.find((item) => item.id === inspection.evidenceId);
  assert.ok(proof);
  assert.equal(proof.result, "passed");
  assert.equal(JSON.parse(proof.details).commit_sha, LOCKED_FIXTURE_SHA);
  assert.deepEqual(JSON.parse(proof.details).patches, LOCKED_FIXTURE_PATCHES);
});

test("locked fixture inspection rejects unsafe page pagination and unrelated arguments", async () => {
  const cases = [
    {
      label: "unsafe page",
      argumentsValue: {
        owner: "mtamburrano",
        repo: "proofboard-demo-fixture",
        sha: LOCKED_FIXTURE_SHA,
        detail: "full_patch",
        page: 2,
        perPage: 100,
      },
    },
    {
      label: "unrelated argument",
      argumentsValue: {
        owner: "mtamburrano",
        repo: "proofboard-demo-fixture",
        sha: LOCKED_FIXTURE_SHA,
        detail: "full_patch",
        page: 1,
        perPage: 100,
        path: "src/index.ts",
      },
    },
  ];
  const expectedReason = "Expected exactly one canonical get_commit MCP call, found 0 semantically canonical calls; observed 1 total tool call.";

  for (const [index, fixture] of cases.entries()) {
    const missions = new MissionService(new InMemoryMissionRepository());
    const { client, calls } = fakeClient((turnId) => lockedCommitEvents(turnId, {
      argumentsValue: fixture.argumentsValue,
    }));
    const runner = new TrueForgeMissionRunner(missions, client, {
      model: "openai/gpt-5-4-mini",
      mcpServers: [{ name: "github", enableTools: ["get_commit"] }],
    });
    const mission = await runner.createMission({
      id: `mission-mcp-invalid-optional-argument-${index}`,
      objective: `Reject ${fixture.label} on the pinned repository read`,
      repository: {
        owner: "mtamburrano",
        name: "proofboard-demo-fixture",
        ref: LOCKED_FIXTURE_REF,
      },
    });

    await assert.rejects(
      runner.inspectRepository({ missionId: mission.id }),
      new RegExp(expectedReason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      fixture.label,
    );
    assert.equal(calls.turns.length, 1, fixture.label);
    const state = await missions.getState();
    assert.equal(state.missions[0].status, "blocked", fixture.label);
    assert.equal(
      state.evidence.some((item) => item.source === "mcp" && item.result === "passed"),
      false,
      fixture.label,
    );
  }
});

test("locked fixture inspection bounds the first MCP read and restores the normal session runtime", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  let unboundedRetryAttempted = false;
  const { client, calls } = fakeClient((turnId, agentSpec) => {
    const bounded = agentSpec?.config?.iterationLimit === COORDINATOR_TRUEFORGE_ITERATION_LIMIT &&
      agentSpec?.model?.params?.parallel_tool_calls === false;
    if (!bounded) {
      unboundedRetryAttempted = true;
      return lockedCommitEvents(turnId, {
        attempts: [
          {
            callId: "call-page-one",
            argumentsValue: {
              owner: "mtamburrano",
              repo: "proofboard-demo-fixture",
              sha: LOCKED_FIXTURE_REF,
              detail: "full_patch",
              perPage: 1,
            },
            sha: LOCKED_FIXTURE_SHA,
            patches: LOCKED_FIXTURE_PATCHES,
          },
          {
            callId: "call-corrective-page",
            argumentsValue: {
              owner: "mtamburrano",
              repo: "proofboard-demo-fixture",
              sha: LOCKED_FIXTURE_REF,
              detail: "full_patch",
              perPage: 100,
            },
            sha: LOCKED_FIXTURE_SHA,
            patches: LOCKED_FIXTURE_PATCHES,
          },
        ],
      });
    }
    return lockedCommitEvents(turnId, {
      argumentsValue: {
        owner: "mtamburrano",
        repo: "proofboard-demo-fixture",
        sha: LOCKED_FIXTURE_REF,
        detail: "full_patch",
        perPage: 100,
      },
      turnState: {
        status: "error",
        message: "TrueForge iteration limit reached after the canonical repository read.",
        requiredActions: [],
      },
    });
  }, { passAgentSpec: true });
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
    mcpServers: [{ name: "github", enableTools: ["get_commit"] }],
  });
  const mission = await runner.createMission({
    id: "mission-mcp-bounded-first-read",
    objective: "Inspect the locked fixture with one deterministic MCP read",
    repository: {
      owner: "mtamburrano",
      name: "proofboard-demo-fixture",
      ref: LOCKED_FIXTURE_REF,
    },
  });

  const inspection = await runner.inspectRepository({ missionId: mission.id });

  assert.equal(inspection.commitSha, LOCKED_FIXTURE_SHA);
  assert.deepEqual(inspection.patches, LOCKED_FIXTURE_PATCHES);
  assert.equal(unboundedRetryAttempted, false);
  assert.equal(calls.turns.length, 1);
  const observedCalls = calls.turns[0].events
    .filter((event) => event.type === "model.message.delta")
    .flatMap((event) => event.toolCalls ?? [])
    .filter((call) => call.function?.name === "get_commit");
  assert.equal(observedCalls.length, 1);
  const observedArguments = calls.turns[0].events
    .filter((event) => event.type === "model.message.delta")
    .flatMap((event) => event.toolCalls ?? [])
    .filter((call) => call.index === 0)
    .map((call) => call.function?.arguments ?? "")
    .join("");
  assert.deepEqual(JSON.parse(observedArguments), {
    owner: "mtamburrano",
    repo: "proofboard-demo-fixture",
    sha: LOCKED_FIXTURE_REF,
    detail: "full_patch",
    perPage: 100,
  });
  assert.deepEqual(
    calls.updates.map((update) => update.request.agent.spec.config.iterationLimit),
    [COORDINATOR_TRUEFORGE_ITERATION_LIMIT, DEFAULT_TRUEFORGE_ITERATION_LIMIT],
  );
  assert.equal(calls.updates[0].request.agent.spec.model.params.parallel_tool_calls, false);
  assert.equal(calls.updates[1].request.agent.spec.model.params, undefined);
  const state = await missions.getState();
  assert.equal(state.missions[0].trueforgeSessionId, "session-created");
  assert.equal(state.missions[0].trueforgeTurnId, "turn-1");
  assert.equal(
    state.evidence.some((item) => item.summary.includes("deterministic read boundary")),
    true,
  );
});

test("coordinator tool-surface matrix isolates repository reads, sandbox exec, and restoration", async () => {
  const normalMcpServers = [{
    name: "github",
    enableTools: ["get_commit", "get_file_contents", "list_tools", "get_tool_info", "call_tool"],
    preloadTools: ["get_commit", "get_file_contents"],
  }];
  const config = {
    model: "openai/gpt-5-4-mini",
    dynamicSubAgents: true,
    iterationLimit: 32,
    mcpServers: normalMcpServers,
  };
  const { client, calls } = fakeClient((turnId, agentSpec) => {
    const servers = agentSpec?.mcpServers ?? [];
    if (
      servers.length === 1 &&
      servers[0]?.enableTools?.length === 1 &&
      servers[0].enableTools[0] === "get_commit" &&
      servers[0].preload === true
    ) {
      return lockedCommitEvents(turnId, {
        turnState: {
          status: "error",
          message: "TrueForge iteration limit reached after the canonical repository read.",
          requiredActions: [],
        },
      });
    }
    if (servers.length === 0) {
      return sandboxEvents(turnId);
    }
    throw new Error("The bounded coordinator surface exposed the normal MCP tool set.");
  }, { passAgentSpec: true });
  const missions = new MissionService(new InMemoryMissionRepository());
  const runner = new TrueForgeMissionRunner(missions, client, config);
  const mission = await runner.createMission({
    id: "mission-coordinator-tool-surface-matrix",
    objective: "Exercise each deterministic coordinator tool surface",
    repository: {
      owner: "mtamburrano",
      name: "proofboard-demo-fixture",
      ref: LOCKED_FIXTURE_REF,
    },
  });

  await runner.inspectRepository({ missionId: mission.id });
  await runner.runSandboxVerification({ missionId: mission.id, command: "node --test" });

  const boundedRepositorySpec = calls.updates[0]?.request.agent.spec;
  const restoredAfterRepositorySpec = calls.updates[1]?.request.agent.spec;
  const boundedSandboxSpec = calls.updates[2]?.request.agent.spec;
  const restoredAfterSandboxSpec = calls.updates[3]?.request.agent.spec;
  assert.ok(boundedRepositorySpec);
  assert.ok(restoredAfterRepositorySpec);
  assert.ok(boundedSandboxSpec);
  assert.ok(restoredAfterSandboxSpec);
  assert.deepEqual(
    calls.updates.map((update) => update.sessionId),
    ["session-created", "session-created", "session-created", "session-created"],
  );
  assert.deepEqual(boundedRepositorySpec.mcpServers, [{
    name: "github",
    enableTools: ["get_commit"],
    preload: true,
  }]);
  assert.equal(boundedRepositorySpec.config.iterationLimit, COORDINATOR_TRUEFORGE_ITERATION_LIMIT);
  assert.equal(boundedRepositorySpec.config.dynamicSubAgents.enabled, false);
  assert.equal(boundedRepositorySpec.model.params.parallel_tool_calls, false);
  assert.deepEqual(boundedSandboxSpec.mcpServers, []);
  assert.equal(boundedSandboxSpec.config.iterationLimit, COORDINATOR_TRUEFORGE_ITERATION_LIMIT);
  assert.equal(boundedSandboxSpec.config.dynamicSubAgents.enabled, false);
  assert.equal(boundedSandboxSpec.model.params.parallel_tool_calls, false);
  assert.deepEqual(restoredAfterRepositorySpec, buildMissionAgentSpec(config));
  assert.deepEqual(restoredAfterSandboxSpec, buildMissionAgentSpec(config));
  assert.equal(restoredAfterRepositorySpec.config.dynamicSubAgents.enabled, true);
  assert.equal(restoredAfterRepositorySpec.config.iterationLimit, 32);
  assert.deepEqual(restoredAfterRepositorySpec.mcpServers, normalMcpServers);
  assert.deepEqual(buildCoordinatorAgentSpec(config, "repository-read").mcpServers, [{
    name: "github",
    enableTools: ["get_commit"],
    preload: true,
  }]);
  assert.deepEqual(buildCoordinatorAgentSpec(config, "sandbox-exec").mcpServers, []);
  assert.equal(calls.turns[0].agentSpec, boundedRepositorySpec);
  assert.equal(calls.turns[1].agentSpec, boundedSandboxSpec);
});

test("delivery-head inspection accepts a changed commit with the verified implementation diff", async () => {
  const headSha = "8bb22a62b3714f699204cb0d5c440fcb7f0a09e1";
  const target = {
    owner: "mtamburrano",
    repo: "proofboard-demo-fixture",
    base: "main",
    head: "proofboard-verified-delivery",
    title: "Verified fixture delivery",
    body: "Verified fixture delivery body.",
  };
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client, calls } = fakeClient((turnId) => lockedCommitEvents(turnId, {
    argumentsValue: {
      owner: target.owner,
      repo: target.repo,
      sha: target.head,
      detail: "full_patch",
      perPage: 100,
    },
    sha: headSha,
    patches: PRIMARY_VERIFIED_DELIVERY_PATCHES,
  }), { passAgentSpec: true });
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
    mcpServers: [{ name: "github", enableTools: ["get_commit"] }],
  });
  const mission = await runner.createMission({
    id: "mission-delivery-head-success",
    objective: "Verify the changed delivery head",
    repository: {
      owner: "mtamburrano",
      name: "proofboard-demo-fixture",
      ref: LOCKED_FIXTURE_REF,
    },
  });

  const inspection = await runner.inspectDeliveryHead({ missionId: mission.id, target });

  assert.equal(inspection.commitSha, headSha);
  assert.deepEqual(inspection.patches, PRIMARY_VERIFIED_DELIVERY_PATCHES);
  assert.match(calls.turns[0].request.input[0].content, /proofboard-verified-delivery/);
  assert.equal(calls.turns[0].agentSpec.config.iterationLimit, COORDINATOR_TRUEFORGE_ITERATION_LIMIT);
  assert.equal(calls.turns[0].agentSpec.model.params.parallel_tool_calls, false);
  assert.deepEqual(
    calls.updates.map((update) => update.request.agent.spec.config.iterationLimit),
    [COORDINATOR_TRUEFORGE_ITERATION_LIMIT, DEFAULT_TRUEFORGE_ITERATION_LIMIT],
  );
  const state = await missions.getState();
  const proof = state.evidence.find((item) => item.id === inspection.evidenceId);
  const details = JSON.parse(proof.details);
  assert.equal(details.provenance_kind, "delivery_head");
  assert.equal(details.arguments.perPage, 100);
  assert.equal(details.baseline_sha, LOCKED_FIXTURE_SHA);
  assert.equal(details.commit_sha, headSha);
});

test("delivery-head inspection rejects the unchanged baseline and mismatched content", async () => {
  const target = {
    owner: "mtamburrano",
    repo: "proofboard-demo-fixture",
    base: "main",
    head: "proofboard-verified-delivery",
    title: "Verified fixture delivery",
    body: "Verified fixture delivery body.",
  };
  const cases = [
    {
      label: "unchanged baseline",
      sha: LOCKED_FIXTURE_SHA,
      patches: PRIMARY_VERIFIED_DELIVERY_PATCHES,
    },
    {
      label: "mismatched content",
      sha: "8bb22a62b3714f699204cb0d5c440fcb7f0a09e1",
      patches: {
        ...PRIMARY_VERIFIED_DELIVERY_PATCHES,
        "src/index.ts": `${PRIMARY_VERIFIED_DELIVERY_PATCHES["src/index.ts"]}\n+unverified change`,
      },
    },
  ];

  for (const fixture of cases) {
    const missions = new MissionService(new InMemoryMissionRepository());
    const { client } = fakeClient((turnId) => lockedCommitEvents(turnId, {
      argumentsValue: {
        owner: target.owner,
        repo: target.repo,
        sha: target.head,
        detail: "full_patch",
        perPage: 100,
      },
      sha: fixture.sha,
      patches: fixture.patches,
    }));
    const runner = new TrueForgeMissionRunner(missions, client, {
      model: "openai/gpt-5-4-mini",
      mcpServers: [{ name: "github", enableTools: ["get_commit"] }],
    });
    const mission = await runner.createMission({
      id: `mission-delivery-head-${fixture.label.replaceAll(" ", "-")}`,
      objective: "Reject invalid delivery-head provenance",
      repository: {
        owner: "mtamburrano",
        name: "proofboard-demo-fixture",
        ref: LOCKED_FIXTURE_REF,
      },
    });

    await assert.rejects(
      runner.inspectDeliveryHead({ missionId: mission.id, target }),
      /Delivery head must differ from the baseline and exactly match the verified implementation patches/,
      fixture.label,
    );
    assert.equal((await missions.getMission(mission.id)).status, "blocked");
  }
});

test("locked fixture inspection rejects a corrective retry after a non-canonical call", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client } = fakeClient((turnId) => lockedCommitEvents(turnId, {
    attempts: [
      {
        callId: "call-non-canonical",
        argumentsValue: {
          owner: "mtambuarano",
          repo: "proofboard-demo-fixture",
          sha: LOCKED_FIXTURE_REF,
          detail: "full_patch",
          perPage: 1,
        },
        responseContent: "not-json",
        sha: "0000000000000000000000000000000000000000",
        patches: LOCKED_FIXTURE_PATCHES,
      },
      {
        callId: "call-canonical",
        argumentsValue: {
          owner: "mtamburrano",
          repo: "proofboard-demo-fixture",
          sha: LOCKED_FIXTURE_REF,
          detail: "full_patch",
          perPage: 100,
        },
        sha: LOCKED_FIXTURE_SHA,
        patches: LOCKED_FIXTURE_PATCHES,
      },
    ],
  }));
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
    mcpServers: [{ name: "github", enableTools: ["get_commit"] }],
  });
  const mission = await runner.createMission({
    id: "mission-mcp-pinned-retry-success",
    objective: "Reject a corrective repository read after an initial non-canonical call",
    repository: {
      owner: "mtamburrano",
      name: "proofboard-demo-fixture",
      ref: LOCKED_FIXTURE_REF,
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

test("locked fixture inspection rejects when no canonical get_commit call exists", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client, calls } = fakeClient((turnId) => lockedCommitEvents(turnId, {
    attempts: [
      {
        callId: "call-non-canonical",
        argumentsValue: {
          owner: "mtambuarano",
          repo: "proofboard-demo-fixture",
          sha: LOCKED_FIXTURE_REF,
          detail: "full_patch",
        },
        sha: LOCKED_FIXTURE_SHA,
        patches: LOCKED_FIXTURE_PATCHES,
      },
    ],
  }));
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "alibaba/qwen3-8-max",
    mcpServers: [{ name: "github", enableTools: ["get_commit"] }],
  });
  const mission = await runner.createMission({
    id: "mission-mcp-pinned-arguments-failure",
    objective: "Reject a non-canonical locked fixture inspection",
    repository: {
      owner: "mtamburrano",
      name: "proofboard-demo-fixture",
      ref: LOCKED_FIXTURE_REF,
    },
  });

  await assert.rejects(
    runner.inspectRepository({ missionId: mission.id }),
    /Expected exactly one canonical get_commit MCP call, found 0/,
  );
  assert.deepEqual(calls.turns[0].agentSpec.model.params, {
    enable_thinking: false,
    parallel_tool_calls: false,
  });
  assert.equal(calls.turns.length, 1);
  const state = await missions.getState();
  assert.equal(state.missions[0].status, "blocked");
  assert.equal(
    state.evidence.some((item) => item.source === "mcp" && item.result === "passed"),
    false,
  );
});

test("failed repository inspection preserves its exact verification reason and bounded tool metadata", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client } = fakeClient((turnId) => lockedCommitEvents(turnId, {
    attempts: [{
      callId: "call-non-canonical",
      argumentsValue: {
        owner: "mtamburrano",
        repo: "proofboard-demo-fixture",
        sha: LOCKED_FIXTURE_REF,
        detail: "summary",
      },
      sha: LOCKED_FIXTURE_SHA,
      patches: LOCKED_FIXTURE_PATCHES,
    }],
  }));
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
    mcpServers: [{ name: "github", enableTools: ["get_commit"] }],
  });
  const mission = await runner.createMission({
    id: "mission-mcp-diagnostic-failure",
    objective: "Preserve the exact repository inspection rejection for diagnostics",
    repository: {
      owner: "mtamburrano",
      name: "proofboard-demo-fixture",
      ref: LOCKED_FIXTURE_REF,
    },
  });

  const expectedReason = "Expected exactly one canonical get_commit MCP call, found 0 semantically canonical calls; observed 1 total tool call.";
  await assert.rejects(
    runner.inspectRepository({ missionId: mission.id }),
    new RegExp(expectedReason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );

  const state = await missions.getState();
  const failure = state.evidence.find((item) =>
    item.source === "mcp" && item.result === "failed"
  );
  assert.ok(failure);
  const details = JSON.parse(failure.details);
  assert.equal(details.reason, expectedReason);
  assert.equal(details.verification_reason, expectedReason);
  assert.equal(details.session_id, "session-created");
  assert.equal(details.turn_id, "turn-1");
  assert.equal(details.tool_calls[0].name, "get_commit");
  assert.equal(details.tool_calls[0].arguments.detail, "summary");
  assert.equal(details.tool_responses[0].tool_call_id, "call-non-canonical");
  assert.equal(failure.executionOrigin.kind, "mcp");
  assert.equal(failure.executionOrigin.turnId, "turn-1");
});

test("locked fixture inspection rejects multiple canonical get_commit calls", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const canonicalArguments = {
    owner: "mtamburrano",
    repo: "proofboard-demo-fixture",
    sha: LOCKED_FIXTURE_REF,
    detail: "full_patch",
    perPage: 100,
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
    model: "openai/gpt-5-4-mini",
    mcpServers: [{ name: "github", enableTools: ["get_commit"] }],
  });
  const mission = await runner.createMission({
    id: "mission-mcp-pinned-multiple-canonical-failure",
    objective: "Reject ambiguous canonical repository provenance",
    repository: {
      owner: "mtamburrano",
      name: "proofboard-demo-fixture",
      ref: LOCKED_FIXTURE_REF,
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
    model: "openai/gpt-5-4-mini",
    mcpServers: [{ name: "github", enableTools: ["get_commit"] }],
  });
  const mission = await runner.createMission({
    id: "mission-mcp-pinned-result-failure",
    objective: "Reject an unverified locked fixture result",
    repository: {
      owner: "mtamburrano",
      name: "proofboard-demo-fixture",
      ref: LOCKED_FIXTURE_REF,
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
      model: "openai/gpt-5-4-mini",
      mcpServers: [{ name: "github", enableTools: ["get_commit"] }],
    });
    const mission = await runner.createMission({
      id: `mission-mcp-pinned-${fixture.label}-failure`,
      objective: "Reject an invalid locked fixture response",
      repository: {
        owner: "mtamburrano",
        name: "proofboard-demo-fixture",
        ref: LOCKED_FIXTURE_REF,
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
    model: "openai/gpt-5-4-mini",
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
    model: "openai/gpt-5-4-mini",
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
    model: "openai/gpt-5-4-mini",
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

test("independent implementation proof measures final facts after normal agentic execution", async () => {
  const repositoryRoot = PRIMARY_SANDBOX_REPOSITORY_ROOT;
  const commands = [
    `git -C ${repositoryRoot} config --get remote.origin.url`,
    `git -C ${repositoryRoot} merge-base --is-ancestor ${LOCKED_FIXTURE_SHA} HEAD`,
    `git -C ${repositoryRoot} status --porcelain=v1 -z --untracked-files=all`,
    `git -C ${repositoryRoot} diff --no-ext-diff --binary ${LOCKED_FIXTURE_SHA} --`,
    `npm --prefix ${repositoryRoot} run typecheck`,
    `npm --prefix ${repositoryRoot} test`,
  ];
  const outputs = [
    "https://github.com/mtamburrano/proofboard-demo-fixture.git\n",
    "",
    " M src/index.ts\u0000 M test/index.test.js\u0000",
    [
      "diff --git a/src/index.ts b/src/index.ts",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -1 +1,2 @@",
      " before",
      "+after",
      "diff --git a/test/index.test.js b/test/index.test.js",
      "--- a/test/index.test.js",
      "+++ b/test/index.test.js",
      "@@ -1 +1,2 @@",
      " before",
      "+after",
    ].join("\n"),
    "typecheck passed\n",
    "tests passed\n",
  ];
  const { client, calls } = fakeClient();
  const sandboxExecutor = fakeSandboxExecutor(
    commands,
    outputs,
    "sandbox-agentic-execution",
  );
  const missions = new MissionService(new InMemoryMissionRepository());
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
    dynamicSubAgents: true,
    sandboxExecutor,
  });
  const mission = await runner.createMission({
    id: "mission-agentic-final-proof",
    objective: "Verify a normal agent-owned implementation from final facts.",
    repository: {
      owner: "mtamburrano",
      name: "proofboard-demo-fixture",
      ref: LOCKED_FIXTURE_SHA,
    },
  });
  const workItem = await missions.addWorkItem(mission.id, {
    id: "work-agentic-final-proof",
    title: "Implement the verified change",
    purpose: "Let the normal implementer own setup and coding.",
    acceptanceCriteria: ["The final state is independently proven."],
    assignedRole: "implementer",
    requiredChecks: ["typecheck", "test"],
    allowedFiles: ["src/index.ts", "test/index.test.js"],
    status: "ready",
  });
  await missions.transitionWorkItem(mission.id, workItem.id, "in_progress");
  await missions.attachTrueforgeTurn(mission.id, "turn-agentic-execution");
  await missions.attachTrueforgeSandbox(mission.id, "sandbox-agentic-execution");

  const proof = await runner.proveImplementation({
    missionId: mission.id,
    workItemId: workItem.id,
  });

  assert.deepEqual(proof.filesChanged, ["src/index.ts", "test/index.test.js"]);
  assert.deepEqual(proof.checks.map((check) => check.name), ["typecheck", "test"]);
  assert.equal(proof.executionOrigin.kind, "sandbox");
  assert.equal(proof.executionOrigin.threadId, undefined);
  assert.equal(proof.executionOrigin.turnId, undefined);
  assert.equal(calls.turns.length, 0);
  assert.equal(sandboxExecutor.calls.length, commands.length);
  assert.deepEqual(sandboxExecutor.calls.map((call) => call.command), commands);
  assert.equal(sandboxExecutor.calls.every((call) => call.sandboxId === "sandbox-agentic-execution"), true);
  assert.equal(commands.every((command) => command.includes(repositoryRoot)), true);
  assert.equal(commands.some((command) => /find \\./.test(command)), false);
  assert.equal(commands.every((command) => !/[;&|]|\n/.test(command)), true);
  assert.equal(calls.updates.length, 0);

  const handoff = await missions.recordHandoff(mission.id, {
    workItemId: workItem.id,
    result: "done",
    summary: "Independent final-state proof completed.",
    filesChanged: proof.filesChanged,
    testsRun: proof.checks.map((check) => check.command),
    diffSummary: proof.diffSummary,
    checks: proof.checks,
    evidenceIds: proof.evidenceIds,
    executionOrigin: proof.executionOrigin,
  });
  await missions.transitionWorkItem(mission.id, workItem.id, "ready_for_review");
  const context = await missions.getReviewContext(mission.id, workItem.id);
  assert.equal(handoff.result, "done");
  assert.deepEqual(context.actualFilesChanged, proof.filesChanged);
  assert.equal(context.evidence.every((evidence) => evidence.source === "sandbox"), true);
});

test("independent implementation proof rejects out-of-scope final changes before checks", async () => {
  const repositoryRoot = PRIMARY_SANDBOX_REPOSITORY_ROOT;
  const commands = [
    `git -C ${repositoryRoot} config --get remote.origin.url`,
    `git -C ${repositoryRoot} merge-base --is-ancestor ${LOCKED_FIXTURE_SHA} HEAD`,
    `git -C ${repositoryRoot} status --porcelain=v1 -z --untracked-files=all`,
    `git -C ${repositoryRoot} diff --no-ext-diff --binary ${LOCKED_FIXTURE_SHA} --`,
  ];
  const outputs = [
    "git@github.com:mtamburrano/proofboard-demo-fixture.git\n",
    "",
    " M src/index.ts\u0000?? package.json\u0000",
    "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1,2 @@\n before\n+after",
  ];
  const { client, calls } = fakeClient();
  const sandboxExecutor = fakeSandboxExecutor(
    commands,
    outputs,
    "sandbox-agentic-out-of-scope",
  );
  const missions = new MissionService(new InMemoryMissionRepository());
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
    dynamicSubAgents: true,
    sandboxExecutor,
  });
  const mission = await runner.createMission({
    id: "mission-agentic-out-of-scope",
    objective: "Reject final changes outside the verified scope.",
    repository: {
      owner: "mtamburrano",
      name: "proofboard-demo-fixture",
      ref: LOCKED_FIXTURE_SHA,
    },
  });
  const workItem = await missions.addWorkItem(mission.id, {
    id: "work-agentic-out-of-scope",
    title: "Implement only the source helper",
    purpose: "Keep the completed change inside source scope.",
    acceptanceCriteria: ["Only src/index.ts changes."],
    assignedRole: "implementer",
    requiredChecks: ["typecheck", "test"],
    allowedFiles: ["src/index.ts"],
    status: "ready",
  });
  await missions.transitionWorkItem(mission.id, workItem.id, "in_progress");
  await missions.attachTrueforgeTurn(mission.id, "turn-agentic-out-of-scope");
  await missions.attachTrueforgeSandbox(mission.id, "sandbox-agentic-out-of-scope");

  await assert.rejects(
    runner.proveImplementation({ missionId: mission.id, workItemId: workItem.id }),
    /outside the allowed scope: package\.json/,
  );
  assert.equal(calls.turns.length, 0);
  assert.equal(sandboxExecutor.calls.length, commands.length);
  const state = await missions.getState();
  const failureEvidence = state.evidence.find((evidence) =>
    evidence.workItemId === workItem.id && evidence.source === "sandbox" &&
    evidence.result === "failed" && /outside the allowed scope/.test(evidence.summary)
  );
  assert.ok(failureEvidence);
  const failureDetails = JSON.parse(failureEvidence.details);
  assert.deepEqual(failureDetails.measurements.map((measurement) => measurement.command), commands);
  assert.equal(failureDetails.measurements.every((measurement) =>
    measurement.result === "passed" && measurement.exitCode === 0 &&
    measurement.sandboxId === "sandbox-agentic-out-of-scope"
  ), true);
});

test("direct Daytona proof execution resolves the exact persisted sandbox through the SDK", async () => {
  const getRequests = [];
  const executeRequests = [];
  const daytona = {
    async get(sandboxId) {
      getRequests.push(sandboxId);
      return {
        id: sandboxId,
        process: {
          async executeCommand(command, cwd, env, timeout) {
            executeRequests.push({ command, cwd, env, timeout });
            return { exitCode: 0, result: "proof output\n" };
          },
        },
      };
    },
  };
  const executor = createDaytonaSandboxExecutor({
    daytona,
    commandTimeoutSeconds: 17,
  });

  const result = await executor.execute({
    sandboxId: "v1:daytona:raw-persisted-id",
    command: "git status --porcelain=v1",
    cwd: "/proof",
  });

  assert.deepEqual(getRequests, ["raw-persisted-id"]);
  assert.deepEqual(executeRequests, [{
    command: "git status --porcelain=v1",
    cwd: "/proof",
    env: undefined,
    timeout: 17,
  }]);
  assert.deepEqual(result, {
    sandboxId: "v1:daytona:raw-persisted-id",
    exitCode: 0,
    stdout: "proof output\n",
  });
});

test("Daytona sandbox references reject an unknown provider namespace and classify auth failures", async () => {
  assert.throws(
    () => resolveDaytonaSandboxId("v1:other:raw-persisted-id"),
    /unsupported provider namespace/i,
  );
  const executor = createDaytonaSandboxExecutor({
    daytona: {
      async get() {
        const error = new Error("Authorization: Bearer live-token");
        error.name = "DaytonaAuthenticationError";
        error.statusCode = 401;
        throw error;
      },
    },
  });
  await assert.rejects(
    executor.execute({ sandboxId: "v1:daytona:raw-persisted-id", command: "true" }),
    (error) => error instanceof DaytonaSandboxExecutionError &&
      error.retryable === true &&
      error.failureClass === "infrastructure" &&
      error.failureCategory === "authentication" &&
      !error.message.includes("live-token"),
  );
});

test("direct proof marks sandbox transport failures retryable without changing the proof commands", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client, calls } = fakeClient();
  const sandboxExecutor = {
    calls: [],
    async execute(request) {
      this.calls.push(request);
      throw new Error("connection reset by peer");
    },
  };
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
    sandboxExecutor,
  });
  const mission = await runner.createMission({
    id: "mission-retryable-proof-transport",
    objective: "Classify provider transport failure as retryable proof infrastructure.",
    repository: {
      owner: "mtamburrano",
      name: "proofboard-demo-fixture",
      ref: LOCKED_FIXTURE_SHA,
    },
  });
  const workItem = await missions.addWorkItem(mission.id, {
    id: "work-retryable-proof-transport",
    title: "Measure the verified implementation",
    purpose: "Prove the implementation from the persisted sandbox.",
    acceptanceCriteria: ["Provider transport failures remain retryable."],
    assignedRole: "implementer",
    requiredChecks: ["typecheck", "test"],
    allowedFiles: ["src/index.ts"],
    status: "ready",
  });
  await missions.transitionWorkItem(mission.id, workItem.id, "in_progress");
  await missions.attachTrueforgeTurn(mission.id, "turn-retryable-proof-transport");
  await missions.attachTrueforgeSandbox(mission.id, "v1:daytona:raw-proof-sandbox");

  await assert.rejects(
    runner.proveImplementation({ missionId: mission.id, workItemId: workItem.id }),
    (error) => error instanceof TrueForgeIntegrationError &&
      error.retryable === true &&
      error.failureClass === "infrastructure" &&
      error.failureCategory === "transport",
  );
  assert.equal(calls.turns.length, 0);
  assert.equal(sandboxExecutor.calls.length, 1);
  const state = await missions.getState();
  const failure = state.evidence.find((item) => item.result === "failed");
  assert.ok(failure);
  const details = JSON.parse(failure.details);
  assert.equal(details.retryable, true);
  assert.equal(details.failure_class, "infrastructure");
  assert.equal(details.failure_reason_category, "transport");
});

test("sandbox verification persists the command, output summary, and exit status", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client, calls } = fakeClient(sandboxEvents);
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
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
    model: "openai/gpt-5-4-mini",
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
    model: "openai/gpt-5-4-mini",
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
    model: "openai/gpt-5-4-mini",
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

test("sandbox verification rejects incomplete or unsafe proof", async () => {
  const cases = [
    {
      label: "missing intent",
      options: { sandboxArguments: { command: "node --test" } },
      error: /bounded intent/,
    },
    {
      label: "unbounded intent",
      options: {
        sandboxArguments: {
          intent: "i".repeat(1_201),
          command: "node --test",
        },
      },
      error: /bounded intent/,
    },
    {
      label: "wrong command",
      options: {
        sandboxArguments: {
          intent: SANDBOX_VERIFICATION_INTENT,
          command: "npm test",
        },
      },
      error: /required canonical command/,
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
      error: /cwd is not permitted for generic sandbox verification.*\/tmp/,
    },
    {
      label: "provider working directory",
      options: {
        sandboxArguments: {
          intent: SANDBOX_VERIFICATION_INTENT,
          command: "node --test",
          cwd: "/workspace",
        },
      },
      error: /cwd is not permitted for generic sandbox verification.*\/workspace/,
    },
    {
      label: "malformed arguments",
      options: { sandboxArguments: "not-an-object" },
      error: /arguments were not a JSON object/,
    },
    {
      label: "root working directory on generic command",
      options: {
        sandboxArguments: {
          intent: SANDBOX_VERIFICATION_INTENT,
          command: "node --test",
          cwd: "/",
        },
      },
      error: /cwd is not permitted for generic sandbox verification.*\//,
    },
    {
      label: "unexpected environment",
      options: {
        sandboxArguments: {
          intent: SANDBOX_VERIFICATION_INTENT,
          command: "node --test",
          env: { NODE_ENV: "test" },
        },
      },
      error: /unsupported extra argument.*env/,
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
      error: /parallel tool calls|Expected exactly one coordinator-owned exec sandbox call, found 2/,
    },
    {
      label: "later non-canonical exec call",
      options: {
        additionalSandboxCalls: [{
          callId: "call-exec-later",
          argumentsValue: {
            intent: "inspect the workspace",
            command: "git status --short",
          },
        }],
      },
      error: /parallel tool calls|Expected exactly one coordinator-owned exec sandbox call, found 2/,
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
      label: "runtime failure exit code",
      exitCode: -1,
      error: /exec sandbox command exited with code -1/,
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
      model: "openai/gpt-5-4-mini",
    });
    const mission = await runner.createMission({
      id: `mission-sandbox-negative-${index}`,
      objective: `Reject ${fixture.label} sandbox proof`,
    });

    if (fixture.expectedSuccess === true) {
      const verification = await runner.runSandboxVerification({ missionId: mission.id, command: "node --test" });
      assert.equal(verification.exitCode, 0, fixture.label);
    } else {
      await assert.rejects(
        runner.runSandboxVerification({ missionId: mission.id, command: "node --test" }),
        (error) => {
          assert.equal(error.operation, "run sandbox verification", fixture.label);
          assert.match(error.message, fixture.error, fixture.label);
          return true;
        },
      );
    }
    const state = await missions.getState();
    assert.equal(
      state.missions[0].status,
      fixture.expectedSuccess === true ? "draft" : "blocked",
      fixture.label,
    );
    assert.equal(
      state.evidence.some((item) => item.source === "sandbox" && item.result === "passed"),
      fixture.expectedSuccess === true,
      fixture.label,
    );
  }
});

test("nonzero sandbox execution is recorded as failure and blocks the mission", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  const { client } = fakeClient((turnId) => sandboxEvents(turnId, 1));
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "openai/gpt-5-4-mini",
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
    model: "openai/gpt-5-4-mini",
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
      model: "openai/gpt-5-4-mini",
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
