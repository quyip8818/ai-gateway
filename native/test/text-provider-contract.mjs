import { readFileSync } from 'node:fs';

export function testTool(model) {
  return {
    model,
    max_tokens: 32,
    messages: [{ role: 'user', content: 'fixture Kiro tool' }],
    tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
  };
}

export function normalizeTextContract(value) {
  if (Array.isArray(value)) return value.map(normalizeTextContract);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === 'conversationId' ? '<uuid>' : normalizeTextContract(item),
    ]),
  );
}

export function expectedTextProviders() {
  return JSON.parse(readFileSync(new URL('./fixtures/text-provider-contracts.json', import.meta.url), 'utf8'));
}
