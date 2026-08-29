import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  InMemoryMissionRepository,
  MissionService,
  createMissionHttpApp,
} from "../dist/index.js";

const appScript = await readFile(new URL("../src/http/public/app.js", import.meta.url), "utf8");
const styleSheet = await readFile(new URL("../src/http/public/style.css", import.meta.url), "utf8");

test("Proof Board UI declares the queue columns and system-owned boundary", () => {
  for (const status of [
    "backlog",
    "ready",
    "in_progress",
    "proving",
    "changes_requested",
    "awaiting_approval",
    "delivering",
    "done",
  ]) {
    assert.match(appScript, new RegExp(`id: "${status}"`));
  }
  assert.match(appScript, /data-drop-enabled/);
  assert.match(appScript, /Backlog ↔ Ready authorizes work/);
  assert.match(appScript, /Changes Requested → Ready authorizes bounded rework/);
  assert.match(appScript, /humanSource: true/);
  assert.match(appScript, /Authorize bounded rework/);
  assert.match(appScript, /draggable="\$\{canDrag\}"/);
  assert.match(appScript, /\["backlog", "ready"\]/);
  assert.match(appScript, /system-owned/);
});

test("Proof Board UI explains the queue mental model and elevates the primary contract", () => {
  assert.match(appScript, /const QUEUE_FLOW = Object\.freeze/);
  assert.match(appScript, /One queue\. Two human gates\./);
  assert.match(appScript, /Backlog → Ready/);
  assert.match(appScript, /In Progress → Proving/);
  assert.match(appScript, /Changes Requested → Ready/);
  assert.match(appScript, /Awaiting Approval → Delivering → Done/);
  assert.match(appScript, /data-primary-ticket="\$\{isPrimary\}"/);
  assert.match(appScript, /Gate 1 · Queue authorization/);
  assert.match(appScript, /Gate 2 · Consequential delivery/);
  assert.match(styleSheet, /\.queue-flow\s*\{/);
  assert.match(styleSheet, /\.ticket-card\.primary-ticket\s*\{/);
  assert.match(styleSheet, /\.checkpoint-delivery-gate\s*\{/);
});

test("Proof Board UI keeps durable polling, drawer, activity, proof, and approval affordances", () => {
  assert.match(appScript, /setInterval\(pollMission, POLL_INTERVAL_MS\)/);
  assert.match(appScript, /expected_revision: currentView\.revision/);
  assert.match(appScript, /expected_revision: currentView\?\.revision/);
  assert.match(appScript, /Placement is a server-owned projection/);
  assert.match(appScript, /pollInFlight/);
  assert.match(appScript, /id="ticket-drawer"/);
  assert.match(appScript, /Attempt history/);
  assert.match(appScript, /Review history/);
  assert.match(appScript, /requestedChanges/);
  assert.match(appScript, /Retired by/);
  assert.match(appScript, /item\.workItemId === ticket\.id/);
  assert.match(appScript, /Deterministic proof/);
  assert.match(appScript, /Agent activity/);
  assert.match(appScript, /Measured proof/);
  assert.match(appScript, /Model/);
  assert.match(appScript, /Real execution trail/);
  assert.match(appScript, /GitHub MCP reads/);
  assert.match(appScript, /Daytona sandbox work/);
  assert.match(appScript, /Subagent delegation/);
  assert.match(appScript, /Reconnect \/ recovery/);
  assert.match(appScript, /Protected approval checkpoint/);
  assert.match(appScript, /Delivery read-back/);
  assert.match(appScript, /Show execution provenance/);
  assert.match(appScript, /Proof Board verification owns deterministic status/);
  assert.match(appScript, /verified head SHA/);
  assert.match(appScript, /Diff context/);
  assert.match(appScript, /Approve exact action/);
  assert.match(appScript, /Second human gate/);
  assert.match(appScript, /Human approval recorded/);
  assert.match(appScript, /Delivery verified/);
  assert.match(appScript, /refresh and reconnect cannot authorize delivery/);
  assert.match(appScript, /Read-back/);
  assert.match(styleSheet, /\.ticket-board\s*\{/);
  assert.match(styleSheet, /\.ticket-drawer\s*\{/);
  assert.match(styleSheet, /grid-template-columns: repeat\(8/);
  assert.match(styleSheet, /\.ticket-column\.is-drag-over/);
  assert.match(styleSheet, /\.attempt-card/);
  assert.match(styleSheet, /\.drawer-rework/);
  assert.match(styleSheet, /\.runtime-facts/);
  assert.match(styleSheet, /\.proof-check-list/);
  assert.match(styleSheet, /\.provenance-strip/);
  assert.match(styleSheet, /\.activity-details/);
});

test("ticket cards open a non-blocking drawer while queue transitions stay in the drawer", () => {
  const cardSource = appScript.slice(
    appScript.indexOf("function renderTicketCard"),
    appScript.indexOf("function renderTicketSignal"),
  );
  assert.match(cardSource, /role="button"/);
  assert.doesNotMatch(cardSource, /Inspect contract|ticket-transition|Authorize execution/);
  assert.match(appScript, /event\.key !== "Enter" && event\.key !== " "/);
  assert.match(appScript, /function renderDrawerAuthorization/);
  assert.match(appScript, /data-ticket-transition/);
  assert.match(appScript, /Authorize execution/);
  assert.match(appScript, /aria-modal="false"/);
  assert.doesNotMatch(appScript, /ticket-drawer-scrim|aria-modal="true"/);
  assert.doesNotMatch(styleSheet, /ticket-drawer-scrim|ticket-card-actions/);
  assert.match(styleSheet, /box-shadow: -18px 0 32px/);
  assert.match(styleSheet, /border: 1px solid var\(--color-border-strong\)/);
});

test("mission view correlates card activity and evidence to the durable ticket", async () => {
  const missions = new MissionService(new InMemoryMissionRepository());
  await missions.createMission({
    id: "primary-mission",
    objective: "Verify a bounded delivery contract.",
    repository: { owner: "example", name: "proof-board", ref: "baseline-sha" },
  });
  const ticket = await missions.addWorkItem("primary-mission", {
    id: "ticket-ui-contract",
    title: "Verify the delivery contract",
    purpose: "Keep the visible card tied to persisted proof.",
    acceptanceCriteria: ["The evidence remains correlated after refresh."],
    allowedFiles: ["src/index.ts"],
  });
  await missions.addEvidence("primary-mission", {
    workItemId: ticket.id,
    kind: "tool_result",
    result: "passed",
    source: "sandbox",
    summary: "Deterministic sandbox check passed.",
  });

  const app = createMissionHttpApp({ missions, runner: {}, model: "openai/test-proof-model" });
  const response = await app.request("/api/mission");
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.mission.tickets[0].id, ticket.id);
  assert.equal(payload.mission.tickets[0].status, "backlog");
  assert.equal(payload.mission.evidence[0].workItemId, ticket.id);
  assert.equal(payload.mission.activity[0].workItemId, ticket.id);
  assert.equal(payload.mission.mission.deliveryTarget.base, "main");
  assert.equal(payload.mission.mission.execution.model, "openai/test-proof-model");
});
