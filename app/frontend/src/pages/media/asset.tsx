import React, { useEffect, useRef, useState } from 'react';
import type { MediaAsset } from '../../../../../shared/contracts/media.ts';
import { adminMediaUrl } from '../../api/admin.ts';
import { Icon } from '../../components/icon.tsx';
import { labels } from '../../labels.ts';
import { formatDate } from './presentation.tsx';

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MiB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KiB';
  return bytes + ' B';
}

function mediaTitle(asset: MediaAsset) {
  return asset.model.slice(asset.model.indexOf('/') + 1);
}

export function MediaCard({ asset, onPreview }: { asset: MediaAsset; onPreview: () => void }) {
  const [failed, setFailed] = useState(false);
  const title = mediaTitle(asset);
  const video = asset.type === 'video';
  const image = asset.type === 'image';
  const typeLabel = labels[asset.type] ?? asset.mime;
  return (
    <article className="media-card">
      <button type="button" className={video ? 'media-preview video-cover' : 'media-preview'}
        aria-label={'预览 ' + title} onClick={onPreview}>
        {image && !failed
          ? <img src={adminMediaUrl(asset.id)} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
          : <span className="preview-symbol"><Icon name={video ? 'play' : 'image'} size={28} /></span>}
        <span className="media-type"><Icon name={video ? 'video' : 'image'} size={13} />{typeLabel}</span>
        {image && !failed && <span className="preview-expand"><Icon name="expand" size={16} /></span>}
      </button>
      <div className="media-info">
        <div className="media-copy">
          <button type="button" className="media-title" title={title} onClick={onPreview}>{title}</button>
          <p>{labels[asset.provider] ?? asset.provider}<span aria-hidden="true"> · </span>
            <time dateTime={asset.created_at}>{formatDate(asset.created_at)}</time>
          </p>
        </div>
        <a className="icon-button quiet" href={adminMediaUrl(asset.id, true)}
          title="下载" aria-label={'下载 ' + title}><Icon name="download" size={17} /></a>
      </div>
    </article>
  );
}

export function MediaPreview({ asset, onClose }: { asset: MediaAsset; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [failed, setFailed] = useState(false);
  const title = mediaTitle(asset);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  return (
    <dialog ref={ref} className="asset-dialog" aria-labelledby="asset-title" onClose={onClose} onClick={(event) => {
      if (event.target === event.currentTarget) ref.current?.close();
    }}>
      <div className="asset-dialog-inner">
        <header>
          <div><h2 id="asset-title">{title}</h2>
            <p>{labels[asset.type] ?? asset.mime} · {formatBytes(asset.bytes)} · {formatDate(asset.created_at)}</p>
          </div>
          <div className="actions">
            <a className="quiet icon-text" href={adminMediaUrl(asset.id, true)}><Icon name="download" size={16} />下载</a>
            <button type="button" className="icon-button quiet" autoFocus aria-label="关闭预览"
              onClick={() => ref.current?.close()}><Icon name="close" /></button>
          </div>
        </header>
        <div className="asset-stage">
          {failed ? <p role="status">此文件暂时无法预览。</p> : asset.type === 'image' ? (
            <img src={adminMediaUrl(asset.id)} alt={title} onError={() => setFailed(true)} />
          ) : asset.type === 'video' ? (
            <video aria-label={title} controls playsInline preload="metadata"
              src={adminMediaUrl(asset.id)} onError={() => setFailed(true)} />
          ) : <p>此格式可下载查阅。</p>}
        </div>
      </div>
    </dialog>
  );
}
