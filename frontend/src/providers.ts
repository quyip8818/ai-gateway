type Provider = {
  label: string;
  allowBackup: boolean;
  basePlaceholder?: string;
  credentialLabel?: string;
  credentialPlaceholder?: string;
  instructions?: string;
};

const providers = {
  openai: {
    label: "OpenAI",
    allowBackup: true,
    basePlaceholder: "https://api.openai.com",
  },
  anthropic: {
    label: "Anthropic",
    allowBackup: true,
    basePlaceholder: "https://api.anthropic.com",
  },
  jimeng: {
    label: "即梦",
    allowBackup: false,
    credentialLabel: "即梦托管 API Key",
    credentialPlaceholder: "jm_…",
    instructions:
      "先在 jimeng-api 管理台的「即梦账号池」保存账号 Cookie，再到「API 密钥」创建托管 Key，填入下方。",
  },
} satisfies Record<string, Provider>;

export type ProviderID = keyof typeof providers;
export const providerOptions = Object.keys(providers) as ProviderID[];

export function providerDetails(id: ProviderID): Provider {
  return providers[id];
}
