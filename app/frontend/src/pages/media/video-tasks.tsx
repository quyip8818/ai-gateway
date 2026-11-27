import React from 'react';
import { adminMediaUrl, type AdminApi, type Row } from '../../api/admin.ts';
import { useAdminResource } from '../../api/use-admin-resource.ts';
import { ResourceError } from '../../components/feedback.tsx';
import { Icon } from '../../components/icon.tsx';
import { cellText } from '../../labels.ts';
import { EmptyMedia, formatDate } from './presentation.tsx';

export function VideoTasks({ api, revision }: { api: AdminApi; revision: number }) {
  const { data: videos, error, loading, refreshing, retry } = useAdminResource<Row[]>(api, 'videos', revision);
  return (
    <>
      {error && <ResourceError message={error} retry={retry} />}
      {loading && <p className="loading-panel" role="status">正在读取视频任务…</p>}
      {videos?.length === 0 && <EmptyMedia title="暂无视频任务" />}
      {Boolean(videos?.length) && (
        <section className="panel task-panel" aria-busy={refreshing}>
          <div className="table">
            <table>
              <thead><tr><th>模型 / 任务 ID</th><th>状态</th><th>进度</th><th>创建时间</th><th>操作</th></tr></thead>
              <tbody>{videos?.map((video) => {
                const status = String(video.status);
                const progress = Math.min(100, Math.max(0, Number(video.progress) || 0));
                return (
                  <tr key={video.id}>
                    <td><strong>{cellText('model', video.model)}</strong><code className="task-id">{video.id}</code></td>
                    <td><span className={'status-pill task-status-' + status}>{cellText('status', status)}</span></td>
                    <td><div className="task-progress">
                      <progress value={progress} max={100} aria-label="生成进度" /><span>{progress}%</span>
                    </div></td>
                    <td>{typeof video.created_at === 'number' ? formatDate(video.created_at) : '—'}</td>
                    <td>{status === 'completed' && video.id.startsWith('video_') && (
                      <a className="icon-button quiet" href={adminMediaUrl(video.id.slice(6), true)}
                        title="下载视频" aria-label="下载视频"><Icon name="download" size={17} /></a>
                    )}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
