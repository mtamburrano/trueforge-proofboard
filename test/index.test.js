import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("TrueForge smoke dry-run is local and contains the expected evidence contract", () => {
  const result = spawnSync(process.execPath, ["scripts/trueforge-smoke.mjs", "--dry-run"], {
    encoding: "utf8",
    env: {
      ...process.env,
      TRUEFORGE_MODEL: "google-gemini/test-model",
      TRUEFORGE_GITHUB_SERVER: "github-test",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"external_calls": false/);
  assert.match(result.stdout, /"tool": "get_file_contents"/);
  assert.match(result.stdout, /TRUEFORGE_DAYTONA_OK/);
});
