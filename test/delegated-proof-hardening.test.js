import assert from "node:assert/strict";
import test from "node:test";

import {
  DeterministicImplementationVerifier,
  InMemoryMissionRepository,
  MissionService,
  PRIMARY_MISSION_ID,
  PRIMARY_MISSION_OBJECTIVE,
  PRIMARY_REPOSITORY,
  RepositoryWorkGraphPlanner,
  TrueForgeMissionRunner,
  createMissionHttpApp,
} from "../dist/index.js";

const ORIGIN = {
  kind: "trueforge",
  sessionId: "session-hardening",
  turnId: "turn-hardening",
  threadId: "thread-hardening",
};

function fixedClock() {
  return new Date("2026-08-27T15:00:00.000Z");
}

function diffOutput(files = ["src/index.ts", "test/index.test.js"]) {
  return files.map((file) => [
    `diff --git a/${file} b/${file}`,
    "@@ -1 +1,2 @@",
    `+export const changedFile = \"${file}\";`,
  ].join("\n")).join("\n");
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

function delegatedEvents(command, output) {
  const response = (id, callId, result) => ({
    type: "tool.response",
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
        { id: "call-diff", function: { name: "exec", arguments: JSON.stringify({ command: "git diff" }) } },
      ],
    },
    response("event-check-response", "call-check", "checks complete\n"),
    response("event-diff-response", "call-diff", output),
    {
      type: "thread.done",
      id: "event-thread-done",
      threadId: ORIGIN.threadId,
      state: {
        status: "done",
        output: { content: JSON.stringify({ decisions: [], openQuestions: [] }) },
      },
    },
    {
      type: "turn.done",
      id: "event-turn-done",
      state: { status: "done", requiredActions: [] },
    },
  ];
}

async function runnerFixture({ command = "npm run typecheck && npm test", output = diffOutput() } = {}) {
  const missions = new MissionService(new InMemoryMissionRepository(), fixedClock);
  const client = {
    sessions: {
      async create() {
        return { data: { id: ORIGIN.sessionId } };
      },
      async get(sessionId) {
        return { data: { id: sessionId } };
      },
      async createTurnStream() {
        return {
          async *withMetadata() {
            for (const event of delegatedEvents(command, output)) {
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
    status: "ready",
  });
  await missions.transitionWorkItem(mission.id, workItem.id, "in_progress");
  const result = await runner.runTurn(mission.id, "Implement the bounded change.", {
    workItemId: workItem.id,
    delegateToSubagent: true,
  });
  return { missions, mission, workItem, result };
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
  for (const command of ["echo npm test", "npm test || true"]) {
    const { result } = await runnerFixture({ command });
    assert.deepEqual(
      result.implementationHandoff.checks.map((check) => [check.name, check.result]),
      [["typecheck", "not_run"], ["test", "not_run"]],
      command,
    );
  }
});

test("rename evidence uses the new path consistently", async () => {
  const output = [
    "diff --git a/src/old-name.ts b/src/new-name.ts",
    "similarity index 100%",
    "rename from src/old-name.ts",
    "rename to src/new-name.ts",
  ].join("\n");
  const { missions, mission, workItem, result } = await runnerFixture({ output });

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
  const timestamp = fixedClock().toISOString();
  const history = {
    id: "legacy-history",
    missionId: PRIMARY_MISSION_ID,
    kind: "tool_result",
    result: "informational",
    source: "system",
    summary: "Legacy mission history remains durable.",
    createdAt: timestamp,
  };
  const legacyState = {
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
    evidence: [history],
    handoffs: [],
    reviews: [],
    approvals: [],
    deliveries: [],
  };
  const missions = new MissionService(new InMemoryMissionRepository(legacyState), fixedClock);
  const runner = new LegacyPrimaryRunner(missions);
  const app = createMissionHttpApp({
    missions,
    runner,
    semanticVerifier: {
      reviewContract() {
        return {
          outcome: "accepted",
          reviewer: "legacy-contract-verifier",
          summary: "The migrated primary contract was independently evaluated.",
          finding: "No blocking findings.",
        };
      },
    },
  });

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
  assert.equal(afterRun.missions[0].status, "verifying");
  assert.equal(afterRun.workItems.filter((item) => item.status === "complete").length, 3);
  assert.equal(afterRun.evidence.some((evidence) => evidence.id === history.id), true);
});

class LegacyPrimaryRunner {
  constructor(missions) {
    this.missions = missions;
    this.turn = 0;
  }

  async createMission(input) {
    return this.missions.createMission({ ...input, trueforgeSessionId: "legacy-session" });
  }

  async inspectRepository(input) {
    const evidence = await this.missions.addEvidence(input.missionId, {
      id: "legacy-inspection-proof",
      workItemId: input.workItemId,
      kind: "tool_result",
      result: "passed",
      source: "mcp",
      summary: "The pinned repository was inspected.",
    });
    return {
      evidenceId: evidence.id,
      resourceUri: "repo://mtamburrano/trueforge-proofboard/590aa8a6d72c580f61fc1b19d33e9876bc0feb9b/commit",
      contentHash: "legacy-content-hash",
      commitSha: "590aa8a6d72c580f61fc1b19d33e9876bc0feb9b",
      patches: {
        "src/index.ts": "@@ verified source",
        "test/index.test.js": "@@ verified tests",
      },
    };
  }

  async runTurn(missionId, _instruction, options) {
    this.turn += 1;
    const turnId = `legacy-turn-${this.turn}`;
    const threadId = `legacy-thread-${this.turn}`;
    await this.missions.attachTrueforgeTurn(missionId, turnId);
    await this.missions.startWorkItemDelegation(missionId, options.workItemId, {
      owner: "legacy-implementer",
      threadId,
      turnId,
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
        evidenceIds: [typecheck.id, tests.id, diff.id],
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
}
