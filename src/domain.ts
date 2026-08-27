import { randomUUID } from "node:crypto";

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
  status: WorkItemStatus;
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
  assignedRole?: ExecutionRole;
}

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
  id?: string;
  dependsOn?: string[];
  assignedRole?: ExecutionRole;
  status?: "backlog" | "ready";
}

export interface RecordEvidenceInput {
  kind: EvidenceKind;
  result: EvidenceResult;
  source: EvidenceSource;
  summary: string;
  id?: string;
  workItemId?: string;
  details?: string;
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

function validateWorkItem(value: unknown, label: string): WorkItem {
  const workItem = objectValue(value, label);
  const assignedRole = optionalString(workItem.assignedRole, `${label}.assignedRole`, 30);
  const result: WorkItem = {
    id: identifier(workItem.id, `${label}.id`),
    missionId: identifier(workItem.missionId, `${label}.missionId`),
    title: requiredString(workItem.title, `${label}.title`, 500),
    purpose: requiredString(workItem.purpose, `${label}.purpose`),
    status: enumValue(workItem.status, workItemStatuses, `${label}.status`),
    dependsOn: stringArray(workItem.dependsOn, `${label}.dependsOn`),
    createdAt: timestamp(workItem.createdAt, `${label}.createdAt`),
    updatedAt: timestamp(workItem.updatedAt, `${label}.updatedAt`),
  };
  if (assignedRole !== undefined) {
    result.assignedRole = enumValue(assignedRole, executionRoles, `${label}.assignedRole`);
  }
  return result;
}

function validateEvidence(value: unknown, label: string): Evidence {
  const evidence = objectValue(value, label);
  const workItemId = optionalString(evidence.workItemId, `${label}.workItemId`, 200);
  const details = optionalString(evidence.details, `${label}.details`);
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
  return result;
}

function validateHandoff(value: unknown, label: string): Handoff {
  const handoff = objectValue(value, label);
  return {
    id: identifier(handoff.id, `${label}.id`),
    missionId: identifier(handoff.missionId, `${label}.missionId`),
    workItemId: identifier(handoff.workItemId, `${label}.workItemId`),
    result: enumValue(handoff.result, handoffResults, `${label}.result`),
    summary: requiredString(handoff.summary, `${label}.summary`),
    filesChanged: stringArray(handoff.filesChanged, `${label}.filesChanged`),
    testsRun: stringArray(handoff.testsRun, `${label}.testsRun`),
    decisions: stringArray(handoff.decisions, `${label}.decisions`),
    openQuestions: stringArray(handoff.openQuestions, `${label}.openQuestions`),
    componentsTouched: stringArray(handoff.componentsTouched, `${label}.componentsTouched`),
    memoryImpact: enumValue(handoff.memoryImpact, memoryImpacts, `${label}.memoryImpact`),
    createdAt: timestamp(handoff.createdAt, `${label}.createdAt`),
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

  async canStartWorkItem(missionId: string, workItemId: string): Promise<boolean> {
    const state = await this.getState();
    const workItem = findWorkItem(
      state,
      normalizedId(missionId, "missionId"),
      normalizedId(workItemId, "workItemId"),
    );
    return workItem.dependsOn.every((dependencyId) =>
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
      const workItem: WorkItem = {
        id,
        missionId: normalizedMissionId,
        title: requiredString(input.title, "title", 500),
        purpose: requiredString(input.purpose, "purpose"),
        status: enumValue(status, ["backlog", "ready"], "status"),
        dependsOn,
        createdAt: now,
        updatedAt: now,
      };
      if (assignedRole !== undefined) {
        workItem.assignedRole = assignedRole;
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
      workItem.status = nextStatus;
      workItem.updatedAt = now;
      return workItem;
    });
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
      findWorkItem(state, normalizedMissionId, workItemId);
      const id = input.id === undefined ? newId("handoff") : normalizedId(input.id, "handoff.id");
      ensureUniqueEntityId(state, id);
      const handoff: Handoff = {
        id,
        missionId: normalizedMissionId,
        workItemId,
        result: enumValue(input.result, handoffResults, "result"),
        summary: requiredString(input.summary, "summary"),
        filesChanged: input.filesChanged === undefined ? [] : stringArray(input.filesChanged, "filesChanged"),
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
