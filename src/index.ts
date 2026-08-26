export const productName = "TrueForge Proof Board" as const;

export const productThesis = "Verified autonomous software delivery" as const;

export const deliveryStages = ["Plan", "Execute", "Prove", "Approve"] as const;

export type DeliveryStage = (typeof deliveryStages)[number];

export function getProductSummary(): string {
  return `${productName}: ${productThesis} — ${deliveryStages.join(" → ")}`;
}
