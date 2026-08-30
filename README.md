# TrueForge Proof Board

TrueForge Agent Harness Hackathon submission for verified autonomous software delivery.

TrueForge Proof Board is a small foundation for making autonomous software work understandable and trustworthy. The product thesis is:

**Plan → Execute → Prove → Approve**

- **Plan** the objective and the bounded work needed to deliver it.
- **Execute** through TrueForge with explicit ownership and controlled tools.
- **Prove** progress with concrete, inspectable evidence rather than agent claims alone.
- **Approve** consequential delivery actions with a human in control.

The application exposes that flow through a compact Mission Control screen backed by durable mission state. Runtime activity remains separate from verified repository and sandbox evidence, so agent narration cannot be mistaken for proof.

## Development

Requires Node.js 22.14 or newer.

```sh
npm install
npm run check
```

`npm run check` type-checks the source, builds it into `dist/`, and runs the Node test suite.

## Mission Control UI

Start the local Mission Control server with:

```sh
npm start
```

The `prestart` lifecycle step builds `dist/` first, so this works from a clean checkout without generated output. The unauthenticated UI binds only to loopback, and state-changing browser requests must be same-origin. Then open `http://127.0.0.1:8787`. The UI starts with human mission intake, persists the submitted objective, and recovers the planned queue from `.trueforge/mission-state.json`. Creating tickets performs only read-only planning; execution and delivery remain behind their existing human gates. Provider and connector credentials remain server-side and are never included in browser payloads. The optional direct proof adapter also keeps its Daytona key server-only.

The demo model defaults to `alibaba/qwen3-8-max`. The supported selectors are
`alibaba/qwen3-8-max`, `alibaba/qwen3-7-flash`, `openai/gpt-5-4-mini`, and
`openai/gpt-5-6-luna`; change only `TRUEFORGE_MODEL` to switch between them.
Model credentials remain in TrueForge.

Use `TRUEFORGE_UI_HOST`, `TRUEFORGE_UI_PORT`, or `TRUEFORGE_MISSION_STATE` to override the local listener or durable state path. Automated HTTP tests inject isolated adapters and temporary state, so they never contact live providers.

## TrueForge smoke path

The reproducible TrueForge + GitHub MCP + Daytona validation path is documented in
[`docs/trueforge-smoke.md`](docs/trueforge-smoke.md). After configuring the local
TrueForge server, run the harmless local validation with:

```sh
npm run smoke:trueforge -- --dry-run
```

Run the live, opt-in smoke only when the external provider, GitHub MCP connector,
and Daytona sandbox are configured:

```sh
npm run smoke:trueforge
```

## Deterministic demo controls

The live queue demo has a local reset and a bounded, read-only preflight. The
full operator sequence—including the two non-mutating rehearsal runs and one
explicitly approved PR-producing rehearsal—is in
[`docs/demo-runbook.md`](docs/demo-runbook.md).

Reset only the guarded local mission state:

```sh
npm run demo:reset
```

Preview the preflight topology without contacting providers, then run the
actual read-only checks manually after external setup:

```sh
npm run demo:preflight -- --dry-run
npm run demo:preflight
```

The actual preflight checks TrueForge capabilities/model settings, GitHub MCP
configuration and tools, Daytona readiness, the exact pinned fixture baseline,
and stale owned delivery branch/pull-request state; it also checks the
server-only `DAYTONA_API_KEY` by making one authenticated, read-only lookup
through the same official Daytona SDK boundary used by deterministic proof.
GitHub API reads are pinned to `https://api.github.com` for the fixed public
fixture, and TrueForge metadata reads disable SDK retries so the nine-call
preflight budget is real. It does not create a session, sandbox, branch, pull
request, or other remote mutation.
Automated tests remain provider-free; real queue runs are intentionally manual.

## Repository safety

Local credentials, environment files, MCP configuration, dependencies, and generated output are ignored by default. Do not commit secrets or machine-specific configuration.

## Mission runtime integration

The exported mission runtime uses the official TrueForge SDK for session creation,
turn execution, and reconnects. Create a `JsonMissionRepository` for the mission
state file and pass it to `MissionService` and `TrueForgeMissionRunner`. A mission
repository target is inspected with `inspectRepository`, which accepts a result only
when the configured MCP server made the exact file request and returned a matching
structured resource. Failed or incomplete MCP evidence blocks the mission; it is
never replaced with canned repository content. `runSandboxVerification` applies the
same proof boundary to the canonical sandbox `exec` tool, recording the exact
command, exit code, and bounded output summary. Implementation proof runs its
authoritative measurements through the official Daytona SDK, retrieving the
exact persisted sandbox ID; it never asks a model to select or invoke a proof
command. Set the server-only `DAYTONA_API_KEY` (and optionally
`DAYTONA_API_URL`) when running the HTTP app. Without that executor,
implementation proof fails closed and records the missing integration. The
deterministic primary fixture runs its checks from the provisioned project directory.

Before delegated coding starts, the primary mission runs a separate sandbox
readiness turn. That turn prepares or verifies Node.js 20+ and npm; on the known
Debian 12 sandbox it installs the NodeSource 22.x package rather than Debian's
Node.js 18 package, then records a specific readiness failure before delegation
if the sandbox still cannot provide them.
Coding turns use a bounded default of 64 TrueForge iterations; callers can provide
a lower limit through `TrueForgeMissionConfig.iterationLimit` when their mission
needs a tighter budget.

Delegated implementation work is review-gated by a structured handoff. It records
changed files, a bounded diff summary, each required check and its observed result,
decisions, open questions, evidence IDs, and the correlated TrueForge session,
turn, thread, and tool origin. Each implementer also carries an explicit,
repository-relative allowed-file scope. Before delegated coding, the coordinator
captures a tool-backed temporary-index tree for both the mission baseline and the
work-item start state; after the child returns, it captures an unfiltered
name-status delta from those refs. This covers committed, staged, unstaged, and
untracked changes, while separating the current work-item delta from cumulative
mission changes in a reused sandbox. The coordinator compares the current delta
against the allowed files and the child’s exit-preserving, content-bearing diff,
then compares the cumulative delta against the union of authorized mission
scopes. Narrated file claims, masked shell wrappers, missing tool results, and
out-of-scope diffs are recorded as failed implementation evidence and block the
work item. Missing, failed, contradictory, or uncorrelated evidence cannot be
promoted to review; earlier durable evidence remains available for diagnosis.

Review-ready delegated work is evaluated by an independent verifier before it can
become complete. The verifier records the changed-state snapshot, structured
handoff, correlated checks, and a durable finding. It can accept the work, request
changes back to an executable state, or block it; every prior handoff and proof
record remains available across those outcomes.

For the deterministic delivery fixture, `inspectRepository` first proves the
immutable `mtamburrano/proofboard-demo-fixture` baseline at commit
`acdbbde12203edeee099313a4636ff8c25a83e24`. After implementation, deterministic
sandbox proof and accepted semantic review bind approval to the exact current
artifact: its baseline, two files, contents, and patches. No delivery-branch
read or remote mutation occurs before the human gate. After approval, the
artifact is published through the protected `push_files` MCP call, independently
read back with `get_commit`, and only then used for `create_pull_request` and its
`pull_request_read` verification. Ordinary repository reads remain fail-closed
for other targets.

Configure the TrueForge model, GitHub MCP connector, and sandbox provider in the
local TrueForge UI as described in [`docs/trueforge-smoke.md`](docs/trueforge-smoke.md).
Only the server-side SDK client and direct Daytona adapter receive connection
credentials; mission persistence stores session, turn, and sandbox identifiers,
not tokens or provider secrets.
