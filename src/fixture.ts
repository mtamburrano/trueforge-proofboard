export const PRIMARY_DELIVERY_FIXTURE = {
  owner: "mtamburrano",
  repository: "proofboard-demo-fixture",
  baselineRef: "88e53b07691d5ed3d327f5d47179e99c64e672af",
  baselineSha: "88e53b07691d5ed3d327f5d47179e99c64e672af",
  base: "main",
  head: "proofboard-verified-delivery",
} as const;

export const PRIMARY_SANDBOX_REPOSITORY_ROOT = "/tmp/proofboard-workspace" as const;

export const PRIMARY_VERIFIED_DELIVERY_FILES = {
  "src/index.ts": [
    "export const productName = \"TrueForge Proof Board\" as const;",
    "",
    "export const productThesis = \"Verified autonomous software delivery\" as const;",
    "",
    "export const deliveryStages = [\"Plan\", \"Execute\", \"Prove\", \"Approve\"] as const;",
    "",
    "export type DeliveryStage = (typeof deliveryStages)[number];",
    "",
    "export function getNextDeliveryStage(stage: DeliveryStage): DeliveryStage | null {",
    "  const index = deliveryStages.indexOf(stage);",
    "  if (index === -1 || index === deliveryStages.length - 1) {",
    "    return null;",
    "  }",
    "  return deliveryStages[index + 1] ?? null;",
    "}",
    "",
    "export function getProductSummary(): string {",
    "  return `${productName}: ${productThesis} — ${deliveryStages.join(\" → \")}`;",
    "}",
    "",
  ].join("\n"),
  "test/index.test.js": [
    "import assert from \"node:assert/strict\";",
    "import test from \"node:test\";",
    "",
    "import {",
    "  deliveryStages,",
    "  getNextDeliveryStage,",
    "  getProductSummary,",
    "  productName,",
    "  productThesis,",
    "} from \"../dist/index.js\";",
    "",
    "test(\"exports the product identity and delivery thesis\", () => {",
    "  assert.equal(productName, \"TrueForge Proof Board\");",
    "  assert.equal(productThesis, \"Verified autonomous software delivery\");",
    "  assert.deepEqual(deliveryStages, [\"Plan\", \"Execute\", \"Prove\", \"Approve\"]);",
    "  assert.equal(",
    "    getProductSummary(),",
    "    \"TrueForge Proof Board: Verified autonomous software delivery — Plan → Execute → Prove → Approve\",",
    "  );",
    "});",
    "",
    "test(\"returns the next delivery stage for every transition\", () => {",
    "  assert.equal(getNextDeliveryStage(\"Plan\"), \"Execute\");",
    "  assert.equal(getNextDeliveryStage(\"Execute\"), \"Prove\");",
    "  assert.equal(getNextDeliveryStage(\"Prove\"), \"Approve\");",
    "  assert.equal(getNextDeliveryStage(\"Approve\"), null);",
    "});",
    "",
  ].join("\n"),
} as const;

export const PRIMARY_VERIFIED_DELIVERY_PATCHES = {
  "src/index.ts": [
    "@@ -6,6 +6,14 @@ export const deliveryStages = [\"Plan\", \"Execute\", \"Prove\", \"Approve\"] as const;",
    " ",
    " export type DeliveryStage = (typeof deliveryStages)[number];",
    " ",
    "+export function getNextDeliveryStage(stage: DeliveryStage): DeliveryStage | null {",
    "+  const index = deliveryStages.indexOf(stage);",
    "+  if (index === -1 || index === deliveryStages.length - 1) {",
    "+    return null;",
    "+  }",
    "+  return deliveryStages[index + 1] ?? null;",
    "+}",
    "+",
    " export function getProductSummary(): string {",
    "   return `${productName}: ${productThesis} — ${deliveryStages.join(\" → \")}`;",
    " }",
  ].join("\n"),
  "test/index.test.js": [
    "@@ -3,6 +3,7 @@ import test from \"node:test\";",
    " import {",
    "   deliveryStages,",
    "+  getNextDeliveryStage,",
    "   getProductSummary,",
    "   productName,",
    "   productThesis,",
    "@@ -17,3 +18,10 @@ test(\"exports the product identity and delivery thesis\", () => {",
    "     \"TrueForge Proof Board: Verified autonomous software delivery — Plan → Execute → Prove → Approve\",",
    "   );",
    " });",
    "+",
    "+test(\"returns the next delivery stage for every transition\", () => {",
    "+  assert.equal(getNextDeliveryStage(\"Plan\"), \"Execute\");",
    "+  assert.equal(getNextDeliveryStage(\"Execute\"), \"Prove\");",
    "+  assert.equal(getNextDeliveryStage(\"Prove\"), \"Approve\");",
    "+  assert.equal(getNextDeliveryStage(\"Approve\"), null);",
    "+});",
  ].join("\n"),
} as const;

export interface VerifiedDeliveryArtifact {
  baselineSha: string;
  files: Readonly<Record<string, string>>;
  patches: Readonly<Record<string, string>>;
  contentHash: string;
}

/**
 * A compact deterministic digest for the exact files and diff approved for
 * the locked demo fixture. This is intentionally local and does not require a
 * provider or a remote repository read.
 */
export function verifiedDeliveryArtifactHash(
  baselineSha: string,
  files: Readonly<Record<string, string>>,
  patches: Readonly<Record<string, string>>,
): string {
  const canonical = JSON.stringify({
    baselineSha,
    files: Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))),
    patches: Object.fromEntries(Object.entries(patches).sort(([left], [right]) => left.localeCompare(right))),
  });
  let hash = 2166136261;
  for (const character of canonical) {
    hash ^= character.codePointAt(0) as number;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export const PRIMARY_VERIFIED_DELIVERY_ARTIFACT: VerifiedDeliveryArtifact = {
  baselineSha: PRIMARY_DELIVERY_FIXTURE.baselineSha,
  files: PRIMARY_VERIFIED_DELIVERY_FILES,
  patches: PRIMARY_VERIFIED_DELIVERY_PATCHES,
  contentHash: verifiedDeliveryArtifactHash(
    PRIMARY_DELIVERY_FIXTURE.baselineSha,
    PRIMARY_VERIFIED_DELIVERY_FILES,
    PRIMARY_VERIFIED_DELIVERY_PATCHES,
  ),
};
