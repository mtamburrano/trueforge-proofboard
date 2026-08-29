import {
  Evidence,
  ExecutionOrigin,
  Mission,
  MissionDomainError,
  MissionState,
  Review,
  WorkItem,
} from "./domain.js";

export const DIAGNOSTIC_SNAPSHOT_VERSION = 1 as const;

const MAX_DIAGNOSTIC_TEXT = 2_000;
const MAX_DIAGNOSTIC_ITEMS = 40;
const MAX_DIAGNOSTIC_EVENTS = 80;
const MAX_DIAGNOSTIC_OBJECT_KEYS = 40;
const MAX_DIAGNOSTIC_ARRAY_ITEMS = 24;
const MAX_DIAGNOSTIC_DEPTH = 4;

export type DiagnosticFailureLayer = "trueforge" | "tool" | "proof_board";
export type DiagnosticFailureCategory =
  | "runtime"
  | "mcp"
  | "sandbox"
  | "policy"
  | "pipeline"
  | "review"
  | "approval"
  | "delivery";

export type DiagnosticValue =
  | string
  | number
  | boolean
  | null
  | DiagnosticValue[]
  | { [key: string]: DiagnosticValue };

export interface DiagnosticOrigin {
  kind: ExecutionOrigin["kind"];
  sessionId: string;
  turnId?: string;
  threadId?: string;
  toolCallId?: string;
}

export interface DiagnosticEvidence {
  id: string;
  source: Evidence["source"];
  kind: Evidence["kind"];
  result: "failed";
  summary: string;
  reason: string;
  createdAt: string;
  workItemId?: string;
  metadata: { [key: string]: DiagnosticValue };
  origin?: DiagnosticOrigin;
}

export interface DiagnosticFailure {
  id: string;
  layer: DiagnosticFailureLayer;
  category: DiagnosticFailureCategory;
  reason: string;
  summary: string;
  createdAt: string;
  evidenceId?: string;
  workItemId?: string;
  source?: Evidence["source"];
  metadata: { [key: string]: DiagnosticValue };
  origin?: DiagnosticOrigin;
}

export interface DiagnosticEvent {
  id: string;
  type: string;
  result: Evidence["result"];
  summary: string;
  createdAt: string;
  evidenceId?: string;
  sessionId?: string;
  turnId?: string;
  threadId?: string;
  toolCallId?: string;
  metadata: { [key: string]: DiagnosticValue };
}

export interface DiagnosticSnapshot {
  version: typeof DIAGNOSTIC_SNAPSHOT_VERSION;
  revision: number;
  capturedAt: string;
  mission: {
    id: string;
    objective: string;
    status: Mission["status"];
    createdAt: string;
    updatedAt: string;
    repository?: { owner: string; name: string; ref: string };
  };
  workItems: Array<{
    id: string;
    title: string;
    status: WorkItem["status"];
    dependsOn: string[];
    assignedRole?: WorkItem["assignedRole"];
    delegation?: {
      owner: string;
      threadId: string;
      status: NonNullable<WorkItem["delegation"]>["status"];
      turnId?: string;
      error?: string;
    };
  }>;
  failedEvidence: DiagnosticEvidence[];
  failures: DiagnosticFailure[];
  trueforge: {
    sessionId?: string;
    turnId?: string;
    sandboxId?: string;
    workspaceBaselineTreeRef?: string;
  };
  events: DiagnosticEvent[];
  proofBoard: {
    reviews: Array<{
      id: string;
      workItemId: string;
      outcome: Review["outcome"];
      reviewer: string;
      summary: string;
      finding: string;
      createdAt: string;
    }>;
    approvals: Array<{
      id: string;
      actionType: string;
      decision: string;
      target: string;
      createdAt: string;
      decidedAt?: string;
    }>;
    deliveries: Array<{
      id: string;
      status: string;
      verificationSummary: string;
      createdAt: string;
    }>;
  };
}

export function buildDiagnosticSnapshot(
  state: MissionState,
  missionId: string,
): DiagnosticSnapshot {
  const mission = state.missions.find((candidate) => candidate.id === missionId);
  if (mission === undefined) {
    throw new MissionDomainError("not_found", `Mission ${missionId} was not found.`);
  }

  const workItems = state.workItems.filter((item) => item.missionId === missionId);
  const missionEvidence = state.evidence.filter((item) => item.missionId === missionId);
  const failedEvidence = missionEvidence
    .filter((item) => item.result === "failed")
    .slice(-MAX_DIAGNOSTIC_ITEMS)
    .map(mapFailedEvidence);
  const failures = buildFailures(mission, workItems, missionEvidence, state);
  const events = buildEvents(missionEvidence);
  const sandboxId = mission.trueforgeSandboxId ?? latestSandboxId(missionEvidence);

  const diagnosticMission: DiagnosticSnapshot["mission"] = {
    id: mission.id,
    objective: safeText(mission.objective),
    status: mission.status,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  };
  if (mission.repository !== undefined) {
    diagnosticMission.repository = {
      owner: safeText(mission.repository.owner, 200),
      name: safeText(mission.repository.name, 200),
      ref: safeText(mission.repository.ref, 400),
    };
  }

  const trueforge: DiagnosticSnapshot["trueforge"] = {};
  if (mission.trueforgeSessionId !== undefined) {
    trueforge.sessionId = safeText(mission.trueforgeSessionId, 200);
  }
  if (mission.trueforgeTurnId !== undefined) {
    trueforge.turnId = safeText(mission.trueforgeTurnId, 200);
  }
  if (sandboxId !== undefined) {
    trueforge.sandboxId = safeText(sandboxId, 200);
  }
  if (mission.trueforgeWorkspaceBaselineTreeRef !== undefined) {
    trueforge.workspaceBaselineTreeRef = safeText(
      mission.trueforgeWorkspaceBaselineTreeRef,
      200,
    );
  }

  return {
    version: DIAGNOSTIC_SNAPSHOT_VERSION,
    revision: state.revision,
    capturedAt: mission.updatedAt,
    mission: diagnosticMission,
    workItems: workItems.slice(-MAX_DIAGNOSTIC_ITEMS).map(mapWorkItem),
    failedEvidence,
    failures,
    trueforge,
    events,
    proofBoard: {
      reviews: state.reviews
        .filter((review) => review.missionId === missionId)
        .slice(-MAX_DIAGNOSTIC_ITEMS)
        .map((review) => ({
          id: review.id,
          workItemId: review.workItemId,
          outcome: review.outcome,
          reviewer: safeText(review.reviewer),
          summary: safeText(review.summary),
          finding: safeText(review.finding),
          createdAt: review.createdAt,
        })),
      approvals: state.approvals
        .filter((approval) => approval.missionId === missionId)
        .slice(-MAX_DIAGNOSTIC_ITEMS)
        .map((approval) => ({
          id: approval.id,
          actionType: safeText(approval.actionType, 200),
          decision: approval.decision,
          target: safeText(approval.target),
          createdAt: approval.createdAt,
          ...(approval.decidedAt === undefined ? {} : { decidedAt: approval.decidedAt }),
        })),
      deliveries: state.deliveries
        .filter((delivery) => delivery.missionId === missionId)
        .slice(-MAX_DIAGNOSTIC_ITEMS)
        .map((delivery) => ({
          id: delivery.id,
          status: delivery.status,
          verificationSummary: safeText(delivery.verificationSummary),
          createdAt: delivery.createdAt,
        })),
    },
  };
}

function mapWorkItem(item: WorkItem): DiagnosticSnapshot["workItems"][number] {
  const mapped: DiagnosticSnapshot["workItems"][number] = {
    id: item.id,
    title: safeText(item.title),
    status: item.status,
    dependsOn: item.dependsOn.slice(0, MAX_DIAGNOSTIC_ARRAY_ITEMS),
  };
  if (item.assignedRole !== undefined) {
    mapped.assignedRole = item.assignedRole;
  }
  if (item.delegation !== undefined) {
    mapped.delegation = {
      owner: safeText(item.delegation.owner, 200),
      threadId: safeText(item.delegation.threadId, 200),
      status: item.delegation.status,
      ...(item.delegation.turnId === undefined
        ? {}
        : { turnId: safeText(item.delegation.turnId, 200) }),
      ...(item.delegation.error === undefined
        ? {}
        : { error: safeText(item.delegation.error) }),
    };
  }
  return mapped;
}

function mapFailedEvidence(evidence: Evidence): DiagnosticEvidence {
  const details = parseDetails(evidence.details);
  const mapped: DiagnosticEvidence = {
    id: evidence.id,
    source: evidence.source,
    kind: evidence.kind,
    result: "failed",
    summary: safeText(evidence.summary),
    reason: diagnosticReason(details, evidence.summary),
    createdAt: evidence.createdAt,
    metadata: details === null ? {} : safeRecord(details),
  };
  if (evidence.workItemId !== undefined) {
    mapped.workItemId = evidence.workItemId;
  }
  if (evidence.executionOrigin !== undefined) {
    mapped.origin = safeOrigin(evidence.executionOrigin);
  }
  return mapped;
}

function buildFailures(
  mission: Mission,
  workItems: WorkItem[],
  evidence: Evidence[],
  state: MissionState,
): DiagnosticFailure[] {
  const failures: DiagnosticFailure[] = evidence
    .filter((item) => item.result === "failed")
    .map((item) => failureFromEvidence(item));

  for (const item of workItems) {
    if (item.status !== "blocked") {
      continue;
    }
    const reason = item.delegation?.error === undefined
      ? `Work item ${item.title} is blocked.`
      : item.delegation.error;
    failures.push({
      id: `work-item:${item.id}`,
      layer: "proof_board",
      category: "pipeline",
      reason: safeText(reason),
      summary: "Proof Board blocked the work item from advancing.",
      createdAt: item.updatedAt,
      workItemId: item.id,
      metadata: {
        status: item.status,
        depends_on: item.dependsOn.slice(0, MAX_DIAGNOSTIC_ARRAY_ITEMS),
      },
    });
  }

  for (const review of state.reviews.filter((item) =>
    item.missionId === mission.id && item.outcome !== "accepted"
  )) {
    failures.push({
      id: `review:${review.id}`,
      layer: "proof_board",
      category: "review",
      reason: safeText(review.finding),
      summary: safeText(review.summary),
      createdAt: review.createdAt,
      workItemId: review.workItemId,
      metadata: {
        outcome: review.outcome,
        reviewer: safeText(review.reviewer, 200),
      },
    });
  }

  for (const approval of state.approvals.filter((item) =>
    item.missionId === mission.id &&
    (item.decision === "rejected" || item.decision === "cancelled")
  )) {
    failures.push({
      id: `approval:${approval.id}`,
      layer: "proof_board",
      category: "approval",
      reason: `The ${approval.actionType} action was ${approval.decision}.`,
      summary: "Proof Board kept the consequential action from advancing.",
      createdAt: approval.decidedAt ?? approval.createdAt,
      metadata: {
        action_type: safeText(approval.actionType, 200),
        target: safeText(approval.target),
      },
    });
  }

  for (const delivery of state.deliveries.filter((item) =>
    item.missionId === mission.id && item.status === "failed"
  )) {
    failures.push({
      id: `delivery:${delivery.id}`,
      layer: "proof_board",
      category: "delivery",
      reason: safeText(delivery.verificationSummary),
      summary: "The recorded delivery did not complete successfully.",
      createdAt: delivery.createdAt,
      metadata: {},
    });
  }

  if (mission.status === "blocked" || mission.status === "failed") {
    failures.push({
      id: `mission:${mission.id}`,
      layer: "proof_board",
      category: "pipeline",
      reason: `Mission is ${mission.status}; no unverified progress is being advanced.`,
      summary: "Proof Board held the mission in a terminal failure state.",
      createdAt: mission.updatedAt,
      metadata: { status: mission.status },
    });
  }

  return failures
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, MAX_DIAGNOSTIC_ITEMS);
}

function failureFromEvidence(evidence: Evidence): DiagnosticFailure {
  const details = parseDetails(evidence.details);
  const classification = classifyFailure(evidence, details);
  const failure: DiagnosticFailure = {
    id: `evidence:${evidence.id}`,
    layer: classification.layer,
    category: classification.category,
    reason: diagnosticReason(details, evidence.summary),
    summary: safeText(evidence.summary),
    createdAt: evidence.createdAt,
    source: evidence.source,
    metadata: details === null ? {} : safeRecord(details),
  };
  if (evidence.workItemId !== undefined) {
    failure.workItemId = evidence.workItemId;
  }
  if (evidence.executionOrigin !== undefined) {
    failure.origin = safeOrigin(evidence.executionOrigin);
  }
  failure.evidenceId = evidence.id;
  return failure;
}

function classifyFailure(
  evidence: Evidence,
  details: Record<string, unknown> | null,
): { layer: DiagnosticFailureLayer; category: DiagnosticFailureCategory } {
  const explicitLayer = details === null ? undefined : details.failure_layer;
  const explicitCategory = details === null ? undefined : details.failure_category;
  if (isFailureLayer(explicitLayer) && isFailureCategory(explicitCategory)) {
    return { layer: explicitLayer, category: explicitCategory };
  }
  if (evidence.source === "mcp" || evidence.executionOrigin?.kind === "mcp") {
    return { layer: "tool", category: "mcp" };
  }
  if (evidence.source === "sandbox" || evidence.executionOrigin?.kind === "sandbox") {
    return { layer: "tool", category: "sandbox" };
  }
  if (evidence.source === "trueforge" || evidence.executionOrigin?.kind === "trueforge") {
    return { layer: "trueforge", category: "runtime" };
  }
  if (evidence.source === "reviewer") {
    return { layer: "proof_board", category: "review" };
  }
  if (evidence.source === "human") {
    return { layer: "proof_board", category: "approval" };
  }
  return { layer: "proof_board", category: "pipeline" };
}

function buildEvents(evidence: Evidence[]): DiagnosticEvent[] {
  const events: DiagnosticEvent[] = [];
  const keys = new Set<string>();
  const append = (event: DiagnosticEvent): void => {
    const key = `${event.id}:${event.type}:${event.toolCallId ?? ""}`;
    if (keys.has(key)) {
      return;
    }
    keys.add(key);
    events.push(event);
  };

  for (const item of evidence) {
    const details = parseDetails(item.details);
    if (details === null) {
      if (item.executionOrigin !== undefined && item.source !== "system") {
        append(eventFromEvidence(item, "evidence", {}));
      }
      continue;
    }

    const nestedEvents = details.events ?? details.runtime_events;
    if (Array.isArray(nestedEvents)) {
      for (const nested of nestedEvents.slice(-MAX_DIAGNOSTIC_EVENTS)) {
        if (isRecord(nested)) {
          append(eventFromRecord(item, nested, "runtime.event"));
        }
      }
    }
    const toolCalls = details.tool_calls ?? details.toolCalls;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls.slice(-MAX_DIAGNOSTIC_EVENTS)) {
        if (isRecord(call)) {
          append(eventFromRecord(item, call, "tool.call"));
        }
      }
    }
    const toolResponses = details.tool_responses ?? details.toolResponses;
    if (Array.isArray(toolResponses)) {
      for (const response of toolResponses.slice(-MAX_DIAGNOSTIC_EVENTS)) {
        if (isRecord(response)) {
          append(eventFromRecord(item, response, "tool.response"));
        }
      }
    }
    if (typeof details.event_type === "string" || item.executionOrigin !== undefined) {
      append(eventFromEvidence(item, stringValue(details.event_type) ?? "evidence", details));
    }
  }

  return events
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-MAX_DIAGNOSTIC_EVENTS);
}

function eventFromEvidence(
  evidence: Evidence,
  type: string,
  metadata: Record<string, unknown>,
): DiagnosticEvent {
  const details = parseDetails(evidence.details);
  const origin = evidence.executionOrigin;
  const event: DiagnosticEvent = {
    id: stringValue(details?.event_id) ?? evidence.id,
    type: safeText(type, 200),
    result: evidence.result,
    summary: safeText(evidence.summary),
    createdAt: stringValue(details?.created_at) ?? evidence.createdAt,
    evidenceId: evidence.id,
    metadata: safeRecord(metadata),
  };
  addOrigin(event, origin, details);
  return event;
}

function eventFromRecord(
  evidence: Evidence,
  record: Record<string, unknown>,
  fallbackType: string,
): DiagnosticEvent {
  const event: DiagnosticEvent = {
    id: stringValue(record.id ?? record.event_id) ?? `${evidence.id}:${fallbackType}`,
    type: safeText(stringValue(record.type ?? record.event_type) ?? fallbackType, 200),
    result: diagnosticResult(record.result) ?? evidence.result,
    summary: safeText(stringValue(record.summary) ?? evidence.summary),
    createdAt: stringValue(record.createdAt ?? record.created_at) ?? evidence.createdAt,
    evidenceId: evidence.id,
    metadata: safeRecord(record),
  };
  addOrigin(event, evidence.executionOrigin, record);
  return event;
}

function addOrigin(
  event: DiagnosticEvent,
  origin: ExecutionOrigin | undefined,
  details: Record<string, unknown> | null,
): void {
  const sessionId = origin?.sessionId;
  if (sessionId !== undefined) {
    event.sessionId = safeText(sessionId, 200);
  }
  const turnId = stringValue(details?.turn_id) ?? origin?.turnId;
  const threadId = stringValue(details?.thread_id) ?? origin?.threadId;
  const toolCallId = stringValue(details?.tool_call_id) ?? origin?.toolCallId;
  if (turnId !== undefined) {
    event.turnId = safeText(turnId, 200);
  }
  if (threadId !== undefined) {
    event.threadId = safeText(threadId, 200);
  }
  if (toolCallId !== undefined) {
    event.toolCallId = safeText(toolCallId, 200);
  }
}

function latestSandboxId(evidence: Evidence[]): string | undefined {
  for (const item of [...evidence].reverse()) {
    const details = parseDetails(item.details);
    const sandboxId = stringValue(details?.sandbox_id) ?? stringValue(details?.sandboxId);
    if (sandboxId !== undefined) {
      return sandboxId;
    }
    if (item.executionOrigin?.kind === "sandbox" && item.executionOrigin.sessionId.length > 0) {
      continue;
    }
  }
  return undefined;
}

function diagnosticReason(
  details: Record<string, unknown> | null,
  fallback: string,
): string {
  if (details !== null) {
    for (const key of ["reason", "error", "message", "finding"]) {
      const value = stringValue(details[key]);
      if (value !== undefined && value.trim().length > 0) {
        return safeText(value);
      }
    }
  }
  return safeText(fallback);
}

function parseDetails(value: string | undefined): Record<string, unknown> | null {
  if (value === undefined) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeOrigin(origin: ExecutionOrigin): DiagnosticOrigin {
  const result: DiagnosticOrigin = {
    kind: origin.kind,
    sessionId: safeText(origin.sessionId, 200),
  };
  if (origin.turnId !== undefined) {
    result.turnId = safeText(origin.turnId, 200);
  }
  if (origin.threadId !== undefined) {
    result.threadId = safeText(origin.threadId, 200);
  }
  if (origin.toolCallId !== undefined) {
    result.toolCallId = safeText(origin.toolCallId, 200);
  }
  return result;
}

function safeRecord(value: Record<string, unknown>): { [key: string]: DiagnosticValue } {
  const entries = Object.entries(value).slice(0, MAX_DIAGNOSTIC_OBJECT_KEYS);
  const result: { [key: string]: DiagnosticValue } = {};
  for (const [key, child] of entries) {
    if (isSensitiveKey(key)) {
      continue;
    }
    result[safeText(key, 120)] = safeValue(child, key, 0);
  }
  return result;
}

function safeValue(value: unknown, key: string, depth: number): DiagnosticValue {
  if (isSensitiveKey(key)) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    return safeText(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : "[unavailable]";
  }
  if (typeof value === "boolean" || value === null) {
    return value;
  }
  if (depth >= MAX_DIAGNOSTIC_DEPTH) {
    return "[bounded]";
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_DIAGNOSTIC_ARRAY_ITEMS)
      .map((child) => safeValue(child, key, depth + 1));
  }
  if (isRecord(value)) {
    return safeRecordAtDepth(value, depth + 1);
  }
  return "[unavailable]";
}

function safeRecordAtDepth(
  value: Record<string, unknown>,
  depth: number,
): { [key: string]: DiagnosticValue } {
  const result: { [key: string]: DiagnosticValue } = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_DIAGNOSTIC_OBJECT_KEYS)) {
    if (isSensitiveKey(key)) {
      continue;
    }
    result[safeText(key, 120)] = safeValue(child, key, depth);
  }
  return result;
}

function safeText(value: string, maxLength = MAX_DIAGNOSTIC_TEXT): string {
  return value
    .replace(/authorization\s*[:=]\s*bearer\s+[^\s,;]+/gi, "[redacted]")
    .replace(/\b(?:api[_-]?key|token|password|secret|credential|cookie)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "[redacted]")
    .slice(0, maxLength);
}

function isSensitiveKey(value: string): boolean {
  return /authorization|api[_-]?key|token|password|secret|credential|cookie|private[_-]?key/i.test(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function diagnosticResult(value: unknown): Evidence["result"] | undefined {
  return value === "passed" || value === "failed" || value === "informational"
    ? value
    : undefined;
}

function isFailureLayer(value: unknown): value is DiagnosticFailureLayer {
  return value === "trueforge" || value === "tool" || value === "proof_board";
}

function isFailureCategory(value: unknown): value is DiagnosticFailureCategory {
  return value === "runtime" || value === "mcp" || value === "sandbox" ||
    value === "policy" || value === "pipeline" || value === "review" ||
    value === "approval" || value === "delivery";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
