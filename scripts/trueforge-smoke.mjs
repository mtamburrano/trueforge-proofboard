const DEFAULTS = Object.freeze({
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

function configFromEnvironment() {
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

function githubArguments(config) {
  return {
    owner: config.githubOwner,
    repo: config.githubRepo,
    path: config.githubPath,
    ref: config.githubRef,
  };
}

function agentSpec(config) {
  const repositoryRequest = JSON.stringify(githubArguments(config));

  return {
    model: { name: config.model },
    instructions: [
      "Run a deterministic infrastructure smoke test and do not claim success from narration alone.",
      `Use the attached GitHub MCP server to call get_file_contents exactly once with ${repositoryRequest}.`,
      "Wait for and retain the structured MCP result.",
      `Then use the configured Daytona-backed sandbox shell tool to execute exactly: ${config.command}`,
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

function serialized(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function findNestedValue(value, keys) {
  const parsed = parseMaybeJson(value);

  if (parsed && typeof parsed === "object") {
    for (const key of keys) {
      if (key in parsed) return parseMaybeJson(parsed[key]);
    }

    for (const child of Object.values(parsed)) {
      const found = findNestedValue(child, keys);
      if (found !== undefined) return found;
    }
  }

  return undefined;
}

function textFrom(value) {
  const parsed = parseMaybeJson(value);
  if (typeof parsed === "string") return parsed;
  if (Array.isArray(parsed)) return parsed.map(textFrom).filter(Boolean).join("\n");
  if (parsed && typeof parsed === "object") {
    return Object.values(parsed).map(textFrom).filter(Boolean).join("\n");
  }
  return "";
}

function shortHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function responseSummary(content) {
  const parsed = parseMaybeJson(content);
  const text = textFrom(parsed);
  const metadata = {};

  for (const key of ["name", "path", "sha", "size", "url"]) {
    const value = findNestedValue(parsed, [key]);
    if (value !== undefined && (typeof value === "string" || typeof value === "number")) {
      metadata[key] = value;
    }
  }

  return {
    metadata,
    content_bytes: text.length,
    content_hash: shortHash(text),
  };
}

function requireEvent(condition, message) {
  if (!condition) throw new Error(message);
}

function collectEvidence(events, config) {
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
  const githubCalls = calls.filter((call) => call.name.endsWith("get_file_contents"));
  requireEvent(githubCalls.length === 1, `Expected one get_file_contents MCP call, found ${githubCalls.length}.`);
  const githubCall = githubCalls[0];
  requireEvent(githubCall, "No structured get_file_contents MCP tool call was recorded.");

  const githubResponse = toolResponseFor(events, githubCall);
  requireEvent(githubResponse, "The get_file_contents MCP call has no structured tool response.");

  const githubArgs = githubCall.arguments;
  const githubArgsText = serialized(githubArgs);
  for (const expected of Object.values(githubArguments(config))) {
    requireEvent(
      githubArgsText.includes(String(expected)),
      `The MCP call arguments did not include expected repository value ${expected}.`,
    );
  }

  const sandboxCreated = events.find((event) => event.type === "sandbox.created");
  requireEvent(sandboxCreated, "No sandbox.created event was recorded; Daytona was not proven.");

  const sandboxCall = calls.find(
    (call) =>
      call.id !== githubCall.id &&
      serialized(call.arguments).includes(EXPECTED_MARKER),
  );
  requireEvent(sandboxCall, "No structured sandbox command call contained the smoke marker.");

  const sandboxResponse = toolResponseFor(events, sandboxCall);
  requireEvent(sandboxResponse, "The sandbox command has no structured tool response.");

  const sandboxContent = sandboxResponse.content ?? sandboxResponse.result ?? "";
  const sandboxText = textFrom(sandboxContent);
  const stdout = findNestedValue(sandboxContent, ["stdout", "standardOutput"]);
  const exitCode = findNestedValue(sandboxContent, ["exit_code", "exitCode"]);
  const output = typeof stdout === "string" ? stdout : sandboxText;
  requireEvent(output.includes(EXPECTED_MARKER), "Daytona stdout did not contain the smoke marker.");
  requireEvent(Number(exitCode) === 0, `Daytona exit code was ${exitCode ?? "missing"}, not 0.`);

  const initializedServers = mcpInitialization.mcpServers ?? mcpInitialization.mcp_servers ?? [];

  return {
    evidence_version: 1,
    trueforge: {
      base_url: config.baseUrl,
      model: config.model,
      session_id: sandboxCreated.sessionId ?? sandboxCreated.session_id ?? undefined,
      turn_id: done.turnId ?? done.turn_id ?? undefined,
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
        ...responseSummary(githubResponse.content ?? githubResponse.result ?? ""),
      },
    },
    sandbox: {
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
        stdout: output,
        exit_code: Number(exitCode),
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
        sandbox: { command: config.command, expected_stdout: EXPECTED_MARKER, expected_exit_code: 0 },
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

async function run() {
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

  console.log(JSON.stringify(collectEvidence(events, config), null, 2));
}

run().catch((error) => {
  console.error(`TrueForge smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
