import { randomUUID } from "node:crypto";

import { parseContentDiffEvidence } from "./diff.js";

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

export const workItemStatuses = [
  "backlog",
  "ready",
  "in_progress",
  "ready_for_review",
  "complete",
  "blocked",
] as const;

export type WorkItemStatus = (typeof workItemStatuses)[number];

export const executionRoles = ["planner", "implementer", "reviewer"] as const;
export type ExecutionRole = (typeof executionRoles)[number];

export const MAX_WORK_GRAPH_ITEMS = 8;
export const MAX_WORK_ITEM_ACCEPTANCE_CRITERIA = 12;
export const MAX_WORK_ITEM_REQUIRED_CHECKS = 12;
export const implementationCheckResults = ["passed", "failed", "not_run"] as const;
export type ImplementationCheckResult = (typeof implementationCheckResults)[number];
export const executionOriginKinds = ["trueforge", "mcp", "sandbox", "tool"] as const;
export type ExecutionOriginKind = (typeof executionOriginKinds)[number];
export const delegationStatuses = ["running", "completed", "failed", "interrupted"] as const;
export type DelegationStatus = (typeof delegationStatuses)[number];

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

export const approvalDecisions = ["pending", "approved", "rejected"] as const;
export type ApprovalDecision = (typeof approvalDecisions)[number];

export const deliveryStatuses = ["delivered", "failed"] as const;
export type DeliveryStatus = (typeof deliveryStatuses)[number];

export const missionTransitions: Readonly<{
  [status in MissionStatus]: readonly MissionStatus[];
}> = {
  draft: ["planning", "blocked"],
  planning: ["executing", "blocked", "failed"],
  executing: ["awaiting_approval", "verifying", "blocked", "failed"],
  awaiting_approval: ["verifying", "blocked", "failed"],
  verifying: ["delivered", "blocked", "failed"],
  delivered: [],
  failed: [],
  blocked: ["planning", "executing", "failed"],
};

export const workItemTransitions: Readonly<{
  [status in WorkItemStatus]: readonly WorkItemStatus[];
}> = {
  backlog: ["ready", "blocked"],
  ready: ["in_progress", "blocked"],
  in_progress: ["ready_for_review", "blocked"],
  ready_for_review: ["complete", "blocked"],
  complete: [],
  blocked: ["ready", "blocked"],
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
}

export interface WorkGraphItem {
  id: string;
  title: string;
  purpose: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  assignedRole: ExecutionRole;
  requiredChecks?: string[];
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
}

export interface Approval {
  id: string;
  missionId: string;
  action: string;
  target: string;
  risk: string;
  expectedEffect: string;
  evidenceIds: string[];
  decision: ApprovalDecision;
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
}

export interface Delivery {
  id: string;
  missionId: string;
  status: DeliveryStatus;
  verificationSummary: string;
  createdAt: string;
  reference?: string;
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
}

export interface MissionRepository {
  load(): Promise<MissionState | null>;
  save(state: MissionState): Promise<void>;
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
  status?: "backlog" | "ready";
}

export interface StartWorkItemDelegationInput {
  owner: string;
  threadId: string;
  turnId?: string;
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
  target: string;
  risk: string;
  expectedEffect: string;
  evidenceIds?: string[];
  id?: string;
}

export interface RecordDeliveryInput {
  status: DeliveryStatus;
  verificationSummary: string;
  reference?: string;
  id?: string;
}

export interface DecideApprovalInput {
  decision: "approved" | "rejected";
  decidedBy: string;
}

export type MissionDomainErrorCode =
  | "invalid_input"
  | "not_found"
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
  return result;
}

function validateWorkItemDelegation(
  value: unknown,
  label: string,
): WorkItemDelegation {
  const delegation = objectValue(value, label);
  const turnId = optionalString(delegation.turnId, `${label}.turnId`, 200);
  const error = optionalString(delegation.error, `${label}.error`, 2_000);
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
    status: enumValue(workItem.status, workItemStatuses, `${label}.status`),
    dependsOn: stringArray(workItem.dependsOn, `${label}.dependsOn`),
    createdAt: timestamp(workItem.createdAt, `${label}.createdAt`),
    updatedAt: timestamp(workItem.updatedAt, `${label}.updatedAt`),
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
  return {
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
}

function validateApproval(value: unknown, label: string): Approval {
  const approval = objectValue(value, label);
  const decidedBy = optionalString(approval.decidedBy, `${label}.decidedBy`, 200);
  const decidedAt =
    approval.decidedAt === undefined
      ? undefined
      : timestamp(approval.decidedAt, `${label}.decidedAt`);
  const decision = enumValue(approval.decision, approvalDecisions, `${label}.decision`);
  if (decision === "pending" && (decidedBy !== undefined || decidedAt !== undefined)) {
    return fail("invalid_input", `${label} cannot have a decision actor or timestamp while pending.`);
  }
  if (decision !== "pending" && (decidedBy === undefined || decidedAt === undefined)) {
    return fail("invalid_input", `${label} needs a decision actor and timestamp.`);
  }
  const result: Approval = {
    id: identifier(approval.id, `${label}.id`),
    missionId: identifier(approval.missionId, `${label}.missionId`),
    action: requiredString(approval.action, `${label}.action`, 500),
    target: requiredString(approval.target, `${label}.target`, 2_000),
    risk: requiredString(approval.risk, `${label}.risk`),
    expectedEffect: requiredString(approval.expectedEffect, `${label}.expectedEffect`),
    evidenceIds: stringArray(approval.evidenceIds, `${label}.evidenceIds`),
    decision,
    createdAt: timestamp(approval.createdAt, `${label}.createdAt`),
  };
  if (decidedBy !== undefined) {
    result.decidedBy = decidedBy;
  }
  if (decidedAt !== undefined) {
    result.decidedAt = decidedAt;
  }
  return result;
}

function validateDelivery(value: unknown, label: string): Delivery {
  const delivery = objectValue(value, label);
  const reference = optionalString(delivery.reference, `${label}.reference`, 2_000);
  const status = enumValue(delivery.status, deliveryStatuses, `${label}.status`);
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
  };

  ensureUniqueIds(result);
  const missions = new Map(result.missions.map((mission) => [mission.id, mission]));
  const workItems = new Map(result.workItems.map((workItem) => [workItem.id, workItem]));
  const evidence = new Map(result.evidence.map((item) => [item.id, item]));

  for (const workItem of result.workItems) {
    if (!missions.has(workItem.missionId)) {
      fail("invalid_input", `Work item ${workItem.id} references an unknown mission.`);
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
      if (workItem.status !== "backlog" && workItem.status !== "blocked" && dependency.status !== "complete") {
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
    }
  }

  for (const handoff of result.handoffs) {
    const workItem = workItems.get(handoff.workItemId);
    if (!missions.has(handoff.missionId) || workItem === undefined || workItem.missionId !== handoff.missionId) {
      fail("invalid_input", `Handoff ${handoff.id} references an invalid work item or mission.`);
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
    if (isStructuredImplementationWorkItem(workItem) && workItem.status === "complete") {
      ensureAcceptedIndependentReview(result, workItem);
    }
  }

  for (const approval of result.approvals) {
    if (!missions.has(approval.missionId)) {
      fail("invalid_input", `Approval ${approval.id} references an unknown mission.`);
    }
    for (const evidenceId of approval.evidenceIds) {
      const item = evidence.get(evidenceId);
      if (item === undefined || item.missionId !== approval.missionId) {
        fail("invalid_input", `Approval ${approval.id} references invalid evidence.`);
      }
    }
  }

  for (const delivery of result.deliveries) {
    if (!missions.has(delivery.missionId)) {
      fail("invalid_input", `Delivery ${delivery.id} references an unknown mission.`);
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
  ].some((entity) => entity.id === id);
  if (exists) {
    fail("invalid_input", `Entity ID ${id} is already in use.`);
  }
}

function ensureDependenciesComplete(state: MissionState, workItem: WorkItem): void {
  const incomplete = workItem.dependsOn.filter((dependencyId) => {
    const dependency = state.workItems.find((item) => item.id === dependencyId);
    return dependency === undefined || dependency.status !== "complete";
  });
  if (incomplete.length > 0) {
    fail(
      "dependency_blocked",
      `Work item ${workItem.id} is blocked by incomplete dependencies: ${incomplete.join(", ")}.`,
    );
  }
}

function ensureAllWorkComplete(state: MissionState, missionId: string): void {
  const incomplete = state.workItems
    .filter((item) => item.missionId === missionId && item.status !== "complete")
    .map((item) => item.id);
  if (incomplete.length > 0) {
    fail(
      "dependency_blocked",
      `Mission ${missionId} still has incomplete work items: ${incomplete.join(", ")}.`,
    );
  }
}

function ensureMissionEvidence(state: MissionState, missionId: string, evidenceIds: string[]): void {
  for (const evidenceId of evidenceIds) {
    const evidence = state.evidence.find((item) => item.id === evidenceId);
    if (evidence === undefined || evidence.missionId !== missionId) {
      fail("invalid_input", `Evidence ${evidenceId} does not belong to mission ${missionId}.`);
    }
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
  return workItem.assignedRole === "implementer" && workItem.delegation !== undefined;
}

function handoffMatchesCurrentDelegation(workItem: WorkItem, handoff: Handoff): boolean {
  if (!isStructuredImplementationWorkItem(workItem)) {
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
    if (
      structured.executionOrigin.turnId !== undefined &&
      evidence.executionOrigin.turnId !== structured.executionOrigin.turnId
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
    isStructuredImplementationWorkItem(workItem) &&
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
  if (changedStateEvidence.some((evidence) => !matchesHandoffOrigin(evidence))) {
    return fail(
      "invalid_input",
      `Handoff ${handoff.id} uses changed-state evidence from a different execution thread.`,
    );
  }

  if (handoff.result !== "done") {
    return;
  }
  if (isStructuredImplementationWorkItem(workItem)) {
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
  if (latest === undefined || structured === null || latest.result !== "done") {
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
    latestReview.handoffId !== latestHandoff.id
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
      state.workItems.some((item) => item.id === dependencyId && item.status === "complete"),
    );
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
          state.workItems.some((item) => item.id === dependencyId && item.status === "complete"),
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
        };
        const requiredChecks = planned.requiredChecks ?? prior?.requiredChecks;
        if (requiredChecks !== undefined) {
          workItem.requiredChecks = [...requiredChecks];
        }
        if (prior?.delegation !== undefined) {
          workItem.delegation = clone(prior.delegation);
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
      const owner = requiredString(input.owner, "delegation.owner", 200);
      const threadId = requiredString(input.threadId, "delegation.threadId", 200);
      const turnId = optionalString(input.turnId, "delegation.turnId", 200);
      workItem.delegation = {
        owner,
        threadId,
        status: "running",
        startedAt: now,
        updatedAt: now,
        ...(turnId === undefined ? {} : { turnId }),
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
      };
      if (assignedRole !== undefined) {
        workItem.assignedRole = assignedRole;
      }
      if (requiredChecks !== undefined) {
        workItem.requiredChecks = requiredChecks;
      }
      state.workItems.push(workItem);
      return workItem;
    });
  }

  async transitionWorkItem(
    missionId: string,
    workItemId: string,
    status: WorkItemStatus,
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
      const nextStatus = enumValue(status, workItemStatuses, "status");
      if (nextStatus === workItem.status || !workItemTransitions[workItem.status].includes(nextStatus)) {
        fail(
          "invalid_transition",
          `Work item ${workItem.id} cannot transition from ${workItem.status} to ${nextStatus}.`,
        );
      }
      if (nextStatus === "ready" || nextStatus === "in_progress") {
        ensureDependenciesComplete(state, workItem);
      }
      if (nextStatus === "ready_for_review" && isStructuredImplementationWorkItem(workItem)) {
        ensureSuccessfulImplementationHandoff(state, workItem);
      }
      if (nextStatus === "complete" && isStructuredImplementationWorkItem(workItem)) {
        ensureSuccessfulImplementationHandoff(state, workItem);
        ensureAcceptedIndependentReview(state, workItem);
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
      if (workItem.status !== "ready_for_review") {
        fail(
          "invalid_transition",
          `Work item ${workItem.id} must be ready for review before an independent review is recorded.`,
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
      state.evidence.push(findingEvidence);
      state.reviews.push(review);
      workItem.status = outcome === "accepted"
        ? "complete"
        : outcome === "changes_requested"
        ? "ready"
        : "blocked";
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
      if (nextStatus === "awaiting_approval" || nextStatus === "verifying") {
        ensureAllWorkComplete(state, mission.id);
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
      if (workItemId !== undefined) {
        findWorkItem(state, normalizedMissionId, workItemId);
      }
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
      const evidenceIds = input.evidenceIds === undefined
        ? []
        : stringArray(input.evidenceIds, "evidenceIds", 100).map((evidenceId) =>
            normalizedId(evidenceId, "evidenceId"),
          );
      ensureMissionEvidence(state, normalizedMissionId, evidenceIds);
      const id = input.id === undefined ? newId("approval") : normalizedId(input.id, "approval.id");
      ensureUniqueEntityId(state, id);
      const approval: Approval = {
        id,
        missionId: normalizedMissionId,
        action: requiredString(input.action, "action", 500),
        target: requiredString(input.target, "target", 2_000),
        risk: requiredString(input.risk, "risk"),
        expectedEffect: requiredString(input.expectedEffect, "expectedEffect"),
        evidenceIds,
        decision: "pending",
        createdAt: now,
      };
      state.approvals.push(approval);
      return approval;
    });
  }

  async decideApproval(
    missionId: string,
    approvalId: string,
    input: DecideApprovalInput,
  ): Promise<Approval> {
    return this.mutate((state, now) => {
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
      approval.decision = enumValue(input.decision, ["approved", "rejected"], "decision");
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
      if (status === "delivered") {
        if (mission.status !== "verifying") {
          fail("invalid_transition", "A delivered record requires a mission in verifying state.");
        }
        ensureAllWorkComplete(state, normalizedMissionId);
        const unapproved = state.approvals.filter(
          (approval) => approval.missionId === normalizedMissionId && approval.decision !== "approved",
        );
        if (unapproved.length > 0) {
          fail(
            "approval_blocked",
            `Delivery is waiting on approvals: ${unapproved.map((approval) => approval.id).join(", ")}.`,
          );
        }
        if (reference === undefined) {
          fail("invalid_input", "reference is required for a delivered record.");
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
      state.deliveries.push(delivery);
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
      const next = clone(current);
      const result = mutator(next, this.currentTimestamp());
      next.revision += 1;
      const validated = validateMissionState(next);
      await this.repository.save(validated);
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
