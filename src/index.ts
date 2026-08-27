export const productName = "TrueForge Proof Board" as const;

export const productThesis = "Verified autonomous software delivery" as const;

export const deliveryStages = ["Plan", "Execute", "Prove", "Approve"] as const;

export type DeliveryStage = (typeof deliveryStages)[number];

export function getProductSummary(): string {
  return `${productName}: ${productThesis} — ${deliveryStages.join(" → ")}`;
}

export * from "./domain.js";
export * from "./persistence.js";
export * from "./trueforge.js";
export * from "./http/server.js";
export * from "./http/config.js";
