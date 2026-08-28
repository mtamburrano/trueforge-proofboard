import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  DeterministicImplementationVerifier,
  COORDINATOR_TRUEFORGE_ITERATION_LIMIT,
  DEFAULT_TRUEFORGE_ITERATION_LIMIT,
  InMemoryMissionRepository,
  MissionService,
  PRIMARY_DELIVERY_FIXTURE,
  PRIMARY_VERIFIED_DELIVERY_PATCHES,
  PRIMARY_MISSION_ID,
  PRIMARY_MISSION_OBJECTIVE,
  PRIMARY_REPOSITORY,
  RepositoryWorkGraphPlanner,
  TrueForgeMissionRunner,
  DELEGATED_WORKSPACE_TREE_SNAPSHOT_COMMAND,
  LOCKED_REPOSITORY_PREPARATION_COMMAND,
  LOCKED_REPOSITORY_PREPARATION_INTENT,
  buildDelegatedWorkspaceDeltaCommand,
  createMissionHttpApp,
} from "../dist/index.js";
import { workspaceDeltaEvidenceDetails } from "./delegated-proof-fixture.js";

const ORIGIN = {
  kind: "trueforge",
  sessionId: "session-hardening",
  turnId: "turn-hardening",
  threadId: "thread-hardening",
};
const execFileAsync = promisify(execFile);
const LOCKED_REPOSITORY_REMOTE_URL =
  `https://github.com/${PRIMARY_DELIVERY_FIXTURE.owner}/${PRIMARY_DELIVERY_FIXTURE.repository}.git`;
const WORKSPACE_SNAPSHOT_INTENT =
  "Capture the coordinator-owned workspace tree before delegated implementation starts.";
const WORKSPACE_DELTA_INTENT =
  "Capture the coordinator-owned current work-item and cumulative mission workspace deltas after delegated implementation.";

function fixedClock() {
  return new Date("2026-08-27T15:00:00.000Z");
}

async function runLocalGit(args, cwd, env = {}) {
  return execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 1024 * 1024,
  });
}

async function createLocalRepositoryBoundary() {
  const root = await mkdtemp(path.join(os.tmpdir(), "trueforge-locked-repository-"));
  const remotePath = path.join(root, "remote.git");
  const seedPath = path.join(root, "seed");
  const workspacePath = path.join(root, "workspace");
  const gitConfigPath = path.join(root, "gitconfig");
  const gitEnv = {
    GIT_CONFIG_GLOBAL: gitConfigPath,
    GIT_CONFIG_NOSYSTEM: "1",
  };

  try {
    await runLocalGit(["init", "--initial-branch=main", seedPath], root);
    await runLocalGit(["config", "user.email", "test@example.invalid"], seedPath);
    await runLocalGit(["config", "user.name", "TrueForge Test"], seedPath);
    await writeFile(path.join(seedPath, "README.md"), "locked repository fixture\n", "utf8");
    await runLocalGit(["add", "README.md"], seedPath);
    await runLocalGit(["commit", "-m", "baseline"], seedPath);
    await runLocalGit(["clone", "--bare", seedPath, remotePath], root);
    await runLocalGit([
      "config",
      "--file",
      gitConfigPath,
      `url.${pathToFileURL(remotePath).href}.insteadOf`,
      LOCKED_REPOSITORY_REMOTE_URL,
    ], root);
    await mkdir(workspacePath);
    const { stdout } = await runLocalGit(["rev-parse", "--verify", "HEAD"], seedPath);
    return {
      gitEnv,
      root,
      workspacePath: await realpath(workspacePath),
      baselineSha: stdout.trim(),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function legacyPrimaryState() {
  const timestamp = fixedClock().toISOString();
  return {
    schemaVersion: 1,
    revision: 20,
    missions: [{
      id: PRIMARY_MISSION_ID,
      objective: PRIMARY_MISSION_OBJECTIVE,
      status: "planning",
      createdAt: timestamp,
      updatedAt: timestamp,
      repository: PRIMARY_REPOSITORY,
      trueforgeSessionId: "legacy-session",
    }],
    workItems: [
      {
        id: "primary-inspect",
        missionId: PRIMARY_MISSION_ID,
        title: "Inspect pinned repository",
        purpose: "Inspect the pinned source.",
        status: "ready",
        dependsOn: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        assignedRole: "planner",
      },
      {
        id: "primary-implement",
        missionId: PRIMARY_MISSION_ID,
        title: "Implement stage helper",
        purpose: "Implement the requested helper.",
        status: "backlog",
        dependsOn: ["primary-inspect"],
        createdAt: timestamp,
        updatedAt: timestamp,
        assignedRole: "implementer",
      },
      {
        id: "primary-verify",
        missionId: PRIMARY_MISSION_ID,
        title: "Verify delivery",
        purpose: "Verify the requested delivery.",
        status: "backlog",
        dependsOn: ["primary-implement"],
        createdAt: timestamp,
        updatedAt: timestamp,
        assignedRole: "reviewer",
      },
    ],
    evidence: [{
      id: "legacy-history",
      missionId: PRIMARY_MISSION_ID,
      kind: "tool_result",
      result: "informational",
      source: "system",
      summary: "Legacy mission history remains durable.",
      createdAt: timestamp,
    }],
    handoffs: [],
    reviews: [],
    approvals: [],
    deliveries: [],
  };
}

function diffOutput(files = ["src/index.ts", "test/index.test.js"]) {
  return files.map((file) => [
    `diff --git a/${file} b/${file}`,
    "@@ -1 +1,2 @@",
    `+export const changedFile = \"${file}\";`,
  ].join("\n")).join("\n");
}

function changedFilesManifestOutput(files = ["src/index.ts", "test/index.test.js"]) {
  return `${files.map((file) => ` M ${file}`).join("\u0000")}\u0000`;
}

const WORKSPACE_START_TREE = "a".repeat(40);
const WORKSPACE_END_TREE = "b".repeat(40);

function workspaceSnapshotEvents(
  treeRef,
  turnId = "turn-workspace-start",
  { intent = WORKSPACE_SNAPSHOT_INTENT, threadId = "main", responseThreadId = "main" } = {},
) {
  return [
    { type: "turn.created", id: `${turnId}-created`, turnId, threadId: null, state: { status: "running" } },
    {
      type: "model.message",
      id: `${turnId}-model`,
      threadId,
      toolCalls: [{
        id: `${turnId}-call-snapshot`,
        function: {
          name: "exec",
          arguments: JSON.stringify({ intent, command: DELEGATED_WORKSPACE_TREE_SNAPSHOT_COMMAND }),
        },
      }],
    },
    {
      type: "tool.response",
      id: `${turnId}-response`,
      threadId: responseThreadId,
      toolCallId: `${turnId}-call-snapshot`,
      content: JSON.stringify({ success: true, response: { exitCode: 0, result: `TRUEFORGE_WORKSPACE_TREE ${treeRef}\n` } }),
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

function workspaceDeltaEvents({
  startTreeRef = WORKSPACE_START_TREE,
  missionStartTreeRef = WORKSPACE_START_TREE,
  endTreeRef = WORKSPACE_END_TREE,
  currentFiles = ["src/index.ts", "test/index.test.js"],
  cumulativeFiles = currentFiles,
  turnId = "turn-workspace-delta",
  intent = WORKSPACE_DELTA_INTENT,
  threadId = "main",
  responseThreadId = "main",
} = {}) {
  const command = buildDelegatedWorkspaceDeltaCommand(startTreeRef, missionStartTreeRef);
  const callId = `${turnId}-call-delta`;
  return [
    { type: "turn.created", id: `${turnId}-created`, turnId, threadId: null, state: { status: "running" } },
    {
      type: "model.message",
      id: `${turnId}-model`,
      threadId,
      toolCalls: [{
        id: callId,
        function: { name: "exec", arguments: JSON.stringify({ intent, command }) },
      }],
    },
    {
      type: "tool.response",
      id: `${turnId}-response`,
      threadId: responseThreadId,
      toolCallId: callId,
      content: JSON.stringify({
        success: true,
        response: {
          exitCode: 0,
          result: workspaceDeltaOutput(
            startTreeRef,
            missionStartTreeRef,
            endTreeRef,
            currentFiles,
            cumulativeFiles,
          ),
        },
      }),
    },
    { type: "turn.done", id: `${turnId}-done`, threadId: null, state: { status: "done", requiredActions: [] } },
  ];
}

function repositoryPreparationEvents({
  repository = `${PRIMARY_REPOSITORY.owner}/${PRIMARY_REPOSITORY.name}`,
  sha = PRIMARY_REPOSITORY.ref,
  root = "/workspace",
  exitCode = 0,
  result = `TRUEFORGE_REPOSITORY_READY repository=${repository} sha=${sha} root=${root}\n`,
  turnId = "turn-repository-preparation",
  intent = LOCKED_REPOSITORY_PREPARATION_INTENT,
  threadId = "main",
  responseThreadId = "main",
} = {}) {
  const callId = `${turnId}-call-preparation`;
  return [
    { type: "turn.created", id: `${turnId}-created`, turnId, threadId: null, state: { status: "running" } },
    { type: "sandbox.created", id: `${turnId}-sandbox`, threadId: null, sandboxId: "sandbox-1" },
    {
      type: "model.message",
      id: `${turnId}-model`,
      threadId,
      toolCalls: [{
        id: callId,
        function: {
          name: "exec",
          arguments: JSON.stringify({
            intent,
            command: LOCKED_REPOSITORY_PREPARATION_COMMAND,
          }),
        },
      }],
    },
    {
      type: "tool.response",
      id: `${turnId}-response`,
      threadId: responseThreadId,
      toolCallId: callId,
      content: JSON.stringify({ success: true, response: { exitCode, result } }),
    },
    { type: "turn.done", id: `${turnId}-done`, threadId: null, state: { status: "done", requiredActions: [] } },
  ];
}

function trueforgeStream(events) {
  return {
    async *withMetadata() {
      for (const event of events) {
        yield { data: event };
      }
    },
  };
}

async function lockedRepositoryRunnerFixture({ preparation = {}, failRestore = false } = {}) {
  const missions = new MissionService(new InMemoryMissionRepository(), fixedClock);
  const turnRequests = [];
  const agentSpecUpdates = [];
  let turnNumber = 0;
  let activeAgentSpec;
  const client = {
    sessions: {
      async create(request) {
        activeAgentSpec = request.agent.spec;
        return { data: { id: ORIGIN.sessionId } };
      },
      async get(sessionId) {
        return { data: { id: sessionId } };
      },
      async update(sessionId, request) {
        agentSpecUpdates.push({ sessionId, request });
        if (failRestore && agentSpecUpdates.length === 2) {
          throw new Error("session restore rejected");
        }
        activeAgentSpec = request.agent.spec;
        return { data: { id: sessionId } };
      },
      async createTurnStream(sessionId, request) {
        turnRequests.push({ sessionId, request, agentSpec: activeAgentSpec });
        const current = turnNumber++;
        if (current === 0) {
          return trueforgeStream(repositoryPreparationEvents(preparation));
        }
        if (current === 1) {
          return trueforgeStream(workspaceSnapshotEvents(WORKSPACE_START_TREE));
        }
        if (current === 2) {
          return trueforgeStream(delegatedEvents(
            "npm run typecheck && npm test",
            diffOutput(),
          ));
        }
        return trueforgeStream(workspaceDeltaEvents());
      },
    },
  };
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "local/locked-repository-fixture",
    dynamicSubAgents: true,
  });
  const mission = await runner.createMission({
    id: "mission-locked-repository-preparation",
    objective: "Prepare the locked repository before delegated proof.",
    repository: PRIMARY_REPOSITORY,
  });
  const workItem = await missions.addWorkItem(mission.id, {
    id: "work-locked-repository-preparation",
    title: "Implement the bounded change",
    purpose: "Apply the bounded change in the prepared repository.",
    acceptanceCriteria: ["The bounded change is checked."],
    requiredChecks: ["typecheck", "test"],
    assignedRole: "implementer",
    allowedFiles: ["src/index.ts", "test/index.test.js"],
    status: "ready",
  });
  await missions.transitionWorkItem(mission.id, workItem.id, "in_progress");
  return { missions, runner, mission, workItem, turnRequests, agentSpecUpdates };
}

function transitionContractVerifier() {
  return {
    reviewContract(context) {
      const contract = [
        context.workItem.title,
        context.workItem.purpose,
        ...context.workItem.acceptanceCriteria,
      ].join(" ");
      const addedSource = context.actualDiff
        .split(/\r?\n/)
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .map((line) => line.slice(1))
        .join("\n");
      if (
        !contract.includes("getNextDeliveryStage") ||
        !contract.includes("Plan") ||
        !contract.includes("Execute") ||
        !context.actualFilesChanged.includes("src/index.ts")
      ) {
        return {
          outcome: "changes_requested",
          reviewer: "semantic-test-verifier",
          summary: "The contract-aware verifier could not identify the requested transition contract.",
          finding: "The work-item contract is not bound to the verified source scope.",
        };
      }
      let implementation;
      try {
        implementation = new Function(
          `${addedSource.replace(/\bexport\s+/, "")}; return getNextDeliveryStage;`,
        )();
      } catch {
        implementation = undefined;
      }
      const transitions = [
        ["Plan", "Execute"],
        ["Execute", "Prove"],
        ["Prove", "Approve"],
        ["Approve", null],
      ];
      if (
        typeof implementation !== "function" ||
        !transitions.every(([stage, next]) => implementation(stage) === next)
      ) {
        return {
          outcome: "changes_requested",
          reviewer: "semantic-test-verifier",
          summary: "The contract-aware verifier found behavior that does not satisfy the transition contract.",
          finding: "The executable helper does not implement every required transition.",
        };
      }
      return {
        outcome: "accepted",
        reviewer: "semantic-test-verifier",
        summary: "The contract-aware verifier executed the changed helper against every required transition.",
        finding: "No blocking findings.",
      };
    },
  };
}

function delegatedEvents(
  command,
  output,
  {
    includeDiff = true,
    diffCommand = "git diff",
    includeManifest = true,
    manifestCommand = "git status --porcelain=v1 -z --untracked-files=all",
    manifestOutput = changedFilesManifestOutput(),
    extraToolCalls = [],
    narrationOnly = false,
    responseType = "tool.response",
  } = {},
) {
  const response = (id, callId, result) => ({
    type: responseType,
    id,
    threadId: ORIGIN.threadId,
    toolCallId: callId,
    content: JSON.stringify({
      success: true,
      response: { exitCode: 0, result },
    }),
  });
  return [
    {
      type: "turn.created",
      id: "event-turn",
      turnId: ORIGIN.turnId,
      state: { status: "running" },
    },
    {
      type: "thread.created",
      id: "event-thread",
      threadId: ORIGIN.threadId,
      agentInfo: {
        type: "dynamic",
        name: "bounded-implementer",
        input: "Work Packet: bounded implementation",
      },
    },
    {
      type: "model.message",
      id: "event-model",
      threadId: ORIGIN.threadId,
      toolCalls: [
        { id: "call-check", function: { name: "exec", arguments: JSON.stringify({ command }) } },
        ...extraToolCalls.map((extra, index) => ({
          id: extra.id ?? `call-extra-${index}`,
          function: { name: "exec", arguments: JSON.stringify({ command: extra.command }) },
        })),
        ...(includeManifest
          ? [{ id: "call-manifest", function: { name: "exec", arguments: JSON.stringify({ command: manifestCommand }) } }]
          : []),
        ...(includeDiff
          ? [{ id: "call-diff", function: { name: "exec", arguments: JSON.stringify({ command: diffCommand }) } }]
          : []),
      ],
    },
    response("event-check-response", "call-check", "checks complete\n"),
    ...extraToolCalls.map((extra, index) => response(
      `event-extra-response-${index}`,
      extra.id ?? `call-extra-${index}`,
      extra.output ?? "command completed\n",
    )),
    ...(includeManifest ? [response("event-manifest-response", "call-manifest", manifestOutput)] : []),
    ...(includeDiff ? [response("event-diff-response", "call-diff", output)] : []),
    {
      type: "thread.done",
      id: "event-thread-done",
      threadId: ORIGIN.threadId,
      state: {
        status: "done",
        output: {
          content: JSON.stringify({
            decisions: [],
            openQuestions: [],
            ...(narrationOnly
              ? {
                  filesChanged: ["src/index.ts", "test/index.test.js"],
                  diffSummary: "The agent says both verified files changed.",
                }
              : {}),
          }),
        },
      },
    },
    {
      type: "turn.done",
      id: "event-turn-done",
      state: { status: "done", requiredActions: [] },
    },
  ];
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

async function runnerFixture({
  command = "npm run typecheck && npm test",
  output = diffOutput(),
  allowedFiles = ["src/index.ts", "test/index.test.js"],
  includeDiff = true,
  diffCommand = "git diff",
  includeManifest = true,
  manifestCommand = "git status --porcelain=v1 -z --untracked-files=all",
  manifestOutput,
  extraToolCalls = [],
  workspaceCurrentFiles = ["src/index.ts", "test/index.test.js"],
  workspaceCumulativeFiles = workspaceCurrentFiles,
  workspaceStartTreeRef = WORKSPACE_START_TREE,
  workspaceMissionStartTreeRef = workspaceStartTreeRef,
  workspaceEndTreeRef = WORKSPACE_END_TREE,
  workspaceSnapshotIntent = WORKSPACE_SNAPSHOT_INTENT,
  workspaceDeltaIntent = WORKSPACE_DELTA_INTENT,
  workspaceSnapshotThreadId = "main",
  workspaceDeltaThreadId = "main",
  workspaceSnapshotResponseThreadId = "main",
  workspaceDeltaResponseThreadId = "main",
  narrationOnly = false,
  responseType = "tool.response",
  run = true,
} = {}) {
  const missions = new MissionService(new InMemoryMissionRepository(), fixedClock);
  let turnNumber = 0;
  const turnRequests = [];
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
      async createTurnStream(sessionId, request) {
        turnRequests.push({ sessionId, request });
        const currentTurnNumber = turnNumber;
        turnNumber += 1;
        if (currentTurnNumber === 0) {
          return {
            async *withMetadata() {
              for (const event of workspaceSnapshotEvents(workspaceStartTreeRef, "turn-workspace-start", {
                intent: workspaceSnapshotIntent,
                threadId: workspaceSnapshotThreadId,
                responseThreadId: workspaceSnapshotResponseThreadId,
              })) {
                yield { data: event };
              }
            },
          };
        }
        if (currentTurnNumber === 2) {
          return {
            async *withMetadata() {
              for (const event of workspaceDeltaEvents({
                startTreeRef: workspaceStartTreeRef,
                missionStartTreeRef: workspaceMissionStartTreeRef,
                endTreeRef: workspaceEndTreeRef,
                currentFiles: workspaceCurrentFiles,
                cumulativeFiles: workspaceCumulativeFiles,
                intent: workspaceDeltaIntent,
                threadId: workspaceDeltaThreadId,
                responseThreadId: workspaceDeltaResponseThreadId,
              })) {
                yield { data: event };
              }
            },
          };
        }
        return {
          async *withMetadata() {
            for (const event of delegatedEvents(command, output, {
              includeDiff,
              diffCommand,
              includeManifest,
              manifestCommand,
              manifestOutput: manifestOutput ?? changedFilesManifestOutput(),
              extraToolCalls,
              narrationOnly,
              responseType,
            })) {
              yield { data: event };
            }
          },
        };
      },
    },
  };
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "local/test-model",
    dynamicSubAgents: true,
  });
  const mission = await runner.createMission({
    id: "mission-hardening",
    objective: "Capture bounded delegated proof.",
  });
  const workItem = await missions.addWorkItem(mission.id, {
    id: "work-hardening",
    title: "Implement the bounded change",
    purpose: "Apply the bounded change and preserve its evidence.",
    acceptanceCriteria: ["The bounded change is checked."],
    requiredChecks: ["typecheck", "test"],
    assignedRole: "implementer",
    allowedFiles,
    status: "ready",
  });
  await missions.transitionWorkItem(mission.id, workItem.id, "in_progress");
  const result = run
    ? await runner.runTurn(mission.id, "Implement the bounded change.", {
        workItemId: workItem.id,
        delegateToSubagent: true,
      })
    : undefined;
  return { missions, mission, runner, workItem, result, turnRequests };
}

test("the default reviewer fails closed instead of trusting lexical contract anchors", () => {
  const diff = [
    "diff --git a/src/index.ts b/src/index.ts",
    "@@ -1 +1,2 @@",
    "+// getNextDeliveryStage maps Plan to Execute, then Prove and Approve.",
    "+const unrelated = \"getNextDeliveryStage Plan Execute Prove Approve\";",
  ].join("\n");
  const decision = new DeterministicImplementationVerifier().review({
    workItem: {
      title: "Implement getNextDeliveryStage",
      purpose: "Add getNextDeliveryStage to src/index.ts.",
      acceptanceCriteria: ["The helper maps Plan to Execute."],
    },
    handoff: { openQuestions: [] },
    filesChanged: ["src/index.ts"],
    actualFilesChanged: ["src/index.ts"],
    actualDiff: diff,
    diffSummary: diff,
    checks: [{ name: "test", required: true, result: "passed" }],
    evidence: [{
      kind: "diff_summary",
      result: "passed",
      details: JSON.stringify({ command: "git diff", output: diff }),
    }],
  });

  assert.equal(decision.outcome, "changes_requested");
  assert.match(decision.finding, /contract-aware|structural|semantic/i);
  assert.equal(
    new DeterministicImplementationVerifier(transitionContractVerifier()).review({
      workItem: {
        title: "Implement getNextDeliveryStage",
        purpose: "Add getNextDeliveryStage to src/index.ts.",
        acceptanceCriteria: ["The helper maps Plan to Execute."],
      },
      handoff: { openQuestions: [] },
      filesChanged: ["src/index.ts"],
      actualFilesChanged: ["src/index.ts"],
      actualDiff: diff,
      diffSummary: diff,
      checks: [{ name: "test", required: true, result: "passed" }],
      evidence: [{
        kind: "diff_summary",
        result: "passed",
        details: JSON.stringify({ command: "git diff", output: diff }),
      }],
    }).outcome,
    "changes_requested",
  );
});

test("an injected contract verifier accepts behavior it executes against the changed state", () => {
  const diff = [
    "diff --git a/src/index.ts b/src/index.ts",
    "@@ -1 +1,5 @@",
    "+export function getNextDeliveryStage(stage) {",
    '+  return { Plan: "Execute", Execute: "Prove", Prove: "Approve", Approve: null }[stage] ?? null;',
    "+}",
  ].join("\n");
  const decision = new DeterministicImplementationVerifier(transitionContractVerifier()).review({
    workItem: {
      title: "Implement getNextDeliveryStage",
      purpose: "Add getNextDeliveryStage to src/index.ts.",
      acceptanceCriteria: ["The helper maps Plan to Execute, Execute to Prove, Prove to Approve, and Approve to null."],
    },
    handoff: { openQuestions: [] },
    filesChanged: ["src/index.ts"],
    actualFilesChanged: ["src/index.ts"],
    actualDiff: diff,
    diffSummary: diff,
    checks: [{ name: "test", required: true, result: "passed" }],
    evidence: [{
      kind: "diff_summary",
      result: "passed",
      details: JSON.stringify({ command: "git diff", output: diff }),
    }],
  });

  assert.equal(decision.outcome, "accepted");
});

test("shell wrappers cannot satisfy required delegated checks", async () => {
  for (const command of [
    "echo npm test",
    "npm test || true",
    "npm run check 2>&1; echo \"EXIT_CODE=$?\"",
  ]) {
    const fixture = await runnerFixture({ command, run: false });
    await assert.rejects(
      fixture.runner.runTurn(fixture.mission.id, "Implement the bounded change.", {
        workItemId: fixture.workItem.id,
        delegateToSubagent: true,
      }),
      (error) => /unsafe shell command|mask the real exit status/i.test(error.message),
    );
    const state = await fixture.missions.getState();
    assert.equal(state.workItems.find((item) => item.id === fixture.workItem.id).status, "blocked");
    assert.equal(
      state.evidence.some((evidence) =>
        evidence.result === "failed" && evidence.summary.startsWith("Delegated implementation evidence failed:"),
      ),
      true,
      command,
    );
  }
});

test("pending tool responses cannot satisfy delegated proof", async () => {
  const fixture = await runnerFixture({ responseType: "tool.response_required", run: false });

  await assert.rejects(
    fixture.runner.runTurn(fixture.mission.id, "Implement the bounded change.", {
      workItemId: fixture.workItem.id,
      delegateToSubagent: true,
    }),
    (error) => /no observed exit-preserving tool execution|was blocked/i.test(error.message),
  );

  const state = await fixture.missions.getState();
  assert.equal(state.workItems.find((item) => item.id === fixture.workItem.id).status, "blocked");
  assert.equal(state.evidence.some((evidence) =>
    evidence.result === "failed" && evidence.summary.startsWith("Delegated implementation evidence failed:"),
  ), true);
});

test("narrated file claims cannot substitute for a delegated content diff", async () => {
  const fixture = await runnerFixture({ includeDiff: false, narrationOnly: true, run: false });

  await assert.rejects(
    fixture.runner.runTurn(fixture.mission.id, "Implement the bounded change.", {
      workItemId: fixture.workItem.id,
      delegateToSubagent: true,
    }),
    (error) => /narration-only|content-bearing diff/i.test(error.message),
  );

  const state = await fixture.missions.getState();
  const failure = state.evidence.find((evidence) =>
    evidence.result === "failed" && evidence.summary.startsWith("Delegated implementation evidence failed:"),
  );
  assert.ok(failure);
  assert.equal(state.workItems.find((item) => item.id === fixture.workItem.id).status, "blocked");
  assert.match(failure.details, /narration-only|content-bearing diff/i);
});

test("safe working-directory prefixes preserve exit-aware check evidence", async () => {
  const { result } = await runnerFixture({
    command: "cd /workspace && npm run typecheck && npm test",
  });

  assert.deepEqual(result.implementationHandoff.checks.map((check) => [check.name, check.result]), [
    ["typecheck", "passed"],
    ["test", "passed"],
  ]);
});

test("coordinator workspace proof turns request their exact sandbox exec commands", async () => {
  const missionStartTreeRef = "c".repeat(40);
  const expectedDeltaCommand = buildDelegatedWorkspaceDeltaCommand(
    WORKSPACE_START_TREE,
    missionStartTreeRef,
  );
  const fixture = await runnerFixture({
    workspaceMissionStartTreeRef: missionStartTreeRef,
    workspaceSnapshotIntent: "Take the pre-delegation tree snapshot in the coordinator sandbox.",
    workspaceDeltaIntent: "Collect the anchored workspace changes after delegated implementation.",
    run: false,
  });
  await fixture.missions.attachTrueforgeWorkspaceBaseline(fixture.mission.id, missionStartTreeRef);

  await fixture.runner.runTurn(fixture.mission.id, "Implement the bounded change.", {
    workItemId: fixture.workItem.id,
    delegateToSubagent: true,
  });

  assert.equal(fixture.turnRequests.length, 3);
  const snapshotRequest = fixture.turnRequests[0];
  const deltaRequest = fixture.turnRequests[2];
  assert.ok(snapshotRequest);
  assert.ok(deltaRequest);
  assert.match(snapshotRequest.request.input[0].content, /Call the sandbox tool exec exactly once/);
  assert.match(deltaRequest.request.input[0].content, /Call the sandbox tool exec exactly once/);
  assert.deepEqual(sandboxInstructionArguments(snapshotRequest.request), {
    intent: WORKSPACE_SNAPSHOT_INTENT,
    command: DELEGATED_WORKSPACE_TREE_SNAPSHOT_COMMAND,
  });
  assert.deepEqual(sandboxInstructionArguments(deltaRequest.request), {
    intent: WORKSPACE_DELTA_INTENT,
    command: expectedDeltaCommand,
  });
});

test("coordinator workspace proof accepts root main and rejects dynamic child execs", async () => {
  const accepted = await runnerFixture({
    workspaceSnapshotThreadId: "main",
    workspaceDeltaThreadId: "main",
    run: false,
  });
  const acceptedResult = await accepted.runner.runTurn(accepted.mission.id, "Implement the bounded change.", {
    workItemId: accepted.workItem.id,
    delegateToSubagent: true,
  });
  assert.ok(acceptedResult.implementationHandoff);
  assert.equal(accepted.turnRequests.length, 3);

  const childSnapshot = await runnerFixture({
    workspaceSnapshotThreadId: "thread-subagent",
    run: false,
  });
  await assert.rejects(
    childSnapshot.runner.runTurn(childSnapshot.mission.id, "Implement the bounded change.", {
      workItemId: childSnapshot.workItem.id,
      delegateToSubagent: true,
    }),
    /workspace start snapshot/i,
  );
  assert.equal(childSnapshot.turnRequests.length, 1);

  const childSnapshotResponse = await runnerFixture({
    workspaceSnapshotResponseThreadId: "thread-subagent",
    run: false,
  });
  await assert.rejects(
    childSnapshotResponse.runner.runTurn(childSnapshotResponse.mission.id, "Implement the bounded change.", {
      workItemId: childSnapshotResponse.workItem.id,
      delegateToSubagent: true,
    }),
    /workspace start snapshot/i,
  );
  assert.equal(childSnapshotResponse.turnRequests.length, 1);

  const childDelta = await runnerFixture({
    workspaceDeltaThreadId: "thread-subagent",
    run: false,
  });
  await assert.rejects(
    childDelta.runner.runTurn(childDelta.mission.id, "Implement the bounded change.", {
      workItemId: childDelta.workItem.id,
      delegateToSubagent: true,
    }),
    /workspace delta/i,
  );
  assert.equal(childDelta.turnRequests.length, 3);

  const childDeltaResponse = await runnerFixture({
    workspaceDeltaResponseThreadId: "thread-subagent",
    run: false,
  });
  await assert.rejects(
    childDeltaResponse.runner.runTurn(childDeltaResponse.mission.id, "Implement the bounded change.", {
      workItemId: childDeltaResponse.workItem.id,
      delegateToSubagent: true,
    }),
    /workspace delta/i,
  );
  assert.equal(childDeltaResponse.turnRequests.length, 3);
});

test("empty locked fixture sandboxes are prepared before the workspace snapshot and delegation", async () => {
  const fixture = await lockedRepositoryRunnerFixture({
    preparation: {
      intent: "Initialize and verify the pinned repository in the persistent sandbox workspace.",
    },
  });

  const result = await fixture.runner.runTurn(fixture.mission.id, "Implement the bounded change.", {
    workItemId: fixture.workItem.id,
    delegateToSubagent: true,
  });

  assert.ok(result.implementationHandoff);
  assert.equal(fixture.turnRequests.length, 4);
  assert.deepEqual(
    fixture.turnRequests.map((turn) => turn.sessionId),
    Array(4).fill(ORIGIN.sessionId),
  );
  assert.deepEqual(sandboxInstructionArguments(fixture.turnRequests[0].request), {
    intent: LOCKED_REPOSITORY_PREPARATION_INTENT,
    command: LOCKED_REPOSITORY_PREPARATION_COMMAND,
  });
  assert.equal(fixture.turnRequests[1].request.previousTurnId, "turn-repository-preparation");
  assert.match(
    fixture.turnRequests[2].request.input[0].content,
    /prepared and verified the pinned repository in this persistent sandbox workspace/i,
  );
  assert.equal(fixture.turnRequests[3].request.previousTurnId, ORIGIN.turnId);
  assert.deepEqual(
    fixture.agentSpecUpdates.map((update) => update.sessionId),
    Array(6).fill(ORIGIN.sessionId),
  );
  assert.deepEqual(
    fixture.agentSpecUpdates.map((update) => update.request.agent.spec.config.iterationLimit),
    [
      COORDINATOR_TRUEFORGE_ITERATION_LIMIT,
      DEFAULT_TRUEFORGE_ITERATION_LIMIT,
      COORDINATOR_TRUEFORGE_ITERATION_LIMIT,
      DEFAULT_TRUEFORGE_ITERATION_LIMIT,
      COORDINATOR_TRUEFORGE_ITERATION_LIMIT,
      DEFAULT_TRUEFORGE_ITERATION_LIMIT,
    ],
  );
  assert.equal(fixture.agentSpecUpdates[0].request.agent.spec.model.params.parallelToolCalls, false);
  assert.equal(fixture.agentSpecUpdates[2].request.agent.spec.model.params.parallelToolCalls, false);
  assert.equal(fixture.agentSpecUpdates[4].request.agent.spec.model.params.parallelToolCalls, false);
  assert.equal(fixture.agentSpecUpdates[1].request.agent.spec.model.params, undefined);
  assert.equal(fixture.agentSpecUpdates[3].request.agent.spec.model.params, undefined);
  assert.equal(fixture.agentSpecUpdates[5].request.agent.spec.model.params, undefined);
  assert.equal(fixture.turnRequests[0].agentSpec.config.iterationLimit, COORDINATOR_TRUEFORGE_ITERATION_LIMIT);
  assert.equal(fixture.turnRequests[1].agentSpec.config.iterationLimit, COORDINATOR_TRUEFORGE_ITERATION_LIMIT);
  assert.equal(fixture.turnRequests[2].agentSpec.config.iterationLimit, DEFAULT_TRUEFORGE_ITERATION_LIMIT);
  assert.equal(fixture.turnRequests[2].agentSpec.config.dynamicSubAgents.enabled, true);
  assert.equal(fixture.turnRequests[3].agentSpec.config.iterationLimit, COORDINATOR_TRUEFORGE_ITERATION_LIMIT);

  const state = await fixture.missions.getState();
  assert.equal(state.missions[0].trueforgeSandboxId, "sandbox-1");
  const preparation = state.evidence.find((evidence) =>
    evidence.summary.startsWith("Sandbox prepared mtamburrano/proofboard-demo-fixture"),
  );
  assert.ok(preparation);
  assert.equal(preparation.result, "passed");
  assert.match(preparation.details, /"baseline_sha":"590aa8a6d72c580f61fc1b19d33e9876bc0feb9b"/);
  assert.match(LOCKED_REPOSITORY_PREPARATION_COMMAND, /git clone --quiet/);
  assert.match(LOCKED_REPOSITORY_PREPARATION_COMMAND, /git checkout --quiet --detach/);
  assert.doesNotMatch(LOCKED_REPOSITORY_PREPARATION_COMMAND, /git push|create_pull_request/);
});

test("locked repository preparation accepts root main and rejects dynamic child execs", async () => {
  const accepted = await lockedRepositoryRunnerFixture({
    preparation: { threadId: "main" },
  });
  const acceptedResult = await accepted.runner.runTurn(accepted.mission.id, "Implement the bounded change.", {
    workItemId: accepted.workItem.id,
    delegateToSubagent: true,
  });
  assert.ok(acceptedResult.implementationHandoff);
  assert.equal(accepted.turnRequests.length, 4);

  const child = await lockedRepositoryRunnerFixture({
    preparation: { threadId: "thread-subagent" },
  });
  await assert.rejects(
    child.runner.runTurn(child.mission.id, "Implement the bounded change.", {
      workItemId: child.workItem.id,
      delegateToSubagent: true,
    }),
    /not coordinator-owned/i,
  );
  assert.equal(child.turnRequests.length, 1);
  const state = await child.missions.getState();
  assert.equal(state.workItems.find((item) => item.id === child.workItem.id).status, "blocked");

  const childResponse = await lockedRepositoryRunnerFixture({
    preparation: { responseThreadId: "thread-subagent" },
  });
  await assert.rejects(
    childResponse.runner.runTurn(childResponse.mission.id, "Implement the bounded change.", {
      workItemId: childResponse.workItem.id,
      delegateToSubagent: true,
    }),
    /uncorrelated structured response|coordinator-owned/i,
  );
  assert.equal(childResponse.turnRequests.length, 1);
});

test("coordinator runtime restoration failure blocks delegated coding", async () => {
  const fixture = await lockedRepositoryRunnerFixture({ failRestore: true });

  await assert.rejects(
    fixture.runner.runTurn(fixture.mission.id, "Implement the bounded change.", {
      workItemId: fixture.workItem.id,
      delegateToSubagent: true,
    }),
    /could not restore the normal multi-iteration agent before delegated coding/i,
  );

  assert.equal(fixture.turnRequests.length, 1);
  const state = await fixture.missions.getState();
  assert.equal(state.workItems.find((item) => item.id === fixture.workItem.id).status, "blocked");
  assert.equal(
    state.evidence.some((evidence) =>
      evidence.result === "failed" &&
      evidence.summary === "Locked repository preparation failed; delegated workspace proof did not start.",
    ),
    true,
  );
});

test("real locked repository preparation handles a fresh clone and rejects a dirty worktree", async () => {
  const boundary = await createLocalRepositoryBoundary();
  try {
    const command = LOCKED_REPOSITORY_PREPARATION_COMMAND.replaceAll(
      PRIMARY_DELIVERY_FIXTURE.baselineSha,
      boundary.baselineSha,
    );
    const prepared = await execFileAsync("sh", ["-c", command], {
      cwd: boundary.workspacePath,
      env: { ...process.env, ...boundary.gitEnv },
      maxBuffer: 1024 * 1024,
    });

    assert.equal(
      prepared.stdout.trim(),
      `TRUEFORGE_REPOSITORY_READY repository=${PRIMARY_DELIVERY_FIXTURE.owner}/${PRIMARY_DELIVERY_FIXTURE.repository} sha=${boundary.baselineSha} root=${boundary.workspacePath}`,
    );
    assert.equal(prepared.stderr, "");
    assert.equal(
      (await runLocalGit(["rev-parse", "--verify", "HEAD"], boundary.workspacePath, boundary.gitEnv)).stdout.trim(),
      boundary.baselineSha,
    );
    assert.equal(
      (await runLocalGit(["status", "--porcelain=v1", "--untracked-files=all"], boundary.workspacePath, boundary.gitEnv)).stdout,
      "",
    );
    assert.equal(
      (await runLocalGit(["rev-parse", "--abbrev-ref", "HEAD"], boundary.workspacePath, boundary.gitEnv)).stdout.trim(),
      "HEAD",
    );
    assert.equal(
      (await runLocalGit(["config", "--get", "remote.origin.url"], boundary.workspacePath, boundary.gitEnv)).stdout.trim(),
      LOCKED_REPOSITORY_REMOTE_URL,
    );

    await writeFile(path.join(boundary.workspacePath, "README.md"), "pre-existing dirty content\n", "utf8");
    await assert.rejects(
      execFileAsync("sh", ["-c", command], {
        cwd: boundary.workspacePath,
        env: { ...process.env, ...boundary.gitEnv },
        maxBuffer: 1024 * 1024,
      }),
      (error) => {
        assert.equal(error.code, 86);
        assert.match(
          `${error.stdout ?? ""}${error.stderr ?? ""}`,
          /LOCKED_REPOSITORY_PREPARATION_FAILED existing Git worktree is not clean before checkout\./,
        );
        return true;
      },
    );
  } finally {
    await rm(boundary.root, { recursive: true, force: true });
  }
});

test("wrong locked repository identity or baseline blocks before delegation", async () => {
  for (const preparation of [
    {
      repository: "unexpected/repository",
      error: /expected mtamburrano\/proofboard-demo-fixture/i,
    },
    {
      sha: "b".repeat(40),
      error: /expected 590aa8a6d72c580f61fc1b19d33e9876bc0feb9b/i,
    },
    {
      exitCode: 86,
      result: "LOCKED_REPOSITORY_PREPARATION_FAILED could not check out the locked baseline.\n",
      error: /could not check out the locked baseline/i,
    },
  ]) {
    const fixture = await lockedRepositoryRunnerFixture({ preparation });
    await assert.rejects(
      fixture.runner.runTurn(fixture.mission.id, "Implement the bounded change.", {
        workItemId: fixture.workItem.id,
        delegateToSubagent: true,
      }),
      (error) => preparation.error.test(error.message),
    );
    assert.equal(fixture.turnRequests.length, 1);
    const state = await fixture.missions.getState();
    assert.equal(state.workItems.find((item) => item.id === fixture.workItem.id).status, "blocked");
    const failure = state.evidence.find((evidence) =>
      evidence.result === "failed" && evidence.summary.includes("Locked repository preparation failed"),
    );
    assert.ok(failure);
  }
});

test("delegated diffs outside the work-item scope block implementation", async () => {
  const fixture = await runnerFixture({
    allowedFiles: ["src/index.ts"],
    run: false,
  });

  await assert.rejects(
    fixture.runner.runTurn(fixture.mission.id, "Implement the bounded change.", {
      workItemId: fixture.workItem.id,
      delegateToSubagent: true,
    }),
    (error) => /outside the allowed scope|test\/index\.test\.js/i.test(error.message),
  );

  const state = await fixture.missions.getState();
  const failure = state.evidence.find((evidence) =>
    evidence.result === "failed" && evidence.summary.startsWith("Delegated implementation evidence failed:"),
  );
  assert.ok(failure);
  assert.match(failure.details, /test\/index\.test\.js/);
  assert.equal(state.workItems.find((item) => item.id === fixture.workItem.id).status, "blocked");
});

test("a path-filtered delegated diff cannot hide a forbidden changed file", async () => {
  const fixture = await runnerFixture({
    allowedFiles: ["src/index.ts"],
    diffCommand: "git diff -- src/index.ts",
    output: diffOutput(["src/index.ts"]),
    workspaceCurrentFiles: ["src/index.ts", "test/index.test.js"],
    workspaceCumulativeFiles: ["src/index.ts", "test/index.test.js"],
    run: false,
  });

  await assert.rejects(
    fixture.runner.runTurn(fixture.mission.id, "Implement the bounded change.", {
      workItemId: fixture.workItem.id,
      delegateToSubagent: true,
    }),
    (error) => /coordinator workspace delta|scoped content diff/i.test(error.message) && /test\/index\.test\.js/i.test(error.message),
  );

  const state = await fixture.missions.getState();
  const failure = state.evidence.find((evidence) =>
    evidence.result === "failed" && evidence.summary.startsWith("Delegated implementation evidence failed:"),
  );
  assert.ok(failure);
  assert.match(failure.details, /test\/index\.test\.js/);
  assert.equal(state.evidence.some((evidence) => evidence.kind === "diff_summary"), false);
  assert.equal(state.workItems.find((item) => item.id === fixture.workItem.id).status, "blocked");
});

test("a forbidden file committed before the child manifest is still captured by the coordinator", async () => {
  const fixture = await runnerFixture({
    allowedFiles: ["src/index.ts"],
    diffCommand: "git diff -- src/index.ts",
    output: diffOutput(["src/index.ts"]),
    manifestOutput: changedFilesManifestOutput(["src/index.ts"]),
    workspaceCurrentFiles: ["src/index.ts", "README.md"],
    workspaceCumulativeFiles: ["src/index.ts", "README.md"],
    extraToolCalls: [{
      id: "call-commit-forbidden",
      command: "git add -- README.md && git commit -m hidden-forbidden-change",
      output: "[fixture hidden-forbidden-change] committed README.md\n",
    }],
    run: false,
  });

  await assert.rejects(
    fixture.runner.runTurn(fixture.mission.id, "Implement the bounded change.", {
      workItemId: fixture.workItem.id,
      delegateToSubagent: true,
    }),
    (error) => /coordinator workspace delta|scoped content diff/i.test(error.message) &&
      /README\.md/.test(error.message),
  );

  const state = await fixture.missions.getState();
  const failure = state.evidence.find((evidence) =>
    evidence.result === "failed" && evidence.summary.startsWith("Delegated implementation evidence failed:"),
  );
  assert.ok(failure);
  assert.match(failure.details, /README\.md/);
  assert.equal(state.workItems.find((item) => item.id === fixture.workItem.id).status, "blocked");
});

async function runSequentialWorkspaceScenario({ forbiddenOnSecond = false } = {}) {
  const missions = new MissionService(new InMemoryMissionRepository(), fixedClock);
  let turnNumber = 0;
  const sourceFile = "src/index.ts";
  const testFile = "test/index.test.js";
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
        const itemNumber = Math.floor(current / 3) + 1;
        const startTreeRef = String.fromCharCode("a".charCodeAt(0) + itemNumber - 1).repeat(40);
        const missionStartTreeRef = WORKSPACE_START_TREE;
        if (current % 3 === 0) {
          return {
            async *withMetadata() {
              for (const event of workspaceSnapshotEvents(startTreeRef, `turn-sequential-start-${itemNumber}`)) {
                yield { data: event };
              }
            },
          };
        }
        if (current % 3 === 2) {
          const currentFiles = itemNumber === 1
            ? [sourceFile]
            : forbiddenOnSecond
            ? [testFile, "README.md"]
            : [testFile];
          const cumulativeFiles = itemNumber === 1
            ? [sourceFile]
            : [sourceFile, ...currentFiles];
          return {
            async *withMetadata() {
              for (const event of workspaceDeltaEvents({
                startTreeRef,
                missionStartTreeRef,
                endTreeRef: String.fromCharCode("a".charCodeAt(0) + itemNumber).repeat(40),
                currentFiles,
                cumulativeFiles,
                turnId: `turn-sequential-delta-${itemNumber}`,
              })) {
                yield { data: event };
              }
            },
          };
        }
        const file = itemNumber === 1 ? sourceFile : testFile;
        return {
          async *withMetadata() {
            for (const event of delegatedEvents(
              "npm run typecheck && npm test",
              diffOutput([file]),
              { includeManifest: false },
            )) {
              yield { data: event };
            }
          },
        };
      },
    },
  };
  const runner = new TrueForgeMissionRunner(missions, client, {
    model: "local/sequential-fixture",
    dynamicSubAgents: true,
  });
  const mission = await runner.createMission({
    id: forbiddenOnSecond ? "mission-sequential-forbidden" : "mission-sequential-safe",
    objective: "Prove sequential delegated workspace deltas.",
  });
  const sourceItem = await missions.addWorkItem(mission.id, {
    id: "work-sequential-source",
    title: "Implement the source change",
    purpose: "Change only the source file.",
    acceptanceCriteria: ["The source change is checked."],
    requiredChecks: ["typecheck", "test"],
    assignedRole: "implementer",
    allowedFiles: [sourceFile],
    status: "ready",
  });
  const testItem = await missions.addWorkItem(mission.id, {
    id: "work-sequential-test",
    title: "Implement the focused test change",
    purpose: "Change only the focused test file.",
    acceptanceCriteria: ["The focused test change is checked."],
    requiredChecks: ["typecheck", "test"],
    assignedRole: "implementer",
    allowedFiles: [testFile],
    status: "ready",
  });
  const completeItem = async (workItem) => {
    await missions.transitionWorkItem(mission.id, workItem.id, "in_progress");
    const execution = await runner.runTurn(mission.id, "Implement this sequential bounded item.", {
      workItemId: workItem.id,
      delegateToSubagent: true,
    });
    const draft = execution.implementationHandoff;
    assert.ok(draft);
    await missions.recordHandoff(mission.id, {
      workItemId: workItem.id,
      result: "done",
      summary: "The sequential fixture item returned anchored proof.",
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
    await missions.transitionWorkItem(mission.id, workItem.id, "ready_for_review");
    await missions.reviewWorkItem(mission.id, {
      workItemId: workItem.id,
      outcome: "accepted",
      reviewer: "independent-sequential-verifier",
      summary: "The sequential fixture item was independently verified.",
      finding: "No blocking findings.",
    });
    return execution;
  };
  const first = await completeItem(sourceItem);
  let secondError;
  try {
    await completeItem(testItem);
  } catch (error) {
    secondError = error;
  }
  return { missions, mission, sourceItem, testItem, first, secondError };
}

test("sequential source then test items ignore the first accepted delta in the reused sandbox", async () => {
  const result = await runSequentialWorkspaceScenario();
  assert.equal(result.secondError, undefined);
  const state = await result.missions.getState();
  assert.deepEqual(state.workItems.map((item) => item.status), ["complete", "complete"]);
  const secondProof = state.evidence.find((evidence) =>
    evidence.workItemId === result.testItem.id && evidence.kind === "file_change",
  );
  assert.ok(secondProof);
  const details = JSON.parse(secondProof.details);
  assert.deepEqual(details.current_changed_files, ["test/index.test.js"]);
  assert.deepEqual(details.cumulative_changed_files, ["src/index.ts", "test/index.test.js"]);
});

test("a forbidden change introduced by the second item fails its anchored delta", async () => {
  const result = await runSequentialWorkspaceScenario({ forbiddenOnSecond: true });
  assert.ok(result.secondError);
  assert.match(result.secondError.message, /README\.md|coordinator workspace delta|scoped content diff/i);
  const state = await result.missions.getState();
  assert.equal(state.workItems.find((item) => item.id === result.sourceItem.id).status, "complete");
  assert.equal(state.workItems.find((item) => item.id === result.testItem.id).status, "blocked");
  assert.equal(state.handoffs.filter((handoff) => handoff.workItemId === result.testItem.id).length, 0);
  const failure = state.evidence.find((evidence) =>
    evidence.workItemId === result.testItem.id &&
    evidence.result === "failed" &&
    evidence.summary.startsWith("Delegated implementation evidence failed:"),
  );
  assert.ok(failure);
  assert.match(failure.details, /README\.md/);
});

test("rename evidence uses the new path consistently", async () => {
  const output = [
    "diff --git a/src/old-name.ts b/src/new-name.ts",
    "similarity index 100%",
    "rename from src/old-name.ts",
    "rename to src/new-name.ts",
  ].join("\n");
  const { missions, mission, workItem, result } = await runnerFixture({
    output,
    allowedFiles: ["src/new-name.ts"],
    workspaceCurrentFiles: ["src/new-name.ts"],
    workspaceCumulativeFiles: ["src/new-name.ts"],
  });

  assert.deepEqual(result.implementationHandoff.filesChanged, ["src/new-name.ts"]);
  const handoff = await missions.recordHandoff(mission.id, {
    workItemId: workItem.id,
    result: "done",
    summary: "The delegated rename is ready for review.",
    filesChanged: result.implementationHandoff.filesChanged,
    testsRun: ["npm run typecheck && npm test"],
    diffSummary: result.implementationHandoff.diffSummary,
    checks: result.implementationHandoff.checks,
    evidenceIds: result.implementationHandoff.evidenceIds,
    executionOrigin: result.implementationHandoff.executionOrigin,
  });
  await missions.transitionWorkItem(mission.id, workItem.id, "ready_for_review");
  const context = await missions.getReviewContext(mission.id, workItem.id);

  assert.equal(handoff.filesChanged[0], "src/new-name.ts");
  assert.deepEqual(context.actualFilesChanged, ["src/new-name.ts"]);
});

test("truncated diff evidence retains the complete changed-file manifest", async () => {
  const output = [
    "diff --git a/src/index.ts b/src/index.ts",
    "@@ -1 +1,2 @@",
    "+export const next = 2;",
    `+${"x".repeat(4_500)}`,
    "diff --git a/test/index.test.js b/test/index.test.js",
    "@@ -1 +1,2 @@",
    "+test(\"next\", () => {});",
  ].join("\n");
  const { missions, mission, workItem, result } = await runnerFixture({ output });
  const state = await missions.getState();
  const diffEvidence = state.evidence.find((evidence) => evidence.kind === "diff_summary");
  const details = JSON.parse(diffEvidence.details);

  assert.deepEqual(result.implementationHandoff.filesChanged, ["src/index.ts", "test/index.test.js"]);
  assert.deepEqual(details.changed_files, ["src/index.ts", "test/index.test.js"]);
  assert.equal(details.output_truncated, true);
  assert.equal(details.output.length <= 4_000, true);

  await missions.recordHandoff(mission.id, {
    workItemId: workItem.id,
    result: "done",
    summary: "The delegated implementation is ready for review.",
    filesChanged: result.implementationHandoff.filesChanged,
    testsRun: ["npm run typecheck && npm test"],
    diffSummary: result.implementationHandoff.diffSummary,
    checks: result.implementationHandoff.checks,
    evidenceIds: result.implementationHandoff.evidenceIds,
    executionOrigin: result.implementationHandoff.executionOrigin,
  });
  await missions.transitionWorkItem(mission.id, workItem.id, "ready_for_review");
  const context = await missions.getReviewContext(mission.id, workItem.id);
  assert.deepEqual(context.actualFilesChanged, ["src/index.ts", "test/index.test.js"]);
});

test("planner fails closed when repository scope exceeds the graph bound", () => {
  const planner = new RepositoryWorkGraphPlanner();
  const files = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [
    `src/file-${index}.ts`,
    "@@ verified source",
  ]));

  assert.throws(
    () => planner.plan({
      mission: {
        id: "mission-scope-bound",
        objective: "Update the verified source files.",
        status: "draft",
        createdAt: fixedClock().toISOString(),
        updatedAt: fixedClock().toISOString(),
      },
      inspection: {
        resourceUri: "repo://owner/repo/commit",
        contentHash: "sha256:scope",
        patches: files,
      },
    }),
    /at most 6 implementation scopes without dropping repository scope/,
  );
});

test("legacy primary missions are upgraded without losing their history", async () => {
  const legacyState = legacyPrimaryState();
  const history = legacyState.evidence[0];
  const missions = new MissionService(new InMemoryMissionRepository(legacyState), fixedClock);
  const runner = new LegacyPrimaryRunner(missions);
  const app = createMissionHttpApp({ missions, runner });

  const response = await app.request("/api/mission", { method: "POST" });
  assert.equal(response.status, 201);
  const state = await missions.getState();
  const implementer = state.workItems.find((item) => item.id === "primary-implement");
  assert.equal(state.evidence.some((evidence) => evidence.id === history.id), true);
  assert.equal(implementer.acceptanceCriteria.length > 0, true);
  assert.deepEqual(implementer.requiredChecks, ["typecheck", "test"]);

  const run = await app.request("/api/mission/run", { method: "POST" });
  assert.equal(run.status, 200);
  const afterRun = await missions.getState();
  assert.equal(afterRun.missions[0].status, "awaiting_approval");
  assert.equal(afterRun.workItems.filter((item) => item.status === "complete").length, 3);
  assert.equal(afterRun.evidence.some((evidence) => evidence.id === history.id), true);
});

test("production app wires bounded contract review and fails closed on invalid results", async () => {
  const observedContexts = [];
  const cases = [
    {
      label: "valid semantic review",
      options: {
        semanticReview(context) {
          observedContexts.push(context);
          return {
            outcome: "accepted",
            reviewer: "local-contract-reviewer",
            summary: "The bounded implementation satisfies the contract.",
            finding: "No blocking findings.",
          };
        },
      },
      status: 200,
      outcome: "accepted",
    },
    {
      label: "unavailable semantic review",
      options: { exposeSemanticReview: false },
      status: 502,
      outcome: "changes_requested",
    },
    {
      label: "malformed semantic review",
      options: { semanticReview: null },
      status: 502,
      outcome: "changes_requested",
    },
    {
      label: "invalid semantic review",
      options: {
        semanticReview: {
          outcome: "accepted",
          reviewer: "",
          summary: "The result is malformed.",
          finding: "The reviewer identity is missing.",
        },
      },
      status: 502,
      outcome: "changes_requested",
    },
  ];

  for (const reviewCase of cases) {
    const missions = new MissionService(
      new InMemoryMissionRepository(legacyPrimaryState()),
      fixedClock,
    );
    const runner = new LegacyPrimaryRunner(missions, reviewCase.options);
    const app = createMissionHttpApp({ missions, runner });

    assert.equal(
      (await app.request("/api/mission", { method: "POST" })).status,
      201,
      reviewCase.label,
    );
    const response = await app.request("/api/mission/run", { method: "POST" });
    assert.equal(response.status, reviewCase.status, reviewCase.label);

    const state = await missions.getState();
    const review = state.reviews.at(-1);
    assert.equal(review?.outcome, reviewCase.outcome, reviewCase.label);
    if (reviewCase.status === 200) {
      const context = observedContexts.at(-1);
      assert.ok(context, reviewCase.label);
      assert.deepEqual(context.actualFilesChanged, ["src/index.ts", "test/index.test.js"]);
      assert.match(context.actualDiff, /getNextDeliveryStage/);
      assert.equal(context.workItem.purpose.length > 0, true);
      assert.equal(context.workItem.acceptanceCriteria.length > 0, true);
      assert.deepEqual(context.checks.map((check) => check.result), ["passed", "passed"]);
    }
  }
});

class LegacyPrimaryRunner {
  constructor(missions, {
    semanticReview = () => ({
      outcome: "accepted",
      reviewer: "legacy-contract-verifier",
      summary: "The migrated primary contract was independently evaluated.",
      finding: "No blocking findings.",
    }),
    exposeSemanticReview = true,
  } = {}) {
    this.missions = missions;
    this.turn = 0;
    this.semanticReview = semanticReview;
    if (!exposeSemanticReview) {
      this.reviewContract = undefined;
    }
  }

  async reviewContract(context) {
    return typeof this.semanticReview === "function"
      ? this.semanticReview(context)
      : this.semanticReview;
  }

  async createMission(input) {
    return this.missions.createMission({ ...input, trueforgeSessionId: "legacy-session" });
  }

  async inspectRepository(input) {
    const resourceUri = `repo://${PRIMARY_DELIVERY_FIXTURE.owner}/${PRIMARY_DELIVERY_FIXTURE.repository}/sha/${PRIMARY_DELIVERY_FIXTURE.baselineSha}`;
    const evidence = await this.missions.addEvidence(input.missionId, {
      id: "legacy-inspection-proof",
      workItemId: input.workItemId,
      kind: "tool_result",
      result: "passed",
      source: "mcp",
      summary: "The pinned repository was inspected.",
      details: JSON.stringify({
        server: "github",
        tool: "get_commit",
        provenance_kind: "baseline",
        arguments: {
          owner: PRIMARY_DELIVERY_FIXTURE.owner,
          repo: PRIMARY_DELIVERY_FIXTURE.repository,
          sha: PRIMARY_DELIVERY_FIXTURE.baselineRef,
          detail: "full_patch",
        },
        repository_owner: PRIMARY_DELIVERY_FIXTURE.owner,
        repository_name: PRIMARY_DELIVERY_FIXTURE.repository,
        requested_ref: PRIMARY_DELIVERY_FIXTURE.baselineRef,
        uri: resourceUri,
        commit_sha: PRIMARY_DELIVERY_FIXTURE.baselineSha,
      }),
    });
    return {
      evidenceId: evidence.id,
      resourceUri,
      contentHash: "legacy-content-hash",
      commitSha: PRIMARY_DELIVERY_FIXTURE.baselineSha,
      patches: {
        "src/index.ts": "@@ verified source",
        "test/index.test.js": "@@ verified tests",
      },
    };
  }

  async inspectDeliveryHead(input) {
    const commitSha = "8bb22a62b3714f699204cb0d5c440fcb7f0a09e1";
    const resourceUri = `repo://${input.target.owner}/${input.target.repo}/sha/${commitSha}`;
    const evidence = await this.missions.addEvidence(input.missionId, {
      kind: "tool_result",
      result: "passed",
      source: "mcp",
      summary: "The changed fixture delivery head was inspected.",
      details: JSON.stringify({
        server: "github",
        tool: "get_commit",
        provenance_kind: "delivery_head",
        arguments: {
          owner: input.target.owner,
          repo: input.target.repo,
          sha: input.target.head,
          detail: "full_patch",
        },
        repository_owner: input.target.owner,
        repository_name: input.target.repo,
        requested_ref: input.target.head,
        baseline_sha: PRIMARY_DELIVERY_FIXTURE.baselineSha,
        uri: resourceUri,
        commit_sha: commitSha,
        patches: PRIMARY_VERIFIED_DELIVERY_PATCHES,
      }),
    });
    return {
      evidenceId: evidence.id,
      resourceUri,
      contentHash: "legacy-delivery-head-content-hash",
      commitSha,
      patches: PRIMARY_VERIFIED_DELIVERY_PATCHES,
    };
  }

  async runTurn(missionId, _instruction, options) {
    this.turn += 1;
    const turnId = `legacy-turn-${this.turn}`;
    const threadId = `legacy-thread-${this.turn}`;
    const treeRef = "a".repeat(40);
    const endTreeRef = "b".repeat(40);
    await this.missions.attachTrueforgeTurn(missionId, turnId);
    await this.missions.attachTrueforgeWorkspaceBaseline(missionId, treeRef);
    await this.missions.startWorkItemDelegation(missionId, options.workItemId, {
      owner: "legacy-implementer",
      threadId,
      turnId,
      startTreeRef: treeRef,
      missionStartTreeRef: treeRef,
    });
    await this.missions.addEvidence(missionId, {
      workItemId: options.workItemId,
      kind: "tool_result",
      result: "passed",
      source: "trueforge",
      summary: "TrueForge turn finished with status done.",
    });
    const origin = { kind: "trueforge", sessionId: "legacy-session", turnId, threadId };
    const typecheck = await this.missions.addEvidence(missionId, {
      workItemId: options.workItemId,
      kind: "typecheck_result",
      result: "passed",
      source: "trueforge",
      summary: "The delegated typecheck passed.",
      executionOrigin: { ...origin, toolCallId: `legacy-typecheck-${this.turn}` },
    });
    const tests = await this.missions.addEvidence(missionId, {
      workItemId: options.workItemId,
      kind: "test_result",
      result: "passed",
      source: "trueforge",
      summary: "The delegated tests passed.",
      executionOrigin: { ...origin, toolCallId: `legacy-test-${this.turn}` },
    });
    const diff = await this.missions.addEvidence(missionId, {
      workItemId: options.workItemId,
      kind: "diff_summary",
      result: "passed",
      source: "trueforge",
      summary: "The delegated content diff was captured.",
      details: JSON.stringify({ command: "git diff", output: [
        "diff --git a/src/index.ts b/src/index.ts",
        "@@ -1 +1,2 @@",
        "+export function getNextDeliveryStage(stage) { return stage === \"Plan\" ? \"Execute\" : null; }",
        "diff --git a/test/index.test.js b/test/index.test.js",
        "@@ -1 +1,2 @@",
        "+assert.equal(getNextDeliveryStage(\"Plan\"), \"Execute\");",
      ].join("\n") }),
      executionOrigin: { ...origin, toolCallId: `legacy-diff-${this.turn}` },
    });
    const manifest = await this.missions.addEvidence(missionId, {
      workItemId: options.workItemId,
      kind: "file_change",
      result: "passed",
      source: "trueforge",
      summary: "The delegated complete changed-file manifest was captured.",
      details: workspaceDeltaEvidenceDetails({
        startTreeRef: treeRef,
        missionStartTreeRef: treeRef,
        endTreeRef,
      }),
      executionOrigin: {
        kind: "trueforge",
        sessionId: "legacy-session",
        turnId: `legacy-proof-turn-${this.turn}`,
        toolCallId: `legacy-manifest-${this.turn}`,
      },
    });
    await this.missions.completeWorkItemDelegation(missionId, options.workItemId, {
      threadId,
      turnId,
    });
    return {
      sessionId: "legacy-session",
      turnId,
      events: [],
      mission: await this.missions.getMission(missionId),
      implementationHandoff: {
        filesChanged: ["src/index.ts", "test/index.test.js"],
        diffSummary: "The source and focused test files changed.",
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
        decisions: [],
        openQuestions: [],
        evidenceIds: [typecheck.id, tests.id, manifest.id, diff.id],
        executionOrigin: origin,
      },
    };
  }

  async runSandboxVerification(input) {
    const evidence = await this.missions.addEvidence(input.missionId, {
      workItemId: input.workItemId,
      kind: "test_result",
      result: "passed",
      source: "sandbox",
      summary: "The sandbox verification passed.",
    });
    return { evidenceId: evidence.id };
  }

  async requestPullRequestApproval(missionId, target) {
    return {
      sessionId: "legacy-session",
      turnId: "legacy-delivery-approval-turn",
      threadId: "legacy-delivery-thread",
      toolCallId: "legacy-create-pr-call",
      serverName: "github",
      toolName: "create_pull_request",
      target: { ...target },
    };
  }

  async resolvePullRequestApproval(_missionId, _pending, decision) {
    return decision === "approved"
      ? {
          number: 1,
          url: "https://github.com/mtamburrano/proofboard-demo-fixture/pull/1",
          headSha: _pending.target.headSha,
          sessionId: "legacy-session",
          turnId: "legacy-delivery-result-turn",
          threadId: "legacy-delivery-thread",
          toolCallId: "legacy-create-pr-call",
        }
      : null;
  }
}
