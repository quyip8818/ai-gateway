import { randomUUID } from "node:crypto";
import { AppError } from "../../../domain.ts";
import { CONTEXT_WINDOW } from "../core/config.ts";
import type { KiroEvent } from "../kiro/type.ts";
import type { AnthropicContentBlock, AnthropicUsage, MessagesResponse, StopReason } from "./type.ts";

/**
 * Aggregates Kiro's event stream into Anthropic content blocks.
 *
 * Kiro emits tool input as a sequence of partial JSON fragments terminated by a
 * `stop` event, which lines up with Anthropic's `input_json_delta`. Text arrives
 * as plain chunks. This class gathers those fragments into a JSON response.
 */

type ToolAccumulator = {
  id: string;
  name: string;
  json: string;
};

export const messageId = (): string => `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

export const mapStopReason = (kiroReason: string | undefined, sawToolUse: boolean): StopReason => {
  if (sawToolUse) return "tool_use";
  switch (kiroReason) {
    case "END_TURN":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "TOOL_USE":
      return "tool_use";
    default:
      return "end_turn";
  }
};

/**
 * Rough token estimate.
 *
 * Kiro reports usage as opaque credits, not tokens, so exact counts are not
 * available. Clients (including Hermes) still expect the usage field to exist,
 * so we approximate at ~4 characters per token and label it clearly rather than
 * inventing precise-looking numbers.
 */
export const estimateTokens = (characters: number): number => Math.ceil(characters / 4);

/**
 * The prompt's size by Kiro's own count, when the service reported one.
 *
 * `contextUsagePercentage` is what the conversation fills once this reply is
 * in it - measured: a reply of 6,392 characters moved it by about 3,500 tokens
 * with the same prompt. So the reply is taken back out, using the same output
 * figure the usage reports, which keeps `input + output` exactly the service's
 * number however rough the output estimate is. That sum is what a client
 * sizing its next request against the window needs.
 */
const promptFromContext = (percent: number | undefined, outputToken: number): number | undefined => {
  if (percent === undefined || !Number.isFinite(percent) || percent < 0 || percent > 100) return undefined;
  return Math.max(1, Math.round(percent * CONTEXT_WINDOW / 100) - outputToken);
};

export function estimateUsage(prompt: number, textChars: number, reasoningChars: number, tools: number, contextPercent?: number): AnthropicUsage {
  const output = Math.max(1, estimateTokens(textChars)) + estimateTokens(reasoningChars) + tools * 8;
  return { input_tokens: promptFromContext(contextPercent, output) ?? prompt, output_tokens: output };
}

export class ResponseBuilder {
  private readonly tools = new Map<string, ToolAccumulator>();
  private readonly order: Array<
    | { kind: "text"; value: string }
    | { kind: "tool"; id: string }
    | { kind: "reasoning"; value: string; signature?: string }
  > = [];
  private textChars = 0;
  private reasoningChars = 0;
  private stopReason: string | undefined;
  private contextPercent: number | undefined;
  private refused = false;

  accept(event: KiroEvent): void {
    switch (event.type) {
      case "assistantResponse": {
        const chunk = event.data.content ?? "";
        if (!chunk) break;
        this.textChars += chunk.length;
        const last = this.order[this.order.length - 1];
        if (last?.kind === "text") last.value += chunk;
        else this.order.push({ kind: "text", value: chunk });
        break;
      }
      case "toolUse": {
        const { toolUseId, name, input } = event.data;
        let acc = this.tools.get(toolUseId);
        if (!acc) {
          acc = { id: toolUseId, name, json: "" };
          this.tools.set(toolUseId, acc);
          this.order.push({ kind: "tool", id: toolUseId });
        }
        if (input) acc.json += input;
        break;
      }
      case "reasoning": {
        const { text, signature } = event.data;
        const last = this.order[this.order.length - 1];
        const block = last?.kind === "reasoning" && !last.signature ? last : undefined;
        if (text) {
          this.reasoningChars += text.length;
          if (block) block.value += text;
          else this.order.push({ kind: "reasoning", value: text });
        } else if (signature && block) {
          block.signature = signature;
        }
        if (text && signature) {
          const current = this.order[this.order.length - 1];
          if (current?.kind === "reasoning") current.signature = signature;
        }
        break;
      }
      case "metadata":
        if (event.data.stopReason) this.stopReason = event.data.stopReason;
        this.refused ||= Boolean(event.data.stopDetails?.refusal);
        break;
      case "contextUsage":
        this.contextPercent = event.data.contextUsagePercentage ?? this.contextPercent;
        break;
      default:
        break;
    }
  }

  private blocks(): AnthropicContentBlock[] {
    const out: AnthropicContentBlock[] = [];
    for (const item of this.order) {
      if (item.kind === "reasoning") {
        out.push({ type: "thinking", thinking: item.value, ...(item.signature ? { signature: item.signature } : {}) });
        continue;
      }
      if (item.kind === "text") {
        out.push({ type: "text", text: item.value });
      } else {
        const acc = this.tools.get(item.id);
        if (!acc) continue;
        out.push({ type: "tool_use", id: acc.id, name: acc.name, input: parseToolInput(acc.json) });
      }
    }
    return out;
  }

  response(model: string, promptToken: number): MessagesResponse {
    if (this.refused && this.order.length === 0) throw new AppError(422, "request_refused");
    return {
      id: messageId(),
      type: "message",
      role: "assistant",
      model,
      content: this.blocks(),
      stop_reason: mapStopReason(this.stopReason, this.tools.size > 0),
      stop_sequence: null,
      usage: estimateUsage(promptToken, this.textChars, this.reasoningChars, this.tools.size, this.contextPercent),
    };
  }
}

/**
 * Parse accumulated tool-input JSON.
 *
 * A truncated stream can leave invalid JSON behind; an empty object is a better
 * outcome for the client than a thrown error mid-response.
 */
const parseToolInput = (json: string): Record<string, unknown> => {
  const trimmed = json.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
