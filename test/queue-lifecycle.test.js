import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  InMemoryMissionRepository,
  JsonMissionRepository,
  MissionDomainError,
  MissionService,
  createMissionHttpApp,
  ticketStatuses,
} from "../dist/index.js";

const NOW = () => new Date("2026-08-29T15:00:00.000Z");

function domainError(code) {
  return (error) => error instanceof MissionDomainError && error.code === code;
}

async function queueFixture(
  repository = new InMemoryMissionRepository(),
  missionId = "mission-queue-lifecycle",
) {
  const missions = new MissionService(repository, NOW);
  const mission = await missions.createMission({
    id: missionId,
    objective: "Verify queue-first authorization and delivery state.",
  });
  const ticket = await missions.addWorkItem(mission.id, {
    id: "ticket-queue-lifecycle",
    title: "Queue-first delivery ticket",
    purpose: "Exercise the persisted authorization and claim boundary.",
  });
  return { missions, mission, ticket };
}

test("exports the queue-first product lifecycle without exposing legacy aliases", () => {
  assert.deepEqual(ticketStatuses, [
    "backlog",
    "ready",
    "in_progress",
    "proving",
    "changes_requested",
    "awaiting_approval",
    "delivering",
    "done",
    "blocked",
  ]);
});

test("human authorization is durable and can only be revoked before a claim", async () => {
  const { missions, mission, ticket } = await queueFixture();
  assert.equal(ticket.status, "backlog");

  let state = await missions.getState();
  const authorized = await missions.moveWorkItemByHuman(
    mission.id,
    ticket.id,
    "ready",
    { actor: "operator", expectedRevision: state.revision },
  );
  assert.equal(authorized.status, "ready");
  assert.deepEqual(authorized.executionAuthorization, {
    authorizedBy: "operator",
    authorizedAt: NOW().toISOString(),
  });

  state = await missions.getState();
  const revoked = await missions.moveWorkItemByHuman(
    mission.id,
    ticket.id,
    "backlog",
    { actor: "operator", expectedRevision: state.revision },
  );
  assert.equal(revoked.status, "backlog");
  assert.equal(revoked.executionAuthorization, undefined);

  state = await missions.getState();
  await missions.moveWorkItemByHuman(
    mission.id,
    ticket.id,
    "ready",
    { actor: "operator", expectedRevision: state.revision },
  );
  const claimed = await missions.claimWorkItem(mission.id, ticket.id, { owner: "trueforge" });
  assert.equal(claimed.status, "in_progress");
  await assert.rejects(
    missions.moveWorkItemByHuman(mission.id, ticket.id, "backlog", { actor: "operator" }),
    domainError("invalid_transition"),
  );
  await assert.rejects(
    missions.moveWorkItemByHuman(mission.id, ticket.id, "proving", { actor: "operator" }),
    domainError("invalid_transition"),
  );
});

test("a ready ticket is claimed once and later lifecycle edges are system-owned", async () => {
  const { missions, mission, ticket } = await queueFixture();
  await missions.moveWorkItemByHuman(mission.id, ticket.id, "ready", { actor: "operator" });
  const claimed = await missions.claimReadyWorkItem(mission.id, ticket.id, {
    owner: "trueforge-worker",
    trueforgeSessionId: "session-queue",
    trueforgeSandboxId: "sandbox-queue",
  });
  assert.equal(claimed.status, "in_progress");
  assert.deepEqual(claimed.claim, {
    owner: "trueforge-worker",
    claimedAt: NOW().toISOString(),
    trueforgeSessionId: "session-queue",
    trueforgeSandboxId: "sandbox-queue",
  });

  await assert.rejects(
    missions.claimWorkItem(mission.id, ticket.id, { owner: "second-worker" }),
    domainError("invalid_transition"),
  );
  await missions.transitionSystemWorkItem(mission.id, ticket.id, "proving", {
    trigger: "execution",
  });
  await missions.transitionSystemWorkItem(mission.id, ticket.id, "awaiting_approval", {
    trigger: "proof",
  });
  await missions.transitionSystemWorkItem(mission.id, ticket.id, "delivering", {
    trigger: "approval",
  });
  const done = await missions.transitionSystemWorkItem(mission.id, ticket.id, "done", {
    trigger: "delivery",
  });
  assert.equal(done.status, "done");
});

test("changes requested is a hard stop and human rework preserves the prior attempt", async () => {
  const { missions, mission, ticket } = await queueFixture();
  await missions.moveWorkItemByHuman(mission.id, ticket.id, "ready", { actor: "first-operator" });
  await missions.claimWorkItem(mission.id, ticket.id, {
    owner: "trueforge-worker",
    trueforgeSessionId: "session-reused",
    trueforgeSandboxId: "sandbox-reused",
  });
  await missions.transitionSystemWorkItem(mission.id, ticket.id, "proving", {
    trigger: "execution",
  });
  const failed = await missions.transitionSystemWorkItem(mission.id, ticket.id, "changes_requested", {
    trigger: "proof",
    reason: "The deterministic proof found an incomplete contract.",
  });
  assert.equal(failed.status, "changes_requested");
  assert.deepEqual(failed.requestedChanges, ["The deterministic proof found an incomplete contract."]);

  await assert.rejects(
    missions.resumeChangesRequestedWorkItem(mission.id, ticket.id),
    domainError("invalid_transition"),
  );
  await assert.rejects(
    missions.transitionSystemWorkItem(mission.id, ticket.id, "in_progress", { trigger: "claim" }),
    domainError("invalid_transition"),
  );

  const beforeRework = await missions.getState();
  const reauthorized = await missions.moveWorkItemByHuman(
    mission.id,
    ticket.id,
    "ready",
    { actor: "rework-operator", expectedRevision: beforeRework.revision },
  );
  assert.equal(reauthorized.status, "ready");
  assert.equal(reauthorized.claim, undefined);
  assert.equal(reauthorized.executionAuthorization.authorizedBy, "rework-operator");
  assert.deepEqual(reauthorized.requestedChanges, ["The deterministic proof found an incomplete contract."]);
  assert.equal(reauthorized.attempts.length, 1);
  assert.equal(reauthorized.attempts[0].status, "changes_requested");
  assert.equal(reauthorized.attempts[0].claim.trueforgeSessionId, "session-reused");
  assert.equal(reauthorized.attempts[0].claim.trueforgeSandboxId, "sandbox-reused");
  assert.equal(reauthorized.attempts[0].retiredBy, "rework-operator");

  const second = await missions.claimWorkItem(mission.id, ticket.id, { owner: "trueforge-worker" });
  assert.equal(second.status, "in_progress");
  assert.equal(second.attempt, 2);
  assert.equal(second.attempts.length, 2);
  assert.equal(second.claim.trueforgeSessionId, "session-reused");
  assert.equal(second.claim.trueforgeSandboxId, "sandbox-reused");
  assert.deepEqual(second.attempts[1].requestedChanges, reauthorized.requestedChanges);
});

test("rework authorization, retired claims, and attempt identity survive JSON reconnect", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-rework-"));
  const filePath = path.join(directory, "state.json");
  try {
    const first = await queueFixture(new JsonMissionRepository(filePath), "mission-rework-reconnect");
    await first.missions.moveWorkItemByHuman(first.mission.id, first.ticket.id, "ready", {
      actor: "operator",
    });
    await first.missions.claimWorkItem(first.mission.id, first.ticket.id, {
      owner: "worker",
      trueforgeSessionId: "session-reconnect-rework",
      trueforgeSandboxId: "sandbox-reconnect-rework",
    });
    await first.missions.transitionSystemWorkItem(first.mission.id, first.ticket.id, "proving", {
      trigger: "execution",
    });
    await first.missions.transitionSystemWorkItem(first.mission.id, first.ticket.id, "changes_requested", {
      trigger: "proof",
      reason: "The proof needs one bounded correction.",
    });
    await first.missions.moveWorkItemByHuman(first.mission.id, first.ticket.id, "ready", {
      actor: "rework-operator",
    });

    const second = new MissionService(new JsonMissionRepository(filePath), NOW);
    const restored = await second.getWorkItem(first.mission.id, first.ticket.id);
    assert.equal(restored.status, "ready");
    assert.equal(restored.claim, undefined);
    assert.equal(restored.executionAuthorization.authorizedBy, "rework-operator");
    assert.equal(restored.attempts[0].retiredBy, "rework-operator");
    assert.equal(restored.attempts[0].claim.trueforgeSandboxId, "sandbox-reconnect-rework");

    const claimed = await second.claimWorkItem(first.mission.id, first.ticket.id, { owner: "worker" });
    assert.equal(claimed.attempt, 2);
    assert.equal(claimed.claim.trueforgeSessionId, "session-reconnect-rework");
    assert.equal(claimed.claim.trueforgeSandboxId, "sandbox-reconnect-rework");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent claim attempts share one durable winner", async () => {
  const repository = new InMemoryMissionRepository();
  const first = await queueFixture(repository);
  const second = new MissionService(repository, NOW);
  await second.getState();
  await first.missions.moveWorkItemByHuman(first.mission.id, first.ticket.id, "ready", {
    actor: "operator",
  });

  const attempts = await Promise.allSettled([
    first.missions.claimWorkItem(first.mission.id, first.ticket.id, { owner: "worker-a" }),
    second.claimWorkItem(first.mission.id, first.ticket.id, { owner: "worker-b" }),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
  const rejected = attempts.find((attempt) => attempt.status === "rejected");
  assert.equal(rejected.reason instanceof MissionDomainError, true);
  assert.equal(["conflict", "invalid_transition"].includes(rejected.reason.code), true);
  const finalState = await first.missions.getState();
  assert.equal(finalState.workItems[0].status, "in_progress");
  assert.equal(["worker-a", "worker-b"].includes(finalState.workItems[0].claim.owner), true);
});

test("queue authorization and claim survive a JSON reconnect", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-queue-"));
  const filePath = path.join(directory, "state.json");
  try {
    const first = await queueFixture(new JsonMissionRepository(filePath));
    await first.missions.moveWorkItemByHuman(first.mission.id, first.ticket.id, "ready", {
      actor: "operator",
    });
    await first.missions.claimWorkItem(first.mission.id, first.ticket.id, {
      owner: "trueforge-worker",
      trueforgeSessionId: "session-reconnect",
      trueforgeSandboxId: "sandbox-reconnect",
    });

    const reconnected = new MissionService(new JsonMissionRepository(filePath), NOW);
    const restored = await reconnected.getWorkItem(first.mission.id, first.ticket.id);
    assert.equal(restored.status, "in_progress");
    assert.equal(restored.executionAuthorization.authorizedBy, "operator");
    assert.equal(restored.claim.trueforgeSandboxId, "sandbox-reconnect");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP exposes ticket reads and rejects non-human lifecycle shortcuts", async () => {
  const { missions, mission, ticket } = await queueFixture(
    new InMemoryMissionRepository(),
    "primary-mission",
  );
  const app = createMissionHttpApp({ missions, runner: {} });

  const initial = await app.request("/api/mission/tickets");
  assert.equal(initial.status, 200);
  const initialPayload = await initial.json();
  assert.equal(initialPayload.tickets[0].status, "backlog");

  const authorized = await app.request(`/api/mission/tickets/${ticket.id}/status`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "ready",
      actor: "operator",
      expected_revision: initialPayload.revision,
    }),
  });
  assert.equal(authorized.status, 200);
  const authorizedPayload = await authorized.json();
  assert.equal(authorizedPayload.ticket.status, "ready");
  assert.equal(authorizedPayload.ticket.executionAuthorization.authorizedBy, "operator");

  const shortcut = await app.request(`/api/mission/tickets/${ticket.id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status: "proving", actor: "operator" }),
  });
  assert.equal(shortcut.status, 400);
  const shortcutPayload = await shortcut.json();
  assert.match(shortcutPayload.message, /Backlog and Ready|system-owned/i);

  const claim = await app.request(`/api/mission/tickets/${ticket.id}/claim`, {
    method: "POST",
    body: JSON.stringify({ owner: "trueforge-worker" }),
  });
  assert.equal(claim.status, 200);
  assert.equal((await claim.json()).ticket.status, "in_progress");
  assert.equal((await missions.getMission(mission.id)).status, "draft");
});

test("HTTP requires human reauthorization before a changes-requested ticket can be claimed", async () => {
  const { missions, mission, ticket } = await queueFixture(
    new InMemoryMissionRepository(),
    "primary-mission",
  );
  const app = createMissionHttpApp({ missions, runner: {} });
  await missions.moveWorkItemByHuman(mission.id, ticket.id, "ready", { actor: "operator" });
  await missions.claimWorkItem(mission.id, ticket.id, { owner: "worker" });
  await missions.transitionSystemWorkItem(mission.id, ticket.id, "proving", {
    trigger: "execution",
  });
  await missions.transitionSystemWorkItem(mission.id, ticket.id, "changes_requested", {
    trigger: "proof",
    reason: "Fix the failed proof contract.",
  });

  const blockedClaim = await app.request("/api/mission/tickets/" + ticket.id + "/claim", {
    method: "POST",
    body: JSON.stringify({ owner: "worker" }),
  });
  assert.equal(blockedClaim.status, 400);

  const current = await missions.getState();
  const authorized = await app.request("/api/mission/tickets/" + ticket.id + "/status", {
    method: "PATCH",
    body: JSON.stringify({
      status: "ready",
      actor: "operator",
      expected_revision: current.revision,
    }),
  });
  assert.equal(authorized.status, 200);
  const payload = await authorized.json();
  assert.equal(payload.ticket.status, "ready");
  assert.equal(payload.ticket.claim, undefined);
  assert.equal(payload.ticket.attempts[0].retiredBy, "operator");
});
