export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

export const isUUID = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

export const operations = ['responses', 'messages', 'image', 'video'] as const;

export const credentialKinds = {
  jimeng: ['cookie'],
  codex: ['oauth', 'api-key'],
  kiro: ['desktop', 'oidc'],
  claude: ['api-key'],
} as const;

export type Provider = keyof typeof credentialKinds;
export const providers = Object.keys(credentialKinds) as Provider[];
export const isProvider = (value: unknown): value is Provider =>
  typeof value === 'string' && Object.hasOwn(credentialKinds, value);
