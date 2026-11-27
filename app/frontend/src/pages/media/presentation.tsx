import React from 'react';
import { Icon } from '../../components/icon.tsx';

const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

export function formatDate(value: string | number) {
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? '—' : dateFormat.format(date);
}

export function EmptyMedia({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty-panel">
      <span className="section-icon"><Icon name="image" size={22} /></span>
      <h2>{title}</h2>
      {children}
    </div>
  );
}
