import { lstat } from "node:fs/promises";
import {
  basename,
  dirname,
  relative,
  resolve,
} from "node:path";

import {
  InMemoryMissionRepository,
  MissionService,
} from "./domain.js";
import type { MissionState } from "./domain.js";
import { JsonMissionRepository } from "./persistence.js";
import {
  buildPreflightWorkGraph,
  resolveDeterministicCoordinatorModelPolicy,
} from "./trueforge.js";
import { PRIMARY_DELIVERY_FIXTURE } from "./fixture.js";
import {
  PRIMARY_MISSION_ID,
  PRIMARY_MISSION_OBJECTIVE,
  PRIMARY_REPOSITORY,
} from "./http/server.js";
import {
  MissionRuntimeConfig,
  resolveMissionRuntimeConfig,
} from "./http/config.js";

export const DEMO_PREFLIGHT_VERSION = 1 as const;
export const DEMO_PREFLIGHT_TIMEOUT_MS = 5_000;
export const DEMO_PREFLIGHT_MAX_READ_CALLS = 8;

export const DEMO_PREFLIGHT_REQUIRED_MCP_TOOLS = [
  "get_file_contents",
  "get_commit",
  "create_pull_request",
  "pull_request_read",
  "search_pull_requests",
] as const;

export interface DemoPreflightConfig {
  baseUrl: string;
  model: string;
  githubServer: string;
  statePath: string;
  daytonaApiKeyConfigured: boolean;
  fixture: typeof PRIMARY_DELIVERY_FIXTURE;
}

export interface DemoPreflightTrueForgeAdapter {
  getCapabilities(): Promise<unknown>;
  listModels(): Promise<unknown>;
  listConfiguredMcpServers(): Promise<unknown>;
  listMcpTools(serverName: string): Promise<unknown>;
  getSandboxProvider(): Promise<unknown>;
}

export interface DemoPreflightGitHubAdapter {
  getCommit(input: {
    owner: string;
    repository: string;
    sha: string;
  }): Promise<unknown>;
  getDeliveryBranch(input: {
    owner: string;
    repository: string;
    branch: string;
  }): Promise<unknown>;
  listDeliveryPullRequests(input: {
    owner: string;
    repository: string;
    base: string;
    head: string;
  }): Promise<unknown>;
}

export interface DemoPreflightAdapters {
  trueforge: DemoPreflightTrueForgeAdapter;
  github: DemoPreflightGitHubAdapter;
}

export interface DemoPreflightCheck {
  id: string;
  status: "passed" | "failed";
  summary: string;
  mutating: false;
}

export interface DemoPreflightReport {
  version: typeof DEMO_PREFLIGHT_VERSION;
  mode: "bounded-read-only";
  ok: boolean;
  config: {
    baseUrl: string;
    model: string;
    githubServer: string;
    statePath: string;
    daytonaApiKeyConfigured: boolean;
    fixture: typeof PRIMARY_DELIVERY_FIXTURE;
  };
  checks: DemoPreflightCheck[];
  externalMutations: 0;
  maxReadCalls: typeof DEMO_PREFLIGHT_MAX_READ_CALLS;
  manualQueueRunRequired: true;
}

export interface DemoPreflightOptions {
  config: DemoPreflightConfig;
  adapters?: DemoPreflightAdapters;
  fixture?: typeof PRIMARY_DELIVERY_FIXTURE;
  timeoutMs?: number;
}

export interface ResetDemoStateOptions {
  statePath: string;
  rootDirectory?: string;
  clock?: () => Date;
}

export interface ResetDemoStateResult {
  statePath: string;
  state: MissionState;
}

const LOCKED_DEMO_FIXTURE = PRIMARY_DELIVERY_FIXTURE;

/**
 * Resolve the runtime values used by the manual demo preflight and reject a
 * state path outside the repository's dedicated local state directory.
 */
export function resolveDemoPreflightConfig(
  environment: Record<string, string | undefined>,
  rootDirectory = process.cwd(),
): DemoPreflightConfig {
  const runtime: MissionRuntimeConfig = resolveMissionRuntimeConfig(environment);
  return {
    baseUrl: runtime.baseUrl,
    model: runtime.model,
    githubServer: runtime.githubServer,
    statePath: resolveDemoStatePath(runtime.statePath, rootDirectory),
    daytonaApiKeyConfigured: (environment.DAYTONA_API_KEY?.trim().length ?? 0) > 0,
    fixture: LOCKED_DEMO_FIXTURE,
  };
}

/**
 * The reset intentionally accepts only .trueforge/mission-state.json below
 * the supplied root. Tests may supply an isolated temporary root; the CLI
 * supplies the repository root.
 */
export function resolveDemoStatePath(statePath: string, rootDirectory: string): string {
  if (statePath.trim().length === 0) {
    throw new Error("The demo state path must not be empty.");
  }
  const root = resolve(rootDirectory);
  const candidate = resolve(root, statePath);
  const expectedDirectory = resolve(root, ".trueforge");
  if (
    basename(candidate) !== "mission-state.json" ||
    relative(expectedDirectory, dirname(candidate)) !== ""
  ) {
    throw new Error(
      "The demo reset only permits .trueforge/mission-state.json below the repository root.",
    );
  }
  return candidate;
}

/**
 * Rebuild the primary mission and its visible queue root in memory, then
 * replace only the guarded local state file. No provider, session, sandbox,
 * connector, or remote repository operation is involved.
 */
export async function resetDemoState(
  options: ResetDemoStateOptions,
): Promise<ResetDemoStateResult> {
  const rootDirectory = options.rootDirectory ?? process.cwd();
  const statePath = resolveDemoStatePath(options.statePath, rootDirectory);
  await rejectSymlink(statePath, "the demo state file");
  await rejectSymlink(dirname(statePath), "the demo state directory");

  const memoryRepository = new InMemoryMissionRepository();
  const missions = options.clock === undefined
    ? new MissionService(memoryRepository)
    : new MissionService(memoryRepository, options.clock);
  const mission = await missions.createMission({
    id: PRIMARY_MISSION_ID,
    objective: PRIMARY_MISSION_OBJECTIVE,
    repository: PRIMARY_REPOSITORY,
  });
  const graph = buildPreflightWorkGraph(mission);
  const created = await missions.persistWorkGraph(PRIMARY_MISSION_ID, graph);
  for (const item of created) {
    if (item.status === "ready") {
      await missions.transitionWorkItem(PRIMARY_MISSION_ID, item.id, "backlog");
    }
  }

  const state = await missions.getState();
  const stateRepository = new JsonMissionRepository(statePath);
  await stateRepository.save(state);
  return { statePath, state };
}

export async function runDemoPreflight(
  options: DemoPreflightOptions,
): Promise<DemoPreflightReport> {
  const fixture = options.fixture ?? LOCKED_DEMO_FIXTURE;
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const checks: DemoPreflightCheck[] = [];

  checks.push(await checked(
    "local-state-path",
    "The reset target is the guarded .trueforge/mission-state.json file.",
    async () => {
      const resolved = resolve(options.config.statePath);
      if (basename(resolved) !== "mission-state.json" || basename(dirname(resolved)) !== ".trueforge") {
        throw new Error("the configured state path is outside the dedicated local state directory");
      }
      await rejectSymlink(resolved, "the demo state file");
      await rejectSymlink(dirname(resolved), "the demo state directory");
      return `reset target ${resolved}`;
    },
    timeoutMs,
  ));

  checks.push(localCheck(
    "local-node-runtime",
    "The Node.js runtime meets the demo's pinned engine requirement.",
    () => {
      const [major, minor] = process.versions.node.split(".").map(Number);
      if (
        major === undefined ||
        minor === undefined ||
        Number.isNaN(major) ||
        Number.isNaN(minor) ||
        major < 22 ||
        (major === 22 && minor < 14)
      ) {
        throw new Error(`Node.js ${process.versions.node} is below the required 22.14 runtime`);
      }
      return `Node.js ${process.versions.node}`;
    },
  ));

  checks.push(localCheck(
    "local-model-policy",
    "The selected model has an exact deterministic coordinator policy.",
    () => {
      const policy = resolveDeterministicCoordinatorModelPolicy(options.config.model);
      return `validated ${policy.provider}/${policy.model}`;
    },
  ));

  checks.push(localCheck(
    "local-fixture-lock",
    "The demo fixture, pinned baseline, and delivery target match the reviewed contract.",
    () => {
      assertExactFixture(fixture);
      return `${fixture.owner}/${fixture.repository}@${fixture.baselineSha}; delivery branch ${fixture.head}`;
    },
  ));

  checks.push(localCheck(
    "local-daytona-credential",
    "The direct Daytona proof adapter has its server-side credential configured.",
    () => {
      if (!options.config.daytonaApiKeyConfigured) {
        throw new Error("DAYTONA_API_KEY is not configured for direct deterministic proof");
      }
      return "DAYTONA_API_KEY is configured without exposing its value";
    },
  ));

  const adapters = options.adapters;
  if (adapters === undefined) {
    checks.push(...missingAdapterChecks());
    return finishPreflight(options.config, fixture, checks);
  }

  const mcpServerCheck = await checked(
    "trueforge-mcp-server",
    "The configured GitHub MCP server is present and authorized.",
    async () => {
      const payload = unwrap(await adapters.trueforge.listConfiguredMcpServers());
      const servers = arrayPayload(payload, "configured MCP servers");
      const configured = servers.find((server) => readString(server.name) === options.config.githubServer);
      if (configured === undefined) {
        throw new Error(`configured MCP server ${options.config.githubServer} was not found`);
      }
      const status = readString(
        recordValue(configured.authStatus)?.status ??
          recordValue(configured.auth_status)?.status,
      );
      if (status !== "authenticated" && status !== "not_required") {
        throw new Error(`MCP server ${options.config.githubServer} is not authorized`);
      }
      return `${options.config.githubServer} is ${status}`;
    },
    timeoutMs,
  );
  checks.push(mcpServerCheck);

  const independentChecks = await Promise.all([
    checked(
      "trueforge-reachable",
      "TrueForge responds to its read-only capabilities endpoint.",
      async () => {
        const payload = unwrap(await adapters.trueforge.getCapabilities());
        if (!isRecord(payload) || !["sandbox", "settings", "skill"].every((key) => key in payload)) {
          throw new Error("capabilities response was incomplete");
        }
        return "capabilities endpoint responded";
      },
      timeoutMs,
    ),
    checked(
      "trueforge-model",
      `TrueForge exposes the configured model ${options.config.model}.`,
      async () => {
        const models = arrayPayload(unwrap(await adapters.trueforge.listModels()), "configured models");
        if (!models.some((model) => readString(model.name) === options.config.model)) {
          throw new Error(`configured model ${options.config.model} was not found`);
        }
        return `configured model ${options.config.model} is available`;
      },
      timeoutMs,
    ),
    checked(
      "trueforge-daytona",
      "TrueForge reports a ready Daytona sandbox provider.",
      async () => {
        const payload = unwrap(await adapters.trueforge.getSandboxProvider());
        if (!isRecord(payload)) {
          throw new Error("sandbox provider response was incomplete");
        }
        const providerType = readString(recordValue(payload.manifest)?.type);
        const status = readString(payload.status);
        if (providerType?.toLowerCase() !== "daytona") {
          throw new Error(`sandbox provider is ${providerType ?? "unknown"}, not Daytona`);
        }
        if (status !== "ready") {
          throw new Error(`Daytona sandbox provider is ${status ?? "not ready"}`);
        }
        return "Daytona provider is ready";
      },
      timeoutMs,
    ),
    checked(
      "github-baseline",
      "The exact fixture repository resolves the pinned baseline commit.",
      async () => {
        const payload = unwrap(await adapters.github.getCommit({
          owner: fixture.owner,
          repository: fixture.repository,
          sha: fixture.baselineSha,
        }));
        const commit = normalizeCommit(payload);
        if (
          commit.owner !== fixture.owner ||
          commit.repository !== fixture.repository ||
          commit.sha.toLowerCase() !== fixture.baselineSha.toLowerCase()
        ) {
          throw new Error(
            `resolved ${commit.owner ?? "unknown"}/${commit.repository ?? "unknown"}@${commit.sha}, expected ${fixture.owner}/${fixture.repository}@${fixture.baselineSha}`,
          );
        }
        return `resolved ${fixture.owner}/${fixture.repository}@${fixture.baselineSha}`;
      },
      timeoutMs,
    ),
    checked(
      "delivery-branch-clean",
      "No stale owned delivery branch exists on the fixture repository.",
      async () => {
        const payload = unwrap(await adapters.github.getDeliveryBranch({
          owner: fixture.owner,
          repository: fixture.repository,
          branch: fixture.head,
        }));
        if (!isRecord(payload) || typeof payload.exists !== "boolean") {
          throw new Error("branch inspection did not return an explicit exists flag");
        }
        if (payload.exists) {
          throw new Error(`stale owned delivery branch ${fixture.head} exists`);
        }
        return `delivery branch ${fixture.head} is absent`;
      },
      timeoutMs,
    ),
    checked(
      "delivery-pr-clean",
      "No stale owned delivery pull request targets the fixture branch.",
      async () => {
        const payload = unwrap(await adapters.github.listDeliveryPullRequests({
          owner: fixture.owner,
          repository: fixture.repository,
          base: fixture.base,
          head: fixture.head,
        }));
        const pullRequests = pullRequestPayload(payload);
        const stale = pullRequests.filter((pullRequest) =>
          isOpenPullRequest(pullRequest) && matchesOwnedDeliveryPullRequest(pullRequest, fixture),
        );
        if (stale.length > 0) {
          const labels = stale
            .map((pullRequest) => readString(pullRequest.html_url) ?? readString(pullRequest.url) ?? "unidentified PR")
            .join(", ");
          throw new Error(`stale owned delivery pull request found: ${labels}`);
        }
        return `no ${fixture.owner}:${fixture.head} pull request targets ${fixture.base}`;
      },
      timeoutMs,
    ),
  ]);
  checks.push(...independentChecks);

  if (mcpServerCheck.status === "passed") {
    checks.push(await checked(
      "trueforge-mcp-tools",
      "The GitHub MCP server exposes every read and delivery tool needed by the demo.",
      async () => {
        const payload = unwrap(await adapters.trueforge.listMcpTools(options.config.githubServer));
        const tools = arrayPayload(payload, "MCP tools");
        const names = new Set(tools
          .map((tool) => readString(tool.name) ?? readString(recordValue(tool.function)?.name))
          .filter((name): name is string => name !== undefined));
        const missing = DEMO_PREFLIGHT_REQUIRED_MCP_TOOLS.filter((name) => !names.has(name));
        if (missing.length > 0) {
          throw new Error(`missing MCP tools: ${missing.join(", ")}`);
        }
        return `available tools: ${DEMO_PREFLIGHT_REQUIRED_MCP_TOOLS.join(", ")}`;
      },
      timeoutMs,
    ));
  } else {
    checks.push(failedCheck(
      "trueforge-mcp-tools",
      "The GitHub MCP tool surface was not queried because server authorization failed.",
    ));
  }

  return finishPreflight(options.config, fixture, checks);
}

function finishPreflight(
  config: DemoPreflightConfig,
  fixture: typeof PRIMARY_DELIVERY_FIXTURE,
  checks: DemoPreflightCheck[],
): DemoPreflightReport {
  return {
    version: DEMO_PREFLIGHT_VERSION,
    mode: "bounded-read-only",
    ok: checks.every((check) => check.status === "passed"),
    config: {
      baseUrl: config.baseUrl,
      model: config.model,
      githubServer: config.githubServer,
      statePath: config.statePath,
      daytonaApiKeyConfigured: config.daytonaApiKeyConfigured,
      fixture,
    },
    checks,
    externalMutations: 0,
    maxReadCalls: DEMO_PREFLIGHT_MAX_READ_CALLS,
    manualQueueRunRequired: true,
  };
}

function missingAdapterChecks(): DemoPreflightCheck[] {
  return [
    "trueforge-mcp-server",
    "trueforge-reachable",
    "trueforge-model",
    "trueforge-daytona",
    "github-baseline",
    "delivery-branch-clean",
    "delivery-pr-clean",
    "trueforge-mcp-tools",
  ].map((id) => failedCheck(id, "No external read-only preflight adapter was supplied."));
}

function localCheck(
  id: string,
  _description: string,
  operation: () => string,
): DemoPreflightCheck {
  try {
    return passedCheck(id, operation());
  } catch (error) {
    return failedCheck(id, safeErrorMessage(error));
  }
}

async function checked(
  id: string,
  _description: string,
  operation: () => Promise<string>,
  timeoutMs: number,
): Promise<DemoPreflightCheck> {
  try {
    return passedCheck(id, await withTimeout(operation(), timeoutMs, id));
  } catch (error) {
    return failedCheck(id, safeErrorMessage(error));
  }
}

function passedCheck(id: string, summary: string): DemoPreflightCheck {
  return { id, status: "passed", summary, mutating: false };
}

function failedCheck(id: string, summary: string): DemoPreflightCheck {
  return { id, status: "failed", summary, mutating: false };
}

function normalizeTimeout(value: number | undefined): number {
  return Number.isInteger(value) && value !== undefined && value > 0
    ? value
    : DEMO_PREFLIGHT_TIMEOUT_MS;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${operation} exceeded the ${timeoutMs}ms read-only timeout`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function assertExactFixture(fixture: typeof PRIMARY_DELIVERY_FIXTURE): void {
  const expectedKeys = Object.keys(LOCKED_DEMO_FIXTURE).sort();
  const actualKeys = Object.keys(fixture).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    fixture.owner !== LOCKED_DEMO_FIXTURE.owner ||
    fixture.repository !== LOCKED_DEMO_FIXTURE.repository ||
    fixture.baselineRef !== LOCKED_DEMO_FIXTURE.baselineRef ||
    fixture.baselineSha !== LOCKED_DEMO_FIXTURE.baselineSha ||
    fixture.base !== LOCKED_DEMO_FIXTURE.base ||
    fixture.head !== LOCKED_DEMO_FIXTURE.head
  ) {
    throw new Error(
      `fixture lock mismatch; expected ${LOCKED_DEMO_FIXTURE.owner}/${LOCKED_DEMO_FIXTURE.repository}@${LOCKED_DEMO_FIXTURE.baselineSha} with delivery branch ${LOCKED_DEMO_FIXTURE.head}`,
    );
  }
}

function unwrap(value: unknown): unknown {
  let current = value;
  for (let index = 0; index < 4; index += 1) {
    if (!isRecord(current) || !("data" in current)) {
      return current;
    }
    current = current.data;
  }
  return current;
}

function arrayPayload(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new Error(`${label} response was not a bounded object list`);
  }
  return value as Record<string, unknown>[];
}

function pullRequestPayload(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return arrayPayload(value, "pull requests");
  }
  if (isRecord(value)) {
    const items = value.items ?? value.pull_requests ?? value.pullRequests;
    if (Array.isArray(items)) {
      return arrayPayload(items, "pull requests");
    }
  }
  throw new Error("pull request inspection did not return a bounded list");
}

function normalizeCommit(value: unknown): {
  owner: string | undefined;
  repository: string | undefined;
  sha: string;
} {
  if (!isRecord(value)) {
    throw new Error("baseline inspection did not return a commit object");
  }
  const repository = recordValue(value.repository) ?? recordValue(value.repo);
  const fullName = readString(repository?.full_name) ?? readString(repository?.fullName);
  const urlIdentity = [
    repositoryIdentityFromCommitUrl(value.url),
    repositoryIdentityFromCommitUrl(value.html_url),
    repositoryIdentityFromCommitUrl(recordValue(value.commit)?.url),
  ].find((identity): identity is { owner: string; repository: string } => identity !== undefined);
  const fullNameParts = fullName?.split("/") ?? [];
  const owner = readString(value.owner) ??
    readString(recordValue(repository?.owner)?.login) ??
    readString(recordValue(repository?.owner)?.name) ??
    (fullNameParts.length === 2 ? fullNameParts[0] : undefined) ??
    urlIdentity?.owner;
  const name = readString(value.repositoryName) ??
    readString(value.repoName) ??
    readString(repository?.name) ??
    (fullNameParts.length === 2 ? fullNameParts[1] : undefined) ??
    urlIdentity?.repository;
  const sha = readString(value.sha) ??
    readString(value.commitSha) ??
    readString(value.commit_sha) ??
    readString(recordValue(value.commit)?.sha);
  if (sha === undefined) {
    throw new Error("baseline inspection did not return a commit SHA");
  }
  return { owner, repository: name, sha };
}

function repositoryIdentityFromCommitUrl(value: unknown): {
  owner: string;
  repository: string;
} | undefined {
  const rawUrl = readString(value);
  if (rawUrl === undefined) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return undefined;
  }

  let segments: string[];
  try {
    segments = parsed.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }

  const repositoriesIndex = segments.findIndex((segment) => segment === "repos");
  const repositoryOwner = segments[repositoriesIndex + 1];
  const repositoryName = segments[repositoriesIndex + 2];
  if (repositoryOwner !== undefined && repositoryName !== undefined) {
    return {
      owner: repositoryOwner,
      repository: repositoryName,
    };
  }

  const commitIndex = segments.findIndex((segment) => segment === "commit");
  const commitOwner = segments[commitIndex - 2];
  const commitRepository = segments[commitIndex - 1];
  if (commitOwner !== undefined && commitRepository !== undefined) {
    return {
      owner: commitOwner,
      repository: commitRepository,
    };
  }
  return undefined;
}

function isOpenPullRequest(pullRequest: Record<string, unknown>): boolean {
  const state = readString(pullRequest.state)?.toLowerCase();
  if (state !== undefined) {
    return state === "open";
  }

  const closedAt = pullRequest.closed_at ?? pullRequest.closedAt;
  if (closedAt !== undefined && closedAt !== null) {
    return false;
  }
  const mergedAt = pullRequest.merged_at ?? pullRequest.mergedAt;
  return mergedAt === undefined || mergedAt === null;
}

function matchesOwnedDeliveryPullRequest(
  pullRequest: Record<string, unknown>,
  fixture: typeof PRIMARY_DELIVERY_FIXTURE,
): boolean {
  const head = recordValue(pullRequest.head);
  const base = recordValue(pullRequest.base);
  const headRef = readString(head?.ref) ?? readString(pullRequest.headRef);
  const baseRef = readString(base?.ref) ?? readString(pullRequest.baseRef);
  if (headRef === undefined || baseRef === undefined) {
    throw new Error("pull request inspection returned an incomplete head/base ref");
  }
  if (headRef !== fixture.head || baseRef !== fixture.base) {
    return false;
  }

  const expectedFullName = `${fixture.owner}/${fixture.repository}`;
  const headRepository = recordValue(head?.repo);
  const fullName = readString(headRepository?.full_name) ??
    readString(headRepository?.fullName) ??
    readString(head?.repository);
  const headOwner = readString(recordValue(head?.user)?.login) ??
    readString(head?.owner) ??
    readString(pullRequest.headOwner);
  const label = readString(head?.label) ?? readString(pullRequest.headLabel);
  if (fullName !== undefined && fullName !== expectedFullName) {
    return false;
  }
  if (headOwner !== undefined && headOwner !== fixture.owner) {
    return false;
  }
  if (label !== undefined && label !== `${fixture.owner}:${fixture.head}`) {
    return false;
  }
  return true;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(token|api[_-]?key|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

async function rejectSymlink(filePath: string, label: string): Promise<void> {
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`The demo reset refuses to follow a symbolic link for ${label}.`);
    }
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}
