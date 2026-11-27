import React from 'react';
import type { Row } from '../api/admin.ts';
import { cellText } from '../labels.ts';

export function VideoTasks({ videos }: { videos: Row[] }) {
  return (
    <section>
      <h2>视频任务</h2>
      <div className="table">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>模型</th>
              <th>状态</th>
              <th>进度</th>
            </tr>
          </thead>
          <tbody>
            {videos.map((v) => (
              <tr key={v.id}>
                <td>{v.id}</td>
                <td>{cellText('model', v.model)}</td>
                <td>{cellText('status', v.status)}</td>
                <td>{cellText('progress', v.progress)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
