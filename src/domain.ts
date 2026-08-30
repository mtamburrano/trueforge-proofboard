import { randomUUID } from "node:crypto";

import {
  parseDelegatedWorkspaceDeltaEvidence,
  parseContentDiffEvidence,
} from "./diff.js";

export const missionStatuses = [
  "draft",
  "planning",
  "executing",
  "awaiting_approval",
  "verifying",
  "delivered",
  "failed",
  "blocked",
] as const;

export type MissionStatus = (typeof missionStatuses)[number];

/** Product-facing ticket lifecycle. Blocked is an exceptional failure state. */
export const ticketStatuses = [
  "backlog",
  "ready",
  "in_progress",
  "proving",
  "changes_requested",
  "awaiting_approval",
  "delivering",
  "done",
  "blocked",
] as const;

export const productLifecycleStatuses = ticketStatuses;
export type TicketStatus = (typeof ticketStatuses)[number];

/**
 * These values are accepted while reconnecting older mission snapshots. New
 * queue operations always write the product lifecycle values above.
 */
export const legacyWorkItemStatuses = ["ready_for_review", "complete"] as const;
export type LegacyWorkItemStatus = (typeof legacyWorkItemStatuses)[number];
export type WorkItemStatus = TicketStatus | LegacyWorkItemStatus;
export const workItemStatuses = ticketStatuses;
const persistedWorkItemStatuses = [...ticketStatuses, ...legacyWorkItemStatuses] as const;

export type WorkItemTransitionTrigger =
  | "human"
  | "claim"
  | "execution"
  | "proof"
  | "approval"
  | "delivery"
  | "failure"
  | "retry"
  | "legacy";

export interface WorkItemTransitionOptions {
  trigger?: WorkItemTransitionTrigger;
  actor?: string;
  expectedRevision?: number;
  reason?: string;
}

export interface WorkItemExecutionAuthorization {
  authorizedBy: string;
  authorizedAt: string;
}

export interface WorkItemClaim {
  owner: string;
  claimedAt: string;
  trueforgeSessionId?: string;
  trueforgeSandboxId?: string;
}

export const workItemAttemptStatuses = [
  "in_progress",
  "proving",
  "changes_requested",
  "awaiting_approval",
  "delivering",
  "done",
  "blocked",
] as const;
export type WorkItemAttemptStatus = (typeof workItemAttemptStatuses)[number];

/** Durable metadata for one bounded Ready-to-pipeline execution cycle. */
export interface WorkItemAttempt {
  number: number;
  authorization: WorkItemExecutionAuthorization;
  requestedChanges: string[];
  claim: WorkItemClaim;
  status: WorkItemAttemptStatus;
  retiredAt?: string;
  retiredBy?: string;
}

export interface HumanWorkItemTransitionInput {
  actor: string;
  expectedRevision?: number;
}

export interface ClaimWorkItemInput {
  owner: string;
  expectedRevision?: number;
  trueforgeSessionId?: string;
  trueforgeSandboxId?: string;
}

export const executionRoles = ["planner", "implementer", "reviewer"] as const;
export type ExecutionRole = (typeof executionRoles)[number];

export const MAX_WORK_GRAPH_ITEMS = 8;
export const MAX_WORK_ITEM_ACCEPTANCE_CRITERIA = 12;
export const MAX_WORK_ITEM_REQUIRED_CHECKS = 12;
export const MAX_WORK_ITEM_ALLOWED_FILES = 8;
export const MAX_WORK_ITEM_REQUESTED_CHANGES = 12;
export const implementationCheckResults = ["passed", "failed", "not_run"] as const;
export type ImplementationCheckResult = (typeof implementationCheckResults)[number];
export const executionOriginKinds = ["trueforge", "mcp", "sandbox", "tool"] as const;
export type ExecutionOriginKind = (typeof executionOriginKinds)[number];
export const delegationStatuses = ["running", "completed", "failed", "interrupted"] as const;
export type DelegationStatus = (typeof delegationStatuses)[number];
/** TrueForge emits root-agent tool events on the literal `main` thread. */
export const TRUEFORGE_ROOT_THREAD_ID = "main" as const;

export const evidenceKinds = [
  "test_result",
  "typecheck_result",
  "lint_result",
  "build_result",
  "diff_summary",
  "file_change",
  "reviewer_finding",
  "sandbox_log",
  "tool_result",
] as const;

export type EvidenceKind = (typeof evidenceKinds)[number];

export const evidenceResults = ["passed", "failed", "informational"] as const;
export type EvidenceResult = (typeof evidenceResults)[number];

export const evidenceSources = [
  "trueforge",
  "mcp",
  "sandbox",
  "agent",
  "reviewer",
  "human",
  "system",
] as const;

export type EvidenceSource = (typeof evidenceSources)[number];

export const handoffResults = ["done", "partial", "blocked"] as const;
export type HandoffResult = (typeof handoffResults)[number];
export const reviewOutcomes = ["accepted", "changes_requested", "blocked"] as const;
export type ReviewOutcome = (typeof reviewOutcomes)[number];

export const memoryImpacts = ["low", "medium", "high"] as const;
export type MemoryImpact = (typeof memoryImpacts)[number];

export const approvalDecisions = ["pending", "approved", "rejected", "cancelled"] as const;
export type ApprovalDecision = (typeof approvalDecisions)[number];

export const readOnlyActions = [
  "inspect_repository",
  "run_sandbox_verification",
] as const;
export type ReadOnlyAction = (typeof readOnlyActions)[number];

export const consequentialActions = ["create_pull_request"] as const;
export type ConsequentialAction = (typeof consequentialActions)[number];

export const PRIMARY_CONSEQUENTIAL_ACTION: ConsequentialAction = "create_pull_request";
export const APPROVAL_EXPIRATION_MS = 15 * 60 * 1_000;

export interface ActionPolicy {
  action: string;
  requiresApproval: boolean;
  rationale: string;
}

export function getActionPolicy(action: string): ActionPolicy {
  const normalized = action.trim();
  if (normalized.length === 0) {
    throw new MissionDomainError("invalid_input", "action must be a non-empty string.");
  }
  if (readOnlyActions.includes(normalized as ReadOnlyAction)) {
    return {
      action: normalized,
      requiresApproval: false,
      rationale: "Read-only discovery does not change the configured repository or external state.",
    };
  }
  if (consequentialActions.includes(normalized as ConsequentialAction)) {
    return {
      action: normalized,
      requiresApproval: true,
      rationale: "The action mutates a remote repository and requires explicit human approval.",
    };
  }
  return {
    action: normalized,
    requiresApproval: true,
    rationale: "Unclassified actions fail closed and require explicit human approval.",
  };
}

export function requiresHumanApproval(action: string): boolean {
  return getActionPolicy(action).requiresApproval;
}

export const deliveryStatuses = ["delivered", "failed"] as const;
export type DeliveryStatus = (typeof deliveryStatuses)[number];

export const missionTransitions: Readonly<{
  [status in MissionStatus]: readonly MissionStatus[];
}> = {
  draft: ["planning", "blocked"],
  planning: ["executing", "blocked", "failed"],
  executing: ["awaiting_approval", "verifying", "blocked", "failed"],
  awaiting_approval: ["verifying", "blocked", "failed"],
  verifying: ["awaiting_approval", "delivered", "blocked", "failed"],
  delivered: [],
  failed: [],
  blocked: ["planning", "executing", "failed"],
};

export const humanWorkItemTransitions: Readonly<{
  [status in TicketStatus]: readonly TicketStatus[];
}> = {
  backlog: ["ready"],
  ready: ["backlog"],
  in_progress: [],
  proving: [],
  changes_requested: ["ready"],
  awaiting_approval: [],
  delivering: [],
  done: [],
  blocked: [],
};

/** All persisted edges, including compatibility edges for pre-pivot snapshots. */
export const workItemTransitions: Readonly<{
  [status in WorkItemStatus]: readonly WorkItemStatus[];
}> = {
  backlog: ["ready", "blocked"],
  ready: ["backlog", "in_progress", "blocked"],
  in_progress: ["proving", "ready_for_review", "blocked"],
  proving: ["changes_requested", "awaiting_approval", "blocked"],
  changes_requested: ["blocked"],
  awaiting_approval: ["delivering", "blocked"],
  delivering: ["done", "blocked"],
  done: [],
  blocked: ["ready", "in_progress"],
  ready_for_review: ["complete", "blocked"],
  complete: [],
};

export interface RepositoryTarget {
  owner: string;
  name: string;
  ref: string;
}

export interface Mission {
  id: string;
  objective: string;
  status: MissionStatus;
  createdAt: string;
  updatedAt: string;
  repository?: RepositoryTarget;
  trueforgeSessionId?: string;
  trueforgeTurnId?: string;
  trueforgeSandboxId?: string;
  trueforgeWorkspaceBaselineTreeRef?: string;
}

export interface WorkItem {
  id: string;
  missionId: string;
  title: string;
  purpose: string;
  acceptanceCriteria: string[];
  status: WorkItemStatus;
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
  assignedRole?: ExecutionRole;
  requiredChecks?: string[];
  allowedFiles?: string[];
  executionAuthorization?: WorkItemExecutionAuthorization;
  /** A claim is intentionally retained after failure so work cannot be double-claimed. */
  claim?: WorkItemClaim;
  /** Number of bounded execution attempts that have been claimed. */
  attempt: number;
  /** Prior attempts remain immutable history even after their claim is retired. */
  attempts: WorkItemAttempt[];
  /** Concrete findings requested for the current rework authorization. */
  requestedChanges?: string[];
  blockedReason?: string;
  delegation?: WorkItemDelegation;
}

export interface WorkItemDelegation {
  owner: string;
  threadId: string;
  status: DelegationStatus;
  startedAt: string;
  updatedAt: string;
  turnId?: string;
  error?: string;
  startTreeRef?: string;
  missionStartTreeRef?: string;
}

export interface WorkGraphItem {
  id: string;
  title: string;
  purpose: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  assignedRole: ExecutionRole;
  requiredChecks?: string[];
  allowedFiles?: string[];
}

export interface WorkGraphDefinition {
  items: WorkGraphItem[];
}

export type WorkGraph = WorkGraphDefinition;
export type PlannedWorkItem = WorkGraphItem;

export interface ExecutionOrigin {
  kind: ExecutionOriginKind;
  sessionId: string;
  turnId?: string;
  threadId?: string;
  toolCallId?: string;
}

export type EvidenceOrigin = ExecutionOrigin;

export interface ImplementationCheck {
  name: string;
  command: string;
  result: ImplementationCheckResult;
  required: boolean;
  evidenceIds: string[];
  exitCode?: number;
}

export type HandoffCheck = ImplementationCheck;

export interface Evidence {
  id: string;
  missionId: string;
  kind: EvidenceKind;
  result: EvidenceResult;
  source: EvidenceSource;
  summary: string;
  createdAt: string;
  workItemId?: string;
  attempt?: number;
  details?: string;
  executionOrigin?: ExecutionOrigin;
}

export interface Handoff {
  id: string;
  missionId: string;
  workItemId: string;
  result: HandoffResult;
  summary: string;
  filesChanged: string[];
  testsRun: string[];
  decisions: string[];
  openQuestions: string[];
  componentsTouched: string[];
  memoryImpact: MemoryImpact;
  createdAt: string;
  attempt?: number;
  diffSummary?: string;
  checks?: ImplementationCheck[];
  evidenceIds?: string[];
  executionOrigin?: ExecutionOrigin;
}

export interface ReviewContext {
  workItem: WorkItem;
  handoff: Handoff;
  filesChanged: string[];
  actualFilesChanged: string[];
  actualDiff: string;
  diffSummary: string;
  checks: ImplementationCheck[];
  evidence: Evidence[];
}

export interface Review {
  id: string;
  missionId: string;
  workItemId: string;
  outcome: ReviewOutcome;
  reviewer: string;
  summary: string;
  finding: string;
  handoffId: string;
  filesChanged: string[];
  diffSummary: string;
  checks: ImplementationCheck[];
  evidenceIds: string[];
  findingEvidenceId: string;
  createdAt: string;
  attempt?: number;
}

export interface Approval {
  id: string;
  missionId: string;
  action: string;
  actionType: string;
  target: string;
  risk: string;
  rationale: string;
  expectedEffect: string;
  evidenceIds: string[];
  decision: ApprovalDecision;
  createdAt: string;
  expiresAt: string;
  decidedBy?: string;
  decidedAt?: string;
  workItemId?: string;
  attempt?: number;
  handoffId?: string;
  reviewId?: string;
  trueforgeSandboxId?: string;
  executionContext?: ApprovalExecutionContext;
}

export interface ApprovalExecutionContext {
  sessionId: string;
  turnId: string;
  threadId: string;
  toolCallId: string;
  serverName: string;
  toolName: string;
  repositoryOwner: string;
  repositoryName: string;
  base: string;
  head: string;
  headSha?: string;
  artifactHash?: string;
  title: string;
  body: string;
}

export interface PullRequestReference {
  number: number;
  url: string;
  repositoryOwner: string;
  repositoryName: string;
  base: string;
  head: string;
  headSha?: string;
}

export interface Delivery {
  id: string;
  missionId: string;
  status: DeliveryStatus;
  verificationSummary: string;
  createdAt: string;
  reference?: string;
  approvalId?: string;
  workItemId?: string;
  attempt?: number;
  pullRequest?: PullRequestReference;
  executionOrigin?: ExecutionOrigin;
}

export const deliveryAttemptStatuses = ["pending", "completed"] as const;
export type DeliveryAttemptStatus = (typeof deliveryAttemptStatuses)[number];

/** The exact remote effect that a durable delivery attempt is allowed to reconcile. */
export interface DeliveryAttemptTarget {
  repositoryOwner: string;
  repositoryName: string;
  base: string;
  head: string;
  headSha?: string;
  artifact?: DeliveryArtifact;
  title: string;
  body: string;
}

/** Exact sandbox artifact bound to a pending delivery approval. */
export interface DeliveryArtifact {
  baselineSha: string;
  files: Readonly<Record<string, string>>;
  patches: Readonly<Record<string, string>>;
  contentHash: string;
}

/** Durable intent and, once available, result for one approved remote mutation. */
export interface DeliveryAttempt {
  id: string;
  missionId: string;
  approvalId: string;
  workItemId: string;
  attempt: number;
  actionType: string;
  expectedEffect: string;
  target: DeliveryAttemptTarget;
  status: DeliveryAttemptStatus;
  createdAt: string;
  updatedAt: string;
  pullRequest?: PullRequestReference;
  executionOrigin?: ExecutionOrigin;
}

export interface MissionState {
  schemaVersion: 1;
  revision: number;
  missions: Mission[];
  workItems: WorkItem[];
  evidence: Evidence[];
  handoffs: Handoff[];
  reviews: Review[];
  approvals: Approval[];
  deliveries: Delivery[];
  deliveryAttempts: DeliveryAttempt[];
}

export interface MissionRepository {
  load(): Promise<MissionState | null>;
  save(state: MissionState): Promise<void>;
  saveIfRevision?(state: MissionState, expectedRevision: number): Promise<void>;
}

export interface CreateMissionInput {
  objective: string;
  id?: string;
  repository?: RepositoryTarget;
  trueforgeSessionId?: string;
  trueforgeSandboxId?: string;
}

export interface CreateWorkItemInput {
  title: string;
  purpose: string;
  acceptanceCriteria?: string[];
  acceptanceConditions?: string[];
  id?: string;
  dependsOn?: string[];
  assignedRole?: ExecutionRole;
  requiredChecks?: string[];
  allowedFiles?: string[];
  status?: "backlog" | "ready";
}

export interface StartWorkItemDelegationInput {
  owner: string;
  threadId: string;
  turnId?: string;
  startTreeRef?: string;
  missionStartTreeRef?: string;
}

export interface CompleteWorkItemDelegationInput {
  threadId: string;
  turnId?: string;
}

export interface FailWorkItemDelegationInput {
  threadId: string;
  error: string;
  turnId?: string;
  interrupted?: boolean;
}

export interface WorkItemExecutionBindingInput {
  trueforgeSessionId: string;
  trueforgeSandboxId?: string;
}

export interface RecordEvidenceInput {
  kind: EvidenceKind;
  result: EvidenceResult;
  source: EvidenceSource;
  summary: string;
  id?: string;
  workItemId?: string;
  details?: string;
  executionOrigin?: ExecutionOrigin;
}

export interface RecordHandoffInput {
  workItemId: string;
  result: HandoffResult;
  summary: string;
  filesChanged?: string[];
  testsRun?: string[];
  decisions?: string[];
  openQuestions?: string[];
  componentsTouched?: string[];
  memoryImpact?: MemoryImpact;
  id?: string;
  diffSummary?: string;
  checks?: ImplementationCheck[];
  evidenceIds?: string[];
  executionOrigin?: ExecutionOrigin;
}

export interface RecordReviewInput {
  workItemId: string;
  outcome: ReviewOutcome;
  summary: string;
  finding: string;
  reviewer?: string;
  id?: string;
}

export interface RequestApprovalInput {
  action: string;
  actionType?: string;
  target: string;
  risk?: string;
  rationale?: string;
  expectedEffect: string;
  evidenceIds?: string[];
  expiresAt?: string;
  id?: string;
  workItemId?: string;
  attempt?: number;
  handoffId?: string;
  reviewId?: string;
  trueforgeSandboxId?: string;
  executionContext?: ApprovalExecutionContext;
}

export interface ActionExecutionInput {
  action: string;
  target: string;
  expectedEffect: string;
  approvalId?: string;
}

export interface RecordDeliveryInput {
  status: DeliveryStatus;
  verificationSummary: string;
  reference?: string;
  approvalId?: string;
  id?: string;
  workItemId?: string;
  attempt?: number;
  pullRequest?: PullRequestReference;
  executionOrigin?: ExecutionOrigin;
}

export interface RecordDeliveryAttemptInput {
  approvalId: string;
  workItemId: string;
  attempt: number;
  actionType?: string;
  expectedEffect: string;
  target: DeliveryAttemptTarget;
  id?: string;
}

export interface DeliveryAttemptRecord {
  attempt: DeliveryAttempt;
  created: boolean;
}

export interface RecordDeliveryAttemptResultInput {
  pullRequest: PullRequestReference;
  executionOrigin: ExecutionOrigin;
}

export interface DecideApprovalInput {
  decision: "approved" | "rejected" | "cancelled";
  decidedBy: string;
  expectedRevision?: number;
}

export type MissionDomainErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "invalid_transition"
  | "dependency_blocked"
  | "approval_blocked"
  | "persistence_error";

export class MissionDomainError extends Error {
  readonly code: MissionDomainErrorCode;

  constructor(code: MissionDomainErrorCode, message: string) {
    super(message);
    this.name = "MissionDomainError";
    this.code = code;
  }
}

export function createEmptyMissionState(): MissionState {
  return {
    schemaVersion: 1,
    revision: 0,
    missions: [],
    workItems: [],
    evidence: [],
    handoffs: [],
    reviews: [],
    approvals: [],
    deliveries: [],
    deliveryAttempts: [],
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fail(code: MissionDomainErrorCode, message: string): never {
  throw new MissionDomainError(code, message);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("invalid_input", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    return fail("invalid_input", `${label} must be an array.`);
  }
  return value;
}

function requiredString(value: unknown, label: string, maxLength = 20_000): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fail("invalid_input", `${label} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    return fail("invalid_input", `${label} must be ${maxLength} characters or fewer.`);
  }
  return value.trim();
}

function optionalString(
  value: unknown,
  label: string,
  maxLength = 20_000,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredString(value, label, maxLength);
}

function optionalTreeRef(value: unknown, label: string): string | undefined {
  const ref = optionalString(value, label, 100);
  if (ref !== undefined && !/^[0-9a-fA-F]{40,64}$/.test(ref)) {
    return fail("invalid_input", `${label} must be a hexadecimal Git tree reference.`);
  }
  return ref;
}

function stringArray(value: unknown, label: string, maxItems = 200): string[] {
  const values = arrayValue(value, label);
  if (values.length > maxItems) {
    return fail("invalid_input", `${label} must contain ${maxItems} items or fewer.`);
  }
  const result = values.map((item, index) =>
    requiredString(item, `${label}[${index}]`, 2_000),
  );
  if (new Set(result).size !== result.length) {
    return fail("invalid_input", `${label} must not contain duplicates.`);
  }
  return result;
}

function optionalStringArray(
  value: unknown,
  label: string,
  maxItems = 200,
): string[] | undefined {
  return value === undefined ? undefined : stringArray(value, label, maxItems);
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") {
    return fail("invalid_input", `${label} must be a string.`);
  }
  if (value.length > maxLength) {
    return fail("invalid_input", `${label} must be ${maxLength} characters or fewer.`);
  }
  return value;
}

function filePathArray(
  value: unknown,
  label: string,
): string[] {
  const files = stringArray(value, label, MAX_WORK_ITEM_ALLOWED_FILES);
  for (const file of files) {
    if (
      file.startsWith("/") ||
      file.startsWith("\\") ||
      /^[A-Za-z]:[\\/]/.test(file) ||
      file.includes("\\") ||
      file.length > 500 ||
      file.includes("\u0000") ||
      /[\u0000-\u001f\u007f]/.test(file) ||
      file.includes("*") ||
      file.includes("?") ||
      file.includes("[") ||
      file.includes("]") ||
      /[;|&$`(){}<>"']/.test(file) ||
      file.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      return fail(
        "invalid_input",
        `${label} must contain safe repository-relative file paths without traversal or shell wildcards.`,
      );
    }
  }
  return files;
}

function optionalFilePathArray(
  value: unknown,
  label: string,
): string[] | undefined {
  return value === undefined ? undefined : filePathArray(value, label);
}

function stableGraphId(value: unknown, label: string): string {
  const result = identifier(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) {
    return fail(
      "invalid_input",
      `${label} must be a stable identifier containing only letters, numbers, dots, underscores, colons, or hyphens.`,
    );
  }
  return result;
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    return fail("invalid_input", `${label} must be one of: ${values.join(", ")}.`);
  }
  return value as T;
}

function assertAcyclicDependencies(
  items: ReadonlyArray<{ id: string; dependsOn: readonly string[] }>,
  label: string,
): void {
  const dependencies = new Map(items.map((item) => [item.id, item.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): void => {
    if (visiting.has(id)) {
      fail("invalid_input", `${label} contains a dependency cycle involving ${id}.`);
    }
    if (visited.has(id)) {
      return;
    }
    const itemDependencies = dependencies.get(id);
    if (itemDependencies === undefined) {
      fail("invalid_input", `${label} references an unknown dependency ${id}.`);
    }
    visiting.add(id);
    for (const dependencyId of itemDependencies) {
      visit(dependencyId);
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const item of items) {
    visit(item.id);
  }
}

export function validateWorkGraph(value: unknown): WorkGraphDefinition {
  const graph = objectValue(value, "workGraph");
  const rawItems = arrayValue(graph.items, "workGraph.items");
  if (rawItems.length === 0) {
    return fail("invalid_input", "workGraph.items must contain at least one work item.");
  }
  if (rawItems.length > MAX_WORK_GRAPH_ITEMS) {
    return fail(
      "invalid_input",
      `workGraph.items must contain ${MAX_WORK_GRAPH_ITEMS} items or fewer.`,
    );
  }

  const ids = new Set<string>();
  const items = rawItems.map((rawItem, index) => {
    const item = objectValue(rawItem, `workGraph.items[${index}]`);
    const id = stableGraphId(item.id, `workGraph.items[${index}].id`);
    if (ids.has(id)) {
      return fail("invalid_input", `workGraph contains a duplicated work item ID: ${id}.`);
    }
    ids.add(id);

    const rawAcceptanceCriteria = item.acceptanceCriteria ?? item.acceptanceConditions;
    if (rawAcceptanceCriteria === undefined) {
      return fail(
        "invalid_input",
        `workGraph.items[${index}].acceptanceCriteria must contain at least one condition.`,
      );
    }
    const acceptanceCriteria = stringArray(
      rawAcceptanceCriteria,
      `workGraph.items[${index}].acceptanceCriteria`,
      MAX_WORK_ITEM_ACCEPTANCE_CRITERIA,
    );
    if (acceptanceCriteria.length === 0) {
      return fail(
        "invalid_input",
        `workGraph.items[${index}].acceptanceCriteria must contain at least one condition.`,
      );
    }
    const rawDependencies = item.dependsOn ?? item.dependencies ?? [];
    const dependsOn = stringArray(
      rawDependencies,
      `workGraph.items[${index}].dependsOn`,
      MAX_WORK_GRAPH_ITEMS - 1,
    ).map((dependencyId) => stableGraphId(
      dependencyId,
      `workGraph.items[${index}].dependsOn item`,
    ));
    if (dependsOn.includes(id)) {
      return fail("invalid_input", `workGraph item ${id} cannot depend on itself.`);
    }
    const assignedRole = item.assignedRole ?? item.role;
    const requiredChecks = optionalStringArray(
      item.requiredChecks,
      `workGraph.items[${index}].requiredChecks`,
      MAX_WORK_ITEM_REQUIRED_CHECKS,
    );
    const allowedFiles = optionalFilePathArray(
      item.allowedFiles,
      `workGraph.items[${index}].allowedFiles`,
    );
    if (assignedRole === "implementer" && (allowedFiles === undefined || allowedFiles.length === 0)) {
      return fail(
        "invalid_input",
        `workGraph.items[${index}].allowedFiles must identify the bounded files an implementer may change.`,
      );
    }
    const result: WorkGraphItem = {
      id,
      title: requiredString(item.title, `workGraph.items[${index}].title`, 500),
      purpose: requiredString(item.purpose, `workGraph.items[${index}].purpose`, 4_000),
      acceptanceCriteria,
      dependsOn,
      assignedRole: enumValue(
        assignedRole,
        executionRoles,
        `workGraph.items[${index}].assignedRole`,
      ),
    };
    if (requiredChecks !== undefined) {
      if (requiredChecks.length === 0) {
        return fail(
          "invalid_input",
          `workGraph.items[${index}].requiredChecks must contain at least one check.`,
        );
      }
      result.requiredChecks = requiredChecks;
    }
    if (allowedFiles !== undefined) {
      result.allowedFiles = allowedFiles;
    }
    return result;
  });

  const knownIds = new Set(items.map((item) => item.id));
  for (const item of items) {
    for (const dependencyId of item.dependsOn) {
      if (!knownIds.has(dependencyId)) {
        return fail(
          "invalid_input",
          `workGraph item ${item.id} references an unknown dependency: ${dependencyId}.`,
        );
      }
    }
  }
  assertAcyclicDependencies(items, "workGraph");
  if (!items.some((item) => item.dependsOn.length === 0)) {
    return fail("invalid_input", "workGraph must contain at least one executable root.");
  }
  return { items };
}

function timestamp(value: unknown, label: string): string {
  const result = requiredString(value, label, 100);
  if (Number.isNaN(Date.parse(result))) {
    return fail("invalid_input", `${label} must be a valid timestamp.`);
  }
  return result;
}

function normalizeActionType(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if ([
    "create_pull_request",
    "create_a_pull_request",
    "open_pull_request",
    "open_a_pull_request",
    "open_the_verified_delivery",
  ].includes(slug)) {
    return PRIMARY_CONSEQUENTIAL_ACTION;
  }
  return slug;
}

function defaultApprovalExpiry(createdAt: string): string {
  return new Date(Date.parse(createdAt) + APPROVAL_EXPIRATION_MS).toISOString();
}

function approvalIsExpired(approval: Approval, now: string): boolean {
  return Date.parse(approval.expiresAt) <= Date.parse(now);
}

function identifier(value: unknown, label: string): string {
  return requiredString(value, label, 200);
}

function normalizedId(value: string, label: string): string {
  return identifier(value, label);
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function normalizeRepository(value: unknown, label = "repository"): RepositoryTarget {
  const repository = objectValue(value, label);
  return {
    owner: requiredString(repository.owner, `${label}.owner`, 200),
    name: requiredString(repository.name, `${label}.name`, 200),
    ref: requiredString(repository.ref, `${label}.ref`, 200),
  };
}

function validateMission(value: unknown, label: string): Mission {
  const mission = objectValue(value, label);
  const repository =
    mission.repository === undefined
      ? undefined
      : normalizeRepository(mission.repository, `${label}.repository`);
  const trueforgeSessionId = optionalString(
    mission.trueforgeSessionId,
    `${label}.trueforgeSessionId`,
    200,
  );
  const trueforgeTurnId = optionalString(mission.trueforgeTurnId, `${label}.trueforgeTurnId`, 200);
  const trueforgeSandboxId = optionalString(
    mission.trueforgeSandboxId,
    `${label}.trueforgeSandboxId`,
    200,
  );
  const trueforgeWorkspaceBaselineTreeRef = optionalTreeRef(
    mission.trueforgeWorkspaceBaselineTreeRef,
    `${label}.trueforgeWorkspaceBaselineTreeRef`,
  );
  const result: Mission = {
    id: identifier(mission.id, `${label}.id`),
    objective: requiredString(mission.objective, `${label}.objective`),
    status: enumValue(mission.status, missionStatuses, `${label}.status`),
    createdAt: timestamp(mission.createdAt, `${label}.createdAt`),
    updatedAt: timestamp(mission.updatedAt, `${label}.updatedAt`),
  };
  if (repository !== undefined) {
    result.repository = repository;
  }
  if (trueforgeSessionId !== undefined) {
    result.trueforgeSessionId = trueforgeSessionId;
  }
  if (trueforgeTurnId !== undefined) {
    result.trueforgeTurnId = trueforgeTurnId;
  }
  if (trueforgeSandboxId !== undefined) {
    result.trueforgeSandboxId = trueforgeSandboxId;
  }
  if (trueforgeWorkspaceBaselineTreeRef !== undefined) {
    result.trueforgeWorkspaceBaselineTreeRef = trueforgeWorkspaceBaselineTreeRef;
  }
  return result;
}

function validateWorkItemDelegation(
  value: unknown,
  label: string,
): WorkItemDelegation {
  const delegation = objectValue(value, label);
  const turnId = optionalString(delegation.turnId, `${label}.turnId`, 200);
  const error = optionalString(delegation.error, `${label}.error`, 2_000);
  const startTreeRef = optionalTreeRef(delegation.startTreeRef, `${label}.startTreeRef`);
  const missionStartTreeRef = optionalTreeRef(
    delegation.missionStartTreeRef,
    `${label}.missionStartTreeRef`,
  );
  if ((startTreeRef === undefined) !== (missionStartTreeRef === undefined)) {
    return fail(
      "invalid_input",
      `${label}.startTreeRef and ${label}.missionStartTreeRef must be provided together.`,
    );
  }
  const result: WorkItemDelegation = {
    owner: requiredString(delegation.owner, `${label}.owner`, 200),
    threadId: requiredString(delegation.threadId, `${label}.threadId`, 200),
    status: enumValue(delegation.status, delegationStatuses, `${label}.status`),
    startedAt: timestamp(delegation.startedAt, `${label}.startedAt`),
    updatedAt: timestamp(delegation.updatedAt, `${label}.updatedAt`),
  };
  if (turnId !== undefined) {
    result.turnId = turnId;
  }
  if (error !== undefined) {
    result.error = error;
  }
  if (startTreeRef !== undefined && missionStartTreeRef !== undefined) {
    result.startTreeRef = startTreeRef;
    result.missionStartTreeRef = missionStartTreeRef;
  }
  return result;
}

function validateWorkItemExecutionAuthorization(
  value: unknown,
  label: string,
): WorkItemExecutionAuthorization {
  const authorization = objectValue(value, label);
  return {
    authorizedBy: requiredString(authorization.authorizedBy, `${label}.authorizedBy`, 200),
    authorizedAt: timestamp(authorization.authorizedAt, `${label}.authorizedAt`),
  };
}

function validateWorkItemClaim(value: unknown, label: string): WorkItemClaim {
  const claim = objectValue(value, label);
  const trueforgeSessionId = optionalString(
    claim.trueforgeSessionId,
    `${label}.trueforgeSessionId`,
    200,
  );
  const trueforgeSandboxId = optionalString(
    claim.trueforgeSandboxId,
    `${label}.trueforgeSandboxId`,
    200,
  );
  const result: WorkItemClaim = {
    owner: requiredString(claim.owner, `${label}.owner`, 200),
    claimedAt: timestamp(claim.claimedAt, `${label}.claimedAt`),
  };
  if (trueforgeSessionId !== undefined) {
    result.trueforgeSessionId = trueforgeSessionId;
  }
  if (trueforgeSandboxId !== undefined) {
    result.trueforgeSandboxId = trueforgeSandboxId;
  }
  return result;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return fail("invalid_input", `${label} must be a non-negative integer.`);
  }
  return value;
}

function validateWorkItemAttempt(value: unknown, label: string): WorkItemAttempt {
  const attempt = objectValue(value, label);
  const requestedChanges = stringArray(
    attempt.requestedChanges ?? [],
    `${label}.requestedChanges`,
    MAX_WORK_ITEM_REQUESTED_CHANGES,
  );
  const retiredAt = attempt.retiredAt === undefined
    ? undefined
    : timestamp(attempt.retiredAt, `${label}.retiredAt`);
  const retiredBy = attempt.retiredBy === undefined
    ? undefined
    : requiredString(attempt.retiredBy, `${label}.retiredBy`, 200);
  const result: WorkItemAttempt = {
    number: nonNegativeInteger(attempt.number, `${label}.number`),
    authorization: validateWorkItemExecutionAuthorization(
      attempt.authorization,
      `${label}.authorization`,
    ),
    requestedChanges,
    claim: validateWorkItemClaim(attempt.claim, `${label}.claim`),
    status: enumValue(attempt.status, workItemAttemptStatuses, `${label}.status`),
  };
  if (retiredAt !== undefined) {
    result.retiredAt = retiredAt;
  }
  if (retiredBy !== undefined) {
    result.retiredBy = retiredBy;
  }
  if (result.number === 0) {
    return fail("invalid_input", `${label}.number must be greater than zero.`);
  }
  if ((retiredAt === undefined) !== (retiredBy === undefined)) {
    return fail("invalid_input", `${label}.retiredAt and ${label}.retiredBy must be provided together.`);
  }
  return result;
}

function validateWorkItem(value: unknown, label: string): WorkItem {
  const workItem = objectValue(value, label);
  const assignedRole = optionalString(workItem.assignedRole, `${label}.assignedRole`, 30);
  const requiredChecks = optionalStringArray(
    workItem.requiredChecks,
    `${label}.requiredChecks`,
    MAX_WORK_ITEM_REQUIRED_CHECKS,
  );
  const allowedFiles = optionalFilePathArray(workItem.allowedFiles, `${label}.allowedFiles`);
  const blockedReason = optionalString(workItem.blockedReason, `${label}.blockedReason`, 2_000);
  const requestedChanges = optionalStringArray(
    workItem.requestedChanges,
    `${label}.requestedChanges`,
    MAX_WORK_ITEM_REQUESTED_CHANGES,
  );
  const rawAttempts = workItem.attempts === undefined
    ? []
    : arrayValue(workItem.attempts, `${label}.attempts`);
  const attempts = rawAttempts.map((item, index) =>
    validateWorkItemAttempt(item, `${label}.attempts[${index}]`),
  );
  const attempt = workItem.attempt === undefined
    ? attempts.at(-1)?.number ?? 0
    : nonNegativeInteger(workItem.attempt, `${label}.attempt`);
  if (attempts.length > 0 && attempts.at(-1)?.number !== attempt) {
    return fail("invalid_input", `${label}.attempt must match the latest attempt history entry.`);
  }
  if (attempts.length === 0 && attempt !== 0) {
    return fail("invalid_input", `${label}.attempt requires attempt history.`);
  }
  for (const [index, item] of attempts.entries()) {
    if (item.number !== index + 1) {
      return fail("invalid_input", `${label}.attempts must be numbered consecutively from one.`);
    }
  }
  const rawAcceptanceCriteria = workItem.acceptanceCriteria ?? workItem.acceptanceConditions;
  const acceptanceCriteria = rawAcceptanceCriteria === undefined
    ? []
    : stringArray(
        rawAcceptanceCriteria,
        `${label}.acceptanceCriteria`,
        MAX_WORK_ITEM_ACCEPTANCE_CRITERIA,
      );
  const result: WorkItem = {
    id: identifier(workItem.id, `${label}.id`),
    missionId: identifier(workItem.missionId, `${label}.missionId`),
    title: requiredString(workItem.title, `${label}.title`, 500),
    purpose: requiredString(workItem.purpose, `${label}.purpose`, 4_000),
    acceptanceCriteria,
    status: enumValue(workItem.status, persistedWorkItemStatuses, `${label}.status`),
    dependsOn: stringArray(workItem.dependsOn, `${label}.dependsOn`),
    createdAt: timestamp(workItem.createdAt, `${label}.createdAt`),
    updatedAt: timestamp(workItem.updatedAt, `${label}.updatedAt`),
    attempt,
    attempts,
  };
  if (assignedRole !== undefined) {
    result.assignedRole = enumValue(assignedRole, executionRoles, `${label}.assignedRole`);
  }
  if (requiredChecks !== undefined) {
    if (requiredChecks.length === 0) {
      return fail("invalid_input", `${label}.requiredChecks must contain at least one check.`);
    }
    result.requiredChecks = requiredChecks;
  }
  if (allowedFiles !== undefined) {
    result.allowedFiles = allowedFiles;
  }
  if (workItem.executionAuthorization !== undefined) {
    result.executionAuthorization = validateWorkItemExecutionAuthorization(
      workItem.executionAuthorization,
      `${label}.executionAuthorization`,
    );
  }
  if (workItem.claim !== undefined) {
    result.claim = validateWorkItemClaim(workItem.claim, `${label}.claim`);
  }
  if (requestedChanges !== undefined) {
    result.requestedChanges = requestedChanges;
  }
  if (blockedReason !== undefined) {
    result.blockedReason = blockedReason;
  }
  if (workItem.delegation !== undefined) {
    result.delegation = validateWorkItemDelegation(workItem.delegation, `${label}.delegation`);
  }
  return result;
}

function validateExecutionOrigin(value: unknown, label: string): ExecutionOrigin {
  const origin = objectValue(value, label);
  const turnId = optionalString(origin.turnId, `${label}.turnId`, 200);
  const threadId = optionalString(origin.threadId, `${label}.threadId`, 200);
  const toolCallId = optionalString(origin.toolCallId, `${label}.toolCallId`, 200);
  const result: ExecutionOrigin = {
    kind: enumValue(origin.kind, executionOriginKinds, `${label}.kind`),
    sessionId: requiredString(origin.sessionId, `${label}.sessionId`, 200),
  };
  if (turnId !== undefined) {
    result.turnId = turnId;
  }
  if (threadId !== undefined) {
    result.threadId = threadId;
  }
  if (toolCallId !== undefined) {
    result.toolCallId = toolCallId;
  }
  return result;
}

function validateImplementationCheck(value: unknown, label: string): ImplementationCheck {
  const check = objectValue(value, label);
  const evidenceIds = stringArray(check.evidenceIds, `${label}.evidenceIds`, 100);
  const rawExitCode = check.exitCode;
  if (
    rawExitCode !== undefined &&
    (typeof rawExitCode !== "number" || !Number.isInteger(rawExitCode) || rawExitCode < 0)
  ) {
    return fail("invalid_input", `${label}.exitCode must be a non-negative integer when provided.`);
  }
  const result = enumValue(
    check.result,
    implementationCheckResults,
    `${label}.result`,
  );
  if (typeof check.required !== "boolean") {
    return fail("invalid_input", `${label}.required must be a boolean.`);
  }
  if (result === "passed" && rawExitCode !== undefined && rawExitCode !== 0) {
    return fail("invalid_input", `${label} contradicts a passed result with a non-zero exit code.`);
  }
  if (result === "failed" && rawExitCode === 0) {
    return fail("invalid_input", `${label} contradicts a failed result with a zero exit code.`);
  }
  if (result === "not_run" && (rawExitCode !== undefined || evidenceIds.length > 0)) {
    return fail("invalid_input", `${label} cannot include execution evidence when not_run.`);
  }
  if (result !== "not_run" && evidenceIds.length === 0) {
    return fail("invalid_input", `${label} needs evidenceIds for an executed check.`);
  }
  const output: ImplementationCheck = {
    name: requiredString(check.name, `${label}.name`, 200),
    command: requiredString(check.command, `${label}.command`, 2_000),
    result,
    required: check.required,
    evidenceIds,
  };
  if (rawExitCode !== undefined) {
    output.exitCode = rawExitCode;
  }
  return output;
}

interface StructuredHandoffFields {
  diffSummary: string;
  checks: ImplementationCheck[];
  evidenceIds: string[];
  executionOrigin: ExecutionOrigin;
}

function validateStructuredHandoffFields(
  value: Record<string, unknown>,
  label: string,
  result: HandoffResult,
  filesChanged: string[],
): StructuredHandoffFields | null {
  const rawFields = [
    value.diffSummary,
    value.checks,
    value.evidenceIds,
    value.executionOrigin,
  ];
  if (rawFields.every((field) => field === undefined)) {
    return null;
  }
  if (rawFields.some((field) => field === undefined)) {
    return fail(
      "invalid_input",
      `${label} must include diffSummary, checks, evidenceIds, and executionOrigin together.`,
    );
  }
  if (filesChanged.length === 0) {
    return fail("invalid_input", `${label}.filesChanged must identify changed files.`);
  }
  const rawChecks = arrayValue(value.checks, `${label}.checks`);
  if (rawChecks.length === 0 || rawChecks.length > MAX_WORK_ITEM_REQUIRED_CHECKS) {
    return fail(
      "invalid_input",
      `${label}.checks must contain between 1 and ${MAX_WORK_ITEM_REQUIRED_CHECKS} checks.`,
    );
  }
  const checks = rawChecks.map((check, index) =>
    validateImplementationCheck(check, `${label}.checks[${index}]`),
  );
  if (new Set(checks.map((check) => check.name)).size !== checks.length) {
    return fail("invalid_input", `${label}.checks must not contain duplicate names.`);
  }
  if (!checks.some((check) => check.required)) {
    return fail("invalid_input", `${label}.checks must include at least one required check.`);
  }
  if (
    result === "done" &&
    checks.some((check) => check.required && check.result !== "passed")
  ) {
    return fail("invalid_input", `${label} cannot be done while a required check is not passed.`);
  }
  return {
    diffSummary: requiredString(value.diffSummary, `${label}.diffSummary`, 4_000),
    checks,
    evidenceIds: (() => {
      const evidenceIds = stringArray(value.evidenceIds, `${label}.evidenceIds`, 100);
      if (evidenceIds.length === 0) {
        return fail("invalid_input", `${label}.evidenceIds must contain supporting evidence.`);
      }
      return evidenceIds;
    })(),
    executionOrigin: validateExecutionOrigin(value.executionOrigin, `${label}.executionOrigin`),
  };
}

function validateEvidence(value: unknown, label: string): Evidence {
  const evidence = objectValue(value, label);
  const workItemId = optionalString(evidence.workItemId, `${label}.workItemId`, 200);
  const attempt = evidence.attempt === undefined
    ? undefined
    : nonNegativeInteger(evidence.attempt, `${label}.attempt`);
  const details = optionalString(evidence.details, `${label}.details`);
  const executionOrigin = evidence.executionOrigin === undefined
    ? undefined
    : validateExecutionOrigin(evidence.executionOrigin, `${label}.executionOrigin`);
  const result: Evidence = {
    id: identifier(evidence.id, `${label}.id`),
    missionId: identifier(evidence.missionId, `${label}.missionId`),
    kind: enumValue(evidence.kind, evidenceKinds, `${label}.kind`),
    result: enumValue(evidence.result, evidenceResults, `${label}.result`),
    source: enumValue(evidence.source, evidenceSources, `${label}.source`),
    summary: requiredString(evidence.summary, `${label}.summary`),
    createdAt: timestamp(evidence.createdAt, `${label}.createdAt`),
  };
  if (workItemId !== undefined) {
    result.workItemId = workItemId;
  }
  if (attempt !== undefined) {
    result.attempt = attempt;
  }
  if (details !== undefined) {
    result.details = details;
  }
  if (executionOrigin !== undefined) {
    result.executionOrigin = executionOrigin;
  }
  return result;
}

function validateHandoff(value: unknown, label: string): Handoff {
  const handoff = objectValue(value, label);
  const result = enumValue(handoff.result, handoffResults, `${label}.result`);
  const filesChanged = stringArray(handoff.filesChanged, `${label}.filesChanged`);
  const attempt = handoff.attempt === undefined
    ? undefined
    : nonNegativeInteger(handoff.attempt, `${label}.attempt`);
  const output: Handoff = {
    id: identifier(handoff.id, `${label}.id`),
    missionId: identifier(handoff.missionId, `${label}.missionId`),
    workItemId: identifier(handoff.workItemId, `${label}.workItemId`),
    result,
    summary: requiredString(handoff.summary, `${label}.summary`),
    filesChanged,
    testsRun: stringArray(handoff.testsRun, `${label}.testsRun`),
    decisions: stringArray(handoff.decisions, `${label}.decisions`),
    openQuestions: stringArray(handoff.openQuestions, `${label}.openQuestions`),
    componentsTouched: stringArray(handoff.componentsTouched, `${label}.componentsTouched`),
    memoryImpact: enumValue(handoff.memoryImpact, memoryImpacts, `${label}.memoryImpact`),
    createdAt: timestamp(handoff.createdAt, `${label}.createdAt`),
  };
  if (attempt !== undefined) {
    output.attempt = attempt;
  }
  const structured = validateStructuredHandoffFields(handoff, label, result, filesChanged);
  if (structured !== null) {
    output.diffSummary = structured.diffSummary;
    output.checks = structured.checks;
    output.evidenceIds = structured.evidenceIds;
    output.executionOrigin = structured.executionOrigin;
  }
  return output;
}

function validateReview(value: unknown, label: string): Review {
  const review = objectValue(value, label);
  const outcome = enumValue(review.outcome, reviewOutcomes, `${label}.outcome`);
  const filesChanged = stringArray(review.filesChanged, `${label}.filesChanged`);
  if (filesChanged.length === 0) {
    return fail("invalid_input", `${label}.filesChanged must identify changed files.`);
  }
  const rawChecks = arrayValue(review.checks, `${label}.checks`);
  if (rawChecks.length === 0 || rawChecks.length > MAX_WORK_ITEM_REQUIRED_CHECKS) {
    return fail(
      "invalid_input",
      `${label}.checks must contain between 1 and ${MAX_WORK_ITEM_REQUIRED_CHECKS} checks.`,
    );
  }
  const checks = rawChecks.map((check, index) =>
    validateImplementationCheck(check, `${label}.checks[${index}]`),
  );
  if (new Set(checks.map((check) => check.name)).size !== checks.length) {
    return fail("invalid_input", `${label}.checks must not contain duplicate names.`);
  }
  if (outcome === "accepted" && checks.some((check) => check.required && check.result !== "passed")) {
    return fail("invalid_input", `${label} cannot be accepted while a required check is not passed.`);
  }
  const evidenceIds = stringArray(review.evidenceIds, `${label}.evidenceIds`, 100);
  if (evidenceIds.length === 0) {
    return fail("invalid_input", `${label}.evidenceIds must contain the reviewed evidence.`);
  }
  const attempt = review.attempt === undefined
    ? undefined
    : nonNegativeInteger(review.attempt, `${label}.attempt`);
  const output: Review = {
    id: identifier(review.id, `${label}.id`),
    missionId: identifier(review.missionId, `${label}.missionId`),
    workItemId: identifier(review.workItemId, `${label}.workItemId`),
    outcome,
    reviewer: requiredString(review.reviewer, `${label}.reviewer`, 200),
    summary: requiredString(review.summary, `${label}.summary`, 4_000),
    finding: requiredString(review.finding, `${label}.finding`, 4_000),
    handoffId: identifier(review.handoffId, `${label}.handoffId`),
    filesChanged,
    diffSummary: requiredString(review.diffSummary, `${label}.diffSummary`, 4_000),
    checks,
    evidenceIds,
    findingEvidenceId: identifier(review.findingEvidenceId, `${label}.findingEvidenceId`),
    createdAt: timestamp(review.createdAt, `${label}.createdAt`),
  };
  if (attempt !== undefined) {
    output.attempt = attempt;
  }
  return output;
}

function validateApproval(value: unknown, label: string): Approval {
  const approval = objectValue(value, label);
  const action = requiredString(approval.action, `${label}.action`, 500);
  const actionType = normalizeActionType(
    optionalString(approval.actionType, `${label}.actionType`, 200) ?? action,
  );
  if (actionType.length === 0) {
    return fail("invalid_input", `${label}.actionType must be a non-empty action type.`);
  }
  const risk = optionalString(approval.risk, `${label}.risk`);
  const rationale = optionalString(approval.rationale, `${label}.rationale`) ?? risk;
  if (rationale === undefined) {
    return fail("invalid_input", `${label} needs a rationale for the approval request.`);
  }
  const createdAt = timestamp(approval.createdAt, `${label}.createdAt`);
  const expiresAt = approval.expiresAt === undefined
    ? defaultApprovalExpiry(createdAt)
    : timestamp(approval.expiresAt, `${label}.expiresAt`);
  const decidedBy = optionalString(approval.decidedBy, `${label}.decidedBy`, 200);
  const decidedAt =
    approval.decidedAt === undefined
      ? undefined
      : timestamp(approval.decidedAt, `${label}.decidedAt`);
  const decision = enumValue(approval.decision, approvalDecisions, `${label}.decision`);
  const workItemId = optionalString(approval.workItemId, `${label}.workItemId`, 200);
  const attempt = approval.attempt === undefined
    ? undefined
    : nonNegativeInteger(approval.attempt, `${label}.attempt`);
  if (attempt !== undefined && attempt === 0) {
    return fail("invalid_input", `${label}.attempt must be greater than zero.`);
  }
  const handoffId = optionalString(approval.handoffId, `${label}.handoffId`, 200);
  const reviewId = optionalString(approval.reviewId, `${label}.reviewId`, 200);
  const trueforgeSandboxId = optionalString(
    approval.trueforgeSandboxId,
    `${label}.trueforgeSandboxId`,
    200,
  );
  if (decision === "pending" && (decidedBy !== undefined || decidedAt !== undefined)) {
    return fail("invalid_input", `${label} cannot have a decision actor or timestamp while pending.`);
  }
  if (decision !== "pending" && (decidedBy === undefined || decidedAt === undefined)) {
    return fail("invalid_input", `${label} needs a decision actor and timestamp.`);
  }
  const result: Approval = {
    id: identifier(approval.id, `${label}.id`),
    missionId: identifier(approval.missionId, `${label}.missionId`),
    action,
    actionType,
    target: requiredString(approval.target, `${label}.target`, 2_000),
    risk: risk ?? rationale,
    rationale,
    expectedEffect: requiredString(approval.expectedEffect, `${label}.expectedEffect`),
    evidenceIds: stringArray(approval.evidenceIds, `${label}.evidenceIds`),
    decision,
    createdAt,
    expiresAt,
  };
  if (decidedBy !== undefined) {
    result.decidedBy = decidedBy;
  }
  if (decidedAt !== undefined) {
    result.decidedAt = decidedAt;
  }
  if (workItemId !== undefined) {
    result.workItemId = identifier(workItemId, `${label}.workItemId`);
  }
  if (attempt !== undefined) {
    result.attempt = attempt;
  }
  if (handoffId !== undefined) {
    result.handoffId = identifier(handoffId, `${label}.handoffId`);
  }
  if (reviewId !== undefined) {
    result.reviewId = identifier(reviewId, `${label}.reviewId`);
  }
  if (trueforgeSandboxId !== undefined) {
    result.trueforgeSandboxId = trueforgeSandboxId;
  }
  if (approval.executionContext !== undefined) {
    result.executionContext = validateApprovalExecutionContext(
      approval.executionContext,
      `${label}.executionContext`,
    );
  }
  return result;
}

function validateApprovalExecutionContext(
  value: unknown,
  label: string,
): ApprovalExecutionContext {
  const context = objectValue(value, label);
  const result: ApprovalExecutionContext = {
    sessionId: identifier(context.sessionId, `${label}.sessionId`),
    turnId: identifier(context.turnId, `${label}.turnId`),
    threadId: identifier(context.threadId, `${label}.threadId`),
    toolCallId: identifier(context.toolCallId, `${label}.toolCallId`),
    serverName: requiredString(context.serverName, `${label}.serverName`, 200),
    toolName: requiredString(context.toolName, `${label}.toolName`, 200),
    repositoryOwner: requiredString(context.repositoryOwner, `${label}.repositoryOwner`, 200),
    repositoryName: requiredString(context.repositoryName, `${label}.repositoryName`, 200),
    base: requiredString(context.base, `${label}.base`, 500),
    head: requiredString(context.head, `${label}.head`, 500),
    title: requiredString(context.title, `${label}.title`, 500),
    body: requiredString(context.body, `${label}.body`, 4_000),
  };
  if (context.headSha !== undefined) {
    result.headSha = requiredString(context.headSha, `${label}.headSha`, 500);
  }
  if (context.artifactHash !== undefined) {
    result.artifactHash = requiredString(context.artifactHash, `${label}.artifactHash`, 200);
  }
  return result;
}

function validatePullRequestReference(value: unknown, label: string): PullRequestReference {
  const pullRequest = objectValue(value, label);
  if (
    typeof pullRequest.number !== "number" ||
    !Number.isInteger(pullRequest.number) ||
    pullRequest.number < 1
  ) {
    return fail("invalid_input", `${label}.number must be a positive integer.`);
  }
  const result: PullRequestReference = {
    number: pullRequest.number,
    url: requiredString(pullRequest.url, `${label}.url`, 2_000),
    repositoryOwner: requiredString(
      pullRequest.repositoryOwner,
      `${label}.repositoryOwner`,
      200,
    ),
    repositoryName: requiredString(
      pullRequest.repositoryName,
      `${label}.repositoryName`,
      200,
    ),
    base: requiredString(pullRequest.base, `${label}.base`, 500),
    head: requiredString(pullRequest.head, `${label}.head`, 500),
  };
  if (pullRequest.headSha !== undefined) {
    result.headSha = requiredString(pullRequest.headSha, `${label}.headSha`, 500);
  }
  try {
    const url = new URL(result.url);
    const expectedPath = `/${result.repositoryOwner}/${result.repositoryName}/pull/${result.number}`;
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.pathname.replace(/\/$/, "") !== expectedPath
    ) {
      return fail("invalid_input", `${label}.url must match the recorded GitHub pull request.`);
    }
  } catch {
    return fail("invalid_input", `${label}.url must be a valid GitHub pull request URL.`);
  }
  return result;
}

function validateDelivery(value: unknown, label: string): Delivery {
  const delivery = objectValue(value, label);
  const reference = optionalString(delivery.reference, `${label}.reference`, 2_000);
  const status = enumValue(delivery.status, deliveryStatuses, `${label}.status`);
  const workItemId = optionalString(delivery.workItemId, `${label}.workItemId`, 200);
  const attempt = delivery.attempt === undefined
    ? undefined
    : nonNegativeInteger(delivery.attempt, `${label}.attempt`);
  if (attempt !== undefined && attempt === 0) {
    return fail("invalid_input", `${label}.attempt must be greater than zero.`);
  }
  if (status === "delivered" && reference === undefined) {
    return fail("invalid_input", `${label}.reference is required for a delivered record.`);
  }
  const result: Delivery = {
    id: identifier(delivery.id, `${label}.id`),
    missionId: identifier(delivery.missionId, `${label}.missionId`),
    status,
    verificationSummary: requiredString(
      delivery.verificationSummary,
      `${label}.verificationSummary`,
    ),
    createdAt: timestamp(delivery.createdAt, `${label}.createdAt`),
  };
  if (reference !== undefined) {
    result.reference = reference;
  }
  if (delivery.approvalId !== undefined) {
    result.approvalId = identifier(delivery.approvalId, `${label}.approvalId`);
  }
  if (workItemId !== undefined) {
    result.workItemId = identifier(workItemId, `${label}.workItemId`);
  }
  if (attempt !== undefined) {
    result.attempt = attempt;
  }
  if (delivery.pullRequest !== undefined) {
    result.pullRequest = validatePullRequestReference(
      delivery.pullRequest,
      `${label}.pullRequest`,
    );
  }
  if (delivery.executionOrigin !== undefined) {
    result.executionOrigin = validateExecutionOrigin(
      delivery.executionOrigin,
      `${label}.executionOrigin`,
    );
  }
  if (
    result.pullRequest !== undefined &&
    (
      result.reference !== result.pullRequest.url ||
      result.approvalId === undefined ||
      result.executionOrigin === undefined
    )
  ) {
    return fail(
      "invalid_input",
      `${label} needs a matching reference, approval, and execution origin for its pull request.`,
    );
  }
  return result;
}

function validateDeliveryAttemptTarget(
  value: unknown,
  label: string,
): DeliveryAttemptTarget {
  const target = objectValue(value, label);
  const headSha = target.headSha === undefined
    ? undefined
    : requiredString(target.headSha, `${label}.headSha`, 500);
  if (headSha !== undefined && !/^[0-9a-f]{40}$/i.test(headSha)) {
    return fail("invalid_input", `${label}.headSha must be a 40-character hexadecimal SHA.`);
  }
  const artifact = target.artifact === undefined
    ? undefined
    : validateDeliveryArtifact(target.artifact, `${label}.artifact`);
  if (headSha === undefined && artifact === undefined) {
    return fail(
      "invalid_input",
      `${label} must identify either a verified remote head SHA or a proof-bound delivery artifact.`,
    );
  }
  const result: DeliveryAttemptTarget = {
    repositoryOwner: requiredString(target.repositoryOwner, `${label}.repositoryOwner`, 200),
    repositoryName: requiredString(target.repositoryName, `${label}.repositoryName`, 200),
    base: requiredString(target.base, `${label}.base`, 500),
    head: requiredString(target.head, `${label}.head`, 500),
    title: requiredString(target.title, `${label}.title`, 500),
    body: requiredString(target.body, `${label}.body`, 4_000),
  };
  if (headSha !== undefined) {
    result.headSha = headSha;
  }
  if (artifact !== undefined) {
    result.artifact = artifact;
  }
  return result;
}

function validateDeliveryArtifact(value: unknown, label: string): DeliveryArtifact {
  const artifact = objectValue(value, label);
  const rawFiles = objectValue(artifact.files, `${label}.files`);
  const rawPatches = objectValue(artifact.patches, `${label}.patches`);
  const fileNames = filePathArray(Object.keys(rawFiles), `${label}.files`);
  const patchNames = filePathArray(Object.keys(rawPatches), `${label}.patches`);
  if (fileNames.length === 0 || fileNames.length !== patchNames.length ||
      fileNames.some((file) => !patchNames.includes(file))) {
    return fail(
      "invalid_input",
      `${label}.files and ${label}.patches must identify the same non-empty files.`,
    );
  }
  const files: Record<string, string> = {};
  for (const file of [...fileNames].sort()) {
    files[file] = boundedString(rawFiles[file], `${label}.files.${file}`, 20_000);
  }
  const patches: Record<string, string> = {};
  for (const file of [...patchNames].sort()) {
    patches[file] = boundedString(rawPatches[file], `${label}.patches.${file}`, 20_000);
  }
  return {
    baselineSha: requiredString(artifact.baselineSha, `${label}.baselineSha`, 500),
    files,
    patches,
    contentHash: requiredString(artifact.contentHash, `${label}.contentHash`, 200),
  };
}

function validateDeliveryAttempt(value: unknown, label: string): DeliveryAttempt {
  const attempt = objectValue(value, label);
  const attemptNumber = nonNegativeInteger(attempt.attempt, `${label}.attempt`);
  if (attemptNumber === 0) {
    return fail("invalid_input", `${label}.attempt must be greater than zero.`);
  }
  const pullRequest = attempt.pullRequest === undefined
    ? undefined
    : validatePullRequestReference(attempt.pullRequest, `${label}.pullRequest`);
  const executionOrigin = attempt.executionOrigin === undefined
    ? undefined
    : validateExecutionOrigin(attempt.executionOrigin, `${label}.executionOrigin`);
  if (pullRequest !== undefined && pullRequest.headSha === undefined) {
    return fail("invalid_input", `${label}.pullRequest.headSha is required for a delivery attempt.`);
  }
  if ((pullRequest === undefined) !== (executionOrigin === undefined)) {
    return fail(
      "invalid_input",
      `${label} must persist its pull request and execution origin together.`,
    );
  }
  const status = enumValue(attempt.status, deliveryAttemptStatuses, `${label}.status`);
  if (status === "completed" && pullRequest === undefined) {
    return fail("invalid_input", `${label} cannot be completed without a persisted pull request result.`);
  }
  const result: DeliveryAttempt = {
    id: identifier(attempt.id, `${label}.id`),
    missionId: identifier(attempt.missionId, `${label}.missionId`),
    approvalId: identifier(attempt.approvalId, `${label}.approvalId`),
    workItemId: identifier(attempt.workItemId, `${label}.workItemId`),
    attempt: attemptNumber,
    actionType: normalizeActionType(
      requiredString(attempt.actionType, `${label}.actionType`, 200),
    ),
    expectedEffect: requiredString(attempt.expectedEffect, `${label}.expectedEffect`),
    target: validateDeliveryAttemptTarget(attempt.target, `${label}.target`),
    status,
    createdAt: timestamp(attempt.createdAt, `${label}.createdAt`),
    updatedAt: timestamp(attempt.updatedAt, `${label}.updatedAt`),
  };
  if (pullRequest !== undefined) {
    result.pullRequest = pullRequest;
  }
  if (executionOrigin !== undefined) {
    result.executionOrigin = executionOrigin;
  }
  return result;
}

function validateRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return fail("invalid_input", "revision must be a non-negative integer.");
  }
  return value;
}

function ensureUniqueIds(state: MissionState): void {
  const ids = new Set<string>();
  const collections = [
    state.missions,
    state.workItems,
    state.evidence,
    state.handoffs,
    state.reviews,
    state.approvals,
    state.deliveries,
    state.deliveryAttempts,
  ];
  for (const collection of collections) {
    for (const entity of collection) {
      if (ids.has(entity.id)) {
        fail("invalid_input", `Entity ID ${entity.id} is duplicated.`);
      }
      ids.add(entity.id);
    }
  }
}

function isPlannerBaselineEvidence(
  item: Evidence,
  workItems: Map<string, WorkItem>,
): boolean {
  if (
    item.workItemId === undefined ||
    item.source !== "mcp" ||
    item.kind !== "tool_result" ||
    workItems.get(item.workItemId)?.assignedRole !== "planner" ||
    item.details === undefined
  ) {
    return false;
  }
  try {
    const details = JSON.parse(item.details) as unknown;
    return typeof details === "object" &&
      details !== null &&
      !Array.isArray(details) &&
      (details as Record<string, unknown>).provenance_kind === "baseline";
  } catch {
    return false;
  }
}

export function validateMissionState(value: unknown): MissionState {
  const state = objectValue(value, "state");
  if (state.schemaVersion !== 1) {
    return fail("invalid_input", "state.schemaVersion must be 1.");
  }
  const result: MissionState = {
    schemaVersion: 1,
    revision: validateRevision(state.revision),
    missions: arrayValue(state.missions, "state.missions").map((item, index) =>
      validateMission(item, `state.missions[${index}]`),
    ),
    workItems: arrayValue(state.workItems, "state.workItems").map((item, index) =>
      validateWorkItem(item, `state.workItems[${index}]`),
    ),
    evidence: arrayValue(state.evidence, "state.evidence").map((item, index) =>
      validateEvidence(item, `state.evidence[${index}]`),
    ),
    handoffs: arrayValue(state.handoffs, "state.handoffs").map((item, index) =>
      validateHandoff(item, `state.handoffs[${index}]`),
    ),
    reviews: arrayValue(state.reviews ?? [], "state.reviews").map((item, index) =>
      validateReview(item, `state.reviews[${index}]`),
    ),
    approvals: arrayValue(state.approvals, "state.approvals").map((item, index) =>
      validateApproval(item, `state.approvals[${index}]`),
    ),
    deliveries: arrayValue(state.deliveries, "state.deliveries").map((item, index) =>
      validateDelivery(item, `state.deliveries[${index}]`),
    ),
    deliveryAttempts: arrayValue(state.deliveryAttempts ?? [], "state.deliveryAttempts").map((item, index) =>
      validateDeliveryAttempt(item, `state.deliveryAttempts[${index}]`),
    ),
  };

  ensureUniqueIds(result);
  const missions = new Map(result.missions.map((mission) => [mission.id, mission]));
  const workItems = new Map(result.workItems.map((workItem) => [workItem.id, workItem]));
  const evidence = new Map(result.evidence.map((item) => [item.id, item]));

  for (const workItem of result.workItems) {
    if (!missions.has(workItem.missionId)) {
      fail("invalid_input", `Work item ${workItem.id} references an unknown mission.`);
    }
    if (
      workItem.claim !== undefined &&
      (workItem.status === "backlog" || workItem.status === "ready")
    ) {
      fail(
        "invalid_input",
        `Claimed work item ${workItem.id} cannot remain in ${workItem.status} state.`,
      );
    }
    if (workItem.claim !== undefined && workItem.attempts.length > 0) {
      const currentAttempt = workItem.attempts.at(-1);
      if (currentAttempt === undefined ||
          JSON.stringify(currentAttempt.claim) !== JSON.stringify(workItem.claim)) {
        fail(
          "invalid_input",
          `Work item ${workItem.id} claim does not match its current attempt history.`,
        );
      }
    }
    const currentAttempt = workItem.attempts.at(-1);
    if (workItem.status === "ready" &&
        currentAttempt?.status === "changes_requested" &&
        currentAttempt.retiredAt === undefined) {
      fail(
        "invalid_input",
        `Work item ${workItem.id} cannot return to Ready before its prior attempt is retired.`,
      );
    }
    if (currentAttempt !== undefined &&
        isProductWorkItemStatus(workItem.status) &&
        workItem.status !== "backlog" &&
        workItem.status !== "ready" &&
        currentAttempt.status !== workItem.status) {
      fail(
        "invalid_input",
        `Work item ${workItem.id} status does not match its current attempt history.`,
      );
    }
    for (const dependencyId of workItem.dependsOn) {
      const dependency = workItems.get(dependencyId);
      if (dependency === undefined) {
        fail("invalid_input", `Work item ${workItem.id} references an unknown dependency.`);
      }
      if (dependency.missionId !== workItem.missionId) {
        fail("invalid_input", `Work item ${workItem.id} has a cross-mission dependency.`);
      }
      if (dependencyId === workItem.id) {
        fail("invalid_input", `Work item ${workItem.id} cannot depend on itself.`);
      }
      if (workItem.status !== "backlog" && workItem.status !== "blocked" &&
          !isCompletedWorkItemStatus(dependency.status)) {
        fail("invalid_input", `Work item ${workItem.id} has an incomplete dependency for its status.`);
      }
    }
  }
  assertAcyclicDependencies(result.workItems, "state.workItems");

  const latestHandoffIds = new Set<string>();
  const latestHandoffsByWorkItem = new Map<string, string>();
  for (const handoff of result.handoffs) {
    latestHandoffsByWorkItem.set(`${handoff.missionId}:${handoff.workItemId}`, handoff.id);
  }
  for (const handoffId of latestHandoffsByWorkItem.values()) {
    latestHandoffIds.add(handoffId);
  }

  for (const item of result.evidence) {
    if (!missions.has(item.missionId)) {
      fail("invalid_input", `Evidence ${item.id} references an unknown mission.`);
    }
    if (item.workItemId !== undefined) {
      const workItem = workItems.get(item.workItemId);
      if (workItem === undefined || workItem.missionId !== item.missionId) {
        fail("invalid_input", `Evidence ${item.id} references an invalid work item.`);
      }
      if (item.attempt !== undefined &&
          (item.attempt === 0 || item.attempt > workItem.attempt ||
            !workItem.attempts.some((attempt) => attempt.number === item.attempt))) {
        fail("invalid_input", `Evidence ${item.id} references an invalid work-item attempt.`);
      }
    } else if (item.attempt !== undefined) {
      fail("invalid_input", `Evidence ${item.id} cannot identify an attempt without a work item.`);
    }
  }

  for (const handoff of result.handoffs) {
    const workItem = workItems.get(handoff.workItemId);
    if (!missions.has(handoff.missionId) || workItem === undefined || workItem.missionId !== handoff.missionId) {
      fail("invalid_input", `Handoff ${handoff.id} references an invalid work item or mission.`);
    }
    if (handoff.attempt !== undefined &&
        (handoff.attempt === 0 || handoff.attempt > workItem.attempt ||
          !workItem.attempts.some((attempt) => attempt.number === handoff.attempt))) {
      fail("invalid_input", `Handoff ${handoff.id} references an invalid work-item attempt.`);
    }
    validateStructuredHandoffCorrelation(
      result,
      handoff,
      workItem,
      latestHandoffIds.has(handoff.id) && handoffMatchesCurrentDelegation(workItem, handoff),
    );
  }

  const handoffsById = new Map(result.handoffs.map((handoff) => [handoff.id, handoff]));
  const evidenceById = new Map(result.evidence.map((item) => [item.id, item]));
  for (const review of result.reviews) {
    const workItem = workItems.get(review.workItemId);
    const handoff = handoffsById.get(review.handoffId);
    if (
      !missions.has(review.missionId) ||
      workItem === undefined ||
      workItem.missionId !== review.missionId ||
      handoff === undefined ||
      handoff.missionId !== review.missionId ||
      handoff.workItemId !== review.workItemId
    ) {
      fail("invalid_input", `Review ${review.id} references an invalid mission, work item, or handoff.`);
    }
    if (review.attempt !== undefined &&
        (review.attempt === 0 || review.attempt > workItem.attempt ||
          !workItem.attempts.some((attempt) => attempt.number === review.attempt))) {
      fail("invalid_input", `Review ${review.id} references an invalid work-item attempt.`);
    }
    const structured = asStructuredHandoff(handoff);
    if (structured === null || handoff.result !== "done") {
      fail("invalid_input", `Review ${review.id} must reference a completed structured handoff.`);
    }
    validateStructuredHandoffCorrelation(
      result,
      handoff,
      workItem,
      latestHandoffIds.has(handoff.id) && handoffMatchesCurrentDelegation(workItem, handoff),
    );
    if (
      JSON.stringify(review.filesChanged) !== JSON.stringify(handoff.filesChanged) ||
      review.diffSummary !== structured.diffSummary ||
      JSON.stringify(review.checks) !== JSON.stringify(structured.checks) ||
      JSON.stringify(review.evidenceIds) !== JSON.stringify(structured.evidenceIds)
    ) {
      fail("invalid_input", `Review ${review.id} does not preserve the reviewed handoff snapshot.`);
    }
    for (const evidenceId of review.evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      if (
        evidence === undefined ||
        evidence.missionId !== review.missionId ||
        evidence.workItemId !== review.workItemId
      ) {
        fail("invalid_input", `Review ${review.id} references invalid reviewed evidence.`);
      }
    }
    const findingEvidence = evidenceById.get(review.findingEvidenceId);
    if (
      findingEvidence === undefined ||
      findingEvidence.missionId !== review.missionId ||
      findingEvidence.workItemId !== review.workItemId ||
      findingEvidence.source !== "reviewer" ||
      findingEvidence.kind !== "reviewer_finding" ||
      findingEvidence.result !== (review.outcome === "accepted" ? "passed" : "failed")
    ) {
      fail("invalid_input", `Review ${review.id} has no matching durable reviewer finding.`);
    }
  }

  for (const workItem of result.workItems) {
    if (isStructuredImplementationWorkItem(workItem) && isCompletedWorkItemStatus(workItem.status)) {
      ensureAcceptedIndependentReview(result, workItem);
    }
  }

  for (const approval of result.approvals) {
    if (!missions.has(approval.missionId)) {
      fail("invalid_input", `Approval ${approval.id} references an unknown mission.`);
    }
    const workItem = approval.workItemId === undefined
      ? undefined
      : workItems.get(approval.workItemId);
    if (approval.workItemId !== undefined &&
        (workItem === undefined || workItem.missionId !== approval.missionId)) {
      fail("invalid_input", `Approval ${approval.id} references an invalid work item.`);
    }
    if (approval.attempt !== undefined &&
        (workItem === undefined || approval.attempt > workItem.attempt ||
          !workItem.attempts.some((attempt) => attempt.number === approval.attempt))) {
      fail("invalid_input", `Approval ${approval.id} references an invalid work-item attempt.`);
    }
    if (approval.handoffId !== undefined) {
      const handoff = handoffsById.get(approval.handoffId);
      if (
        handoff === undefined ||
        handoff.missionId !== approval.missionId ||
        (workItem !== undefined && handoff.workItemId !== workItem.id) ||
        (approval.attempt !== undefined && handoff.attempt !== approval.attempt)
      ) {
        fail("invalid_input", `Approval ${approval.id} references an invalid handoff.`);
      }
    }
    if (approval.reviewId !== undefined) {
      const review = result.reviews.find((candidate) => candidate.id === approval.reviewId);
      if (
        review === undefined ||
        review.missionId !== approval.missionId ||
        (workItem !== undefined && review.workItemId !== workItem.id) ||
        (approval.attempt !== undefined && review.attempt !== approval.attempt)
      ) {
        fail("invalid_input", `Approval ${approval.id} references an invalid review.`);
      }
    }
    if (approval.trueforgeSandboxId !== undefined && workItem !== undefined) {
      const attempt = workItem.attempts.find((candidate) => candidate.number === approval.attempt);
      if (attempt?.claim.trueforgeSandboxId !== approval.trueforgeSandboxId) {
        fail("invalid_input", `Approval ${approval.id} is not bound to the recorded TrueForge sandbox.`);
      }
    }
    for (const evidenceId of approval.evidenceIds) {
      const item = evidence.get(evidenceId);
      if (item === undefined || item.missionId !== approval.missionId) {
        fail("invalid_input", `Approval ${approval.id} references invalid evidence.`);
      }
      if (
        approval.workItemId !== undefined &&
        item.workItemId !== undefined &&
        item.workItemId !== approval.workItemId &&
        !isPlannerBaselineEvidence(item, workItems)
      ) {
        fail("invalid_input", `Approval ${approval.id} mixes evidence from another work item.`);
      }
    }
  }

  for (const delivery of result.deliveries) {
    if (!missions.has(delivery.missionId)) {
      fail("invalid_input", `Delivery ${delivery.id} references an unknown mission.`);
    }
    if (delivery.approvalId !== undefined) {
      const approval = result.approvals.find((item) => item.id === delivery.approvalId);
      if (approval === undefined || approval.missionId !== delivery.missionId) {
        fail("invalid_input", `Delivery ${delivery.id} references an invalid approval.`);
      }
      if (
        approval.decision !== "approved" ||
        approval.actionType !== PRIMARY_CONSEQUENTIAL_ACTION
      ) {
        fail("invalid_input", `Delivery ${delivery.id} does not reference an approved delivery action.`);
      }
      if (
        delivery.workItemId !== undefined &&
        (approval.workItemId !== delivery.workItemId ||
          delivery.attempt !== undefined && approval.attempt !== delivery.attempt)
      ) {
        fail("invalid_input", `Delivery ${delivery.id} is not correlated to its approved work-item attempt.`);
      }
      if (delivery.pullRequest !== undefined && delivery.executionOrigin !== undefined) {
        const context = approval.executionContext;
        const artifactApproval = context?.artifactHash !== undefined;
        if (
          context === undefined ||
          context.toolName !== (artifactApproval ? "push_files" : PRIMARY_CONSEQUENTIAL_ACTION) ||
          context.repositoryOwner !== delivery.pullRequest.repositoryOwner ||
          context.repositoryName !== delivery.pullRequest.repositoryName ||
          context.base !== delivery.pullRequest.base ||
          context.head !== delivery.pullRequest.head ||
          (context.headSha !== undefined && context.headSha !== delivery.pullRequest.headSha) ||
          context.sessionId !== delivery.executionOrigin.sessionId ||
          context.threadId !== delivery.executionOrigin.threadId ||
          context.toolCallId !== delivery.executionOrigin.toolCallId
        ) {
          fail(
            "invalid_input",
            `Delivery ${delivery.id} is not correlated to its approved tool call.`,
          );
        }
      }
    }
    if (delivery.workItemId !== undefined) {
      const workItem = workItems.get(delivery.workItemId);
      if (workItem === undefined || workItem.missionId !== delivery.missionId) {
        fail("invalid_input", `Delivery ${delivery.id} references an invalid work item.`);
      }
      if (delivery.attempt !== undefined &&
          (delivery.attempt > workItem.attempt ||
            !workItem.attempts.some((attempt) => attempt.number === delivery.attempt))) {
        fail("invalid_input", `Delivery ${delivery.id} references an invalid work-item attempt.`);
      }
    } else if (delivery.attempt !== undefined) {
      fail("invalid_input", `Delivery ${delivery.id} cannot identify an attempt without a work item.`);
    }
  }

  for (const deliveryAttempt of result.deliveryAttempts) {
    const approval = result.approvals.find((item) => item.id === deliveryAttempt.approvalId);
    const workItem = result.workItems.find((item) => item.id === deliveryAttempt.workItemId);
    if (
      !missions.has(deliveryAttempt.missionId) ||
      approval === undefined ||
      approval.missionId !== deliveryAttempt.missionId ||
      workItem === undefined ||
      workItem.missionId !== deliveryAttempt.missionId
    ) {
      fail("invalid_input", `Delivery attempt ${deliveryAttempt.id} references an invalid mission, approval, or work item.`);
    }
    if (
      approval.decision !== "approved" ||
      approval.actionType !== PRIMARY_CONSEQUENTIAL_ACTION ||
      deliveryAttempt.actionType !== approval.actionType ||
      deliveryAttempt.expectedEffect !== approval.expectedEffect ||
      approval.workItemId !== deliveryAttempt.workItemId ||
      approval.attempt !== deliveryAttempt.attempt ||
      workItem.attempt !== deliveryAttempt.attempt
    ) {
      fail("invalid_input", `Delivery attempt ${deliveryAttempt.id} is not correlated to its approved work-item attempt.`);
    }
    const context = approval.executionContext;
    if (
      context === undefined ||
      (context.headSha === undefined && context.artifactHash === undefined) ||
      context.repositoryOwner !== deliveryAttempt.target.repositoryOwner ||
      context.repositoryName !== deliveryAttempt.target.repositoryName ||
      context.base !== deliveryAttempt.target.base ||
      context.head !== deliveryAttempt.target.head ||
      (context.headSha !== undefined && context.headSha !== deliveryAttempt.target.headSha) ||
      (context.artifactHash !== undefined &&
        context.artifactHash !== deliveryAttempt.target.artifact?.contentHash) ||
      context.title !== deliveryAttempt.target.title ||
      context.body !== deliveryAttempt.target.body
    ) {
      fail("invalid_input", `Delivery attempt ${deliveryAttempt.id} does not preserve the approved target.`);
    }
    if (deliveryAttempt.pullRequest !== undefined) {
      const pullRequest = deliveryAttempt.pullRequest;
      const executionOrigin = deliveryAttempt.executionOrigin;
      if (
        pullRequest.repositoryOwner !== deliveryAttempt.target.repositoryOwner ||
        pullRequest.repositoryName !== deliveryAttempt.target.repositoryName ||
        pullRequest.base !== deliveryAttempt.target.base ||
        pullRequest.head !== deliveryAttempt.target.head ||
        (deliveryAttempt.target.headSha !== undefined &&
          pullRequest.headSha !== deliveryAttempt.target.headSha) ||
        executionOrigin?.kind !== "mcp" ||
        executionOrigin.sessionId !== approval.executionContext?.sessionId ||
        executionOrigin.threadId !== approval.executionContext?.threadId ||
        executionOrigin.toolCallId !== approval.executionContext?.toolCallId
      ) {
        fail("invalid_input", `Delivery attempt ${deliveryAttempt.id} has an uncorrelated pull request result.`);
      }
    }
    if (deliveryAttempt.status === "completed" && !result.deliveries.some((delivery) =>
      delivery.missionId === deliveryAttempt.missionId &&
      delivery.status === "delivered" &&
      delivery.approvalId === deliveryAttempt.approvalId &&
      delivery.workItemId === deliveryAttempt.workItemId &&
      delivery.attempt === deliveryAttempt.attempt &&
      delivery.pullRequest?.url === deliveryAttempt.pullRequest?.url
    )) {
      fail("invalid_input", `Completed delivery attempt ${deliveryAttempt.id} has no matching delivered record.`);
    }
  }

  for (const mission of result.missions) {
    const deliveries = result.deliveries.filter((delivery) => delivery.missionId === mission.id);
    if (mission.status === "delivered" && !deliveries.some((delivery) => delivery.status === "delivered")) {
      fail("invalid_input", `Delivered mission ${mission.id} needs a delivered record.`);
    }
    if (mission.status !== "delivered" && deliveries.some((delivery) => delivery.status === "delivered")) {
      fail("invalid_input", `Mission ${mission.id} cannot have a delivered record before delivery.`);
    }
  }

  return result;
}

export class InMemoryMissionRepository implements MissionRepository {
  private state: MissionState | null;

  constructor(initialState?: MissionState | null) {
    this.state = initialState === undefined || initialState === null
      ? null
      : validateMissionState(initialState);
  }

  async load(): Promise<MissionState | null> {
    return this.state === null ? null : clone(this.state);
  }

  async save(state: MissionState): Promise<void> {
    this.state = clone(validateMissionState(state));
  }

  async saveIfRevision(state: MissionState, expectedRevision: number): Promise<void> {
    const actualRevision = this.state?.revision ?? 0;
    if (actualRevision !== expectedRevision) {
      fail(
        "conflict",
        `Mission state changed from revision ${expectedRevision}; reload before saving again.`,
      );
    }
    this.state = clone(validateMissionState(state));
  }
}

function findMission(state: MissionState, missionId: string): Mission {
  const mission = state.missions.find((item) => item.id === missionId);
  if (mission === undefined) {
    fail("not_found", `Mission ${missionId} was not found.`);
  }
  return mission;
}

function findWorkItem(state: MissionState, missionId: string, workItemId: string): WorkItem {
  const workItem = state.workItems.find(
    (item) => item.id === workItemId && item.missionId === missionId,
  );
  if (workItem === undefined) {
    fail("not_found", `Work item ${workItemId} was not found in mission ${missionId}.`);
  }
  return workItem;
}

function isCompletedWorkItemStatus(status: WorkItemStatus): boolean {
  return status === "done" || status === "complete";
}

function isProductWorkItemStatus(status: WorkItemStatus): status is TicketStatus {
  return (ticketStatuses as readonly string[]).includes(status);
}

function validateExpectedRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail("invalid_input", "expectedRevision must be a non-negative integer.");
  }
  return value;
}

function ensureExpectedRevision(state: MissionState, expectedRevision: number | undefined): void {
  if (expectedRevision === undefined) {
    return;
  }
  const expected = validateExpectedRevision(expectedRevision);
  if (state.revision !== expected) {
    fail(
      "conflict",
      `Mission state changed from revision ${expected}; reload the ticket before retrying.`,
    );
  }
}

function ensureOpen(mission: Mission): void {
  if (mission.status === "delivered" || mission.status === "failed") {
    fail("invalid_transition", `Mission ${mission.id} is already ${mission.status}.`);
  }
}

function ensureUniqueEntityId(state: MissionState, id: string): void {
  const exists = [
    ...state.missions,
    ...state.workItems,
    ...state.evidence,
    ...state.handoffs,
    ...state.reviews,
    ...state.approvals,
    ...state.deliveries,
    ...state.deliveryAttempts,
  ].some((entity) => entity.id === id);
  if (exists) {
    fail("invalid_input", `Entity ID ${id} is already in use.`);
  }
}

function ensureDependenciesComplete(state: MissionState, workItem: WorkItem): void {
  const incomplete = workItem.dependsOn.filter((dependencyId) => {
    const dependency = state.workItems.find((item) => item.id === dependencyId);
    return dependency === undefined || !isCompletedWorkItemStatus(dependency.status);
  });
  if (incomplete.length > 0) {
    fail(
      "dependency_blocked",
      `Work item ${workItem.id} is blocked by incomplete dependencies: ${incomplete.join(", ")}.`,
    );
  }
}

function stableExecutionBinding(
  label: string,
  ...values: Array<string | undefined>
): string | undefined {
  const unique = [...new Set(values.filter((value): value is string => value !== undefined))];
  if (unique.length > 1) {
    fail(
      "invalid_transition",
      `${label} identity changed across attempts; refusing to create a replacement binding.`,
    );
  }
  return unique[0];
}

function ensureAttemptHistoryForClaim(workItem: WorkItem): WorkItemAttempt {
  const existing = workItem.attempts.at(-1);
  if (existing !== undefined) {
    return existing;
  }
  if (workItem.claim === undefined) {
    fail(
      "invalid_transition",
      `Work item ${workItem.id} has no prior claim to retire before reauthorization.`,
    );
  }
  const authorization = workItem.executionAuthorization ?? {
    authorizedBy: "legacy-recovered",
    authorizedAt: workItem.claim.claimedAt,
  };
  const attempt: WorkItemAttempt = {
    number: workItem.attempt === 0 ? 1 : workItem.attempt,
    authorization: clone(authorization),
    requestedChanges: [...(workItem.requestedChanges ?? [])],
    claim: clone(workItem.claim),
    status: "changes_requested",
  };
  workItem.attempt = attempt.number;
  workItem.attempts.push(attempt);
  return attempt;
}

function updateCurrentAttempt(
  workItem: WorkItem,
  status: WorkItemAttemptStatus,
): void {
  const attempt = workItem.attempts.at(-1);
  if (attempt !== undefined) {
    attempt.status = status;
    if (workItem.requestedChanges !== undefined) {
      attempt.requestedChanges = [...workItem.requestedChanges];
    }
  }
}

function workItemFinding(
  state: MissionState,
  workItem: WorkItem,
  reason?: string,
): string {
  const explicit = reason === undefined ? undefined : optionalString(reason, "reason", 4_000);
  if (explicit !== undefined) {
    return explicit;
  }
  const latestFailure = [...state.evidence].reverse().find((evidence) =>
    evidence.workItemId === workItem.id && evidence.result === "failed",
  );
  return latestFailure?.summary ?? "The current proof did not establish the ticket contract.";
}

function ensureAllWorkComplete(state: MissionState, missionId: string): void {
  const incomplete = state.workItems
    .filter((item) => item.missionId === missionId && !isCompletedWorkItemStatus(item.status))
    .map((item) => item.id);
  if (incomplete.length > 0) {
    fail(
      "dependency_blocked",
      `Mission ${missionId} still has incomplete work items: ${incomplete.join(", ")}.`,
    );
  }
}

function productDeliveryWorkItems(state: MissionState, missionId: string): WorkItem[] {
  return state.workItems.filter((item) =>
    item.missionId === missionId && item.assignedRole !== "reviewer"
  );
}

function ensureQueueApprovalReady(state: MissionState, missionId: string): void {
  const productItems = productDeliveryWorkItems(state, missionId);
  if (productItems.length === 0) {
    ensureAllWorkComplete(state, missionId);
    return;
  }
  const incomplete = productItems.filter((item) => {
    if (item.assignedRole === "implementer") {
      return item.status !== "awaiting_approval" && !isCompletedWorkItemStatus(item.status);
    }
    return !isCompletedWorkItemStatus(item.status);
  });
  if (incomplete.length > 0) {
    fail(
      "dependency_blocked",
      `Mission ${missionId} is not ready for approval; queue items are not at the approval gate: ${incomplete.map((item) => item.id).join(", ")}.`,
    );
  }
}

function ensureQueueVerificationReady(state: MissionState, missionId: string): void {
  const productItems = productDeliveryWorkItems(state, missionId);
  if (productItems.length === 0) {
    ensureAllWorkComplete(state, missionId);
    return;
  }
  const incomplete = productItems.filter((item) => {
    if (item.assignedRole === "implementer") {
      return !["delivering", "done"].includes(item.status) && !isCompletedWorkItemStatus(item.status);
    }
    return !isCompletedWorkItemStatus(item.status);
  });
  if (incomplete.length > 0) {
    fail(
      "dependency_blocked",
      `Mission ${missionId} is not ready for delivery verification: queue items are not delivering or done: ${incomplete.map((item) => item.id).join(", ")}.`,
    );
  }
}

function ensureQueueDeliveryComplete(
  state: MissionState,
  missionId: string,
  deliveryWorkItemId: string,
  deliveryAttempt: number | undefined,
): WorkItem | undefined {
  const productItems = productDeliveryWorkItems(state, missionId);
  if (productItems.length === 0) {
    ensureAllWorkComplete(state, missionId);
    return undefined;
  }
  const deliveryWorkItem = findWorkItem(state, missionId, deliveryWorkItemId);
  if (deliveryWorkItem.assignedRole !== "implementer" ||
      (!["delivering", "done"].includes(deliveryWorkItem.status) &&
        !isCompletedWorkItemStatus(deliveryWorkItem.status))) {
    fail(
      "invalid_transition",
      `Delivery work item ${deliveryWorkItem.id} must be delivering before the verified result is recorded.`,
    );
  }
  if (deliveryAttempt !== undefined && deliveryWorkItem.attempt !== deliveryAttempt) {
    fail(
      "approval_blocked",
      `Delivery work item ${deliveryWorkItem.id} is on attempt ${deliveryWorkItem.attempt}, not approved attempt ${deliveryAttempt}.`,
    );
  }
  const incomplete = productItems.filter((item) =>
    item.id === deliveryWorkItem.id
      ? (!["delivering", "done"].includes(item.status) && !isCompletedWorkItemStatus(item.status))
      : !isCompletedWorkItemStatus(item.status),
  );
  if (incomplete.length > 0) {
    fail(
      "dependency_blocked",
      `Mission ${missionId} still has incomplete delivery work items: ${incomplete.map((item) => item.id).join(", ")}.`,
    );
  }
  if (isStructuredImplementationWorkItem(deliveryWorkItem)) {
    ensureAcceptedIndependentReview(state, deliveryWorkItem);
  }
  return deliveryWorkItem;
}

function ensureMissionEvidence(state: MissionState, missionId: string, evidenceIds: string[]): void {
  for (const evidenceId of evidenceIds) {
    const evidence = state.evidence.find((item) => item.id === evidenceId);
    if (evidence === undefined || evidence.missionId !== missionId) {
      fail("invalid_input", `Evidence ${evidenceId} does not belong to mission ${missionId}.`);
    }
  }
}

function ensureApprovalEvidence(state: MissionState, approval: Approval): void {
  if (approval.evidenceIds.length === 0) {
    fail("approval_blocked", `Approval ${approval.id} has no supporting evidence.`);
  }
  for (const evidenceId of approval.evidenceIds) {
    const evidence = state.evidence.find((item) => item.id === evidenceId);
    if (evidence === undefined || evidence.missionId !== approval.missionId) {
      fail("approval_blocked", `Approval ${approval.id} references invalid supporting evidence.`);
    }
  }
}

function ensureCurrentApprovalCorrelation(state: MissionState, approval: Approval): void {
  if (approval.workItemId === undefined) {
    return;
  }
  const workItem = state.workItems.find((item) =>
    item.id === approval.workItemId && item.missionId === approval.missionId,
  );
  const currentAttempt = workItem?.attempts.at(-1);
  if (
    workItem === undefined ||
    approval.attempt === undefined ||
    approval.attempt !== workItem.attempt ||
    !["awaiting_approval", "delivering"].includes(workItem.status) ||
    currentAttempt === undefined ||
    currentAttempt.status !== workItem.status
  ) {
    fail(
      "approval_blocked",
      `Approval ${approval.id} is stale for the current work-item attempt.`,
    );
  }
  if (approval.handoffId !== undefined) {
    const latestHandoff = state.handoffs
      .filter((handoff) => handoff.missionId === approval.missionId && handoff.workItemId === workItem.id)
      .at(-1);
    if (latestHandoff?.id !== approval.handoffId || latestHandoff.attempt !== approval.attempt) {
      fail("approval_blocked", `Approval ${approval.id} is stale for the current implementation handoff.`);
    }
  }
  if (approval.reviewId !== undefined) {
    const latestReview = state.reviews
      .filter((review) => review.missionId === approval.missionId && review.workItemId === workItem.id)
      .at(-1);
    if (
      latestReview?.id !== approval.reviewId ||
      latestReview.attempt !== approval.attempt ||
      latestReview.outcome !== "accepted"
    ) {
      fail("approval_blocked", `Approval ${approval.id} is stale for the current implementation review.`);
    }
  }
}

function ensureApprovedAction(
  state: MissionState,
  missionId: string,
  input: ActionExecutionInput,
  now: string,
): Approval | null {
  const action = normalizeActionType(requiredString(input.action, "action", 200));
  const policy = getActionPolicy(action);
  if (!policy.requiresApproval) {
    return null;
  }
  const target = requiredString(input.target, "target", 2_000);
  const expectedEffect = requiredString(input.expectedEffect, "expectedEffect");
  const approvalId = input.approvalId === undefined
    ? undefined
    : normalizedId(input.approvalId, "approvalId");
  const approval = approvalId === undefined
    ? state.approvals
        .filter((candidate) =>
          candidate.missionId === missionId &&
          candidate.actionType === action &&
          candidate.target === target &&
          candidate.expectedEffect === expectedEffect,
        )
        .at(-1)
    : state.approvals.find((candidate) =>
        candidate.id === approvalId && candidate.missionId === missionId,
      );
  if (approval === undefined || approval.actionType !== action ||
      approval.target !== target || approval.expectedEffect !== expectedEffect) {
    fail(
      "approval_blocked",
      `Action ${action} has no matching approval for target ${target}.`,
    );
  }
  if (approval.decision !== "approved") {
    fail(
      "approval_blocked",
      `Action ${action} cannot execute while approval ${approval.id} is ${approval.decision}.`,
    );
  }
  if (approvalIsExpired(approval, now)) {
    fail("approval_blocked", `Approval ${approval.id} has expired.`);
  }
  ensureApprovalEvidence(state, approval);
  ensureCurrentApprovalCorrelation(state, approval);
  return approval;
}

function ensureApprovedDelivery(
  state: MissionState,
  missionId: string,
  approvalId: string | undefined,
  now: string,
): Approval {
  const normalizedApprovalId = approvalId === undefined
    ? undefined
    : normalizedId(approvalId, "approvalId");
  const approval = normalizedApprovalId === undefined
    ? state.approvals
        .filter((candidate) =>
          candidate.missionId === missionId &&
          candidate.actionType === PRIMARY_CONSEQUENTIAL_ACTION,
        )
        .at(-1)
    : state.approvals.find((candidate) =>
        candidate.id === normalizedApprovalId && candidate.missionId === missionId,
      );
  if (approval === undefined || approval.actionType !== PRIMARY_CONSEQUENTIAL_ACTION) {
    fail(
      "approval_blocked",
      "The verified delivery cannot execute without a matching approval request.",
    );
  }
  if (approval.decision !== "approved") {
    fail(
      "approval_blocked",
      `The verified delivery cannot execute while approval ${approval.id} is ${approval.decision}.`,
    );
  }
  if (approvalIsExpired(approval, now)) {
    fail("approval_blocked", `Approval ${approval.id} has expired.`);
  }
  ensureApprovalEvidence(state, approval);
  ensureCurrentApprovalCorrelation(state, approval);
  return approval;
}

function ensureDeliveryAttemptMatchesApproval(
  approval: Approval,
  target: DeliveryAttemptTarget,
  actionType: string,
  expectedEffect: string,
): void {
  const context = approval.executionContext;
  if (
    context === undefined ||
    approval.actionType !== PRIMARY_CONSEQUENTIAL_ACTION ||
    actionType !== approval.actionType ||
    expectedEffect !== approval.expectedEffect ||
    context.repositoryOwner !== target.repositoryOwner ||
    context.repositoryName !== target.repositoryName ||
    context.base !== target.base ||
    context.head !== target.head ||
    (context.headSha !== undefined && context.headSha !== target.headSha) ||
    (context.artifactHash !== undefined && target.artifact?.contentHash !== context.artifactHash) ||
    context.title !== target.title ||
    context.body !== target.body
  ) {
    fail(
      "approval_blocked",
      "The durable delivery attempt does not match the exact approved repository, base, head, artifact, SHA, or effect.",
    );
  }
}

function ensureDeliveryAttemptResultMatchesTarget(
  deliveryAttempt: DeliveryAttempt,
  pullRequest: PullRequestReference,
  executionOrigin: ExecutionOrigin,
): void {
  if (
    pullRequest.headSha === undefined ||
    pullRequest.repositoryOwner !== deliveryAttempt.target.repositoryOwner ||
    pullRequest.repositoryName !== deliveryAttempt.target.repositoryName ||
    pullRequest.base !== deliveryAttempt.target.base ||
    pullRequest.head !== deliveryAttempt.target.head ||
    (deliveryAttempt.target.headSha !== undefined &&
      pullRequest.headSha !== deliveryAttempt.target.headSha) ||
    executionOrigin.kind !== "mcp"
  ) {
    fail(
      "approval_blocked",
      "The reconciled pull request result does not match the exact approved delivery attempt.",
    );
  }
}

type StructuredHandoffRecord = Handoff & {
  diffSummary: string;
  checks: ImplementationCheck[];
  evidenceIds: string[];
  executionOrigin: ExecutionOrigin;
};

function asStructuredHandoff(handoff: Handoff): StructuredHandoffRecord | null {
  return handoff.diffSummary !== undefined &&
      handoff.checks !== undefined &&
      handoff.evidenceIds !== undefined &&
      handoff.executionOrigin !== undefined
    ? handoff as StructuredHandoffRecord
    : null;
}

function isStructuredImplementationWorkItem(workItem: WorkItem): boolean {
  return workItem.assignedRole === "implementer" && (
    workItem.delegation !== undefined ||
    (workItem.requiredChecks !== undefined && workItem.requiredChecks.length > 0 &&
      workItem.allowedFiles !== undefined && workItem.allowedFiles.length > 0)
  );
}

function isDelegatedImplementationWorkItem(workItem: WorkItem): boolean {
  return isStructuredImplementationWorkItem(workItem) && workItem.delegation !== undefined;
}

function isCoordinatorWorkspaceDeltaEvidence(evidence: Evidence): boolean {
  const origin = evidence.executionOrigin;
  return evidence.source === "trueforge" &&
    origin?.kind === "trueforge" &&
    origin.turnId !== undefined &&
    origin.threadId === TRUEFORGE_ROOT_THREAD_ID &&
    origin.toolCallId !== undefined &&
    parseDelegatedWorkspaceDeltaEvidence(evidence) !== null;
}

function handoffMatchesCurrentDelegation(workItem: WorkItem, handoff: Handoff): boolean {
  if (!isDelegatedImplementationWorkItem(workItem)) {
    return false;
  }
  const structured = asStructuredHandoff(handoff);
  const delegation = workItem.delegation;
  return structured !== null &&
    delegation?.status === "completed" &&
    delegation.threadId === structured.executionOrigin.threadId &&
    (delegation.turnId === undefined || delegation.turnId === structured.executionOrigin.turnId);
}

function validateStructuredHandoffCorrelation(
  state: MissionState,
  handoff: Handoff,
  workItem: WorkItem,
  enforceCurrentDelegation = true,
): void {
  const structured = asStructuredHandoff(handoff);
  if (structured === null) {
    return;
  }
  const evidenceById = new Map(state.evidence.map((item) => [item.id, item]));
  const matchesHandoffOrigin = (evidence: Evidence): boolean => {
    const evidenceOrigin = evidence.executionOrigin;
    const handoffOrigin = structured.executionOrigin;
    return evidenceOrigin !== undefined &&
      evidenceOrigin.sessionId === handoffOrigin.sessionId &&
      (handoffOrigin.turnId === undefined || evidenceOrigin.turnId === handoffOrigin.turnId) &&
      (handoffOrigin.threadId === undefined || evidenceOrigin.threadId === handoffOrigin.threadId);
  };
  const linkedEvidence = structured.evidenceIds.map((evidenceId) => {
    const evidence = evidenceById.get(evidenceId);
    if (
      evidence === undefined ||
      evidence.missionId !== handoff.missionId ||
      evidence.workItemId !== handoff.workItemId
    ) {
      return fail(
        "invalid_input",
        `Handoff ${handoff.id} references uncorrelated evidence ${evidenceId}.`,
      );
    }
    if (evidence.executionOrigin === undefined) {
      return fail(
        "invalid_input",
        `Evidence ${evidence.id} is missing an execution origin for handoff ${handoff.id}.`,
      );
    }
    if (evidence.executionOrigin.sessionId !== structured.executionOrigin.sessionId) {
      return fail(
        "invalid_input",
        `Evidence ${evidence.id} belongs to a different execution session than handoff ${handoff.id}.`,
      );
    }
    const isCoordinatorWorkspaceProof = isCoordinatorWorkspaceDeltaEvidence(evidence);
    if (
      structured.executionOrigin.turnId !== undefined &&
      evidence.executionOrigin.turnId !== structured.executionOrigin.turnId &&
      !isCoordinatorWorkspaceProof
    ) {
      return fail(
        "invalid_input",
        `Evidence ${evidence.id} belongs to a different execution turn than handoff ${handoff.id}.`,
      );
    }
    return evidence;
  });

  if (
    structured.executionOrigin.threadId !== undefined &&
    !linkedEvidence.some((evidence) =>
      evidence.executionOrigin?.threadId === structured.executionOrigin.threadId,
    )
  ) {
    return fail(
      "invalid_input",
      `Handoff ${handoff.id} has no evidence from its execution thread.`,
    );
  }
  if (
    isDelegatedImplementationWorkItem(workItem) &&
    enforceCurrentDelegation &&
    (structured.executionOrigin.threadId === undefined ||
      structured.executionOrigin.threadId !== workItem.delegation?.threadId)
  ) {
    return fail(
      "invalid_input",
      `Handoff ${handoff.id} is not correlated to the delegated execution thread.`,
    );
  }
  if (
    state.missions.find((mission) => mission.id === handoff.missionId)?.trueforgeSessionId !== undefined &&
    state.missions.find((mission) => mission.id === handoff.missionId)?.trueforgeSessionId !==
      structured.executionOrigin.sessionId
  ) {
    return fail(
      "invalid_input",
      `Handoff ${handoff.id} is not correlated to the mission TrueForge session.`,
    );
  }

  for (const check of structured.checks) {
    if (!check.evidenceIds.every((evidenceId) => structured.evidenceIds.includes(evidenceId))) {
      return fail(
        "invalid_input",
        `Handoff ${handoff.id} contains check evidence outside its evidence set.`,
      );
    }
    const checkEvidence = check.evidenceIds.map((evidenceId) => evidenceById.get(evidenceId));
    if (
      check.result !== "not_run" &&
      checkEvidence.some((evidence) => evidence === undefined || !matchesHandoffOrigin(evidence))
    ) {
      return fail(
        "invalid_input",
        `Handoff ${handoff.id} uses ${check.name} evidence from a different execution thread.`,
      );
    }
    if (
      check.result === "passed" &&
      !checkEvidence.some((evidence) => evidence?.result === "passed")
    ) {
      return fail("invalid_input", `Handoff ${handoff.id} marks ${check.name} passed without passing evidence.`);
    }
    if (
      check.result === "failed" &&
      !checkEvidence.some((evidence) => evidence?.result === "failed")
    ) {
      return fail("invalid_input", `Handoff ${handoff.id} marks ${check.name} failed without failed evidence.`);
    }
  }

  const changedStateEvidence = linkedEvidence.filter((evidence) =>
    evidence.kind === "diff_summary" || evidence.kind === "file_change"
  );
  if (changedStateEvidence.some((evidence) =>
    !matchesHandoffOrigin(evidence) && !isCoordinatorWorkspaceDeltaEvidence(evidence)
  )) {
    return fail(
      "invalid_input",
      `Handoff ${handoff.id} uses changed-state evidence from a different execution thread.`,
    );
  }

  if (isDelegatedImplementationWorkItem(workItem) && enforceCurrentDelegation) {
    const workspaceDeltaEvidence = linkedEvidence
      .map((evidence) => ({
        evidence,
        parsed: isCoordinatorWorkspaceDeltaEvidence(evidence)
          ? parseDelegatedWorkspaceDeltaEvidence(evidence)
          : null,
      }))
      .filter((candidate): candidate is typeof candidate & {
        parsed: NonNullable<typeof candidate.parsed>;
      } => candidate.parsed !== null);
    const workspaceDelta = workspaceDeltaEvidence.at(-1)?.parsed;
    if (workspaceDelta === undefined) {
      return fail(
        "invalid_input",
        `Handoff ${handoff.id} has no coordinator-collected anchored workspace delta for delegated implementation.`,
      );
    }
    const allowedFiles = workItem.allowedFiles;
    if (allowedFiles === undefined || allowedFiles.length === 0) {
      return fail(
        "invalid_input",
        `Work item ${workItem.id} has no explicit allowed file scope for delegated implementation.`,
      );
    }
    const delegation = workItem.delegation;
    if (
      delegation?.startTreeRef === undefined ||
      delegation.missionStartTreeRef === undefined
    ) {
      return fail(
        "invalid_input",
        `Work item ${workItem.id} has no known per-work-item workspace start state for delegated implementation.`,
      );
    }
    const mission = state.missions.find((candidate) => candidate.id === handoff.missionId);
    if (
      mission?.trueforgeWorkspaceBaselineTreeRef === undefined ||
      workspaceDelta.startTreeRef !== delegation.startTreeRef ||
      workspaceDelta.missionStartTreeRef !== delegation.missionStartTreeRef ||
      workspaceDelta.missionStartTreeRef !== mission.trueforgeWorkspaceBaselineTreeRef
    ) {
      return fail(
        "invalid_input",
        `Handoff ${handoff.id} is not anchored to the persisted mission and work-item workspace start states.`,
      );
    }
    const observedChangedFiles = [...new Set(changedStateEvidence.flatMap((evidence) =>
      changedFilesFromContentBearingEvidence(evidence) ?? []
    ))];
    const currentChangedFiles = workspaceDelta.currentChangedFiles;
    const missionAllowedFiles = [...new Set(state.workItems
      .filter((item) => item.missionId === handoff.missionId && item.assignedRole === "implementer")
      .flatMap((item) => item.allowedFiles ?? []))];
    const itemOutOfScopeFiles = [...new Set([
      ...handoff.filesChanged,
      ...currentChangedFiles,
      ...observedChangedFiles,
    ].filter((file) => !allowedFiles.includes(file)))];
    if (itemOutOfScopeFiles.length > 0) {
      return fail(
        "invalid_input",
        `Handoff ${handoff.id} changes files outside work item ${workItem.id} scope: ${itemOutOfScopeFiles.join(", ")}. Allowed files: ${allowedFiles.join(", ")}.`,
      );
    }
    const cumulativeOutOfScopeFiles = workspaceDelta.cumulativeChangedFiles.filter((file) =>
      !missionAllowedFiles.includes(file),
    );
    if (cumulativeOutOfScopeFiles.length > 0) {
      return fail(
        "invalid_input",
        `Handoff ${handoff.id} includes cumulative mission changes outside the union of authorized work-item scopes: ${cumulativeOutOfScopeFiles.join(", ")}. Authorized files: ${missionAllowedFiles.join(", ")}.`,
      );
    }
    const missingFromScopedDiff = currentChangedFiles.filter((file) => !observedChangedFiles.includes(file));
    const missingFromWorkspaceDelta = observedChangedFiles.filter((file) => !currentChangedFiles.includes(file));
    if (
      observedChangedFiles.length > 0 &&
      (missingFromScopedDiff.length > 0 || missingFromWorkspaceDelta.length > 0)
    ) {
      const differences = [
        ...(missingFromScopedDiff.length === 0
          ? []
          : [`missing from the scoped content diff: ${missingFromScopedDiff.join(", ")}`]),
        ...(missingFromWorkspaceDelta.length === 0
          ? []
          : [`missing from the coordinator workspace delta: ${missingFromWorkspaceDelta.join(", ")}`]),
      ];
      return fail(
        "invalid_input",
        `Handoff ${handoff.id} has a coordinator workspace delta that does not match its scoped content diff (${differences.join("; ")}).`,
      );
    }
  }

  if (handoff.result !== "done") {
    return;
  }
  if (isDelegatedImplementationWorkItem(workItem)) {
    if (structured.executionOrigin.kind !== "trueforge") {
      return fail(
        "invalid_input",
        `Handoff ${handoff.id} must identify the TrueForge origin of delegated work.`,
      );
    }
    if (enforceCurrentDelegation && workItem.delegation?.status !== "completed") {
      return fail(
        "invalid_input",
        `Handoff ${handoff.id} cannot complete before its delegation completes.`,
      );
    }
    if (enforceCurrentDelegation && workItem.delegation?.threadId !== structured.executionOrigin.threadId) {
      return fail(
        "invalid_input",
        `Handoff ${handoff.id} is not correlated to the delegated thread.`,
      );
    }
    if (
      enforceCurrentDelegation &&
      workItem.delegation?.turnId !== undefined &&
      workItem.delegation?.turnId !== structured.executionOrigin.turnId
    ) {
      return fail(
        "invalid_input",
        `Handoff ${handoff.id} is not correlated to the delegated turn.`,
      );
    }
  }
  const requiredChecks = workItem.requiredChecks ?? [];
  for (const requiredCheck of requiredChecks) {
    const check = structured.checks.find((candidate) => candidate.name === requiredCheck);
    if (check === undefined || !check.required || check.result !== "passed") {
      return fail(
        "invalid_input",
        `Handoff ${handoff.id} is missing a passed required check: ${requiredCheck}.`,
      );
    }
  }
}

function ensureSuccessfulImplementationHandoff(state: MissionState, workItem: WorkItem): void {
  const latest = state.handoffs
    .filter((handoff) => handoff.missionId === workItem.missionId && handoff.workItemId === workItem.id)
    .at(-1);
  const structured = latest === undefined ? null : asStructuredHandoff(latest);
  if (workItem.attempt > 0 && latest?.attempt !== workItem.attempt) {
    return fail(
      "invalid_transition",
      `Work item ${workItem.id} requires a structured implementation handoff for attempt ${workItem.attempt}.`,
    );
  }
  if (latest === undefined || structured === null || latest.result !== "done") {
    const proofFailure = state.evidence
      .filter((evidence) =>
        evidence.missionId === workItem.missionId &&
        evidence.workItemId === workItem.id &&
        evidence.source === "trueforge" &&
        evidence.result === "failed" &&
        evidence.summary.startsWith("Delegated implementation evidence failed:"),
      )
      .at(-1);
    if (proofFailure !== undefined) {
      return fail(
        "invalid_transition",
        `Work item ${workItem.id} cannot reach review: ${proofFailure.summary}`,
      );
    }
    return fail(
      "invalid_transition",
      `Work item ${workItem.id} requires a valid structured implementation handoff before review.`,
    );
  }
  validateStructuredHandoffCorrelation(state, latest, workItem);
}

function ensureAcceptedIndependentReview(state: MissionState, workItem: WorkItem): void {
  const latestHandoff = state.handoffs
    .filter((handoff) => handoff.missionId === workItem.missionId && handoff.workItemId === workItem.id)
    .at(-1);
  const latestReview = state.reviews
    .filter((review) => review.missionId === workItem.missionId && review.workItemId === workItem.id)
    .at(-1);
  if (
    latestHandoff === undefined ||
    latestReview === undefined ||
    latestReview.outcome !== "accepted" ||
    latestReview.handoffId !== latestHandoff.id ||
    (workItem.attempt > 0 &&
      (latestHandoff.attempt !== workItem.attempt || latestReview.attempt !== workItem.attempt))
  ) {
    return fail(
      "invalid_transition",
      `Work item ${workItem.id} requires an accepted independent review before completion.`,
    );
  }
}

function changedFilesFromContentBearingEvidence(evidence: Evidence): string[] | null {
  return parseContentDiffEvidence(evidence)?.filesChanged ?? null;
}

function isContentBearingChangedStateEvidence(evidence: Evidence): boolean {
  return changedFilesFromContentBearingEvidence(evidence) !== null;
}

function buildReviewContext(
  state: MissionState,
  missionId: string,
  workItemId: string,
): ReviewContext {
  const workItem = findWorkItem(state, missionId, workItemId);
  if (!isStructuredImplementationWorkItem(workItem)) {
    return fail(
      "invalid_transition",
      `Work item ${workItem.id} is not eligible for independent implementation review.`,
    );
  }
  ensureSuccessfulImplementationHandoff(state, workItem);
  const handoff = state.handoffs
    .filter((candidate) => candidate.missionId === missionId && candidate.workItemId === workItemId)
    .at(-1);
  if (handoff === undefined) {
    return fail("invalid_transition", `Work item ${workItem.id} has no handoff to review.`);
  }
  const structured = asStructuredHandoff(handoff);
  if (structured === null) {
    return fail("invalid_transition", `Work item ${workItem.id} has no structured handoff to review.`);
  }
  const evidenceById = new Map(state.evidence.map((item) => [item.id, item]));
  const evidence = structured.evidenceIds.map((evidenceId) => {
    const item = evidenceById.get(evidenceId);
    if (item === undefined) {
      return fail("invalid_input", `Review evidence ${evidenceId} is not available.`);
    }
    return item;
  });
  if (!evidence.some(isContentBearingChangedStateEvidence)) {
    return fail(
      "invalid_transition",
      `Work item ${workItem.id} has no content-bearing changed-state evidence for independent review.`,
    );
  }
  const actualFilesChanged = [...new Set(evidence.flatMap((item) =>
    changedFilesFromContentBearingEvidence(item) ?? []
  ))];
  const actualDiff = evidence
    .map((item) => parseContentDiffEvidence(item)?.output)
    .filter((output): output is string => output !== undefined)
    .at(-1) ?? "";
  for (const requiredCheck of workItem.requiredChecks ?? []) {
    const check = structured.checks.find((candidate) => candidate.name === requiredCheck);
    if (check === undefined || check.result !== "passed" || !check.required) {
      return fail(
        "invalid_transition",
        `Work item ${workItem.id} has insufficient proof for required check ${requiredCheck}.`,
      );
    }
  }
  return {
    workItem: clone(workItem),
    handoff: clone(handoff),
    filesChanged: [...handoff.filesChanged],
    actualFilesChanged,
    actualDiff,
    diffSummary: structured.diffSummary,
    checks: clone(structured.checks),
    evidence: clone(evidence),
  };
}

export class MissionService {
  private state: MissionState | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: MissionRepository = new InMemoryMissionRepository(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async getState(): Promise<MissionState> {
    await this.pending;
    return clone(await this.ensureState());
  }

  async getMission(missionId: string): Promise<Mission> {
    const state = await this.getState();
    return clone(findMission(state, normalizedId(missionId, "missionId")));
  }

  async getWorkItem(missionId: string, workItemId: string): Promise<WorkItem> {
    const state = await this.getState();
    return clone(
      findWorkItem(
        state,
        normalizedId(missionId, "missionId"),
        normalizedId(workItemId, "workItemId"),
      ),
    );
  }

  async listWorkItems(missionId: string): Promise<WorkItem[]> {
    const state = await this.getState();
    const normalizedMissionId = normalizedId(missionId, "missionId");
    findMission(state, normalizedMissionId);
    return clone(state.workItems.filter((item) => item.missionId === normalizedMissionId));
  }

  async getEvidence(missionId: string, evidenceId: string): Promise<Evidence> {
    const state = await this.getState();
    const normalizedMissionId = normalizedId(missionId, "missionId");
    findMission(state, normalizedMissionId);
    const evidence = state.evidence.find(
      (item) => item.id === normalizedId(evidenceId, "evidenceId") &&
        item.missionId === normalizedMissionId,
    );
    if (evidence === undefined) {
      fail("not_found", `Evidence ${evidenceId} was not found in mission ${normalizedMissionId}.`);
    }
    return clone(evidence);
  }

  async listEvidence(missionId: string, workItemId?: string): Promise<Evidence[]> {
    const state = await this.getState();
    const normalizedMissionId = normalizedId(missionId, "missionId");
    findMission(state, normalizedMissionId);
    const normalizedWorkItemId = workItemId === undefined
      ? undefined
      : normalizedId(workItemId, "workItemId");
    return clone(state.evidence.filter((item) =>
      item.missionId === normalizedMissionId &&
      (normalizedWorkItemId === undefined || item.workItemId === normalizedWorkItemId),
    ));
  }

  async listHandoffs(missionId: string, workItemId?: string): Promise<Handoff[]> {
    const state = await this.getState();
    const normalizedMissionId = normalizedId(missionId, "missionId");
    findMission(state, normalizedMissionId);
    const normalizedWorkItemId = workItemId === undefined
      ? undefined
      : normalizedId(workItemId, "workItemId");
    return clone(state.handoffs.filter((item) =>
      item.missionId === normalizedMissionId &&
      (normalizedWorkItemId === undefined || item.workItemId === normalizedWorkItemId),
    ));
  }

  async getReviewContext(missionId: string, workItemId: string): Promise<ReviewContext> {
    const state = await this.getState();
    const normalizedMissionId = normalizedId(missionId, "missionId");
    findMission(state, normalizedMissionId);
    return buildReviewContext(
      state,
      normalizedMissionId,
      normalizedId(workItemId, "workItemId"),
    );
  }

  async listReviews(missionId: string, workItemId?: string): Promise<Review[]> {
    const state = await this.getState();
    const normalizedMissionId = normalizedId(missionId, "missionId");
    findMission(state, normalizedMissionId);
    const normalizedWorkItemId = workItemId === undefined
      ? undefined
      : normalizedId(workItemId, "workItemId");
    return clone(state.reviews.filter((item) =>
      item.missionId === normalizedMissionId &&
      (normalizedWorkItemId === undefined || item.workItemId === normalizedWorkItemId),
    ));
  }

  async canStartWorkItem(missionId: string, workItemId: string): Promise<boolean> {
    const state = await this.getState();
    const workItem = findWorkItem(
      state,
      normalizedId(missionId, "missionId"),
      normalizedId(workItemId, "workItemId"),
    );
    return workItem.status === "ready" && workItem.dependsOn.every((dependencyId) =>
      state.workItems.some((item) => item.id === dependencyId && isCompletedWorkItemStatus(item.status)),
    );
  }

  /**
   * Apply the only status changes a human may make from the board. The actor
   * and expected revision are persisted/checked together with the mutation so
   * a stale browser cannot silently overwrite another operator's decision.
   */
  async moveWorkItemByHuman(
    missionId: string,
    workItemId: string,
    status: "backlog" | "ready",
    input: HumanWorkItemTransitionInput,
  ): Promise<WorkItem> {
    const actor = requiredString(input.actor, "actor", 200);
    if (status === "ready") {
      return this.authorizeWorkItem(missionId, workItemId, {
        actor,
        ...(input.expectedRevision === undefined
          ? {}
          : { expectedRevision: input.expectedRevision }),
      });
    }
    return this.revokeWorkItemAuthorization(missionId, workItemId, {
      actor,
      ...(input.expectedRevision === undefined
        ? {}
        : { expectedRevision: input.expectedRevision }),
    });
  }

  async authorizeWorkItem(
    missionId: string,
    workItemId: string,
    input: HumanWorkItemTransitionInput,
  ): Promise<WorkItem> {
    return this.mutate((state, now) => {
      ensureExpectedRevision(state, input.expectedRevision);
      const normalizedMissionId = normalizedId(missionId, "missionId");
      const mission = findMission(state, normalizedMissionId);
      ensureOpen(mission);
      const workItem = findWorkItem(
        state,
        normalizedMissionId,
        normalizedId(workItemId, "workItemId"),
      );
      if (workItem.status !== "backlog" && workItem.status !== "changes_requested") {
        fail(
          "invalid_transition",
          `Work item ${workItem.id} can only be authorized from backlog or changes_requested, not ${workItem.status}.`,
        );
      }
      if (workItem.status === "backlog" && workItem.claim !== undefined) {
        fail("invalid_transition", `Work item ${workItem.id} has already been claimed.`);
      }
      ensureDependenciesComplete(state, workItem);
      const actor = requiredString(input.actor, "actor", 200);
      if (workItem.status === "changes_requested") {
        if (workItem.delegation?.status === "running") {
          fail(
            "invalid_transition",
            `Work item ${workItem.id} still has a running delegation; it cannot be reauthorized yet.`,
          );
        }
        const priorAttempt = workItem.claim === undefined
          ? workItem.attempts.at(-1)
          : ensureAttemptHistoryForClaim(workItem);
        if (priorAttempt !== undefined) {
          if (workItem.claim !== undefined) {
            priorAttempt.claim = clone(workItem.claim);
          }
          priorAttempt.status = "changes_requested";
          priorAttempt.retiredAt = now;
          priorAttempt.retiredBy = actor;
        }
        delete workItem.claim;
      }
      workItem.executionAuthorization = {
        authorizedBy: actor,
        authorizedAt: now,
      };
      delete workItem.blockedReason;
      workItem.status = "ready";
      workItem.updatedAt = now;
      return workItem;
    });
  }

  async revokeWorkItemAuthorization(
    missionId: string,
    workItemId: string,
    input: HumanWorkItemTransitionInput,
  ): Promise<WorkItem> {
    return this.mutate((state, now) => {
      ensureExpectedRevision(state, input.expectedRevision);
      const normalizedMissionId = normalizedId(missionId, "missionId");
      const mission = findMission(state, normalizedMissionId);
      ensureOpen(mission);
      const workItem = findWorkItem(
        state,
        normalizedMissionId,
        normalizedId(workItemId, "workItemId"),
      );
      if (workItem.status !== "ready") {
        fail(
          "invalid_transition",
          `Work item ${workItem.id} can only be returned to backlog from ready, not ${workItem.status}.`,
        );
      }
      if (workItem.claim !== undefined) {
        fail(
          "invalid_transition",
          `Work item ${workItem.id} cannot return to backlog after it has been claimed.`,
        );
      }
      requiredString(input.actor, "actor", 200);
      delete workItem.executionAuthorization;
      workItem.status = "backlog";
      workItem.updatedAt = now;
      return workItem;
    });
  }

  /** Claim is a one-way, system-owned handoff from an authorized queue item. */
  async claimWorkItem(
    missionId: string,
    workItemId: string,
    input: ClaimWorkItemInput,
  ): Promise<WorkItem> {
    return this.mutate((state, now) => {
      ensureExpectedRevision(state, input.expectedRevision);
      const normalizedMissionId = normalizedId(missionId, "missionId");
      const mission = findMission(state, normalizedMissionId);
      ensureOpen(mission);
      const workItem = findWorkItem(
        state,
        normalizedMissionId,
        normalizedId(workItemId, "workItemId"),
      );
      if (workItem.status !== "ready") {
        fail(
          "invalid_transition",
          `Work item ${workItem.id} can only be claimed from ready, not ${workItem.status}.`,
        );
      }
      if (workItem.executionAuthorization === undefined) {
        fail(
          "invalid_transition",
          `Work item ${workItem.id} cannot be claimed before human execution authorization.`,
        );
      }
      if (workItem.claim !== undefined) {
        fail("invalid_transition", `Work item ${workItem.id} has already been claimed.`);
      }
      ensureDependenciesComplete(state, workItem);
      const owner = requiredString(input.owner, "owner", 200);
      const requestedSessionId = optionalString(
        input.trueforgeSessionId,
        "trueforgeSessionId",
        200,
      );
      const requestedSandboxId = optionalString(
        input.trueforgeSandboxId,
        "trueforgeSandboxId",
        200,
      );
      const priorAttempt = workItem.attempts.at(-1);
      const priorClaim = priorAttempt?.claim;
      const trueforgeSessionId = stableExecutionBinding(
        "TrueForge session",
        requestedSessionId,
        mission.trueforgeSessionId,
        priorClaim?.trueforgeSessionId,
      );
      const trueforgeSandboxId = stableExecutionBinding(
        "TrueForge sandbox",
        requestedSandboxId,
        mission.trueforgeSandboxId,
        priorClaim?.trueforgeSandboxId,
      );
      const claim: WorkItemClaim = {
        owner,
        claimedAt: now,
        ...(trueforgeSessionId === undefined ? {} : { trueforgeSessionId }),
        ...(trueforgeSandboxId === undefined ? {} : { trueforgeSandboxId }),
      };
      const attempt: WorkItemAttempt = {
        number: workItem.attempt + 1,
        authorization: clone(workItem.executionAuthorization),
        requestedChanges: [...(workItem.requestedChanges ?? [])],
        claim: clone(claim),
        status: "in_progress",
      };
      workItem.attempt = attempt.number;
      workItem.attempts.push(attempt);
      workItem.claim = claim;
      workItem.status = "in_progress";
      workItem.updatedAt = now;
      return workItem;
    });
  }

  async claimReadyWorkItem(
    missionId: string,
    workItemId: string,
    input: ClaimWorkItemInput,
  ): Promise<WorkItem> {
    return this.claimWorkItem(missionId, workItemId, input);
  }

  async resumeChangesRequestedWorkItem(
    missionId: string,
    workItemId: string,
    expectedRevision?: number,
  ): Promise<WorkItem> {
    throw new MissionDomainError(
      "invalid_transition",
      "Changes Requested is a hard stop; a human must move the ticket to Ready before it can be claimed again.",
    );
  }

  async transitionSystemWorkItem(
    missionId: string,
    workItemId: string,
    status: TicketStatus,
    options: Omit<WorkItemTransitionOptions, "trigger"> & {
      trigger: Exclude<WorkItemTransitionTrigger, "human" | "legacy">;
    },
  ): Promise<WorkItem> {
    return this.mutate((state, now) => {
      ensureExpectedRevision(state, options.expectedRevision);
      const normalizedMissionId = normalizedId(missionId, "missionId");
      const mission = findMission(state, normalizedMissionId);
      ensureOpen(mission);
      const workItem = findWorkItem(
        state,
        normalizedMissionId,
        normalizedId(workItemId, "workItemId"),
      );
      const nextStatus = enumValue(status, ticketStatuses, "status");
      const fromStatus = workItem.status;
      if (!isProductWorkItemStatus(fromStatus)) {
        fail(
          "invalid_transition",
          `Legacy work item ${workItem.id} must be migrated before system transitions are used.`,
        );
      }
      const legal =
        (options.trigger === "claim" &&
          fromStatus === "ready" && nextStatus === "in_progress") ||
        (options.trigger === "execution" && fromStatus === "in_progress" && nextStatus === "proving") ||
        (options.trigger === "proof" && fromStatus === "proving" &&
          (["changes_requested", "awaiting_approval", "blocked"].includes(nextStatus) ||
            (nextStatus === "done" && workItem.assignedRole !== "implementer"))) ||
        (options.trigger === "approval" && fromStatus === "awaiting_approval" && nextStatus === "delivering") ||
        (options.trigger === "delivery" && fromStatus === "delivering" && nextStatus === "done") ||
        (options.trigger === "failure" &&
          ["ready", "in_progress", "proving", "changes_requested", "awaiting_approval", "delivering"]
            .includes(fromStatus) && nextStatus === "blocked") ||
        (options.trigger === "retry" && fromStatus === "blocked" && nextStatus === "in_progress");
      if (!legal) {
        fail(
          "invalid_transition",
          `Work item ${workItem.id} cannot transition from ${fromStatus} to ${nextStatus} through ${options.trigger}.`,
        );
      }
      if (["in_progress", "proving", "changes_requested", "awaiting_approval", "delivering", "done"]
        .includes(nextStatus) && workItem.claim === undefined) {
        fail("invalid_transition", `Work item ${workItem.id} has no durable claim.`);
      }
      if (nextStatus === "blocked") {
        workItem.blockedReason = requiredString(options.reason, "reason", 2_000);
      } else {
        delete workItem.blockedReason;
      }
      if (nextStatus === "changes_requested") {
        workItem.requestedChanges = [workItemFinding(state, workItem, options.reason)];
      } else if (nextStatus === "awaiting_approval" || nextStatus === "done") {
        delete workItem.requestedChanges;
      }
      updateCurrentAttempt(workItem, nextStatus as WorkItemAttemptStatus);
      workItem.status = nextStatus;
      workItem.updatedAt = now;
      return workItem;
    });
  }

  async createMission(input: CreateMissionInput): Promise<Mission> {
    return this.mutate((state, now) => {
      const id = input.id === undefined ? newId("mission") : normalizedId(input.id, "mission.id");
      ensureUniqueEntityId(state, id);
      const repository =
        input.repository === undefined ? undefined : normalizeRepository(input.repository);
      const trueforgeSessionId = optionalString(
        input.trueforgeSessionId,
        "trueforgeSessionId",
        200,
      );
      const trueforgeSandboxId = optionalString(
        input.trueforgeSandboxId,
        "trueforgeSandboxId",
        200,
      );
      const mission: Mission = {
        id,
        objective: requiredString(input.objective, "objective"),
        status: "draft",
        createdAt: now,
        updatedAt: now,
      };
      if (repository !== undefined) {
        mission.repository = repository;
      }
      if (trueforgeSessionId !== undefined) {
        mission.trueforgeSessionId = trueforgeSessionId;
      }
      if (trueforgeSandboxId !== undefined) {
        mission.trueforgeSandboxId = trueforgeSandboxId;
      }
      state.missions.push(mission);
      return mission;
    });
  }

  async attachTrueforgeSession(missionId: string, sessionId: string): Promise<Mission> {
    return this.mutate((state, now) => {
      const mission = findMission(state, normalizedId(missionId, "missionId"));
      ensureOpen(mission);
      mission.trueforgeSessionId = requiredString(sessionId, "trueforgeSessionId", 200);
      mission.updatedAt = now;
      return mission;
    });
  }

  async attachTrueforgeTurn(missionId: string, turnId: string): Promise<Mission> {
    return this.mutate((state, now) => {
      const mission = findMission(state, normalizedId(missionId, "missionId"));
      ensureOpen(mission);
      mission.trueforgeTurnId = requiredString(turnId, "trueforgeTurnId", 200);
      mission.updatedAt = now;
      return mission;
    });
  }

  async attachTrueforgeSandbox(missionId: string, sandboxId: string): Promise<Mission> {
    return this.mutate((state, now) => {
      const mission = findMission(state, normalizedId(missionId, "missionId"));
      ensureOpen(mission);
      mission.trueforgeSandboxId = requiredString(sandboxId, "trueforgeSandboxId", 200);
      mission.updatedAt = now;
      return mission;
    });
  }

  async attachWorkItemExecution(
    missionId: string,
    workItemId: string,
    input: WorkItemExecutionBindingInput,
  ): Promise<WorkItem> {
    return this.mutate((state, now) => {
      const normalizedMissionId = normalizedId(missionId, "missionId");
      const mission = findMission(state, normalizedMissionId);
      ensureOpen(mission);
      const workItem = findWorkItem(
        state,
        normalizedMissionId,
        normalizedId(workItemId, "workItemId"),
      );
      if (workItem.claim === undefined) {
        fail(
          "invalid_transition",
          `Work item ${workItem.id} must be claimed before execution can be bound.`,
        );
      }
      const trueforgeSessionId = requiredString(
        input.trueforgeSessionId,
        "trueforgeSessionId",
        200,
      );
      const trueforgeSandboxId = optionalString(
        input.trueforgeSandboxId,
        "trueforgeSandboxId",
        200,
      );
      if (
        workItem.claim.trueforgeSessionId !== undefined &&
        workItem.claim.trueforgeSessionId !== trueforgeSessionId
      ) {
        fail(
          "invalid_transition",
          `Work item ${workItem.id} is already bound to a different TrueForge session.`,
        );
      }
      if (
        trueforgeSandboxId !== undefined &&
        workItem.claim.trueforgeSandboxId !== undefined &&
        workItem.claim.trueforgeSandboxId !== trueforgeSandboxId
      ) {
        fail(
          "invalid_transition",
          `Work item ${workItem.id} is already bound to a different TrueForge sandbox.`,
        );
      }
      workItem.claim.trueforgeSessionId = trueforgeSessionId;
      if (trueforgeSandboxId !== undefined) {
        workItem.claim.trueforgeSandboxId = trueforgeSandboxId;
      }
      const attempt = workItem.attempts.at(-1);
      if (attempt !== undefined) {
        attempt.claim = clone(workItem.claim);
      }
      workItem.updatedAt = now;
      return workItem;
    });
  }

  async attachTrueforgeWorkspaceBaseline(
    missionId: string,
    treeRef: string,
  ): Promise<Mission> {
    return this.mutate((state, now) => {
      const mission = findMission(state, normalizedId(missionId, "missionId"));
      ensureOpen(mission);
      const normalizedTreeRef = optionalTreeRef(treeRef, "trueforgeWorkspaceBaselineTreeRef");
      if (normalizedTreeRef === undefined) {
        fail(
          "invalid_input",
          "trueforgeWorkspaceBaselineTreeRef must be a hexadecimal Git tree reference.",
        );
      }
      if (
        mission.trueforgeWorkspaceBaselineTreeRef !== undefined &&
        mission.trueforgeWorkspaceBaselineTreeRef !== normalizedTreeRef
      ) {
        fail(
          "invalid_transition",
          `Mission ${mission.id} already has a different TrueForge workspace baseline tree reference.`,
        );
      }
      mission.trueforgeWorkspaceBaselineTreeRef = normalizedTreeRef;
      mission.updatedAt = now;
      return mission;
    });
  }

  async persistWorkGraph(missionId: string, graph: unknown): Promise<WorkItem[]> {
    const validatedGraph = validateWorkGraph(graph);
    return this.mutate((state, now) => {
      const normalizedMissionId = normalizedId(missionId, "missionId");
      const mission = findMission(state, normalizedMissionId);
      ensureOpen(mission);

      const existing = state.workItems.filter((item) => item.missionId === normalizedMissionId);
      const existingById = new Map(existing.map((item) => [item.id, item]));
      const graphIds = new Set(validatedGraph.items.map((item) => item.id));

      for (const item of existing) {
        if (!graphIds.has(item.id)) {
          return fail(
            "invalid_input",
            `The work graph cannot remove work item ${item.id} after it has been persisted.`,
          );
        }
      }
      for (const item of validatedGraph.items) {
        const conflictingWorkItem = state.workItems.find(
          (candidate) => candidate.id === item.id && candidate.missionId !== normalizedMissionId,
        );
        if (conflictingWorkItem !== undefined) {
          return fail("invalid_input", `Work item ID ${item.id} belongs to another mission.`);
        }
        const conflictingEntity = [
          ...state.missions,
          ...state.evidence,
          ...state.handoffs,
          ...state.reviews,
          ...state.approvals,
          ...state.deliveries,
        ].find((entity) => entity.id === item.id);
        if (conflictingEntity !== undefined) {
          return fail("invalid_input", `Work item ID ${item.id} is already in use.`);
        }
      }

      const workItems = validatedGraph.items.map((planned) => {
        const prior = existingById.get(planned.id);
        const dependenciesComplete = planned.dependsOn.every((dependencyId) =>
          state.workItems.some((item) => item.id === dependencyId && isCompletedWorkItemStatus(item.status)),
        );
        const status = prior === undefined
          ? dependenciesComplete ? "ready" : "backlog"
          : prior.status;
        if (
          prior !== undefined &&
          status !== "backlog" &&
          status !== "blocked" &&
          !dependenciesComplete
        ) {
          return fail(
            "dependency_blocked",
            `Work item ${planned.id} cannot keep status ${status} with incomplete dependencies.`,
          );
        }
        const workItem: WorkItem = {
          id: planned.id,
          missionId: normalizedMissionId,
          title: planned.title,
          purpose: planned.purpose,
          acceptanceCriteria: [...planned.acceptanceCriteria],
          status,
          dependsOn: [...planned.dependsOn],
          createdAt: prior?.createdAt ?? now,
          updatedAt: now,
          assignedRole: planned.assignedRole,
          attempt: prior?.attempt ?? 0,
          attempts: prior?.attempts === undefined ? [] : clone(prior.attempts),
        };
        const allowedFiles = planned.allowedFiles ?? prior?.allowedFiles;
        if (allowedFiles !== undefined) {
          workItem.allowedFiles = [...allowedFiles];
        }
        const requiredChecks = planned.requiredChecks ?? prior?.requiredChecks;
        if (requiredChecks !== undefined) {
          workItem.requiredChecks = [...requiredChecks];
        }
        if (prior?.delegation !== undefined) {
          workItem.delegation = clone(prior.delegation);
        }
        if (prior?.executionAuthorization !== undefined) {
          workItem.executionAuthorization = clone(prior.executionAuthorization);
        }
        if (prior?.claim !== undefined) {
          workItem.claim = clone(prior.claim);
        }
        if (prior?.requestedChanges !== undefined) {
          workItem.requestedChanges = [...prior.requestedChanges];
        }
        if (prior?.blockedReason !== undefined) {
          workItem.blockedReason = prior.blockedReason;
        }
        return workItem;
      });

      const firstIndex = state.workItems.findIndex((item) => item.missionId === normalizedMissionId);
      const withoutMission = state.workItems.filter((item) => item.missionId !== normalizedMissionId);
      if (firstIndex === -1) {
        state.workItems = [...withoutMission, ...workItems];
      } else {
        const insertIndex = Math.min(firstIndex, withoutMission.length);
        state.workItems = [
          ...withoutMission.slice(0, insertIndex),
          ...workItems,
          ...withoutMission.slice(insertIndex),
        ];
      }
      return workItems;
    });
  }

  async createWorkGraph(missionId: string, graph: unknown): Promise<WorkItem[]> {
    return this.persistWorkGraph(missionId, graph);
  }

  async replaceWorkGraph(missionId: string, graph: unknown): Promise<WorkItem[]> {
    return this.persistWorkGraph(missionId, graph);
  }

  async startWorkItemDelegation(
    missionId: string,
    workItemId: string,
    input: StartWorkItemDelegationInput,
  ): Promise<WorkItem> {
    return this.mutate((state, now) => {
      const normalizedMissionId = normalizedId(missionId, "missionId");
      const mission = findMission(state, normalizedMissionId);
      ensureOpen(mission);
      const workItem = findWorkItem(
        state,
        normalizedMissionId,
        normalizedId(workItemId, "workItemId"),
      );
      if (workItem.status !== "in_progress") {
        fail(
          "invalid_transition",
          `Work item ${workItem.id} must be in progress before delegation starts.`,
        );
      }
      ensureDependenciesComplete(state, workItem);
      if (workItem.delegation?.status === "running") {
        fail("invalid_transition", `Work item ${workItem.id} already has a running delegation.`);
      }
      if (workItem.assignedRole === "implementer" &&
          (workItem.allowedFiles === undefined || workItem.allowedFiles.length === 0)) {
        fail(
          "invalid_transition",
          `Work item ${workItem.id} requires an explicit allowed file scope before delegation starts.`,
        );
      }
      const owner = requiredString(input.owner, "delegation.owner", 200);
      const threadId = requiredString(input.threadId, "delegation.threadId", 200);
      const turnId = optionalString(input.turnId, "delegation.turnId", 200);
      const startTreeRef = optionalTreeRef(input.startTreeRef, "delegation.startTreeRef");
      const missionStartTreeRef = optionalTreeRef(
        input.missionStartTreeRef,
        "delegation.missionStartTreeRef",
      );
      if ((startTreeRef === undefined) !== (missionStartTreeRef === undefined)) {
        fail(
          "invalid_input",
          "delegation.startTreeRef and delegation.missionStartTreeRef must be provided together.",
        );
      }
      if (workItem.assignedRole === "implementer" && startTreeRef === undefined) {
        fail(
          "invalid_transition",
          `Work item ${workItem.id} requires a coordinator-captured workspace start state before delegation starts.`,
        );
      }
      if (
        missionStartTreeRef !== undefined &&
        mission.trueforgeWorkspaceBaselineTreeRef !== missionStartTreeRef
      ) {
        fail(
          "invalid_transition",
          `Work item ${workItem.id} delegation does not match the mission workspace baseline tree reference.`,
        );
      }
      if (workItem.claim === undefined) {
        workItem.claim = {
          owner,
          claimedAt: now,
        };
      } else if (workItem.claim.owner !== owner) {
        fail(
          "invalid_transition",
          `Work item ${workItem.id} is already claimed by ${workItem.claim.owner}.`,
        );
      }
      workItem.delegation = {
        owner,
        threadId,
        status: "running",
        startedAt: now,
        updatedAt: now,
        ...(turnId === undefined ? {} : { turnId }),
        ...(startTreeRef === undefined || missionStartTreeRef === undefined
          ? {}
          : { startTreeRef, missionStartTreeRef }),
      };
      workItem.updatedAt = now;
      return workItem;
    });
  }

  async completeWorkItemDelegation(
    missionId: string,
    workItemId: string,
    input: CompleteWorkItemDelegationInput,
  ): Promise<WorkItem> {
    return this.mutate((state, now) => {
      const normalizedMissionId = normalizedId(missionId, "missionId");
      const mission = findMission(state, normalizedMissionId);
      ensureOpen(mission);
      const workItem = findWorkItem(
        state,
        normalizedMissionId,
        normalizedId(workItemId, "workItemId"),
      );
      const delegation = workItem.delegation;
      const threadId = normalizedId(input.threadId, "delegation.threadId");
      if (delegation === undefined || delegation.threadId !== threadId) {
        fail("invalid_transition", `Work item ${workItem.id} has no matching delegation.`);
      }
      if (delegation.status !== "running") {
        fail("invalid_transition", `Work item ${workItem.id} delegation is already ${delegation.status}.`);
      }
      const turnId = optionalString(input.turnId, "delegation.turnId", 200);
      delegation.status = "completed";
      delegation.updatedAt = now;
      if (turnId !== undefined) {
        delegation.turnId = turnId;
      }
      workItem.updatedAt = now;
      return workItem;
    });
  }

  async failWorkItemDelegation(
    missionId: string,
    workItemId: string,
    input: FailWorkItemDelegationInput,
  ): Promise<WorkItem> {
    return this.mutate((state, now) => {
      const normalizedMissionId = normalizedId(missionId, "missionId");
      const mission = findMission(state, normalizedMissionId);
      ensureOpen(mission);
      const workItem = findWorkItem(
        state,
        normalizedMissionId,
        normalizedId(workItemId, "workItemId"),
      );
      const delegation = workItem.delegation;
      const threadId = normalizedId(input.threadId, "delegation.threadId");
      if (delegation === undefined || delegation.threadId !== threadId) {
        fail("invalid_transition", `Work item ${workItem.id} has no matching delegation.`);
      }
      if (delegation.status !== "running") {
        fail("invalid_transition", `Work item ${workItem.id} delegation is already ${delegation.status}.`);
      }
      const turnId = optionalString(input.turnId, "delegation.turnId", 200);
      delegation.status = input.interrupted === true ? "interrupted" : "failed";
      delegation.error = requiredString(input.error, "delegation.error", 2_000);
      delegation.updatedAt = now;
      if (turnId !== undefined) {
        delegation.turnId = turnId;
      }
      workItem.updatedAt = now;
      return workItem;
    });
  }

  async addWorkItem(missionId: string, input: CreateWorkItemInput): Promise<WorkItem> {
    return this.mutate((state, now) => {
      const normalizedMissionId = normalizedId(missionId, "missionId");
      const mission = findMission(state, normalizedMissionId);
      ensureOpen(mission);
      const id = input.id === undefined ? newId("work") : normalizedId(input.id, "workItem.id");
      ensureUniqueEntityId(state, id);
      const dependsOn = input.dependsOn === undefined
        ? []
        : stringArray(input.dependsOn, "dependsOn", 100).map((dependencyId) =>
            normalizedId(dependencyId, "dependsOn item"),
          );
      for (const dependencyId of dependsOn) {
        const dependency = state.workItems.find((item) => item.id === dependencyId);
        if (dependency === undefined) {
          fail("invalid_input", `Dependency ${dependencyId} does not exist.`);
        }
        if (dependency.missionId !== normalizedMissionId) {
          fail("invalid_input", `Dependency ${dependencyId} belongs to another mission.`);
        }
        if (dependencyId === id) {
          fail("invalid_input", "A work item cannot depend on itself.");
        }
      }
      const status = input.status ?? "backlog";
      if (status === "ready" && dependsOn.some((dependencyId) => {
        const dependency = state.workItems.find((item) => item.id === dependencyId);
        return dependency?.status !== "complete";
      })) {
        fail("dependency_blocked", `Work item ${id} cannot start until its dependencies are complete.`);
      }
      const assignedRole = input.assignedRole === undefined
        ? undefined
        : enumValue(input.assignedRole, executionRoles, "assignedRole");
      const requiredChecks = input.requiredChecks === undefined
        ? undefined
        : stringArray(
            input.requiredChecks,
            "requiredChecks",
            MAX_WORK_ITEM_REQUIRED_CHECKS,
          );
      if (requiredChecks !== undefined && requiredChecks.length === 0) {
        fail("invalid_input", "requiredChecks must contain at least one check.");
      }
      const allowedFiles = optionalFilePathArray(input.allowedFiles, "allowedFiles");
      const workItem: WorkItem = {
        id,
        missionId: normalizedMissionId,
        title: requiredString(input.title, "title", 500),
        purpose: requiredString(input.purpose, "purpose", 4_000),
        acceptanceCriteria: input.acceptanceCriteria === undefined && input.acceptanceConditions === undefined
          ? []
          : stringArray(
              input.acceptanceCriteria ?? input.acceptanceConditions,
              "acceptanceCriteria",
              MAX_WORK_ITEM_ACCEPTANCE_CRITERIA,
            ),
        status: enumValue(status, ["backlog", "ready"], "status"),
        dependsOn,
        createdAt: now,
        updatedAt: now,
        attempt: 0,
        attempts: [],
      };
      if (assignedRole !== undefined) {
        workItem.assignedRole = assignedRole;
      }
      if (requiredChecks !== undefined) {
        workItem.requiredChecks = requiredChecks;
      }
      if (allowedFiles !== undefined) {
        workItem.allowedFiles = allowedFiles;
      }
      state.workItems.push(workItem);
      return workItem;
    });
  }

  async transitionWorkItem(
    missionId: string,
    workItemId: string,
    status: WorkItemStatus,
    options: WorkItemTransitionOptions = {},
  ): Promise<WorkItem> {
    if (options.trigger === "human") {
      if (status !== "backlog" && status !== "ready") {
        fail(
          "invalid_transition",
          "Humans may move tickets between backlog and ready, or authorize changes_requested rework by moving it to ready.",
        );
      }
      if (options.actor === undefined) {
        fail("invalid_input", "A human ticket transition requires an actor.");
      }
      return this.moveWorkItemByHuman(missionId, workItemId, status, {
        actor: options.actor,
        ...(options.expectedRevision === undefined
          ? {}
          : { expectedRevision: options.expectedRevision }),
      });
    }
    if (options.trigger !== undefined && options.trigger !== "legacy") {
      return this.transitionSystemWorkItem(missionId, workItemId, status as TicketStatus, {
        trigger: options.trigger,
        ...(options.expectedRevision === undefined
          ? {}
          : { expectedRevision: options.expectedRevision }),
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      });
    }
    return this.mutate((state, now) => {
      ensureExpectedRevision(state, options.expectedRevision);
      const normalizedMissionId = normalizedId(missionId, "missionId");
      const mission = findMission(state, normalizedMissionId);
      ensureOpen(mission);
      const workItem = findWorkItem(
        state,
        normalizedMissionId,
        normalizedId(workItemId, "workItemId"),
      );
      const nextStatus = enumValue(status, persistedWorkItemStatuses, "status");
      if (nextStatus === workItem.status || !workItemTransitions[workItem.status].includes(nextStatus)) {
        fail(
          "invalid_transition",
          `Work item ${workItem.id} cannot transition from ${workItem.status} to ${nextStatus}.`,
        );
      }
      if (nextStatus === "ready" || nextStatus === "in_progress") {
        ensureDependenciesComplete(state, workItem);
      }
      if ((nextStatus === "ready_for_review" || nextStatus === "proving") &&
          isStructuredImplementationWorkItem(workItem)) {
        ensureSuccessfulImplementationHandoff(state, workItem);
      }
      if ((nextStatus === "complete" || nextStatus === "done") &&
          isStructuredImplementationWorkItem(workItem)) {
        ensureSuccessfulImplementationHandoff(state, workItem);
        ensureAcceptedIndependentReview(state, workItem);
      }
      if (nextStatus !== "blocked") {
        delete workItem.blockedReason;
      }
      workItem.status = nextStatus;
      workItem.updatedAt = now;
      return workItem;
    });
  }

  async recordReview(missionId: string, input: RecordReviewInput): Promise<Review> {
    return this.mutate((state, now) => {
      const normalizedMissionId = normalizedId(missionId, "missionId");
      const mission = findMission(state, normalizedMissionId);
      ensureOpen(mission);
      const workItemId = normalizedId(input.workItemId, "workItemId");
      const workItem = findWorkItem(state, normalizedMissionId, workItemId);
      if (workItem.status !== "ready_for_review" && workItem.status !== "proving") {
        fail(
          "invalid_transition",
          `Work item ${workItem.id} must be proving before an independent review is recorded.`,
        );
      }
      const context = buildReviewContext(state, normalizedMissionId, workItemId);
      const outcome = enumValue(input.outcome, reviewOutcomes, "outcome");
      const reviewer = input.reviewer === undefined
        ? "independent-verifier"
        : requiredString(input.reviewer, "reviewer", 200);
      if (reviewer === workItem.delegation?.owner) {
        fail("invalid_input", "The implementer cannot record its own independent review.");
      }
      const id = input.id === undefined ? newId("review") : normalizedId(input.id, "review.id");
      ensureUniqueEntityId(state, id);
      const findingEvidenceId = newId("evidence");
      ensureUniqueEntityId(state, findingEvidenceId);
      const summary = requiredString(input.summary, "summary", 4_000);
      const finding = requiredString(input.finding, "finding", 4_000);
      const findingEvidence: Evidence = {
        id: findingEvidenceId,
        missionId: normalizedMissionId,
        workItemId,
        kind: "reviewer_finding",
        result: outcome === "accepted" ? "passed" : "failed",
        source: "reviewer",
        summary: `Independent verifier ${outcome}: ${finding}`,
        createdAt: now,
        details: JSON.stringify({
          reviewer,
          outcome,
          handoffId: context.handoff.id,
          ...(workItem.attempt === 0 ? {} : { attempt: workItem.attempt }),
          filesChanged: context.filesChanged,
          diffSummary: context.diffSummary,
          checks: context.checks,
          evidenceIds: context.handoff.evidenceIds,
        }),
      };
      const review: Review = {
        id,
        missionId: normalizedMissionId,
        workItemId,
        outcome,
        reviewer,
        summary,
        finding,
        handoffId: context.handoff.id,
        filesChanged: [...context.filesChanged],
        diffSummary: context.diffSummary,
        checks: clone(context.checks),
        evidenceIds: [...(context.handoff.evidenceIds ?? [])],
        findingEvidenceId,
        createdAt: now,
      };
      if (workItem.attempt > 0) {
        review.attempt = workItem.attempt;
        findingEvidence.attempt = workItem.attempt;
      }
      state.evidence.push(findingEvidence);
      state.reviews.push(review);
      const legacyReview = workItem.status === "ready_for_review";
      const nextStatus: WorkItemStatus = outcome === "accepted"
        ? legacyReview ? "complete" : "awaiting_approval"
        : outcome === "changes_requested"
        ? legacyReview ? "ready" : "changes_requested"
        : "blocked";
      workItem.status = nextStatus;
      if (!legacyReview) {
        if (outcome === "changes_requested" || outcome === "blocked") {
          workItem.requestedChanges = [finding];
        } else {
          delete workItem.requestedChanges;
        }
        updateCurrentAttempt(workItem, nextStatus as WorkItemAttemptStatus);
      }
      if (legacyReview && outcome === "changes_requested") {
        // Older mission snapshots treated a requested change as a fresh ready
        // attempt. Product-lifecycle tickets use the explicit human-gated
        // changes_requested -> ready path above instead.
        delete workItem.claim;
      }
      workItem.updatedAt = now;
      return review;
    });
  }

  async reviewWorkItem(missionId: string, input: RecordReviewInput): Promise<Review> {
    return this.recordReview(missionId, input);
  }

  async transitionMission(missionId: string, status: MissionStatus): Promise<Mission> {
    return this.mutate((state, now) => {
      const mission = findMission(state, normalizedId(missionId, "missionId"));
      const nextStatus = enumValue(status, missionStatuses, "status");
      if (nextStatus === mission.status || !missionTransitions[mission.status].includes(nextStatus)) {
        fail(
          "invalid_transition",
          `Mission ${mission.id} cannot transition from ${mission.status} to ${nextStatus}.`,
        );
      }
      if (nextStatus === "awaiting_approval") {
        ensureQueueApprovalReady(state, mission.id);
      }
      if (nextStatus === "verifying") {
        ensureQueueVerificationReady(state, mission.id);
      }
      if (nextStatus === "delivered") {
        fail("invalid_transition", "Record a verified delivery before marking a mission delivered.");
      }
      mission.status = nextStatus;
      mission.updatedAt = now;
      return mission;
    });
  }

  async addEvidence(missionId: string, input: RecordEvidenceInput): Promise<Evidence> {
    return this.mutate((state, now) => {
      const normalizedMissionId = normalizedId(missionId, "missionId");
      const mission = findMission(state, normalizedMissionId);
      ensureOpen(mission);
      const id = input.id === undefined ? newId("evidence") : normalizedId(input.id, "evidence.id");
      ensureUniqueEntityId(state, id);
      const workItemId = input.workItemId === undefined
        ? undefined
        : normalizedId(input.workItemId, "workItemId");
      const workItem = workItemId === undefined
        ? undefined
        : findWorkItem(state, normalizedMissionId, workItemId);
      const details = optionalString(input.details, "details");
      const executionOrigin = input.executionOrigin === undefined
        ? undefined
        : validateExecutionOrigin(input.executionOrigin, "executionOrigin");
      const evidence: Evidence = {
        id,
        missionId: normalizedMissionId,
        kind: enumValue(input.kind, evidenceKinds, "kind"),
        result: enumValue(input.result, evidenceResults, "result"),
        source: enumValue(input.source, evidenceSources, "source"),
        summary: requiredString(input.summary, "summary"),
        createdAt: now,
      };
      if (workItemId !== undefined) {
        evidence.workItemId = workItemId;
      }
      if (workItem !== undefined && workItem.attempt > 0) {
        evidence.attempt = workItem.attempt;
      }
      if (details !== undefined) {
        evidence.details = details;
      }
      if (executionOrigin !== undefined) {
        evidence.executionOrigin = executionOrigin;
      }
      state.evidence.push(evidence);
      return evidence;
    });
  }

  async recordHandoff(missionId: string, input: RecordHandoffInput): Promise<Handoff> {
    return this.mutate((state, now) => {
      const normalizedMissionId = normalizedId(missionId, "missionId");
      const mission = findMission(state, normalizedMissionId);
      ensureOpen(mission);
      const workItemId = normalizedId(input.workItemId, "workItemId");
      const workItem = findWorkItem(state, normalizedMissionId, workItemId);
      const id = input.id === undefined ? newId("handoff") : normalizedId(input.id, "handoff.id");
      ensureUniqueEntityId(state, id);
      const result = enumValue(input.result, handoffResults, "result");
      const filesChanged = input.filesChanged === undefined
        ? []
        : stringArray(input.filesChanged, "filesChanged");
      const structured = validateStructuredHandoffFields(
        {
          diffSummary: input.diffSummary,
          checks: input.checks,
          evidenceIds: input.evidenceIds,
          executionOrigin: input.executionOrigin,
        },
        "handoff",
        result,
        filesChanged,
      );
      if (isStructuredImplementationWorkItem(workItem) && result === "done" && structured === null) {
        fail(
          "invalid_input",
          `Work item ${workItem.id} requires a structured implementation handoff.`,
        );
      }
      const handoff: Handoff = {
        id,
        missionId: normalizedMissionId,
        workItemId,
        result,
        summary: requiredString(input.summary, "summary"),
        filesChanged,
        testsRun: input.testsRun === undefined ? [] : stringArray(input.testsRun, "testsRun"),
        decisions: input.decisions === undefined ? [] : stringArray(input.decisions, "decisions"),
        openQuestions: input.openQuestions === undefined ? [] : stringArray(input.openQuestions, "openQuestions"),
        componentsTouched: input.componentsTouched === undefined
          ? []
          : stringArray(input.componentsTouched, "componentsTouched"),
        memoryImpact: input.memoryImpact === undefined
          ? "low"
          : enumValue(input.memoryImpact, memoryImpacts, "memoryImpact"),
        createdAt: now,
      };
      if (workItem.attempt > 0) {
        handoff.attempt = workItem.attempt;
      }
      if (structured !== null) {
        handoff.diffSummary = structured.diffSummary;
        handoff.checks = structured.checks;
        handoff.evidenceIds = structured.evidenceIds.map((evidenceId) =>
          normalizedId(evidenceId, "evidenceId"),
        );
        handoff.executionOrigin = structured.executionOrigin;
      }
      validateStructuredHandoffCorrelation(state, handoff, workItem);
      state.handoffs.push(handoff);
      return handoff;
    });
  }

  async requestApproval(missionId: string, input: RequestApprovalInput): Promise<Approval> {
    return this.mutate((state, now) => {
      const normalizedMissionId = normalizedId(missionId, "missionId");
      const mission = findMission(state, normalizedMissionId);
      ensureOpen(mission);
      const action = requiredString(input.action, "action", 500);
      const actionType = normalizeActionType(
        requiredString(input.actionType ?? action, "actionType", 200),
      );
      const rationale = requiredString(input.rationale ?? input.risk, "rationale");
      const risk = input.risk === undefined
        ? rationale
        : requiredString(input.risk, "risk");
      const evidenceIds = input.evidenceIds === undefined
        ? []
        : stringArray(input.evidenceIds, "evidenceIds", 100).map((evidenceId) =>
            normalizedId(evidenceId, "evidenceId"),
        );
      if (getActionPolicy(actionType).requiresApproval && evidenceIds.length === 0) {
        fail("invalid_input", "A consequential approval request needs supporting evidence.");
      }
      ensureMissionEvidence(state, normalizedMissionId, evidenceIds);
      const id = input.id === undefined ? newId("approval") : normalizedId(input.id, "approval.id");
      ensureUniqueEntityId(state, id);
      const expiresAt = input.expiresAt === undefined
        ? defaultApprovalExpiry(now)
        : timestamp(input.expiresAt, "expiresAt");
      const workItemId = input.workItemId === undefined
        ? undefined
        : normalizedId(input.workItemId, "workItemId");
      const attempt = input.attempt === undefined
        ? undefined
        : nonNegativeInteger(input.attempt, "attempt");
      if (attempt !== undefined && attempt === 0) {
        fail("invalid_input", "attempt must be greater than zero.");
      }
      const handoffId = input.handoffId === undefined
        ? undefined
        : normalizedId(input.handoffId, "handoffId");
      const reviewId = input.reviewId === undefined
        ? undefined
        : normalizedId(input.reviewId, "reviewId");
      const trueforgeSandboxId = input.trueforgeSandboxId === undefined
        ? undefined
        : requiredString(input.trueforgeSandboxId, "trueforgeSandboxId", 200);
      if (workItemId !== undefined) {
        const workItem = findWorkItem(state, normalizedMissionId, workItemId);
        if (attempt !== undefined && attempt !== workItem.attempt) {
          fail(
            "invalid_input",
            `Approval attempt ${attempt} does not match work item ${workItem.id} attempt ${workItem.attempt}.`,
          );
        }
      } else if (attempt !== undefined || handoffId !== undefined || reviewId !== undefined || trueforgeSandboxId !== undefined) {
        fail("invalid_input", "Approval attempt correlation requires a work item.");
      }
      const approval: Approval = {
        id,
        missionId: normalizedMissionId,
        action,
        actionType,
        target: requiredString(input.target, "target", 2_000),
        risk,
        rationale,
        expectedEffect: requiredString(input.expectedEffect, "expectedEffect"),
        evidenceIds,
        decision: "pending",
        createdAt: now,
        expiresAt,
      };
      if (workItemId !== undefined) {
        approval.workItemId = workItemId;
      }
      if (attempt !== undefined) {
        approval.attempt = attempt;
      }
      if (handoffId !== undefined) {
        approval.handoffId = handoffId;
      }
      if (reviewId !== undefined) {
        approval.reviewId = reviewId;
      }
      if (trueforgeSandboxId !== undefined) {
        approval.trueforgeSandboxId = trueforgeSandboxId;
      }
      if (input.executionContext !== undefined) {
        approval.executionContext = validateApprovalExecutionContext(
          input.executionContext,
          "executionContext",
        );
      }
      state.approvals.push(approval);
      return approval;
    });
  }

  async requestActionApproval(
    missionId: string,
    input: RequestApprovalInput,
  ): Promise<Approval> {
    const actionType = normalizeActionType(
      requiredString(input.actionType ?? input.action, "actionType", 200),
    );
    if (!getActionPolicy(actionType).requiresApproval) {
      fail("invalid_input", `Action ${actionType} is read-only and does not require approval.`);
    }
    return this.requestApproval(missionId, { ...input, actionType });
  }

  async authorizeAction(
    missionId: string,
    input: ActionExecutionInput,
  ): Promise<Approval | null> {
    const state = await this.getState();
    const normalizedMissionId = normalizedId(missionId, "missionId");
    const mission = findMission(state, normalizedMissionId);
    const action = normalizeActionType(requiredString(input.action, "action", 200));
    if (getActionPolicy(action).requiresApproval) {
      ensureOpen(mission);
    }
    const approval = ensureApprovedAction(
      state,
      normalizedMissionId,
      { ...input, action },
      this.currentTimestamp(),
    );
    return approval === null ? null : clone(approval);
  }

  async executeProtectedAction<T>(
    missionId: string,
    input: ActionExecutionInput,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    if (typeof operation !== "function") {
      fail("invalid_input", "A protected action needs an execution function.");
    }
    await this.authorizeAction(missionId, input);
    return operation();
  }

  /**
   * Persist the intent for a consequential delivery before invoking its remote
   * mutation. The created flag lets concurrent controllers distinguish the
   * owner of the first attempt from a reconnect that must reconcile instead.
   */
  async recordDeliveryAttempt(
    missionId: string,
    input: RecordDeliveryAttemptInput,
  ): Promise<DeliveryAttemptRecord> {
    return this.mutate((state, now) => {
      const normalizedMissionId = normalizedId(missionId, "missionId");
      const mission = findMission(state, normalizedMissionId);
      ensureOpen(mission);
      const normalizedApprovalId = normalizedId(input.approvalId, "approvalId");
      const normalizedWorkItemId = normalizedId(input.workItemId, "workItemId");
      const workItem = findWorkItem(state, normalizedMissionId, normalizedWorkItemId);
      const attempt = nonNegativeInteger(input.attempt, "attempt");
      if (attempt === 0) {
        fail("invalid_input", "attempt must be greater than zero.");
      }
      if (workItem.attempt !== attempt) {
        fail(
          "approval_blocked",
          `Delivery attempt ${attempt} does not match work item ${workItem.id} attempt ${workItem.attempt}.`,
        );
      }
      const approval = ensureApprovedDelivery(
        state,
        normalizedMissionId,
        normalizedApprovalId,
        now,
      );
      if (
        approval.workItemId !== normalizedWorkItemId ||
        approval.attempt !== attempt
      ) {
        fail(
          "approval_blocked",
          "The durable delivery attempt is not correlated to the approved work-item attempt.",
        );
      }
      const actionType = normalizeActionType(
        requiredString(input.actionType ?? approval.actionType, "actionType", 200),
      );
      const expectedEffect = requiredString(input.expectedEffect, "expectedEffect");
      const target = validateDeliveryAttemptTarget(input.target, "target");
      ensureDeliveryAttemptMatchesApproval(approval, target, actionType, expectedEffect);

      const existing = state.deliveryAttempts.find((candidate) =>
        candidate.missionId === normalizedMissionId &&
        candidate.approvalId === normalizedApprovalId &&
        candidate.workItemId === normalizedWorkItemId &&
        candidate.attempt === attempt,
      );
      if (existing !== undefined) {
        if (
          existing.actionType !== actionType ||
          existing.expectedEffect !== expectedEffect ||
          JSON.stringify(existing.target) !== JSON.stringify(target)
        ) {
          fail(
            "approval_blocked",
            `Delivery attempt ${existing.id} has a different approved target or expected effect.`,
          );
        }
        return { attempt: existing, created: false };
      }

      const id = input.id === undefined
        ? newId("delivery-attempt")
        : normalizedId(input.id, "deliveryAttempt.id");
      ensureUniqueEntityId(state, id);
      const deliveryAttempt: DeliveryAttempt = {
        id,
        missionId: normalizedMissionId,
        approvalId: normalizedApprovalId,
        workItemId: normalizedWorkItemId,
        attempt,
        actionType,
        expectedEffect,
        target,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      state.deliveryAttempts.push(deliveryAttempt);
      return { attempt: deliveryAttempt, created: true };
    });
  }

  /** Persist the first observed remote result before recording the final delivery. */
  async recordDeliveryAttemptResult(
    missionId: string,
    deliveryAttemptId: string,
    input: RecordDeliveryAttemptResultInput,
  ): Promise<DeliveryAttempt> {
    return this.mutate((state, now) => {
      const normalizedMissionId = normalizedId(missionId, "missionId");
      const deliveryAttempt = state.deliveryAttempts.find((candidate) =>
        candidate.id === normalizedId(deliveryAttemptId, "deliveryAttemptId") &&
        candidate.missionId === normalizedMissionId,
      );
      if (deliveryAttempt === undefined) {
        fail(
          "not_found",
          `Delivery attempt ${deliveryAttemptId} was not found in mission ${normalizedMissionId}.`,
        );
      }
      const approval = state.approvals.find((candidate) =>
        candidate.id === deliveryAttempt.approvalId &&
        candidate.missionId === normalizedMissionId,
      );
      if (approval === undefined) {
        fail(
          "approval_blocked",
          `Delivery attempt ${deliveryAttempt.id} has no matching approved action.`,
        );
      }
      const pullRequest = validatePullRequestReference(input.pullRequest, "pullRequest");
      const executionOrigin = validateExecutionOrigin(input.executionOrigin, "executionOrigin");
      ensureDeliveryAttemptResultMatchesTarget(deliveryAttempt, pullRequest, executionOrigin);
      if (
        executionOrigin.kind !== "mcp" ||
        executionOrigin.sessionId !== approval.executionContext?.sessionId ||
        executionOrigin.threadId !== approval.executionContext?.threadId ||
        executionOrigin.toolCallId !== approval.executionContext?.toolCallId
      ) {
        fail(
          "approval_blocked",
          "The delivery result execution origin does not match the approved tool call.",
        );
      }
      if (
        deliveryAttempt.pullRequest !== undefined ||
        deliveryAttempt.executionOrigin !== undefined
      ) {
        if (
          JSON.stringify(deliveryAttempt.pullRequest) !== JSON.stringify(pullRequest)
        ) {
          fail(
            "approval_blocked",
            `Delivery attempt ${deliveryAttempt.id} already has a different remote result.`,
          );
        }
        return deliveryAttempt;
      }
      deliveryAttempt.pullRequest = pullRequest;
      deliveryAttempt.executionOrigin = executionOrigin;
      deliveryAttempt.updatedAt = now;
      return deliveryAttempt;
    });
  }

  /** Mark a result-bearing attempt complete only after its delivered record is durable. */
  async completeDeliveryAttempt(
    missionId: string,
    deliveryAttemptId: string,
  ): Promise<DeliveryAttempt> {
    return this.mutate((state, now) => {
      const normalizedMissionId = normalizedId(missionId, "missionId");
      const deliveryAttempt = state.deliveryAttempts.find((candidate) =>
        candidate.id === normalizedId(deliveryAttemptId, "deliveryAttemptId") &&
        candidate.missionId === normalizedMissionId,
      );
      if (deliveryAttempt === undefined) {
        fail(
          "not_found",
          `Delivery attempt ${deliveryAttemptId} was not found in mission ${normalizedMissionId}.`,
        );
      }
      if (deliveryAttempt.status === "completed") {
        return deliveryAttempt;
      }
      if (deliveryAttempt.pullRequest === undefined || deliveryAttempt.executionOrigin === undefined) {
        fail(
          "invalid_transition",
          `Delivery attempt ${deliveryAttempt.id} cannot complete before its remote result is persisted.`,
        );
      }
      const delivered = state.deliveries.some((delivery) =>
        delivery.missionId === normalizedMissionId &&
        delivery.status === "delivered" &&
        delivery.approvalId === deliveryAttempt.approvalId &&
        delivery.workItemId === deliveryAttempt.workItemId &&
        delivery.attempt === deliveryAttempt.attempt &&
        delivery.pullRequest?.url === deliveryAttempt.pullRequest?.url,
      );
      if (!delivered) {
        fail(
          "invalid_transition",
          `Delivery attempt ${deliveryAttempt.id} cannot complete before its delivered record is durable.`,
        );
      }
      deliveryAttempt.status = "completed";
      deliveryAttempt.updatedAt = now;
      return deliveryAttempt;
    });
  }

  async executeAction<T>(
    missionId: string,
    input: ActionExecutionInput,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    return this.executeProtectedAction(missionId, input, operation);
  }

  async decideApproval(
    missionId: string,
    approvalId: string,
    input: DecideApprovalInput,
  ): Promise<Approval> {
    return this.mutate((state, now) => {
      ensureExpectedRevision(state, input.expectedRevision);
      const normalizedMissionId = normalizedId(missionId, "missionId");
      const mission = findMission(state, normalizedMissionId);
      ensureOpen(mission);
      const approval = state.approvals.find(
        (item) => item.id === normalizedId(approvalId, "approvalId") && item.missionId === normalizedMissionId,
      );
      if (approval === undefined) {
        fail("not_found", `Approval ${approvalId} was not found in mission ${normalizedMissionId}.`);
      }
      if (approval.decision !== "pending") {
        fail("invalid_transition", `Approval ${approval.id} has already been decided.`);
      }
      const decision = enumValue(
        input.decision,
        ["approved", "rejected", "cancelled"],
        "decision",
      );
      if (decision === "approved" && approvalIsExpired(approval, now)) {
        fail("approval_blocked", `Approval ${approval.id} has expired and cannot be approved.`);
      }
      approval.decision = decision;
      approval.decidedBy = requiredString(input.decidedBy, "decidedBy", 200);
      approval.decidedAt = now;
      return approval;
    });
  }

  async recordDelivery(missionId: string, input: RecordDeliveryInput): Promise<Delivery> {
    return this.mutate((state, now) => {
      const normalizedMissionId = normalizedId(missionId, "missionId");
      const mission = findMission(state, normalizedMissionId);
      ensureOpen(mission);
      if (state.deliveries.some((delivery) => delivery.missionId === normalizedMissionId)) {
        fail("invalid_transition", `Mission ${normalizedMissionId} already has a delivery record.`);
      }
      const status = enumValue(input.status, deliveryStatuses, "status");
      const verificationSummary = requiredString(
        input.verificationSummary,
        "verificationSummary",
      );
      const reference = optionalString(input.reference, "reference", 2_000);
      const workItemId = input.workItemId === undefined
        ? undefined
        : normalizedId(input.workItemId, "workItemId");
      const attempt = input.attempt === undefined
        ? undefined
        : nonNegativeInteger(input.attempt, "attempt");
      if (attempt !== undefined && attempt === 0) {
        fail("invalid_input", "attempt must be greater than zero.");
      }
      const pullRequest = input.pullRequest === undefined
        ? undefined
        : validatePullRequestReference(input.pullRequest, "pullRequest");
      const executionOrigin = input.executionOrigin === undefined
        ? undefined
        : validateExecutionOrigin(input.executionOrigin, "executionOrigin");
      let approvedDelivery: Approval | undefined;
      let deliveryWorkItem: WorkItem | undefined;
      if (status === "delivered") {
        if (mission.status !== "verifying") {
          fail("invalid_transition", "A delivered record requires a mission in verifying state.");
        }
        if (workItemId === undefined) {
          if (attempt !== undefined) {
            fail("invalid_input", "attempt requires a work item for a delivered record.");
          }
          ensureAllWorkComplete(state, normalizedMissionId);
        }
        if (workItemId !== undefined) {
          deliveryWorkItem = ensureQueueDeliveryComplete(
            state,
            normalizedMissionId,
            workItemId,
            attempt,
          );
        }
        approvedDelivery = ensureApprovedDelivery(
          state,
          normalizedMissionId,
          input.approvalId,
          now,
        );
        if (
          workItemId !== undefined &&
          approvedDelivery.workItemId !== workItemId
        ) {
          fail("approval_blocked", "The delivered result is not correlated to the approved work item.");
        }
        if (
          attempt !== undefined &&
          approvedDelivery.attempt !== attempt
        ) {
          fail("approval_blocked", "The delivered result is not correlated to the approved work-item attempt.");
        }
        if (reference === undefined) {
          fail("invalid_input", "reference is required for a delivered record.");
        }
        if (pullRequest === undefined || executionOrigin === undefined) {
          fail(
            "invalid_input",
            "A delivered record requires the canonical pull request result and execution origin.",
          );
        }
        if (reference !== pullRequest.url) {
          fail("invalid_input", "Delivered pull request URL must match the delivery reference.");
        }
        const context = approvedDelivery.executionContext;
        const artifactApproval = context?.artifactHash !== undefined;
        if (
          context === undefined ||
          context.toolName !== (artifactApproval ? "push_files" : PRIMARY_CONSEQUENTIAL_ACTION) ||
          context.repositoryOwner !== pullRequest.repositoryOwner ||
          context.repositoryName !== pullRequest.repositoryName ||
          context.base !== pullRequest.base ||
          context.head !== pullRequest.head ||
          (context.headSha !== undefined && context.headSha !== pullRequest.headSha) ||
          executionOrigin.kind !== "mcp" ||
          context.sessionId !== executionOrigin.sessionId ||
          context.threadId !== executionOrigin.threadId ||
          context.toolCallId !== executionOrigin.toolCallId
        ) {
          fail(
            "approval_blocked",
            "The pull request result is not correlated to the approved TrueForge tool call.",
          );
        }
      } else if (!["executing", "awaiting_approval", "verifying", "blocked"].includes(mission.status)) {
        fail("invalid_transition", `A failed delivery cannot be recorded from ${mission.status} state.`);
      }
      const id = input.id === undefined ? newId("delivery") : normalizedId(input.id, "delivery.id");
      ensureUniqueEntityId(state, id);
      const delivery: Delivery = {
        id,
        missionId: normalizedMissionId,
        status,
        verificationSummary,
        createdAt: now,
      };
      if (reference !== undefined) {
        delivery.reference = reference;
      }
      if (approvedDelivery !== undefined) {
        delivery.approvalId = approvedDelivery.id;
      }
      if (workItemId !== undefined) {
        delivery.workItemId = workItemId;
      }
      if (attempt !== undefined) {
        delivery.attempt = attempt;
      }
      if (pullRequest !== undefined) {
        delivery.pullRequest = pullRequest;
      }
      if (executionOrigin !== undefined) {
        delivery.executionOrigin = executionOrigin;
      }
      state.deliveries.push(delivery);
      if (
        status === "delivered" &&
        approvedDelivery !== undefined &&
        workItemId !== undefined &&
        attempt !== undefined &&
        pullRequest !== undefined
      ) {
        const deliveryAttempt = state.deliveryAttempts.find((candidate) =>
          candidate.missionId === normalizedMissionId &&
          candidate.approvalId === approvedDelivery?.id &&
          candidate.workItemId === workItemId &&
          candidate.attempt === attempt,
        );
        if (deliveryAttempt !== undefined) {
          if (deliveryAttempt.pullRequest?.url !== pullRequest.url) {
            fail(
              "approval_blocked",
              `Delivery attempt ${deliveryAttempt.id} does not match the delivered pull request.`,
            );
          }
          deliveryAttempt.status = "completed";
          deliveryAttempt.updatedAt = now;
        }
      }
      if (status === "delivered" && deliveryWorkItem !== undefined && deliveryWorkItem.status === "delivering") {
        updateCurrentAttempt(deliveryWorkItem, "done");
        delete deliveryWorkItem.requestedChanges;
        deliveryWorkItem.status = "done";
        deliveryWorkItem.updatedAt = now;
      }
      mission.status = status === "delivered" ? "delivered" : "failed";
      mission.updatedAt = now;
      return delivery;
    });
  }

  private async ensureState(): Promise<MissionState> {
    if (this.state !== null) {
      return this.state;
    }
    const loaded = await this.repository.load();
    this.state = loaded === null ? createEmptyMissionState() : validateMissionState(loaded);
    return this.state;
  }

  private currentTimestamp(): string {
    const value = this.clock();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      fail("invalid_input", "The mission clock must return a valid Date.");
    }
    return value.toISOString();
  }

  private mutate<T>(mutator: (state: MissionState, now: string) => T): Promise<T> {
    const operation = this.pending.then(async () => {
      const current = await this.ensureState();
      const expectedRevision = current.revision;
      const next = clone(current);
      const result = mutator(next, this.currentTimestamp());
      next.revision += 1;
      const validated = validateMissionState(next);
      try {
        if (this.repository.saveIfRevision !== undefined) {
          await this.repository.saveIfRevision(validated, expectedRevision);
        } else {
          await this.repository.save(validated);
        }
      } catch (error) {
        if (error instanceof MissionDomainError && error.code === "conflict") {
          this.state = null;
        }
        throw error;
      }
      this.state = validated;
      return clone(result);
    });
    this.pending = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
