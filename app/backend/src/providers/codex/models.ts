import { isRecord } from "./utils.js"

const DEFAULT_CODEX_CLIENT_VERSION = "0.144.1"

const CODEX_VERSION_CACHE_TTL_MS = 60 * 60 * 1000
const CODEX_REGISTRY_URL = "https://registry.npmjs.org/@openai/codex/latest"

export type CodexModelInfo = {
	slug: string
	visibility?: string
	supportedInApi?: boolean
	useResponsesLite?: boolean
	supportVerbosity?: boolean
	defaultVerbosity?: string
	defaultReasoningLevel?: string
}

type RegistryPackageResponse = {
	version?: unknown
}

const normalizeVersion = (value: unknown): string | undefined => {
	if (typeof value !== "string") {
		return undefined
	}

	return value.trim().match(/\b\d+\.\d+\.\d+\b/)?.[0]
}

const optionalString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined

const optionalBoolean = (value: unknown): boolean | undefined =>
	typeof value === "boolean" ? value : undefined

const toCodexModelInfo = (value: unknown): CodexModelInfo | undefined => {
	if (!isRecord(value)) {
		return undefined
	}

	const slug = optionalString(value.slug)
	if (!slug) {
		return undefined
	}

	return {
		slug,
		visibility: optionalString(value.visibility),
		supportedInApi: optionalBoolean(value.supported_in_api),
		useResponsesLite: optionalBoolean(value.use_responses_lite),
		supportVerbosity: optionalBoolean(value.support_verbosity),
		defaultVerbosity: optionalString(value.default_verbosity),
		defaultReasoningLevel: optionalString(value.default_reasoning_level),
	}
}

const toUpstreamErrorMessage = (bodyText: string): string => {
	if (!bodyText) {
		return "Failed to load models from Codex."
	}

	try {
		const parsed = JSON.parse(bodyText)
		if (isRecord(parsed)) {
			if (typeof parsed.detail === "string" && parsed.detail.length > 0) {
				return parsed.detail
			}
			if (isRecord(parsed.error) && typeof parsed.error.message === "string") {
				return parsed.error.message
			}
		}
	} catch {}

	return bodyText
}

let cachedCodexClientVersion: string | undefined
let codexClientVersionCacheExpiresAt = 0
let inflightCodexClientVersion: Promise<string> | undefined

const resolveCodexClientVersion = async (): Promise<string> => {
	const now = Date.now()
	if (cachedCodexClientVersion && now < codexClientVersionCacheExpiresAt) {
		return cachedCodexClientVersion
	}

	if (inflightCodexClientVersion) {
		return inflightCodexClientVersion
	}

	inflightCodexClientVersion = (async () => {
		try {
			const response = await fetch(CODEX_REGISTRY_URL, {
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(2_500),
			})
			if (response.ok) {
				const parsed = (await response.json()) as RegistryPackageResponse
				const version = normalizeVersion(parsed.version)
				if (version) {
					cachedCodexClientVersion = version
					codexClientVersionCacheExpiresAt =
						Date.now() + CODEX_VERSION_CACHE_TTL_MS
					return version
				}
			}
		} catch {}

		cachedCodexClientVersion = DEFAULT_CODEX_CLIENT_VERSION
		codexClientVersionCacheExpiresAt = Date.now() + CODEX_VERSION_CACHE_TTL_MS
		return DEFAULT_CODEX_CLIENT_VERSION
	})().finally(() => {
		inflightCodexClientVersion = undefined
	})

	return inflightCodexClientVersion
}

export const fetchCodexModelCatalog = async (
	request: (path: string) => Promise<Response>,
): Promise<CodexModelInfo[]> => {
	const clientVersion = await resolveCodexClientVersion()
	const response = await request(
		`/models?client_version=${encodeURIComponent(clientVersion)}`,
	)
	const bodyText = await response.text()

	if (!response.ok) {
		throw new Error(toUpstreamErrorMessage(bodyText))
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(bodyText)
	} catch {
		throw new Error("Codex returned an invalid models response.")
	}

	if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
		throw new Error("Codex returned a malformed models response.")
	}

	const models = parsed.models
		.map(toCodexModelInfo)
		.filter((model): model is CodexModelInfo => model !== undefined)
	if (models.length === 0) {
		throw new Error("Codex returned an empty models list.")
	}

	return models
}

export const isPublicCodexModel = (model: CodexModelInfo): boolean =>
	model.supportedInApi !== false &&
	(model.visibility === undefined || model.visibility === "list")
