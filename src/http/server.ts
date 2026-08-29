import { readFile } from "node:fs/promises";

import {
  buildDiagnosticSnapshot,
  DiagnosticFailureCategory,
  DiagnosticFailureLayer,
  DiagnosticSnapshot,
} from "../diagnostics.js";
import {
  Approval,
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
  missionTransitions,
  validateWorkGraph,
} from "../domain.js";
import {
  buildPreflightWorkGraph,
  DeliveryHeadInspectionInput,
  ImplementationProofInput,
  ImplementationHandoffDraft,
  RepositoryInspectionInput,
  RepositoryWorkGraphPlanner,
  PullRequestDeliveryTarget,
  SandboxVerificationInput,
  TrueForgeDeliveryApproval,
  TrueForgeIntegrationError,
  TrueForgePullRequestResult,
  TrueForgeTurnResult,
  VerifiedRepositoryInspection,
  WorkGraphPlanner,
  IMPLEMENTATION_PROOF_MODE,
} from "../trueforge.js";
import { parseContentDiffEvidence } from "../diff.js";
import {
  PRIMARY_DELIVERY_FIXTURE,
  PRIMARY_VERIFIED_DELIVERY_FILES,
  PRIMARY_VERIFIED_DELIVERY_PATCHES,
  PRIMARY_SANDBOX_REPOSITORY_ROOT,
} from "../fixture.js";

export const PRIMARY_MISSION_ID = "primary-mission";
export const PRIMARY_MISSION_OBJECTIVE =
  "Add a backwards-compatible getNextDeliveryStage(stage) helper to src/index.ts. It returns the next stage for Plan, Execute, and Prove, returns null for terminal Approve, preserves the existing identity exports, and includes focused tests for every transition.";
export const PRIMARY_REPOSITORY = {
  owner: PRIMARY_DELIVERY_FIXTURE.owner,
  name: PRIMARY_DELIVERY_FIXTURE.repository,
  ref: PRIMARY_DELIVERY_FIXTURE.baselineRef,
} as const;

export const PRIMARY_DELIVERY_TARGET: PullRequestDeliveryTarget = {
  owner: PRIMARY_DELIVERY_FIXTURE.owner,
  repo: PRIMARY_DELIVERY_FIXTURE.repository,
  base: PRIMARY_DELIVERY_FIXTURE.base,
  head: PRIMARY_DELIVERY_FIXTURE.head,
  title: "Add the verified delivery-stage helper",
  body: "Adds the backwards-compatible delivery-stage helper and focused transition coverage verified by the Proof Board mission.",
};

export const PRIMARY_VERIFICATION_COMMAND = "npm test";

export interface MissionRunner {
  createMission(input: {
    id: string;
    objective: string;
    repository: { owner: string; name: string; ref: string };
  }): Promise<Mission>;
  inspectRepository(input: RepositoryInspectionInput): Promise<unknown>;
  inspectDeliveryHead(input: DeliveryHeadInspectionInput): Promise<unknown>;
  runTurn(
    missionId: string,
    instruction: string,
    options: { workItemId: string; previousTurnId?: string; delegateToSubagent?: boolean },
  ): Promise<TrueForgeTurnResult>;
  claimReadyWorkItem?(
    missionId: string,
    workItemId: string,
    owner: string,
    expectedRevision?: number,
  ): Promise<WorkItem>;
  proveImplementation(input: ImplementationProofInput): Promise<ImplementationHandoffDraft>;
  runSandboxVerification(input: SandboxVerificationInput): Promise<unknown>;
  requestPullRequestApproval(
    missionId: string,
    target: PullRequestDeliveryTarget,
  ): Promise<TrueForgeDeliveryApproval>;
  resolvePullRequestApproval(
    missionId: string,
    pending: TrueForgeDeliveryApproval,
    decision: "approved" | "rejected" | "cancelled",
    workItemId?: string,
  ): Promise<TrueForgePullRequestResult | null>;
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
  workItemId?: string;
  workItemTitle?: string;
  attempt?: number;
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
  attempt?: number;
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
  attempt?: number;
}

export interface ActivityView {
  id: string;
  actor: string;
  result: Evidence["result"] | "active";
  summary: string;
  createdAt: string;
  workItemId?: string;
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
    deliveryTarget?: { owner: string; repo: string; base: string; head: string };
    execution: { connected: boolean; resumed: boolean; sandboxId?: string };
  };
  progress: {
    complete: number;
    total: number;
    passedEvidence: number;
    failedEvidence: number;
    execution: "not_started" | "running" | "passed" | "failed";
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
      allowedFiles?: string[];
      delegation?: WorkItem["delegation"];
    }>;
  }>;
  /** Queue-first board payload; lanes remain for clients using the original view. */
  tickets: Array<{
    id: string;
    title: string;
    purpose: string;
    acceptanceCriteria: string[];
    status: WorkItem["status"];
    dependsOn: string[];
    assignedRole?: WorkItem["assignedRole"];
    requiredChecks?: string[];
    allowedFiles?: string[];
    executionAuthorization?: WorkItem["executionAuthorization"];
    claim?: WorkItem["claim"];
    attempt: number;
    attempts: WorkItem["attempts"];
    requestedChanges?: string[];
    blockedReason?: string;
    delegation?: WorkItem["delegation"];
  }>;
  activity: ActivityView[];
  evidence: EvidenceView[];
  diagnostics: DiagnosticSnapshot;
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
    workItemId?: string;
    attempt?: number;
    handoffId?: string;
    reviewId?: string;
    trueforgeSandboxId?: string;
    decidedBy?: string;
    decidedAt?: string;
    executionContext?: Approval["executionContext"];
  }>;
  delivery: Array<{
    id: string;
    status: string;
    verificationSummary: string;
    createdAt: string;
    reference?: string;
    approvalId?: string;
    workItemId?: string;
    attempt?: number;
    pullRequest?: {
      number: number;
      url: string;
      repositoryOwner: string;
      repositoryName: string;
      base: string;
      head: string;
      headSha?: string;
    };
    executionOrigin?: {
      kind: string;
      sessionId: string;
      turnId?: string;
      threadId?: string;
      toolCallId?: string;
    };
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
    !requiredChecks.includes("test") ||
    implementer.allowedFiles === undefined ||
    implementer.allowedFiles.length === 0;
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
        allowedFiles: Object.keys(PRIMARY_VERIFIED_DELIVERY_FILES),
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
  const allowedFiles = [...new Set(implementers.flatMap((item) => item.allowedFiles ?? []))];
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
        allowedFiles,
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

  async getPrimaryDiagnostics(): Promise<DiagnosticSnapshot | null> {
    const state = await this.missions.getState();
    return state.missions.some((mission) => mission.id === PRIMARY_MISSION_ID)
      ? buildDiagnosticSnapshot(state, PRIMARY_MISSION_ID)
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
        const upgraded = await this.missions.persistWorkGraph(
          PRIMARY_MISSION_ID,
          buildLegacyPrimaryWorkGraph(mission),
        );
        for (const item of upgraded) {
          if (item.status === "ready" && item.claim === undefined && item.executionAuthorization === undefined) {
            await this.missions.transitionWorkItem(PRIMARY_MISSION_ID, item.id, "backlog");
          }
        }
      }
      return;
    }
    if (workItems.length > 0) {
      validateWorkGraph({ items: workItems });
      // A pre-claim primary root may have been created by the legacy graph
      // bootstrap. Keep it in the visible queue until a human authorizes it.
      for (const item of workItems) {
        if (item.status === "ready" && item.claim === undefined && item.executionAuthorization === undefined) {
          await this.missions.transitionWorkItem(PRIMARY_MISSION_ID, item.id, "backlog");
        }
      }
      return;
    }
    const created = await this.missions.persistWorkGraph(
      PRIMARY_MISSION_ID,
      buildPreflightWorkGraph(mission),
    );
    for (const item of created) {
      if (item.status === "ready") {
        await this.missions.transitionWorkItem(PRIMARY_MISSION_ID, item.id, "backlog");
      }
    }
  }

  private async executePrimaryMission(): Promise<MissionView> {
    await this.createOrOpenPrimaryMission();
    const queued = await this.nextQueueWorkItem();
    if (queued === undefined) {
      throw new MissionDomainError(
        "invalid_transition",
        "No ticket is Ready for execution. Move a Backlog ticket to Ready to authorize the next run.",
      );
    }
    try {
      await this.prepareMissionForExecution();
      if (queued.status === "proving") {
        await this.executeProofAndReview(queued);
      } else if (queued.status === "awaiting_approval") {
        const approval = (await this.missions.getState()).approvals
          .filter((item) =>
            item.missionId === PRIMARY_MISSION_ID &&
            item.workItemId === queued.id &&
            item.attempt === queued.attempt &&
            isPrimaryDeliveryApproval(item),
          )
          .at(-1);
        if (approval?.decision === "approved") {
          await this.resumePrimaryDelivery(queued);
        } else {
          await this.ensurePrimaryDeliveryApproval();
        }
      } else if (queued.status === "delivering") {
        await this.resumePrimaryDelivery(queued);
      } else {
        const workItem = await this.claimForExecution(queued, "trueforge-worker");
        if (workItem.assignedRole === "planner") {
          await this.executeRepositoryInspection(workItem);
        } else if (workItem.assignedRole === "implementer") {
          await this.executeImplementation(workItem);
        } else {
          throw new MissionControlError(
            `Ready ticket ${workItem.id} has no executable implementation role.`,
          );
        }
      }
      return mapMissionState(await this.missions.getState(), PRIMARY_MISSION_ID);
    } catch (error) {
      await this.recordMissionFailure(error);
      await this.blockActiveWork(error);
      throw error;
    }
  }

  private async nextQueueWorkItem(): Promise<WorkItem | undefined> {
    const state = await this.missions.getState();
    const items = state.workItems.filter((item) => item.missionId === PRIMARY_MISSION_ID);
    const active = items.filter((item) =>
      ["in_progress", "proving", "awaiting_approval", "delivering"].includes(item.status) &&
      item.claim !== undefined,
    );
    if (active.length > 1) {
      throw new MissionControlError("Only one TrueForge ticket may execute at a time.");
    }
    if (active[0] !== undefined) {
      return active[0];
    }
    return items.find((item) =>
      item.status === "ready" &&
      item.claim === undefined &&
      item.executionAuthorization !== undefined,
    );
  }

  private async executeProofAndReview(workItem: WorkItem): Promise<void> {
    if (workItem.assignedRole !== "implementer" || workItem.claim === undefined) {
      throw new MissionControlError(
        `Ticket ${workItem.id} cannot enter independent proof without an implementer claim.`,
      );
    }

    // A process can restart after proof or review has already been persisted
    // but before the enclosing request returned. Continue from the durable
    // checkpoint instead of measuring the same sandbox a second time.
    const recoveredState = await this.missions.getState();
    const recoveredHandoff = recoveredState.handoffs
      .filter((item) =>
        item.missionId === PRIMARY_MISSION_ID &&
        item.workItemId === workItem.id &&
        item.attempt === workItem.attempt,
      )
      .at(-1);
    const recoveredReview = recoveredState.reviews
      .filter((item) =>
        item.missionId === PRIMARY_MISSION_ID &&
        item.workItemId === workItem.id &&
        item.attempt === workItem.attempt,
      )
      .at(-1);
    if (recoveredHandoff?.result === "done") {
      if (recoveredReview?.outcome === "accepted") {
        await this.ensurePrimaryDeliveryApproval();
        return;
      }
      if (recoveredReview === undefined) {
        const outcome = await this.reviewImplementation(workItem.id);
        if (outcome === "accepted") {
          await this.ensurePrimaryDeliveryApproval();
        }
        return;
      }
    }

    let handoff: ImplementationHandoffDraft;
    try {
      handoff = await this.runner.proveImplementation({
        missionId: PRIMARY_MISSION_ID,
        workItemId: workItem.id,
      });
      await this.recordImplementationHandoff(handoff, workItem.id);
    } catch (error) {
      if (!isRecoverableImplementationProofFailure(error)) {
        throw error;
      }
      await this.recordProofFindingAndRequestChanges(workItem.id, error);
      return;
    }

    const outcome = await this.reviewImplementation(workItem.id);
    if (outcome === "blocked") {
      throw new MissionControlError(
        "Independent verification blocked the implementation; inspect the durable finding before retrying.",
      );
    }
    if (outcome === "accepted") {
      await this.ensurePrimaryDeliveryApproval();
    }
  }

  private async recordProofFindingAndRequestChanges(
    workItemId: string,
    error: unknown,
  ): Promise<void> {
    const reason = missionFailureReason(error);
    await this.missions.addEvidence(PRIMARY_MISSION_ID, {
      workItemId,
      kind: "reviewer_finding",
      result: "failed",
      source: "reviewer",
      summary: "Independent deterministic proof requested changes before review.",
      details: JSON.stringify({
        failure_layer: "proof_board",
        failure_category: "verification",
        phase: "deterministic-proof",
        reason,
      }),
    });
    await this.missions.transitionSystemWorkItem(PRIMARY_MISSION_ID, workItemId, "changes_requested", {
      trigger: "proof",
      reason,
    });
  }

  private async claimForExecution(
    workItem: WorkItem,
    owner: string,
    expectedRevision?: number,
  ): Promise<WorkItem> {
    const revision = expectedRevision ?? (await this.missions.getState()).revision;
    if (this.runner.claimReadyWorkItem !== undefined) {
      return this.runner.claimReadyWorkItem(
        PRIMARY_MISSION_ID,
        workItem.id,
        workItem.claim?.owner ?? owner,
        workItem.status === "ready" ? revision : undefined,
      );
    }
    if (workItem.status === "in_progress") {
      if (workItem.claim === undefined) {
        throw new MissionControlError(`In-progress ticket ${workItem.id} has no durable claim.`);
      }
      return workItem;
    }
    const mission = await this.missions.getMission(PRIMARY_MISSION_ID);
    return this.missions.claimReadyWorkItem(PRIMARY_MISSION_ID, workItem.id, {
      owner,
      expectedRevision: revision,
      ...(mission.trueforgeSessionId === undefined
        ? {}
        : { trueforgeSessionId: mission.trueforgeSessionId }),
      ...(mission.trueforgeSandboxId === undefined
        ? {}
        : { trueforgeSandboxId: mission.trueforgeSandboxId }),
    });
  }

  async claimPrimaryTicket(
    workItemId: string,
    owner: string,
    expectedRevision?: number,
  ): Promise<WorkItem> {
    const workItem = await this.missions.getWorkItem(PRIMARY_MISSION_ID, workItemId);
    if (workItem.status !== "ready" && workItem.status !== "in_progress") {
      throw new MissionDomainError(
        "invalid_transition",
        `Ticket ${workItem.id} is ${workItem.status}; only Ready tickets can enter execution.`,
      );
    }
    return this.claimForExecution(workItem, owner, expectedRevision);
  }

  private async executeRepositoryInspection(workItem: WorkItem): Promise<void> {
    const state = await this.missions.getState();
    const inspectionEvidence = latestEvidenceForAttempt(
      state.evidence,
      workItem.id,
      workItem.attempt,
      "mcp",
    );
    if (inspectionEvidence?.result === "passed") {
      await this.missions.transitionSystemWorkItem(PRIMARY_MISSION_ID, workItem.id, "proving", {
        trigger: "execution",
      });
      await this.missions.transitionSystemWorkItem(PRIMARY_MISSION_ID, workItem.id, "done", {
        trigger: "proof",
      });
      await this.persistInspectedWorkGraph(
        { evidenceId: inspectionEvidence.id },
        workItem.id,
      );
      await this.ensureWorkItems();
      return;
    }
    let inspectionResult: unknown;
    await this.executeClaimedWork(workItem.id, async () => {
      const mission = await this.missions.getMission(PRIMARY_MISSION_ID);
      inspectionResult = await this.runner.inspectRepository({
        missionId: PRIMARY_MISSION_ID,
        workItemId: workItem.id,
        ...(mission.trueforgeTurnId === undefined ? {} : { previousTurnId: mission.trueforgeTurnId }),
      });
      await this.requirePassedEvidence(workItem.id, "mcp");
    });
    if (inspectionResult === undefined) {
      throw new MissionControlError(
        "Completed repository inspection did not return authoritative repository facts.",
      );
    }
    await this.missions.transitionSystemWorkItem(PRIMARY_MISSION_ID, workItem.id, "done", {
      trigger: "proof",
    });
    await this.persistInspectedWorkGraph(inspectionResult, workItem.id);
    await this.ensureWorkItems();
  }

  private async executeImplementation(workItem: WorkItem): Promise<void> {
    const state = await this.missions.getState();
    const completedTurn = latestEvidenceForAttempt(
      state.evidence,
      workItem.id,
      workItem.attempt,
      "trueforge",
    );
    if (
      completedTurn?.result === "passed" &&
      completedTurn.summary.startsWith("TrueForge turn finished with status done")
    ) {
      await this.missions.transitionSystemWorkItem(PRIMARY_MISSION_ID, workItem.id, "proving", {
        trigger: "execution",
      });
      return;
    }
    const repositoryProof = state.evidence.find((evidence) =>
      evidence.missionId === PRIMARY_MISSION_ID &&
      evidence.source === "mcp" &&
      evidence.result === "passed"
    );
    if (repositoryProof === undefined) {
      throw new MissionControlError(
        "Implementation cannot start before a successful read-only repository MCP interaction is persisted.",
      );
    }
    const mission = await this.missions.getMission(PRIMARY_MISSION_ID);
    const repository = mission.repository;
    if (repository === undefined) {
      throw new MissionControlError("Implementation cannot start without a verified repository target.");
    }
    const details = evidenceDetails(repositoryProof);
    const verifiedSha = typeof details?.commit_sha === "string"
      ? details.commit_sha
      : repository.ref;
    await this.executeClaimedWork(workItem.id, async () => {
      const currentMission = await this.missions.getMission(PRIMARY_MISSION_ID);
      await this.runner.runTurn(
        PRIMARY_MISSION_ID,
        [
          `Own the bounded implementation ticket: ${workItem.purpose}`,
          `Mission objective: ${currentMission.objective}`,
          `Acceptance criteria: ${workItem.acceptanceCriteria.join(" ")}`,
          `Allowed files: ${(workItem.allowedFiles ?? []).join(", ")}`,
          ...(workItem.requestedChanges === undefined
            ? []
            : [`Requested rework findings: ${workItem.requestedChanges.join(" ")}`]),
          `Verified repository facts: ${repository.owner}/${repository.name} at full commit ${verifiedSha}.`,
          `Use ${PRIMARY_SANDBOX_REPOSITORY_ROOT} as the one canonical absolute sandbox checkout root. Ensure the pinned repository is present there before edits; never use /workspace, a guessed cwd, or a nested checkout.`,
          "Use the real persistent sandbox and configured tools. You may inspect, edit, install, test, recover from structured command failures, and optionally delegate through TrueForge; keep the turn agentic instead of following a shell micro-script.",
          "Proof Board will independently measure the final persisted sandbox; narration is not proof.",
          "Do not push, open a pull request, or perform any other remote mutation.",
        ].join(" "),
        {
          workItemId: workItem.id,
          ...(currentMission.trueforgeTurnId === undefined
            ? {}
            : { previousTurnId: currentMission.trueforgeTurnId }),
        },
      );
      await this.requirePassedTurn(workItem.id);
    });
  }

  private async executeClaimedWork(
    workItemId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const workItem = await this.missions.getWorkItem(PRIMARY_MISSION_ID, workItemId);
    if (workItem.status !== "in_progress" || workItem.claim === undefined) {
      throw new MissionControlError(
        `Ticket ${workItem.id} must be durably claimed before TrueForge execution.`,
      );
    }
    await operation();
    const current = await this.missions.getWorkItem(PRIMARY_MISSION_ID, workItemId);
    if (current.status === "in_progress") {
      await this.missions.transitionSystemWorkItem(PRIMARY_MISSION_ID, workItemId, "proving", {
        trigger: "execution",
      });
    }
  }

  private async recordImplementationHandoff(
    draft: ImplementationHandoffDraft,
    workItemId: string,
  ): Promise<void> {
    const requiredChecksPassed = draft.checks
      .filter((check) => check.required)
      .every((check) => check.result === "passed");
    await this.missions.recordHandoff(PRIMARY_MISSION_ID, {
      workItemId,
      result: requiredChecksPassed ? "done" : "partial",
      summary: requiredChecksPassed
        ? "Independent final-state proof established a structured implementation handoff."
        : "Independent final-state proof returned a partial handoff with unresolved required checks.",
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
    const workItems = state.workItems.filter((item) => item.missionId === PRIMARY_MISSION_ID);
    const implementation = workItems.find((item) => item.assignedRole === "implementer");
    if (implementation === undefined) {
      throw new MissionControlError(
        "Delivery approval requires a bounded implementer ticket.",
      );
    }
    if (implementation.status !== "awaiting_approval" || implementation.claim === undefined) {
      throw new MissionControlError(
        "Delivery approval requires the current implementer ticket to be awaiting human approval.",
      );
    }
    const attempt = implementation.attempts.at(-1);
    const handoff = state.handoffs
      .filter((item) => item.missionId === PRIMARY_MISSION_ID && item.workItemId === implementation.id)
      .at(-1);
    const review = state.reviews
      .filter((item) => item.missionId === PRIMARY_MISSION_ID && item.workItemId === implementation.id)
      .at(-1);
    if (
      attempt === undefined ||
      attempt.status !== "awaiting_approval" ||
      handoff === undefined ||
      handoff.result !== "done" ||
      handoff.attempt !== implementation.attempt ||
      review === undefined ||
      review.outcome !== "accepted" ||
      review.attempt !== implementation.attempt ||
      review.handoffId !== handoff.id
    ) {
      throw new MissionControlError(
        "Delivery approval requires the current attempt's completed proof and accepted independent review.",
      );
    }
    const proofEvidenceIds = handoff.evidenceIds ?? [];
    const proofEvidence = proofEvidenceIds.map((evidenceId) =>
      state.evidence.find((item) => item.id === evidenceId),
    );
    if (
      proofEvidence.length === 0 ||
      proofEvidence.some((evidence) =>
        evidence === undefined ||
        evidence.missionId !== PRIMARY_MISSION_ID ||
        evidence.workItemId !== implementation.id ||
        evidence.attempt !== implementation.attempt ||
        evidence.result !== "passed"
      ) ||
      !proofEvidence.some((evidence) => evidence?.source === "sandbox") ||
      !proofEvidence.every(isDirectImplementationProofEvidence) ||
      state.evidence.some((evidence) =>
        evidence.workItemId === implementation.id &&
        evidence.attempt === implementation.attempt &&
        ["sandbox", "reviewer"].includes(evidence.source) &&
        evidence.result === "failed"
      )
    ) {
      throw new MissionControlError(
        "Delivery approval requires current passed direct deterministic proof for the approved attempt.",
      );
    }
    const reviewEvidence = state.evidence.find((evidence) =>
      evidence.id === review.findingEvidenceId &&
      evidence.missionId === PRIMARY_MISSION_ID &&
      evidence.workItemId === implementation.id &&
      evidence.attempt === implementation.attempt &&
      evidence.source === "reviewer" &&
      evidence.result === "passed"
    );
    if (reviewEvidence === undefined) {
      throw new MissionControlError(
        "Delivery approval requires the accepted review finding for the current attempt.",
      );
    }
    const activeRequest = state.approvals.find((approval) =>
      approval.missionId === PRIMARY_MISSION_ID &&
      isPrimaryDeliveryApproval(approval) &&
      ["pending", "approved"].includes(approval.decision) &&
      Date.parse(approval.expiresAt) > Date.now(),
    );
    if (activeRequest !== undefined) {
      requireApprovalRepositoryProof(state, activeRequest);
      requireCurrentDeliveryApprovalCorrelation(
        state,
        activeRequest,
        implementation,
        handoff,
        review,
      );
      const mission = await this.missions.getMission(PRIMARY_MISSION_ID);
      if (mission.status === "executing") {
        await this.missions.transitionMission(PRIMARY_MISSION_ID, "awaiting_approval");
      }
      return;
    }
    const plannerIds = new Set(
      workItems.filter((item) => item.assignedRole === "planner").map((item) => item.id),
    );
    const repositoryProof = state.evidence.filter((evidence) =>
      evidence.missionId === PRIMARY_MISSION_ID &&
      evidence.workItemId !== undefined &&
      plannerIds.has(evidence.workItemId) &&
      evidence.source === "mcp" &&
      evidence.result === "passed"
    ).at(-1);
    if (repositoryProof === undefined) {
      throw new MissionControlError(
        "Delivery approval requires current passed repository proof.",
      );
    }
    const mission = state.missions.find((item) => item.id === PRIMARY_MISSION_ID);
    if (mission === undefined) {
      throw new MissionControlError("The primary mission is missing from durable state.");
    }
    requireBaselineRepositoryProof(mission, repositoryProof);
    const deliveryHeadResult = await this.runner.inspectDeliveryHead({
      missionId: PRIMARY_MISSION_ID,
      target: PRIMARY_DELIVERY_TARGET,
      workItemId: implementation.id,
    });
    const deliveryState = await this.missions.getState();
    const { evidence: deliveryHeadProof, headSha } = deliveryHeadProofFromResult(
      deliveryHeadResult,
      deliveryState,
    );
    const deliveryTarget: PullRequestDeliveryTarget = {
      ...PRIMARY_DELIVERY_TARGET,
      headSha,
    };
    requireDeliveryHeadProof(deliveryHeadProof, deliveryTarget);
    const evidenceIds = [...new Set([
      repositoryProof.id,
      deliveryHeadProof.id,
      ...proofEvidenceIds,
      reviewEvidence.id,
    ])];
    const pending = await this.runner.requestPullRequestApproval(
      PRIMARY_MISSION_ID,
      deliveryTarget,
    );
    if (
      pending.target.owner !== deliveryTarget.owner ||
      pending.target.repo !== deliveryTarget.repo ||
      pending.target.base !== deliveryTarget.base ||
      pending.target.head !== deliveryTarget.head ||
      pending.target.title !== deliveryTarget.title ||
      pending.target.body !== deliveryTarget.body ||
      pending.target.headSha !== deliveryTarget.headSha
    ) {
      throw new MissionControlError(
        "TrueForge returned a delivery approval for an artifact different from the verified head.",
      );
    }
    const target = pullRequestApprovalTarget(deliveryTarget);
    const approval = await this.missions.requestActionApproval(PRIMARY_MISSION_ID, {
      action: "Open the verified delivery",
      actionType: PRIMARY_CONSEQUENTIAL_ACTION,
      target,
      risk: "A remote repository mutation will create a pull request.",
      rationale: "A human must authorize the verified change before it is published for review.",
      expectedEffect: pullRequestExpectedEffect(deliveryTarget),
      evidenceIds,
      workItemId: implementation.id,
      attempt: implementation.attempt,
      handoffId: handoff.id,
      reviewId: review.id,
      ...(attempt.claim.trueforgeSandboxId === undefined
        ? {}
        : { trueforgeSandboxId: attempt.claim.trueforgeSandboxId }),
      executionContext: approvalExecutionContext(pending),
    });
    requireCurrentDeliveryApprovalCorrelation(
      { ...(await this.missions.getState()) },
      approval,
      implementation,
      handoff,
      review,
    );
    const currentMission = await this.missions.getMission(PRIMARY_MISSION_ID);
    if (currentMission.status === "executing") {
      await this.missions.transitionMission(PRIMARY_MISSION_ID, "awaiting_approval");
    }
  }

  async decidePrimaryDelivery(
    approvalId: string,
    decision: "approved" | "rejected" | "cancelled",
    decidedBy = "mission-operator",
    expectedRevision?: number,
  ): Promise<MissionView> {
    const state = await this.missions.getState();
    if (expectedRevision !== undefined && state.revision !== expectedRevision) {
      throw new MissionDomainError(
        "conflict",
        `Mission state changed from revision ${expectedRevision}; reload before deciding delivery.`,
      );
    }
    const approval = state.approvals.find((item) =>
      item.id === approvalId && item.missionId === PRIMARY_MISSION_ID
    );
    if (approval === undefined) {
      throw new MissionDomainError("not_found", "The requested approval was not found.");
    }
    const implementation = state.workItems.find((item) =>
      item.missionId === PRIMARY_MISSION_ID &&
      item.assignedRole === "implementer" &&
      item.id === approval.workItemId,
    );
    const handoff = implementation === undefined
      ? undefined
      : state.handoffs
          .filter((item) => item.missionId === PRIMARY_MISSION_ID && item.workItemId === implementation.id)
          .at(-1);
    const review = implementation === undefined
      ? undefined
      : state.reviews
          .filter((item) => item.missionId === PRIMARY_MISSION_ID && item.workItemId === implementation.id)
          .at(-1);
    if (implementation === undefined || handoff === undefined || review === undefined) {
      throw new MissionControlError(
        "The delivery approval is not correlated to a current implementation review.",
      );
    }
    requireCurrentDeliveryApprovalCorrelation(
      state,
      approval,
      implementation,
      handoff,
      review,
    );
    requireApprovalRepositoryProof(state, approval);
    const pending = deliveryApprovalFromState(approval);
    const approvedHeadSha = pending.target.headSha;
    if (approvedHeadSha === undefined) {
      throw new MissionControlError("The approved delivery has no verified head identity.");
    }
    if (decision === "approved") {
      await this.revalidatePrimaryDeliveryHead(pending.target, implementation.id);
    }
    const decisionState = await this.missions.getState();
    const decisionApproval = decisionState.approvals.find((item) =>
      item.id === approval.id && item.missionId === PRIMARY_MISSION_ID
    );
    const decisionImplementation = decisionState.workItems.find((item) =>
      item.id === implementation.id && item.missionId === PRIMARY_MISSION_ID
    );
    const decisionHandoff = decisionState.handoffs
      .filter((item) => item.missionId === PRIMARY_MISSION_ID && item.workItemId === implementation.id)
      .at(-1);
    const decisionReview = decisionState.reviews
      .filter((item) => item.missionId === PRIMARY_MISSION_ID && item.workItemId === implementation.id)
      .at(-1);
    if (
      decisionApproval === undefined ||
      decisionImplementation === undefined ||
      decisionHandoff === undefined ||
      decisionReview === undefined
    ) {
      throw new MissionControlError(
        "The delivery approval changed before the operator decision could be persisted.",
      );
    }
    requireCurrentDeliveryApprovalCorrelation(
      decisionState,
      decisionApproval,
      decisionImplementation,
      decisionHandoff,
      decisionReview,
    );
    requireApprovalRepositoryProof(decisionState, decisionApproval);
    const decidedApproval = await this.missions.decideApproval(PRIMARY_MISSION_ID, approval.id, {
      decision,
      decidedBy,
      expectedRevision: decisionState.revision,
    });
    if (decision !== "approved") {
      const result = await this.runner.resolvePullRequestApproval(
        PRIMARY_MISSION_ID,
        pending,
        decision,
        implementation.id,
      );
      if (result !== null) {
        throw new MissionControlError("A denied delivery unexpectedly returned a pull request result.");
      }
      await this.blockPrimaryDelivery(
        `The operator ${decision} the protected delivery action; no pull request was created.`,
      );
      return mapMissionState(await this.missions.getState(), PRIMARY_MISSION_ID);
    }

    try {
      await this.missions.transitionSystemWorkItem(
        PRIMARY_MISSION_ID,
        implementation.id,
        "delivering",
        { trigger: "approval" },
      );
      const mission = await this.missions.getMission(PRIMARY_MISSION_ID);
      if (mission.status === "awaiting_approval") {
        await this.missions.transitionMission(PRIMARY_MISSION_ID, "verifying");
      }
      return await this.completePrimaryDelivery(
        decidedApproval,
        pending,
        decisionImplementation,
        approvedHeadSha,
      );
    } catch (error) {
      await this.recordMissionFailure(error);
      await this.blockPrimaryDelivery(error);
      throw error;
    }
  }

  private async resumePrimaryDelivery(workItem: WorkItem): Promise<void> {
    const state = await this.missions.getState();
    const approval = state.approvals
      .filter((item) =>
        item.missionId === PRIMARY_MISSION_ID &&
        item.workItemId === workItem.id &&
        item.attempt === workItem.attempt &&
        isPrimaryDeliveryApproval(item),
      )
      .at(-1);
    if (approval === undefined || approval.decision !== "approved") {
      throw new MissionControlError(
        "A delivering ticket requires a persisted approved delivery action before it can resume.",
      );
    }
    const implementation = state.workItems.find((item) => item.id === workItem.id);
    const handoff = state.handoffs
      .filter((item) => item.missionId === PRIMARY_MISSION_ID && item.workItemId === workItem.id)
      .at(-1);
    const review = state.reviews
      .filter((item) => item.missionId === PRIMARY_MISSION_ID && item.workItemId === workItem.id)
      .at(-1);
    if (implementation === undefined || handoff === undefined || review === undefined) {
      throw new MissionControlError(
        "The delivering ticket has no current proof and review correlation to resume.",
      );
    }
    requireCurrentDeliveryApprovalCorrelation(
      state,
      approval,
      implementation,
      handoff,
      review,
    );
    requireApprovalRepositoryProof(state, approval);
    const pending = deliveryApprovalFromState(approval);
    const approvedHeadSha = pending.target.headSha;
    if (approvedHeadSha === undefined) {
      throw new MissionControlError("The approved delivery has no verified head identity.");
    }
    try {
      if (implementation.status === "awaiting_approval") {
        await this.missions.transitionSystemWorkItem(
          PRIMARY_MISSION_ID,
          implementation.id,
          "delivering",
          { trigger: "approval" },
        );
      }
      const mission = await this.missions.getMission(PRIMARY_MISSION_ID);
      if (mission.status === "awaiting_approval") {
        await this.missions.transitionMission(PRIMARY_MISSION_ID, "verifying");
      }
      await this.completePrimaryDelivery(
        approval,
        pending,
        implementation,
        approvedHeadSha,
      );
    } catch (error) {
      await this.recordMissionFailure(error);
      await this.blockPrimaryDelivery(error);
      throw error;
    }
  }

  private async completePrimaryDelivery(
    approval: Approval,
    pending: TrueForgeDeliveryApproval,
    workItem: WorkItem,
    approvedHeadSha: string,
  ): Promise<MissionView> {
    const persistedReadback = persistedPullRequestReadback(
      await this.missions.getState(),
      approval,
      workItem,
    );
    const result = persistedReadback ?? await this.missions.executeProtectedAction(
        PRIMARY_MISSION_ID,
        {
          action: PRIMARY_CONSEQUENTIAL_ACTION,
          target: approval.target,
          expectedEffect: approval.expectedEffect,
          approvalId: approval.id,
        },
        () => this.runner.resolvePullRequestApproval(
          PRIMARY_MISSION_ID,
          pending,
          "approved",
          workItem.id,
        ),
      );
    if (result === null) {
      throw new MissionControlError("Approved delivery returned no pull request result.");
    }
    if (result.headSha !== approvedHeadSha) {
      throw new MissionControlError(
        "The delivered pull request head does not match the SHA approved by the operator.",
      );
    }
    const evidence = await this.missions.addEvidence(PRIMARY_MISSION_ID, {
      workItemId: workItem.id,
      kind: "tool_result",
      result: "passed",
      source: "trueforge",
      summary: `TrueForge created pull request #${result.number} in the approved fixture repository.`,
      details: JSON.stringify({
        tool: PRIMARY_CONSEQUENTIAL_ACTION,
        repository: `${PRIMARY_DELIVERY_TARGET.owner}/${PRIMARY_DELIVERY_TARGET.repo}`,
        base: PRIMARY_DELIVERY_TARGET.base,
        head: PRIMARY_DELIVERY_TARGET.head,
        head_sha: result.headSha,
        head_sha_verified: true,
        pull_request_number: result.number,
        pull_request_url: result.url,
        approval_id: approval.id,
        attempt: workItem.attempt,
      }),
      executionOrigin: {
        kind: "mcp",
        sessionId: result.sessionId,
        turnId: result.turnId,
        threadId: result.threadId,
        toolCallId: result.toolCallId,
      },
    });
    await this.missions.recordDelivery(PRIMARY_MISSION_ID, {
      status: "delivered",
      reference: result.url,
      approvalId: approval.id,
      workItemId: workItem.id,
      attempt: workItem.attempt,
      verificationSummary: `Verified evidence ${approval.evidenceIds.join(", ")} authorized the correlated pull request result ${evidence.id}.`,
      pullRequest: {
        number: result.number,
        url: result.url,
        repositoryOwner: PRIMARY_DELIVERY_TARGET.owner,
        repositoryName: PRIMARY_DELIVERY_TARGET.repo,
        base: PRIMARY_DELIVERY_TARGET.base,
        head: PRIMARY_DELIVERY_TARGET.head,
        headSha: result.headSha,
      },
      executionOrigin: {
        kind: "mcp",
        sessionId: result.sessionId,
        turnId: result.turnId,
        threadId: result.threadId,
        toolCallId: result.toolCallId,
      },
    });
    return mapMissionState(await this.missions.getState(), PRIMARY_MISSION_ID);
  }

  private async blockPrimaryDelivery(reason: unknown): Promise<void> {
    const message = missionFailureReason(reason);
    try {
      const state = await this.missions.getState();
      const workItem = state.workItems.find((item) =>
        item.missionId === PRIMARY_MISSION_ID &&
        item.assignedRole === "implementer" &&
        ["awaiting_approval", "delivering"].includes(item.status) &&
        item.claim !== undefined,
      );
      if (workItem !== undefined) {
        await this.missions.transitionSystemWorkItem(PRIMARY_MISSION_ID, workItem.id, "blocked", {
          trigger: "failure",
          reason: message,
        });
      }
      const mission = await this.missions.getMission(PRIMARY_MISSION_ID);
      if (![
        "blocked",
        "failed",
        "delivered",
      ].includes(mission.status) && missionTransitions[mission.status].includes("blocked")) {
        await this.missions.transitionMission(PRIMARY_MISSION_ID, "blocked");
      }
    } catch {
      // Preserve the original approval or delivery error when failure state is already durable.
    }
  }

  private async revalidatePrimaryDeliveryHead(
    target: PullRequestDeliveryTarget,
    workItemId?: string,
  ): Promise<void> {
    const result = await this.runner.inspectDeliveryHead({
      missionId: PRIMARY_MISSION_ID,
      target,
      ...(workItemId === undefined ? {} : { workItemId }),
    });
    const state = await this.missions.getState();
    const { evidence, headSha } = deliveryHeadProofFromResult(result, state);
    requireDeliveryHeadProof(evidence, target);
    if (headSha !== target.headSha) {
      throw new MissionControlError(
        "The delivery head changed after approval; the protected pull request action was not allowed.",
      );
    }
  }

  private async reviewImplementation(workItemId: string): Promise<ReviewOutcome> {
    const workItem = await this.missions.getWorkItem(PRIMARY_MISSION_ID, workItemId);
    if (workItem.status === "complete") {
      return "accepted";
    }
    if (workItem.status !== "ready_for_review" && workItem.status !== "proving") {
      throw new MissionControlError(
        "Independent verification requires the implementation to be ready for review.",
      );
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
    return decision.outcome;
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
    if (mission.status === "planning") {
      await this.missions.transitionMission(PRIMARY_MISSION_ID, "executing");
    }
    const current = await this.missions.getMission(PRIMARY_MISSION_ID);
    if (current.status === "blocked") {
      throw new MissionControlError(
        "Mission is blocked; inspect the durable failure record before retrying the same ticket.",
      );
    }
    if (!["executing", "awaiting_approval", "verifying"].includes(current.status)) {
      throw new MissionControlError(`Mission cannot run from ${current.status}.`);
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

  private async recordMissionFailure(error: unknown): Promise<void> {
    const reason = missionFailureReason(error);
    const classification = missionFailureClassification(error);
    try {
      const state = await this.missions.getState();
      const alreadyRecorded = state.evidence.some((item) =>
        item.missionId === PRIMARY_MISSION_ID &&
        item.result === "failed" &&
        evidenceDetails(item)?.reason === reason,
      );
      if (alreadyRecorded) {
        return;
      }
      const activeWorkItem = state.workItems.find((item) =>
        item.missionId === PRIMARY_MISSION_ID &&
        ["in_progress", "proving", "ready_for_review", "awaiting_approval", "delivering"].includes(item.status)
      );
      await this.missions.addEvidence(PRIMARY_MISSION_ID, {
        ...(activeWorkItem === undefined ? {} : { workItemId: activeWorkItem.id }),
        kind: "reviewer_finding",
        result: "failed",
        source: "system",
        summary: "Mission execution failed closed; inspect the diagnostic snapshot for the cause.",
        details: JSON.stringify({
          failure_layer: classification.layer,
          failure_category: classification.category,
          reason,
          ...(error instanceof TrueForgeIntegrationError
            ? { operation: error.operation }
            : {}),
        }),
      });
    } catch {
      // Preserve the original operation error when durable failure recording is unavailable.
    }
  }

  private async blockActiveWork(error?: unknown): Promise<void> {
    try {
      const state = await this.missions.getState();
      const active = state.workItems.find(
        (item) =>
          item.missionId === PRIMARY_MISSION_ID &&
          ["in_progress", "proving", "ready_for_review", "awaiting_approval", "delivering"].includes(item.status) &&
          item.claim !== undefined,
      );
      if (active !== undefined) {
        const reason = missionFailureReason(error ?? "TrueForge execution failed before the ticket could advance.");
        if (["in_progress", "proving", "awaiting_approval", "delivering"].includes(active.status)) {
          await this.missions.transitionSystemWorkItem(PRIMARY_MISSION_ID, active.id, "blocked", {
            trigger: "failure",
            reason,
          });
        } else {
          await this.missions.transitionWorkItem(PRIMARY_MISSION_ID, active.id, "blocked");
        }
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

function pullRequestApprovalTarget(target: PullRequestDeliveryTarget): string {
  const verifiedHead = target.headSha === undefined ? target.head : `${target.head}@${target.headSha}`;
  return `${target.owner}/${target.repo} base=${target.base} head=${verifiedHead}`;
}

function pullRequestExpectedEffect(target: PullRequestDeliveryTarget): string {
  const verifiedHead = target.headSha === undefined ? target.head : `${target.head} at ${target.headSha}`;
  return `Open one pull request in ${target.owner}/${target.repo} from verified head ${verifiedHead} into ${target.base}; do not merge or mutate any other repository state.`;
}

function approvalExecutionContext(
  pending: TrueForgeDeliveryApproval,
): NonNullable<Approval["executionContext"]> {
  const context: NonNullable<Approval["executionContext"]> = {
    sessionId: pending.sessionId,
    turnId: pending.turnId,
    threadId: pending.threadId,
    toolCallId: pending.toolCallId,
    serverName: pending.serverName,
    toolName: pending.toolName,
    repositoryOwner: pending.target.owner,
    repositoryName: pending.target.repo,
    base: pending.target.base,
    head: pending.target.head,
    title: pending.target.title,
    body: pending.target.body,
  };
  if (pending.target.headSha !== undefined) {
    context.headSha = pending.target.headSha;
  }
  return context;
}

function evidenceDetails(evidence: Evidence): Record<string, unknown> | null {
  if (evidence.details === undefined) {
    return null;
  }
  try {
    const details = JSON.parse(evidence.details) as unknown;
    return isRecord(details) ? details : null;
  } catch {
    return null;
  }
}

function latestEvidenceForAttempt(
  evidence: Evidence[],
  workItemId: string,
  attempt: number,
  source: Evidence["source"],
): Evidence | undefined {
  return evidence
    .filter((item) =>
      item.workItemId === workItemId &&
      item.source === source &&
      (item.attempt ?? 0) === attempt,
    )
    .at(-1);
}

function requireBaselineRepositoryProof(
  mission: Mission,
  evidence: Evidence,
): void {
  const repository = mission.repository;
  if (
    repository === undefined ||
    repository.owner !== PRIMARY_DELIVERY_FIXTURE.owner ||
    repository.name !== PRIMARY_DELIVERY_FIXTURE.repository ||
    repository.ref !== PRIMARY_DELIVERY_FIXTURE.baselineRef
  ) {
    throw new MissionControlError(
      "Delivery approval requires the mission to start from the pinned fixture baseline.",
    );
  }
  const details = evidenceDetails(evidence);
  const argumentsValue = details !== null && isRecord(details.arguments)
    ? details.arguments
    : null;
  const expectedUri =
    `repo://${repository.owner}/${repository.name}/sha/${PRIMARY_DELIVERY_FIXTURE.baselineSha}`;
  if (
    details === null ||
    argumentsValue === null ||
    details.tool !== "get_commit" ||
    details.provenance_kind !== "baseline" ||
    details.repository_owner !== repository.owner ||
    details.repository_name !== repository.name ||
    details.requested_ref !== repository.ref ||
    details.commit_sha !== PRIMARY_DELIVERY_FIXTURE.baselineSha ||
    details.uri !== expectedUri ||
    argumentsValue.owner !== repository.owner ||
    argumentsValue.repo !== repository.name ||
    argumentsValue.sha !== repository.ref ||
    argumentsValue.detail !== "full_patch"
  ) {
    throw new MissionControlError(
      "Delivery approval rejected evidence that does not prove the pinned baseline commit.",
    );
  }
}

function requireDeliveryHeadProof(
  evidence: Evidence,
  target: PullRequestDeliveryTarget,
): void {
  const details = evidenceDetails(evidence);
  const argumentsValue = details !== null && isRecord(details.arguments)
    ? details.arguments
    : null;
  const patches = details !== null && isRecord(details.patches) ? details.patches : null;
  const expectedPatchEntries = Object.entries(PRIMARY_VERIFIED_DELIVERY_PATCHES);
  const headSha = target.headSha;
  const patchesMatch = patches !== null &&
    Object.keys(patches).length === expectedPatchEntries.length &&
    expectedPatchEntries.every(([filename, patch]) => patches[filename] === patch);
  if (
    headSha === undefined ||
    !/^[0-9a-f]{40}$/i.test(headSha) ||
    headSha === PRIMARY_DELIVERY_FIXTURE.baselineSha ||
    details === null ||
    argumentsValue === null ||
    details.tool !== "get_commit" ||
    details.provenance_kind !== "delivery_head" ||
    details.repository_owner !== target.owner ||
    details.repository_name !== target.repo ||
    details.requested_ref !== target.head ||
    details.baseline_sha !== PRIMARY_DELIVERY_FIXTURE.baselineSha ||
    details.commit_sha !== headSha ||
    details.uri !== `repo://${target.owner}/${target.repo}/sha/${headSha}` ||
    argumentsValue.owner !== target.owner ||
    argumentsValue.repo !== target.repo ||
    argumentsValue.sha !== target.head ||
    argumentsValue.detail !== "full_patch" ||
    !patchesMatch
  ) {
    throw new MissionControlError(
      "Delivery approval rejected a head that is unchanged from baseline or does not match the verified implementation.",
    );
  }
}

function deliveryHeadProofFromResult(
  result: unknown,
  state: MissionState,
): { evidence: Evidence; headSha: string } {
  if (!isRecord(result) || typeof result.evidenceId !== "string" || typeof result.commitSha !== "string") {
    throw new MissionControlError("Delivery-head inspection returned no structured commit proof.");
  }
  const evidence = state.evidence.find((item) =>
    item.id === result.evidenceId &&
    item.missionId === PRIMARY_MISSION_ID &&
    item.source === "mcp" &&
    item.result === "passed"
  );
  if (evidence === undefined) {
    throw new MissionControlError("Delivery-head inspection evidence is not durable mission proof.");
  }
  return { evidence, headSha: result.commitSha };
}

function requireApprovalRepositoryProof(
  state: MissionState,
  approval: Approval,
): void {
  const mission = state.missions.find((item) => item.id === approval.missionId);
  const baselineEvidence = state.evidence.find((item) =>
    approval.evidenceIds.includes(item.id) &&
    item.missionId === approval.missionId &&
    item.source === "mcp" &&
    item.result === "passed" &&
    evidenceDetails(item)?.provenance_kind === "baseline"
  );
  const headEvidence = state.evidence.find((item) =>
    approval.evidenceIds.includes(item.id) &&
    item.missionId === approval.missionId &&
    item.source === "mcp" &&
    item.result === "passed" &&
    evidenceDetails(item)?.provenance_kind === "delivery_head"
  );
  const context = approval.executionContext;
  if (mission === undefined || baselineEvidence === undefined || headEvidence === undefined || context?.headSha === undefined) {
    throw new MissionControlError(
      "Delivery approval requires separate baseline and verified delivery-head provenance.",
    );
  }
  requireBaselineRepositoryProof(mission, baselineEvidence);
  requireDeliveryHeadProof(headEvidence, {
    owner: context.repositoryOwner,
    repo: context.repositoryName,
    base: context.base,
    head: context.head,
    headSha: context.headSha,
    title: context.title,
    body: context.body,
  });
}

function requireCurrentDeliveryApprovalCorrelation(
  state: MissionState,
  approval: Approval,
  workItem: WorkItem,
  handoff: Handoff,
  review: Review,
): void {
  const attempt = workItem.attempts.at(-1);
  const proofEvidenceIds = handoff.evidenceIds ?? [];
  const requiredEvidenceIds = [...new Set([
    ...proofEvidenceIds,
    review.findingEvidenceId,
  ])];
  if (
    !isPrimaryDeliveryApproval(approval) ||
    approval.workItemId !== workItem.id ||
    approval.attempt !== workItem.attempt ||
    (workItem.status !== "awaiting_approval" && workItem.status !== "delivering") ||
    attempt === undefined ||
    attempt.status !== workItem.status ||
    approval.handoffId !== handoff.id ||
    approval.reviewId !== review.id ||
    handoff.result !== "done" ||
    handoff.attempt !== workItem.attempt ||
    review.outcome !== "accepted" ||
    review.attempt !== workItem.attempt ||
    review.handoffId !== handoff.id ||
    (attempt.claim.trueforgeSandboxId !== undefined &&
      approval.trueforgeSandboxId !== attempt.claim.trueforgeSandboxId) ||
    requiredEvidenceIds.some((evidenceId) => !approval.evidenceIds.includes(evidenceId)) ||
    proofEvidenceIds.some((evidenceId) => {
      const evidence = state.evidence.find((item) => item.id === evidenceId);
      return !isDirectImplementationProofEvidence(evidence);
    }) ||
    requiredEvidenceIds.some((evidenceId) => {
      const evidence = state.evidence.find((item) => item.id === evidenceId);
      return evidence === undefined ||
        evidence.missionId !== PRIMARY_MISSION_ID ||
        evidence.workItemId !== workItem.id ||
        evidence.attempt !== workItem.attempt ||
        evidence.result !== "passed";
    })
  ) {
    throw new MissionControlError(
      "The delivery approval is stale or does not match the current proven implementation attempt.",
    );
  }
}

function isDirectImplementationProofEvidence(evidence: Evidence | undefined): boolean {
  return evidence?.source === "sandbox" &&
    evidence.result === "passed" &&
    evidenceDetails(evidence)?.proof_mode === IMPLEMENTATION_PROOF_MODE;
}

function persistedPullRequestReadback(
  state: MissionState,
  approval: Approval,
  workItem: WorkItem,
): TrueForgePullRequestResult | null {
  const context = approval.executionContext;
  if (context?.headSha === undefined) {
    return null;
  }
  const expectedUrlPrefix = `https://github.com/${context.repositoryOwner}/${context.repositoryName}/pull/`;
  const evidence = [...state.evidence].reverse().find((item) => {
    const details = evidenceDetails(item);
    return item.missionId === approval.missionId &&
      item.workItemId === workItem.id &&
      item.attempt === workItem.attempt &&
      item.source === "mcp" &&
      item.result === "passed" &&
      details?.tool === "pull_request_read" &&
      details.repository_owner === context.repositoryOwner &&
      details.repository_name === context.repositoryName &&
      details.base === context.base &&
      details.head === context.head &&
      details.head_sha === context.headSha &&
      typeof details.pull_request_number === "number" &&
      Number.isInteger(details.pull_request_number) &&
      details.pull_request_number > 0 &&
      typeof details.pull_request_url === "string" &&
      details.pull_request_url === `${expectedUrlPrefix}${details.pull_request_number}` &&
      item.executionOrigin?.kind === "mcp" &&
      item.executionOrigin.sessionId === context.sessionId;
  });
  if (evidence === undefined) {
    return null;
  }
  const details = evidenceDetails(evidence);
  const number = details?.pull_request_number;
  const url = details?.pull_request_url;
  if (typeof number !== "number" || typeof url !== "string") {
    return null;
  }
  return {
    number,
    url,
    headSha: context.headSha,
    sessionId: context.sessionId,
    turnId: evidence.executionOrigin?.turnId ?? context.turnId,
    threadId: context.threadId,
    toolCallId: context.toolCallId,
  };
}

function deliveryApprovalFromState(approval: Approval): TrueForgeDeliveryApproval {
  const context = approval.executionContext;
  if (!isPrimaryDeliveryApproval(approval) || context?.headSha === undefined) {
    throw new MissionControlError(
      "The persisted approval is not correlated to the exact fixture pull request action.",
    );
  }
  return {
    sessionId: context.sessionId,
    turnId: context.turnId,
    threadId: context.threadId,
    toolCallId: context.toolCallId,
    serverName: context.serverName,
    toolName: "create_pull_request",
    target: { ...PRIMARY_DELIVERY_TARGET, headSha: context.headSha },
  };
}

function isPrimaryDeliveryApproval(approval: Approval): boolean {
  const context = approval.executionContext;
  if (
    context === undefined ||
    context.headSha === undefined ||
    !/^[0-9a-f]{40}$/i.test(context.headSha) ||
    context.headSha === PRIMARY_DELIVERY_FIXTURE.baselineSha
  ) {
    return false;
  }
  const target = { ...PRIMARY_DELIVERY_TARGET, headSha: context.headSha };
  return (
    approval.actionType === PRIMARY_CONSEQUENTIAL_ACTION &&
    approval.target === pullRequestApprovalTarget(target) &&
    approval.expectedEffect === pullRequestExpectedEffect(target) &&
    context.toolName === PRIMARY_CONSEQUENTIAL_ACTION &&
    context.repositoryOwner === PRIMARY_DELIVERY_TARGET.owner &&
    context.repositoryName === PRIMARY_DELIVERY_TARGET.repo &&
    context.base === PRIMARY_DELIVERY_TARGET.base &&
    context.head === PRIMARY_DELIVERY_TARGET.head &&
    context.title === PRIMARY_DELIVERY_TARGET.title &&
    context.body === PRIMARY_DELIVERY_TARGET.body
  );
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
  const completed = workItems.filter((item) => ["done", "complete"].includes(item.status)).length;
  const implementationItems = workItems.filter((item) => item.assignedRole === "implementer");
  const reviewerItems = workItems.filter((item) => item.assignedRole === "reviewer");
  const latestSandboxPreparation = [...missionEvidence].reverse().find((item) =>
    item.source === "sandbox" &&
    item.workItemId === undefined &&
    item.summary.startsWith("Sandbox toolchain readiness")
  );
  const implementationExecutionFailed = implementationItems.some((item) =>
    item.status === "blocked" ||
    item.delegation?.status === "failed" ||
    item.delegation?.status === "interrupted"
  );
  const executionComplete = implementationItems.length > 0 &&
    implementationItems.every((item) => ["done", "complete"].includes(item.status));
  const executionFailed = implementationExecutionFailed || (
    !executionComplete && latestSandboxPreparation?.result === "failed"
  );
  const executionRunning = implementationItems.some((item) =>
    ["in_progress", "proving", "ready_for_review", "awaiting_approval", "delivering"].includes(item.status)
  ) || (
    !executionComplete &&
    !executionFailed &&
    (mission.status === "planning" || mission.status === "executing")
  );
  const execution = executionFailed
    ? "failed"
    : executionComplete
    ? "passed"
    : executionRunning
    ? "running"
    : "not_started";
  const repositoryProof = latestProofResultForRole(
    missionEvidence,
    workItems,
    "planner",
    "mcp",
  );
  const sandboxProof = latestProofResultForRole(
    missionEvidence,
    workItems,
    ["implementer", "reviewer"],
    "sandbox",
  );
  const currentProofFailed = repositoryProof === "failed" || sandboxProof === "failed";
  const currentProofPassed = repositoryProof === "passed" && sandboxProof === "passed";
  const verificationRunning = reviewerItems.some((item) =>
    item.status === "in_progress" || item.status === "ready_for_review"
  ) || mission.status === "verifying";
  const verification = currentProofFailed
    ? "failed"
    : (["awaiting_approval", "verifying", "delivered"].includes(mission.status)) && currentProofPassed
    ? "passed"
    : verificationRunning
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
    deliveryTarget: {
      owner: PRIMARY_DELIVERY_TARGET.owner,
      repo: PRIMARY_DELIVERY_TARGET.repo,
      base: PRIMARY_DELIVERY_TARGET.base,
      head: PRIMARY_DELIVERY_TARGET.head,
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
      execution,
      verification,
    },
    lanes: [
      lane("plan", "Plan", workItems.filter((item) => item.assignedRole === "planner")),
      lane("execute", "Execute", workItems.filter((item) => item.assignedRole === "implementer")),
      lane("prove", "Prove", workItems.filter((item) => item.assignedRole === "reviewer")),
      lane("approve", "Approve", []),
    ],
    tickets: workItems.map(mapTicket),
    activity,
    evidence,
    diagnostics: buildDiagnosticSnapshot(state, missionId),
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
        ...(item.attempt === undefined ? {} : { attempt: item.attempt }),
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
        ...(item.attempt === undefined ? {} : { attempt: item.attempt }),
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
        ...(item.workItemId === undefined ? {} : { workItemId: item.workItemId }),
        ...(item.attempt === undefined ? {} : { attempt: item.attempt }),
        ...(item.handoffId === undefined ? {} : { handoffId: item.handoffId }),
        ...(item.reviewId === undefined ? {} : { reviewId: item.reviewId }),
        ...(item.trueforgeSandboxId === undefined ? {} : { trueforgeSandboxId: item.trueforgeSandboxId }),
        ...(item.decidedBy === undefined ? {} : { decidedBy: item.decidedBy }),
        ...(item.decidedAt === undefined ? {} : { decidedAt: item.decidedAt }),
        ...(item.executionContext === undefined
          ? {}
          : { executionContext: { ...item.executionContext } }),
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
          ...(item.approvalId === undefined ? {} : { approvalId: item.approvalId }),
          ...(item.workItemId === undefined ? {} : { workItemId: item.workItemId }),
          ...(item.attempt === undefined ? {} : { attempt: item.attempt }),
          ...(item.pullRequest === undefined
            ? {}
            : { pullRequest: { ...item.pullRequest } }),
          ...(item.executionOrigin === undefined
            ? {}
            : { executionOrigin: { ...item.executionOrigin } }),
        };
        return delivery;
      }),
  };
}

function mapTicket(item: WorkItem): MissionView["tickets"][number] {
  return {
    id: item.id,
    title: item.title,
    purpose: item.purpose,
    acceptanceCriteria: [...item.acceptanceCriteria],
    status: item.status,
    dependsOn: [...item.dependsOn],
    ...(item.assignedRole === undefined ? {} : { assignedRole: item.assignedRole }),
    ...(item.requiredChecks === undefined ? {} : { requiredChecks: [...item.requiredChecks] }),
    ...(item.allowedFiles === undefined ? {} : { allowedFiles: [...item.allowedFiles] }),
    ...(item.executionAuthorization === undefined
      ? {}
      : { executionAuthorization: { ...item.executionAuthorization } }),
    ...(item.claim === undefined ? {} : { claim: { ...item.claim } }),
    attempt: item.attempt,
    attempts: item.attempts.map((attempt) => ({
      ...attempt,
      authorization: { ...attempt.authorization },
      requestedChanges: [...attempt.requestedChanges],
      claim: { ...attempt.claim },
    })),
    ...(item.requestedChanges === undefined
      ? {}
      : { requestedChanges: [...item.requestedChanges] }),
    ...(item.blockedReason === undefined ? {} : { blockedReason: item.blockedReason }),
    ...(item.delegation === undefined ? {} : { delegation: { ...item.delegation } }),
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
      ...(item.allowedFiles === undefined ? {} : { allowedFiles: [...item.allowedFiles] }),
      ...(item.delegation === undefined ? {} : { delegation: { ...item.delegation } }),
    })),
  };
}

function latestProofResultForRole(
  evidence: Evidence[],
  workItems: WorkItem[],
  role: "planner" | "implementer" | "reviewer" | ReadonlyArray<"planner" | "implementer" | "reviewer">,
  source: "mcp" | "sandbox",
): Evidence["result"] | undefined {
  const roles = new Set(Array.isArray(role) ? role : [role]);
  const workItemIds = new Set(
    workItems.filter((item) =>
      item.assignedRole !== undefined && roles.has(item.assignedRole)
    ).map((item) => item.id),
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
  if (evidence.workItemId !== undefined) {
    view.workItemId = evidence.workItemId;
  }
  if (evidence.attempt !== undefined) {
    view.attempt = evidence.attempt;
  }
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
    ...(evidence.workItemId === undefined ? {} : { workItemId: evidence.workItemId }),
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
      if (request.method === "GET" && url.pathname === "/api/mission/tickets") {
        return jsonResponse(await primaryTicketsResponse(options.missions));
      }
      if (request.method === "GET" && url.pathname === "/api/mission/work-items") {
        return jsonResponse(await primaryTicketsResponse(options.missions));
      }
      if (request.method === "GET" && url.pathname === "/api/mission/diagnostics") {
        return jsonResponse({ diagnostics: await controller.getPrimaryDiagnostics() });
      }
      if (request.method === "POST" && url.pathname === "/api/mission") {
        return jsonResponse({ mission: await controller.createOrOpenPrimaryMission() }, 201);
      }
      if (request.method === "POST" && url.pathname === "/api/mission/run") {
        return jsonResponse({ mission: await controller.runPrimaryMission() });
      }
      const ticketStatusRoute = url.pathname.match(
        /^\/api\/mission\/(?:tickets|work-items)\/([^/]+)\/status$/,
      );
      if (request.method === "PATCH" && ticketStatusRoute?.[1] !== undefined) {
        const body = await requestRecord(request, "Ticket transition body");
        const status = body.status;
        if (status !== "backlog" && status !== "ready") {
          throw new MissionDomainError(
            "invalid_transition",
            "Humans may move tickets between Backlog and Ready, or authorize Changes Requested rework by moving it to Ready; later states are system-owned.",
          );
        }
        const actor = requiredRequestString(body.actor, "actor");
        const expectedRevision = requestRevision(body);
        const ticket = await options.missions.moveWorkItemByHuman(
          PRIMARY_MISSION_ID,
          decodeURIComponent(ticketStatusRoute[1]),
          status,
          {
            actor,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
          },
        );
        return jsonResponse({
          revision: (await options.missions.getState()).revision,
          ticket: mapTicket(ticket),
        });
      }
      const ticketClaimRoute = url.pathname.match(
        /^\/api\/mission\/(?:tickets|work-items)\/([^/]+)\/claim$/,
      );
      if (request.method === "POST" && ticketClaimRoute?.[1] !== undefined) {
        const body = await requestRecord(request, "Ticket claim body");
        const owner = requiredRequestString(body.owner ?? body.agent, "owner");
        const expectedRevision = requestRevision(body);
        const ticket = await controller.claimPrimaryTicket(
          decodeURIComponent(ticketClaimRoute[1]),
          owner,
          expectedRevision,
        );
        return jsonResponse({
          revision: (await options.missions.getState()).revision,
          ticket: mapTicket(ticket),
        });
      }
      const approvalRoute = url.pathname.match(/^\/api\/mission\/approvals\/([^/]+)$/);
      if (request.method === "POST" && approvalRoute?.[1] !== undefined) {
        const { decision, decidedBy, expectedRevision } = await approvalDecisionFromRequest(request);
        return jsonResponse({
          mission: await controller.decidePrimaryDelivery(
            decodeURIComponent(approvalRoute[1]),
            decision,
            decidedBy,
            expectedRevision,
          ),
        });
      }
      return jsonResponse({ error: "not_found", message: "Route not found." }, 404);
    } catch (error) {
      const status = error instanceof MissionDomainError
        ? error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400
        : error instanceof TrueForgeIntegrationError || error instanceof MissionControlError
        ? 502
        : 500;
      const message = publicErrorMessage(error);
      const mission = await controller.getPrimaryMission().catch(() => null);
      return jsonResponse({ error: "operation_failed", message, mission }, status);
    }
  }
}

async function primaryTicketsResponse(missions: MissionService): Promise<{
  revision: number;
  mission: { id: string; objective: string; status: Mission["status"] } | null;
  tickets: MissionView["tickets"];
}> {
  const state = await missions.getState();
  const mission = state.missions.find((item) => item.id === PRIMARY_MISSION_ID);
  return {
    revision: state.revision,
    mission: mission === undefined
      ? null
      : { id: mission.id, objective: mission.objective, status: mission.status },
    tickets: state.workItems
      .filter((item) => item.missionId === PRIMARY_MISSION_ID)
      .map(mapTicket),
  };
}

async function requestRecord(
  request: Request,
  label: string,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new MissionDomainError("invalid_input", `${label} must be valid JSON.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MissionDomainError("invalid_input", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredRequestString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MissionDomainError("invalid_input", `${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requestRevision(body: Record<string, unknown>): number | undefined {
  const value = body.expected_revision ?? body.expectedRevision ?? body.expected_version;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new MissionDomainError(
      "invalid_input",
      "expected_revision must be a non-negative integer.",
    );
  }
  return value;
}

async function approvalDecisionFromRequest(
  request: Request,
): Promise<{
  decision: "approved" | "rejected" | "cancelled";
  decidedBy: string;
  expectedRevision?: number;
}> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new MissionDomainError("invalid_input", "Approval decision body must be valid JSON.");
  }
  if (!isRecord(value)) {
    throw new MissionDomainError("invalid_input", "Approval decision body must be an object.");
  }
  const decision = value.decision;
  if (decision !== "approved" && decision !== "rejected" && decision !== "cancelled") {
    throw new MissionDomainError("invalid_input", "Approval decision is not supported.");
  }
  const rawActor = value.actor ?? value.decided_by ?? value.decidedBy;
  const expectedRevision = requestRevision(value);
  return {
    decision,
    decidedBy: rawActor === undefined
      ? "mission-operator"
      : requiredRequestString(rawActor, "actor"),
    ...(expectedRevision === undefined
      ? {}
      : { expectedRevision }),
  };
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
    if (error.operation.includes("prepare sandbox")) {
      return sanitizePublicRuntimeError(error.message);
    }
    if (error.operation.includes("sandbox")) {
      return "Sandbox verification failed. Check the configured runtime and sandbox provider.";
    }
    if (error.operation.includes("delegate work item")) {
      return sanitizePublicRuntimeError(error.message);
    }
    if (error.operation.includes("collect implementation evidence")) {
      return sanitizePublicRuntimeError(error.message);
    }
    return "The execution runtime is unavailable or could not complete the requested operation.";
  }
  if (error instanceof MissionControlError) {
    return error.message.slice(0, 240);
  }
  if (error instanceof MissionDomainError) {
    if (/allowed file scope|outside .* scope|exit-preserving|content-bearing diff/i.test(error.message)) {
      return sanitizePublicRuntimeError(error.message);
    }
    if (["conflict", "invalid_transition", "dependency_blocked", "invalid_input"].includes(error.code)) {
      return error.message.slice(0, 240);
    }
    return error.code === "not_found"
      ? "The requested mission state was not found."
      : "The mission state operation could not be completed.";
  }
  return "Mission Control could not complete the requested operation.";
}

function missionFailureReason(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : "Mission Control encountered an unknown failure.";
  return message
    .replace(/authorization\s*[:=]\s*bearer\s+[^\s,;]+/gi, "[redacted]")
    .replace(/\b(?:api[_-]?key|token|password|secret|credential|cookie)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "[redacted]")
    .slice(0, 2_000);
}

function isRecoverableImplementationProofFailure(error: unknown): boolean {
  if (error instanceof TrueForgeIntegrationError) {
    return error.operation === "prove implementation" ||
      error.operation === "run sandbox verification";
  }
  return error instanceof MissionDomainError &&
    (error.code === "invalid_input" || error.code === "invalid_transition");
}

function missionFailureClassification(error: unknown): {
  layer: DiagnosticFailureLayer;
  category: DiagnosticFailureCategory;
} {
  if (error instanceof TrueForgeIntegrationError) {
    const operation = error.operation.toLowerCase();
    if (operation.includes("inspect") || operation.includes("repository")) {
      return { layer: "tool", category: "mcp" };
    }
    if (operation.includes("sandbox")) {
      return { layer: "tool", category: "sandbox" };
    }
    return { layer: "trueforge", category: "runtime" };
  }
  if (error instanceof MissionDomainError) {
    return { layer: "proof_board", category: "policy" };
  }
  return { layer: "proof_board", category: "pipeline" };
}

function sanitizePublicRuntimeError(message: string): string {
  return message
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .slice(0, 240);
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
