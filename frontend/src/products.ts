export const jimeng = {
  id: "jimeng",
  name: "即梦",
  description: "图片与视频生成",
  icon: "✧",
  protocol: "media",
  provider: "jimeng",
  providerName: "即梦",
  operations: [
    { id: "image.generate", label: "图片生成" },
    { id: "video.generate", label: "视频生成" },
  ],
  workspace: "media",
} as const;

export const products = [
  {
    id: "codex",
    name: "Codex",
    description: "OpenAI Responses",
    icon: ">_",
    protocol: "responses",
    provider: "openai",
    providerName: "OpenAI",
    operations: [{ id: "responses", label: "文本生成" }],
  },
  {
    id: "claude",
    name: "Claude Code",
    description: "Anthropic Messages",
    icon: "✳",
    protocol: "messages",
    provider: "anthropic",
    providerName: "Anthropic",
    operations: [{ id: "messages", label: "对话生成" }],
  },
  jimeng,
] as const;

export type Product = (typeof products)[number];

export const providers = [
  ...new Map(
    products.map(({ provider, providerName }) => [provider, providerName]),
  ),
];

export type ProductOperation = {
  id: string;
  label: string;
  product: Product;
};

export const operations = products.flatMap((product): ProductOperation[] =>
  product.operations.map((operation) => ({
    ...operation,
    product,
  })),
);

export const operationLabel = (id: string) =>
  operations.find((operation) => operation.id === id)?.label ?? id;
