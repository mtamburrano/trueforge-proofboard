import { TrueForge } from "@truefoundry/trueforge-sdk";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

import {
  CreateMissionInput,
  EvidenceKind,
  EvidenceResult,
  Mission,
  MissionDomainError,
  MissionService,
  WorkItem,
  missionTransitions,
} from "./domain.js";

export interface TrueForgeClientOptions {
  baseUrl: string;
  token?: string;
  timeoutInSeconds?: number;
}

export interface TrueForgeMissionConfig {
  model: string;
  instructions?: string;
  mcpServers?: TrueForgeApi.McpServer[];
  mcpServerName?: string;
  repositoryToolName?: string;
  sandboxToolName?: string;
  iterationLimit?: number;
  sandboxEnabled?: boolean;
}

export interface TrueForgeEventStream extends AsyncIterable<TrueForgeApi.TurnStreamingEvent> {
  withMetadata?: () => AsyncIterable<{ data: TrueForgeApi.TurnStreamingEvent }>;
}

const LOCKED_FIXTURE_OWNER = "mtamburrano";
const LOCKED_FIXTURE_REPO = "trueforge-proofboard";
const LOCKED_FIXTURE_SHA = "590aa8a6d72c580f61fc1b19d33e9876bc0feb9b";
const LOCKED_FIXTURE_FILES = ["src/index.ts", "test/index.test.js"] as const;
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
} as const;

const SANDBOX_VERIFICATION_INTENT = "Run the requested verification command in the sandbox.";

export interface TrueForgeClientLike {
  sessions: {
    create(request: TrueForgeApi.CreateSessionRequest): Promise<TrueForgeApi.GetSessionResponse>;
    get(sessionId: string): Promise<TrueForgeApi.GetSessionResponse>;
    createTurnStream(
      sessionId: string,
      request: TrueForgeApi.CreateTurnSessionsStreamRequest,
    ): Promise<TrueForgeEventStream>;
  };
}

export interface MissionSession {
  sessionId: string;
  created: boolean;
}

export interface RunTurnOptions {
  workItemId?: string;
  previousTurnId?: string;
}

export interface RepositoryInspectionInput {
  missionId: string;
  path?: string;
  workItemId?: string;
  mcpServerName?: string;
  toolName?: string;
}

export interface RepositoryInspectionResult {
  sessionId: string;
  turnId: string;
  mcpServerName: string;
  toolName: string;
  resourceUri: string;
  content: string;
  contentBytes: number;
  contentHash: string;
  commitSha?: string;
  patches?: Readonly<Record<string, string>>;
  evidenceId: string;
  mission: Mission;
}

export interface SandboxVerificationInput {
  missionId: string;
  command: string;
  workItemId?: string;
  toolName?: string;
}

export interface SandboxVerificationResult {
  sessionId: string;
  turnId: string;
  toolName: string;
  command: string;
  exitCode: number;
  stdout: string;
  outputSummary: string;
  evidenceId: string;
  mission: Mission;
}

export interface TrueForgeRuntimeEvent {
  id: string | null;
  type: string;
  createdAt: string | null;
  threadId: string | null;
  turnId: string | null;
}

export interface TrueForgeTurnResult {
  sessionId: string;
  turnId: string;
  events: TrueForgeRuntimeEvent[];
  mission: Mission;
}

interface RuntimeEvidence {
  kind: EvidenceKind;
  result: EvidenceResult;
  summary: string;
  details: string;
}

interface InternalTurnResult extends TrueForgeTurnResult {
  rawEvents: TrueForgeApi.TurnStreamingEvent[];
}

interface VerifiedRepositoryFile {
  resourceUri: string;
  content: string;
  contentHash: string;
}

interface VerifiedRepositoryCommit {
  resourceUri: string;
  content: string;
  contentHash: string;
  commitSha: string;
  patches: Readonly<Record<string, string>>;
}

function isVerifiedRepositoryCommit(
  value: VerifiedRepositoryFile | VerifiedRepositoryCommit,
): value is VerifiedRepositoryCommit {
  return "commitSha" in value && "patches" in value;
}

interface VerifiedSandboxExecution {
  exitCode: number;
  stdout: string;
  outputSummary: string;
}

export class TrueForgeIntegrationError extends Error {
  readonly operation: string;

  constructor(operation: string, message: string) {
    super(message);
    this.name = "TrueForgeIntegrationError";
    this.operation = operation;
  }
}

export function createTrueForgeClient(options: TrueForgeClientOptions): TrueForgeClientLike {
  if (options.baseUrl.trim().length === 0) {
    throw new MissionDomainError("invalid_input", "TrueForge baseUrl must not be empty.");
  }
  const client = new TrueForge({
    baseUrl: options.baseUrl,
    timeoutInSeconds: options.timeoutInSeconds ?? 600,
    ...(options.token === undefined ? {} : { token: options.token }),
  });
  return client as unknown as TrueForgeClientLike;
}

export function buildMissionAgentSpec(
  config: TrueForgeMissionConfig,
): TrueForgeApi.AgentSpec {
  if (config.model.trim().length === 0) {
    throw new MissionDomainError("invalid_input", "TrueForge model must not be empty.");
  }
  const spec: TrueForgeApi.AgentSpec = {
    model: { name: config.model },
    instructions: config.instructions ?? defaultInstructions,
    config: {
      sandbox: { enabled: config.sandboxEnabled ?? true },
      dynamicSubAgents: { enabled: false },
      askUserQuestions: { enabled: false },
      generativeUi: { enabled: false },
      iterationLimit: config.iterationLimit ?? 12,
    },
  };
  spec.mcpServers = config.mcpServers ?? [defaultRepositoryMcpServer(config)];
  return spec;
}

const defaultInstructions = [
  "Work only on the supplied mission objective and active work item.",
  "Inspect before changing anything and use the attached MCP tools for repository facts.",
  "Run generated commands only through the configured sandbox.",
  "Return concrete evidence and stop before consequential remote mutations unless approval is present.",
].join(" ");

function defaultRepositoryMcpServer(
  config: TrueForgeMissionConfig,
): TrueForgeApi.McpServer {
  const toolName = config.repositoryToolName ?? "get_file_contents";
  const toolNames = [...new Set([toolName, "get_file_contents", "get_commit"])];
  return {
    name: config.mcpServerName ?? "github",
    enableTools: toolNames,
    preloadTools: toolNames,
  };
}

export class TrueForgeMissionRunner {
  constructor(
    private readonly missions: MissionService,
    private readonly client: TrueForgeClientLike,
    private readonly config: TrueForgeMissionConfig,
  ) {}

  async createMission(input: CreateMissionInput): Promise<Mission> {
    const session = await this.resolveSession(input.trueforgeSessionId);
    const missionInput: CreateMissionInput = {
      objective: input.objective,
      trueforgeSessionId: session.sessionId,
    };
    if (input.id !== undefined) {
      missionInput.id = input.id;
    }
    if (input.repository !== undefined) {
      missionInput.repository = input.repository;
    }
    return this.missions.createMission(missionInput);
  }

  async resumeMission(missionId: string): Promise<MissionSession> {
    const mission = await this.missions.getMission(missionId);
    if (mission.trueforgeSessionId === undefined) {
      throw new TrueForgeIntegrationError(
        "resume session",
        `Mission ${mission.id} has no TrueForge session reference.`,
      );
    }
    const session = await this.call("resume session", () =>
      this.client.sessions.get(mission.trueforgeSessionId as string),
    );
    this.requireSessionId(session, mission.trueforgeSessionId, "resume session");
    return { sessionId: mission.trueforgeSessionId, created: false };
  }

  async runTurn(
    missionId: string,
    instruction: string,
    options: RunTurnOptions = {},
  ): Promise<TrueForgeTurnResult> {
    const execution = await this.executeTurn(missionId, instruction, options);
    return {
      sessionId: execution.sessionId,
      turnId: execution.turnId,
      events: execution.events,
      mission: execution.mission,
    };
  }

  async inspectRepository(
    input: RepositoryInspectionInput,
  ): Promise<RepositoryInspectionResult> {
    const mission = await this.missions.getMission(input.missionId);
    try {
      if (mission.repository === undefined) {
        throw new TrueForgeIntegrationError(
          "inspect repository",
          `Mission ${mission.id} has no repository target.`,
        );
      }
      const lockedFixture = isLockedFixtureRepository(mission.repository);
      const path = input.path === undefined
        ? undefined
        : requiredInspectionString(input.path, "repository path");
      const mcpServerName = requiredInspectionString(
        input.mcpServerName ?? this.config.mcpServerName ?? "github",
        "MCP server name",
      );
      const requestedToolName = input.toolName ?? this.config.repositoryToolName;
      if (lockedFixture && requestedToolName !== undefined && requestedToolName !== "get_commit") {
        throw new TrueForgeIntegrationError(
          "inspect repository",
          "The locked fixture requires the canonical GitHub MCP get_commit tool.",
        );
      }
      const toolName = lockedFixture
        ? "get_commit"
        : requiredInspectionString(requestedToolName ?? "get_file_contents", "MCP tool name");
      if (!lockedFixture && path === undefined) {
        throw new TrueForgeIntegrationError("inspect repository", "repository path must not be empty.");
      }
      ensureRepositoryMcpConfigured(this.config, mcpServerName, toolName);
      const inspectionOptions: RunTurnOptions = {};
      if (input.workItemId !== undefined) {
        inspectionOptions.workItemId = input.workItemId;
      }
      const execution = await this.executeTurn(
        mission.id,
        lockedFixture
          ? buildLockedFixtureInspectionInstruction(mission, mcpServerName)
          : buildRepositoryInspectionInstruction(mission, path as string, mcpServerName, toolName),
        inspectionOptions,
      );
      const verified: VerifiedRepositoryFile | VerifiedRepositoryCommit = lockedFixture
        ? verifyLockedFixtureInspection(execution.rawEvents, mission.repository, mcpServerName)
        : verifyRepositoryInspection(
            execution.rawEvents,
            mission.repository,
            path as string,
            mcpServerName,
            toolName,
          );
      const isCommit = isVerifiedRepositoryCommit(verified);
      const evidenceInput = {
        kind: "tool_result" as const,
        result: "passed" as const,
        source: "mcp" as const,
        summary: isCommit
          ? `MCP verified locked repository commit ${verified.commitSha}.`
          : `MCP verified repository file ${verified.resourceUri}.`,
        details: isCommit
          ? JSON.stringify({
              server: mcpServerName,
              tool: toolName,
              arguments: lockedFixtureArguments(),
              commit_sha: verified.commitSha,
              patches: verified.patches,
              content_hash: verified.contentHash,
            })
          : JSON.stringify({
              server: mcpServerName,
              tool: toolName,
              uri: verified.resourceUri,
              content_bytes: verified.content.length,
              content_hash: verified.contentHash,
            }),
      };
      const evidence = input.workItemId === undefined
        ? await this.missions.addEvidence(mission.id, evidenceInput)
        : await this.missions.addEvidence(mission.id, {
            ...evidenceInput,
            workItemId: input.workItemId,
          });
      const result: RepositoryInspectionResult = {
        sessionId: execution.sessionId,
        turnId: execution.turnId,
        mcpServerName,
        toolName,
        resourceUri: verified.resourceUri,
        content: verified.content,
        contentBytes: verified.content.length,
        contentHash: verified.contentHash,
        evidenceId: evidence.id,
        mission: await this.missions.getMission(mission.id),
      };
      if (isCommit) {
        result.commitSha = verified.commitSha;
        result.patches = verified.patches;
      }
      return result;
    } catch (error) {
      await this.recordInspectionFailure(mission.id, input.workItemId, error);
      if (error instanceof TrueForgeIntegrationError) {
        throw error;
      }
      throw new TrueForgeIntegrationError(
        "inspect repository",
        "The repository inspection could not be verified.",
      );
    }
  }

  async runSandboxVerification(
    input: SandboxVerificationInput,
  ): Promise<SandboxVerificationResult> {
    const mission = await this.missions.getMission(input.missionId);
    try {
      const command = requiredSandboxString(input.command, "sandbox command");
      const toolName = canonicalSandboxToolName(input.toolName, this.config.sandboxToolName);
      const intent = buildSandboxVerificationIntent();
      const verificationOptions: RunTurnOptions = {};
      if (input.workItemId !== undefined) {
        verificationOptions.workItemId = input.workItemId;
      }
      const execution = await this.executeTurn(
        mission.id,
        buildSandboxVerificationInstruction(mission, command, toolName, intent),
        verificationOptions,
      );
      const verified = verifySandboxExecution(execution.rawEvents, intent, command, toolName);
      const evidenceInput = {
        kind: "test_result" as const,
        result: "passed" as const,
        source: "sandbox" as const,
        summary: `Sandbox ${toolName} completed the verification command with exit code 0.`,
        details: JSON.stringify({
          tool: toolName,
          intent,
          command,
          exit_code: verified.exitCode,
          output: verified.outputSummary,
        }),
      };
      const evidence = input.workItemId === undefined
        ? await this.missions.addEvidence(mission.id, evidenceInput)
        : await this.missions.addEvidence(mission.id, {
            ...evidenceInput,
            workItemId: input.workItemId,
          });
      return {
        sessionId: execution.sessionId,
        turnId: execution.turnId,
        toolName,
        command,
        exitCode: verified.exitCode,
        stdout: verified.stdout,
        outputSummary: verified.outputSummary,
        evidenceId: evidence.id,
        mission: await this.missions.getMission(mission.id),
      };
    } catch (error) {
      await this.recordSandboxFailure(mission.id, input.workItemId, input.command, error);
      if (error instanceof TrueForgeIntegrationError) {
        throw error;
      }
      throw new TrueForgeIntegrationError(
        "run sandbox verification",
        "The sandbox verification could not be verified.",
      );
    }
  }

  private async executeTurn(
    missionId: string,
    instruction: string,
    options: RunTurnOptions,
  ): Promise<InternalTurnResult> {
    const mission = await this.missions.getMission(missionId);
    const session = await this.resumeMission(mission.id);
    const workItem = options.workItemId === undefined
      ? undefined
      : await this.missions.getWorkItem(mission.id, options.workItemId);
    const content = buildTurnInstruction(mission, workItem, instruction);
    const request: TrueForgeApi.CreateTurnSessionsStreamRequest = {
      input: [{ type: "user.message", content }],
    };
    if (options.previousTurnId !== undefined) {
      request.previousTurnId = options.previousTurnId;
    }

    const stream = await this.call("start turn", () =>
      this.client.sessions.createTurnStream(session.sessionId, request),
    );
    const events: TrueForgeRuntimeEvent[] = [];
    const rawEvents: TrueForgeApi.TurnStreamingEvent[] = [];
    let turnId: string | null = null;
    for await (const event of streamEvents(stream)) {
      rawEvents.push(event);
      const runtimeEvent = summarizeRuntimeEvent(event);
      events.push(runtimeEvent);
      if (event.type === "turn.created") {
        turnId = event.turnId;
        await this.missions.attachTrueforgeTurn(mission.id, turnId);
      }
      const evidence = runtimeEvidence(event);
      if (evidence !== null) {
        const evidenceInput = {
          kind: evidence.kind,
          result: evidence.result,
          source: "trueforge" as const,
          summary: evidence.summary,
          details: evidence.details,
        };
        if (workItem !== undefined) {
          await this.missions.addEvidence(mission.id, {
            ...evidenceInput,
            workItemId: workItem.id,
          });
        } else {
          await this.missions.addEvidence(mission.id, evidenceInput);
        }
      }
    }
    if (turnId === null) {
      throw new TrueForgeIntegrationError(
        "complete turn",
        "TrueForge did not emit a turn.created event.",
      );
    }
    return {
      sessionId: session.sessionId,
      turnId,
      events,
      rawEvents,
      mission: await this.missions.getMission(mission.id),
    };
  }

  private async recordInspectionFailure(
    missionId: string,
    workItemId: string | undefined,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof TrueForgeIntegrationError
      ? error.message
      : "The repository inspection could not be verified.";
    try {
      const evidenceInput = {
        kind: "tool_result" as const,
        result: "failed" as const,
        source: "mcp" as const,
        summary: "MCP repository inspection failed; no repository finding was accepted.",
        details: JSON.stringify({ reason: message }),
      };
      if (workItemId === undefined) {
        await this.missions.addEvidence(missionId, evidenceInput);
      } else {
        await this.missions.addEvidence(missionId, { ...evidenceInput, workItemId });
      }
      const current = await this.missions.getMission(missionId);
      if (
        current.status !== "blocked" &&
        current.status !== "delivered" &&
        current.status !== "failed" &&
        missionTransitions[current.status].includes("blocked")
      ) {
        await this.missions.transitionMission(missionId, "blocked");
      }
    } catch {
      // Preserve the original inspection error when the mission is already terminal or unavailable.
    }
  }

  private async resolveSession(sessionId: string | undefined): Promise<MissionSession> {
    if (sessionId !== undefined) {
      const existing = await this.call("attach session", () =>
        this.client.sessions.get(sessionId),
      );
      this.requireSessionId(existing, sessionId, "attach session");
      return { sessionId, created: false };
    }
    const created = await this.call("create session", () =>
      this.client.sessions.create({ agent: { spec: buildMissionAgentSpec(this.config) } }),
    );
    const createdSessionId = this.requireSessionId(created, null, "create session");
    return { sessionId: createdSessionId, created: true };
  }

  private requireSessionId(
    response: TrueForgeApi.GetSessionResponse,
    expectedId: string | null,
    operation: string,
  ): string {
    const session = isRecord(response) && isRecord(response.data) ? response.data : null;
    if (session === null || typeof session.id !== "string" || session.id.trim().length === 0) {
      throw new TrueForgeIntegrationError(operation, "TrueForge returned a session without an id.");
    }
    if (expectedId !== null && session.id !== expectedId) {
      throw new TrueForgeIntegrationError(operation, "TrueForge returned a different session id.");
    }
    return session.id;
  }

  private async call<T>(operation: string, callback: () => Promise<T>): Promise<T> {
    try {
      return await callback();
    } catch (error) {
      if (error instanceof TrueForgeIntegrationError) {
        throw error;
      }
      throw new TrueForgeIntegrationError(operation, `TrueForge ${operation} failed.`);
    }
  }

  private async recordSandboxFailure(
    missionId: string,
    workItemId: string | undefined,
    command: string,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof TrueForgeIntegrationError
      ? error.message
      : "The sandbox verification could not be verified.";
    try {
      const evidenceInput = {
        kind: "test_result" as const,
        result: "failed" as const,
        source: "sandbox" as const,
        summary: "Sandbox verification failed; the command was not accepted as passing.",
        details: JSON.stringify({
          command: typeof command === "string" ? command.trim().slice(0, 2_000) : "",
          reason: message,
        }),
      };
      if (workItemId === undefined) {
        await this.missions.addEvidence(missionId, evidenceInput);
      } else {
        await this.missions.addEvidence(missionId, { ...evidenceInput, workItemId });
      }
      const current = await this.missions.getMission(missionId);
      if (
        current.status !== "blocked" &&
        current.status !== "delivered" &&
        current.status !== "failed" &&
        missionTransitions[current.status].includes("blocked")
      ) {
        await this.missions.transitionMission(missionId, "blocked");
      }
    } catch {
      // Preserve the original verification error when the mission is already terminal or unavailable.
    }
  }
}

function buildTurnInstruction(
  mission: Mission,
  workItem: WorkItem | undefined,
  instruction: string,
): string {
  if (instruction.trim().length === 0) {
    throw new MissionDomainError("invalid_input", "Turn instruction must not be empty.");
  }
  const workItemContext = workItem === undefined
    ? "No specific work item is selected."
    : `Active work item: ${workItem.title}. Purpose: ${workItem.purpose}`;
  return [
    `Mission objective: ${mission.objective}`,
    workItemContext,
    `Requested action: ${instruction.trim()}`,
    "Keep the work bounded to this mission and report structured facts from the tools you actually use.",
  ].join("\n");
}

function requiredInspectionString(value: string | undefined, label: string): string {
  return requiredString(value, label, "inspect repository");
}

function requiredSandboxString(value: string, label: string): string {
  return requiredString(value, label, "run sandbox verification");
}

function requiredString(value: string | undefined, label: string, operation: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new TrueForgeIntegrationError(operation, `${label} must not be empty.`);
  }
  return value.trim();
}

function canonicalSandboxToolName(
  inputToolName: string | undefined,
  configuredToolName: string | undefined,
): "exec" {
  const requestedToolName = inputToolName ?? configuredToolName;
  if (requestedToolName !== undefined) {
    const toolName = requiredSandboxString(requestedToolName, "sandbox tool name");
    if (toolName !== "exec") {
      throw new TrueForgeIntegrationError(
        "run sandbox verification",
        "Sandbox verification requires the canonical TrueForge exec tool.",
      );
    }
  }
  return "exec";
}

function ensureRepositoryMcpConfigured(
  config: TrueForgeMissionConfig,
  serverName: string,
  toolName: string,
): void {
  const servers = config.mcpServers ?? [defaultRepositoryMcpServer(config)];
  const server = servers.find((candidate) => candidate.name === serverName);
  const enabledTools = server?.enableTools ?? [];
  if (
    server === undefined ||
    (!enabledTools.includes(toolName) && !enabledTools.includes("@all"))
  ) {
    throw new TrueForgeIntegrationError(
      "inspect repository",
      `MCP server ${serverName} is not configured to expose ${toolName}.`,
    );
  }
}

function buildRepositoryInspectionInstruction(
  mission: Mission,
  path: string,
  serverName: string,
  toolName: string,
): string {
  if (mission.repository === undefined) {
    throw new TrueForgeIntegrationError(
      "inspect repository",
      `Mission ${mission.id} has no repository target.`,
    );
  }
  const argumentsValue = {
    owner: mission.repository.owner,
    repo: mission.repository.name,
    path: path.replace(/^\/+/, ""),
    ref: mission.repository.ref,
  };
  return [
    `Use the configured MCP server ${serverName}.`,
    `Call ${toolName} exactly once with this JSON object: ${JSON.stringify(argumentsValue)}.`,
    "Use the MCP response as the only source of repository contents; do not use the host filesystem or canned data.",
    "Report the returned file facts and stop after the read.",
  ].join(" ");
}

function buildLockedFixtureInspectionInstruction(
  mission: Mission,
  serverName: string,
): string {
  if (mission.repository === undefined || !isLockedFixtureRepository(mission.repository)) {
    throw new TrueForgeIntegrationError(
      "inspect repository",
      "The locked fixture inspection requires the pinned repository target.",
    );
  }
  return [
    `Use the configured MCP server ${serverName}.`,
    `Use get_commit with this exact JSON object: ${JSON.stringify(lockedFixtureArguments())}.`,
    `The returned commit must include the exact patches for ${LOCKED_FIXTURE_FILES.join(" and ")}.`,
    "Ignore any non-canonical read-only attempts; only a correlated response to the exact arguments above is valid provenance.",
    "Use the MCP response as the only source of repository facts; do not use the host filesystem, canned data, or final-answer narration.",
    "Stop after the read.",
  ].join(" ");
}

function buildSandboxVerificationInstruction(
  mission: Mission,
  command: string,
  toolName: string,
  intent: string,
): string {
  const argumentsValue = { intent, command };
  return [
    `Use the configured sandbox for mission ${mission.id}.`,
    `Call the sandbox tool ${toolName} exactly once with this JSON object: ${JSON.stringify(argumentsValue)}.`,
    "Do not run the command on the host, do not use a different execution tool, and do not fabricate the result.",
    "Return the structured sandbox response after the command completes.",
  ].join(" ");
}

function buildSandboxVerificationIntent(): string {
  return SANDBOX_VERIFICATION_INTENT;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function verificationFailure(operation: string, message: string): never {
  throw new TrueForgeIntegrationError(operation, message);
}

function inspectionFailure(message: string): never {
  return verificationFailure("inspect repository", message);
}

function sandboxFailure(message: string): never {
  return verificationFailure("run sandbox verification", message);
}

interface TurnCompletion {
  status: string | null;
  requiredActions: unknown[] | null;
}

function turnCompletion(event: TrueForgeApi.TurnStreamingEvent): TurnCompletion {
  const state = recordValue(event).state;
  if (!isRecord(state)) {
    return { status: null, requiredActions: null };
  }
  const rawRequiredActions = state.requiredActions ?? state.required_actions;
  return {
    status: stringOrNull(state.status),
    requiredActions: Array.isArray(rawRequiredActions) ? rawRequiredActions : null,
  };
}

function requireCompletedTurn(
  events: TrueForgeApi.TurnStreamingEvent[],
  operation: string,
  subject: string,
): void {
  const doneEvents = events.filter((event) => event.type === "turn.done");
  const done = doneEvents[doneEvents.length - 1];
  if (done === undefined) {
    return verificationFailure(operation, `TrueForge did not record a completed ${subject} turn.`);
  }
  const completion = turnCompletion(done);
  if (completion.status !== "done") {
    return verificationFailure(operation, `TrueForge ${subject} turn did not finish successfully.`);
  }
  if (completion.requiredActions === null) {
    return verificationFailure(operation, `TrueForge ${subject} turn did not include required actions.`);
  }
  if (completion.requiredActions.length > 0) {
    return verificationFailure(operation, `TrueForge ${subject} paused with required actions.`);
  }
}

function observedToolCalls(
  events: TrueForgeApi.TurnStreamingEvent[],
): Array<{ id: string; name: string; arguments: unknown }> {
  interface MutableToolCall {
    id: string;
    name: string;
    argumentText: string;
    argumentValue?: unknown;
  }

  const callsById = new Map<string, MutableToolCall>();
  const callIdsByIndex = new Map<number, string>();
  for (const event of events) {
    if (event.type !== "model.message" && event.type !== "model.message.delta") {
      continue;
    }
    const record = recordValue(event);
    if (!Array.isArray(record.toolCalls)) {
      continue;
    }
    for (const rawCall of record.toolCalls) {
      if (!isRecord(rawCall)) {
        continue;
      }
      const functionValue = isRecord(rawCall.function) ? rawCall.function : rawCall;
      const index = typeof rawCall.index === "number" ? rawCall.index : null;
      const explicitId = stringOrNull(rawCall.id);
      if (explicitId !== null && index !== null) {
        callIdsByIndex.set(index, explicitId);
      }
      const id = explicitId ?? (index === null ? null : callIdsByIndex.get(index) ?? null);
      if (id === null) {
        continue;
      }
      const existing = callsById.get(id);
      const name = stringOrNull(functionValue.name) ?? existing?.name ?? null;
      if (name === null) {
        continue;
      }
      const call = existing ?? { id, name, argumentText: "" };
      call.name = name;
      const rawArguments = functionValue.arguments ?? rawCall.arguments;
      if (typeof rawArguments === "string") {
        call.argumentText = event.type === "model.message.delta"
          ? `${call.argumentText}${rawArguments}`
          : rawArguments;
      } else if (rawArguments !== undefined) {
        call.argumentValue = rawArguments;
      }
      callsById.set(id, call);
    }
  }
  return [...callsById.values()].map((call) => ({
    id: call.id,
    name: call.name,
    arguments: call.argumentValue !== undefined
      ? call.argumentValue
      : parseMaybeJson(call.argumentText.length === 0 ? {} : call.argumentText),
  }));
}

function expectedRepositoryArguments(
  repository: NonNullable<Mission["repository"]>,
  path: string,
): Record<string, string> {
  return {
    owner: repository.owner,
    repo: repository.name,
    path: path.replace(/^\/+/, ""),
    ref: repository.ref,
  };
}

function isLockedFixtureRepository(
  repository: NonNullable<Mission["repository"]>,
): boolean {
  return (
    repository.owner === LOCKED_FIXTURE_OWNER &&
    repository.name === LOCKED_FIXTURE_REPO &&
    (repository.ref === LOCKED_FIXTURE_SHA || repository.ref === `sha/${LOCKED_FIXTURE_SHA}`)
  );
}

function lockedFixtureArguments(): Record<string, string> {
  return {
    owner: LOCKED_FIXTURE_OWNER,
    repo: LOCKED_FIXTURE_REPO,
    sha: LOCKED_FIXTURE_SHA,
    detail: "full_patch",
  };
}

function verifyRepositoryInspection(
  events: TrueForgeApi.TurnStreamingEvent[],
  repository: NonNullable<Mission["repository"]>,
  path: string,
  serverName: string,
  toolName: string,
): VerifiedRepositoryFile {
  const initialization = events.find((event) => event.type === "mcp.initialize");
  if (initialization === undefined) {
    return inspectionFailure("TrueForge did not record MCP initialization.");
  }
  const initializedServers = recordValue(initialization).mcpServers;
  if (
    !Array.isArray(initializedServers) ||
    !initializedServers.some(
      (server) => isRecord(server) && server.name === serverName,
    )
  ) {
    return inspectionFailure(`MCP server ${serverName} was not initialized.`);
  }

  const calls = observedToolCalls(events).filter((call) => call.name === toolName);
  if (calls.length !== 1) {
    return inspectionFailure(
      `Expected exactly one ${toolName} MCP call, found ${calls.length}.`,
    );
  }
  const call = calls[0];
  if (call === undefined || !isRecord(call.arguments)) {
    return inspectionFailure(`${toolName} MCP arguments were not a JSON object.`);
  }
  const actualArguments = call.arguments;
  const expectedArguments = expectedRepositoryArguments(repository, path);
  const actualKeys = Object.keys(actualArguments).sort();
  const expectedKeys = Object.keys(expectedArguments).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    Object.entries(expectedArguments).some(
      ([key, expected]) => actualArguments[key] !== expected,
    )
  ) {
    return inspectionFailure(`${toolName} MCP arguments did not match the repository target.`);
  }

  const response = events.find(
    (event) =>
      event.type === "tool.response" &&
      recordValue(event).toolCallId === call.id,
  );
  if (response === undefined) {
    return inspectionFailure(`${toolName} MCP call has no structured response.`);
  }
  const responseContent = recordValue(response).content;
  const responseValue = parseMaybeJson(responseContent);
  if (!isRecord(responseValue)) {
    return inspectionFailure(`${toolName} MCP response was not a JSON object.`);
  }
  if (responseValue.isError === true) {
    return inspectionFailure(`${toolName} MCP returned an error result.`);
  }
  const content = responseValue.content;
  if (!Array.isArray(content)) {
    return inspectionFailure(`${toolName} MCP returned no structured content.`);
  }
  const resourcePart = content.find(
    (part) => isRecord(part) && part.type === "resource" && isRecord(part.resource),
  );
  if (!isRecord(resourcePart) || !isRecord(resourcePart.resource)) {
    return inspectionFailure(`${toolName} MCP did not return a structured file resource.`);
  }
  const resource = resourcePart.resource;
  const resourceUri = stringOrNull(resource.uri);
  const fileContent = resource.text;
  if (resourceUri === null || typeof fileContent !== "string") {
    return inspectionFailure(`${toolName} MCP file resource was missing URI or text.`);
  }
  if (!matchesRepositoryFileUri(resourceUri, repository, path)) {
    return inspectionFailure(`${toolName} MCP returned an unexpected repository path.`);
  }

  requireCompletedTurn(events, "inspect repository", "inspection");
  return {
    resourceUri,
    content: fileContent,
    contentHash: shortHash(fileContent),
  };
}

function verifyLockedFixtureInspection(
  events: TrueForgeApi.TurnStreamingEvent[],
  repository: NonNullable<Mission["repository"]>,
  serverName: string,
): VerifiedRepositoryCommit {
  const initialization = events.find((event) => event.type === "mcp.initialize");
  if (initialization === undefined) {
    return inspectionFailure("TrueForge did not record MCP initialization.");
  }
  const initializedServers = recordValue(initialization).mcpServers;
  if (
    !Array.isArray(initializedServers) ||
    !initializedServers.some((server) => isRecord(server) && server.name === serverName)
  ) {
    return inspectionFailure(`MCP server ${serverName} was not initialized.`);
  }

  const canonicalArguments = lockedFixtureArguments();
  const canonicalCalls = observedToolCalls(events).filter(
    (call) => call.name === "get_commit" && isRecord(call.arguments) &&
      argumentsExactlyMatch(call.arguments, canonicalArguments),
  );
  if (canonicalCalls.length !== 1) {
    return inspectionFailure(
      `Expected exactly one canonical get_commit MCP call, found ${canonicalCalls.length}.`,
    );
  }
  const call = canonicalCalls[0];
  if (call === undefined || !isRecord(call.arguments)) {
    return inspectionFailure("get_commit MCP arguments were not a JSON object.");
  }

  const response = events.find(
    (event) =>
      event.type === "tool.response" &&
      recordValue(event).toolCallId === call.id,
  );
  if (response === undefined) {
    return inspectionFailure("get_commit MCP call has no structured response.");
  }
  const responseValue = parseMaybeJson(recordValue(response).content);
  if (!isRecord(responseValue)) {
    return inspectionFailure("get_commit MCP response was not a JSON object.");
  }
  if (responseValue.isError === true) {
    return inspectionFailure("get_commit MCP returned an error result.");
  }
  const verifiedPayload = parseLockedFixtureObject(responseValue);
  if (verifiedPayload === null) {
    return inspectionFailure(
      "get_commit MCP response did not contain the pinned SHA and expected file patches.",
    );
  }

  requireCompletedTurn(events, "inspect repository", "inspection");
  const content = JSON.stringify({
    sha: verifiedPayload.commitSha,
    files: LOCKED_FIXTURE_FILES.map((filename) => ({
      filename,
      patch: verifiedPayload.patches[filename],
    })),
  });
  return {
    resourceUri: `repo://${repository.owner}/${repository.name}/${repositoryResourceRef(LOCKED_FIXTURE_SHA)}`,
    content,
    contentHash: shortHash(content),
    commitSha: verifiedPayload.commitSha,
    patches: verifiedPayload.patches,
  };
}

function argumentsExactlyMatch(
  actual: Record<string, unknown>,
  expected: Record<string, string>,
): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    Object.entries(expected).every(([key, value]) => actual[key] === value)
  );
}

function parseLockedFixtureObject(
  value: Record<string, unknown>,
): { commitSha: string; patches: Readonly<Record<string, string>> } | null {
  const commitSha = stringOrNull(value.sha);
  const files = commitFileEntries(value.files);
  if (commitSha === null || files === null) {
    return null;
  }
  const patches: Record<string, string> = {};
  for (const filename of LOCKED_FIXTURE_FILES) {
    const matchingFiles = files.filter((file) => file.filename === filename);
    if (matchingFiles.length !== 1) {
      return null;
    }
    const patch = matchingFiles[0]?.patch;
    if (typeof patch !== "string" || normalizeCommitPatch(patch) !== LOCKED_FIXTURE_PATCHES[filename]) {
      return null;
    }
    patches[filename] = normalizeCommitPatch(patch);
  }
  if (commitSha !== LOCKED_FIXTURE_SHA) {
    return null;
  }
  return { commitSha, patches };
}

interface CommitFileEntry {
  filename: string;
  patch: unknown;
}

function commitFileEntries(value: unknown): CommitFileEntry[] | null {
  if (Array.isArray(value)) {
    return value.flatMap((file) => {
      if (!isRecord(file)) {
        return [];
      }
      const filename = stringOrNull(file.filename) ?? stringOrNull(file.path);
      return filename === null ? [] : [{ filename, patch: file.patch }];
    });
  }
  if (!isRecord(value)) {
    return null;
  }
  return Object.entries(value).map(([filename, file]) => ({
    filename,
    patch: isRecord(file) ? file.patch : file,
  }));
}

function normalizeCommitPatch(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\n+$/g, "");
  const hunkStart = normalized.indexOf("@@");
  return hunkStart === -1 ? normalized : normalized.slice(hunkStart);
}

function verifySandboxExecution(
  events: TrueForgeApi.TurnStreamingEvent[],
  intent: string,
  command: string,
  toolName: string,
): VerifiedSandboxExecution {
  if (toolName !== "exec") {
    return sandboxFailure("Sandbox verification requires the canonical TrueForge exec tool.");
  }
  const sandboxCreated = events.find((event) => event.type === "sandbox.created");
  if (sandboxCreated === undefined) {
    return sandboxFailure("TrueForge did not record sandbox creation.");
  }
  const expectedArguments = { intent, command };
  const canonicalCalls = observedToolCalls(events).filter(
    (call) => call.name === toolName && isRecord(call.arguments) &&
      argumentsExactlyMatch(call.arguments, expectedArguments),
  );
  if (canonicalCalls.length !== 1) {
    return sandboxFailure(
      `Expected exactly one canonical ${toolName} sandbox call, found ${canonicalCalls.length}.`,
    );
  }
  const call = canonicalCalls[0];
  if (call === undefined || !isRecord(call.arguments)) {
    return sandboxFailure(`${toolName} sandbox arguments were not a JSON object.`);
  }
  const response = events.find(
    (event) =>
      event.type === "tool.response" &&
      recordValue(event).toolCallId === call.id,
  );
  if (response === undefined) {
    return sandboxFailure(`${toolName} sandbox call has no structured response.`);
  }
  const responseValue = parseMaybeJson(recordValue(response).content);
  if (!isRecord(responseValue)) {
    return sandboxFailure(`${toolName} sandbox response was not a JSON object.`);
  }
  if (responseValue.success !== true) {
    return sandboxFailure(`${toolName} sandbox execution did not return success: true.`);
  }
  const sandboxResponse = responseValue.response;
  if (!isRecord(sandboxResponse)) {
    return sandboxFailure(`${toolName} sandbox response did not include a response object.`);
  }
  const exitCode = sandboxResponse.exitCode;
  if (typeof exitCode !== "number" || !Number.isFinite(exitCode)) {
    return sandboxFailure(`${toolName} sandbox response returned a non-numeric exit code.`);
  }
  const stdout = sandboxResponse.result;
  if (typeof stdout !== "string") {
    return sandboxFailure(`${toolName} sandbox response did not include string output.`);
  }
  if (exitCode !== 0) {
    return sandboxFailure(`${toolName} sandbox command exited with code ${exitCode}.`);
  }
  requireCompletedTurn(events, "run sandbox verification", "sandbox");
  return {
    exitCode,
    stdout,
    outputSummary: summarizeOutput(stdout),
  };
}

function summarizeOutput(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 4_000
    ? normalized
    : `${normalized.slice(0, 3_997)}...`;
}

function matchesRepositoryFileUri(
  uri: string,
  repository: NonNullable<Mission["repository"]>,
  path: string,
): boolean {
  const resourceRef = repositoryResourceRef(repository.ref);
  const expected =
    `repo://${repository.owner}/${repository.name}/${resourceRef}/contents/${path.replace(/^\/+/, "")}`;
  try {
    return decodeURIComponent(uri) === expected;
  } catch {
    return false;
  }
}

function repositoryResourceRef(ref: string): string {
  const normalizedRef = ref.replace(/^\/+/, "");
  if (normalizedRef.startsWith("refs/") || normalizedRef.startsWith("sha/")) {
    return normalizedRef;
  }
  return /^[0-9a-f]{40}$/i.test(normalizedRef)
    ? `sha/${normalizedRef}`
    : `refs/heads/${normalizedRef}`;
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) as number;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function* streamEvents(
  stream: TrueForgeEventStream,
): AsyncGenerator<TrueForgeApi.TurnStreamingEvent> {
  if (stream.withMetadata !== undefined) {
    for await (const envelope of stream.withMetadata()) {
      yield envelope.data;
    }
    return;
  }
  for await (const event of stream) {
    yield event;
  }
}

function recordValue(event: TrueForgeApi.TurnStreamingEvent): Record<string, unknown> {
  return event as unknown as Record<string, unknown>;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function summarizeRuntimeEvent(event: TrueForgeApi.TurnStreamingEvent): TrueForgeRuntimeEvent {
  const record = recordValue(event);
  return {
    id: stringOrNull(record.id),
    type: event.type,
    createdAt: stringOrNull(record.createdAt),
    threadId: stringOrNull(record.threadId),
    turnId: stringOrNull(record.turnId),
  };
}

function runtimeDetails(event: TrueForgeApi.TurnStreamingEvent): string {
  const summary = summarizeRuntimeEvent(event);
  const record = recordValue(event);
  const details: Record<string, unknown> = {
    event_id: summary.id,
    event_type: summary.type,
    created_at: summary.createdAt,
    thread_id: summary.threadId,
    turn_id: summary.turnId,
  };
  if (event.type === "turn.done" || event.type === "thread.done") {
    const state = record.state;
    if (state !== null && typeof state === "object" && !Array.isArray(state)) {
      details.status = stringOrNull((state as Record<string, unknown>).status);
    }
  }
  if (event.type === "model.message") {
    details.tool_call_count = Array.isArray(record.toolCalls) ? record.toolCalls.length : 0;
  }
  if (event.type === "mcp.initialize") {
    details.server_count = Array.isArray(record.mcpServers) ? record.mcpServers.length : 0;
  }
  if (event.type === "tool.response" || event.type === "tool.response_required") {
    details.tool_call_id = stringOrNull(record.toolCallId);
  }
  return JSON.stringify(details);
}

function runtimeEvidence(event: TrueForgeApi.TurnStreamingEvent): RuntimeEvidence | null {
  const details = runtimeDetails(event);
  switch (event.type) {
    case "turn.created":
      return {
        kind: "tool_result",
        result: "informational",
        summary: `TrueForge turn ${event.turnId} started.`,
        details,
      };
    case "turn.done": {
      const state = recordValue(event).state;
      const status = isRecord(state) ? stringOrNull(state.status) ?? "unknown" : "unknown";
      const rawRequiredActions = isRecord(state)
        ? state.requiredActions ?? state.required_actions
        : undefined;
      const requiredActions = Array.isArray(rawRequiredActions) ? rawRequiredActions : null;
      const isComplete = status === "done" && requiredActions !== null && requiredActions.length === 0;
      const summary = requiredActions === null
        ? `TrueForge turn finished with status ${status}; required actions were not provided.`
        : requiredActions.length === 0
        ? `TrueForge turn finished with status ${status}.`
        : `TrueForge turn finished with status ${status} and ${requiredActions.length} required action${requiredActions.length === 1 ? "" : "s"}.`;
      return {
        kind: "tool_result",
        result: isComplete ? "passed" : "failed",
        summary,
        details,
      };
    }
    case "mcp.initialize":
      return {
        kind: "tool_result",
        result: "informational",
        summary: "TrueForge initialized the configured MCP servers.",
        details,
      };
    case "mcp.auth_required":
      return {
        kind: "reviewer_finding",
        result: "failed",
        summary: "TrueForge paused because MCP authentication is required.",
        details,
      };
    case "sandbox.created":
      return {
        kind: "sandbox_log",
        result: "informational",
        summary: "TrueForge created a sandbox for the turn.",
        details,
      };
    case "tool.approval_required":
      return {
        kind: "reviewer_finding",
        result: "informational",
        summary: "TrueForge paused for tool approval.",
        details,
      };
    case "tool.response_required":
      return {
        kind: "tool_result",
        result: "informational",
        summary: "TrueForge is waiting for a tool response.",
        details,
      };
    case "tool.response":
      return {
        kind: "tool_result",
        result: "informational",
        summary: "TrueForge received a tool response.",
        details,
      };
    case "model.message": {
      const toolCallCount = Array.isArray(recordValue(event).toolCalls)
        ? (recordValue(event).toolCalls as unknown[]).length
        : 0;
      if (toolCallCount === 0) {
        return null;
      }
      return {
        kind: "tool_result",
        result: "informational",
        summary: `TrueForge emitted ${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"}.`,
        details,
      };
    }
    case "thread.created":
      return {
        kind: "tool_result",
        result: "informational",
        summary: "TrueForge created an execution thread.",
        details,
      };
    case "thread.done": {
      const status = stringOrNull(recordValue(event).state &&
        (recordValue(event).state as Record<string, unknown>).status) ?? "unknown";
      return {
        kind: "tool_result",
        result: status === "done" ? "passed" : "failed",
        summary: `TrueForge thread finished with status ${status}.`,
        details,
      };
    }
    default:
      return null;
  }
}
