import type { Provider } from './providers.ts';

export const mediaTypes = ['image', 'video'] as const;
export type MediaType = typeof mediaTypes[number];

export interface VideoOutput {
  width: number | null;
  height: number | null;
  duration_ms: number | null;
}

export interface MediaAsset {
  id: string;
  type: string;
  mime: string;
  bytes: number;
  model: string;
  provider: string;
  created_at: string;
}

export interface MediaPage {
  items: MediaAsset[];
  page: number;
  total: number;
  total_pages: number;
}

export interface MediaQuery {
  type?: MediaType;
  provider?: Provider;
  page: number;
  limit: number;
}
