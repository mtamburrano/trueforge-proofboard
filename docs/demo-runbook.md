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

The reset is local and deterministic. It restores empty mission intake and
atomically writes only `.trueforge/mission-state.json`; the next `Create
tickets` action performs the read-only inspection and planning phase. It clears prior session, turn, sandbox,
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
read budget is nine calls maximum. TrueForge metadata requests use zero SDK
retries so transient failures cannot silently expand that budget.

It checks:

- the loopback/local state target, Node.js 22.14+ runtime, and the exact
  deterministic model policy;
- TrueForge reachability through `server.getCapabilities()` and the configured
  model through `models.list()`;
- the configured GitHub MCP server's authorization and the complete tool
  surface required by the demo: `get_file_contents`, `get_commit`, `push_files`,
  `create_pull_request`, `pull_request_read`, and `search_pull_requests`;
- the TrueForge sandbox settings projection, requiring a `daytona` provider in
  `ready` status without provisioning or executing anything, plus the
  server-side `DAYTONA_API_KEY` required by the direct deterministic proof
  adapter. A separate official-Daytona-SDK lookup against a fresh, absent
  sandbox ID verifies that the direct credential reaches the authenticated API
  boundary; a 404 is the expected non-mutating response and a 401 fails closed;
- the exact fixture `mtamburrano/proofboard-demo-fixture` at pinned baseline
  `88e53b07691d5ed3d327f5d47179e99c64e672af`;
- the absence of the owned delivery branch
  `proofboard-verified-delivery`; and
- the absence of an open owned pull request from that branch into `main`.
  Closed historical pull requests are ignored after their delivery branch has
  been removed; an existing branch still remains a collision.

The connector and model checks use TrueForge metadata endpoints. The direct
Daytona probe uses the same server-only key and API URL as deterministic proof,
but does not create, start, execute, stop, or delete a sandbox. GitHub API
requests are pinned to `https://api.github.com` because this demo's fixture is
hosted on GitHub.com; a configured alternate host is rejected before a token is
sent. The exact
baseline and stale branch/pull-request checks use bounded, read-only GitHub
API requests so the collision check can inspect remote repository state without
starting an agent turn. Set a read-capable `GITHUB_TOKEN` in the environment
when anonymous GitHub API access is unavailable; never commit it. A failed
request, incomplete response, missing tool, pending authorization, mismatched
SHA, or stale artifact is a preflight failure that must be resolved before a
recorded run.

### External nondeterminism and retry plan

The earlier live rehearsal exposed a direct-Daytona `401` even while the
TrueForge settings projection reported a ready Daytona provider. Treat that as
an external credential or endpoint mismatch, not as a coding result. The
direct SDK probe above now catches that boundary before a queue run starts. If
it fails, preserve the report, correct the server-only key or API URL, run
`npm run demo:reset`, and repeat the complete preflight; the preflight itself
does not retry or mutate remote state. If a provider fails after a passing
preflight, preserve the durable failure evidence, reconnect or retry only
through the visible queue recovery path, and record the reason before repeating
the non-mutating rehearsal. Never clean up a branch or pull request unless it
was created by the explicitly authorized rehearsal described below.

## Manual validation after review

The following steps deliberately remain manual. Do not replace a real queue
run with the smoke dry-run or with fixture text.

1. Start the pinned local TrueForge server and configure the documented model,
   GitHub MCP connector, and Daytona provider.
2. Run `npm run demo:reset`, then `npm run demo:preflight`. Do not continue on
   a failed check.
3. Open Mission Control, enter the mission objective (or use the exact Todo
   demo mission), choose `Create tickets`, then authorize only the resulting
   implementation ticket by moving it from `Backlog` to `Ready`, and drive the real queue through repository
   inspection, implementation, independent proof, and review. Stop at
   `Awaiting Approval`; do not approve delivery for the rehearsal.
4. Repeat the reset, preflight, and clean pre-approval queue run once more.
   Record both outcomes. If either run is nondeterministic, preserve the
   failure evidence, rerun preflight after correcting the external condition,
   and record the operational retry reason rather than silently retrying.
5. For one separate PR-producing rehearsal, start from a fresh reset and a
   passing preflight. Review the exact repository, base, delivery branch,
   artifact baseline/files/patches, expected effect, and proof records in the
   second human gate. Approve once through Mission Control. TrueForge then
   publishes the exact approved artifact with `push_files`, independently reads
   the branch back with `get_commit`, and only then creates and reads the one
   pull request. `Done` is valid only after that correlated read-back.
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
