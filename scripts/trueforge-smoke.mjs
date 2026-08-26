import { pathToFileURL } from "node:url";

export const DEFAULTS = Object.freeze({
  baseUrl: "http://localhost:8790",
  model: "google-gemini/gemini-3.6-flash",
  githubServer: "github",
  githubOwner: "mtamburrano",
  githubRepo: "trueforge-proofboard",
  githubRef: "main",
  githubPath: "package.json",
  command: "printf 'TRUEFORGE_DAYTONA_OK\\n'",
});

const EXPECTED_MARKER = "TRUEFORGE_DAYTONA_OK";

export function configFromEnvironment() {
  return {
    baseUrl: process.env.TRUEFORGE_BASE_URL || DEFAULTS.baseUrl,
    model: process.env.TRUEFORGE_MODEL || DEFAULTS.model,
    githubServer: process.env.TRUEFORGE_GITHUB_SERVER || DEFAULTS.githubServer,
    githubOwner: process.env.TRUEFORGE_GITHUB_OWNER || DEFAULTS.githubOwner,
    githubRepo: process.env.TRUEFORGE_GITHUB_REPO || DEFAULTS.githubRepo,
    githubRef: process.env.TRUEFORGE_GITHUB_REF || DEFAULTS.githubRef,
    githubPath: process.env.TRUEFORGE_GITHUB_PATH || DEFAULTS.githubPath,
    command: DEFAULTS.command,
  };
}

export function githubArguments(config) {
  return {
    owner: config.githubOwner,
    repo: config.githubRepo,
    path: config.githubPath,
    ref: config.githubRef,
  };
}

export function agentSpec(config) {
  const repositoryRequest = JSON.stringify(githubArguments(config));

  return {
    model: { name: config.model },
    instructions: [
      "Run a deterministic infrastructure smoke test and do not claim success from narration alone.",
      `Use the attached GitHub MCP server to call get_file_contents exactly once with ${repositoryRequest}.`,
      "Wait for and retain the structured MCP result.",
      `Then use the configured Daytona-backed sandbox exec tool named exec to execute exactly: ${config.command}`,
      "Do not execute the command on the host and do not access credentials.",
      "Finish only after both tool calls return.",
    ].join(" "),
    mcp_servers: [
      {
        name: config.githubServer,
        enable_tools: ["get_file_contents"],
        preload_tools: ["get_file_contents"],
      },
    ],
    config: {
      sandbox: { enabled: true },
      dynamic_sub_agents: { enabled: false },
      ask_user_questions: { enabled: false },
      generative_ui: { enabled: false },
      iteration_limit: 12,
    },
  };
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedToolArguments(call) {
  return parseMaybeJson(call?.function?.arguments ?? call?.arguments ?? {});
}

function toolCalls(events) {
  return events
    .filter((event) => event.type === "model.message")
    .flatMap((event) =>
      (event.toolCalls ?? event.tool_calls ?? []).map((call) => ({
        eventId: event.id,
        threadId: event.threadId ?? event.thread_id ?? null,
        id: call.id,
        name: call.function?.name ?? call.name ?? "",
        arguments: normalizedToolArguments(call),
      })),
    );
}

function toolResponseFor(events, call) {
  return events.find(
    (event) =>
      event.type === "tool.response" &&
      (event.toolCallId ?? event.tool_call_id) === call.id,
  );
}

function shortHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function requireEvent(condition, message) {
  if (!condition) throw new Error(message);
}

function parseToolResponseContent(toolResponse, label) {
  requireEvent(
    typeof toolResponse?.content === "string",
    `${label} response content was not a JSON string.`,
  );
  const result = parseMaybeJson(toolResponse.content);
  requireEvent(isRecord(result), `${label} response content was not a JSON object.`);
  return result;
}

function requireExactGithubArguments(argumentsValue, config) {
  requireEvent(
    isRecord(argumentsValue),
    "The get_file_contents MCP call arguments were not a JSON object.",
  );

  for (const [key, expected] of Object.entries(githubArguments(config))) {
    requireEvent(
      Object.prototype.hasOwnProperty.call(argumentsValue, key) && argumentsValue[key] === expected,
      `The get_file_contents MCP argument ${key} did not exactly match the configured value.`,
    );
  }
}

function matchesRepositoryFileUri(uri, config) {
  const prefix = `repo://${config.githubOwner}/${config.githubRepo}/`;
  const expectedPath = config.githubPath.replace(/^\/+/, "");

  try {
    const decodedUri = decodeURIComponent(uri);
    return decodedUri.startsWith(prefix) && decodedUri.endsWith(`/contents/${expectedPath}`);
  } catch {
    return false;
  }
}

function parseGithubFileResult(toolResponse, config) {
  const result = parseToolResponseContent(toolResponse, "GitHub MCP");
  requireEvent(result.isError !== true, "GitHub MCP returned an error result.");
  requireEvent(
    Array.isArray(result.content) && result.content.length > 0,
    "GitHub MCP returned no structured content.",
  );

  const resourcePart = result.content.find(
    (part) => isRecord(part) && part.type === "resource",
  );
  requireEvent(
    resourcePart && isRecord(resourcePart.resource),
    "GitHub MCP did not return a structured file resource.",
  );

  const resource = resourcePart.resource;
  requireEvent(
    typeof resource.uri === "string" && matchesRepositoryFileUri(resource.uri, config),
    "GitHub MCP returned a resource for an unexpected repository path.",
  );
  requireEvent(
    typeof resource.text === "string",
    "GitHub MCP file resource did not contain text content.",
  );

  return { result, resource };
}

function parseSandboxExecResult(toolResponse) {
  const result = parseToolResponseContent(toolResponse, "Daytona sandbox");
  requireEvent(
    result.success === true,
    "Daytona sandbox execution did not return success: true.",
  );
  requireEvent(
    isRecord(result.response),
    "Daytona sandbox execution did not return a response object.",
  );

  const response = result.response;
  requireEvent(
    typeof response.exitCode === "number" && Number.isFinite(response.exitCode),
    "Daytona sandbox execution returned a non-numeric exitCode.",
  );
  requireEvent(
    response.exitCode === 0,
    `Daytona exit code was ${response.exitCode}, not 0.`,
  );
  requireEvent(
    typeof response.result === "string",
    "Daytona sandbox execution did not return a string response.result.",
  );
  requireEvent(
    response.result.includes(EXPECTED_MARKER),
    "Daytona stdout did not contain the smoke marker in response.result.",
  );

  return { result, response };
}

function responseSummary(content) {
  const { resource } = content;
  const metadata = { uri: resource.uri };
  const mimeType = resource.mimeType ?? resource.mime_type;
  if (typeof mimeType === "string") metadata.mime_type = mimeType;

  return {
    metadata,
    content_bytes: resource.text.length,
    content_hash: shortHash(resource.text),
  };
}

export async function readConfiguredSandboxProvider(client) {
  let response;
  try {
    response = await client.settings.sandboxProviders.get();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read TrueForge sandbox provider settings: ${message}`);
  }

  const payload = response.data?.data ?? response.data;
  const manifest = payload?.manifest;
  const providerType = manifest?.type;
  requireEvent(
    typeof providerType === "string",
    "TrueForge sandbox provider settings did not return a provider type.",
  );
  requireEvent(
    providerType.toLowerCase() === "daytona",
    `TrueForge is configured with sandbox provider ${providerType}, not Daytona.`,
  );

  return {
    type: providerType,
    status: payload.status ?? null,
    status_reason: payload.statusReason ?? payload.status_reason ?? null,
    source: "settings.sandboxProviders.get",
  };
}

export function collectEvidence(events, config, sessionId, turnId, sandboxProvider) {
  const done = [...events].reverse().find((event) => event.type === "turn.done");
  requireEvent(done, "TrueForge did not return a turn.done event.");
  requireEvent(
    done.state?.status === "done",
    `TrueForge smoke paused or failed with status ${done.state?.status ?? "unknown"}.`,
  );
  requireEvent(
    (done.state?.requiredActions ?? done.state?.required_actions ?? []).length === 0,
    "TrueForge smoke returned pending actions; complete MCP auth or approval setup first.",
  );

  const mcpInitialization = events.find((event) => event.type === "mcp.initialize");
  requireEvent(mcpInitialization, "No mcp.initialize event was recorded.");

  const calls = toolCalls(events);
  const githubCalls = calls.filter((call) => call.name === "get_file_contents");
  requireEvent(githubCalls.length === 1, `Expected one get_file_contents MCP call, found ${githubCalls.length}.`);
  const githubCall = githubCalls[0];
  requireEvent(githubCall, "No structured get_file_contents MCP tool call was recorded.");

  const githubResponse = toolResponseFor(events, githubCall);
  requireEvent(githubResponse, "The get_file_contents MCP call has no structured tool response.");
  requireExactGithubArguments(githubCall.arguments, config);
  const githubResult = parseGithubFileResult(githubResponse, config);

  const sandboxCreated = events.find((event) => event.type === "sandbox.created");
  requireEvent(sandboxCreated, "No sandbox.created event was recorded; Daytona was not proven.");

  const sandboxCalls = calls.filter(
    (call) => call.id !== githubCall.id && call.name === "exec",
  );
  requireEvent(sandboxCalls.length === 1, `Expected one Daytona exec call, found ${sandboxCalls.length}.`);
  const sandboxCall = sandboxCalls[0];
  requireEvent(
    isRecord(sandboxCall.arguments) && sandboxCall.arguments.command === config.command,
    "The Daytona exec command did not exactly match the configured command.",
  );

  const sandboxResponse = toolResponseFor(events, sandboxCall);
  requireEvent(sandboxResponse, "The sandbox command has no structured tool response.");
  const sandboxResult = parseSandboxExecResult(sandboxResponse);

  const initializedServers = mcpInitialization.mcpServers ?? mcpInitialization.mcp_servers ?? [];

  return {
    evidence_version: 1,
    trueforge: {
      base_url: config.baseUrl,
      model: config.model,
      session_id: sessionId,
      turn_id: turnId,
    },
    mcp: {
      configured_server: config.githubServer,
      initialized_servers: initializedServers,
      tool_call: {
        event_id: githubCall.eventId,
        tool_call_id: githubCall.id,
        name: githubCall.name,
        arguments: githubCall.arguments,
      },
      tool_response: {
        event_id: githubResponse.id,
        tool_call_id: githubResponse.toolCallId ?? githubResponse.tool_call_id,
        ...responseSummary(githubResult),
      },
    },
    sandbox: {
      provider: sandboxProvider,
      provider_evidence: "sandbox.created",
      sandbox_id: sandboxCreated.sandboxId ?? sandboxCreated.sandbox_id,
      creation_event_id: sandboxCreated.id,
      tool_call: {
        event_id: sandboxCall.eventId,
        tool_call_id: sandboxCall.id,
        name: sandboxCall.name,
        arguments: sandboxCall.arguments,
      },
      tool_response: {
        event_id: sandboxResponse.id,
        tool_call_id: sandboxResponse.toolCallId ?? sandboxResponse.tool_call_id,
        success: sandboxResult.result.success,
        stdout: sandboxResult.response.result,
        exit_code: sandboxResult.response.exitCode,
      },
    },
  };
}

function printDryRun(config) {
  console.log(
    JSON.stringify(
      {
        mode: "dry-run",
        trueforge: { base_url: config.baseUrl, model: config.model },
        mcp: {
          server: config.githubServer,
          tool: "get_file_contents",
          arguments: githubArguments(config),
        },
        sandbox: {
          configured_provider: "daytona (checked from TrueForge settings during live run)",
          command: config.command,
          expected_stdout: EXPECTED_MARKER,
          expected_exit_code: 0,
        },
        external_calls: false,
      },
      null,
      2,
    ),
  );
}

function printUsage() {
  console.log("Usage: npm run smoke:trueforge [-- --dry-run]");
  console.log("Set up TrueForge first; see docs/trueforge-smoke.md.");
}

export async function run() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help")) {
    printUsage();
    return;
  }

  const config = configFromEnvironment();
  if (args.has("--dry-run")) {
    printDryRun(config);
    return;
  }

  const { TrueForge } = await import("@truefoundry/trueforge-sdk");
  const client = new TrueForge({
    baseUrl: config.baseUrl,
    timeoutInSeconds: 600,
    ...(process.env.TRUEFORGE_TOKEN ? { token: process.env.TRUEFORGE_TOKEN } : {}),
  });

  const sandboxProvider = await readConfiguredSandboxProvider(client);
  const { data: session } = await client.sessions.create({ agent: { spec: agentSpec(config) } });
  const stream = await client.sessions.createTurnStream(session.id, {
    input: [{ type: "user.message", content: "Run the configured TrueForge smoke test now." }],
  });

  let turnId;
  for await (const { data: event } of stream.withMetadata()) {
    if (event.type === "turn.created") turnId = event.turnId ?? event.turn_id;
    if (event.type === "mcp.auth_required") {
      throw new Error("GitHub MCP authentication is required; authorize the connector in TrueForge first.");
    }
  }

  requireEvent(turnId, "TrueForge did not return a turn id.");

  const events = [];
  for await (const event of await client.sessions.listTurnEvents(session.id, turnId)) {
    events.push(event);
  }

  console.log(JSON.stringify(collectEvidence(events, config, session.id, turnId, sandboxProvider), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(`TrueForge smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
