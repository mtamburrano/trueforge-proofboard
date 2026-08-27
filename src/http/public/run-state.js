(function (global) {
  "use strict";

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
      if (!view || typeof view.revision !== "number") return false;
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

  global.MissionRunState = Object.freeze({ createRunCoordinator });
})(globalThis);
