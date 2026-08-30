# TrueForge smoke path

This repository keeps the first runtime proof intentionally small: one read-only
GitHub MCP call and one harmless command in a Daytona-backed TrueForge sandbox.
The script verifies TrueForge's structured event log, so a model's final prose
cannot stand in for tool evidence.

## Versioned prerequisites

| Component | Requirement | Why |
| --- | --- | --- |
| Node.js | 22.14 or newer | Required by the current TrueForge local quickstart and this repository's engine constraint. |
| TrueForge server | `@truefoundry/trueforge@0.1.4` | Pinned local server used by this smoke path. |
| TrueForge SDK | `@truefoundry/trueforge-sdk@0.1.3` | Pinned in `package.json` for the event-streaming runner. |
| Model provider | Native provider for one of the four supported selectors | Configure the provider in TrueForge Settings; the API key stays in TrueForge. |
| MCP connector | GitHub MCP with `get_file_contents` and `get_commit` enabled | Read-only repository provenance for file and locked-commit inspections. |
| Sandbox provider | Daytona | Configure the provider in TrueForge Settings; the API key stays in TrueForge. |

TrueForge local mode uses SQLite and listens on `http://localhost:8790` by
default. Keep it on localhost. The server, model, connector, and sandbox
credentials are configured in the TrueForge UI, not in this repository.

Official setup references: [TrueForge quickstart](https://trueforge.dev/quickstart),
[model setup](https://trueforge.dev/models),
[MCP setup](https://trueforge.dev/mcp-servers), and
[sandbox setup](https://trueforge.dev/sandbox).

## One-time external setup

1. Confirm Node.js 22.14+ and start the pinned local server:

   ```sh
   npx @truefoundry/trueforge@0.1.4
   ```

   Open `http://localhost:8790`.

2. In Settings → Models, configure the provider for the selected model. The
   demo supports exactly these `TRUEFORGE_MODEL` values:
   `alibaba/qwen3-8-max`, `alibaba/qwen3-7-flash`, `openai/gpt-5-4-mini`, and
   `openai/gpt-5-6-luna`.

3. In Settings → Connectors, connect the GitHub MCP server and authorize it.
   The smoke runner expects the configured server name `github`; set
   `TRUEFORGE_GITHUB_SERVER` if the UI uses another name. Verify that
   `get_file_contents` and `get_commit` are available. The official GitHub MCP server documents
   both hosted and local Docker-backed configurations; the TrueForge catalog
   path is preferred here because credentials remain in the harness.

4. In Settings → Sandbox providers, configure Daytona and enable it for the
   smoke agent. The provider must be able to create and execute in a sandbox.

5. Install this repository's pinned development dependencies and create a local
   ignored environment file:

   ```sh
   npm ci
   cp .env.example .env
   ```

   Adjust only non-secret selectors in `.env`. Never add provider, GitHub, or
   Daytona keys to the file.

## Run the smoke

First verify the planned topology without contacting the server:

```sh
npm run smoke:trueforge -- --dry-run
```

Then run the live proof:

```sh
npm run smoke:trueforge
```

The runner creates an inline TrueForge session and requests exactly two useful
operations:

1. `get_file_contents` on the configured public repository path.
2. `printf 'TRUEFORGE_DAYTONA_OK\\n'` through the configured sandbox `exec` tool.

The command is harmless and does not mutate the repository or remote GitHub.
TrueForge provisions and manages the Daytona sandbox according to its provider
lifecycle settings. Before creating the session, the runner reads
`settings.sandboxProviders.get()` and fails closed unless the configured provider
manifest reports `type: "daytona"`.

## Evidence and fail-closed checks

On success, stdout is a JSON evidence packet containing:

- the TrueForge base URL, model, session, and turn;
- the configured sandbox provider type/status returned by TrueForge settings;
- the MCP initialization event, structured `get_file_contents` call arguments,
  matching tool-response ID, and the structured repository file resource
  URI/content hash;
- the `sandbox.created` event and sandbox ID;
- the structured `exec` call with its deterministic verification intent and exact
  command, plus the matching `{ success: true, response: { exitCode: 0, result } }`
  response.

The runner exits non-zero if any of those records is missing, if GitHub MCP
authentication is pending, if the repository arguments differ, or if the
Daytona result does not contain the expected marker and exit code. The model's
final answer is never used as proof.

The mission adapter uses distinct fail-closed proofs for the delivery fixture.
Initial inspection requires a correlated GitHub MCP `get_commit` call for the
immutable `mtamburrano/proofboard-demo-fixture` baseline
`88e53b07691d5ed3d327f5d47179e99c64e672af`. Before delivery approval, a second
read-only call resolves `proofboard-verified-delivery`. The pinned baseline's
`full_patch` response must contain the Todo transition in `src/index.ts`
(`Todo`, `createTodo`, and `getOpenTodos`) and the two focused Todo tests in
`test/index.test.js`; the former Proof Board/getNextDeliveryStage shape is not
accepted. The delivery-head commit must differ from the baseline and contain
the exact approved artifact patches. Its observed SHA is included in the
approval target, context, and durable delivery evidence; narration, unchanged
baseline state, or unrelated content cannot satisfy the check.

`npm run check` remains local-only and does not contact Gemini, GitHub, or
Daytona. A live run requires the operator's configured provider accounts and is
therefore intentionally separate from automated local checks.

## Known limitation

The repository cannot safely automate provider-key creation, GitHub OAuth, or
Daytona account setup. Those steps are explicit prerequisites in the local
TrueForge UI. If a live run is unavailable, preserve the dry-run output and
report the missing external configuration rather than substituting model text
for tool evidence.

For the GitHub connector's tool names and read-only configuration, see the
[official GitHub MCP server documentation](https://github.com/github/github-mcp-server).
