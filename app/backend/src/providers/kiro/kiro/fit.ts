import { CONTEXT_WINDOW } from '../core/config.ts';

export function measuredPromptToken(percent: number) {
  return Number.isFinite(percent) && percent >= 0 && percent <= 100
    ? Math.round(percent * CONTEXT_WINDOW / 100)
    : undefined;
}
