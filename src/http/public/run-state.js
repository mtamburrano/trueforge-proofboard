(function (global) {
  "use strict";

  function viewTickets(view) {
    if (Array.isArray(view?.tickets)) return view.tickets;
    return (view?.lanes ?? []).flatMap((lane) => lane.items ?? []);
  }

  function primaryTicket(view) {
    const tickets = viewTickets(view);
    return tickets.find((ticket) => ticket.assignedRole === "implementer") ??
      tickets.find((ticket) => ticket.allowedFiles?.length > 0) ?? tickets[0];
  }

  function normalizedTicketStatus(ticket) {
    if (ticket?.status === "ready_for_review") return "proving";
    if (ticket?.status === "complete") return "done";
    return ticket?.status;
  }

  function describeRunOutcome(view) {
    const status = normalizedTicketStatus(primaryTicket(view));
    if (status === "proving" && view?.progress?.verification === "failed") {
      return {
        kind: "warning",
        message: "TrueForge recorded a retryable proof infrastructure failure. The ticket remains in Proving; inspect the durable failed evidence and retry proof.",
      };
    }
    if (status === "proving") {
      return {
        kind: "success",
        message: "TrueForge completed the implementation step; deterministic proof is next.",
      };
    }
    if (status === "awaiting_approval") {
      return {
        kind: "success",
        message: "Deterministic proof and independent review passed; approve the exact delivery.",
      };
    }
    if (status === "delivering") {
      return {
        kind: "success",
        message: "Delivery approval is recorded; protected read-back is in progress.",
      };
    }
    if (status === "done") {
      return {
        kind: "success",
        message: "Delivery is verified with durable pull request evidence.",
      };
    }
    if (status === "in_progress") {
      return {
        kind: "success",
        message: "TrueForge claimed the authorized ticket; execution is in progress.",
      };
    }
    return {
      kind: "success",
      message: "TrueForge advanced the durable queue state.",
    };
  }

  function createRunCoordinator(options) {
    const intervalMs = options.intervalMs ?? 750;
    const schedule = options.schedule ?? ((callback, delay) => global.setTimeout(callback, delay));
    const cancel = options.cancel ?? ((handle) => global.clearTimeout(handle));
    let activeRun = null;
    let polling = false;
    let pollHandle = null;
    let latestRevision = null;
    let latestView = null;

    function accept(view, { force = false, authoritative = false } = {}) {
      if (!view || !Number.isInteger(view.revision) || view.revision < 0) return false;
      if (latestRevision !== null && view.revision < latestRevision) return false;
      if (!force && view.revision === latestRevision) return false;
      latestRevision = view.revision;
      latestView = view;
      options.onState(view, { authoritative });
      return true;
    }

    async function poll() {
      if (!polling) return;
      try {
        const payload = await options.refresh();
        if (!polling) return;
        if (payload?.mission) accept(payload.mission);
      } catch (error) {
        if (polling) options.onPollError?.(error);
      }
      if (polling) pollHandle = schedule(poll, intervalMs);
    }

    function startPolling() {
      polling = true;
      pollHandle = schedule(poll, intervalMs);
    }

    function stopPolling() {
      polling = false;
      if (pollHandle !== null) cancel(pollHandle);
      pollHandle = null;
    }

    function run() {
      if (activeRun !== null) return activeRun;

      options.onRunStart?.(latestView);
      options.onRunningChange?.(true, latestView);
      const request = Promise.resolve().then(() => options.start());
      startPolling();
      activeRun = (async () => {
        try {
          const payload = await request;
          stopPolling();
          if (payload?.mission) accept(payload.mission, { force: true, authoritative: true });
          return payload;
        } catch (error) {
          stopPolling();
          if (error?.payload?.mission) {
            accept(error.payload.mission, { force: true, authoritative: true });
          } else {
            try {
              const payload = await options.refresh();
              if (payload?.mission) {
                accept(payload.mission, { force: true, authoritative: true });
              }
            } catch {
              // The original run failure remains authoritative when refresh is unavailable.
            }
          }
          throw error;
        } finally {
          stopPolling();
          activeRun = null;
          options.onRunningChange?.(false, latestView);
        }
      })();
      return activeRun;
    }

    return Object.freeze({
      accept,
      isRunning: () => activeRun !== null,
      latestRevision: () => latestRevision,
      run,
    });
  }

  global.MissionRunState = Object.freeze({ createRunCoordinator, describeRunOutcome });
})(globalThis);
