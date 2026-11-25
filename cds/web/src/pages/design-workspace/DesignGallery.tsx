import { useEffect, useRef, useState } from 'react';
import type { DesignEntry, DesignRun, DesignTheme, DesignThumbnailStatus, DesignVersion } from '../../../../src/shared/design-workspace';
import { designViewports } from '../../../../src/shared/design-workspace';
import { designVisualKey } from '../../../../src/shared/design-visual';
import { usePlanningRead } from '../engineering-planning/planning-ui';
import { designArtifact, designPath, type DesignCommand } from './design-ui';

export function DesignThumbnail({ projectId, artifactId }: { projectId: string; artifactId?: string }) {
  const [failed, setFailed] = useState<string>();
  if (artifactId && failed !== artifactId) {
    return <img src={designArtifact(projectId, artifactId)} alt="" loading="lazy" onError={() => setFailed(artifactId)} />;
  }
  return <span className="dw-thumbnail-empty">
    <small>{artifactId ? '缩略图加载失败' : '缺少缩略图'}</small>
    <strong>打开原型</strong>
  </span>;
}

type Props = {
  entry: DesignEntry; version: DesignVersion; run?: DesignRun; theme: DesignTheme; zoom: number | null;
  canGenerate: boolean; busy: boolean; command: DesignCommand; onOpen: (id: string) => void;
  onThumbnailsUpdated?: () => void;
};

export function DesignGallery({ entry, version, run, theme, zoom, canGenerate, busy, command, onOpen, onThumbnailsUpdated }: Props) {
  const grid = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(25);
  const [reload, setReload] = useState(0);
  const [requested, setRequested] = useState(false);
  const reported = useRef(0);
  const refresh = () => setReload(value => value + 1);
  const path = designPath(entry.projectId) + '?' + new URLSearchParams({
    view: 'thumbnails', designId: entry.id, version: String(version.version),
  });
  const source = usePlanningRead<DesignThumbnailStatus>(path, reload);
  const status = source.data?.designId === entry.id && source.data.version === version.version ? source.data : undefined;
  const renders = status?.renders ?? version.renders;
  const running = status?.state === 'running';
  useEffect(() => {
    if (!running || source.loading || source.error) return;
    const timer = window.setTimeout(() => setReload(value => value + 1), 1500);
    return () => window.clearTimeout(timer);
  }, [running, reload, source.loading, source.error]);
  useEffect(() => {
    if (!status || running || status.completed <= reported.current) return;
    reported.current = status.completed;
    const saved = version.screens.reduce((count, screen) =>
      count + screen.themes.filter(color => version.renders?.[screen.id]?.[color]).length, 0);
    if (status.completed > saved) onThumbnailsUpdated?.();
  }, [status, running, version, onThumbnailsUpdated]);
  useEffect(() => {
    if (!grid.current) return;
    const observer = new ResizeObserver(([row]) => {
      setFit(Math.max(10, Math.min(27, (row.contentRect.width - 14) / designViewports.desktop.width * 100)));
    });
    observer.observe(grid.current);
    return () => observer.disconnect();
  }, []);

  const tiles = version.screens.map(screen => {
    const color = screen.themes.includes(theme) ? theme : screen.themes[0];
    const artifactId = renders?.[screen.id]?.[color]?.id
      ?? run?.visual?.[designVisualKey(screen.id, `${screen.viewport}-${color}`)]?.referenceImageId;
    return { screen, artifactId };
  });
  const missing = tiles.filter(tile => !tile.artifactId).length;
  let message = missing ? `${missing} 屏缺少缩略图，可直接打开原型。` : '';
  if (source.error) message = '缩略图进度暂时读不到，可继续打开原型。';
  else if (status?.state === 'unavailable') message = '自动生成缩略图暂不可用，可直接打开原型。';
  else if (status?.state === 'locked') message = '此版本已签收，可打开原型查看缺图画面。';
  else if (status?.state === 'running') message = `正在生成缩略图 ${status.completed}/${status.total} 张`;
  else if (status?.state === 'incomplete') {
    message = `仍有 ${status.total - status.completed} 张缩略图未生成，${canGenerate ? '可重试或打开原型' : '可直接打开原型'}。`;
  }
  else if (status?.state === 'idle' && !missing) message = `还有 ${status.total - status.completed} 张其他主题的缩略图待补。`;
  else if (status?.state === 'ready' && requested) message = '缩略图已补齐。';
  const retry = status?.state === 'incomplete';
  const canStart = canGenerate && !source.error && (status?.state === 'idle' || retry);
  const scale = (zoom ?? fit) / 100;
  return <div className="dw-gallery">
    {(message || canStart) && <div className="dw-thumbnail-tools">
      <span role="status">{message}</span>
      {source.error && <button type="button" className="ep-button" onClick={refresh}>重读缩略图状态</button>}
      {canStart && <button type="button" className="ep-button" disabled={busy || source.loading} onClick={() => {
        setRequested(true);
        void command('reference.generate', { designId: entry.id, version: version.version }).finally(refresh);
      }}>{retry ? '重试生成缩略图' : '生成缩略图'}</button>}
    </div>}
    <div className="dw-all-screens" ref={grid}>
      {tiles.map(({ screen, artifactId }, index) => {
        const { width, height } = designViewports[screen.viewport];
        return <button type="button" className="dw-gallery-open" key={screen.id} data-screen={screen.id}
          aria-label={`打开原型 ${screen.name}`} style={{ width: width * scale }} onClick={() => onOpen(screen.id)}>
          <span className="dw-gallery-art" style={{ height: height * scale }}>
            <DesignThumbnail projectId={entry.projectId} artifactId={artifactId} />
          </span>
          <span className="dw-gallery-title">{index + 1} · {screen.name}</span>
        </button>;
      })}
    </div>
  </div>;
}
