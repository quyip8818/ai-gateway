import type { MessagesRequest } from "../anthropic/type.ts";
import { convertTools, type NormalMessage, normalizeMessages, systemText } from "./convert.ts";
import { nativeThinking, THINKING_FIELDS, THINKING_INSTRUCTION, thinkingAllowed, thinkingAsked } from "./thinking.ts";
import type { KiroHistoryEntry, KiroPayload, KiroUserInputMessage } from "./type.ts";

/**
 * What to say when a turn has no words of its own.
 *
 * ★Only the *current* message needs this, and only when it is empty in every
 * way. Empty `content` was treated as a 400 anywhere in the conversation, so
 * every wordless turn - which in an agent conversation is most of them, a tool
 * call one way and its result the other - carried a placeholder into the
 * prompt. The model reads its own history, and a transcript full of "(empty
 * placeholder)" eventually gets it written into an answer, which is how this
 * was noticed.
 *
 * Measured: empty `content` is accepted on history entries (assistant and
 * user), and on the current message when it carries tool results. The one
 * rejection is a current message with nothing at all - no text, no images, no
 * tool results - which happens when the client's last turn is the assistant's
 * and a user turn has to be invented to carry the request. "Continue." is what
 * that invented turn actually means.
 */
const CONTINUE_TEXT = "Continue.";

const buildUserMessage = (msg: NormalMessage, modelId: string): KiroUserInputMessage => {
  const out: KiroUserInputMessage = {
    content: msg.text,
    modelId,
    origin: "AI_EDITOR",
  };
  // Images belong directly on userInputMessage, not inside the context object.
  if (msg.images.length > 0) out.images = msg.images;
  if (msg.toolResults.length > 0) out.userInputMessageContext = { toolResults: msg.toolResults };
  return out;
};

export const buildPayload = (
  request: MessagesRequest,
  modelId: string,
  profileArn: string | undefined,
  conversationId: string,
): KiroPayload => {
  const { tools, documentation } = convertTools(request.tools);
  const hasTools = tools.length > 0;

  let system = systemText(request.system);
  if (documentation) system = system ? system + documentation : documentation.trim();
  // Reasoning is asked for here and parsed back out of the answer; the service
  // has no parameter for it. See kiro/thinking.ts for why it is not a tool.
  const native = thinkingAsked(request) && nativeThinking(modelId);
  if (thinkingAsked(request) && !native && thinkingAllowed(modelId)) {
    system = system ? `${system}\n\n${THINKING_INSTRUCTION}` : THINKING_INSTRUCTION;
  }

  // Past reasoning is not replayed with native thinking on: the model thinks
  // afresh each turn, as the Messages API does with earlier turns, and a
  // transcript full of written-out reasoning is what Opus's guard refuses.
  const messages = normalizeMessages(request.messages, hasTools, !native);
  if (messages.length === 0) throw new Error("No messages to send");

  const historyMessages = messages.slice(0, -1);
  const currentMessage = messages[messages.length - 1] as NormalMessage;

  // Kiro has no system role: the prompt is prepended to the earliest user turn
  // so it stays at the front of the conversation.
  if (system) {
    const firstUser = historyMessages[0] ?? currentMessage;
    firstUser.text = `${system}\n\n${firstUser.text}`;
  }

  const history: KiroHistoryEntry[] = [];
  for (const msg of historyMessages) {
    if (msg.role === "user") {
      history.push({ userInputMessage: buildUserMessage(msg, modelId) });
    } else {
      const assistant: KiroHistoryEntry = {
        assistantResponseMessage: {
          content: msg.text,
          // An empty toolUses array is itself a 400; only attach a populated one.
          ...(msg.toolUses.length > 0 ? { toolUses: msg.toolUses } : {}),
        },
      };
      history.push(assistant);
    }
  }

  const current = buildUserMessage(currentMessage, modelId);
  if (hasTools) {
    current.userInputMessageContext = { ...(current.userInputMessageContext ?? {}), tools };
  }

  // The final turn must be a user turn; fold a trailing assistant into history.
  if (currentMessage.role === "assistant") {
    history.push({
      assistantResponseMessage: {
        content: currentMessage.text,
        ...(currentMessage.toolUses.length > 0 ? { toolUses: currentMessage.toolUses } : {}),
      },
    });
    current.content = "";
    delete current.images;
  }

  // The one turn Kiro will not take empty: a current message with nothing
  // in it at all. Everything else keeps its own silence.
  if (!current.content && !current.images?.length && !current.userInputMessageContext?.toolResults?.length) {
    current.content = CONTINUE_TEXT;
  }

  const payload: KiroPayload = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId,
      currentMessage: { userInputMessage: current },
      ...(history.length > 0 ? { history } : {}),
    },
    ...(profileArn ? { profileArn } : {}),
    ...(native ? { additionalModelRequestFields: { ...THINKING_FIELDS } } : {}),
  };

  return payload;
};
