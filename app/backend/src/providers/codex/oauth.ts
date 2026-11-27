import { createHash, randomBytes } from "node:crypto"
import { isRecord } from "./utils.js"

const DEFAULT_OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const DEFAULT_OPENAI_OAUTH_ISSUER = "https://auth.openai.com"
const DEFAULT_OPENAI_OAUTH_SCOPE = "openid profile email offline_access"
type OpenAIOAuthTokenResponse = {
	accessToken: string
	refreshToken?: string
	idToken?: string
	expiresIn?: number
	accountId?: string
}

function parseJwtClaims(token: string | undefined): Record<string, unknown> | undefined {
	const parts = token?.split(".")
	if (parts?.length !== 3 || !parts[1]) return undefined
	try {
		const parsed: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
		return isRecord(parsed) ? parsed : undefined
	} catch {
		return undefined
	}
}

export const deriveAccountId = (
	idToken: string | undefined,
): string | undefined => {
	const claims = parseJwtClaims(idToken)
	if (!claims) {
		return undefined
	}
	const authClaim = claims["https://api.openai.com/auth"]
	if (isRecord(authClaim)) {
		const accountId = authClaim.chatgpt_account_id
		if (typeof accountId === "string" && accountId.length > 0) {
			return accountId
		}
	}

	const topLevelAccountId = claims.chatgpt_account_id
	if (typeof topLevelAccountId === "string" && topLevelAccountId.length > 0) {
		return topLevelAccountId
	}

	const organizations = claims.organizations
	if (Array.isArray(organizations)) {
		const first = organizations[0]
		if (
			isRecord(first) &&
			typeof first.id === "string" &&
			first.id.length > 0
		) {
			return first.id
		}
	}

	return undefined
}

export const deriveChatGptAccountIsFedRamp = (
	token: string | undefined,
): boolean => {
	const claims = parseJwtClaims(token)
	if (!claims) {
		return false
	}

	const authClaim = claims["https://api.openai.com/auth"]
	return isRecord(authClaim) && authClaim.chatgpt_account_is_fedramp === true
}

const toTokenResponse = (payload: unknown): OpenAIOAuthTokenResponse => {
	if (!isRecord(payload)) {
		throw new Error("OpenAI OAuth token response must be a JSON object.")
	}

	const accessToken =
		typeof payload.access_token === "string" ? payload.access_token : undefined
	if (!accessToken) {
		throw new Error("OpenAI OAuth token response did not include access_token.")
	}

	const refreshToken =
		typeof payload.refresh_token === "string"
			? payload.refresh_token
			: undefined
	const idToken =
		typeof payload.id_token === "string" ? payload.id_token : undefined
	const expiresIn =
		typeof payload.expires_in === "number" ? payload.expires_in : undefined

	return {
		accessToken,
		refreshToken,
		idToken,
		expiresIn,
		accountId: deriveAccountId(idToken) ?? deriveAccountId(accessToken),
	}
}

const requestOpenAIOAuthTokens = async (options: {
	signal: AbortSignal
	body: Record<string, string>
	encoding: "form" | "json"
}): Promise<OpenAIOAuthTokenResponse> => {
	const isForm = options.encoding === "form"
	const response = await fetch(
		`${DEFAULT_OPENAI_OAUTH_ISSUER}/oauth/token`,
		{
			method: "POST",
			headers: {
				"Content-Type": isForm
					? "application/x-www-form-urlencoded"
					: "application/json",
			},
			body: isForm
				? new URLSearchParams(options.body).toString()
				: JSON.stringify(options.body),
			signal: options.signal,
			redirect: "error",
		},
	)
	const bodyText = await response.text()

	if (!response.ok) {
		let detail = ""
		try {
			const parsed = JSON.parse(bodyText)
			if (isRecord(parsed)) {
				const message =
					parsed.error_description ?? parsed.message ?? parsed.detail
				if (typeof message === "string") {
					detail = ` ${message}`
				}
			}
		} catch {}
		throw new Error(
			`OpenAI OAuth token request failed with HTTP ${response.status}.${detail}`,
		)
	}

	try {
		return toTokenResponse(JSON.parse(bodyText))
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error("OpenAI OAuth token response was not valid JSON.")
		}
		throw error
	}
}

export function createOpenAIOAuthRequest({ redirectUri }: { redirectUri: string }) {
	const state = randomBytes(24).toString("base64url")
	const codeVerifier = randomBytes(48).toString("base64url")
	const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
	const authorizationUrl = new URL(`${DEFAULT_OPENAI_OAUTH_ISSUER}/oauth/authorize`)
	authorizationUrl.search = new URLSearchParams({
		response_type: "code",
		client_id: DEFAULT_OPENAI_OAUTH_CLIENT_ID,
		redirect_uri: redirectUri,
		scope: DEFAULT_OPENAI_OAUTH_SCOPE,
		state,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
	}).toString()
	return { authorizationUrl: authorizationUrl.toString(), state, codeVerifier }
}

export function exchangeOpenAIOAuthCode(options: {
	code: string
	codeVerifier: string
	redirectUri: string
	signal: AbortSignal
}) {
	return requestOpenAIOAuthTokens({
		signal: options.signal,
		encoding: "form",
		body: {
			grant_type: "authorization_code",
			code: options.code,
			redirect_uri: options.redirectUri,
			client_id: DEFAULT_OPENAI_OAUTH_CLIENT_ID,
			code_verifier: options.codeVerifier,
		},
	})
}

export function refreshOpenAIOAuthTokens(options: { refreshToken: string; signal: AbortSignal }) {
	return requestOpenAIOAuthTokens({
		signal: options.signal,
		encoding: "json",
		body: {
			grant_type: "refresh_token",
			refresh_token: options.refreshToken,
			client_id: DEFAULT_OPENAI_OAUTH_CLIENT_ID,
		},
	})
}
