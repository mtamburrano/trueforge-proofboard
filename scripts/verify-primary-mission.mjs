import assert from "node:assert/strict";

const { getNextDeliveryStage } = await import("../dist/index.js");

assert.equal(typeof getNextDeliveryStage, "function", "the mission stage helper is missing");
assert.equal(getNextDeliveryStage("Plan"), "Execute");
assert.equal(getNextDeliveryStage("Execute"), "Prove");
assert.equal(getNextDeliveryStage("Prove"), "Approve");
assert.equal(getNextDeliveryStage("Approve"), null);

console.log("Mission transition verification passed.");
