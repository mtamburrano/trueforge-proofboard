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

Then open `http://127.0.0.1:8787`. The UI creates or recovers the primary mission from `.trueforge/mission-state.json`. Creating and running the mission uses the configured local TrueForge server; provider and connector credentials remain in that server and are never included in browser payloads.

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
command, exit code, and bounded output summary.

For the deterministic public fixture (`mtamburrano/trueforge-proofboard` at commit
`590aa8a6d72c580f61fc1b19d33e9876bc0feb9b`), `inspectRepository` uses the GitHub MCP
`get_commit` tool with `detail: "full_patch"` and accepts evidence only when the
returned commit contains the expected `src/index.ts` and `test/index.test.js`
patches. The regular `get_file_contents` resource contract remains fail-closed for
other repository targets.

Configure the TrueForge model, GitHub MCP connector, and sandbox provider in the
local TrueForge UI as described in [`docs/trueforge-smoke.md`](docs/trueforge-smoke.md).
Only the SDK client receives connection credentials; mission persistence stores
session and turn identifiers, not tokens or provider secrets.
