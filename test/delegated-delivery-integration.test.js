import assert from "node:assert/strict";
import test from "node:test";

import { DELEGATED_DELIVERY_FIXTURE, runDelegatedDeliveryIntegration } from "../scripts/delegated-delivery-integration.mjs";

test("delegated delivery reset fixture unlocks reviewed dependencies and preserves failure history", async () => {
  const result = await runDelegatedDeliveryIntegration();

  assert.equal(result.summary.missionId, DELEGATED_DELIVERY_FIXTURE.missionId);
  assert.equal(result.summary.missionStatus, "verifying");
  assert.deepEqual(result.summary.completedWorkItems, ["proof-loop-root", "proof-loop-dependent", "proof-loop-terminal"]);
  assert.equal(result.summary.dependentUnlockedAfterReviewedCompletion, true);
  assert.equal(result.summary.changesRequestedPreservedHistory, true);
  assert.equal(result.summary.malformedDelegationDidNotUnlockDependent, true);
  assert.equal(result.summary.uncorrelatedEvidenceDidNotUnlockDependent, true);
  assert.equal(result.summary.blockedReviewDidNotUnlockDependent, true);
  assert.equal(result.summary.remoteMutations, 0);
  assert.equal(result.malformed.rootDelegationStatus, "interrupted");
  assert.equal(result.malformed.dependentStatus, "backlog");
  assert.equal(result.uncorrelated.dependentStatus, "backlog");
  assert.equal(result.uncorrelated.handoffCount, 0);
  assert.equal(result.uncorrelated.retainedEvidenceCount > 0, true);
  assert.equal(result.blockedReview.reviewOutcome, "blocked");
  assert.equal(result.blockedReview.rootStatus, "blocked");
  assert.equal(result.blockedReview.dependentStatus, "backlog");
  assert.equal(result.blockedReview.handoffCount, 1);

  const primaryReviews = result.state.reviews.filter((review) => review.missionId === DELEGATED_DELIVERY_FIXTURE.missionId);
  assert.deepEqual(
    primaryReviews.map((review) => review.outcome),
    ["accepted", "changes_requested", "accepted", "accepted"],
  );
  assert.equal(result.state.missions.some((mission) => mission.id === DELEGATED_DELIVERY_FIXTURE.malformedMissionId), true);
  assert.equal(result.state.missions.some((mission) => mission.id === DELEGATED_DELIVERY_FIXTURE.uncorrelatedMissionId), true);
  assert.equal(result.state.missions.some((mission) => mission.id === DELEGATED_DELIVERY_FIXTURE.blockedReviewMissionId), true);
});
