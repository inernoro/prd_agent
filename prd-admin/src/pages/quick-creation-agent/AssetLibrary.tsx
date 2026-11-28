/**
 * 右栏「产物」：已经生成的视频和网页。创作时回看自己和团队做过的成品，看同一个风格做出来是什么样，
 * 并能一键打开原任务、把风格带回输入框，已发布的直接去网页托管。
 * 只列已生成的成品；进行中、失败的任务在「我的作品」里管理，两处不重复。
 * 版式与风格库一致：上方是选中产物的大图与信息，下方按「我的 / 团队」和产出类型浏览。
 */
import { useState } from 'react';
import { ExternalLink, FolderOpen, Globe, Palette, Video } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { Segmented } from '@/components/web-hosting/workbench/WorkbenchParts';
import { StyleFrame } from './TemplateFrames';
import type { AssetScope, OutputKind, QcAsset, QcTemplate } from './types';
import { formatClock } from './format';

type KindFilter = 'all' | OutputKind;

function assetSize(a: QcAsset) {
  return a.kind === 'video' ? formatClock(a.durationSec ?? 0) : `${a.sections ?? 0} 节`;
}

export function AssetLibrary({ assets, loading, scope, onScopeChange, templates, onOpen, onUseStyle, onOpenHosting, currentStyleId }: {
  assets: QcAsset[];
  loading: boolean;
  scope: AssetScope;
  onScopeChange: (scope: AssetScope) => void;
  templates: QcTemplate[];
  onOpen: (asset: QcAsset) => void;
  onUseStyle: (asset: QcAsset) => void;
  onOpenHosting: (asset: QcAsset) => void;
  currentStyleId?: string;
}) {
  const [kind, setKind] = useState<KindFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const style = (id: string) => templates.find(t => t.id === id);
  const list = assets.filter(a => kind === 'all' || a.kind === kind);
  const selected = list.find(a => a.id === selectedId) ?? list[0];
  const selectedStyle = selected && style(selected.templateId);
  const count = (k: KindFilter) => assets.filter(a => k === 'all' || a.kind === k).length;

  return (
    <div className="h-full overflow-y-auto" style={{ overscrollBehavior: 'contain' }} data-qc="asset-library" data-scope={scope}>
      {selected && selectedStyle ? (
        <section className="grid gap-4 p-2.5 sm:p-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:p-5" aria-label="选中的产物" data-qc="asset-detail" data-asset-id={selected.id}>
          <div key={selected.id} className="qc-rise relative self-start overflow-hidden rounded-[12px] border border-token-subtle shadow-[var(--shadow-card-sm)]">
            <StyleFrame template={selectedStyle} scene={2} />
          </div>
          <div className="flex min-w-0 flex-col">
            <div className="flex items-center gap-2 text-[12px] text-token-muted">
              <span>{selected.mine ? '我做的' : `${selected.ownerName} 做的`}</span><span>·</span><span>{selected.updatedAt}</span>
              {selected.publishStatus === 'done' && <Badge size="sm" variant="success">已发布</Badge>}
              {selected.publishStatus === 'failed' && <Badge size="sm" variant="warning">发布未完成</Badge>}
            </div>
            <div className="mt-2 text-[18px] font-semibold leading-7 text-token-primary">{selected.title}</div>
            <div className="mt-1 flex items-center gap-1.5 text-[12.5px] text-token-secondary">
              {selected.kind === 'video' ? <Video size={13} aria-hidden /> : <Globe size={13} aria-hidden />}{selected.kind === 'video' ? '视频' : '网页'} · {assetSize(selected)}
            </div>
            <div className="mt-2 flex items-center gap-2 text-[13px] text-token-secondary">
              <span className="w-12 shrink-0 overflow-hidden rounded-[4px]"><StyleFrame template={{ ...selectedStyle, frame: undefined }} /></span>
              <span className="min-w-0 truncate">风格 · {selectedStyle.name}</span>
              {currentStyleId === selectedStyle.id && <span className="shrink-0 text-[11.5px] text-[color:var(--accent-primary)]">当前正在用</span>}
            </div>
            <p className="m-0 mt-3 text-[12.5px] leading-5 text-token-muted">
              {selected.mine ? '打开可以继续发布或改做另一种产出。' : '打开只能查看；想做同样的效果，把风格带回输入框，再放进你自己的稿件。'}
            </p>
            <div className="mt-auto flex flex-wrap gap-2 pt-3">
              <Button size="sm" variant="secondary" className="max-md:min-h-11" data-qc="asset-open" onClick={() => onOpen(selected)}><FolderOpen size={13} />打开</Button>
              <Button size="sm" variant="secondary" className="max-md:min-h-11" data-qc="asset-use-style" disabled={currentStyleId === selectedStyle.id} onClick={() => onUseStyle(selected)}>
                <Palette size={13} />用这个风格
              </Button>
              {selected.publishStatus === 'done' && selected.siteId && (
                <Button size="sm" variant="ghost" className="max-md:min-h-11" data-qc="asset-hosting" onClick={() => onOpenHosting(selected)}><ExternalLink size={13} />在网页托管中查看</Button>
              )}
            </div>
          </div>
        </section>
      ) : !loading && (
        <div className="px-6 pb-2 pt-10 text-center text-[13px] leading-6 text-token-muted">
          {scope === 'mine' ? '你还没有生成过产物。生成完成的视频和网页会出现在这里；切到「团队」看看同事做过的。' : '团队还没有生成过产物。'}
        </div>
      )}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-y border-token-subtle bg-[var(--bg-card)] px-2.5 py-2 sm:px-4 lg:px-5">
        {/* 公共组件 Segmented 沿用正式实现（28px），触控高度差异记为框架债务 */}
        <span data-qc-touch-exempt className="shrink-0">
          <Segmented<AssetScope> label="产物范围" value={scope} onChange={s => { onScopeChange(s); setSelectedId(null); }}
            options={[{ value: 'mine', label: '我的' }, { value: 'team', label: '团队' }]} />
        </span>
        <div role="radiogroup" aria-label="产出类型" className="flex gap-1.5">
          {([['all', '全部'], ['video', '视频'], ['web', '网页']] as const).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => { setKind(k); setSelectedId(null); }} data-kind={k}
              className={cn('inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[12px] max-md:h-11',
                kind === k ? 'border-[color:var(--accent-primary)] bg-[var(--selection-bg)] font-medium text-token-primary' : 'border-token-subtle text-token-secondary hover-bg-soft')}>
              {label}<span className="tabular-nums text-token-muted">{count(k)}</span>
            </button>
          ))}
        </div>
        {loading && <span className="ml-auto inline-flex items-center gap-1.5 text-[12px] text-token-muted"><MapSpinner size={12} />正在读取</span>}
      </div>
      <div role="radiogroup" aria-label="选择产物" className="grid grid-cols-2 gap-3 p-2.5 sm:grid-cols-3 sm:p-4 lg:p-5 2xl:grid-cols-4">
        {list.map(a => {
          const st = style(a.templateId);
          const on = a.id === selected?.id;
          return (
            <button key={a.id} type="button" role="radio" aria-checked={on} onClick={() => setSelectedId(a.id)} data-asset={a.id}
              className={cn('flex flex-col overflow-hidden rounded-[12px] border bg-[var(--bg-input)] text-left transition-[border-color,box-shadow]',
                on ? 'border-[color:var(--accent-primary)] shadow-[0_0_0_1px_var(--accent-primary)]' : 'border-token-subtle hover:border-[var(--border-default)]')}>
              <span className="block">
                {st ? <StyleFrame template={st} scene={2} /> : <span className="block aspect-video bg-[var(--bg-secondary)]" />}
              </span>
              <span className="block px-2.5 py-2">
                <span className="block truncate text-[13px] font-medium text-token-primary">{a.title}</span>
                <span className="flex items-center gap-1 truncate text-[11.5px] text-token-muted">
                  {a.kind === 'video' ? <Video size={11} className="shrink-0" aria-label="视频" /> : <Globe size={11} className="shrink-0" aria-label="网页" />}
                  <span className="truncate">{assetSize(a)} · {st?.name ?? '未知风格'} · {a.mine ? '我' : a.ownerName} · {a.updatedAt}</span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
