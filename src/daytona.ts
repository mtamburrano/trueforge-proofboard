import type {
  SandboxCommandExecutionRequest,
  SandboxCommandExecutor,
} from "./trueforge.js";

export const DEFAULT_DAYTONA_TOOLBOX_BASE_URL = "https://proxy.app.daytona.io/toolbox";
export const DEFAULT_DAYTONA_COMMAND_TIMEOUT_SECONDS = 600;
const DEFAULT_DAYTONA_REQUEST_TIMEOUT_BUFFER_SECONDS = 30;
const MAX_DAYTONA_RESULT_LENGTH = 2_000_000;

export interface DaytonaSandboxExecutorOptions {
  apiKey: string;
  toolboxBaseUrl?: string;
  commandTimeoutSeconds?: number;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Execute a command through Daytona's sandbox toolbox API without creating a
 * TrueForge turn or allowing a model to choose the target, command, or args.
 */
export function createDaytonaSandboxExecutor(
  options: DaytonaSandboxExecutorOptions,
): SandboxCommandExecutor {
  const apiKey = requiredTrimmedText(options.apiKey, "Daytona API key");
  const toolboxBaseUrl = normalizeToolboxBaseUrl(options.toolboxBaseUrl);
  const commandTimeoutSeconds = positiveInteger(
    options.commandTimeoutSeconds ?? DEFAULT_DAYTONA_COMMAND_TIMEOUT_SECONDS,
    "Daytona command timeout",
  );
  const requestTimeoutMs = positiveInteger(
    options.requestTimeoutMs ??
      (commandTimeoutSeconds + DEFAULT_DAYTONA_REQUEST_TIMEOUT_BUFFER_SECONDS) * 1_000,
    "Daytona request timeout",
  );
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required for direct Daytona sandbox execution.");
  }

  return {
    async execute(request: SandboxCommandExecutionRequest) {
      const sandboxId = requiredTrimmedText(request.sandboxId, "Daytona sandbox id");
      const command = requiredValue(request.command, "Daytona sandbox command");
      const timeoutSeconds = positiveInteger(
        request.timeoutSeconds ?? commandTimeoutSeconds,
        "Daytona command timeout",
      );
      const body: Record<string, unknown> = {
        command,
        timeout: timeoutSeconds,
      };
      if (request.cwd !== undefined) {
        body.cwd = request.cwd;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      const url = `${toolboxBaseUrl}/${encodeURIComponent(sandboxId)}/process/execute`;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "request failed";
        throw new Error(
          controller.signal.aborted
            ? `Daytona sandbox execution timed out after ${requestTimeoutMs}ms.`
            : `Daytona sandbox execution request failed: ${sanitizeDaytonaError(reason)}`,
        );
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        throw new Error(`Daytona sandbox execution returned HTTP ${response.status}.`);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Daytona sandbox execution returned invalid JSON.");
      }
      const exitCode = isRecord(payload) ? payload.exitCode : undefined;
      const result = isRecord(payload) ? payload.result : undefined;
      if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || typeof result !== "string") {
        throw new Error("Daytona sandbox execution returned an invalid result.");
      }
      if (result.length > MAX_DAYTONA_RESULT_LENGTH) {
        throw new Error(
          `Daytona sandbox execution exceeded the ${MAX_DAYTONA_RESULT_LENGTH}-character output bound.`,
        );
      }
      return {
        sandboxId,
        exitCode,
        stdout: result,
      };
    },
  };
}

function normalizeToolboxBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_DAYTONA_TOOLBOX_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Daytona toolbox base URL must be a valid URL.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new Error("Daytona toolbox base URL must use HTTP(S) without embedded credentials.");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
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
    .replace(/authorization\s*[:=]\s*bearer\s+[^\s,;]+/gi, "[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "[redacted]")
    .slice(0, 600);
}
