const app = document.querySelector("#app");
const connectionState = document.querySelector("#connection-state");
const messageRegion = document.querySelector("#message");
let runCoordinator;

const labels = {
  draft: "Draft",
  planning: "Planning",
  executing: "Executing",
  awaiting_approval: "Awaiting approval",
  verifying: "Verifying",
  delivered: "Delivered",
  failed: "Failed",
  blocked: "Blocked",
  backlog: "Queued",
  ready: "Ready",
  in_progress: "In progress",
  ready_for_review: "Proof pending",
  complete: "Complete",
  not_started: "Not started",
  running: "Running",
  passed: "Passed",
  informational: "Info",
  pending: "Pending approval",
  approved: "Approved execution",
  rejected: "Rejected delivery",
  cancelled: "Cancelled delivery",
  commitSha: "Commit SHA",
  contentHash: "Content hash",
  contentBytes: "Content bytes",
  exitCode: "Exit code",
  tool: "Tool",
  server: "Server",
  reason: "Reason",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function semanticClass(prefix, value) {
  return `${prefix}-${String(value).replaceAll("_", "-")}`;
}

function humanLabel(value) {
  return labels[value] ?? String(value).replaceAll("_", " ");
}

function chip(value, prefix = "status") {
  return `<span class="chip ${prefix}-chip ${semanticClass(prefix, value)}">${escapeHtml(humanLabel(value))}</span>`;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function shortRef(value) {
  return String(value).length > 12 ? String(value).slice(0, 12) : String(value);
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
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.message ?? "Request failed.");
    error.payload = payload;
    throw error;
  }
  return payload;
}

function setConnection(kind, label) {
  connectionState.className = `connection-state ${kind}`;
  connectionState.textContent = label;
}

function showMessage(kind, text) {
  messageRegion.replaceChildren();
  const toast = document.createElement("div");
  toast.className = `toast toast-${kind}`;
  toast.setAttribute("role", kind === "error" ? "alert" : "status");
  toast.textContent = text;
  messageRegion.append(toast);
  if (kind === "success") {
    window.setTimeout(() => toast.remove(), 3500);
  }
}

function clearMessage() {
  messageRegion.replaceChildren();
}

function renderEmpty() {
  app.innerHTML = `
    <section class="empty-state panel">
      <p class="eyebrow">Mission Control</p>
      <h1>Start with one bounded software mission.</h1>
      <p>Create the primary mission to connect a durable work contract to repository inspection, sandbox execution, and verified evidence.</p>
      <button id="create-mission" class="primary-action" type="button">Create primary mission</button>
    </section>`;
  document.querySelector("#create-mission")?.addEventListener("click", createMission);
}

function renderMission(view) {
  const mission = view.mission;
  const repository = mission.repository;
  const terminal = ["delivered", "failed"].includes(mission.status);
  const runInFlight = runCoordinator?.isRunning() ?? false;
  const runLabel = runInFlight
    ? "Mission running…"
    : mission.status === "awaiting_approval"
    ? "Approval required"
    : mission.status === "verifying"
    ? "Verification current"
    : mission.status === "blocked"
    ? "Retry mission"
    : "Run mission";
  const verificationClass = view.progress.verification === "failed" ? "bad" :
    view.progress.verification === "passed" ? "good" : "";
  const executionClass = view.progress.execution === "failed" ? "bad" :
    view.progress.execution === "passed" ? "good" : "";

  app.innerHTML = `
    <section class="mission-header panel" aria-labelledby="mission-objective">
      <div class="mission-header-main">
        <div class="mission-title-row">
          <p class="eyebrow">Active mission</p>
          ${chip(mission.status)}
        </div>
        <h1 id="mission-objective" class="mission-objective">${escapeHtml(mission.objective)}</h1>
        <p class="mission-meta">
          <span><strong>Repository</strong> ${repository ? `${escapeHtml(repository.owner)}/${escapeHtml(repository.name)}` : "Not attached"}</span>
          ${repository ? `<span><strong>Ref</strong> <span title="${escapeHtml(repository.ref)}">${escapeHtml(shortRef(repository.ref))}</span></span>` : ""}
          <span><strong>Runtime</strong> ${mission.execution.connected ? "Session connected" : "Not connected"}</span>
          <span><strong>State rev</strong> ${escapeHtml(view.revision)}</span>
        </p>
      </div>
      <div class="mission-actions">
        <button id="run-mission" class="primary-action" type="button" ${terminal || ["awaiting_approval", "verifying"].includes(mission.status) || runInFlight ? "disabled" : ""} ${runInFlight ? 'aria-busy="true"' : ""}>${escapeHtml(runLabel)}</button>
      </div>
    </section>

    <section class="metrics-strip" aria-label="Mission verification summary">
      <div class="metric"><span class="metric-label">Work complete</span><span class="metric-value">${view.progress.complete} / ${view.progress.total}</span></div>
      <div class="metric"><span class="metric-label">Verified evidence</span><span class="metric-value good">${view.progress.passedEvidence}</span></div>
      <div class="metric"><span class="metric-label">Failed checks</span><span class="metric-value ${view.progress.failedEvidence ? "bad" : ""}">${view.progress.failedEvidence}</span></div>
      <div class="metric"><span class="metric-label">Execution</span><span class="metric-value ${executionClass}">${escapeHtml(humanLabel(view.progress.execution))}</span></div>
      <div class="metric"><span class="metric-label">Verification</span><span class="metric-value ${verificationClass}">${escapeHtml(humanLabel(view.progress.verification))}</span></div>
    </section>

    <div class="section-heading">
      <div><p class="section-kicker">Structured work</p><h2>Plan → Execute → Prove → Approve</h2></div>
      <p class="section-note">Durable work state, recovered on refresh</p>
    </div>
    <section class="work-board" aria-label="Mission work stages">
      ${view.lanes.map((lane) => renderLane(lane, view)).join("")}
    </section>

    <div class="section-heading">
      <div><p class="section-kicker">Operational record</p><h2>Activity and evidence</h2></div>
      <p class="section-note"><span class="proof-boundary">Verified boundary</span></p>
    </div>
    <section class="operations-grid">
      <article class="operations-panel panel" aria-labelledby="activity-heading">
        <header class="operations-panel-header">
          <div><p class="section-kicker">Runtime</p><h2 id="activity-heading">Activity</h2></div>
          <span class="badge">${view.activity.length}</span>
        </header>
        ${renderActivity(view.activity)}
      </article>
      <article class="operations-panel panel" aria-labelledby="evidence-heading">
        <header class="operations-panel-header">
          <div><p class="section-kicker">Proof records</p><h2 id="evidence-heading">Evidence</h2></div>
          <span class="badge">MCP + Sandbox only</span>
        </header>
        ${renderEvidence(view.evidence)}
      </article>
    </section>
    ${renderDiagnostics(view)}
    `;

  document.querySelector("#run-mission")?.addEventListener("click", runMission);
  document.querySelector("#copy-diagnostics")?.addEventListener("click", () => copyDiagnostics(view.diagnostics));
  document.querySelectorAll("[data-approval-decision]").forEach((button) => {
    button.addEventListener("click", decideApproval);
  });
}

function renderDiagnostics(view) {
  const diagnostics = view.diagnostics;
  if (!diagnostics || (!diagnostics.failures?.length && !diagnostics.failedEvidence?.length)) {
    return "";
  }
  const latest = diagnostics.failures?.find((failure) => failure.evidenceId !== undefined) ??
    diagnostics.failures?.find((failure) => !failure.id.startsWith("mission:")) ??
    diagnostics.failures?.[0];
  const reason = latest?.reason ?? diagnostics.failedEvidence?.[0]?.reason ?? "No specific reason recorded.";
  const eventCount = diagnostics.events?.length ?? 0;
  return `
    <section class="diagnostics-panel panel" aria-labelledby="diagnostics-heading">
      <div class="section-heading diagnostics-heading">
        <div><p class="section-kicker">Failure record</p><h2 id="diagnostics-heading">Diagnostics</h2></div>
        <button id="copy-diagnostics" class="compact-action" type="button">Copy diagnostic snapshot</button>
      </div>
      <div class="diagnostics-summary">
        <div>
          <p class="diagnostics-reason">${escapeHtml(reason)}</p>
          <p class="diagnostics-correlation">${escapeHtml(latest?.layer ?? "proof_board")} / ${escapeHtml(latest?.category ?? "pipeline")} · ${eventCount} correlated event${eventCount === 1 ? "" : "s"}</p>
        </div>
        <details>
          <summary>Show failure details</summary>
          <dl class="diagnostics-meta">
            <div><dt>Mission</dt><dd>${escapeHtml(diagnostics.mission.id)}</dd></div>
            <div><dt>Status</dt><dd>${escapeHtml(humanLabel(diagnostics.mission.status))}</dd></div>
            ${diagnostics.trueforge?.sessionId ? `<div><dt>Session</dt><dd>${escapeHtml(shortRef(diagnostics.trueforge.sessionId))}</dd></div>` : ""}
            ${diagnostics.trueforge?.turnId ? `<div><dt>Turn</dt><dd>${escapeHtml(shortRef(diagnostics.trueforge.turnId))}</dd></div>` : ""}
            ${diagnostics.trueforge?.sandboxId ? `<div><dt>Sandbox</dt><dd>${escapeHtml(shortRef(diagnostics.trueforge.sandboxId))}</dd></div>` : ""}
          </dl>
        </details>
      </div>
    </section>`;
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
  link.download = `mission-diagnostics-${snapshot.mission.id}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
  showMessage("success", "Diagnostic snapshot exported locally.");
}

function renderLane(lane, view) {
  const approvalCards = lane.id === "approve"
    ? view.approvals.map((approval) => `
        <article class="work-card approval-card" data-approval-state="${escapeHtml(approval.decision)}">
          <h4>${escapeHtml(approval.action)}</h4>
          <p><strong>Target:</strong> ${escapeHtml(approval.target)}</p>
          <p>${escapeHtml(approval.expectedEffect)}</p>
          <p class="work-card-secondary">${escapeHtml(approval.rationale)}</p>
          ${approval.executionContext ? `<p class="runtime-correlation"><strong>TrueForge:</strong> session ${escapeHtml(shortRef(approval.executionContext.sessionId))} · turn ${escapeHtml(shortRef(approval.executionContext.turnId))} · call ${escapeHtml(shortRef(approval.executionContext.toolCallId))}</p>` : ""}
          <div class="work-card-meta">${chip(approval.decision)}</div>
          ${approval.decision === "pending" ? `
            <div class="approval-actions" aria-label="Delivery approval decision">
              <button class="primary-action compact-action" type="button" data-approval-id="${escapeHtml(approval.id)}" data-approval-decision="approved">Approve exact action</button>
              <button class="compact-action" type="button" data-approval-id="${escapeHtml(approval.id)}" data-approval-decision="rejected">Reject</button>
              <button class="compact-action" type="button" data-approval-id="${escapeHtml(approval.id)}" data-approval-decision="cancelled">Cancel</button>
            </div>` : ""}
          ${approval.decision === "approved" && view.delivery.length === 0 ? `<p class="approval-outcome">Approved. Waiting for correlated remote result evidence; delivery is not yet proven.</p>` : ""}
          ${approval.decision === "rejected" ? `<p class="approval-outcome">Rejected. The protected repository operation was not executed.</p>` : ""}
          ${approval.decision === "cancelled" ? `<p class="approval-outcome">Cancelled. The protected repository operation was not executed.</p>` : ""}
        </article>`).join("")
    : "";
  const deliveryCards = lane.id === "approve"
    ? view.delivery.map((delivery) => {
        const pullRequestUrl = safePullRequestUrl(delivery.reference);
        return `
        <article class="work-card delivery-card" data-delivery-state="${escapeHtml(delivery.status)}">
          <h4>${delivery.pullRequest ? `Delivered pull request #${escapeHtml(delivery.pullRequest.number)}` : "Delivery result"}</h4>
          <p>${escapeHtml(delivery.verificationSummary)}</p>
          ${delivery.pullRequest ? `<p><strong>Repository:</strong> ${escapeHtml(delivery.pullRequest.repositoryOwner)}/${escapeHtml(delivery.pullRequest.repositoryName)} · ${escapeHtml(delivery.pullRequest.head)} → ${escapeHtml(delivery.pullRequest.base)}</p>` : ""}
          ${pullRequestUrl ? `<p><a href="${escapeHtml(pullRequestUrl)}" target="_blank" rel="noreferrer">Open delivered pull request</a></p>` : ""}
          ${delivery.executionOrigin ? `<p class="runtime-correlation"><strong>Result:</strong> turn ${escapeHtml(shortRef(delivery.executionOrigin.turnId))} · call ${escapeHtml(shortRef(delivery.executionOrigin.toolCallId))}</p>` : ""}
          <div class="work-card-meta">${chip(delivery.status)}</div>
        </article>`;
      }).join("")
    : "";
  const items = lane.items.map((item) => `
    <article class="work-card">
      <h4>${escapeHtml(item.title)}</h4>
      <p>${escapeHtml(item.purpose)}</p>
      <div class="work-card-meta">
        ${chip(item.status)}
        ${item.assignedRole ? `<span class="badge">${escapeHtml(item.assignedRole)}</span>` : ""}
        ${item.dependsOn.length ? `<span class="badge" title="Depends on ${escapeHtml(item.dependsOn.join(", "))}">${item.dependsOn.length} dependency</span>` : ""}
      </div>
    </article>`).join("");
  const approvalContent = `${approvalCards}${deliveryCards}`;
  const content = items || approvalContent || `<p class="lane-empty">${lane.id === "approve" ? "No remote action requested" : "No work in this stage"}</p>`;
  const count = lane.items.length + (lane.id === "approve" ? view.approvals.length + view.delivery.length : 0);
  return `
    <article class="lane" data-lane="${escapeHtml(lane.id)}">
      <header class="lane-header">
        <div><p class="lane-kicker">Stage</p><h3>${escapeHtml(lane.label)}</h3></div>
        <span class="badge lane-count">${count}</span>
      </header>
      <div class="lane-body">${content}</div>
    </article>`;
}

function renderActivity(activity) {
  if (activity.length === 0) {
    return `<p class="activity-empty">Runtime activity will appear here after the mission starts.</p>`;
  }
  return `<ol class="operations-list">${activity.map((item) => `
    <li class="activity-item" data-result="${escapeHtml(item.result)}" data-category="${escapeHtml(item.category)}">
      <span class="activity-marker" aria-hidden="true"></span>
      <div>
        <div class="activity-head"><span class="activity-actor">${escapeHtml(item.actor)}</span><time datetime="${escapeHtml(item.createdAt)}">${escapeHtml(formatTime(item.createdAt))}</time></div>
        <p>${escapeHtml(item.summary)}</p>
      </div>
    </li>`).join("")}</ol>`;
}

function renderEvidence(evidence) {
  if (evidence.length === 0) {
    return `<p class="evidence-empty">No verified MCP or sandbox evidence has been recorded yet. Runtime narration never appears in this panel.</p>`;
  }
  return `<div class="evidence-list">${evidence.map((item) => {
    const metadata = Object.entries(item.metadata).map(([key, value]) => `
      <div><dt>${escapeHtml(humanLabel(key))}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
    return `
      <article class="evidence-card" data-source="${escapeHtml(item.source)}" data-result="${escapeHtml(item.result)}">
        <div class="evidence-head">
          <span class="evidence-source">${item.source === "mcp" ? "Repository MCP" : "Sandbox"}</span>
          ${chip(item.result, "result")}
        </div>
        <h3>${escapeHtml(item.summary)}</h3>
        <p>${escapeHtml(item.workItemTitle ?? humanLabel(item.kind))} · <time datetime="${escapeHtml(item.createdAt)}">${escapeHtml(formatTime(item.createdAt))}</time></p>
        ${metadata ? `<dl class="evidence-meta">${metadata}</dl>` : ""}
      </article>`;
  }).join("")}</div>`;
}

async function createMission(event) {
  await withBusy(event.currentTarget, async () => {
    try {
      const payload = await api("/api/mission", { method: "POST" });
      runCoordinator.accept(payload.mission, { force: true, authoritative: true });
      setConnection("connected", "Durable state");
      showMessage("success", "Primary mission created and connected.");
    } catch (error) {
      setConnection("failed", "Operation failed");
      showMessage("error", error.message);
      if (error.payload?.mission) {
        runCoordinator.accept(error.payload.mission, { force: true, authoritative: true });
      }
    }
  });
}

async function runMission(event) {
  event.preventDefault();
  if (runCoordinator.isRunning()) return;
  try {
    await runCoordinator.run();
    setConnection("connected", "State persisted");
    showMessage("success", "Mission run completed with durable verification evidence.");
  } catch (error) {
    setConnection("failed", "Run failed");
    showMessage("error", error.message);
  }
}

async function decideApproval(event) {
  const button = event.currentTarget;
  const approvalId = button.dataset.approvalId;
  const decision = button.dataset.approvalDecision;
  await withBusy(button, async () => {
    try {
      const payload = await api(`/api/mission/approvals/${encodeURIComponent(approvalId)}`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      runCoordinator.accept(payload.mission, { force: true, authoritative: true });
      setConnection("connected", "Decision persisted");
      showMessage(
        "success",
        decision === "approved"
          ? "Approved action completed with durable pull request evidence."
          : `Delivery ${decision}; no protected repository operation was executed.`,
      );
    } catch (error) {
      setConnection("failed", "Decision failed");
      showMessage("error", error.message);
      if (error.payload?.mission) {
        runCoordinator.accept(error.payload.mission, { force: true, authoritative: true });
      }
    }
  });
}

async function withBusy(button, operation) {
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

async function loadMission() {
  try {
    const payload = await api("/api/mission");
    if (payload.mission === null) renderEmpty();
    else runCoordinator.accept(payload.mission, { force: true, authoritative: true });
    setConnection("connected", payload.mission ? "State recovered" : "Ready");
  } catch (error) {
    setConnection("failed", "Unavailable");
    showMessage("error", error.message);
    app.innerHTML = `
      <section class="empty-state panel">
        <p class="eyebrow">Connection error</p>
        <h1>Mission state could not be loaded.</h1>
        <p>${escapeHtml(error.message)}</p>
        <button id="retry-load" type="button">Retry</button>
      </section>`;
    document.querySelector("#retry-load")?.addEventListener("click", loadMission);
  }
}

runCoordinator = MissionRunState.createRunCoordinator({
  start: () => api("/api/mission/run", { method: "POST" }),
  refresh: () => api("/api/mission"),
  onState: (view) => renderMission(view),
  onRunStart: () => clearMessage(),
  onRunningChange: (running, view) => {
    if (view) renderMission(view);
    if (running) {
      setConnection("connected", "Mission running");
    }
  },
});

loadMission();
