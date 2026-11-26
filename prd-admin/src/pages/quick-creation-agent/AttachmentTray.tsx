/**
 * 资料（附件）。三处出现，同一套「资料卡」：
 * - 输入框顶部的托盘：一行摘要 + 最多两张资料卡 + 「+N」，附件再多也只占这一块；
 * - 右栏的资料面板：点托盘的「管理」打开，按读取失败 / 稿件 / 知识库文档 / 图片分组，逐项重试或移除，右侧看正文；
 * - 已发送消息里：两张资料卡 + 「全部 N 份」，点开在右栏回看（同一个面板的只读形态）。
 * 管理放到右栏：左栏装不下一张像样的列表，输入框也不该被它撑高。
 */
import { useMemo } from 'react';
import { AlertTriangle, BookOpen, ChevronRight, FileText, Image as ImageIcon, RotateCcw, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { Button } from '@/components/design/Button';
import type { AttachmentKind, QcAttachment } from './types';
import { CHAR_BUDGET, KIND_LABEL, MAX_ATTACHMENTS, formatChars, sortAttachments, summarizeAttachments } from './format';

const KIND_TINT: Record<AttachmentKind, { bg: string; fg: string }> = {
  doc: { bg: 'var(--semantic-neutral-soft)', fg: 'var(--text-secondary)' },
  kb: { bg: 'var(--semantic-info-soft)', fg: 'var(--accent-fg-info)' },
  image: { bg: 'var(--semantic-purple-soft)', fg: 'var(--accent-fg-violet)' },
};

export function KindIcon({ kind, size = 14 }: { kind: AttachmentKind; size?: number }) {
  if (kind === 'kb') return <BookOpen size={size} aria-hidden />;
  if (kind === 'image') return <ImageIcon size={size} aria-hidden />;
  return <FileText size={size} aria-hidden />;
}

/** 资料卡左侧的类型方块：失败换成错误色，读取中换成转圈 */
function KindSquare({ item, size = 28 }: { item: QcAttachment; size?: number }) {
  const failed = item.status === 'failed';
  const tint = KIND_TINT[item.kind];
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-lg" style={{
      width: size, height: size,
      background: failed ? 'var(--semantic-danger-soft)' : tint.bg,
      color: failed ? 'var(--accent-fg-error)' : tint.fg,
    }}>
      {item.status === 'reading' ? <MapSpinner size={13} /> : failed ? <AlertTriangle size={14} aria-label="读取失败" /> : <KindIcon kind={item.kind} />}
    </span>
  );
}

function shortStatus(item: QcAttachment): { text: string; tone: 'muted' | 'error' } {
  if (item.status === 'reading') return { text: `读取中 ${item.progress ?? 0}%`, tone: 'muted' };
  if (item.status === 'failed') return { text: '读取失败', tone: 'error' };
  if (item.kind === 'image') return { text: '画面参考', tone: 'muted' };
  return { text: `${formatChars(item.chars ?? 0)} 字`, tone: 'muted' };
}

/** 一张资料卡：类型方块 + 名称 + 一句状态 */
function Tile({ item, onRemove, onOpen }: { item: QcAttachment; onRemove?: () => void; onOpen?: () => void }) {
  const st = shortStatus(item);
  const body = (
    <>
      <KindSquare item={item} />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[12px] font-medium leading-4 text-token-primary">{item.name}</span>
        <span className="block truncate text-[11px] leading-4" style={{ color: st.tone === 'error' ? 'var(--accent-fg-error)' : 'var(--text-muted)' }}>{st.text}</span>
      </span>
    </>
  );
  return (
    <span title={`${item.name} · ${item.meta}`} data-att-tile={item.status}
      className="relative flex h-11 min-w-0 flex-1 basis-0 items-center rounded-[10px] border border-token-subtle bg-[var(--bg-card)] max-w-[220px] max-md:h-auto">
      {onOpen ? (
        <button type="button" onClick={onOpen} className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-[10px] pl-1.5 pr-2 hover-bg-soft max-md:min-h-11">{body}</button>
      ) : (
        <span className="flex h-full min-w-0 flex-1 items-center gap-2 pl-1.5 pr-1 max-md:min-h-11">{body}</span>
      )}
      {onRemove && (
        <button type="button" aria-label={`移除 ${item.name}`} onClick={onRemove}
          className="mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-token-muted hover-bg-soft hover:text-token-primary max-md:hidden">
          <X size={12} />
        </button>
      )}
    </span>
  );
}

/** 输入框顶部的资料托盘（只有收起形态；管理在右栏） */
export function AttachmentTray({ items, onRemove, onManage, managing }: {
  items: QcAttachment[];
  onRemove: (id: string) => void;
  onManage: () => void;
  managing: boolean;
}) {
  const sum = useMemo(() => summarizeAttachments(items), [items]);
  const ordered = useMemo(() => sortAttachments(items), [items]);
  if (!items.length) return null;
  /* 两张资料卡保证名称读得出来，其余收进「+N」 */
  const visible = ordered.slice(0, 2);
  const hidden = ordered.length - visible.length;

  return (
    <div className="px-2.5 pt-2" data-qc="attachment-tray" data-count={sum.total} data-failed-count={sum.failed} data-reading-count={sum.reading}>
      <button type="button" data-qc="tray-toggle" onClick={onManage} aria-expanded={managing}
        className="flex h-6 w-full items-center gap-2 whitespace-nowrap rounded-md px-1 text-left text-[12px] hover-bg-soft max-md:h-11">
        <span className="min-w-0 truncate">
          <span className="font-medium text-token-primary">{sum.total} 份资料</span>
          <span className="text-token-muted"> · {formatChars(sum.chars)} 字</span>
        </span>
        {sum.reading > 0 && <span className="shrink-0 rounded-full bg-[var(--bg-tertiary)] px-1.5 text-[11px] leading-[18px] text-token-secondary">{sum.reading} 读取中</span>}
        {sum.failed > 0 && <span className="shrink-0 rounded-full px-1.5 text-[11px] font-medium leading-[18px]" style={{ background: 'var(--semantic-danger-soft)', color: 'var(--accent-fg-error)' }}>{sum.failed} 失败</span>}
        <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-token-secondary">{managing ? '管理中' : '管理'}<ChevronRight size={13} /></span>
      </button>
      <div className="flex items-center gap-1.5 pb-2 pt-1">
        {visible.map(a => <Tile key={a.id} item={a} onRemove={() => onRemove(a.id)} />)}
        {hidden > 0 && (
          <button type="button" onClick={onManage} aria-label={`查看另外 ${hidden} 份资料`}
            className="inline-flex h-11 shrink-0 flex-col items-center justify-center rounded-[10px] border border-dashed border-[var(--border-default)] px-3 text-[12px] font-medium leading-4 text-token-primary hover-bg-soft">
            +{hidden}<span className="text-[10.5px] font-normal text-token-muted">更多</span>
          </button>
        )}
      </div>
    </div>
  );
}

function rowMeta(item: QcAttachment): string {
  if (item.status === 'reading') return `${item.meta} · 正在读取 ${item.progress ?? 0}%`;
  if (item.status === 'failed') return item.meta;
  if (item.kind === 'image') return `${item.meta} · ${item.note ?? '作为画面参考，不读入旁白'}`;
  return `${item.meta} · 已读取 ${formatChars(item.chars ?? 0)} 字`;
}

function Row({ item, active, onRemove, onRetry, onOpen }: { item: QcAttachment; active?: boolean; onRemove?: () => void; onRetry?: () => void; onOpen?: () => void }) {
  const failed = item.status === 'failed';
  return (
    <li data-att-id={item.id} data-att-status={item.status}
      className={cn('rounded-[10px] px-2.5 py-2 transition-colors', active && 'bg-[var(--selection-bg)]', !active && onOpen && 'hover-bg-soft')}>
      <div className="flex items-start gap-2.5">
      <KindSquare item={item} size={32} />
      <div className="min-w-0 flex-1">
        {onOpen ? (
          <button type="button" onClick={onOpen} className="block w-full min-w-0 truncate text-left text-[13px] font-medium text-token-primary max-md:min-h-11">{item.name}</button>
        ) : (
          <div className="truncate text-[13px] font-medium text-token-primary">{item.name}</div>
        )}
        <div className="truncate text-[11.5px] text-token-muted">{rowMeta(item)}</div>
        {item.status === 'reading' && (
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]"><div className="qc-bar-live h-full rounded-full" style={{ width: `${item.progress ?? 0}%` }} /></div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {failed && onRetry && <Button size="xs" variant="secondary" className="max-md:min-h-11" data-qc="att-retry" onClick={onRetry}><RotateCcw size={12} />重试</Button>}
        {onRemove && (
          <button type="button" data-qc="att-remove" aria-label={`移除 ${item.name}`} onClick={onRemove}
            className="inline-flex h-7 w-7 max-md:h-11 max-md:w-11 items-center justify-center rounded-md text-token-muted hover-bg-soft hover:text-token-primary">
            <X size={14} />
          </button>
        )}
      </div>
      </div>
      {failed && item.error && <div className="mt-1 pl-[42px] text-[12px] leading-5" style={{ color: 'var(--accent-fg-error)' }}>{item.error}</div>}
    </li>
  );
}

const GROUPS: AttachmentKind[] = ['doc', 'kb', 'image'];

function GroupedList({ items, activeId, onRemove, onRetry, onOpen }: {
  items: QcAttachment[];
  activeId?: string;
  onRemove?: (id: string) => void;
  onRetry?: (id: string) => void;
  onOpen?: (id: string) => void;
}) {
  const failed = items.filter(a => a.status === 'failed');
  const rest = sortAttachments(items.filter(a => a.status !== 'failed'));
  const head = (label: string, n: number, danger?: boolean) => (
    <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1 text-[11.5px] font-medium" style={{ color: danger ? 'var(--accent-fg-error)' : 'var(--text-muted)' }}>
      {label}<span className="tabular-nums">{n}</span>{danger && <span className="font-normal text-token-muted">· 不会用于生成</span>}
    </div>
  );
  return (
    <div className="space-y-2">
      {failed.length > 0 && (
        <section aria-label="读取失败" className="rounded-[12px] p-1" style={{ background: 'var(--semantic-danger-soft)' }}>
          {head('读取失败', failed.length, true)}
          <ul className="space-y-0.5">{failed.map(a => <Row key={a.id} item={a} active={a.id === activeId} onRemove={onRemove && (() => onRemove(a.id))} onRetry={onRetry && (() => onRetry(a.id))} />)}</ul>
        </section>
      )}
      {GROUPS.map(kind => {
        const list = rest.filter(a => a.kind === kind);
        if (!list.length) return null;
        return (
          <section key={kind} aria-label={KIND_LABEL[kind]} className="p-1">
            {head(KIND_LABEL[kind], list.length)}
            <ul className="space-y-0.5">{list.map(a => <Row key={a.id} item={a} active={a.id === activeId} onRemove={onRemove && (() => onRemove(a.id))} onOpen={onOpen && (() => onOpen(a.id))} />)}</ul>
          </section>
        );
      })}
    </div>
  );
}

function Excerpt({ item }: { item?: QcAttachment }) {
  if (!item) return <div className="flex h-full items-center justify-center p-6 text-[13px] text-token-muted">选一份资料查看正文</div>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2.5 border-b border-token-subtle px-5 py-3">
        <KindSquare item={item} />
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold text-token-primary">{item.name}</div>
          <div className="truncate text-[11.5px] text-token-muted">{rowMeta(item)}</div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap px-5 py-4 text-[13.5px] leading-7 text-token-secondary" style={{ overscrollBehavior: 'contain' }}>
        {item.status === 'reading' ? '正在读取，读完后这里显示正文。'
          : item.status === 'failed' ? '这份资料没有读出正文，不会用于生成。可以重试，或移除后换一个文件。'
            : item.kind === 'image' ? '这张图作为画面参考使用，不读入旁白。' : item.excerpt ?? '（正文较短，已全部读入）'}
      </div>
    </div>
  );
}

/**
 * 右栏的资料面板。manage：发送前管理（重试、移除、预算）；review：发送后只读回看。
 * 列表在左、正文在右；窄屏上下排。
 */
export function MaterialsPanel({ mode, items, activeId, onSelect, onRemove, onRetry, onClearFailed }: {
  mode: 'manage' | 'review';
  items: QcAttachment[];
  activeId?: string;
  onSelect: (id: string) => void;
  onRemove?: (id: string) => void;
  onRetry?: (id: string) => void;
  onClearFailed?: () => void;
}) {
  const list = mode === 'review' ? items.filter(a => a.status === 'ready') : items;
  const sum = summarizeAttachments(list);
  const active = list.find(a => a.id === activeId) ?? sortAttachments(list).find(a => a.status === 'ready') ?? list[0];
  const overBudget = sum.chars > CHAR_BUDGET;
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row" data-qc={mode === 'review' ? 'attachment-review' : 'materials-panel'}>
      <div className="flex min-h-0 shrink-0 flex-col border-token-subtle max-md:max-h-[50%] max-md:border-b md:w-[340px] md:border-r">
        <div className="min-h-0 flex-1 overflow-y-auto p-2" style={{ overscrollBehavior: 'contain' }} data-qc={mode === 'manage' ? 'attachment-list' : undefined}>
          {list.length ? (
            <GroupedList items={list} activeId={active?.id} onOpen={onSelect} onRemove={onRemove} onRetry={onRetry} />
          ) : (
            <div className="p-6 text-center text-[13px] text-token-muted">还没有资料。用左边输入框的上传或知识库按钮添加。</div>
          )}
        </div>
        {mode === 'manage' && (
          <div className="flex shrink-0 items-center gap-2 border-t border-token-subtle px-3.5 py-2 text-[11.5px] text-token-muted" data-qc="budget">
            <span style={overBudget ? { color: 'var(--accent-fg-warning)' } : undefined}>
              文字 {formatChars(sum.chars)} / {formatChars(CHAR_BUDGET)} · 附件 {sum.total} / {MAX_ATTACHMENTS}
            </span>
            {sum.failed > 0 && onClearFailed && <button type="button" onClick={onClearFailed} className="ml-auto rounded px-1.5 py-0.5 hover-bg-soft hover:text-token-primary max-md:min-h-11">移除失败项</button>}
          </div>
        )}
      </div>
      <div className="min-h-0 min-w-0 flex-1"><Excerpt item={active} /></div>
    </div>
  );
}

/** 已发送消息里的资料：两张资料卡 + 「全部 N 份」，点开在右栏回看 */
export function SentAttachments({ items, onOpenAll, onOpen }: { items: QcAttachment[]; onOpenAll: () => void; onOpen: (id: string) => void }) {
  const used = sortAttachments(items.filter(a => a.status === 'ready'));
  const first = used.slice(0, 2);
  return (
    <div className="flex w-full items-center gap-1.5" data-qc="sent-attachments">
      {first.map(a => <Tile key={a.id} item={a} onOpen={() => onOpen(a.id)} />)}
      <button type="button" data-qc="open-all-attachments" onClick={onOpenAll}
        className="inline-flex h-11 shrink-0 flex-col items-center justify-center rounded-[10px] border border-dashed border-[var(--border-default)] px-2.5 text-[12px] font-medium leading-4 text-token-primary hover-bg-soft">
        全部<span className="text-[10.5px] font-normal text-token-muted">{used.length} 份</span>
      </button>
    </div>
  );
}
