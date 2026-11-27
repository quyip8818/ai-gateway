import { randomUUID } from "node:crypto";
import { EventStreamDecoder } from "./event-stream.ts";
import type {
  AssistantResponseEvent,
  ContextUsageEvent,
  KiroEvent,
  MetadataEvent,
  MeteringEvent,
  ReasoningContentEvent,
  ToolUseEvent,
} from "./type.ts";

/** Mirrors the Kiro IDE client so the service accepts our requests. */
const buildHeaders = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/x-amz-json-1.0",
  "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
  "user-agent":
    "aws-sdk-js/1.0.27 ua/2.1 os/win32#10.0.19044 lang/js md/nodejs#22.21.1 api/codewhispererstreaming#1.0.27 m/E KiroIDE-0.7.45-kiro-api",
  "x-amz-user-agent": "aws-sdk-js/1.0.27 KiroIDE-0.7.45-kiro-api",
  "x-amzn-codewhisperer-optout": "true",
  "x-amzn-kiro-agent-mode": "vibe",
  "amz-sdk-invocation-id": randomUUID(),
  "amz-sdk-request": "attempt=1; max=3",
});

const parseJson = (bytes: Uint8Array): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const toEvent = (eventType: string, raw: Record<string, unknown>): KiroEvent => {
  switch (eventType) {
    case "assistantResponseEvent":
      return { type: "assistantResponse", data: raw as AssistantResponseEvent };
    case "toolUseEvent":
      return { type: "toolUse", data: raw as unknown as ToolUseEvent };
    case "metadataEvent":
      return { type: "metadata", data: raw as MetadataEvent };
    case "reasoningContentEvent":
      return { type: "reasoning", data: raw as ReasoningContentEvent };
    case "contextUsageEvent":
      return { type: "contextUsage", data: raw as ContextUsageEvent };
    case "meteringEvent":
      return { type: "metering", data: raw as MeteringEvent };
    default:
      return { type: "unknown", name: eventType, data: raw };
  }
};

export class KiroApiError extends Error {
  constructor(
    override readonly message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "KiroApiError";
  }
}

export async function* invoke(body: string, token: string, region: string, oidc: boolean, signal?: AbortSignal, send = fetch): AsyncGenerator<KiroEvent> {
  const response = await send(`https://runtime.${region}.kiro.dev/generateAssistantResponse`, {
    method: "POST", headers: { ...buildHeaders(token), ...(oidc ? { tokentype: "SSO_OIDC" } : {}) }, body, signal, redirect: "error",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new KiroApiError(extractMessage(body, response.status), response.status, body);
  }
  if (!response.body) throw new KiroApiError("Kiro returned an empty body", 502, "");

  const decoder = new EventStreamDecoder();
  const reader = response.body.getReader();
  let drained = false;
  let terminalEvent = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        break;
      }
      if (!value) continue;

      for (const frame of decoder.push(value)) {
        const eventType = frame.headers[":event-type"] ?? "";
        const messageType = frame.headers[":message-type"] ?? "";

        // AWS signals modelled errors through the frame headers, not the status.
        if (messageType === "exception" || eventType.endsWith("Exception")) {
          const raw = parseJson(frame.payload);
          const message = typeof raw.message === "string" ? raw.message : `Kiro exception: ${eventType}`;
          throw new KiroApiError(message, 400, new TextDecoder().decode(frame.payload));
        }

        const event = toEvent(eventType, parseJson(frame.payload));
        if (event.type === "metering" || event.type === "metadata" && event.data.stopReason) terminalEvent = true;
        yield event;
      }
    }
    if (!terminalEvent || decoder.pending > 0) throw new KiroApiError("Truncated Kiro event stream", 502, "");
  } finally {
    reader.releaseLock();
    // releaseLock alone leaves the body live — it keeps streaming from the
    // socket. Any early exit (a thrown frame, a client disconnect running the
    // generator's return()) must cancel it or the connection leaks.
    if (!drained) await response.body.cancel().catch(() => {});
  }
}

/** Kiro reports most problems as a JSON body with a `message` field. */
const extractMessage = (body: string, status: number): string => {
  try {
    const parsed = JSON.parse(body) as { message?: string; reason?: string };
    return parsed.message ?? parsed.reason ?? `Kiro request failed with status ${status}`;
  } catch {
    return body.slice(0, 300) || `Kiro request failed with status ${status}`;
  }
};
