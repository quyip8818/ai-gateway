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

export function ResourceError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="feedback feedback-error resource-error" role="alert">
      <span>{message}</span>
      <button className="quiet" type="button" onClick={retry}>重试</button>
    </div>
  );
}
