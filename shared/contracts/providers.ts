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
