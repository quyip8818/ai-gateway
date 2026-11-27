import type { MetadataEvent } from "./type.ts";

/** The refusal a metadata event carries, as one readable line. */
export const refusalOf = (data: MetadataEvent): string | undefined => {
  const refusal = data.stopDetails?.refusal;
  if (!refusal) return undefined;
  return `Kiro refused this request (${refusal.category ?? "unknown"}): ${refusal.explanation ?? "no explanation"}`;
};

/**
 * Keep the request that came back empty, so the next one can be replayed.
 * Only the last one is kept; it holds the conversation, so it stays local.
 */
