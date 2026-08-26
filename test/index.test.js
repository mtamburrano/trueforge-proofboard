import assert from "node:assert/strict";
import test from "node:test";

import {
  deliveryStages,
  getProductSummary,
  productName,
  productThesis,
} from "../dist/index.js";

test("exports the product identity and delivery thesis", () => {
  assert.equal(productName, "TrueForge Proof Board");
  assert.equal(productThesis, "Verified autonomous software delivery");
  assert.deepEqual(deliveryStages, ["Plan", "Execute", "Prove", "Approve"]);
  assert.equal(
    getProductSummary(),
    "TrueForge Proof Board: Verified autonomous software delivery — Plan → Execute → Prove → Approve",
  );
});
