import { useMemo, useState } from 'react';
import { ChevronRight, Globe, Plus, Video } from 'lucide-react';
import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { SegmentedTabs } from '@/components/design/SegmentedTabs';
import { StyleFrame } from './TemplateFrames';
import type { QcTemplate, QcWork } from './types';

type Filter = 'all' | 'active' | 'attention' | 'published';

export function workStatus(w: QcWork): { label: string; variant: 'subtle' | 'success' | 'danger' | 'warning' | 'new' } {
  if (w.status === 'queued') return { label: '排队中', variant: 'new' };
  if (w.status === 'running') return { label: '生成中', variant: 'new' };
  if (w.status === 'failed') return { label: '需要处理', variant: 'danger' };
  if (w.publishStatus === 'failed') return { label: '发布未完成', variant: 'warning' };
  if (w.publishStatus === 'done') return { label: '已发布', variant: 'success' };
  return { label: '已生成', variant: 'subtle' };
}

export function WorksList({ works, templates, onOpen, onCreate }: {
  works: QcWork[];
  templates: QcTemplate[];
  onOpen: (runId: string) => void;
  onCreate: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const counts = useMemo(() => ({
    active: works.filter(w => w.status === 'queued' || w.status === 'running').length,
    attention: works.filter(w => w.status === 'failed' || w.publishStatus === 'failed').length,
    published: works.filter(w => w.publishStatus === 'done').length,
  }), [works]);
  const shown = works.filter(w => filter === 'all'
    || (filter === 'active' && (w.status === 'queued' || w.status === 'running'))
    || (filter === 'attention' && (w.status === 'failed' || w.publishStatus === 'failed'))
    || (filter === 'published' && w.publishStatus === 'done'));
  const tpl = (id: string) => templates.find(t => t.id === id);

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 px-4 py-5 md:px-8 md:py-7" data-qc="works">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-token-muted">快速创作 · 我的作品</div>
          <h1 className="m-0 mt-1 text-[20px] font-semibold text-token-primary">文稿视频与网页 · {works.length}</h1>
        </div>
        <Button variant="primary" className="max-md:min-h-11" onClick={onCreate}><Plus size={15} />新建</Button>
      </div>
      {/* 公共组件 SegmentedTabs 沿用正式实现（32px），触控高度差异记为框架债务 */}
      <div className="overflow-x-auto" data-qc-touch-exempt>
        <SegmentedTabs<Filter>
          ariaLabel="按状态筛选"
          value={filter}
          onChange={setFilter}
          items={[
            { key: 'all', label: `全部 ${works.length}` },
            { key: 'active', label: `进行中 ${counts.active}` },
            { key: 'attention', label: `需要处理 ${counts.attention}` },
            { key: 'published', label: `已发布 ${counts.published}` },
          ]}
        />
      </div>
      <ul className="m-0 list-none divide-y divide-[var(--border-faint)] overflow-hidden rounded-[var(--radius-card)] border border-token-subtle bg-[var(--bg-card)] p-0">
        {shown.map(w => {
          const t = tpl(w.templateId);
          const st = workStatus(w);
          return (
            <li key={w.runId}>
              <button type="button" data-run-id={w.runId} onClick={() => onOpen(w.runId)} className="flex min-h-[64px] w-full items-center gap-3 px-3 py-2.5 text-left hover-bg-soft md:px-4">
                <span className="w-[88px] shrink-0 overflow-hidden rounded-md border border-token-subtle md:w-[104px]">
                  {t ? <StyleFrame template={t} scene={1} /> : <span className="block aspect-video bg-token-nested" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-[13.5px] font-medium leading-5 text-token-primary md:line-clamp-1">{w.title}</span>
                  <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-token-muted">
                    <span className="shrink-0 whitespace-nowrap"><Badge size="sm" variant={st.variant}>{st.label}</Badge></span>
                    {w.kind === 'video' ? <Video size={12} aria-label="视频" /> : <Globe size={12} aria-label="网页" />}
                    <span className="min-w-0 truncate">{t?.name ?? ''} · {w.summary}</span>
                  </span>
                </span>
                <span className="hidden shrink-0 text-[12px] text-token-muted md:block">{w.updatedAt}</span>
                <ChevronRight size={16} className="shrink-0 text-token-muted" aria-hidden />
              </button>
            </li>
          );
        })}
        {!shown.length && <li className="px-4 py-10 text-center text-[13px] text-token-muted">这个分类下暂时没有作品</li>}
      </ul>
    </div>
  );
}
