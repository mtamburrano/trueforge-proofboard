import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PRIMARY_VERIFICATION_COMMAND,
  PRIMARY_VERIFIED_DELIVERY_FILES,
} from "../dist/index.js";

const BASELINE_SOURCE = "export const deliveryStages = [\"Plan\", \"Execute\", \"Prove\", \"Approve\"];";
const BASELINE_DIST = "export const deliveryStages = [\"Plan\", \"Execute\", \"Prove\", \"Approve\"];";
const BASELINE_TESTS = "import test from \"node:test\"; test(\"existing coverage\", () => {});";
const MIMIC_TESTS = [
  "import test from \"node:test\";",
  "const misleadingText = `getNextDeliveryStage(\\\"Plan\\\"), \\\"Execute\\\"; getNextDeliveryStage(\\\"Execute\\\"), \\\"Prove\\\"; getNextDeliveryStage(\\\"Prove\\\"), \\\"Approve\\\"; getNextDeliveryStage(\\\"Approve\\\"), null;`;",
  "/* getNextDeliveryStage(\"Plan\") -> \"Execute\"; getNextDeliveryStage(\"Execute\") -> \"Prove\"; getNextDeliveryStage(\"Prove\") -> \"Approve\"; getNextDeliveryStage(\"Approve\") -> null */",
  "test(\"no-op lookalike coverage\", () => {});",
].join("\n");
const TOP_LEVEL_CALLS_TESTS = [
  "import test from \"node:test\";",
  "import { getNextDeliveryStage } from \"../dist/index.js\";",
  "getNextDeliveryStage(\"Plan\");",
  "getNextDeliveryStage(\"Execute\");",
  "getNextDeliveryStage(\"Prove\");",
  "getNextDeliveryStage(\"Approve\");",
  "test(\"no-op top-level call coverage\", () => {});",
].join("\n");
const HELPER_SOURCE = [
  "export function getNextDeliveryStage(stage) {",
  "  return stage === \"Plan\" ? \"Execute\" : stage === \"Execute\" ? \"Prove\" : stage === \"Prove\" ? \"Approve\" : null;",
  "}",
].join("\n");
const VERIFIED_DELIVERY_DIST = [
  "export const productName = \"TrueForge Proof Board\";",
  "export const productThesis = \"Verified autonomous software delivery\";",
  "export const deliveryStages = [\"Plan\", \"Execute\", \"Prove\", \"Approve\"];",
  "export function getNextDeliveryStage(stage) {",
  "  const index = deliveryStages.indexOf(stage);",
  "  if (index === -1 || index === deliveryStages.length - 1) return null;",
  "  return deliveryStages[index + 1] ?? null;",
  "}",
  "export function getProductSummary() {",
  "  return `${productName}: ${productThesis} — ${deliveryStages.join(\" → \")}`;",
  "}",
].join("\n");
test("mission verification rejects the unchanged baseline", async () => {
  const result = await runVerificationFixture({
    source: BASELINE_SOURCE,
    dist: BASELINE_DIST,
    tests: BASELINE_TESTS,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /mission stage helper is missing/);
});

test("mission verification rejects a helper without focused transition tests", async () => {
  const result = await runVerificationFixture({
    source: HELPER_SOURCE,
    dist: HELPER_SOURCE,
    tests: BASELINE_TESTS,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /transition Plan -> Execute was not executed by the focused test/);
});

test("mission verification rejects non-executed transition lookalikes", async () => {
  const result = await runVerificationFixture({
    source: HELPER_SOURCE,
    dist: HELPER_SOURCE,
    tests: MIMIC_TESTS,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /transition Plan -> Execute was not executed by the focused test/);
});

test("mission verification rejects top-level calls without assertions", async () => {
  const result = await runVerificationFixture({
    source: HELPER_SOURCE,
    dist: HELPER_SOURCE,
    tests: TOP_LEVEL_CALLS_TESTS,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /focused test did not enforce transition Plan -> Execute/);
});

test("mission verification accepts helper behavior with focused transition tests", async () => {
  const result = await runVerificationFixture({
    source: PRIMARY_VERIFIED_DELIVERY_FILES["src/index.ts"],
    dist: VERIFIED_DELIVERY_DIST,
    tests: PRIMARY_VERIFIED_DELIVERY_FILES["test/index.test.js"],
  });

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /Mission transition verification passed/);
});

async function runVerificationFixture({ source, dist, tests }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trueforge-mission-verification-"));
  try {
    await mkdir(path.join(directory, "src"));
    await mkdir(path.join(directory, "test"));
    await mkdir(path.join(directory, "dist"));
    await writeFile(path.join(directory, "src", "index.ts"), source, "utf8");
    await writeFile(path.join(directory, "test", "index.test.js"), tests, "utf8");
    await writeFile(path.join(directory, "dist", "index.js"), dist, "utf8");
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "mission-verification-fixture",
        type: "module",
        scripts: { test: "node -e 'process.exit(0)'" },
      }),
      "utf8",
    );
    return spawnSync("sh", ["-c", PRIMARY_VERIFICATION_COMMAND], {
      cwd: directory,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
