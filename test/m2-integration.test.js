import assert from "node:assert/strict";
import test from "node:test";

import { M2_FIXTURE, runM2Integration } from "../scripts/m2-integration.mjs";

test("M2 reset fixture unlocks reviewed dependencies and preserves failure history", async () => {
  const result = await runM2Integration();

  assert.equal(result.summary.missionId, M2_FIXTURE.missionId);
  assert.equal(result.summary.missionStatus, "verifying");
  assert.deepEqual(result.summary.completedWorkItems, ["m2-root", "m2-dependent", "m2-terminal"]);
  assert.equal(result.summary.dependentUnlockedAfterReviewedCompletion, true);
  assert.equal(result.summary.changesRequestedPreservedHistory, true);
  assert.equal(result.summary.malformedDelegationDidNotUnlockDependent, true);
  assert.equal(result.summary.remoteMutations, 0);
  assert.equal(result.malformed.rootDelegationStatus, "interrupted");
  assert.equal(result.malformed.dependentStatus, "backlog");

  const primaryReviews = result.state.reviews.filter((review) => review.missionId === M2_FIXTURE.missionId);
  assert.deepEqual(
    primaryReviews.map((review) => review.outcome),
    ["accepted", "changes_requested", "accepted", "accepted"],
  );
  assert.equal(result.state.missions.some((mission) => mission.id === M2_FIXTURE.malformedMissionId), true);
});
