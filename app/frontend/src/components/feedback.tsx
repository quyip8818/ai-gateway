import React from 'react';

export type Notice = { kind: 'error' | 'success'; message: string };

export function Feedback({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  const error = notice.kind === 'error';
  return (
    <p className={error ? 'feedback feedback-error' : 'feedback'} role={error ? 'alert' : 'status'}>
      {notice.message}
    </p>
  );
}
