import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  InMemoryMissionRepository,
  JsonMissionRepository,
  MAX_WORK_GRAPH_ITEMS,
  MissionDomainError,
  MissionService,
  PRIMARY_MISSION_OBJECTIVE,
  RepositoryWorkGraphPlanner,
  buildPreflightWorkGraph,
  validateWorkGraph,
} from "../dist/index.js";

function fixedClock() {
  return new Date("2026-08-27T12:00:00.000Z");
}

function domainError(code) {
  return (error) => error instanceof MissionDomainError && error.code === code;
}

function graph() {
  return {
    items: [
      {
        id: "inspect",
        title: "Inspect the verified source",
        purpose: "Record the repository facts required by the mission.",
        acceptanceCriteria: ["The pinned source is correlated to the inspection result."],
        dependsOn: [],
        assignedRole: "planner",
      },
      {
        id: "implement",
        title: "Implement the bounded change",
        purpose: "Apply the requested change only after inspection completes.",
        acceptanceCriteria: ["The requested behavior is implemented."],
        dependsOn: ["inspect"],
        assignedRole: "implementer",
        allowedFiles: ["src/index.ts"],
      },
      {
        id: "verify",
        title: "Verify the bounded change",
        purpose: "Check the implementation independently.",
        acceptanceCriteria: ["The focused verification passes."],
        dependsOn: ["implement"],
        assignedRole: "reviewer",
      },
    ],
  };
}

test("the repository planner derives bounded work from verified inspection facts", () => {
  const planner = new RepositoryWorkGraphPlanner();
  const planned = planner.plan({
    mission: {
      id: "mission-planning",
      objective: "Update src/index.ts and test/index.test.js without breaking compatibility.",
      status: "draft",
      createdAt: fixedClock().toISOString(),
      updatedAt: fixedClock().toISOString(),
      repository: { owner: "owner", name: "repo", ref: "fixture-sha" },
    },
    inspection: {
      resourceUri: "repo://owner/repo/fixture-sha/commit",
      contentHash: "sha256:verified",
      commitSha: "fixture-sha",
      patches: {
        "src/index.ts": "@@ verified source",
        "test/index.test.js": "@@ verified test",
      },
    },
  });

  assert.equal(planned.items.length, 4);
  assert.deepEqual(planned.items.map((item) => item.assignedRole), [
    "planner",
    "implementer",
    "implementer",
    "reviewer",
  ]);
  assert.deepEqual(planned.items.map((item) => item.dependsOn), [
    [],
    ["primary-inspect"],
    ["primary-inspect"],
    ["primary-implement-1-src-index-ts", "primary-implement-2-test-index-test-js"],
  ]);
  assert.equal(planned.items.every((item) => item.acceptanceCriteria.length > 0), true);
  assert.match(planned.items[1].purpose, /src\/index\.ts/);
  assert.deepEqual(planned.items[1].allowedFiles, ["src/index.ts"]);
  assert.deepEqual(planned.items[2].allowedFiles, ["test/index.test.js"]);
  assert.match(planned.items[0].acceptanceCriteria[0], /sha256:verified/);

  const documentationPlan = planner.plan({
    mission: {
      id: "mission-doc-planning",
      objective: "Update docs/usage.md with the verified command contract.",
      status: "draft",
      createdAt: fixedClock().toISOString(),
      updatedAt: fixedClock().toISOString(),
    },
    inspection: {
      resourceUri: "repo://owner/repo/docs/commit",
      contentHash: "sha256:docs",
      patches: { "docs/usage.md": "@@ verified documentation" },
    },
  });
  assert.equal(documentationPlan.items.length, 3);
  assert.deepEqual(
    documentationPlan.items.map((item) => item.id),
    ["primary-inspect", "primary-implement-1-docs-usage-md", "primary-verify"],
  );
  assert.notDeepEqual(
    documentationPlan.items.map(({ id, dependsOn }) => ({ id, dependsOn })),
    planned.items.map(({ id, dependsOn }) => ({ id, dependsOn })),
  );
});

test("the primary objective authorizes both source and verified focused-test surfaces", () => {
  const planner = new RepositoryWorkGraphPlanner();
  const planned = planner.plan({
    mission: {
      id: "primary-mission-planning-regression",
      objective: PRIMARY_MISSION_OBJECTIVE,
      status: "draft",
      createdAt: fixedClock().toISOString(),
      updatedAt: fixedClock().toISOString(),
      repository: { owner: "owner", name: "repo", ref: "fixture-sha" },
    },
    inspection: {
      resourceUri: "repo://owner/repo/fixture-sha/commit",
      contentHash: "sha256:primary-fixture",
      commitSha: "fixture-sha",
      patches: {
        "src/index.ts": "@@ verified source",
        "test/index.test.js": "@@ verified focused tests",
      },
    },
  });

  const implementers = planned.items.filter((item) => item.assignedRole === "implementer");
  assert.deepEqual(
    implementers.map((item) => item.id),
    ["primary-implement-1-src-index-ts", "primary-implement-2-test-index-test-js"],
  );
  assert.match(implementers[0].purpose, /src\/index\.ts/);
  assert.match(implementers[1].purpose, /test\/index\.test\.js/);
  assert.deepEqual(implementers.map((item) => item.allowedFiles), [
    ["src/index.ts"],
    ["test/index.test.js"],
  ]);
  assert.deepEqual(
    planned.items.find((item) => item.assignedRole === "reviewer").dependsOn,
    implementers.map((item) => item.id),
  );
});

test("persisted graphs expose executable roots and enforce dependencies in the service", async () => {
  const service = new MissionService(new InMemoryMissionRepository(), fixedClock);
  const mission = await service.createMission({
    id: "mission-graph-dependencies",
    objective: "Enforce graph dependencies",
  });
  const persisted = await service.persistWorkGraph(mission.id, graph());

  assert.deepEqual(persisted.map((item) => item.status), ["ready", "backlog", "backlog"]);
  assert.equal(await service.canStartWorkItem(mission.id, "inspect"), true);
  assert.equal(await service.canStartWorkItem(mission.id, "implement"), false);
  await assert.rejects(
    service.transitionWorkItem(mission.id, "implement", "ready"),
    domainError("dependency_blocked"),
  );

  await service.transitionWorkItem(mission.id, "inspect", "in_progress");
  await service.transitionWorkItem(mission.id, "inspect", "ready_for_review");
  await service.transitionWorkItem(mission.id, "inspect", "complete");
  await service.transitionWorkItem(mission.id, "implement", "ready");
  assert.equal(await service.canStartWorkItem(mission.id, "implement"), true);
});

test("graph structure, criteria, dependencies, and roles survive JSON reconnect", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-proofboard-graph-"));
  const filePath = path.join(directory, "mission-state.json");
  try {
    const first = new MissionService(new JsonMissionRepository(filePath), fixedClock);
    const mission = await first.createMission({
      id: "mission-graph-reconnect",
      objective: "Reload the work graph",
    });
    await first.persistWorkGraph(mission.id, graph());
    const before = (await first.getState()).workItems;

    const second = new MissionService(new JsonMissionRepository(filePath), fixedClock);
    const after = (await second.getState()).workItems;
    assert.deepEqual(after, before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid planning output fails closed without partially executable state", async () => {
  const service = new MissionService(new InMemoryMissionRepository(), fixedClock);
  const mission = await service.createMission({
    id: "mission-graph-invalid",
    objective: "Reject invalid planning output",
  });
  const before = await service.getState();

  await assert.rejects(
    service.persistWorkGraph(mission.id, { items: [] }),
    domainError("invalid_input"),
  );
  await assert.rejects(
    service.persistWorkGraph(mission.id, {
      items: [
        {
          id: "cycle-a",
          title: "Cycle A",
          purpose: "Invalid cycle node.",
          acceptanceCriteria: ["Never executable."],
          dependsOn: ["cycle-b"],
          assignedRole: "planner",
        },
        {
          id: "cycle-b",
          title: "Cycle B",
          purpose: "Invalid cycle node.",
          acceptanceCriteria: ["Never executable."],
          dependsOn: ["cycle-a"],
          assignedRole: "implementer",
          allowedFiles: ["src/index.ts"],
        },
      ],
    }),
    domainError("invalid_input"),
  );
  await assert.rejects(
    service.persistWorkGraph(mission.id, {
      items: [{
        id: "unknown-ref",
        title: "Unknown dependency",
        purpose: "Invalid dependency node.",
        acceptanceCriteria: ["Never executable."],
        dependsOn: ["missing"],
        assignedRole: "reviewer",
      }],
    }),
    domainError("invalid_input"),
  );

  const after = await service.getState();
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.workItems, []);
});

test("graph-size bounds reject oversized and ambiguous plans", () => {
  const oversized = {
    items: Array.from({ length: MAX_WORK_GRAPH_ITEMS + 1 }, (_, index) => ({
      id: `item-${index}`,
      title: `Item ${index}`,
      purpose: "Bounded graph item.",
      acceptanceCriteria: ["The item is bounded."],
      dependsOn: [],
      assignedRole: "implementer",
      allowedFiles: [`src/file-${index}.ts`],
    })),
  };
  assert.throws(() => validateWorkGraph(oversized), domainError("invalid_input"));
  assert.throws(
    () => validateWorkGraph({ items: [{ id: "ambiguous", title: "Ambiguous", purpose: "Missing role and criteria." }] }),
    domainError("invalid_input"),
  );
  assert.equal(buildPreflightWorkGraph({
    objective: "Change src/index.ts",
    repository: { owner: "owner", name: "repo", ref: "fixture" },
  }).items.length, 1);
});
