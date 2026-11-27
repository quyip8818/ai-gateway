import React from 'react';

const paths = {
  accounts: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-4m-5-9a4 4 0 1 1 0 8M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  key: 'M21 3h-4l-6 6a5 5 0 1 0 4 4l2-2V9h2l2-2V3Z',
  layers: 'm12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5',
  activity: 'M3 12h4l3-7 4 14 3-7h4',
  image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6m-5-9h.01',
  settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  refresh: 'M20 7v5h-5m5 0a8 8 0 1 0-2 6',
  logout: 'M10 4H5v16h5m-1-8h12m-4-4 4 4-4 4',
  video: 'M3 6h13v12H3zM16 10l5-3v10l-5-3',
  play: 'm9 5 11 7-11 7V5Z',
  download: 'M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4',
  expand: 'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5',
  close: 'm6 6 12 12M18 6 6 18',
  chevronLeft: 'm15 18-6-6 6-6',
  chevronRight: 'm9 6 6 6-6 6',
  check: 'm5 12 4 4 10-10',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
