import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadRunState() {
  const source = await readFile(
    new URL("../src/http/public/run-state.js", import.meta.url),
    "utf8",
  );
  const context = vm.createContext({});
  vm.runInContext(source, context);
  return context.MissionRunState;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function manualScheduler() {
  let nextId = 1;
  const jobs = [];
  return {
    schedule(callback) {
      const job = { id: nextId, callback, active: true };
      nextId += 1;
      jobs.push(job);
      return job.id;
    },
    cancel(id) {
      const job = jobs.find((candidate) => candidate.id === id);
      if (job) job.active = false;
    },
    async runNext() {
      const job = jobs.find((candidate) => candidate.active);
      assert.ok(job, "expected a scheduled poll");
      job.active = false;
      await job.callback();
    },
    activeCount() {
      return jobs.filter((job) => job.active).length;
    },
  };
}

test("run coordinator polls durable revisions without starting a duplicate run", async () => {
  const { createRunCoordinator } = await loadRunState();
  const scheduler = manualScheduler();
  const runResult = deferred();
  const refreshed = [
    { mission: { revision: 1, marker: "inspection" } },
    { mission: { revision: 1, marker: "unchanged" } },
    { mission: { revision: 2, marker: "execution" } },
  ];
  const rendered = [];
  const runningChanges = [];
  let startCalls = 0;
  let refreshCalls = 0;

  const coordinator = createRunCoordinator({
    start() {
      startCalls += 1;
      return runResult.promise;
    },
    async refresh() {
      const payload = refreshed[refreshCalls];
      refreshCalls += 1;
      return payload;
    },
    onState(view, metadata) {
      rendered.push({ revision: view.revision, authoritative: metadata.authoritative });
    },
    onRunningChange(running, view) {
      runningChanges.push({ running, revision: view?.revision ?? null });
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    intervalMs: 1,
  });
  coordinator.accept({ revision: 0, marker: "initial" }, { force: true });
  rendered.length = 0;

  const firstRun = coordinator.run();
  const duplicateRun = coordinator.run();
  await Promise.resolve();
  assert.equal(startCalls, 1);
  assert.equal(coordinator.isRunning(), true);

  await scheduler.runNext();
  await scheduler.runNext();
  await scheduler.runNext();
  assert.equal(refreshCalls, 3);
  assert.deepEqual(rendered, [
    { revision: 1, authoritative: false },
    { revision: 2, authoritative: false },
  ]);

  runResult.resolve({ mission: { revision: 2, marker: "final" } });
  const [firstPayload, duplicatePayload] = await Promise.all([firstRun, duplicateRun]);
  assert.equal(firstPayload.mission.marker, "final");
  assert.equal(duplicatePayload.mission.marker, "final");
  assert.equal(startCalls, 1);
  assert.equal(coordinator.isRunning(), false);
  assert.equal(scheduler.activeCount(), 0);
  assert.deepEqual(rendered.at(-1), { revision: 2, authoritative: true });
  assert.deepEqual(runningChanges, [
    { running: true, revision: 0 },
    { running: false, revision: 2 },
  ]);
});

test("run coordinator renders the authoritative failure state and stops polling", async () => {
  const { createRunCoordinator } = await loadRunState();
  const scheduler = manualScheduler();
  const failure = new Error("Public failure");
  failure.payload = { mission: { revision: 4, marker: "blocked" } };
  const rendered = [];
  const coordinator = createRunCoordinator({
    async start() {
      throw failure;
    },
    async refresh() {
      throw new Error("refresh should not replace an authoritative failure payload");
    },
    onState(view, metadata) {
      rendered.push({ marker: view.marker, authoritative: metadata.authoritative });
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    intervalMs: 1,
  });

  await assert.rejects(coordinator.run(), /Public failure/);
  assert.deepEqual(rendered, [{ marker: "blocked", authoritative: true }]);
  assert.equal(coordinator.isRunning(), false);
  assert.equal(scheduler.activeCount(), 0);
});

test("run coordinator never lets an older revision replace newer state", async () => {
  const { createRunCoordinator } = await loadRunState();
  const rendered = [];
  const coordinator = createRunCoordinator({
    onState(view, metadata) {
      rendered.push({ revision: view.revision, marker: view.marker, authoritative: metadata.authoritative });
    },
  });

  assert.equal(coordinator.accept({ revision: 5, marker: "newer" }, { force: true }), true);
  assert.equal(
    coordinator.accept(
      { revision: 4, marker: "stale-authoritative" },
      { force: true, authoritative: true },
    ),
    false,
  );
  assert.equal(coordinator.latestRevision(), 5);
  assert.equal(
    coordinator.accept(
      { revision: 5, marker: "authoritative-rerender" },
      { force: true, authoritative: true },
    ),
    true,
  );
  assert.deepEqual(rendered, [
    { revision: 5, marker: "newer", authoritative: false },
    { revision: 5, marker: "authoritative-rerender", authoritative: true },
  ]);
});
