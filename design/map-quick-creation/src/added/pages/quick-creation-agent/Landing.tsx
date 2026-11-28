/**
 * 新建页（还没开始对话、也没有任务时）：居中一列，输入框是主角。
 * - 输入框下面：几个起头（放稿件或直接开聊），安静的文字按钮；
 * - 风格灵感：一排大海报，点一下就换成这个风格；「全部 99 种」打开风格库浮层；
 * - 最近作品：历史就在这里，不用去右上角找。「我的」列出全部任务（含进行中、失败），「团队」列出同事的成品。
 * 不套卡片：海报自己就是视觉重点，文字直接排在下面，靠留白分组。
 */
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowRight, ExternalLink, FolderOpen, Globe, Palette, Video, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { listQuickCreationAssets } from '@/services/real/quickCreation';
import { StyleFrame } from './TemplateFrames';
import { formatClock } from './format';
import type { QcAsset, QcTemplate, QcWork } from './types';

/** 通用浮层：风格库、资料管理、团队成品详情都用它；不另起页面，关掉就回到原处 */
export function Sheet({ open, onOpenChange, title, qc, wide, attrs, children }: { open: boolean; onOpenChange: (v: boolean) => void; title: string; qc: string; wide?: boolean; attrs?: Record<string, string | undefined>; children: React.ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-[var(--dialog-overlay)]" />
        <Dialog.Content data-qc={qc} aria-describedby={undefined} {...attrs}
          className={cn('qc-menu-surface fixed left-1/2 top-1/2 z-[101] flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl shadow-2xl',
            wide ? 'h-[min(86vh,820px)] w-[min(1100px,calc(100vw-24px))]' : 'max-h-[86vh] w-[min(720px,calc(100vw-24px))]')}>
          <div className="flex shrink-0 items-center justify-between gap-3 px-5 pb-2 pt-4">
            <Dialog.Title className="m-0 text-[16px] font-semibold text-token-primary">{title}</Dialog.Title>
            <Dialog.Close className="qc-icon-btn" aria-label="关闭"><X size={17} /></Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** 起头：放稿件的两种方式 + 直接开聊的三句话 */
export function Starters({ onSample, onKnowledge, onSay, showSay }: { onSample: () => void; onKnowledge: () => void; onSay: (t: string) => void; showSay: boolean }) {
  const chip = 'qc-face qc-face-quiet relative inline-flex items-center px-3 text-[13px] text-token-secondary';
  return (
    <div className="mt-4 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1" aria-label="从这里开始">
      <button type="button" data-qc="sample-doc" className={chip} onClick={onSample}>用示例稿件试一下</button>
      <button type="button" data-qc="pick-knowledge" className={chip} onClick={onKnowledge}>从知识库选</button>
      {showSay && ['我想做一个宣传片', '给新同事做个培训短片', '不知道选什么风格'].map(t => (
        <button key={t} type="button" data-qc="starter" data-value={t} className={chip} onClick={() => onSay(t)}>{t}</button>
      ))}
    </div>
  );
}

function SectionHead({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <h2 className="m-0 text-[15px] font-semibold text-token-primary">{title}</h2>
      {action}
    </div>
  );
}

const linkCls = 'inline-flex min-h-8 items-center gap-1 rounded-md text-[13px] text-token-secondary hover:text-token-primary max-md:min-h-11';

/** 风格灵感：每类取一种做海报，横向滑动；点一下换风格 */
export function StyleInspiration({ templates, selectedId, onSelect, onBrowseAll }: { templates: QcTemplate[]; selectedId?: string; onSelect: (id: string) => void; onBrowseAll: () => void }) {
  const picks: QcTemplate[] = [];
  for (const t of templates) if (!picks.some(p => p.categoryId === t.categoryId)) picks.push(t);
  return (
    <section className="mt-14" aria-label="风格灵感" data-qc="style-inspiration">
      <SectionHead title="风格灵感" action={<button type="button" className={linkCls} data-qc="style-library-open" onClick={onBrowseAll}>全部 {templates.length} 种<ArrowRight size={14} /></button>} />
      <div role="radiogroup" aria-label="挑一个风格" className="flex snap-x gap-4 overflow-x-auto pb-2" style={{ scrollbarWidth: 'none' }}>
        {picks.slice(0, 10).map(t => {
          const on = t.id === selectedId;
          return (
            <button key={t.id} type="button" role="radio" aria-checked={on} data-style={t.id} onClick={() => onSelect(t.id)}
              className="group w-[200px] shrink-0 snap-start text-left max-md:w-[160px]">
              <span className={cn('block overflow-hidden rounded-xl transition-[box-shadow,transform] duration-200 group-hover:-translate-y-0.5', on ? 'shadow-[0_0_0_2px_var(--accent-primary)]' : 'shadow-[var(--shadow-card-sm)]')}>
                <StyleFrame template={{ ...t, frame: undefined }} />
              </span>
              <span className={cn('mt-2 block truncate text-[13px]', on ? 'font-semibold text-token-primary' : 'text-token-primary')}>{t.name}</span>
              <span className="block truncate text-[12px] text-token-muted">{t.line}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function workStatus(w: QcWork): { text: string; tone: 'live' | 'warn' | 'muted' } | null {
  if (w.status === 'queued') return { text: '排队中', tone: 'live' };
  if (w.status === 'running') return { text: '生成中', tone: 'live' };
  if (w.status === 'failed') return { text: '需要处理', tone: 'warn' };
  if (w.publishStatus === 'done') return { text: '已发布', tone: 'muted' };
  return null;
}

function Poster({ template }: { template?: QcTemplate }) {
  return template ? <StyleFrame template={{ ...template, frame: undefined }} /> : <span className="block aspect-video bg-[var(--bg-tertiary)]" />;
}

/** 最近作品：历史就在新建页上。我的 = 全部任务；团队 = 同事做好的成品（点开可以把风格带回来） */
export function RecentWorks({ works, templates, onOpenWork, onAllWorks, onUseStyle, onOpenAsset, onOpenHosting, currentStyleId }: {
  works: QcWork[];
  templates: QcTemplate[];
  onOpenWork: (runId: string) => void;
  onAllWorks: () => void;
  onUseStyle: (a: QcAsset) => void;
  onOpenAsset: (a: QcAsset) => void;
  onOpenHosting: (a: QcAsset) => void;
  currentStyleId?: string;
}) {
  const [tab, setTab] = useState<'mine' | 'team'>('mine');
  const [team, setTeam] = useState<QcAsset[] | null>(null);
  const [detail, setDetail] = useState<QcAsset | null>(null);
  useEffect(() => {
    if (tab !== 'team' || team) return;
    void listQuickCreationAssets('team').then(res => setTeam(res.success ? res.data.items.filter(a => !a.mine) : []));
  }, [tab, team]);
  const style = (id: string) => templates.find(t => t.id === id);
  const tabCls = (on: boolean) => cn('relative inline-flex min-h-8 items-center text-[15px] max-md:min-h-11', on ? 'font-semibold text-token-primary' : 'text-token-muted hover:text-token-secondary');
  const detailStyle = detail ? style(detail.templateId) : undefined;
  return (
    <section className="mt-12" aria-label="最近作品" data-qc="recent-works" data-tab={tab}>
      <div className="mb-3 flex items-end justify-between gap-3">
        <div role="tablist" aria-label="最近作品" className="flex items-center gap-5">
          <button type="button" role="tab" aria-selected={tab === 'mine'} data-qc="recent-tab-mine" className={tabCls(tab === 'mine')} onClick={() => setTab('mine')}>我的作品</button>
          <button type="button" role="tab" aria-selected={tab === 'team'} data-qc="recent-tab-team" className={tabCls(tab === 'team')} onClick={() => setTab('team')}>团队在做</button>
        </div>
        {tab === 'mine' && <button type="button" className={linkCls} data-qc="all-works" onClick={onAllWorks}>全部 {works.length}<ArrowRight size={14} /></button>}
      </div>
      {tab === 'mine' ? (
        works.length ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4">
            {works.slice(0, 8).map(w => {
              const st = workStatus(w);
              return (
                <button key={w.runId} type="button" data-work={w.runId} onClick={() => onOpenWork(w.runId)} className="group min-w-0 text-left">
                  <span className="relative block overflow-hidden rounded-xl shadow-[var(--shadow-card-sm)] transition-transform duration-200 group-hover:-translate-y-0.5">
                    <Poster template={style(w.templateId)} />
                    {st && (
                      <span className={cn('qc-menu-surface absolute left-2 top-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium shadow-sm',
                        st.tone === 'live' ? 'text-[color:var(--accent-primary)]' : st.tone === 'warn' ? 'text-[color:var(--semantic-warning-text)]' : 'text-token-secondary')}>
                        {st.tone === 'live' && <span className="qc-pulse h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}{st.text}
                      </span>
                    )}
                  </span>
                  <span className="mt-2 block truncate text-[13px] text-token-primary">{w.title}</span>
                  <span className="flex items-center gap-1 truncate text-[12px] text-token-muted">
                    {w.kind === 'video' ? <Video size={11} className="shrink-0" aria-label="视频" /> : <Globe size={11} className="shrink-0" aria-label="网页" />}
                    <span className="truncate">{w.updatedAt}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : <p className="m-0 py-6 text-[13px] text-token-muted">做好的视频和网页会出现在这里。</p>
      ) : !team ? (
        <div className="flex items-center gap-2 py-6 text-[13px] text-token-muted"><MapSpinner size={13} />正在读取团队的成品</div>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4" data-qc="team-assets">
          {team.slice(0, 8).map(a => (
            <button key={a.id} type="button" data-asset={a.id} onClick={() => setDetail(a)} className="group min-w-0 text-left">
              <span className="block overflow-hidden rounded-xl shadow-[var(--shadow-card-sm)] transition-transform duration-200 group-hover:-translate-y-0.5"><Poster template={style(a.templateId)} /></span>
              <span className="mt-2 block truncate text-[13px] text-token-primary">{a.title}</span>
              <span className="block truncate text-[12px] text-token-muted">{a.ownerName} · {style(a.templateId)?.name ?? ''}</span>
            </button>
          ))}
        </div>
      )}
      <Sheet open={!!detail} onOpenChange={v => { if (!v) setDetail(null); }} title={detail?.title ?? ''} qc="asset-detail" attrs={{ 'data-asset-id': detail?.id }}>
        {detail && detailStyle && (
          <div className="px-5 pb-5">
            <div className="overflow-hidden rounded-xl"><StyleFrame template={detailStyle} scene={2} /></div>
            <div className="mt-3 text-[13px] text-token-secondary">
              {detail.ownerName} 做的 · {detail.kind === 'video' ? `视频 ${formatClock(detail.durationSec ?? 0)}` : `网页 ${detail.sections ?? 0} 节`} · 风格 {detailStyle.name} · {detail.updatedAt}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" data-qc="asset-use-style" disabled={currentStyleId === detailStyle.id} onClick={() => { onUseStyle(detail); setDetail(null); }}
                className="qc-face qc-face-primary-plain relative inline-flex items-center gap-1.5 px-3.5 text-[13px] font-medium disabled:opacity-50"><Palette size={14} />{currentStyleId === detailStyle.id ? '正在用这个风格' : '用这个风格'}</button>
              <button type="button" data-qc="asset-open" onClick={() => onOpenAsset(detail)} className="qc-face qc-face-chip relative inline-flex items-center gap-1.5 px-3.5 text-[13px] text-token-primary"><FolderOpen size={14} />打开看看</button>
              {detail.publishStatus === 'done' && detail.siteId && (
                <button type="button" data-qc="asset-hosting" onClick={() => onOpenHosting(detail)} className="qc-face qc-face-quiet relative inline-flex items-center gap-1.5 px-3 text-[13px] text-token-secondary"><ExternalLink size={14} />网页托管</button>
              )}
            </div>
          </div>
        )}
      </Sheet>
    </section>
  );
}
