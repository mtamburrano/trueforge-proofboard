import { readFile } from "node:fs/promises";

import {
  Evidence,
  Handoff,
  Mission,
  MissionDomainError,
  MissionService,
  MissionState,
  Review,
  ReviewContext,
  ReviewOutcome,
  WorkGraphDefinition,
  WorkItem,
  MAX_WORK_ITEM_ACCEPTANCE_CRITERIA,
  PRIMARY_CONSEQUENTIAL_ACTION,
  validateWorkGraph,
} from "../domain.js";
import {
  buildPreflightWorkGraph,
  RepositoryInspectionInput,
  RepositoryWorkGraphPlanner,
  SandboxVerificationInput,
  TrueForgeIntegrationError,
  TrueForgeTurnResult,
  VerifiedRepositoryInspection,
  WorkGraphPlanner,
} from "../trueforge.js";
import { parseContentDiffEvidence } from "../diff.js";

export const PRIMARY_MISSION_ID = "primary-mission";
export const PRIMARY_MISSION_OBJECTIVE =
  "Add a backwards-compatible getNextDeliveryStage(stage) helper to src/index.ts. It returns the next stage for Plan, Execute, and Prove, returns null for terminal Approve, preserves the existing identity exports, and includes focused tests for every transition.";
export const PRIMARY_REPOSITORY = {
  owner: "mtamburrano",
  name: "trueforge-proofboard",
  ref: "590aa8a6d72c580f61fc1b19d33e9876bc0feb9b",
} as const;

export const PRIMARY_MISSION_VERIFICATION_SCRIPT = [
  'import assert from "node:assert/strict";',
  'import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";',
  'import { spawnSync } from "node:child_process";',
  'import os from "node:os";',
  'import path from "node:path";',
  'const source = await readFile("src/index.ts", "utf8");',
  'assert.match(source, /(?:export\\s+function|export\\s+const)\\s+getNextDeliveryStage/, "mission stage helper is missing");',
  'const transitions = [["Plan", "Execute"], ["Execute", "Prove"], ["Prove", "Approve"], ["Approve", null]];',
  'const { getNextDeliveryStage } = await import("./dist/index.js");',
  'assert.equal(typeof getNextDeliveryStage, "function", "mission stage helper is not callable");',
  'for (const [stage, next] of transitions) assert.equal(getNextDeliveryStage(stage), next);',
  'const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-mission-verification-"));',
  'const loaderPath = path.join(directory, "loader.mjs");',
  'const logPath = path.join(directory, "calls.jsonl");',
  'const loaderSource = String.raw`',
  'import { pathToFileURL } from "node:url";',
  'const targetUrl = pathToFileURL(process.cwd() + "/dist/index.js").href;',
  'export async function load(url, context, defaultLoad) {',
  '  const loaded = await defaultLoad(url, context);',
  '  if (url !== targetUrl) return loaded;',
  '  let source = String(loaded.source);',
  '  if (source.includes("__trueforgeVerificationWrapper")) return { ...loaded, source, shortCircuit: true };',
  '  if (source.includes("export function getNextDeliveryStage")) {',
  '    source = source.replace("export function getNextDeliveryStage", "function __verifiedGetNextDeliveryStage");',
  '  } else if (source.includes("export const getNextDeliveryStage")) {',
  '    source = source.replace("export const getNextDeliveryStage", "const __verifiedGetNextDeliveryStage");',
  '  } else {',
  '    throw new Error("mission stage helper is missing");',
  '  }',
  '  const newline = String.fromCharCode(10);',
  '  source = "import { appendFileSync as __trueforgeAppendCall } from " + String.fromCharCode(34) + "node:fs" + String.fromCharCode(34) + ";" + newline + source;',
  '  source += newline + "const __trueforgeVerificationWrapper = true;" + newline +',
  '    "const __trueforgeMutationStage = process.env.MISSION_VERIFICATION_MUTATION_STAGE;" + newline +',
  '    "const __trueforgeMutationResults = { Plan: null, Execute: null, Prove: null, Approve: " + String.fromCharCode(34) + "Plan" + String.fromCharCode(34) + " };" + newline +',
  '    "export function getNextDeliveryStage(stage) {" + newline +',
  '    "  const result = __verifiedGetNextDeliveryStage(stage);" + newline +',
  '    "  const returnedResult = __trueforgeMutationStage === stage ? __trueforgeMutationResults[stage] : result;" + newline +',
  '    "  __trueforgeAppendCall(process.env.MISSION_VERIFICATION_LOG, JSON.stringify({ stage, result: returnedResult, mutated: __trueforgeMutationStage === stage }) + String.fromCharCode(10));" + newline +',
  '    "  return returnedResult;" + newline +',
  '    "}" + newline;',
  '  return { ...loaded, source, shortCircuit: true };',
  '}',
  '`;',
  'try {',
  'const testArguments = ["--loader", loaderPath, "--test", "test/index.test.js"];',
  'const baseEnvironment = { ...process.env, MISSION_VERIFICATION_LOG: logPath };',
  'delete baseEnvironment.MISSION_VERIFICATION_MUTATION_STAGE;',
  'const runFocusedTests = (mutationStage, mutationLogPath) => spawnSync(process.execPath, testArguments, {',
  '  cwd: process.cwd(),',
  '  encoding: "utf8",',
  '  env: { ...baseEnvironment, MISSION_VERIFICATION_LOG: mutationLogPath, ...(mutationStage ? { MISSION_VERIFICATION_MUTATION_STAGE: mutationStage } : {}) },',
  '});',
  'const readCalls = async (logFile) => (await readFile(logFile, "utf8").catch(() => "")).trim().split(String.fromCharCode(10)).filter(Boolean).map((line) => JSON.parse(line));',
  'await writeFile(loaderPath, loaderSource, "utf8");',
  'const testRun = runFocusedTests(null, logPath);',
  'if (testRun.stdout) process.stdout.write(testRun.stdout);',
  'if (testRun.status !== 0) {',
  '  if (testRun.stderr) process.stderr.write(testRun.stderr);',
  '  throw new Error("focused transition tests failed");',
  '}',
  'const observed = new Set((await readCalls(logPath)).map(({ stage, result }) => JSON.stringify([stage, result])));',
  'for (const transition of transitions) {',
  '  assert.ok(observed.has(JSON.stringify(transition)), "transition " + transition[0] + " -> " + transition[1] + " was not executed by the focused test");',
  '  const mutationLogPath = path.join(directory, "mutation-" + transition[0] + ".jsonl");',
  '  const mutationRun = runFocusedTests(transition[0], mutationLogPath);',
  '  const mutatedStages = new Set((await readCalls(mutationLogPath)).filter(({ mutated }) => mutated).map(({ stage }) => stage));',
  '  assert.ok(mutatedStages.has(transition[0]), "transition " + transition[0] + " was not exercised during mutation verification");',
  '  assert.notEqual(mutationRun.status, 0, "focused test did not enforce transition " + transition[0] + " -> " + transition[1]);',
  '}',
  '  console.log("Mission transition verification passed.");',
  '} finally {',
  '  await rm(directory, { recursive: true, force: true });',
  '}',
].join("\n");

export const PRIMARY_VERIFICATION_COMMAND =
  `npm test && node --input-type=module -e '${PRIMARY_MISSION_VERIFICATION_SCRIPT}'`;

export interface MissionRunner {
  createMission(input: {
    id: string;
    objective: string;
    repository: { owner: string; name: string; ref: string };
  }): Promise<Mission>;
  inspectRepository(input: RepositoryInspectionInput): Promise<unknown>;
  runTurn(
    missionId: string,
    instruction: string,
    options: { workItemId: string; delegateToSubagent?: boolean },
  ): Promise<TrueForgeTurnResult>;
  runSandboxVerification(input: SandboxVerificationInput): Promise<unknown>;
  reviewContract?(context: ReviewContext): Promise<ImplementationReviewDecision>;
}

export interface MissionHttpOptions {
  missions: MissionService;
  runner: MissionRunner;
  planner?: WorkGraphPlanner;
  verifier?: ImplementationVerifier;
  semanticVerifier?: SemanticContractVerifier;
}

export interface ImplementationReviewDecision {
  outcome: ReviewOutcome;
  reviewer: string;
  summary: string;
  finding: string;
}

export interface SemanticContractVerifier {
  reviewContract(
    context: ReviewContext,
  ): ImplementationReviewDecision | Promise<ImplementationReviewDecision>;
}

export interface ImplementationVerifier {
  review(
    context: ReviewContext,
  ): ImplementationReviewDecision | Promise<ImplementationReviewDecision>;
}

export class DeterministicImplementationVerifier implements ImplementationVerifier {
  constructor(private readonly semanticVerifier?: SemanticContractVerifier) {}

  review(context: ReviewContext): ImplementationReviewDecision | Promise<ImplementationReviewDecision> {
    const missingRequiredCheck = context.checks.find((check) =>
      check.required && check.result !== "passed"
    );
    if (missingRequiredCheck !== undefined) {
      return {
        outcome: "blocked",
        reviewer: "independent-verifier",
        summary: "Independent verification found incomplete required proof.",
        finding: `Required check ${missingRequiredCheck.name} is ${missingRequiredCheck.result}.`,
      };
    }
    if (!context.evidence.some(isContentBearingReviewEvidence)) {
      return {
        outcome: "changes_requested",
        reviewer: "independent-verifier",
        summary: "Independent verification could not inspect the changed content.",
        finding: "Provide a bounded content diff; status, file names, or diff statistics are insufficient.",
      };
    }
    const parsedDiffs = context.evidence
      .map((evidence) => parseContentDiffEvidence(evidence))
      .filter((diff): diff is NonNullable<typeof diff> => diff !== null);
    if (parsedDiffs.length === 0) {
      return {
        outcome: "changes_requested",
        reviewer: "independent-verifier",
        summary: "Independent verification could not inspect the changed content.",
        finding: "Provide a bounded content diff; status, file names, or diff statistics are insufficient.",
      };
    }
    const claimedFiles = [...new Set(context.filesChanged.map(normalizeChangedFile))].sort();
    const actualFiles = [...new Set(parsedDiffs.flatMap((diff) =>
      diff.filesChanged.map(normalizeChangedFile),
    ))].sort();
    if (JSON.stringify(claimedFiles) !== JSON.stringify(actualFiles)) {
      return {
        outcome: "changes_requested",
        reviewer: "independent-verifier",
        summary: "Independent verification found contradictory changed-file proof.",
        finding: `Handoff files (${claimedFiles.join(", ")}) do not match the content diff (${actualFiles.join(", ")}).`,
      };
    }
    if (context.handoff.openQuestions.length > 0) {
      return {
        outcome: "blocked",
        reviewer: "independent-verifier",
        summary: "Independent verification found unresolved implementation uncertainty.",
        finding: context.handoff.openQuestions.join(" "),
      };
    }
    if (this.semanticVerifier === undefined) {
      return {
        outcome: "changes_requested",
        reviewer: "independent-verifier",
        summary: "Independent verification could not establish the work-item contract.",
        finding: "No contract-aware verifier was supplied; structural diff evidence cannot prove that the changed state satisfies the work item's purpose and acceptance criteria.",
      };
    }
    try {
      const review = this.semanticVerifier.reviewContract(context);
      if (isPromiseLike(review)) {
        return Promise.resolve(review)
          .then(normalizeSemanticReviewDecision)
          .catch(() => unavailableSemanticReviewDecision());
      }
      return normalizeSemanticReviewDecision(review);
    } catch {
      return unavailableSemanticReviewDecision();
    }
  }
}

export interface EvidenceView {
  id: string;
  source: "mcp" | "sandbox";
  result: Evidence["result"];
  kind: Evidence["kind"];
  summary: string;
  createdAt: string;
  workItemTitle?: string;
  metadata: Record<string, string | number>;
  executionOrigin?: Evidence["executionOrigin"];
}

export interface HandoffView {
  id: string;
  workItemId: string;
  result: Handoff["result"];
  summary: string;
  filesChanged: string[];
  testsRun: string[];
  decisions: string[];
  openQuestions: string[];
  memoryImpact: Handoff["memoryImpact"];
  createdAt: string;
  diffSummary?: string;
  checks?: Handoff["checks"];
  evidenceIds?: string[];
  executionOrigin?: Handoff["executionOrigin"];
}

export interface ReviewView {
  id: string;
  workItemId: string;
  outcome: Review["outcome"];
  reviewer: string;
  summary: string;
  finding: string;
  handoffId: string;
  filesChanged: string[];
  diffSummary: string;
  checks: Review["checks"];
  evidenceIds: string[];
  findingEvidenceId: string;
  createdAt: string;
}

export interface ActivityView {
  id: string;
  actor: string;
  result: Evidence["result"] | "active";
  summary: string;
  createdAt: string;
  category: "session" | "runtime" | "repository" | "sandbox" | "narration";
}

export interface MissionView {
  revision: number;
  mission: {
    id: string;
    objective: string;
    status: Mission["status"];
    createdAt: string;
    updatedAt: string;
    repository?: { owner: string; name: string; ref: string };
    execution: { connected: boolean; resumed: boolean; sandboxId?: string };
  };
  progress: {
    complete: number;
    total: number;
    passedEvidence: number;
    failedEvidence: number;
    verification: "not_started" | "running" | "passed" | "failed";
  };
  lanes: Array<{
    id: "plan" | "execute" | "prove" | "approve";
    label: string;
    items: Array<{
      id: string;
      title: string;
      purpose: string;
      acceptanceCriteria: string[];
      status: WorkItem["status"];
      dependsOn: string[];
      assignedRole?: WorkItem["assignedRole"];
      requiredChecks?: string[];
      delegation?: WorkItem["delegation"];
    }>;
  }>;
  activity: ActivityView[];
  evidence: EvidenceView[];
  handoffs: HandoffView[];
  reviews: ReviewView[];
  approvals: Array<{
    id: string;
    action: string;
    actionType: string;
    target: string;
    risk: string;
    rationale: string;
    expectedEffect: string;
    evidenceIds: string[];
    decision: string;
    createdAt: string;
    expiresAt: string;
  }>;
  delivery: Array<{
    id: string;
    status: string;
    verificationSummary: string;
    createdAt: string;
    reference?: string;
  }>;
}

class MissionControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionControlError";
  }
}

const LEGACY_PRIMARY_WORK_ITEM_IDS = {
  inspect: "primary-inspect",
  implement: "primary-implement",
  verify: "primary-verify",
} as const;

function hasLegacyPrimaryWorkGraphShape(workItems: WorkItem[]): boolean {
  const legacyIds = new Set<string>(Object.values(LEGACY_PRIMARY_WORK_ITEM_IDS));
  return workItems.length === legacyIds.size &&
    workItems.every((item) => legacyIds.has(item.id));
}

function needsPrimaryWorkGraphUpgrade(workItems: WorkItem[]): boolean {
  const legacyIds = new Set<string>(Object.values(LEGACY_PRIMARY_WORK_ITEM_IDS));
  if (workItems.length === 0 || !workItems.every((item) => legacyIds.has(item.id))) {
    return false;
  }
  const implementer = workItems.find((item) => item.id === LEGACY_PRIMARY_WORK_ITEM_IDS.implement);
  if (implementer === undefined) {
    return false;
  }
  const requiredChecks = implementer.requiredChecks ?? [];
  return workItems.some((item) => item.acceptanceCriteria.length === 0 || item.assignedRole === undefined) ||
    !requiredChecks.includes("typecheck") ||
    !requiredChecks.includes("test");
}

function buildLegacyPrimaryWorkGraph(mission: Mission): WorkGraphDefinition {
  return validateWorkGraph({
    items: [
      {
        id: LEGACY_PRIMARY_WORK_ITEM_IDS.inspect,
        title: "Inspect the pinned repository",
        purpose: "Verify the exact source commit and expected file surface before implementation starts.",
        acceptanceCriteria: [
          "The pinned repository inspection is correlated to the primary mission.",
          "The verified source surface is recorded before dependent work becomes executable.",
        ],
        dependsOn: [],
        assignedRole: "planner",
      },
      {
        id: LEGACY_PRIMARY_WORK_ITEM_IDS.implement,
        title: "Implement the requested change",
        purpose: `Apply the primary mission objective to the verified repository: ${mission.objective}`,
        acceptanceCriteria: [
          `The implementation satisfies the primary mission objective: ${mission.objective}`,
          "The source change and focused tests remain within the verified repository scope.",
        ],
        dependsOn: [LEGACY_PRIMARY_WORK_ITEM_IDS.inspect],
        assignedRole: "implementer",
        requiredChecks: ["typecheck", "test"],
      },
      {
        id: LEGACY_PRIMARY_WORK_ITEM_IDS.verify,
        title: "Verify the requested delivery",
        purpose: "Independently verify the implementation against the primary mission contract.",
        acceptanceCriteria: [
          "The configured verification command passes against the completed implementation.",
        ],
        dependsOn: [LEGACY_PRIMARY_WORK_ITEM_IDS.implement],
        assignedRole: "reviewer",
      },
    ],
  });
}

function compactPrimaryWorkGraph(graph: WorkGraphDefinition): WorkGraphDefinition {
  const inspections = graph.items.filter((item) =>
    item.assignedRole === "planner" && item.dependsOn.length === 0,
  );
  const implementers = graph.items.filter((item) => item.assignedRole === "implementer");
  const reviewers = graph.items.filter((item) => item.assignedRole === "reviewer");
  if (inspections.length !== 1 || implementers.length === 0 || reviewers.length !== 1 ||
      inspections.length + implementers.length + reviewers.length !== graph.items.length) {
    throw new MissionDomainError(
      "invalid_input",
      "The legacy primary mission cannot compact the planned work graph without losing a work scope.",
    );
  }
  const acceptanceCriteria = [...new Set(implementers.flatMap((item) => item.acceptanceCriteria))];
  if (acceptanceCriteria.length > MAX_WORK_ITEM_ACCEPTANCE_CRITERIA) {
    throw new MissionDomainError(
      "invalid_input",
      `The legacy primary mission needs ${acceptanceCriteria.length} implementation acceptance conditions, exceeding the bounded limit of ${MAX_WORK_ITEM_ACCEPTANCE_CRITERIA}.`,
    );
  }
  const purpose = implementers.map((item) => `${item.title}: ${item.purpose}`).join(" ");
  if (purpose.length > 4_000) {
    throw new MissionDomainError(
      "invalid_input",
      "The legacy primary mission cannot compact its implementation scope into a bounded work item.",
    );
  }
  const requiredChecks = [...new Set(implementers.flatMap((item) => item.requiredChecks ?? []))];
  const inspection = inspections[0];
  const reviewer = reviewers[0];
  if (inspection === undefined || reviewer === undefined) {
    throw new MissionDomainError(
      "invalid_input",
      "The legacy primary mission is missing a bounded inspection or verification scope.",
    );
  }
  const compacted: WorkGraphDefinition = {
    items: [
      { ...inspection, id: LEGACY_PRIMARY_WORK_ITEM_IDS.inspect, dependsOn: [] },
      {
        id: LEGACY_PRIMARY_WORK_ITEM_IDS.implement,
        title: "Implement the requested change across the verified scope",
        purpose,
        acceptanceCriteria,
        dependsOn: [LEGACY_PRIMARY_WORK_ITEM_IDS.inspect],
        assignedRole: "implementer",
        ...(requiredChecks.length === 0 ? {} : { requiredChecks }),
      },
      {
        ...reviewer,
        id: LEGACY_PRIMARY_WORK_ITEM_IDS.verify,
        dependsOn: [LEGACY_PRIMARY_WORK_ITEM_IDS.implement],
      },
    ],
  };
  return validateWorkGraph(compacted);
}

class MissionController {
  private operation: Promise<MissionView> | null = null;
  private createOperation: Promise<MissionView> | null = null;

  constructor(
    private readonly missions: MissionService,
    private readonly runner: MissionRunner,
    private readonly planner: WorkGraphPlanner = new RepositoryWorkGraphPlanner(),
    private readonly verifier: ImplementationVerifier = new DeterministicImplementationVerifier(),
  ) {}

  async getPrimaryMission(): Promise<MissionView | null> {
    const state = await this.missions.getState();
    return state.missions.some((mission) => mission.id === PRIMARY_MISSION_ID)
      ? mapMissionState(state, PRIMARY_MISSION_ID)
      : null;
  }

  createOrOpenPrimaryMission(): Promise<MissionView> {
    if (this.createOperation !== null) {
      return this.createOperation;
    }
    this.createOperation = this.createOrOpenPrimaryMissionOnce().finally(() => {
      this.createOperation = null;
    });
    return this.createOperation;
  }

  private async createOrOpenPrimaryMissionOnce(): Promise<MissionView> {
    const existing = await this.getPrimaryMission();
    if (existing !== null) {
      await this.ensureWorkItems();
      return mapMissionState(await this.missions.getState(), PRIMARY_MISSION_ID);
    }

    await this.runner.createMission({
      id: PRIMARY_MISSION_ID,
      objective: PRIMARY_MISSION_OBJECTIVE,
      repository: PRIMARY_REPOSITORY,
    });
    await this.ensureWorkItems();
    return mapMissionState(await this.missions.getState(), PRIMARY_MISSION_ID);
  }

  runPrimaryMission(): Promise<MissionView> {
    if (this.operation !== null) {
      return this.operation;
    }
    this.operation = this.executePrimaryMission().finally(() => {
      this.operation = null;
    });
    return this.operation;
  }

  private async ensureWorkItems(): Promise<void> {
    const state = await this.missions.getState();
    const workItems = state.workItems.filter((item) => item.missionId === PRIMARY_MISSION_ID);
    const mission = await this.missions.getMission(PRIMARY_MISSION_ID);
    if (needsPrimaryWorkGraphUpgrade(workItems)) {
      if (mission.status !== "delivered" && mission.status !== "failed") {
        await this.missions.persistWorkGraph(
          PRIMARY_MISSION_ID,
          buildLegacyPrimaryWorkGraph(mission),
        );
      }
      return;
    }
    if (workItems.length > 0) {
      validateWorkGraph({ items: workItems });
      return;
    }
    await this.missions.persistWorkGraph(
      PRIMARY_MISSION_ID,
      buildPreflightWorkGraph(mission),
    );
  }

  private async executePrimaryMission(): Promise<MissionView> {
    await this.createOrOpenPrimaryMission();
    await this.prepareMissionForExecution();
    try {
      let state = await this.missions.getState();
      const inspectionItems = state.workItems.filter((item) =>
        item.missionId === PRIMARY_MISSION_ID &&
        item.assignedRole === "planner" &&
        item.dependsOn.length === 0
      );
      if (inspectionItems.length !== 1 || inspectionItems[0] === undefined) {
        throw new MissionControlError(
          "Planning requires exactly one executable repository-inspection root.",
        );
      }
      const inspectionItem = inspectionItems[0];
      let inspectionResult: unknown;
      await this.executeWork(inspectionItem.id, async () => {
        inspectionResult = await this.runner.inspectRepository({
          missionId: PRIMARY_MISSION_ID,
          workItemId: inspectionItem.id,
        });
        await this.requirePassedEvidence(inspectionItem.id, "mcp");
      });
      if (inspectionResult !== undefined) {
        await this.persistInspectedWorkGraph(inspectionResult, inspectionItem.id);
      } else {
        const plannedState = await this.missions.getState();
        const hasExecutableGraph = plannedState.workItems.some((item) =>
          item.missionId === PRIMARY_MISSION_ID && item.assignedRole === "implementer"
        ) && plannedState.workItems.some((item) =>
          item.missionId === PRIMARY_MISSION_ID && item.assignedRole === "reviewer"
        );
        if (!hasExecutableGraph) {
          throw new MissionControlError(
            "Completed repository inspection did not produce executable work.",
          );
        }
      }

      state = await this.missions.getState();
      const implementers = state.workItems.filter((item) =>
        item.missionId === PRIMARY_MISSION_ID && item.assignedRole === "implementer"
      );
      const reviewers = state.workItems.filter((item) =>
        item.missionId === PRIMARY_MISSION_ID && item.assignedRole === "reviewer"
      );
      if (implementers.length === 0 || reviewers.length === 0) {
        throw new MissionControlError(
          "Planning must produce bounded implementation and verification work.",
        );
      }
      for (const implementer of implementers) {
        await this.executeWork(implementer.id, async () => {
          const execution = await this.runner.runTurn(
            PRIMARY_MISSION_ID,
            [
              `Execute only this bounded work item: ${implementer.purpose}`,
              `Acceptance criteria: ${implementer.acceptanceCriteria.join(" ")}`,
              "Use the configured sandbox and verified pinned source.",
              "Do not push, open a pull request, or perform any other remote mutation.",
            ].join(" "),
            { workItemId: implementer.id, delegateToSubagent: true },
          );
          await this.requirePassedTurn(implementer.id);
          if (execution.implementationHandoff !== undefined) {
            await this.recordImplementationHandoff(execution, implementer.id);
          }
        }, false);
        await this.reviewImplementation(implementer.id);
      }
      for (const reviewer of reviewers) {
        await this.executeWork(reviewer.id, async () => {
          await this.runner.runSandboxVerification({
            missionId: PRIMARY_MISSION_ID,
            workItemId: reviewer.id,
            command: PRIMARY_VERIFICATION_COMMAND,
          });
          await this.requirePassedEvidence(reviewer.id, "sandbox");
        });
      }

      const mission = await this.missions.getMission(PRIMARY_MISSION_ID);
      if (mission.status === "executing") {
        await this.missions.transitionMission(PRIMARY_MISSION_ID, "verifying");
      }
      await this.ensurePrimaryDeliveryApproval();
      return mapMissionState(await this.missions.getState(), PRIMARY_MISSION_ID);
    } catch (error) {
      await this.blockActiveWork();
      throw error;
    }
  }

  private async recordImplementationHandoff(
    execution: TrueForgeTurnResult,
    workItemId: string,
  ): Promise<void> {
    const draft = execution.implementationHandoff;
    if (draft === undefined) {
      return;
    }
    const requiredChecksPassed = draft.checks
      .filter((check) => check.required)
      .every((check) => check.result === "passed");
    await this.missions.recordHandoff(PRIMARY_MISSION_ID, {
      workItemId,
      result: requiredChecksPassed ? "done" : "partial",
      summary: requiredChecksPassed
        ? "The delegated implementation returned a structured evidence handoff."
        : "The delegated implementation returned a partial handoff with unresolved required checks.",
      filesChanged: draft.filesChanged,
      testsRun: [...new Set(draft.checks.map((check) => check.command))],
      decisions: draft.decisions,
      openQuestions: draft.openQuestions,
      componentsTouched: [],
      memoryImpact: "medium",
      diffSummary: draft.diffSummary,
      checks: draft.checks,
      evidenceIds: draft.evidenceIds,
      executionOrigin: draft.executionOrigin,
    });
  }

  private async ensurePrimaryDeliveryApproval(): Promise<void> {
    const state = await this.missions.getState();
    const activeRequest = state.approvals.find((approval) =>
      approval.missionId === PRIMARY_MISSION_ID &&
      approval.actionType === PRIMARY_CONSEQUENTIAL_ACTION &&
      ["pending", "approved"].includes(approval.decision) &&
      Date.parse(approval.expiresAt) > Date.now(),
    );
    if (activeRequest !== undefined) {
      return;
    }
    const mission = state.missions.find((item) => item.id === PRIMARY_MISSION_ID);
    if (mission === undefined) {
      throw new MissionControlError("Approval could not find the primary mission.");
    }
    const target = mission.repository === undefined
      ? `mission ${mission.id}`
      : `${mission.repository.owner}/${mission.repository.name}@${mission.repository.ref}`;
    const evidenceIds = state.evidence
      .filter((evidence) =>
        evidence.missionId === PRIMARY_MISSION_ID &&
        (evidence.source === "mcp" || evidence.source === "sandbox") &&
        evidence.result === "passed",
      )
      .map((evidence) => evidence.id);
    await this.missions.requestActionApproval(PRIMARY_MISSION_ID, {
      action: "Open the verified delivery",
      actionType: PRIMARY_CONSEQUENTIAL_ACTION,
      target,
      risk: "A remote repository mutation will create a pull request.",
      rationale: "A human must authorize the verified change before it is published for review.",
      expectedEffect: "Open a pull request containing the verified source change for review.",
      evidenceIds,
    });
  }

  private async reviewImplementation(workItemId: string): Promise<void> {
    const workItem = await this.missions.getWorkItem(PRIMARY_MISSION_ID, workItemId);
    if (workItem.status === "complete") {
      return;
    }
    if (workItem.status !== "ready_for_review") {
      throw new MissionControlError(
        "Independent verification requires the implementation to be ready for review.",
      );
    }
    if (workItem.delegation === undefined) {
      await this.missions.transitionWorkItem(PRIMARY_MISSION_ID, workItemId, "complete");
      return;
    }
    const context = await this.missions.getReviewContext(PRIMARY_MISSION_ID, workItemId);
    const decision = await this.verifier.review(context);
    await this.missions.reviewWorkItem(PRIMARY_MISSION_ID, {
      workItemId,
      outcome: decision.outcome,
      reviewer: decision.reviewer,
      summary: decision.summary,
      finding: decision.finding,
    });
    if (decision.outcome !== "accepted") {
      throw new MissionControlError(
        `Independent verification returned ${decision.outcome}: ${decision.finding}`,
      );
    }
  }

  private async persistInspectedWorkGraph(
    inspectionResult: unknown,
    inspectionWorkItemId: string,
  ): Promise<void> {
    const state = await this.missions.getState();
    const mission = state.missions.find((item) => item.id === PRIMARY_MISSION_ID);
    if (mission === undefined) {
      throw new MissionControlError("Planning could not find the primary mission.");
    }
    const inspection = verifiedInspectionFromResult(
      inspectionResult,
      state,
      mission,
      inspectionWorkItemId,
    );
    try {
      const plannedGraph = validateWorkGraph(await this.planner.plan({ mission, inspection }));
      const graph = hasLegacyPrimaryWorkGraphShape(
        state.workItems.filter((item) => item.missionId === PRIMARY_MISSION_ID),
      )
        ? compactPrimaryWorkGraph(plannedGraph)
        : plannedGraph;
      await this.missions.persistWorkGraph(PRIMARY_MISSION_ID, graph);
    } catch (error) {
      if (error instanceof MissionDomainError) {
        throw error;
      }
      throw new MissionControlError(
        "Planning failed closed; no executable work graph was persisted.",
      );
    }
  }

  private async prepareMissionForExecution(): Promise<void> {
    let mission = await this.missions.getMission(PRIMARY_MISSION_ID);
    if (mission.status === "draft") {
      mission = await this.missions.transitionMission(PRIMARY_MISSION_ID, "planning");
    }
    if (mission.status === "planning" || mission.status === "blocked") {
      await this.missions.transitionMission(PRIMARY_MISSION_ID, "executing");
    }
    const current = await this.missions.getMission(PRIMARY_MISSION_ID);
    if (current.status !== "executing" && current.status !== "verifying") {
      throw new MissionControlError(`Mission cannot run from ${current.status}.`);
    }
  }

  private async executeWork(
    workItemId: string,
    operation: () => Promise<void>,
    complete = true,
  ): Promise<void> {
    let item = await this.missions.getWorkItem(PRIMARY_MISSION_ID, workItemId);
    if (item.status === "complete") {
      return;
    }
    if (item.status === "blocked") {
      item = await this.missions.transitionWorkItem(PRIMARY_MISSION_ID, workItemId, "ready");
    }
    if (item.status === "backlog") {
      item = await this.missions.transitionWorkItem(PRIMARY_MISSION_ID, workItemId, "ready");
    }
    if (item.status === "ready") {
      item = await this.missions.transitionWorkItem(PRIMARY_MISSION_ID, workItemId, "in_progress");
    }
    if (item.status === "in_progress") {
      await operation();
      item = await this.missions.transitionWorkItem(
        PRIMARY_MISSION_ID,
        workItemId,
        "ready_for_review",
      );
    }
    if (complete && item.status === "ready_for_review") {
      await this.missions.transitionWorkItem(PRIMARY_MISSION_ID, workItemId, "complete");
    }
  }

  private async requirePassedEvidence(workItemId: string, source: "mcp" | "sandbox") {
    const state = await this.missions.getState();
    const latest = state.evidence.filter(
      (item) => item.workItemId === workItemId && item.source === source,
    ).at(-1);
    if (latest?.result !== "passed") {
      throw new MissionControlError(`${source === "mcp" ? "Repository" : "Sandbox"} proof did not pass.`);
    }
  }

  private async requirePassedTurn(workItemId: string) {
    const state = await this.missions.getState();
    const completed = state.evidence.some(
      (item) =>
        item.workItemId === workItemId &&
        item.source === "trueforge" &&
        item.result === "passed" &&
        item.summary.startsWith("TrueForge turn finished with status done"),
    );
    if (!completed) {
      throw new MissionControlError("Execution stopped before the turn completed successfully.");
    }
  }

  private async blockActiveWork(): Promise<void> {
    try {
      const state = await this.missions.getState();
      const active = state.workItems.find(
        (item) =>
          item.missionId === PRIMARY_MISSION_ID &&
          ["backlog", "ready", "in_progress", "ready_for_review"].includes(item.status) &&
          (item.status === "in_progress" || item.status === "ready_for_review"),
      );
      if (active !== undefined) {
        await this.missions.transitionWorkItem(PRIMARY_MISSION_ID, active.id, "blocked");
      }
      const mission = await this.missions.getMission(PRIMARY_MISSION_ID);
      if (!["blocked", "failed", "delivered"].includes(mission.status)) {
        await this.missions.transitionMission(PRIMARY_MISSION_ID, "blocked");
      }
    } catch {
      // Preserve the operation error if the durable failure state was already recorded.
    }
  }
}

function verifiedInspectionFromResult(
  result: unknown,
  state: MissionState,
  mission: Mission,
  workItemId: string,
): VerifiedRepositoryInspection {
  if (isRecord(result) &&
      typeof result.resourceUri === "string" &&
      typeof result.contentHash === "string") {
    const inspection: VerifiedRepositoryInspection = {
      resourceUri: result.resourceUri,
      contentHash: result.contentHash,
    };
    if (typeof result.content === "string") {
      inspection.content = result.content;
    }
    if (typeof result.commitSha === "string") {
      inspection.commitSha = result.commitSha;
    }
    if (isRecord(result.patches)) {
      const patches: Record<string, string> = {};
      for (const [file, patch] of Object.entries(result.patches)) {
        if (typeof patch !== "string") {
          throw new MissionControlError(
            "Planning failed closed; repository inspection patches were malformed.",
          );
        }
        patches[file] = patch;
      }
      inspection.patches = patches;
    }
    return inspection;
  }

  const evidenceId = isRecord(result) && typeof result.evidenceId === "string"
    ? result.evidenceId
    : undefined;
  const evidence = evidenceId === undefined
    ? [...state.evidence]
        .reverse()
        .find((item) =>
          item.missionId === mission.id &&
          item.workItemId === workItemId &&
          item.source === "mcp",
        )
    : state.evidence.find((item) => item.id === evidenceId);
  if (
    evidence === undefined ||
    evidence.missionId !== mission.id ||
    evidence.workItemId !== workItemId ||
    evidence.source !== "mcp" ||
    evidence.result !== "passed"
  ) {
    throw new MissionControlError(
      "Planning failed closed; no verified repository inspection was available.",
    );
  }

  let details: Record<string, unknown> = {};
  if (evidence.details !== undefined) {
    try {
      const parsed = JSON.parse(evidence.details) as unknown;
      if (isRecord(parsed)) {
        details = parsed;
      }
    } catch {
      throw new MissionControlError(
        "Planning failed closed; repository inspection evidence was malformed.",
      );
    }
  }
  const contentHash = typeof details.content_hash === "string"
    ? details.content_hash
    : undefined;
  if (contentHash === undefined || contentHash.trim().length === 0) {
    throw new MissionControlError(
      "Planning failed closed; repository inspection evidence had no content hash.",
    );
  }
  const resourceUri = typeof details.uri === "string" && details.uri.trim().length > 0
    ? details.uri
    : mission.repository === undefined
    ? `repo://verified/${contentHash}`
    : `repo://${mission.repository.owner}/${mission.repository.name}/${mission.repository.ref}/verified`;
  const inspection: VerifiedRepositoryInspection = { resourceUri, contentHash };
  if (typeof details.commit_sha === "string") {
    inspection.commitSha = details.commit_sha;
  }
  if (isRecord(details.patches)) {
    const patches: Record<string, string> = {};
    for (const [file, patch] of Object.entries(details.patches)) {
      if (typeof patch !== "string") {
        throw new MissionControlError(
          "Planning failed closed; repository inspection patches were malformed.",
        );
      }
      patches[file] = patch;
    }
    inspection.patches = patches;
  }
  return inspection;
}

export function mapMissionState(state: MissionState, missionId: string): MissionView {
  const mission = state.missions.find((item) => item.id === missionId);
  if (mission === undefined) {
    throw new MissionDomainError("not_found", `Mission ${missionId} was not found.`);
  }
  const workItems = state.workItems.filter((item) => item.missionId === missionId);
  const titleByWorkId = new Map(workItems.map((item) => [item.id, item.title]));
  const missionEvidence = state.evidence.filter((item) => item.missionId === missionId);
  const evidence = missionEvidence
    .filter((item): item is Evidence & { source: "mcp" | "sandbox" } =>
      item.source === "mcp" || item.source === "sandbox")
    .map((item) => mapEvidence(item, titleByWorkId))
    .sort(newestFirst);
  const activity = missionEvidence.map(mapActivity).sort(newestFirst);
  if (mission.trueforgeSessionId !== undefined) {
    activity.push({
      id: `session-${mission.id}`,
      actor: "TrueForge",
      result: "active",
      summary: mission.trueforgeTurnId === undefined
        ? "Execution session connected."
        : "Execution session resumed with durable mission state.",
      createdAt: mission.updatedAt,
      category: "session",
    });
    activity.sort(newestFirst);
  }
  const passedEvidence = evidence.filter((item) => item.result === "passed").length;
  const failedEvidence = evidence.filter((item) => item.result === "failed").length;
  const completed = workItems.filter((item) => item.status === "complete").length;
  const repositoryProof = latestProofResultForRole(
    missionEvidence,
    workItems,
    "planner",
    "mcp",
  );
  const sandboxProof = latestProofResultForRole(
    missionEvidence,
    workItems,
    "reviewer",
    "sandbox",
  );
  const currentProofFailed = repositoryProof === "failed" || sandboxProof === "failed";
  const currentProofPassed = repositoryProof === "passed" && sandboxProof === "passed";
  const verification = mission.status === "failed" || mission.status === "blocked"
    ? "failed"
    : (mission.status === "verifying" || mission.status === "delivered") && currentProofPassed
    ? "passed"
    : currentProofFailed
    ? "failed"
    : workItems.some((item) => item.status === "in_progress" || item.status === "ready_for_review")
      || mission.status === "planning" || mission.status === "executing"
    ? "running"
    : "not_started";

  const missionView: MissionView["mission"] = {
    id: mission.id,
    objective: mission.objective,
    status: mission.status,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    execution: {
      connected: mission.trueforgeSessionId !== undefined,
      resumed: mission.trueforgeTurnId !== undefined,
    },
  };
  if (mission.trueforgeSandboxId !== undefined) {
    missionView.execution.sandboxId = mission.trueforgeSandboxId;
  }
  if (mission.repository !== undefined) {
    missionView.repository = { ...mission.repository };
  }

  return {
    revision: state.revision,
    mission: missionView,
    progress: {
      complete: completed,
      total: workItems.length,
      passedEvidence,
      failedEvidence,
      verification,
    },
    lanes: [
      lane("plan", "Plan", workItems.filter((item) => item.assignedRole === "planner")),
      lane("execute", "Execute", workItems.filter((item) => item.assignedRole === "implementer")),
      lane("prove", "Prove", workItems.filter((item) => item.assignedRole === "reviewer")),
      lane("approve", "Approve", []),
    ],
    activity,
    evidence,
    handoffs: state.handoffs
      .filter((item) => item.missionId === missionId)
      .map((item) => ({
        id: item.id,
        workItemId: item.workItemId,
        result: item.result,
        summary: item.summary,
        filesChanged: [...item.filesChanged],
        testsRun: [...item.testsRun],
        decisions: [...item.decisions],
        openQuestions: [...item.openQuestions],
        memoryImpact: item.memoryImpact,
        createdAt: item.createdAt,
        ...(item.diffSummary === undefined ? {} : { diffSummary: item.diffSummary }),
        ...(item.checks === undefined ? {} : {
          checks: item.checks.map((check) => ({
            ...check,
            evidenceIds: [...check.evidenceIds],
          })),
        }),
        ...(item.evidenceIds === undefined ? {} : { evidenceIds: [...item.evidenceIds] }),
        ...(item.executionOrigin === undefined ? {} : { executionOrigin: { ...item.executionOrigin } }),
      })),
    reviews: state.reviews
      .filter((item) => item.missionId === missionId)
      .map((item) => ({
        id: item.id,
        workItemId: item.workItemId,
        outcome: item.outcome,
        reviewer: item.reviewer,
        summary: item.summary,
        finding: item.finding,
        handoffId: item.handoffId,
        filesChanged: [...item.filesChanged],
        diffSummary: item.diffSummary,
        checks: item.checks.map((check) => ({
          ...check,
          evidenceIds: [...check.evidenceIds],
        })),
        evidenceIds: [...item.evidenceIds],
        findingEvidenceId: item.findingEvidenceId,
        createdAt: item.createdAt,
      })),
    approvals: state.approvals
      .filter((item) => item.missionId === missionId)
      .map((item) => ({
        id: item.id,
        action: item.action,
        actionType: item.actionType,
        target: item.target,
        risk: item.risk,
        rationale: item.rationale,
        expectedEffect: item.expectedEffect,
        evidenceIds: [...item.evidenceIds],
        decision: item.decision,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
      })),
    delivery: state.deliveries
      .filter((item) => item.missionId === missionId)
      .map((item) => {
        const delivery = {
          id: item.id,
          status: item.status,
          verificationSummary: item.verificationSummary,
          createdAt: item.createdAt,
          ...(item.reference === undefined ? {} : { reference: item.reference }),
        };
        return delivery;
      }),
  };
}

function lane(id: "plan" | "execute" | "prove" | "approve", label: string, items: WorkItem[]) {
  return {
    id,
    label,
    items: items.map((item) => ({
      id: item.id,
      title: item.title,
      purpose: item.purpose,
      acceptanceCriteria: [...item.acceptanceCriteria],
      status: item.status,
      dependsOn: [...item.dependsOn],
      ...(item.assignedRole === undefined ? {} : { assignedRole: item.assignedRole }),
      ...(item.requiredChecks === undefined ? {} : { requiredChecks: [...item.requiredChecks] }),
      ...(item.delegation === undefined ? {} : { delegation: { ...item.delegation } }),
    })),
  };
}

function latestProofResultForRole(
  evidence: Evidence[],
  workItems: WorkItem[],
  role: "planner" | "implementer" | "reviewer",
  source: "mcp" | "sandbox",
): Evidence["result"] | undefined {
  const workItemIds = new Set(
    workItems.filter((item) => item.assignedRole === role).map((item) => item.id),
  );
  let latest: Evidence["result"] | undefined;
  for (const item of evidence) {
    if (item.workItemId !== undefined && workItemIds.has(item.workItemId) && item.source === source) {
      latest = item.result;
    }
  }
  return latest;
}

function mapEvidence(
  evidence: Evidence & { source: "mcp" | "sandbox" },
  titleByWorkId: Map<string, string>,
): EvidenceView {
  const metadata = safeEvidenceMetadata(evidence);
  const view: EvidenceView = {
    id: evidence.id,
    source: evidence.source,
    result: evidence.result,
    kind: evidence.kind,
    summary: evidence.summary,
    createdAt: evidence.createdAt,
    metadata,
  };
  const title = evidence.workItemId === undefined ? undefined : titleByWorkId.get(evidence.workItemId);
  if (title !== undefined) {
    view.workItemTitle = title;
  }
  if (evidence.executionOrigin !== undefined) {
    view.executionOrigin = { ...evidence.executionOrigin };
  }
  return view;
}

function safeEvidenceMetadata(evidence: Evidence): Record<string, string | number> {
  if (evidence.details === undefined) {
    return {};
  }
  let details: unknown;
  try {
    details = JSON.parse(evidence.details);
  } catch {
    return {};
  }
  if (!isRecord(details)) {
    return {};
  }
  const allowed = [
    ["server", "server"],
    ["tool", "tool"],
    ["commit_sha", "commitSha"],
    ["uri", "resource"],
    ["content_hash", "contentHash"],
    ["content_bytes", "contentBytes"],
    ["command", "command"],
    ["exit_code", "exitCode"],
    ["output", "output"],
    ["sandbox_id", "sandboxId"],
  ] as const;
  const safe: Record<string, string | number> = {};
  for (const [sourceKey, publicKey] of allowed) {
    const value = details[sourceKey];
    if (typeof value === "string") {
      safe[publicKey] = value.slice(0, 4_000);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      safe[publicKey] = value;
    }
  }
  return safe;
}

function mapActivity(evidence: Evidence): ActivityView {
  const actor = evidence.source === "mcp"
    ? "Repository MCP"
    : evidence.source === "sandbox"
    ? "Sandbox"
    : evidence.source === "trueforge"
    ? "TrueForge"
    : evidence.source === "agent"
    ? "Agent report"
    : evidence.source[0]?.toUpperCase() + evidence.source.slice(1);
  const category = evidence.source === "mcp"
    ? "repository"
    : evidence.source === "sandbox"
    ? "sandbox"
    : evidence.source === "agent"
    ? "narration"
    : "runtime";
  return {
    id: evidence.id,
    actor,
    result: evidence.result,
    summary: evidence.summary,
    createdAt: evidence.createdAt,
    category,
  };
}

function newestFirst(a: { createdAt: string }, b: { createdAt: string }): number {
  return b.createdAt.localeCompare(a.createdAt);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof value === "object" && value !== null &&
    "then" in value && typeof value.then === "function";
}

function unavailableSemanticReviewDecision(): ImplementationReviewDecision {
  return {
    outcome: "changes_requested",
    reviewer: "independent-verifier",
    summary: "Independent verification could not establish the work-item contract.",
    finding: "The contract-aware verifier returned no valid semantic review; structural proof cannot establish that the changed state satisfies the work item's purpose and acceptance criteria.",
  };
}

function normalizeSemanticReviewDecision(value: unknown): ImplementationReviewDecision {
  const reviewer = isRecord(value) ? boundedReviewText(value.reviewer, 200) : null;
  const summary = isRecord(value) ? boundedReviewText(value.summary, 4_000) : null;
  const finding = isRecord(value) ? boundedReviewText(value.finding, 4_000) : null;
  if (
    !isRecord(value) ||
    !isReviewOutcome(value.outcome) ||
    reviewer === null ||
    summary === null ||
    finding === null
  ) {
    return unavailableSemanticReviewDecision();
  }
  return {
    outcome: value.outcome,
    reviewer,
    summary,
    finding,
  };
}

function isReviewOutcome(value: unknown): value is ReviewOutcome {
  return value === "accepted" || value === "changes_requested" || value === "blocked";
}

function boundedReviewText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength
    ? value.trim()
    : null;
}

function isContentBearingReviewEvidence(evidence: Evidence): boolean {
  return parseContentDiffEvidence(evidence) !== null;
}

function normalizeChangedFile(value: string): string {
  return value.trim().replace(/^\.\//, "");
}

export function createMissionHttpApp(options: MissionHttpOptions) {
  const semanticVerifier = options.semanticVerifier ?? semanticVerifierFromRunner(options.runner);
  const controller = new MissionController(
    options.missions,
    options.runner,
    options.planner,
    options.verifier ?? new DeterministicImplementationVerifier(semanticVerifier),
  );
  return {
    request(path: string, init?: RequestInit) {
      return handle(new Request(new URL(path, "http://mission.local"), init));
    },
    fetch: handle,
  };

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (isStateChangingMethod(request.method) && isCrossOriginRequest(request, url)) {
        return jsonResponse({
          error: "cross_origin",
          message: "Cross-origin state-changing requests are not allowed.",
        }, 403);
      }
      if (request.method === "GET" && url.pathname === "/") {
        return htmlResponse(INDEX_HTML);
      }
      if (request.method === "GET" && url.pathname === "/public/style.css") {
        return assetResponse("style.css", "text/css; charset=utf-8");
      }
      if (request.method === "GET" && url.pathname === "/public/app.js") {
        return assetResponse("app.js", "text/javascript; charset=utf-8");
      }
      if (request.method === "GET" && url.pathname === "/public/run-state.js") {
        return assetResponse("run-state.js", "text/javascript; charset=utf-8");
      }
      if (request.method === "GET" && url.pathname === "/api/mission") {
        return jsonResponse({ mission: await controller.getPrimaryMission() });
      }
      if (request.method === "POST" && url.pathname === "/api/mission") {
        return jsonResponse({ mission: await controller.createOrOpenPrimaryMission() }, 201);
      }
      if (request.method === "POST" && url.pathname === "/api/mission/run") {
        return jsonResponse({ mission: await controller.runPrimaryMission() });
      }
      return jsonResponse({ error: "not_found", message: "Route not found." }, 404);
    } catch (error) {
      const status = error instanceof MissionDomainError
        ? error.code === "not_found" ? 404 : 400
        : error instanceof TrueForgeIntegrationError || error instanceof MissionControlError
        ? 502
        : 500;
      const message = publicErrorMessage(error);
      const mission = await controller.getPrimaryMission().catch(() => null);
      return jsonResponse({ error: "operation_failed", message, mission }, status);
    }
  }
}

function semanticVerifierFromRunner(
  runner: MissionRunner,
): SemanticContractVerifier | undefined {
  const reviewContract = runner.reviewContract;
  return reviewContract === undefined
    ? undefined
    : {
        reviewContract: (context) => reviewContract.call(runner, context),
      };
}

function isStateChangingMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function isCrossOriginRequest(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    if (origin === "null") {
      return true;
    }
    try {
      return new URL(origin).origin !== url.origin;
    } catch {
      return true;
    }
  }
  return request.headers.get("sec-fetch-site") === "cross-site";
}

async function assetResponse(
  fileName: "style.css" | "app.js" | "run-state.js",
  contentType: string,
) {
  const content = await readFile(new URL(`./public/${fileName}`, import.meta.url), "utf8");
  return new Response(content, {
    headers: securityHeaders({ "content-type": contentType, "cache-control": "no-cache" }),
  });
}

function htmlResponse(content: string) {
  return new Response(content, {
    headers: securityHeaders({ "content-type": "text/html; charset=utf-8" }),
  });
}

function jsonResponse(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: securityHeaders({
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    }),
  });
}

function securityHeaders(headers: Record<string, string>) {
  return {
    ...headers,
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function publicErrorMessage(error: unknown): string {
  if (error instanceof TrueForgeIntegrationError) {
    if (error.operation.includes("inspect repository")) {
      return "Repository inspection failed. Check the configured runtime and repository connector.";
    }
    if (error.operation.includes("sandbox")) {
      return "Sandbox verification failed. Check the configured runtime and sandbox provider.";
    }
    return "The execution runtime is unavailable or could not complete the requested operation.";
  }
  if (error instanceof MissionControlError) {
    return error.message.slice(0, 240);
  }
  if (error instanceof MissionDomainError) {
    return error.code === "not_found"
      ? "The requested mission state was not found."
      : "The mission state operation could not be completed.";
  }
  return "Mission Control could not complete the requested operation.";
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#08090a">
    <title>Mission Control · TrueForge</title>
    <link rel="stylesheet" href="/public/style.css">
    <script src="/public/run-state.js" defer></script>
    <script src="/public/app.js" defer></script>
  </head>
  <body>
    <header class="topbar">
      <a class="product-mark" href="/" aria-label="TrueForge Mission Control home">
        <span class="product-glyph" aria-hidden="true">TF</span>
        <span>MISSION CONTROL</span>
      </a>
      <p class="topbar-thesis">Plan <span>→</span> Execute <span>→</span> Prove <span>→</span> Approve</p>
      <span id="connection-state" class="connection-state">Connecting</span>
    </header>
    <main id="app" class="mission-shell" aria-live="polite">
      <section class="boot-state panel">
        <p class="eyebrow">Mission Control</p>
        <h1>Loading durable mission state…</h1>
      </section>
    </main>
    <div id="message" class="toast-region" aria-live="assertive"></div>
  </body>
</html>`;
