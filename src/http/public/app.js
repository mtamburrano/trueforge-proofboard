const app = document.querySelector("#app");
const connectionState = document.querySelector("#connection-state");
const messageRegion = document.querySelector("#message");
const HUMAN_ACTOR = "board-operator";
const POLL_INTERVAL_MS = 2_000;
const BOARD_COLUMNS = Object.freeze([
  { id: "backlog", label: "Backlog", note: "Needs authorization", canDrop: true },
  { id: "ready", label: "Ready", note: "Authorized queue", canDrop: true },
  { id: "in_progress", label: "In Progress", note: "TrueForge is working", canDrop: false },
  { id: "proving", label: "Proving", note: "Deterministic checks", canDrop: false },
  { id: "changes_requested", label: "Changes Requested", note: "Human rework gate", canDrop: false, humanSource: true },
  { id: "awaiting_approval", label: "Awaiting Approval", note: "Protected action", canDrop: false },
  { id: "delivering", label: "Delivering", note: "Read-back in progress", canDrop: false },
  { id: "done", label: "Done", note: "Verified delivery", canDrop: false },
]);

let runCoordinator;
let currentView = null;
let selectedTicketId = null;
let drawerOpener = null;
let focusDrawerOnRender = false;
let pollHandle = null;
let pollInFlight = false;
let missionLoadSequence = 0;
let boardDragInProgress = false;

const labels = {
  draft: "Draft", planning: "Planning", executing: "Executing",
  awaiting_approval: "Awaiting approval", verifying: "Verifying",
  delivered: "Delivered", failed: "Failed", backlog: "Backlog",
  ready: "Ready", in_progress: "In progress", proving: "Proving",
  changes_requested: "Changes requested", delivering: "Delivering",
  done: "Done", blocked: "Blocked / error", ready_for_review: "Proof pending",
  complete: "Done", not_started: "Not started", running: "Running",
  passed: "Passed", active: "Active", pending: "Pending approval",
  approved: "Approved execution", rejected: "Rejected delivery",
  cancelled: "Cancelled delivery", commitSha: "Commit SHA",
  contentHash: "Content hash", contentBytes: "Content bytes",
  exitCode: "Exit code", sandboxId: "Sandbox", resource: "Resource",
  command: "Command", output: "Output", tool: "Tool", server: "Server",
  reason: "Reason",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function semanticClass(prefix, value) {
  return prefix + "-" + String(value).replaceAll("_", "-");
}

function humanLabel(value) {
  return labels[value] ?? String(value ?? "").replaceAll("_", " ");
}

function chip(value, prefix = "status") {
  return `<span class="chip ${prefix}-chip ${semanticClass(prefix, value)}">${escapeHtml(humanLabel(value))}</span>`;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

function shortRef(value) {
  const text = String(value ?? "");
  return text.length > 12 ? text.slice(0, 8) + "…" + text.slice(-4) : text || "—";
}

function domId(value) {
  return String(value ?? "ticket").replace(/[^a-z0-9_-]/giu, "-");
}

function safePullRequestUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && url.hostname === "github.com" ? url.toString() : null;
  } catch {
    return null;
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers ?? {}) } });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.message ?? "Request failed.");
    error.payload = payload;
    throw error;
  }
  return payload;
}

function setConnection(kind, label) {
  connectionState.className = "connection-state " + kind;
  connectionState.textContent = label;
}

function showMessage(kind, text) {
  messageRegion.replaceChildren();
  const toast = document.createElement("div");
  toast.className = "toast toast-" + kind;
  toast.setAttribute("role", kind === "error" ? "alert" : "status");
  toast.textContent = text;
  messageRegion.append(toast);
  if (kind === "success") window.setTimeout(() => toast.remove(), 3_500);
}

function clearMessage() {
  messageRegion.replaceChildren();
}

function renderEmpty() {
  currentView = null;
  selectedTicketId = null;
  app.innerHTML = `<section class="empty-state panel"><p class="eyebrow">Proof Board</p><h1>Queue one bounded delivery mission.</h1><p>Start with a durable work contract, authorize it in Ready, and let TrueForge carry the work through proof and human-approved delivery.</p><button id="create-mission" class="primary-action" type="button">Create primary mission</button></section>`;
  document.querySelector("#create-mission")?.addEventListener("click", createMission);
}

function ticketsForView(view) {
  if (Array.isArray(view.tickets)) return view.tickets;
  return (view.lanes ?? []).flatMap((lane) => lane.items ?? []);
}

function ticketById(view, id) {
  return ticketsForView(view).find((ticket) => ticket.id === id);
}

function normalizedStatus(ticket) {
  if (ticket.status === "ready_for_review") return "proving";
  if (ticket.status === "complete") return "done";
  return ticket.status;
}

function implementationTicket(view) {
  const tickets = ticketsForView(view);
  return tickets.find((ticket) => ticket.assignedRole === "implementer") ??
    tickets.find((ticket) => ticket.allowedFiles?.length > 0) ?? tickets[0];
}

function isDeliveryTicket(ticket, view) {
  return ticket?.assignedRole === "implementer" || ticket?.id === implementationTicket(view)?.id;
}

function latestReview(ticket, view) {
  return [...(view.reviews ?? [])].reverse().find((review) => review.workItemId === ticket.id);
}

function ticketReviews(ticket, view) {
  return (view.reviews ?? []).filter((review) => review.workItemId === ticket.id);
}

function latestAttempt(ticket) {
  return ticket.attempts?.at(-1);
}

function requestedChanges(ticket) {
  return ticket.requestedChanges ?? latestAttempt(ticket)?.requestedChanges ?? [];
}

function reworkAuthorizationReady(ticket) {
  const attempt = latestAttempt(ticket);
  return ticket.status === "ready" && ticket.attempt > 0 &&
    attempt?.status === "changes_requested" && attempt.retiredAt !== undefined;
}

function deliveryApproval(view) {
  const ticket = implementationTicket(view);
  return [...(view.approvals ?? [])].reverse().find((approval) =>
    ["pending", "approved", "rejected", "cancelled"].includes(approval.decision) &&
    (ticket === undefined || approval.workItemId === undefined
      ? true
      : approval.workItemId === ticket.id && approval.attempt === ticket.attempt),
  );
}

function deliveryResult(view) {
  const ticket = implementationTicket(view);
  return [...(view.delivery ?? [])].reverse().find((delivery) =>
    ticket === undefined || delivery.workItemId === undefined
      ? true
      : delivery.workItemId === ticket.id && delivery.attempt === ticket.attempt,
  );
}

function effectiveStatus(ticket) {
  // Placement is a server-owned projection of durable state. Only legacy
  // aliases are normalized here; approvals and reviews never rewrite a
  // ticket column in the browser.
  return normalizedStatus(ticket);
}

function columnForStatus(status) {
  return status === "blocked" ? "changes_requested" : status;
}

function ticketEvidence(ticket, view) {
  return (view.evidence ?? []).filter((item) => item.workItemId === ticket.id || (item.workItemId === undefined && item.workItemTitle === ticket.title));
}

function ticketActivity(ticket, view) {
  return (view.activity ?? []).filter((item) => item.workItemId === ticket.id || (item.workItemId === undefined && item.summary.includes(ticket.title)));
}

function hasUnresolvedDependency(ticket, view) {
  return ticket.dependsOn.some((dependencyId) => {
    const dependency = ticketById(view, dependencyId);
    return dependency === undefined || effectiveStatus(dependency) !== "done";
  });
}

function canHumanMove(ticket, target) {
  if (ticket === undefined || ticket.delegation?.status === "running") return false;
  if (ticket.status === "changes_requested") return target === "ready";
  return ticket.claim === undefined &&
    ["backlog", "ready"].includes(ticket.status) &&
    ["backlog", "ready"].includes(target) && ticket.status !== target;
}

function canDragTicket(ticket) {
  return ticket.delegation?.status !== "running" &&
    (ticket.status === "changes_requested" ||
      (ticket.claim === undefined && ["backlog", "ready"].includes(ticket.status)));
}

function canStartMission(view) {
  const ticket = implementationTicket(view);
  if (ticket === undefined || ticket.executionAuthorization === undefined) return false;
  if (["delivered", "failed"].includes(view.mission.status)) return false;
  const status = effectiveStatus(ticket);
  const approval = deliveryApproval(view);
  if (view.mission.status === "awaiting_approval") {
    return false;
  }
  if (view.mission.status === "verifying") {
    return status === "delivering" && approval?.decision === "approved";
  }
  return ["ready", "in_progress", "proving", "ready_for_review", "delivering"].includes(status);
}

function renderRepositoryFacts(view) {
  const repository = view.mission.repository;
  const target = view.mission.deliveryTarget;
  if (!repository) return `<span class="fact"><span>Repository</span> <strong>Not attached</strong></span>`;
  return `<span class="fact"><span>Repository</span> <strong>${escapeHtml(repository.owner)}/${escapeHtml(repository.name)}</strong></span><span class="fact"><span>Base</span> <strong>${escapeHtml(target?.base ?? "—")}</strong></span><span class="fact"><span>Pinned ref</span> <strong title="${escapeHtml(repository.ref)}">${escapeHtml(shortRef(repository.ref))}</strong></span>`;
}

function renderMission(view) {
  currentView = view;
  const tickets = ticketsForView(view);
  if (selectedTicketId !== null && ticketById(view, selectedTicketId) === undefined) {
    selectedTicketId = null;
    drawerOpener = null;
    focusDrawerOnRender = false;
  }
  const previousBoard = document.querySelector(".ticket-board");
  const previousScroll = { x: window.scrollX, y: window.scrollY, boardX: previousBoard?.scrollLeft ?? 0 };
  const counts = Object.fromEntries(BOARD_COLUMNS.map((column) => [column.id, 0]));
  tickets.forEach((ticket) => {
    const status = columnForStatus(effectiveStatus(ticket));
    if (counts[status] !== undefined) counts[status] += 1;
  });
  const authorized = tickets.filter((ticket) => ticket.executionAuthorization !== undefined).length;
  const blocked = tickets.filter((ticket) => effectiveStatus(ticket) === "blocked").length;
  const repair = Math.max(0, counts.changes_requested - blocked);
  const running = runCoordinator?.isRunning() ?? false;
  const terminal = ["delivered", "failed"].includes(view.mission.status);
  const canRun = canStartMission(view);
  const runDisabled = running || terminal || !canRun;
  const primaryTicket = implementationTicket(view);
  const runHint = !canRun && !running && !terminal
    ? primaryTicket?.status === "changes_requested"
      ? "Inspect the durable findings, then move Changes Requested to Ready to authorize bounded rework."
      : "Move the primary ticket from Backlog to Ready to authorize TrueForge."
    : "Execution starts only after the human queue decision.";
  app.innerHTML = `
    <section class="queue-hero panel" aria-labelledby="mission-objective"><div class="queue-hero-copy"><div class="mission-title-row"><p class="eyebrow">Proof Board · verified delivery</p>${chip(view.mission.status)}</div><h1 id="mission-objective" class="mission-objective">${escapeHtml(view.mission.objective)}</h1><p class="queue-thesis">Queue work. Prove facts. Approve the exact delivery.</p><p class="mission-meta">${renderRepositoryFacts(view)}<span class="fact"><span>TrueForge</span> <strong>${view.mission.execution.connected ? "Session connected" : "Waiting"}</strong></span><span class="fact"><span>State revision</span> <strong>${escapeHtml(view.revision)}</strong></span></p></div><div class="mission-actions"><button id="run-mission" class="primary-action" type="button" ${runDisabled ? "disabled" : ""} ${running ? 'aria-busy="true"' : ""}>${escapeHtml(running ? "TrueForge is working…" : canRun ? "Start TrueForge execution" : "Authorize execution first")}</button><p class="run-hint">${escapeHtml(runHint)}</p></div></section>
    <section class="metrics-strip queue-metrics" aria-label="Proof Board summary"><div class="metric"><span class="metric-label">Tickets</span><span class="metric-value">${tickets.length}</span></div><div class="metric"><span class="metric-label">Ready / authorized</span><span class="metric-value good">${counts.ready} / ${authorized}</span></div><div class="metric"><span class="metric-label">Verified done</span><span class="metric-value good">${counts.done}</span></div><div class="metric"><span class="metric-label">Blocked / repair</span><span class="metric-value ${blocked + repair ? "bad" : ""}">${blocked + repair}</span></div><div class="metric"><span class="metric-label">Evidence records</span><span class="metric-value">${view.evidence.length}</span></div></section>
    <section class="board-section" aria-labelledby="board-title"><header class="board-heading"><div><p class="section-kicker">Queue-first control plane</p><h2 id="board-title">Backlog → Ready → verified delivery</h2><p id="board-description" class="section-note">Backlog ↔ Ready authorizes work. Changes Requested → Ready authorizes bounded rework. Coding, proof, approval, and delivery are pipeline-owned.</p></div><div class="board-legend"><span class="legend-item"><span class="legend-dot legend-dot-human"></span>Human gate</span><span class="legend-item"><span class="legend-dot legend-dot-system"></span>System state</span><span class="revision-label">Revision ${escapeHtml(view.revision)}</span></div></header>${blocked ? `<div class="blocked-summary" role="status"><strong>${blocked} ticket${blocked === 1 ? "" : "s"} blocked.</strong> Open the card for the concrete failure fact before retrying.</div>` : ""}<div class="ticket-board-wrap"><section class="ticket-board" data-revision="${escapeHtml(view.revision)}" aria-describedby="board-description">${BOARD_COLUMNS.map((column) => renderBoardColumn(column, view, counts[column.id])).join("")}</section></div></section>
    ${renderApprovalCheckpoint(view)}
    <section class="section-heading operations-heading"><div><p class="section-kicker">Durable operational record</p><h2>Activity and proof</h2></div><p class="section-note"><span class="proof-boundary">MCP + sandbox evidence only</span></p></section><section class="operations-grid"><article class="operations-panel panel" aria-labelledby="activity-heading"><header class="operations-panel-header"><div><p class="section-kicker">Runtime</p><h2 id="activity-heading">Activity</h2></div><span class="badge">${view.activity.length}</span></header>${renderActivity(view.activity)}</article><article class="operations-panel panel" aria-labelledby="evidence-heading"><header class="operations-panel-header"><div><p class="section-kicker">Proof records</p><h2 id="evidence-heading">Evidence</h2></div><span class="badge">MCP + Sandbox only</span></header>${renderEvidence(view.evidence)}</article></section>${renderDiagnostics(view)}${selectedTicketId === null ? "" : renderTicketDrawer(ticketById(view, selectedTicketId), view)}
    `;
  bindMissionInteractions(view);
  window.requestAnimationFrame(() => { window.scrollTo(previousScroll.x, previousScroll.y); const board = document.querySelector(".ticket-board"); if (board) board.scrollLeft = previousScroll.boardX; });
  if (selectedTicketId !== null && drawerOpener !== null && focusDrawerOnRender) {
    focusDrawerOnRender = false;
    window.requestAnimationFrame(() => document.querySelector("#close-ticket-drawer")?.focus());
  }
}

function renderBoardColumn(column, view, count) {
  const tickets = ticketsForView(view).filter((ticket) => columnForStatus(effectiveStatus(ticket)) === column.id);
  const columnType = column.canDrop ? "Human gate" : column.humanSource ? "Human rework gate" : "Pipeline";
  return `<article class="ticket-column ${column.canDrop ? "drop-enabled" : "pipeline-owned"} ${column.humanSource ? "human-source" : ""}" data-status="${column.id}" data-drop-enabled="${column.canDrop}" data-human-source="${column.humanSource === true}" aria-labelledby="column-title-${column.id}"><header class="ticket-column-header"><div><p class="column-kicker">${columnType}</p><h3 id="column-title-${column.id}">${escapeHtml(column.label)}</h3><p>${escapeHtml(column.note)}</p></div><span class="column-count" aria-label="${count} ticket${count === 1 ? "" : "s"} in ${escapeHtml(column.label)}">${count}</span></header><div class="ticket-column-body" data-drop-status="${column.id}" ${column.canDrop ? "" : 'aria-disabled="true"'}>${tickets.length ? tickets.map((ticket) => renderTicketCard(ticket, view)).join("") : `<p class="column-empty">${column.canDrop ? "Nothing queued" : "Waiting for pipeline"}</p>`}</div></article>`;
}

function renderTicketCard(ticket, view) {
  const status = effectiveStatus(ticket);
  const canDrag = canDragTicket(ticket);
  const repository = view.mission.repository;
  const target = view.mission.deliveryTarget;
  const scope = ticket.allowedFiles ?? [];
  const criteria = ticket.acceptanceCriteria ?? [];
  const dependencyBlocked = hasUnresolvedDependency(ticket, view);
  const findings = requestedChanges(ticket);
  const reworkReady = reworkAuthorizationReady(ticket);
  const safeId = domId(ticket.id);
  const authorizationBadge = reworkReady
    ? `<span class="badge authorization-badge">Rework authorized · next attempt ${ticket.attempt + 1}</span>`
    : ticket.executionAuthorization
      ? `<span class="badge authorization-badge">Human authorized</span>`
      : ticket.status === "backlog"
        ? `<span class="badge gate-badge">Needs human authorization</span>`
        : "";
  const claimBadge = ticket.claim
    ? `<span class="badge">${status === "changes_requested" ? "Prior claim" : "Claimed"} · ${escapeHtml(ticket.claim.owner)}</span>`
    : "";
  const attemptBadge = ticket.attempt > 0
    ? `<span class="badge attempt-badge">Attempt ${ticket.attempt}</span>`
    : "";
  const findingsBadge = status === "changes_requested" && findings.length > 0
    ? `<span class="badge finding-badge">${findings.length} unresolved finding${findings.length === 1 ? "" : "s"}</span>`
    : "";
  return `<article class="ticket-card ${canDrag ? "human-movable" : "system-owned"}" data-ticket-card data-ticket-id="${escapeHtml(ticket.id)}" data-status="${escapeHtml(columnForStatus(status))}" role="button" aria-labelledby="ticket-title-${safeId}" aria-haspopup="dialog" aria-controls="ticket-drawer" aria-expanded="${selectedTicketId === ticket.id ? "true" : "false"}" draggable="${canDrag}" tabindex="0"><div class="ticket-card-topline"><span class="ticket-contract-label">Work contract</span>${chip(status)}</div><h3 id="ticket-title-${safeId}">${escapeHtml(ticket.title)}</h3><p class="ticket-objective"><span>Objective</span> ${escapeHtml(ticket.purpose)}</p><div class="ticket-facts">${repository ? `<span title="Pinned repository"><strong>${escapeHtml(repository.owner)}/${escapeHtml(repository.name)}</strong> · base ${escapeHtml(target?.base ?? "—")}</span>` : ""}${criteria.length ? `<span title="Acceptance criteria">${criteria.length} acceptance condition${criteria.length === 1 ? "" : "s"}</span>` : ""}</div>${scope.length ? `<div class="ticket-scope" aria-label="Allowed file scope">${scope.slice(0, 3).map((file) => `<code>${escapeHtml(file)}</code>`).join("")}${scope.length > 3 ? `<span class="badge">+${scope.length - 3} files</span>` : ""}</div>` : ""}<div class="ticket-card-meta">${authorizationBadge}${claimBadge}${attemptBadge}${findingsBadge}${dependencyBlocked ? `<span class="badge dependency-badge">Dependency blocked</span>` : ticket.dependsOn.length ? `<span class="badge">${ticket.dependsOn.length} dependenc${ticket.dependsOn.length === 1 ? "y" : "ies"}</span>` : ""}</div>${renderTicketSignal(ticket, view, status)}</article>`;
}

function renderTicketSignal(ticket, view, status) {
  const evidence = ticketEvidence(ticket, view);
  const activity = ticketActivity(ticket, view);
  const review = latestReview(ticket, view);
  const approval = isDeliveryTicket(ticket, view) ? deliveryApproval(view) : undefined;
  const delivery = isDeliveryTicket(ticket, view) ? deliveryResult(view) : undefined;
  if (status === "backlog") return `<p class="ticket-signal gate-signal"><strong>Human gate:</strong> move to Ready to authorize execution.</p>`;
  if (status === "ready") {
    if (reworkAuthorizationReady(ticket)) {
      const findings = requestedChanges(ticket);
      return `<div class="ticket-signal ready-signal rework-ready-signal"><strong>Rework authorized</strong><span>Attempt ${ticket.attempt + 1} is ready for a bounded TrueForge pass.</span>${findings.length ? `<span>${findings.length} unresolved finding${findings.length === 1 ? "" : "s"} remain in the repair context.</span>` : ""}</div>`;
    }
    return `<p class="ticket-signal ready-signal"><strong>Authorized</strong> by ${escapeHtml(ticket.executionAuthorization?.authorizedBy ?? "human operator")} · waiting for TrueForge claim.</p>`;
  }
  if (status === "in_progress") {
    const claim = ticket.claim;
    const latest = activity[0];
    return `<div class="ticket-signal runtime-signal"><strong>TrueForge active · attempt ${ticket.attempt || "—"}</strong><span>${claim?.trueforgeSessionId ? "session " + escapeHtml(shortRef(claim.trueforgeSessionId)) : "session connected"}${claim?.trueforgeSandboxId ? " · sandbox " + escapeHtml(shortRef(claim.trueforgeSandboxId)) : ""}</span>${latest ? `<span>${escapeHtml(latest.summary)}</span>` : "<span>Awaiting the next durable activity record.</span>"}</div>`;
  }
  if (status === "proving") {
    const passed = evidence.filter((item) => item.result === "passed").length;
    const failed = evidence.filter((item) => item.result === "failed").length;
    return `<p class="ticket-signal proof-signal"><strong>Deterministic proof · attempt ${ticket.attempt || "—"}</strong> · ${passed} passed${failed ? " · " + failed + " failed" : ""}${ticket.requiredChecks?.length ? " · " + ticket.requiredChecks.length + " required check" + (ticket.requiredChecks.length === 1 ? "" : "s") : ""}</p>`;
  }
  if (status === "changes_requested") {
    const findings = requestedChanges(ticket);
    const finding = findings[0] ?? ticket.blockedReason ?? review?.finding ?? "Concrete repair facts are recorded in the drawer.";
    return `<div class="ticket-signal repair-signal"><strong>Human rework gate</strong><span>${escapeHtml(finding)}${findings.length > 1 ? ` · +${findings.length - 1} more durable finding${findings.length === 2 ? "" : "s"}` : ""}</span><span>Move to Ready to authorize bounded attempt ${(ticket.attempt ?? 0) + 1}.</span></div>`;
  }
  if (status === "awaiting_approval") return `<p class="ticket-signal approval-signal"><strong>Human approval gate:</strong> ${escapeHtml(approval?.action ?? "Create the verified pull request")}</p>`;
  if (status === "delivering") return `<p class="ticket-signal delivery-signal"><strong>Human approval recorded:</strong> ${escapeHtml(approval?.target ?? "Approved exact action")} · awaiting read-back.</p>`;
  if (status === "blocked") return `<p class="ticket-signal blocked-signal"><strong>Blocked / error:</strong> ${escapeHtml(ticket.blockedReason ?? review?.finding ?? "Pipeline stopped; inspect the diagnostic record.")}</p>`;
  if (status === "done") return `<p class="ticket-signal done-signal"><strong>${delivery?.pullRequest ? "Pull request #" + escapeHtml(delivery.pullRequest.number) : "Verified delivery"}</strong> · ${escapeHtml(delivery?.verificationSummary ?? "Verified delivery state is durable.")}</p>`;
  return `<p class="ticket-signal">${escapeHtml(humanLabel(status))}</p>`;
}

function renderApprovalCheckpoint(view) {
  const approval = deliveryApproval(view);
  const delivery = deliveryResult(view);
  const authorized = ticketsForView(view).some((ticket) => ticket.executionAuthorization !== undefined);
  return `<section class="checkpoint-grid" aria-label="Approval and delivery checkpoint"><article class="checkpoint-panel panel"><div class="checkpoint-heading"><div><p class="section-kicker">Human authorization</p><h2>Backlog → Ready</h2></div>${chip(approval ? approval.decision : authorized ? "approved" : "backlog")}</div><p>Moving a ticket into Ready is the explicit authorization for autonomous execution. After claim, lifecycle movement belongs to the pipeline.</p><p class="checkpoint-note">${authorized ? "Authorization is recorded with the ticket and survives reconnect." : "No ticket has been authorized yet."}</p></article><article class="checkpoint-panel panel" aria-labelledby="approval-checkpoint-title"><div class="checkpoint-heading"><div><p class="section-kicker">Protected delivery</p><h2 id="approval-checkpoint-title">${approval ? escapeHtml(approval.action) : "No delivery action requested"}</h2></div>${approval ? chip(approval.decision) : ""}</div>${approval ? renderApprovalBody(approval) : "<p>Verified work will surface the exact repository, base, head, and expected effect here before any remote mutation.</p>"}${delivery ? renderDeliveryBody(delivery) : ""}</article></section>`;
}

function renderApprovalBody(approval) {
  const correlation = [
    approval.workItemId ? `ticket ${shortRef(approval.workItemId)}` : "",
    approval.attempt ? `attempt ${approval.attempt}` : "",
    approval.trueforgeSandboxId ? `sandbox ${shortRef(approval.trueforgeSandboxId)}` : "",
    approval.executionContext?.headSha ? `head ${shortRef(approval.executionContext.headSha)}` : "",
  ].filter(Boolean).join(" · ");
  return `<div class="approval-facts"><p><span>Target</span><strong>${escapeHtml(approval.target)}</strong></p><p><span>Expected effect</span><strong>${escapeHtml(approval.expectedEffect)}</strong></p><p><span>Rationale</span><strong>${escapeHtml(approval.rationale)}</strong></p></div>${correlation ? `<p class="runtime-correlation"><strong>Correlated artifact:</strong> ${escapeHtml(correlation)}</p>` : ""}${approval.executionContext ? `<p class="runtime-correlation"><strong>TrueForge provenance:</strong> session ${escapeHtml(shortRef(approval.executionContext.sessionId))} · turn ${escapeHtml(shortRef(approval.executionContext.turnId))} · call ${escapeHtml(shortRef(approval.executionContext.toolCallId))}</p>` : ""}${approval.decision === "pending" ? `<p class="approval-gate-note"><strong>Second human gate:</strong> approve this exact verified action to begin protected delivery.</p><div class="approval-actions" aria-label="Delivery approval decision"><button class="primary-action compact-action" type="button" data-approval-id="${escapeHtml(approval.id)}" data-approval-decision="approved">Approve exact action</button><button class="compact-action" type="button" data-approval-id="${escapeHtml(approval.id)}" data-approval-decision="rejected">Reject</button><button class="compact-action" type="button" data-approval-id="${escapeHtml(approval.id)}" data-approval-decision="cancelled">Cancel</button></div>` : ""}${approval.decision === "approved" ? `<p class="approval-outcome">Approved. Waiting for correlated remote result evidence while protected delivery runs; it is not Done until the exact result is verified.</p>` : ""}${approval.decision === "rejected" ? `<p class="approval-outcome">Rejected. The protected repository operation was not executed.</p>` : ""}${approval.decision === "cancelled" ? `<p class="approval-outcome">Cancelled. The protected repository operation was not executed.</p>` : ""}`;
}

function renderDeliveryBody(delivery) {
  const pullRequestUrl = safePullRequestUrl(delivery.reference);
  return `<div class="delivery-result delivery-card"><p><strong>Delivered pull request read-back:</strong> ${escapeHtml(delivery.verificationSummary)}</p>${delivery.pullRequest ? `<p><strong>Repository:</strong> ${escapeHtml(delivery.pullRequest.repositoryOwner)}/${escapeHtml(delivery.pullRequest.repositoryName)} · ${escapeHtml(delivery.pullRequest.head)} → ${escapeHtml(delivery.pullRequest.base)}${delivery.pullRequest.headSha ? ` · head ${escapeHtml(shortRef(delivery.pullRequest.headSha))}` : ""}</p>` : ""}${delivery.attempt ? `<p><strong>Correlated attempt:</strong> ${escapeHtml(delivery.attempt)}</p>` : ""}${pullRequestUrl ? `<p><a href="${escapeHtml(pullRequestUrl)}" target="_blank" rel="noreferrer">Open delivered pull request</a></p>` : ""}</div>`;
}

function renderTicketDrawer(ticket, view) {
  if (ticket === undefined) return "";
  const status = effectiveStatus(ticket, view);
  const evidence = ticketEvidence(ticket, view);
  const activity = ticketActivity(ticket, view);
  const reviews = ticketReviews(ticket, view);
  const attempt = latestAttempt(ticket);
  const approval = isDeliveryTicket(ticket, view) ? deliveryApproval(view) : undefined;
  const delivery = isDeliveryTicket(ticket, view) ? deliveryResult(view) : undefined;
  const repository = view.mission.repository;
  const target = view.mission.deliveryTarget;
  const dependencies = ticket.dependsOn.map((dependencyId) => {
    const dependency = ticketById(view, dependencyId);
    return `<li>${escapeHtml(dependency?.title ?? dependencyId)}${dependency ? " · " + chip(effectiveStatus(dependency)) : ""}</li>`;
  }).join("");
  return `<aside id="ticket-drawer" class="ticket-drawer" role="dialog" aria-modal="false" aria-labelledby="ticket-drawer-title" tabindex="-1"><header class="drawer-header"><div><p class="drawer-eyebrow">Proof ticket · ${escapeHtml(ticket.assignedRole ?? "pipeline")}</p><h2 id="ticket-drawer-title">${escapeHtml(ticket.title)}</h2></div><button id="close-ticket-drawer" class="compact-action" type="button" aria-label="Close ticket drawer">Close</button></header><div class="drawer-status-row">${chip(status)}${ticket.attempt > 0 ? `<span class="badge attempt-badge">Attempt ${ticket.attempt}</span>` : ""}${ticket.executionAuthorization ? `<span class="badge authorization-badge">Authorized by ${escapeHtml(ticket.executionAuthorization.authorizedBy)}</span>` : ""}${ticket.claim ? `<span class="badge">${status === "changes_requested" ? "Prior claim" : "Claimed"} by ${escapeHtml(ticket.claim.owner)}</span>` : ""}</div><section class="drawer-section"><p class="section-kicker">Objective</p><p class="drawer-objective">${escapeHtml(ticket.purpose)}</p></section><section class="drawer-section"><p class="section-kicker">Work contract</p><dl class="ticket-meta">${repository ? `<div><dt>Repository</dt><dd>${escapeHtml(repository.owner)}/${escapeHtml(repository.name)}</dd></div><div><dt>Base</dt><dd>${escapeHtml(target?.base ?? "—")}</dd></div><div><dt>Pinned ref</dt><dd><code>${escapeHtml(repository.ref)}</code></dd></div>` : ""}<div><dt>Allowed files</dt><dd>${ticket.allowedFiles?.length ? ticket.allowedFiles.map((file) => `<code>${escapeHtml(file)}</code>`).join("<br>") : "Mission scope"}</dd></div><div><dt>Required checks</dt><dd>${ticket.requiredChecks?.length ? ticket.requiredChecks.join(", ") : "Pipeline-defined"}</dd></div><div><dt>Attempt</dt><dd>${ticket.attempt > 0 ? ticket.attempt : "Not claimed"}</dd></div><div><dt>Claim</dt><dd>${ticket.claim ? escapeHtml(ticket.claim.owner) + " · " + escapeHtml(formatTime(ticket.claim.claimedAt)) : "Unclaimed"}</dd></div><div><dt>TrueForge binding</dt><dd>${ticket.claim?.trueforgeSessionId ? `session ${escapeHtml(shortRef(ticket.claim.trueforgeSessionId))}` : attempt?.claim?.trueforgeSessionId ? `session ${escapeHtml(shortRef(attempt.claim.trueforgeSessionId))}` : "Not connected"}${ticket.claim?.trueforgeSandboxId ? ` · sandbox ${escapeHtml(shortRef(ticket.claim.trueforgeSandboxId))}` : attempt?.claim?.trueforgeSandboxId ? ` · sandbox ${escapeHtml(shortRef(attempt.claim.trueforgeSandboxId))}` : ""}</dd></div></dl></section><section class="drawer-section"><p class="section-kicker">Acceptance</p><ul class="acceptance-list">${ticket.acceptanceCriteria?.map((criterion) => `<li>${escapeHtml(criterion)}</li>`).join("") || "<li>No acceptance conditions recorded.</li>"}</ul></section><section class="drawer-section"><p class="section-kicker">Dependencies</p><ul class="dependency-list">${dependencies || "<li>None</li>"}</ul>${ticket.blockedReason ? `<p class="drawer-failure"><strong>Blocker:</strong> ${escapeHtml(ticket.blockedReason)}</p>` : ""}</section>${renderReworkContext(ticket, status)}<section class="drawer-section drawer-gate"><p class="section-kicker">Authorization</p>${renderDrawerAuthorization(ticket, view)}</section><section class="drawer-section"><p class="section-kicker">Current state</p>${renderTicketSignal(ticket, view, status)}${approval ? `<div class="drawer-approval">${renderApprovalBody(approval)}</div>` : ""}${delivery ? renderDeliveryBody(delivery) : ""}</section><section class="drawer-section"><p class="section-kicker">Attempt history</p>${renderAttemptHistory(ticket)}</section><section class="drawer-section"><p class="section-kicker">Review history</p>${renderReviewHistory(reviews)}</section><section class="drawer-section"><p class="section-kicker">TrueForge activity</p>${renderTicketActivity(activity)}</section><section class="drawer-section"><p class="section-kicker">Ticket evidence</p>${renderTicketEvidence(evidence)}</section></aside>`;
}

function renderReworkContext(ticket, status) {
  const findings = requestedChanges(ticket);
  if (findings.length === 0 && status !== "changes_requested" && !reworkAuthorizationReady(ticket)) return "";
  const message = status === "changes_requested"
    ? `Review the durable findings below, then move this ticket to Ready to authorize bounded attempt ${(ticket.attempt ?? 0) + 1}.`
    : "These findings remain attached to the ticket as context for the next bounded pass; implementation narration cannot resolve them.";
  return `<section class="drawer-section drawer-rework"><p class="section-kicker">Rework context</p><p>${escapeHtml(message)}</p>${findings.length ? `<ul class="finding-list">${findings.map((finding) => `<li>${escapeHtml(finding)}</li>`).join("")}</ul>` : `<p class="drawer-empty">No unresolved findings are attached to this authorization.</p>`}</section>`;
}

function renderAttemptHistory(ticket) {
  const attempts = [...(ticket.attempts ?? [])].reverse();
  if (attempts.length === 0) return `<p class="drawer-empty">No claimed attempt has started yet.</p>`;
  return `<div class="attempt-history">${attempts.map((attempt) => `<article class="attempt-card" data-attempt-status="${escapeHtml(attempt.status)}"><div class="attempt-card-header"><div><strong>Attempt ${attempt.number}</strong>${chip(attempt.status)}</div><span>Authorized by ${escapeHtml(attempt.authorization.authorizedBy)}</span></div><p class="attempt-binding">Claimed by ${escapeHtml(attempt.claim.owner)} at ${escapeHtml(formatTime(attempt.claim.claimedAt))}${attempt.claim.trueforgeSessionId ? ` · session ${escapeHtml(shortRef(attempt.claim.trueforgeSessionId))}` : ""}${attempt.claim.trueforgeSandboxId ? ` · sandbox ${escapeHtml(shortRef(attempt.claim.trueforgeSandboxId))}` : ""}</p>${attempt.requestedChanges?.length ? `<ul class="finding-list">${attempt.requestedChanges.map((finding) => `<li>${escapeHtml(finding)}</li>`).join("")}</ul>` : `<p class="attempt-no-findings">No requested delta recorded for this attempt.</p>`}${attempt.retiredAt ? `<p class="attempt-retired">Retired by ${escapeHtml(attempt.retiredBy ?? "human operator")} at ${escapeHtml(formatTime(attempt.retiredAt))}.</p>` : ""}</article>`).join("")}</div>`;
}

function renderReviewHistory(reviews) {
  if (reviews.length === 0) return `<p class="drawer-empty">No independent review finding recorded yet.</p>`;
  return `<div class="review-history">${[...reviews].reverse().map((review) => `<article class="review-history-card" data-outcome="${escapeHtml(review.outcome)}"><div class="review-history-header"><div>${chip(review.outcome, "result")}${review.attempt === undefined ? `<span class="badge">Historical</span>` : `<span class="badge">Attempt ${review.attempt}</span>`}</div><span>${escapeHtml(review.reviewer)} · ${escapeHtml(formatTime(review.createdAt))}</span></div><p><strong>${escapeHtml(review.summary)}</strong></p><p>${escapeHtml(review.finding)}</p></article>`).join("")}</div>`;
}

function renderDrawerAuthorization(ticket, view) {
  const status = effectiveStatus(ticket);
  const approval = isDeliveryTicket(ticket, view) ? deliveryApproval(view) : undefined;
  if (status === "changes_requested") return `<p><strong>Human rework required.</strong> This hard stop cannot be retried by refresh, reconnect, or the pipeline. Moving it to Ready authorizes the next bounded pass.</p>${canHumanMove(ticket, "ready", view) ? `<button class="primary-action compact-action ticket-transition" type="button" data-ticket-transition="${escapeHtml(ticket.id)}" data-target-status="ready">Authorize bounded rework</button>` : `<p class="drawer-empty">A running delegation must finish before rework can be authorized.</p>`}`;
  if (status === "awaiting_approval") return `<p><strong>Second human gate: protected delivery approval.</strong> Deterministic proof and independent review are complete for attempt ${escapeHtml(ticket.attempt || "—")}. Review the exact target and approve it below; refresh and reconnect cannot authorize delivery.</p>`;
  if (status === "delivering") return `<p><strong>Delivery authorized.</strong> ${approval?.decidedBy ? `Approved by ${escapeHtml(approval.decidedBy)} at ${escapeHtml(formatTime(approval.decidedAt))}. ` : ""}The protected action and read-back are in progress. The ticket becomes Done only after the repository, base, head, and full head SHA match the approved artifact.</p>`;
  if (status === "done") return `<p><strong>Delivery verified.</strong> The ticket is Done because the protected result was read back and correlated to the approved attempt.</p>`;
  if (status === "blocked") return `<p><strong>Pipeline stopped.</strong> This ticket cannot be revived by refresh, retry, or stale approval. Inspect the durable finding and authorize a new bounded rework cycle if the queue permits it.</p>`;
  if (ticket.executionAuthorization) return `<p>${reworkAuthorizationReady(ticket) ? "Bounded rework is authorized" : "Authorized"} by <strong>${escapeHtml(ticket.executionAuthorization.authorizedBy)}</strong> at ${escapeHtml(formatTime(ticket.executionAuthorization.authorizedAt))}. This authorization remains attached after reconnect.</p>${reworkAuthorizationReady(ticket) ? `<p class="drawer-rework-note">The prior findings remain visible below and will be supplied to the next attempt.</p>` : ""}${canHumanMove(ticket, "backlog", view) ? `<button class="compact-action ticket-transition" type="button" data-ticket-transition="${escapeHtml(ticket.id)}" data-target-status="backlog">Return to Backlog</button>` : ""}`;
  if (ticket.status === "backlog") return `<p>This ticket is waiting for a human decision. Moving it to Ready authorizes TrueForge to claim and execute it.</p><button class="primary-action compact-action ticket-transition" type="button" data-ticket-transition="${escapeHtml(ticket.id)}" data-target-status="ready">Authorize execution</button>`;
  return `<p>Authorization details are not available for this ticket state.</p>`;
}

function renderTicketActivity(activity) {
  if (activity.length === 0) return `<p class="drawer-empty">No ticket-scoped activity recorded yet.</p>`;
  return `<ol class="drawer-activity">${activity.map((item) => `<li><span class="activity-marker"></span><div><strong>${escapeHtml(item.actor)}</strong><time datetime="${escapeHtml(item.createdAt)}">${escapeHtml(formatTime(item.createdAt))}</time><p>${escapeHtml(item.summary)}</p></div></li>`).join("")}</ol>`;
}

function renderTicketEvidence(evidence) {
  if (evidence.length === 0) return `<p class="drawer-empty">No ticket-scoped MCP or sandbox evidence recorded yet.</p>`;
  return `<div class="drawer-evidence">${evidence.map((item) => `<article class="drawer-evidence-card" data-result="${escapeHtml(item.result)}"><div><strong>${escapeHtml(item.source === "mcp" ? "Repository MCP" : "Sandbox")}</strong>${item.attempt === undefined ? "" : `<span class="badge">Attempt ${item.attempt}</span>`}${chip(item.result, "result")}</div><p>${escapeHtml(item.summary)}</p>${Object.keys(item.metadata ?? {}).length ? `<dl>${Object.entries(item.metadata).slice(0, 4).map(([key, value]) => `<div><dt>${escapeHtml(humanLabel(key))}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>` : ""}</article>`).join("")}</div>`;
}

function renderActivity(activity) {
  if (activity.length === 0) return `<p class="activity-empty">Runtime activity will appear here after the mission starts.</p>`;
  return `<ol class="operations-list">${activity.map((item) => `<li class="activity-item" data-result="${escapeHtml(item.result)}" data-category="${escapeHtml(item.category)}"><span class="activity-marker" aria-hidden="true"></span><div><div class="activity-head"><span class="activity-actor">${escapeHtml(item.actor)}</span><time datetime="${escapeHtml(item.createdAt)}">${escapeHtml(formatTime(item.createdAt))}</time></div><p>${escapeHtml(item.summary)}</p></div></li>`).join("")}</ol>`;
}

function renderEvidence(evidence) {
  if (evidence.length === 0) return `<p class="evidence-empty">No verified MCP or sandbox evidence has been recorded yet. Runtime narration never appears in this panel.</p>`;
  return `<div class="evidence-list">${evidence.map((item) => `<article class="evidence-card" data-source="${escapeHtml(item.source)}" data-result="${escapeHtml(item.result)}"><div class="evidence-head"><span class="evidence-source">${item.source === "mcp" ? "Repository MCP" : "Sandbox"}</span>${chip(item.result, "result")}</div><h3>${escapeHtml(item.summary)}</h3><p>${escapeHtml(item.workItemTitle ?? humanLabel(item.kind))} · <time datetime="${escapeHtml(item.createdAt)}">${escapeHtml(formatTime(item.createdAt))}</time></p>${Object.keys(item.metadata ?? {}).length ? `<dl class="evidence-meta">${Object.entries(item.metadata).map(([key, value]) => `<div><dt>${escapeHtml(humanLabel(key))}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>` : ""}</article>`).join("")}</div>`;
}

function renderDiagnostics(view) {
  const diagnostics = view.diagnostics;
  if (!diagnostics || (!diagnostics.failures?.length && !diagnostics.failedEvidence?.length)) return "";
  const latest = diagnostics.failures?.find((failure) => failure.evidenceId !== undefined) ?? diagnostics.failures?.find((failure) => !failure.id.startsWith("mission:")) ?? diagnostics.failures?.[0];
  const reason = latest?.reason ?? diagnostics.failedEvidence?.[0]?.reason ?? "No specific reason recorded.";
  const eventCount = diagnostics.events?.length ?? 0;
  return `<section class="diagnostics-panel panel" aria-labelledby="diagnostics-heading"><div class="section-heading diagnostics-heading"><div><p class="section-kicker">Failure record</p><h2 id="diagnostics-heading">Diagnostics</h2></div><button id="copy-diagnostics" class="compact-action" type="button">Copy diagnostic snapshot</button></div><div class="diagnostics-summary"><div><p class="diagnostics-reason">${escapeHtml(reason)}</p><p class="diagnostics-correlation">${escapeHtml(latest?.layer ?? "proof_board")} / ${escapeHtml(latest?.category ?? "pipeline")} · ${eventCount} correlated event${eventCount === 1 ? "" : "s"}</p></div><details><summary>Show failure details</summary><dl class="diagnostics-meta"><div><dt>Mission</dt><dd>${escapeHtml(diagnostics.mission.id)}</dd></div><div><dt>Status</dt><dd>${escapeHtml(humanLabel(diagnostics.mission.status))}</dd></div>${diagnostics.trueforge?.sessionId ? `<div><dt>Session</dt><dd>${escapeHtml(shortRef(diagnostics.trueforge.sessionId))}</dd></div>` : ""}${diagnostics.trueforge?.turnId ? `<div><dt>Turn</dt><dd>${escapeHtml(shortRef(diagnostics.trueforge.turnId))}</dd></div>` : ""}${diagnostics.trueforge?.sandboxId ? `<div><dt>Sandbox</dt><dd>${escapeHtml(shortRef(diagnostics.trueforge.sandboxId))}</dd></div>` : ""}</dl></details></div></section>`;
}

function bindMissionInteractions(view) {
  document.querySelector("#run-mission")?.addEventListener("click", runMission);
  document.querySelector("#copy-diagnostics")?.addEventListener("click", () => copyDiagnostics(view.diagnostics));
  document.querySelector("#close-ticket-drawer")?.addEventListener("click", closeTicketDrawer);
  document.querySelectorAll("[data-approval-decision]").forEach((button) => button.addEventListener("click", decideApproval));
  document.querySelectorAll("[data-ticket-transition]").forEach((button) => button.addEventListener("click", transitionTicket));
  document.querySelectorAll("[data-ticket-open]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    openTicket(button.dataset.ticketOpen, button);
  }));
  document.querySelectorAll("[data-ticket-card]").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest("button, a")) return;
      openTicket(card.dataset.ticketId, card);
    });
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openTicket(card.dataset.ticketId, card);
    });
    if (card.getAttribute("draggable") === "true") {
      card.addEventListener("dragstart", (event) => {
        boardDragInProgress = true;
        card.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", JSON.stringify({ id: card.dataset.ticketId, status: card.dataset.status }));
      });
      card.addEventListener("dragend", () => {
        boardDragInProgress = false;
        card.classList.remove("dragging");
        document.querySelectorAll(".ticket-column.is-drag-over").forEach((column) => column.classList.remove("is-drag-over"));
      });
    }
  });
  document.querySelectorAll(".ticket-column[data-drop-enabled=\"true\"]").forEach((column) => {
    column.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types?.includes("text/plain") || !["backlog", "ready"].includes(column.dataset.status)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      column.classList.add("is-drag-over");
    });
    column.addEventListener("dragleave", () => column.classList.remove("is-drag-over"));
    column.addEventListener("drop", async (event) => {
      event.preventDefault();
      column.classList.remove("is-drag-over");
      boardDragInProgress = false;
      const payload = parseDragPayload(event.dataTransfer?.getData("text/plain"));
      const ticket = ticketById(currentView, payload.id);
      if (!canHumanMove(ticket, column.dataset.status)) {
        showMessage("error", "Only Backlog ↔ Ready and Changes Requested → Ready are human transitions.");
        return;
      }
      await moveTicket(ticket, column.dataset.status);
    });
  });
}

function parseDragPayload(value) {
  try {
    const parsed = JSON.parse(value);
    return { id: parsed.id, status: parsed.status };
  } catch {
    return { id: value };
  }
}

function openTicket(ticketId, opener) {
  if (currentView === null || ticketById(currentView, ticketId) === undefined) return;
  selectedTicketId = ticketId;
  drawerOpener = opener;
  focusDrawerOnRender = true;
  renderMission(currentView);
}

function closeTicketDrawer() {
  const opener = drawerOpener;
  selectedTicketId = null;
  drawerOpener = null;
  focusDrawerOnRender = false;
  if (currentView !== null) renderMission(currentView);
  window.requestAnimationFrame(() => opener?.isConnected && opener.focus());
}

async function moveTicket(ticket, targetStatus, button = null) {
  const isRework = ticket.status === "changes_requested" && targetStatus === "ready";
  await withBusy(button, async () => {
    try {
      await api("/api/mission/tickets/" + encodeURIComponent(ticket.id) + "/status", {
        method: "PATCH",
        body: JSON.stringify({ status: targetStatus, actor: HUMAN_ACTOR, expected_revision: currentView.revision }),
      });
      await refreshMission({ force: true });
      setConnection("connected", isRework ? "Rework authorized" : targetStatus === "ready" ? "Execution authorized" : "Queue decision saved");
      showMessage("success", isRework ? "Bounded rework authorized; the prior findings remain attached." : targetStatus === "ready" ? "Ticket authorized and ready for TrueForge." : "Ticket returned to Backlog.");
    } catch (error) {
      setConnection("failed", "Queue update failed");
      showMessage("error", error.message);
      if (error.payload?.mission) runCoordinator.accept(error.payload.mission, { force: true, authoritative: true });
    }
  });
}

async function transitionTicket(event) {
  event.preventDefault();
  event.stopPropagation();
  const ticket = ticketById(currentView, event.currentTarget.dataset.ticketTransition);
  const target = event.currentTarget.dataset.targetStatus;
  if (canHumanMove(ticket, target)) await moveTicket(ticket, target, event.currentTarget);
  else showMessage("error", "That lifecycle transition is owned by the Proof Board pipeline.");
}

async function copyDiagnostics(snapshot) {
  const content = JSON.stringify(snapshot, null, 2);
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(content);
      showMessage("success", "Diagnostic snapshot copied.");
      return;
    }
  } catch {
    // Fall back to a local download when clipboard permissions are unavailable.
  }
  const blob = new Blob([content], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "mission-diagnostics-" + snapshot.mission.id + ".json";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
  showMessage("success", "Diagnostic snapshot exported locally.");
}

async function createMission(event) {
  await withBusy(event.currentTarget, async () => {
    try {
      const payload = await api("/api/mission", { method: "POST" });
      runCoordinator.accept(payload.mission, { force: true, authoritative: true });
      setConnection("connected", "Durable queue ready");
      showMessage("success", "Primary ticket created in Backlog.");
    } catch (error) {
      setConnection("failed", "Operation failed");
      showMessage("error", error.message);
      if (error.payload?.mission) runCoordinator.accept(error.payload.mission, { force: true, authoritative: true });
    }
  });
}

async function runMission(event) {
  event.preventDefault();
  if (runCoordinator.isRunning()) return;
  if (!canStartMission(currentView)) {
    showMessage("error", "Authorize the primary ticket by moving it from Backlog to Ready first.");
    return;
  }
  try {
    await runCoordinator.run();
    setConnection("connected", "State persisted");
    showMessage("success", "TrueForge run completed with durable verification evidence.");
  } catch (error) {
    setConnection("failed", "Run failed closed");
    showMessage("error", error.message);
  }
}

async function decideApproval(event) {
  const button = event.currentTarget;
  await withBusy(button, async () => {
    try {
      const payload = await api("/api/mission/approvals/" + encodeURIComponent(button.dataset.approvalId), {
        method: "POST",
        body: JSON.stringify({
          decision: button.dataset.approvalDecision,
          actor: HUMAN_ACTOR,
          expected_revision: currentView?.revision,
        }),
      });
      runCoordinator.accept(payload.mission, { force: true, authoritative: true });
      setConnection("connected", "Decision persisted");
      showMessage("success", button.dataset.approvalDecision === "approved" ? "Approved action completed with durable pull request evidence." : "Delivery " + button.dataset.approvalDecision + "; no protected repository operation was executed.");
    } catch (error) {
      setConnection("failed", "Decision failed");
      showMessage("error", error.message);
      if (error.payload?.mission) runCoordinator.accept(error.payload.mission, { force: true, authoritative: true });
    }
  });
}

async function withBusy(button, operation) {
  if (button === null) {
    await operation();
    return;
  }
  if (!(button instanceof HTMLButtonElement) || button.getAttribute("aria-busy") === "true") return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    await operation();
  } finally {
    button.removeAttribute("aria-busy");
    if (button.isConnected) button.disabled = false;
  }
}

async function refreshMission({ force = false } = {}) {
  const payload = await api("/api/mission");
  if (payload.mission === null) {
    renderEmpty();
    return payload;
  }
  runCoordinator.accept(payload.mission, { force, authoritative: force });
  return payload;
}

async function pollMission() {
  if (document.hidden || boardDragInProgress || runCoordinator?.isRunning() || pollInFlight) return;
  pollInFlight = true;
  try {
    const payload = await api("/api/mission");
    if (payload.mission === null) {
      // A delayed empty response must not erase a mission recovered or
      // created by a newer request.
      if (currentView === null) renderEmpty();
      return;
    }
    const accepted = runCoordinator.accept(payload.mission);
    if (accepted || connectionState.classList.contains("failed")) setConnection("connected", "State synced");
  } catch (error) {
    setConnection("failed", "Reconnecting…");
    if (currentView === null) showMessage("error", error.message);
  } finally {
    pollInFlight = false;
  }
}

function startMissionPolling() {
  if (pollHandle === null) pollHandle = window.setInterval(pollMission, POLL_INTERVAL_MS);
}

async function loadMission() {
  const loadSequence = ++missionLoadSequence;
  try {
    const payload = await api("/api/mission");
    if (loadSequence !== missionLoadSequence) return;
    if (payload.mission === null) renderEmpty();
    else runCoordinator.accept(payload.mission, { force: true, authoritative: true });
    setConnection("connected", payload.mission ? "State recovered" : "Ready");
    startMissionPolling();
  } catch (error) {
    if (loadSequence !== missionLoadSequence) return;
    setConnection("failed", "Unavailable");
    showMessage("error", error.message);
    app.innerHTML = `<section class="empty-state panel"><p class="eyebrow">Connection error</p><h1>Mission state could not be loaded.</h1><p>${escapeHtml(error.message)}</p><button id="retry-load" type="button">Retry</button></section>`;
    document.querySelector("#retry-load")?.addEventListener("click", loadMission);
  }
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && selectedTicketId !== null) {
    closeTicketDrawer();
  }
});

runCoordinator = MissionRunState.createRunCoordinator({
  start: () => api("/api/mission/run", { method: "POST" }),
  refresh: () => api("/api/mission"),
  onState: (view) => renderMission(view),
  onRunStart: () => clearMessage(),
  onRunningChange: (running, view) => {
    if (view) renderMission(view);
    if (running) setConnection("connected", "TrueForge running");
  },
});

loadMission();
