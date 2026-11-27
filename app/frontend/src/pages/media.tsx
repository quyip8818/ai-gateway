import React, { useRef, useState } from 'react';
import { mediaTypes, type MediaAsset, type MediaPage as AssetPage, type MediaType } from '../../../../shared/contracts/media.ts';
import { providers } from '../../../../shared/contracts/providers.ts';
import { type AdminApi } from '../api/admin.ts';
import { useAdminResource } from '../api/use-admin-resource.ts';
import { ResourceError } from '../components/feedback.tsx';
import { Icon } from '../components/icon.tsx';
import { labels } from '../labels.ts';
import { MediaCard, MediaPreview } from './media/asset.tsx';
import { EmptyMedia } from './media/presentation.tsx';
import { VideoTasks } from './media/video-tasks.tsx';

type BrowseProps = { api: AdminApi; revision: number };
type Filter = { type: MediaType | ''; provider: string; page: number };
const initialFilter: Filter = { type: '', provider: '', page: 1 };

export function MediaPage(props: BrowseProps) {
  const [view, setView] = useState<'library' | 'tasks'>('library');
  const [filter, setFilter] = useState(initialFilter);
  return (
    <>
      <div className="view-switch" role="group" aria-label="媒体视图">
        <button type="button" aria-pressed={view === 'library'} onClick={() => setView('library')}>
          <Icon name="image" />媒体库
        </button>
        <button type="button" aria-pressed={view === 'tasks'} onClick={() => setView('tasks')}>
          <Icon name="video" />视频任务
        </button>
      </div>
      {view === 'library' ? <MediaLibrary {...props} filter={filter} setFilter={setFilter} /> : <VideoTasks {...props} />}
    </>
  );
}

function MediaLibrary({ api, revision, filter, setFilter }: BrowseProps & {
  filter: Filter;
  setFilter: (filter: Filter) => void;
}) {
  const [preview, setPreview] = useState<MediaAsset>();
  const top = useRef<HTMLDivElement>(null);
  const query = new URLSearchParams({ page: String(filter.page) });
  if (filter.type) query.set('type', filter.type);
  if (filter.provider) query.set('provider', filter.provider);
  const { data, error, loading, refreshing, retry } = useAdminResource<AssetPage>(api, 'media?' + query, revision);
  const filtered = Boolean(filter.provider || filter.type);

  function movePage(page: number) {
    setFilter({ ...filter, page });
    top.current?.scrollIntoView({ block: 'nearest' });
  }

  return (
    <>
      <div className="media-toolbar" ref={top}>
        <div className="segmented" role="group" aria-label="媒体类型">
          {(['', ...mediaTypes] as const).map((type) => (
            <button type="button" key={type} aria-pressed={filter.type === type}
              onClick={() => setFilter({ ...filter, type, page: 1 })}>{type ? labels[type] : '全部'}</button>
          ))}
        </div>
        <div className="media-toolbar-side">
          {data && <span className="media-count" aria-live="polite">{data.total} 项资源</span>}
          <select aria-label="按供应商筛选" value={filter.provider}
            onChange={(event) => setFilter({ ...filter, provider: event.target.value, page: 1 })}>
            <option value="">全部供应商</option>
            {providers.map((provider) => <option key={provider} value={provider}>{labels[provider]}</option>)}
          </select>
        </div>
      </div>
      {error && <ResourceError message={error} retry={retry} />}
      <div aria-busy={refreshing}>
        {loading && (
          <>
            <p className="sr-only" role="status">正在读取媒体资源…</p>
            <div className="media-grid" aria-hidden="true">
              {Array.from({ length: 6 }, (_, index) => <div className="media-skeleton" key={index} />)}
            </div>
          </>
        )}
        {data?.items.length ? (
          <div className="media-grid">
            {data.items.map((asset) => <MediaCard key={asset.id} asset={asset} onPreview={() => setPreview(asset)} />)}
          </div>
        ) : data && (
          <EmptyMedia title={filtered ? '暂无匹配的媒体资源' : '暂无媒体资源'}>
            {filtered
              ? <button type="button" className="quiet" onClick={() => setFilter(initialFilter)}>清除筛选</button>
              : <p>生成并保存的图片和视频会显示在这里。</p>}
          </EmptyMedia>
        )}
      </div>
      {data && (data.total > 0 || data.page > 1) && (
        <div className="pagination" aria-label="媒体分页">
          <button className="quiet icon-text" type="button" disabled={data.page <= 1 || refreshing}
            onClick={() => movePage(data.page - 1)}><Icon name="chevronLeft" size={16} />上一页</button>
          <span>第 {data.page} / {data.total_pages} 页</span>
          <button className="quiet icon-text" type="button" disabled={data.page >= data.total_pages || refreshing}
            onClick={() => movePage(data.page + 1)}>下一页<Icon name="chevronRight" size={16} /></button>
        </div>
      )}
      {preview && <MediaPreview asset={preview} onClose={() => setPreview(undefined)} />}
    </>
  );
}
