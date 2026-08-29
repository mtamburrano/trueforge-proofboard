import assert from "node:assert/strict";
import test from "node:test";

import { runQueueSafetyRecoveryIntegration } from "../scripts/queue-safety-recovery-integration.mjs";

test("queue safety and recovery gate proves human authorization, current evidence, reconnect, and delivery boundaries", async () => {
  const summary = await runQueueSafetyRecoveryIntegration();

  assert.equal(summary.remoteMutations, 0);
  assert.equal(summary.semanticRework.status, "delivered");
  assert.equal(summary.semanticRework.attempt, 2);
  assert.equal(summary.semanticRework.handoffs, 2);
  assert.equal(summary.semanticRework.reviews, 2);
  assert.equal(summary.semanticRework.protectedOperations, 1);
  assert.equal(summary.proofFailure.status, "proving");
  assert.equal(summary.proofFailure.attempts, 2);
  assert.equal(summary.proofInfrastructureRetry.status, "awaiting_approval");
  assert.equal(summary.proofInfrastructureRetry.attempts, 1);
  assert.equal(summary.proofInfrastructureRetry.codingTurns, 1);
  assert.equal(summary.proofInfrastructureRetry.proofCalls, 2);
  assert.equal(summary.proofInfrastructureRetry.evidencePreserved, true);
  assert.equal(summary.staleCorrelation.staleEvidenceBlocked, true);
  assert.equal(summary.staleCorrelation.currentFindingBlocked, true);
  assert.equal(summary.rejectedApproval.status, "blocked");
  assert.equal(summary.rejectedApproval.protectedOperations, 0);
  assert.equal(summary.readbackMismatch.status, "blocked");
  assert.equal(summary.readbackMismatch.protectedOperations, 1);
});
