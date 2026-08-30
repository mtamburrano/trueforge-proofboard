import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

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

test("Proof Board UI starts with human mission intake and a planning-only gate", () => {
  assert.match(appScript, /id="mission-intake-form"/);
  assert.match(appScript, /id="mission-objective"/);
  assert.match(appScript, /Use demo mission/);
  assert.match(appScript, /Add support for marking a todo as completed\./);
  assert.match(appScript, /id="create-tickets"/);
  assert.match(appScript, /id="start-execution"[^>]+disabled/);
  assert.match(appScript, /body: JSON\.stringify\(\{ objective \}\)/);
  assert.match(appScript, /Read-only planning complete/);
  assert.match(styleSheet, /\.mission-intake-form\s*\{/);
  assert.match(styleSheet, /\.intake-repository\s*\{/);
});

test("Proof Board UI explains the queue mental model and elevates the primary contract", () => {
  assert.match(appScript, /const QUEUE_FLOW = Object\.freeze/);
  assert.match(appScript, /One queue\. Two human gates\./);
  assert.match(appScript, /Backlog → Ready/);
  assert.match(appScript, /In Progress → Proving/);
  assert.match(appScript, /Changes Requested → Ready/);
  assert.match(appScript, /Awaiting Approval → Delivering → Done/);
  assert.match(appScript, /data-primary-ticket="\$\{isPrimary\}"/);
  assert.match(appScript, /function renderDeliveryApprovalContext/);
  assert.doesNotMatch(appScript, /Gate 1 · Queue authorization/);
  assert.doesNotMatch(appScript, /Gate 2 · Consequential delivery/);
  assert.doesNotMatch(appScript, /renderApprovalCheckpoint/);
  assert.match(styleSheet, /\.queue-flow\s*\{/);
  assert.match(styleSheet, /\.ticket-card\.primary-ticket\s*\{/);
  assert.match(styleSheet, /\.delivery-approval-context\s*\{/);
  assert.doesNotMatch(styleSheet, /\.checkpoint-grid\s*\{/);
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
  assert.doesNotMatch(appScript, /Run provenance/);
  assert.doesNotMatch(appScript, /Real execution trail/);
  assert.doesNotMatch(appScript, /renderProvenanceTrail/);
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
  assert.match(styleSheet, /\.provenance-details/);
  assert.doesNotMatch(styleSheet, /\.provenance-strip\s*\{/);
  assert.match(styleSheet, /\.activity-details/);
});

test("delivery approval is absent until a real approval exists and stays compact when it does", () => {
  const renderSource = appScript.slice(
    appScript.indexOf("function escapeHtml"),
    appScript.indexOf("function bindMissionInteractions"),
  );
  const { renderDeliveryApprovalContext } = vm.runInNewContext(`${renderSource}\n({ renderDeliveryApprovalContext })`, {
    labels: { pending: "Pending approval" },
  });
  const baseView = {
    tickets: [{ id: "ticket-delivery", assignedRole: "implementer", status: "awaiting_approval", attempt: 1 }],
    approvals: [],
    delivery: [],
  };

  assert.equal(renderDeliveryApprovalContext(baseView), "");

  const approvalMarkup = renderDeliveryApprovalContext({
    ...baseView,
    approvals: [{
      id: "approval-delivery",
      decision: "pending",
      action: "Create pull request",
      target: "example/proof-board@main",
      workItemId: "ticket-delivery",
      attempt: 1,
      executionContext: {
        repositoryOwner: "example",
        repositoryName: "proof-board",
        base: "main",
        head: "verified-delivery",
        headSha: "0123456789abcdef",
      },
    }],
  });

  assert.match(approvalMarkup, /delivery-approval-context/);
  assert.match(approvalMarkup, /example\/proof-board · main → verified-delivery/);
  assert.match(approvalMarkup, /Approve exact action/);
  assert.doesNotMatch(approvalMarkup, /checkpoint-grid|Gate 1|Gate 2/);
});

test("blocked infrastructure state stays outside rework and remains reachable from the board", () => {
  const renderSource = appScript.slice(
    appScript.indexOf("function escapeHtml"),
    appScript.indexOf("function bindMissionInteractions"),
  );
  const { columnForStatus, renderBlockedSummary, renderDrawerAuthorization } = vm.runInNewContext(
    `${renderSource}\n({ columnForStatus, renderBlockedSummary, renderDrawerAuthorization })`,
    { labels: {} },
  );
  const ticket = {
    id: "ticket-blocked",
    title: "Infrastructure failure",
    status: "blocked",
    dependsOn: [],
    attempts: [],
  };
  const view = { tickets: [ticket], approvals: [], delivery: [] };
  const summaryMarkup = renderBlockedSummary(view);
  const authorizationMarkup = renderDrawerAuthorization(ticket, view);

  assert.equal(columnForStatus("blocked"), "blocked");
  assert.match(summaryMarkup, /Pipeline blocked/);
  assert.match(summaryMarkup, /data-ticket-open="ticket-blocked"/);
  assert.doesNotMatch(summaryMarkup, /Changes Requested|data-target-status="ready"/);
  assert.match(authorizationMarkup, /Pipeline blocked/);
  assert.doesNotMatch(authorizationMarkup, /data-ticket-transition|Authorize bounded rework|next bounded pass/);
});

test("the eight-state board keeps desktop columns reachable through horizontal navigation", () => {
  assert.match(styleSheet, /\.ticket-board-wrap\s*\{[^}]*overflow-x: auto/);
  assert.match(styleSheet, /\.ticket-board\s*\{[^}]*grid-template-columns: repeat\(8, minmax\(220px, 1fr\)\)/);
  assert.match(styleSheet, /min-width: 1816px/);
  assert.match(styleSheet, /\.ticket-board\s*\{ display: flex; min-width: max-content; min-height: 0; \}/);
});

test("repeated null-mission polling preserves the mounted intake draft and focus", async () => {
  const renderStart = appScript.indexOf("function escapeHtml");
  const escapeEnd = appScript.indexOf("function semanticClass");
  const renderEnd = appScript.indexOf("function ticketsForView");
  const pollStart = appScript.indexOf("async function pollMission");
  const pollEnd = appScript.indexOf("function startMissionPolling");
  assert.ok(renderStart >= 0 && escapeEnd > renderStart && renderEnd > escapeEnd);
  assert.ok(pollStart >= 0 && pollEnd > pollStart);

  let mountedForm = null;
  let renderCount = 0;
  let pollCount = 0;
  const document = {
    hidden: false,
    activeElement: null,
    querySelector(selector) {
      if (selector === "#mission-intake-form") return mountedForm;
      if (selector === "#mission-objective") return mountedForm?.objective ?? null;
      if (selector === "#use-demo-mission") return mountedForm?.demoButton ?? null;
      return null;
    },
  };
  const app = {
    set innerHTML(markup) {
      renderCount += 1;
      const objective = {
        value: "",
        focus() {
          document.activeElement = this;
        },
      };
      const demoButton = {
        listeners: new Map(),
        addEventListener(type, listener) {
          this.listeners.set(type, listener);
        },
        click() {
          this.listeners.get("click")?.({ currentTarget: this });
        },
      };
      mountedForm = {
        objective,
        demoButton,
        listeners: new Map(),
        querySelector(selector) {
          if (selector === "#mission-objective") return this.objective;
          if (selector === "#use-demo-mission") return this.demoButton;
          return null;
        },
        addEventListener(type, listener) {
          this.listeners.set(type, listener);
        },
      };
    },
  };
  const context = {
    app,
    document,
    DEFAULT_DEMO_OBJECTIVE: "Add support for marking a todo as completed.",
    currentView: null,
    selectedTicketId: null,
    intakeConfig: null,
    boardDragInProgress: false,
    pollInFlight: false,
    runCoordinator: { isRunning: () => false, accept() {} },
    connectionState: { classList: { contains: () => false } },
    createMission() {},
    setConnection() {},
    showMessage() {},
    api: async () => {
      pollCount += 1;
      return {
        mission: null,
        intake: {
          demoObjective: "Add support for marking a todo as completed.",
          repository: { owner: "example", name: "todos", ref: "baseline" },
        },
      };
    },
  };
  vm.runInNewContext(
    appScript.slice(renderStart, escapeEnd) +
      appScript.slice(appScript.indexOf("function renderEmpty"), renderEnd) +
      "\n" + appScript.slice(pollStart, pollEnd),
    context,
  );

  context.renderEmpty();
  const form = mountedForm;
  const objective = form.objective;
  objective.value = "Keep this draft while the server is still empty.";
  objective.focus();

  await context.pollMission();
  await context.pollMission();
  assert.equal(pollCount, 2);
  assert.equal(renderCount, 1);
  assert.equal(mountedForm, form);
  assert.equal(objective.value, "Keep this draft while the server is still empty.");
  assert.equal(document.activeElement, objective);

  form.demoButton.click();
  await context.pollMission();
  await context.pollMission();
  assert.equal(renderCount, 1);
  assert.equal(mountedForm, form);
  assert.equal(objective.value, context.DEFAULT_DEMO_OBJECTIVE);
  assert.equal(document.activeElement, objective);
});

test("Proof Board UI uses the returned mission state for run feedback", () => {
  assert.match(appScript, /const payload = await runCoordinator\.run\(\)/);
  assert.match(appScript, /MissionRunState\.describeRunOutcome\(payload\?\.mission \?\? currentView\)/);
  assert.doesNotMatch(appScript, /TrueForge run completed with durable verification evidence/);
  assert.match(styleSheet, /\.toast-warning\s*\{/);
});

test("Agent activity excludes deterministic proof and control-plane activity", () => {
  const runtimeSource = appScript.slice(
    appScript.indexOf("function ticketActivity"),
    appScript.indexOf("function latestHandoff"),
  );
  const { activitySurface, ticketRuntimeActivity } = vm.runInNewContext(`${runtimeSource}\n({ activitySurface, ticketRuntimeActivity })`);
  const categories = ["repository", "runtime", "narration", "session", "sandbox", "approval", "delivery"];
  const activity = categories.map((category) => ({
    category,
    workItemId: "ticket-runtime-boundary",
    summary: `${category} activity`,
    createdAt: "2026-08-30T00:00:00.000Z",
  }));

  assert.deepEqual(
    ticketRuntimeActivity(
      { id: "ticket-runtime-boundary", title: "Runtime boundary" },
      { activity },
    ).map((item) => item.category),
    ["repository", "runtime", "narration", "session"],
  );
  assert.deepEqual(
    categories.map((category) => activitySurface(category)),
    ["runtime", "runtime", "runtime", "runtime", "proof", "control-plane", "control-plane"],
  );
  assert.match(appScript, /drawer-runtime[^\n]*data-provenance-surface="runtime"[\s\S]*renderTicketActivity\(activity\)/);
  assert.match(appScript, /drawer-proof[^\n]*data-provenance-surface="proof"[\s\S]*renderTicketEvidence\(evidence\)/);
  assert.match(appScript, /approval-facts[^\n]*data-provenance-surface="control-plane"/);
  assert.match(appScript, /delivery-result delivery-card[^\n]*data-provenance-surface="control-plane"/);
  assert.match(appScript, /data-provenance-surface="\$\{escapeHtml\(activitySurface\(item\.category\)\)\}"/);
  assert.match(appScript, /renderApprovalBody\(approval\)/);
  assert.match(appScript, /renderDeliveryBody\(delivery\)/);
});

test("the ticket drawer keeps runtime activity, proof, and delivery control surfaces separate", () => {
  const drawerSource = appScript.slice(
    appScript.indexOf("function renderTicketDrawer"),
    appScript.indexOf("function renderReworkContext"),
  );
  const runtimeSection = drawerSource.slice(
    drawerSource.indexOf("drawer-runtime"),
    drawerSource.indexOf("drawer-proof"),
  );

  assert.match(drawerSource, /const activity = ticketRuntimeActivity\(ticket, view\)/);
  assert.match(runtimeSection, /data-provenance-surface="runtime"/);
  assert.match(runtimeSection, /renderTicketActivity\(activity\)/);
  assert.doesNotMatch(runtimeSection, /renderApprovalBody|renderDeliveryBody|renderTicketEvidence/);
  assert.match(drawerSource, /drawer-proof[\s\S]*data-provenance-surface="proof"[\s\S]*renderTicketEvidence\(evidence\)/);
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
