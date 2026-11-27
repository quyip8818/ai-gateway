import {
	type CodexModelInfo,
	fetchCodexModelCatalog,
	isPublicCodexModel,
} from "./models.js"
import { deriveChatGptAccountIsFedRamp } from "./oauth.ts"
import { collectCompletedResponseFromSse } from "./sse.js"
import { isRecord } from "./utils.js"

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite"

type CodexSession = {
	accessToken: string
	accountId: string
	isFedRamp?: boolean
	idToken?: string
}

const normalizeResponsesInput = (input: unknown): unknown =>
	typeof input === "string"
		? [
				{
					role: "user",
					content: [{ type: "input_text", text: input }],
				},
			]
		: input

const addEncryptedReasoningContent = (include: unknown): string[] => {
	const values = Array.isArray(include)
		? include.filter((value): value is string => typeof value === "string")
		: []
	if (!values.includes("reasoning.encrypted_content")) {
		values.push("reasoning.encrypted_content")
	}
	return values
}

const applyModelDefaults = (
	normalized: Record<string, unknown>,
	modelInfo: CodexModelInfo | undefined,
): void => {
	if (!modelInfo) {
		return
	}

	const reasoning = isRecord(normalized.reasoning)
		? { ...normalized.reasoning }
		: {}
	if (
		reasoning.effort === undefined &&
		modelInfo.defaultReasoningLevel !== undefined
	) {
		reasoning.effort = modelInfo.defaultReasoningLevel
	}
	if (modelInfo.useResponsesLite) {
		reasoning.context = "all_turns"
	}
	if (Object.keys(reasoning).length > 0) {
		normalized.reasoning = reasoning
	}

	if (modelInfo.supportVerbosity && modelInfo.defaultVerbosity !== undefined) {
		const text = isRecord(normalized.text) ? { ...normalized.text } : {}
		if (text.verbosity === undefined) {
			text.verbosity = modelInfo.defaultVerbosity
		}
		normalized.text = text
	}

	if (!modelInfo.useResponsesLite) {
		return
	}

	const input = Array.isArray(normalized.input) ? [...normalized.input] : []
	const prefix: unknown[] = []
	const tools = Array.isArray(normalized.tools) ? normalized.tools : []
	if (
		tools.length > 0 &&
		!input.some((item) => isRecord(item) && item.type === "additional_tools")
	) {
		prefix.push({
			type: "additional_tools",
			role: "developer",
			tools,
		})
	}

	if (typeof normalized.instructions === "string" && normalized.instructions) {
		prefix.push({
			role: "developer",
			content: [{ type: "input_text", text: normalized.instructions }],
		})
	}

	normalized.input = [...prefix, ...input]
	normalized.instructions = ""
	normalized.parallel_tool_calls = false
	delete normalized.tools
}

function codexHeaders(auth: CodexSession) {
	const headers = new Headers({
		authorization: `Bearer ${auth.accessToken}`,
		"chatgpt-account-id": auth.accountId,
	})
	const isFedRamp = auth.isFedRamp ??
		(deriveChatGptAccountIsFedRamp(auth.idToken) || deriveChatGptAccountIsFedRamp(auth.accessToken))
	if (isFedRamp) headers.set("x-openai-fedramp", "true")
	return headers
}

async function loadModels(auth: CodexSession, signal: AbortSignal) {
	return fetchCodexModelCatalog((path) => fetch(`${DEFAULT_CODEX_BASE_URL}${path}`, {
		headers: codexHeaders(auth),
		signal,
		redirect: "error",
	}))
}

export async function discoverCodexModels(auth: CodexSession, signal: AbortSignal) {
	const models = (await loadModels(auth, signal)).filter(isPublicCodexModel)
	if (!models.length) throw new Error("Codex returned no public models.")
	return models.map((model) => model.slug)
}

export async function requestCodexResponse(auth: CodexSession, body: Record<string, unknown>, signal: AbortSignal) {
	const headers = codexHeaders(auth)
	headers.set("content-type", "application/json")
	const models = await loadModels(auth, signal).catch(() => [])
	signal.throwIfAborted()
	const model = models.find((entry) => entry.slug === body.model)
	const normalized: Record<string, unknown> = {
		...body,
		instructions: typeof body.instructions === "string" ? body.instructions : "",
		input: normalizeResponsesInput(body.input),
		store: false,
		stream: true,
		include: addEncryptedReasoningContent(body.include),
	}
	applyModelDefaults(normalized, model)
	delete normalized.max_output_tokens
	if (model?.useResponsesLite) headers.set(RESPONSES_LITE_HEADER, "true")

	const response = await fetch(`${DEFAULT_CODEX_BASE_URL}/responses`, {
		method: "POST",
		headers,
		body: JSON.stringify(normalized),
		signal,
		redirect: "error",
	})
	if (body.stream === true || !response.ok || response.body == null) return response

	const completed = await collectCompletedResponseFromSse(response.body)
	const responseHeaders = new Headers(response.headers)
	responseHeaders.delete("content-encoding")
	responseHeaders.delete("content-length")
	responseHeaders.set("content-type", "application/json")
	return new Response(JSON.stringify(completed), {
		status: response.status,
		statusText: response.statusText,
		headers: responseHeaders,
	})
}
