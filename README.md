# Proof Board

Trustworthy autonomous software delivery through a durable queue and independent review.

Proof Board turns a bounded software change into an inspectable delivery path. A human authorizes the work, TrueForge performs the real implementation in a persisted Daytona sandbox, Proof Board captures the sandbox's actual changed state, and a separate TrueForge reviewer evaluates that captured artifact. Only an explicit human approval can publish the reviewed artifact to GitHub.

## What it does

Proof Board is a delivery control plane, not a list of agent promises. Each ticket is a bounded work contract with an authorization state, attempt history, review findings, and delivery evidence. The board keeps those records durable across reconnects and makes the next consequential action visible before it happens.

## Why it exists

An implementation summary can sound complete while the repository is unchanged, incomplete, or changed outside the requested scope. Proof Board separates execution from evidence: the reviewer sees the files and diff captured from the sandbox where the work happened, not just what the implementer says it did. A second human gate then protects the remote repository from an unexamined or stale artifact.

## How it works

```text
Backlog
  │ human authorizes
  ▼
Ready
  │ TrueForge claims one bounded ticket
  ▼
Implementation in a persisted Daytona sandbox
  │ Proof Board captures changed files, diff, and final artifact
  ▼
Independent TrueForge review of the captured artifact
  ├─ Changes Requested ── human reauthorizes ──► Ready
  └─ accepted ─► Awaiting Approval
                     │ human approves the exact reviewed artifact
                     ▼
        GitHub MCP: push_files → create PR → read back → Done
```

The key boundary is simple: the independent reviewer receives the actual same-sandbox change, diff, and artifact. Implementer narration is not a substitute for that evidence or the review.

## Runtime components

| Component | Responsibility |
| --- | --- |
| **Proof Board** | Owns durable queue and lifecycle state, authorization gates, attempt and review history, evidence correlation, and delivery control. |
| **TrueForge** | Provides model reasoning and runtime execution, persisted session continuity, GitHub MCP access, implementation turns, and a separate independent reviewer turn. |
| **Daytona** | Hosts the persistent coding sandbox. The changed files and diff reviewed by Proof Board come from this sandbox. |
| **GitHub MCP** | Inspects the real repository and, only after approval, performs the protected publication, pull-request creation, and read-back. |
| **Human gates** | Authorize Backlog → Ready work, authorize Changes Requested → Ready rework, and approve the exact artifact before delivery. |

## Human control and rework

Moving a ticket from Backlog to Ready is the work authorization. Changes Requested is a hard stop: the reviewer’s concrete finding remains attached to the same durable ticket, and a human must move it back to Ready before another bounded attempt can start. Prior attempts and reviews remain visible.

An accepted review moves the current attempt to Awaiting Approval; it does not publish anything. The approval is bound to the exact reviewed repository, files, contents, and patches. If that artifact is not the one presented for approval, delivery is rejected. After approval, GitHub MCP publishes the artifact and Proof Board verifies the resulting commit and pull request.

## Running locally

Requirements: Node.js 22.14 or newer, a local TrueForge server, an authorized GitHub MCP connector, and a Daytona sandbox provider. The default endpoints are TrueForge at `http://localhost:8790`, Proof Board at `http://127.0.0.1:8787`, and durable state at `.trueforge/mission-state.json`.

Configure TrueForge separately with a model, the GitHub MCP tools used by the delivery flow, and Daytona. Copy `.env.example` to a local `.env`, set the server-side `DAYTONA_API_KEY`, and keep model and connector credentials in TrueForge configuration. Start the local TrueForge server in another terminal, for example:

```sh
npx @truefoundry/trueforge@0.1.4
```

Then, from the repository root:

```sh
npm ci
cp .env.example .env
npm run demo:reset
npm run demo:preflight -- --dry-run
npm start
```

Open `http://127.0.0.1:8787`. `npm start` builds the application before starting it. After the external providers are configured, `npm run demo:preflight` performs the bounded read-only readiness and collision checks; it does not create a session, sandbox, branch, or pull request.

## Demo flow

1. Open the board, enter a bounded objective (or use the demo mission), and create the tickets. Repository inspection and planning leave the implementation ticket in Backlog.
2. Move that ticket to Ready, then start TrueForge execution.
3. TrueForge creates or resumes the persisted session and performs the implementation in the Daytona sandbox.
4. Proof Board captures the actual same-sandbox changed state, diff, and final file contents. A separate TrueForge reviewer receives that capture and records either acceptance or a concrete finding.
5. For Changes Requested, inspect the finding and move the same ticket back to Ready to authorize a new bounded attempt.
6. For an accepted review, inspect the exact artifact in Awaiting Approval and explicitly approve or reject delivery.
7. Only after approval does GitHub MCP publish the exact reviewed artifact, create the pull request, and read back the delivered commit and PR. The delivery is complete only after that read-back.

## Qodo Code Review Evidence

The reviewable evidence for a repository change is the corresponding GitHub pull request: its exact diff, any visible Qodo Code Review findings, and the resulting review status. This README does not summarize an unobserved review result or treat agent narration as code-review evidence.

## AI coding-assistant disclosure

AI coding assistance was used while developing this repository and this README. Humans defined the scope, inspect the resulting changes, and retain both authorization gates; the independent reviewer evaluates the captured sandbox artifact.
