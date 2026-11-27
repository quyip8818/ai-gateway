import type { MessagesRequest } from "../anthropic/type.ts";

const nativeThinkingUnsupported = new Set([
  "claude-haiku-4.5",
  "glm-5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

export const THINKING_FIELDS = { thinking: { type: "adaptive" } } as const;

export function useNativeThinking(request: MessagesRequest, modelId: string): boolean {
  return request.thinking !== undefined &&
    request.thinking.type !== "disabled" &&
    !nativeThinkingUnsupported.has(modelId);
}
