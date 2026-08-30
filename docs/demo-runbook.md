# Deterministic demo runbook

This runbook is the operator path for the real queue demo. The repository's
automated tests do not contact TrueForge, a GitHub MCP connector, Daytona, or
GitHub. They use fake read-only adapters, temporary state, and local fixtures.
The commands below are intentionally separate from that validation because the
preflight reads the operator's configured services and the queue run uses the
real providers.

## Local reset

From the repository root, run:

```sh
npm run demo:reset
```

The reset is local and deterministic. It rebuilds the primary mission in
memory, creates the one inspect ticket in `Backlog`, and atomically writes only
`.trueforge/mission-state.json`. It clears prior session, turn, sandbox,
evidence, handoff, review, approval, delivery, and delivery-attempt records.
It does not call a provider, create a sandbox, inspect GitHub, delete a branch,
close a pull request, or touch other files. The reset refuses a state-file or
state-directory symlink and refuses paths outside the dedicated
`.trueforge/mission-state.json` target.

`TRUEFORGE_MISSION_STATE` remains available for the application, but the demo
reset accepts only that exact filename directly inside the repository's
`.trueforge` directory. Use an isolated temporary repository root when testing
the reset programmatically.

## Bounded read-only preflight

First, inspect the planned topology without contacting anything:

```sh
npm run demo:preflight -- --dry-run
```

After external setup is complete, run the actual preflight:

```sh
npm run demo:preflight
```

The actual command is read-only, bounded to one pass, and fails closed. It
does not create a TrueForge session or turn, run a model, authorize an MCP
server, create a Daytona sandbox, execute a sandbox command, create a branch,
open a pull request, or mutate any remote resource. Every reported check is
marked `mutating: false`; the report declares `externalMutations: 0` and the
read budget is eight calls maximum.

It checks:

- the loopback/local state target, Node.js 22.14+ runtime, and the exact
  deterministic model policy;
- TrueForge reachability through `server.getCapabilities()` and the configured
  model through `models.list()`;
- the configured GitHub MCP server's authorization and the complete tool
  surface required by the demo: `get_file_contents`, `get_commit`,
  `create_pull_request`, `pull_request_read`, and `search_pull_requests`;
- the TrueForge sandbox settings projection, requiring a `daytona` provider in
  `ready` status without provisioning or executing anything, plus the
  server-side `DAYTONA_API_KEY` required by the direct deterministic proof
  adapter;
- the exact fixture `mtamburrano/proofboard-demo-fixture` at pinned baseline
  `590aa8a6d72c580f61fc1b19d33e9876bc0feb9b`;
- the absence of the owned delivery branch
  `proofboard-verified-delivery`; and
- the absence of an owned pull request from that branch into `main`.

The connector and model checks use TrueForge metadata endpoints. The exact
baseline and stale branch/pull-request checks use bounded, read-only GitHub
API requests so the collision check can inspect remote repository state without
starting an agent turn. Set a read-capable `GITHUB_TOKEN` in the environment
when anonymous GitHub API access is unavailable; never commit it. A failed
request, incomplete response, missing tool, pending authorization, mismatched
SHA, or stale artifact is a preflight failure that must be resolved before a
recorded run.

## Manual validation after review

The following steps deliberately remain manual. Do not replace a real queue
run with the smoke dry-run or with fixture text.

1. Start the pinned local TrueForge server and configure the documented model,
   GitHub MCP connector, and Daytona provider.
2. Run `npm run demo:reset`, then `npm run demo:preflight`. Do not continue on
   a failed check.
3. Open Mission Control, authorize only the intended ticket by moving it from
   `Backlog` to `Ready`, and drive the real queue through repository
   inspection, implementation, independent proof, and review. Stop at
   `Awaiting Approval`; do not approve delivery for the rehearsal.
4. Repeat the reset, preflight, and clean pre-approval queue run once more.
   Record both outcomes. If either run is nondeterministic, preserve the
   failure evidence, rerun preflight after correcting the external condition,
   and record the operational retry reason rather than silently retrying.
5. For one separate PR-producing rehearsal, start from a fresh reset and a
   passing preflight. Review the exact repository, base, delivery branch,
   verified head SHA, expected effect, and proof records in the second human
   gate. Approve once through Mission Control, then confirm the real pull
   request and its read-back. `Done` is valid only after that correlated
   read-back.
6. Clean up only the branch and pull request created by that explicitly
   authorized rehearsal, using an operator-approved GitHub action. Never
   delete or close an artifact that predated the run; the preflight's stale
   artifact checks exist to prevent that collision.

The UI keeps `Agent activity · runtime` limited to repository/runtime/session
activity. Deterministic sandbox measurements belong to the Proof Board proof
surface. Approval checkpoints and delivery read-back belong to the
control-plane surface. A runtime narrative is not a substitute for either
proof or approval.

## Local validation boundary

`npm run check` and the focused demo-control tests are provider-free. The
tests inject TrueForge, MCP, and GitHub read-only fakes and use temporary JSON
state. The real queue rehearsals above are the only path that should be used
to validate live provider behavior, and they should be run only after code
review and a passing manual preflight.
