import { PING_INTERVAL_MS } from "../core/config.ts";
import { KiroApiError } from "../kiro/client.ts";
import type { KiroEvent } from "../kiro/type.ts";
import { estimateUsage, mapStopReason, messageId } from "./response.ts";

/**
 * Anthropic SSE streaming.
 *
 * The event order is part of the contract clients rely on:
 *   message_start
 *   (content_block_start -> content_block_delta* -> content_block_stop)*
 *   message_delta (stop_reason + usage)
 *   message_stop
 *
 * Kiro interleaves text and tool events freely, so an open block is closed
 * before a different block opens; indices stay monotonic.
 *
 * Native reasoning events use their own thinking blocks.
 */

const encoder = new TextEncoder();

const sse = (event: string, data: unknown): Uint8Array =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

type OpenBlock =
  | { kind: "text"; index: number }
  | { kind: "thinking"; index: number }
  | { kind: "tool"; index: number; id: string }
  | undefined;

export const streamResponse = (
  events: AsyncIterable<KiroEvent>,
  model: string,
  promptToken: number,
  abortUpstream: () => void,
): Response => {
  const id = messageId();
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Only the tool *count* feeds the usage estimate; the streamed JSON is
      // already forwarded to the client as input_json_delta and never re-read
      // here, so accumulating it would just hold large strings for nothing.
      const toolIds = new Set<string>();
      let open: OpenBlock;
      let nextIndex = 0;
      let textChars = 0;
      let stopReason: string | undefined;
      let thoughtChars = 0;
      let contextPercent: number | undefined;
      let refused = false;

      const closeOpen = (): void => {
        if (!open) return;
        controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: open.index }));
        open = undefined;
      };

      const heartbeat = setInterval(() => {
        if (!cancelled) controller.enqueue(sse("ping", { type: "ping" }));
      }, PING_INTERVAL_MS);

      const startBlock = (kind: "text" | "thinking"): { kind: "text" | "thinking"; index: number } => {
        closeOpen();
        const block = { kind, index: nextIndex++ };
        open = block;
        controller.enqueue(
          sse("content_block_start", {
            type: "content_block_start",
            index: block.index,
            content_block: kind === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" },
          }),
        );
        return block;
      };

      const writeContent = (kind: "text" | "thinking", text: string): void => {
        const block = open?.kind === kind ? open : startBlock(kind);
        if (kind === "thinking") thoughtChars += text.length;
        else textChars += text.length;
        controller.enqueue(
          sse("content_block_delta", {
            type: "content_block_delta",
            index: block.index,
            delta: kind === "thinking"
              ? { type: "thinking_delta", thinking: text }
              : { type: "text_delta", text },
          }),
        );
      };

      try {
        controller.enqueue(
          sse("message_start", {
            type: "message_start",
            message: {
              id,
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: promptToken, output_tokens: 0 },
            },
          }),
        );
        controller.enqueue(sse("ping", { type: "ping" }));

        for await (const event of events) {
          if (cancelled) return;

          if (event.type === "assistantResponse") {
            const chunk = event.data.content ?? "";
            if (!chunk) continue;
            writeContent("text", chunk);
            continue;
          }

          if (event.type === "reasoning") {
            const { text, signature } = event.data;
            if (text) writeContent("thinking", text);
            // The signature closes the block it belongs to. A model that chose
            // not to think sends one with no text; there is no block to sign.
            if (signature && open?.kind === "thinking") {
              controller.enqueue(
                sse("content_block_delta", {
                  type: "content_block_delta",
                  index: open.index,
                  delta: { type: "signature_delta", signature },
                }),
              );
              closeOpen();
            }
            continue;
          }

          if (event.type === "toolUse") {
            const { toolUseId, name, input, stop } = event.data;

            if (!(open?.kind === "tool" && open.id === toolUseId)) {
              closeOpen();
              open = { kind: "tool", index: nextIndex++, id: toolUseId };
              toolIds.add(toolUseId);
              controller.enqueue(
                sse("content_block_start", {
                  type: "content_block_start",
                  index: open.index,
                  content_block: { type: "tool_use", id: toolUseId, name, input: {} },
                }),
              );
            }

            if (input) {
              controller.enqueue(
                sse("content_block_delta", {
                  type: "content_block_delta",
                  index: open.index,
                  delta: { type: "input_json_delta", partial_json: input },
                }),
              );
            }
            if (stop) closeOpen();
            continue;
          }

          if (event.type === "contextUsage") {
            contextPercent = event.data.contextUsagePercentage ?? contextPercent;
            continue;
          }

          if (event.type === "metadata") {
            stopReason = event.data.stopReason ?? stopReason;
            refused ||= Boolean(event.data.stopDetails?.refusal);
          }
        }

        if (cancelled) return;
        closeOpen();

        if (refused && !textChars && !thoughtChars && !toolIds.size) {
          controller.enqueue(sse("error", {
            type: "error",
            error: { type: "invalid_request_error", code: "request_refused", message: "request_refused" },
          }));
          return;
        }

        const usage = estimateUsage(promptToken, textChars, thoughtChars, toolIds.size, contextPercent);
        controller.enqueue(
          sse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: mapStopReason(stopReason, toolIds.size > 0), stop_sequence: null },
            usage,
          }),
        );
        controller.enqueue(sse("message_stop", { type: "message_stop" }));
      } catch (error) {
        if (cancelled) return;
        const message = "Kiro upstream stream failed";
        // The HTTP status is already 200 by this point, so the failure has to be
        // reported inside the stream where the client will actually see it.
        controller.enqueue(
          sse("error", {
            type: "error",
            error: {
              type: error instanceof KiroApiError
                  ? "api_error"
                  : "internal_server_error",
              message,
            },
          }),
        );
      } finally {
        clearInterval(heartbeat);
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
      abortUpstream();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
};
