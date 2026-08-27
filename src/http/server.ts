import { readFile } from "node:fs/promises";

import {
  Evidence,
  Mission,
  MissionDomainError,
  MissionService,
  MissionState,
  WorkItem,
} from "../domain.js";
import {
  RepositoryInspectionInput,
  SandboxVerificationInput,
  TrueForgeIntegrationError,
  TrueForgeTurnResult,
} from "../trueforge.js";

export const PRIMARY_MISSION_ID = "primary-mission";
export const PRIMARY_MISSION_OBJECTIVE =
  "Add a backwards-compatible getNextDeliveryStage(stage) helper to src/index.ts. It returns the next stage for Plan, Execute, and Prove, returns null for terminal Approve, preserves the existing identity exports, and includes focused tests for every transition.";
export const PRIMARY_REPOSITORY = {
  owner: "mtamburrano",
  name: "trueforge-proofboard",
  ref: "590aa8a6d72c580f61fc1b19d33e9876bc0feb9b",
} as const;

const WORK = {
  inspect: "primary-inspect",
  implement: "primary-implement",
  verify: "primary-verify",
} as const;

const VERIFY_COMMAND = "npm run typecheck && npm test";

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
    options: { workItemId: string },
  ): Promise<TrueForgeTurnResult>;
  runSandboxVerification(input: SandboxVerificationInput): Promise<unknown>;
}

export interface MissionHttpOptions {
  missions: MissionService;
  runner: MissionRunner;
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
    execution: { connected: boolean; resumed: boolean };
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
      status: WorkItem["status"];
      dependsOn: string[];
      assignedRole?: WorkItem["assignedRole"];
    }>;
  }>;
  activity: ActivityView[];
  evidence: EvidenceView[];
  approvals: Array<{
    id: string;
    action: string;
    target: string;
    risk: string;
    expectedEffect: string;
    decision: string;
    createdAt: string;
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

class MissionController {
  private operation: Promise<MissionView> | null = null;

  constructor(
    private readonly missions: MissionService,
    private readonly runner: MissionRunner,
  ) {}

  async getPrimaryMission(): Promise<MissionView | null> {
    const state = await this.missions.getState();
    return state.missions.some((mission) => mission.id === PRIMARY_MISSION_ID)
      ? mapMissionState(state, PRIMARY_MISSION_ID)
      : null;
  }

  async createOrOpenPrimaryMission(): Promise<MissionView> {
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
    let state = await this.missions.getState();
    const exists = (id: string) => state.workItems.some(
      (item) => item.missionId === PRIMARY_MISSION_ID && item.id === id,
    );

    if (!exists(WORK.inspect)) {
      await this.missions.addWorkItem(PRIMARY_MISSION_ID, {
        id: WORK.inspect,
        title: "Inspect pinned repository",
        purpose: "Verify the exact source commit and expected file surface through repository MCP.",
        status: "ready",
        assignedRole: "planner",
      });
      state = await this.missions.getState();
    }
    if (!exists(WORK.implement)) {
      await this.missions.addWorkItem(PRIMARY_MISSION_ID, {
        id: WORK.implement,
        title: "Implement the stage helper",
        purpose: "Make the bounded backwards-compatible source and test change in the sandbox.",
        dependsOn: [WORK.inspect],
        assignedRole: "implementer",
      });
      state = await this.missions.getState();
    }
    if (!exists(WORK.verify)) {
      await this.missions.addWorkItem(PRIMARY_MISSION_ID, {
        id: WORK.verify,
        title: "Verify the delivery contract",
        purpose: "Run type checking and the complete test suite in the sandbox.",
        dependsOn: [WORK.implement],
        assignedRole: "reviewer",
      });
    }
  }

  private async executePrimaryMission(): Promise<MissionView> {
    await this.createOrOpenPrimaryMission();
    await this.prepareMissionForExecution();
    try {
      await this.executeWork(WORK.inspect, async () => {
        await this.runner.inspectRepository({
          missionId: PRIMARY_MISSION_ID,
          workItemId: WORK.inspect,
        });
        await this.requirePassedEvidence(WORK.inspect, "mcp");
      });
      await this.executeWork(WORK.implement, async () => {
        await this.runner.runTurn(
          PRIMARY_MISSION_ID,
          [
            "Implement the mission objective in the configured sandbox using the verified pinned source.",
            "Keep the change limited to src/index.ts and test/index.test.js.",
            "Do not push, open a pull request, or perform any other remote mutation.",
          ].join(" "),
          { workItemId: WORK.implement },
        );
        await this.requirePassedTurn(WORK.implement);
      });
      await this.executeWork(WORK.verify, async () => {
        await this.runner.runSandboxVerification({
          missionId: PRIMARY_MISSION_ID,
          workItemId: WORK.verify,
          command: VERIFY_COMMAND,
        });
        await this.requirePassedEvidence(WORK.verify, "sandbox");
      });

      const mission = await this.missions.getMission(PRIMARY_MISSION_ID);
      if (mission.status === "executing") {
        await this.missions.transitionMission(PRIMARY_MISSION_ID, "verifying");
      }
      return mapMissionState(await this.missions.getState(), PRIMARY_MISSION_ID);
    } catch (error) {
      await this.blockActiveWork();
      throw error;
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

  private async executeWork(workItemId: string, operation: () => Promise<void>): Promise<void> {
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
    if (item.status === "ready_for_review") {
      await this.missions.transitionWorkItem(PRIMARY_MISSION_ID, workItemId, "complete");
    }
  }

  private async requirePassedEvidence(workItemId: string, source: "mcp" | "sandbox") {
    const state = await this.missions.getState();
    const passed = state.evidence.some(
      (item) => item.workItemId === workItemId && item.source === source && item.result === "passed",
    );
    if (!passed) {
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
          item.status === "in_progress",
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
  const verification = failedEvidence > 0 || mission.status === "failed" || mission.status === "blocked"
    ? "failed"
    : mission.status === "verifying" || mission.status === "delivered"
    ? "passed"
    : workItems.some((item) => item.status === "in_progress" || item.status === "ready_for_review")
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
    approvals: state.approvals
      .filter((item) => item.missionId === missionId)
      .map((item) => ({
        id: item.id,
        action: item.action,
        target: item.target,
        risk: item.risk,
        expectedEffect: item.expectedEffect,
        decision: item.decision,
        createdAt: item.createdAt,
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
      status: item.status,
      dependsOn: [...item.dependsOn],
      ...(item.assignedRole === undefined ? {} : { assignedRole: item.assignedRole }),
    })),
  };
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
    ["reason", "reason"],
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

export function createMissionHttpApp(options: MissionHttpOptions) {
  const controller = new MissionController(options.missions, options.runner);
  return {
    request(path: string, init?: RequestInit) {
      return handle(new Request(new URL(path, "http://mission.local"), init));
    },
    fetch: handle,
  };

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        return htmlResponse(INDEX_HTML);
      }
      if (request.method === "GET" && url.pathname === "/public/style.css") {
        return assetResponse("style.css", "text/css; charset=utf-8");
      }
      if (request.method === "GET" && url.pathname === "/public/app.js") {
        return assetResponse("app.js", "text/javascript; charset=utf-8");
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
      const message = error instanceof Error ? error.message : "The operation failed.";
      const mission = await controller.getPrimaryMission().catch(() => null);
      return jsonResponse({ error: "operation_failed", message, mission }, status);
    }
  }
}

async function assetResponse(fileName: "style.css" | "app.js", contentType: string) {
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

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#08090a">
    <title>Mission Control · TrueForge</title>
    <link rel="stylesheet" href="/public/style.css">
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
