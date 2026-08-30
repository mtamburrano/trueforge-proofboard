import { randomUUID } from "node:crypto";

import { Daytona } from "@daytona/sdk";

import type {
  SandboxCommandExecutionRequest,
  SandboxCommandExecutor,
} from "./trueforge.js";

export const DAYTONA_SANDBOX_REFERENCE_PREFIX = "v1:daytona:";
export const DEFAULT_DAYTONA_COMMAND_TIMEOUT_SECONDS = 600;
const DEFAULT_DAYTONA_REQUEST_TIMEOUT_BUFFER_SECONDS = 30;
const MAX_DAYTONA_RESULT_LENGTH = 2_000_000;

export type DaytonaSandboxFailureCategory =
  | "configuration"
  | "authentication"
  | "network"
  | "transport"
  | "identity";

export interface DaytonaSandboxProcess {
  executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeout?: number,
  ): Promise<{ exitCode: number; result: string }>;
}

export interface DaytonaSandboxClient {
  get(sandboxIdOrName: string): Promise<{
    id: string;
    process: DaytonaSandboxProcess;
  }>;
}

export interface DaytonaReadinessClient {
  get(sandboxIdOrName: string): Promise<unknown>;
}

export interface DaytonaReadinessProbeOptions {
  /** Required when a Daytona client is not injected for an isolated test. */
  apiKey?: string;
  apiUrl?: string;
  requestTimeoutMs?: number;
  /** Injectable supported-client surface used by tests; production uses Daytona. */
  daytona?: DaytonaReadinessClient;
}

export interface DaytonaReadinessProbe {
  checkReadiness(): Promise<string>;
}

export interface DaytonaSandboxExecutorOptions {
  /** Required when a Daytona client is not injected for an isolated test. */
  apiKey?: string;
  apiUrl?: string;
  commandTimeoutSeconds?: number;
  requestTimeoutMs?: number;
  /** Injectable supported-client surface used by tests; production uses Daytona. */
  daytona?: DaytonaSandboxClient;
}

/**
 * A provider-boundary failure is retryable by the Proof Board. It must never
 * be interpreted as a request to launch another implementation turn.
 */
export class DaytonaSandboxExecutionError extends Error {
  readonly retryable = true as const;
  readonly failureClass = "infrastructure" as const;
  readonly failureCategory: DaytonaSandboxFailureCategory;

  constructor(message: string, failureCategory: DaytonaSandboxFailureCategory) {
    super(message);
    this.name = "DaytonaSandboxExecutionError";
    this.failureCategory = failureCategory;
  }
}

/**
 * Validate the direct Daytona credential and endpoint without creating a
 * sandbox or executing a command. The random lookup intentionally expects a
 * 404; a valid API key must reach the authenticated resource boundary first.
 */
export function createDaytonaReadinessProbe(
  options: DaytonaReadinessProbeOptions,
): DaytonaReadinessProbe {
  const requestTimeoutMs = positiveInteger(
    options.requestTimeoutMs ?? 5_000,
    "Daytona readiness request timeout",
  );
  let daytona = options.daytona;

  return {
    async checkReadiness() {
      if (daytona === undefined) {
        const clientOptions: DaytonaSandboxExecutorOptions = {
          ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
          ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
        };
        daytona = createDaytonaClient(
          clientOptions,
          requestTimeoutMs,
          true,
        );
      }

      const probeId = `trueforge-proofboard-preflight-${randomUUID()}`;
      try {
        await daytona.get(probeId);
      } catch (error) {
        if (isDaytonaNotFoundError(error)) {
          return "Daytona API authenticated and reachable; the read-only probe target is absent";
        }
        const reason = error instanceof Error
          ? sanitizeDaytonaError(error.message)
          : "provider request failed";
        throw new Error(`Daytona readiness probe failed: ${reason}`);
      }
      return "Daytona API accepted an authenticated read-only sandbox lookup";
    },
  };
}

/**
 * Resolve the persisted Proof Board reference to the raw provider ID used by
 * Daytona's supported SDK. Resolution is deliberately pure: it never creates,
 * starts, forks, or substitutes a sandbox.
 */
export function resolveDaytonaSandboxId(reference: string): string {
  const normalized = requiredTrimmedText(reference, "Daytona sandbox reference");
  if (!normalized.startsWith("v1:")) {
    return normalized;
  }
  if (!normalized.startsWith(DAYTONA_SANDBOX_REFERENCE_PREFIX)) {
    throw new DaytonaSandboxExecutionError(
      "The persisted sandbox reference uses an unsupported provider namespace.",
      "identity",
    );
  }
  const rawId = normalized.slice(DAYTONA_SANDBOX_REFERENCE_PREFIX.length);
  if (rawId.length === 0) {
    throw new DaytonaSandboxExecutionError(
      "The persisted Daytona sandbox reference does not include a provider id.",
      "identity",
    );
  }
  return rawId;
}

/**
 * Execute deterministic proof commands through the official Daytona SDK.
 * The adapter retrieves only the exact persisted sandbox and returns the
 * persisted reference so downstream proof evidence keeps stable identity.
 */
export function createDaytonaSandboxExecutor(
  options: DaytonaSandboxExecutorOptions,
): SandboxCommandExecutor {
  const commandTimeoutSeconds = positiveInteger(
    options.commandTimeoutSeconds ?? DEFAULT_DAYTONA_COMMAND_TIMEOUT_SECONDS,
    "Daytona command timeout",
  );
  const requestTimeoutMs = positiveInteger(
    options.requestTimeoutMs ??
      (commandTimeoutSeconds + DEFAULT_DAYTONA_REQUEST_TIMEOUT_BUFFER_SECONDS) * 1_000,
    "Daytona request timeout",
  );
  const daytona = options.daytona ?? createDaytonaClient(options, requestTimeoutMs);

  return {
    async execute(request: SandboxCommandExecutionRequest) {
      const persistedReference = requiredTrimmedText(
        request.sandboxId,
        "Daytona sandbox reference",
      );
      const rawId = resolveDaytonaSandboxId(persistedReference);
      const command = requiredValue(request.command, "Daytona sandbox command");
      const timeoutSeconds = positiveInteger(
        request.timeoutSeconds ?? commandTimeoutSeconds,
        "Daytona command timeout",
      );

      let sandbox: Awaited<ReturnType<DaytonaSandboxClient["get"]>>;
      try {
        sandbox = await daytona.get(rawId);
      } catch (error) {
        throw daytonaExecutionError(
          "Daytona could not retrieve the persisted sandbox",
          error,
        );
      }
      if (
        !isRecord(sandbox) ||
        typeof sandbox.id !== "string" ||
        sandbox.id !== rawId ||
        !isRecord(sandbox.process) ||
        typeof sandbox.process.executeCommand !== "function"
      ) {
        throw new DaytonaSandboxExecutionError(
          "Daytona returned a sandbox that does not match the persisted provider id.",
          "identity",
        );
      }

      let response: unknown;
      try {
        response = await sandbox.process.executeCommand(
          command,
          request.cwd,
          undefined,
          timeoutSeconds,
        );
      } catch (error) {
        throw daytonaExecutionError(
          "Daytona could not execute the deterministic proof command",
          error,
        );
      }

      if (
        !isRecord(response) ||
        typeof response.exitCode !== "number" ||
        !Number.isInteger(response.exitCode) ||
        typeof response.result !== "string"
      ) {
        throw new DaytonaSandboxExecutionError(
          "Daytona returned an invalid deterministic proof result.",
          "transport",
        );
      }
      if (response.result.length > MAX_DAYTONA_RESULT_LENGTH) {
        throw new DaytonaSandboxExecutionError(
          `Daytona sandbox execution exceeded the ${MAX_DAYTONA_RESULT_LENGTH}-character output bound.`,
          "transport",
        );
      }

      return {
        sandboxId: persistedReference,
        exitCode: response.exitCode,
        stdout: response.result,
      };
    },
  };
}

function createDaytonaClient(
  options: DaytonaSandboxExecutorOptions,
  requestTimeoutMs: number,
  useDeprecatedPolling = false,
): DaytonaSandboxClient {
  const apiKey = requiredTrimmedText(options.apiKey ?? "", "Daytona API key");
  const config: ConstructorParameters<typeof Daytona>[0] = {
    apiKey,
    requestTimeoutMs,
    useDeprecatedPolling,
  };
  if (options.apiUrl !== undefined) {
    config.apiUrl = normalizeDaytonaApiUrl(options.apiUrl);
  }
  return new Daytona(config);
}

function isDaytonaNotFoundError(error: unknown): boolean {
  const record = isRecord(error) ? error : undefined;
  const name = typeof record?.name === "string" ? record.name.toLowerCase() : "";
  const code = typeof record?.code === "string" ? record.code.toLowerCase() : "";
  return record?.statusCode === 404 ||
    name.includes("notfound") ||
    name.includes("not_found") ||
    code === "not_found" ||
    code === "not-found";
}

function normalizeDaytonaApiUrl(value: string): string {
  const raw = requiredTrimmedText(value, "Daytona API URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Daytona API URL must be a valid URL.");
  }
  if (url.username || url.password || url.protocol !== "https:") {
    throw new Error("Daytona API URL must use HTTPS and must not contain credentials.");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function daytonaExecutionError(prefix: string, error: unknown): DaytonaSandboxExecutionError {
  const category = daytonaFailureCategory(error);
  const reason = error instanceof Error ? sanitizeDaytonaError(error.message) : "provider request failed";
  return new DaytonaSandboxExecutionError(`${prefix}: ${reason}`, category);
}

function daytonaFailureCategory(error: unknown): DaytonaSandboxFailureCategory {
  if (error instanceof DaytonaSandboxExecutionError) {
    return error.failureCategory;
  }
  const record = isRecord(error) ? error : undefined;
  const statusCode = record?.statusCode;
  const name = typeof record?.name === "string" ? record.name : "";
  const code = typeof record?.code === "string" ? record.code : "";
  const text = `${name} ${code} ${error instanceof Error ? error.message : ""}`.toLowerCase();
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    /auth|credential|forbidden|unauthorized/.test(text)
  ) {
    return "authentication";
  }
  if (
    (typeof statusCode === "number" &&
      (statusCode === 408 || statusCode === 429 || statusCode >= 500)) ||
    /connection|network|timeout|timed out|socket|fetch|gateway|service unavailable/.test(text)
  ) {
    return "network";
  }
  return "transport";
}

function requiredValue(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  return value;
}

function requiredTrimmedText(value: string, label: string): string {
  return requiredValue(value, label).trim();
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeDaytonaError(value: string): string {
  return value
    .replace(/authorization\s*[:=]\s*bearer\s+[^\s,;]+/gi, "authorization: Bearer [redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|token|password|secret|credential|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 600);
}
