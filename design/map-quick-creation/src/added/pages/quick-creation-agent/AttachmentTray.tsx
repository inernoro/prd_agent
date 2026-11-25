/**
 * 附件托盘。附件再多，输入框里也只占一行：
 * - 一行最多两个胶囊（文件名要读得出来），其余收成「+N」；
 * - 上方一行摘要：数量、可用字数、失败数；失败用错误色并可直接展开；
 * - 展开后是限高列表（超出滚动），按类型分组，失败排最前，逐项重试或移除。
 * 发送后，消息里用 SentAttachmentSummary 收成一行，点开在右栏回看。
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, BookOpen, Check, ChevronDown, FileText, Image as ImageIcon, RotateCcw, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { Button } from '@/components/design/Button';
import type { AttachmentKind, QcAttachment } from './types';
import { CHAR_BUDGET, KIND_LABEL, MAX_ATTACHMENTS, formatChars, sortAttachments, summarizeAttachments } from './format';

export function KindIcon({ kind, size = 14 }: { kind: AttachmentKind; size?: number }) {
  if (kind === 'kb') return <BookOpen size={size} className="text-[color:var(--accent-fg-info)]" aria-hidden />;
  if (kind === 'image') return <ImageIcon size={size} className="text-[color:var(--accent-fg-violet)]" aria-hidden />;
  return <FileText size={size} className="text-token-secondary" aria-hidden />;
}

function StatusMark({ item }: { item: QcAttachment }) {
  if (item.status === 'reading') return <MapSpinner size={12} />;
  if (item.status === 'failed') return <AlertTriangle size={13} className="text-[color:var(--accent-fg-error)]" aria-label="读取失败" />;
  return <Check size={13} className="text-[color:var(--accent-fg-success)]" aria-label="已读取" />;
}

function Chip({ item, onRemove }: { item: QcAttachment; onRemove?: () => void }) {
  return (
    <span
      className={cn(
        'inline-flex h-8 max-md:h-11 min-w-0 max-w-[176px] flex-1 items-center gap-1.5 rounded-[var(--radius-control)] border pl-2 pr-1 text-[12px]',
        item.status === 'failed'
          ? 'border-[color:var(--accent-fg-error)]/45 bg-[color:var(--accent-fg-error)]/[0.08]'
          : 'border-token-subtle bg-token-nested',
      )}
      title={`${item.name} · ${item.meta}`}
    >
      <KindIcon kind={item.kind} size={13} />
      <span className="min-w-0 flex-1 truncate text-token-primary">{item.name}</span>
      <StatusMark item={item} />
      {onRemove && (
        <button type="button" aria-label={`移除 ${item.name}`} onClick={onRemove}
          className="inline-flex h-6 w-6 max-md:h-11 max-md:w-9 shrink-0 items-center justify-center rounded-md text-token-muted hover-bg-soft hover:text-token-primary">
          <X size={12} />
        </button>
      )}
    </span>
  );
}

function rowMeta(item: QcAttachment): string {
  if (item.status === 'reading') return `${item.meta} · 正在读取 ${item.progress ?? 0}%`;
  if (item.status === 'failed') return item.meta;
  if (item.kind === 'image') return `${item.meta} · ${item.note ?? '作为画面参考，不读入旁白'}`;
  return `${item.meta} · 已读取 ${formatChars(item.chars ?? 0)} 字`;
}

function Row({ item, onRemove, onRetry, onOpen }: { item: QcAttachment; onRemove?: () => void; onRetry?: () => void; onOpen?: () => void }) {
  const failed = item.status === 'failed';
  return (
    <li className={cn('flex items-start gap-2.5 rounded-[var(--radius-field)] px-2.5 py-2', failed && 'bg-[color:var(--accent-fg-error)]/[0.06]')}>
      <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-token-nested"><KindIcon kind={item.kind} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {onOpen ? (
            <button type="button" onClick={onOpen} className="min-w-0 truncate text-left text-[13px] font-medium text-token-primary hover:underline">{item.name}</button>
          ) : (
            <span className="min-w-0 truncate text-[13px] font-medium text-token-primary">{item.name}</span>
          )}
          <StatusMark item={item} />
        </div>
        <div className="truncate text-[11.5px] text-token-muted">{rowMeta(item)}</div>
        {failed && item.error && <div className="mt-1 text-[12px] leading-5 text-[color:var(--accent-fg-error)]">{item.error}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {failed && onRetry && <Button size="xs" variant="secondary" className="max-md:min-h-11" onClick={onRetry}><RotateCcw size={12} />重试</Button>}
        {onRemove && (
          <button type="button" aria-label={`移除 ${item.name}`} onClick={onRemove}
            className="inline-flex h-7 w-7 max-md:h-11 max-md:w-11 items-center justify-center rounded-md text-token-muted hover-bg-soft hover:text-token-primary">
            <X size={14} />
          </button>
        )}
      </div>
    </li>
  );
}

const GROUPS: AttachmentKind[] = ['doc', 'kb', 'image'];

function GroupedList({ items, onRemove, onRetry, onOpen }: {
  items: QcAttachment[];
  onRemove?: (id: string) => void;
  onRetry?: (id: string) => void;
  onOpen?: (id: string) => void;
}) {
  const failed = items.filter(a => a.status === 'failed');
  const rest = sortAttachments(items.filter(a => a.status !== 'failed'));
  return (
    <div className="space-y-2">
      {failed.length > 0 && (
        <section aria-label="读取失败">
          <div className="px-2.5 pb-1 text-[11px] font-medium text-[color:var(--accent-fg-error)]">读取失败 · {failed.length}（不会用于生成）</div>
          <ul className="space-y-0.5">{failed.map(a => <Row key={a.id} item={a} onRemove={onRemove && (() => onRemove(a.id))} onRetry={onRetry && (() => onRetry(a.id))} onOpen={onOpen && (() => onOpen(a.id))} />)}</ul>
        </section>
      )}
      {GROUPS.map(kind => {
        const list = rest.filter(a => a.kind === kind);
        if (!list.length) return null;
        return (
          <section key={kind} aria-label={KIND_LABEL[kind]}>
            <div className="px-2.5 pb-1 text-[11px] text-token-muted">{KIND_LABEL[kind]} · {list.length}</div>
            <ul className="space-y-0.5">{list.map(a => <Row key={a.id} item={a} onRemove={onRemove && (() => onRemove(a.id))} onOpen={onOpen && (() => onOpen(a.id))} />)}</ul>
          </section>
        );
      })}
    </div>
  );
}

/** 输入框里的附件托盘 */
export function AttachmentTray({ items, onRemove, onRetry, onClearFailed, defaultExpanded = false }: {
  items: QcAttachment[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onClearFailed: () => void;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const sum = useMemo(() => summarizeAttachments(items), [items]);
  const ordered = useMemo(() => sortAttachments(items), [items]);
  if (!items.length) return null;
  /* 收起时只放两个胶囊，保证文件名读得出来；其余收进「+N」 */
  const visible = ordered.slice(0, 2);
  const hidden = ordered.length - visible.length;
  const overBudget = sum.chars > CHAR_BUDGET;

  return (
    <div className="rounded-[var(--radius-field)] border border-token-subtle bg-token-nested" data-qc="attachment-tray">
      <button type="button" data-qc="tray-toggle" onClick={() => setExpanded(v => !v)} aria-expanded={expanded}
        className="flex w-full items-center gap-2 whitespace-nowrap px-2.5 pt-2 text-left text-[12px] max-md:min-h-11 max-md:pt-0">
        <span className="min-w-0 truncate">
          <span className="font-medium text-token-primary">{sum.total} 个附件</span>
          <span className="text-token-muted"> · {formatChars(sum.chars)} 字</span>
          {sum.reading > 0 && <span className="text-token-muted"> · {sum.reading} 个读取中</span>}
          {sum.failed > 0 && <span className="font-medium text-[color:var(--accent-fg-error)]"> · {sum.failed} 个失败</span>}
        </span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-token-muted">{expanded ? '收起' : '管理'}<ChevronDown size={13} className={cn('transition-transform', expanded && 'rotate-180')} /></span>
      </button>
      {!expanded ? (
        <div className="flex items-center gap-1.5 overflow-hidden px-2 pb-2 pt-1.5">
          {visible.map(a => <Chip key={a.id} item={a} onRemove={() => onRemove(a.id)} />)}
          {hidden > 0 && (
            <button type="button" onClick={() => setExpanded(true)}
              className="inline-flex h-8 max-md:h-11 shrink-0 items-center rounded-[var(--radius-control)] border border-token-subtle px-2.5 text-[12px] text-token-secondary hover-bg-soft">
              +{hidden}
            </button>
          )}
        </div>
      ) : (
        <div className="px-1 pb-1.5 pt-1">
          <div className="max-h-[232px] overflow-y-auto pr-1" data-qc="attachment-list">
            <GroupedList items={items} onRemove={onRemove} onRetry={onRetry} />
          </div>
          <div className="flex items-center gap-2 border-t border-token-subtle px-2.5 pt-1.5 text-[11.5px] text-token-muted">
            <span className={cn(overBudget && 'text-[color:var(--accent-fg-warning)]')}>
              文字 {formatChars(sum.chars)} / {formatChars(CHAR_BUDGET)} · 附件 {sum.total} / {MAX_ATTACHMENTS}
            </span>
            {sum.failed > 0 && <button type="button" onClick={onClearFailed} className="ml-auto rounded px-1.5 py-0.5 hover-bg-soft hover:text-token-primary">移除失败项</button>}
          </div>
        </div>
      )}
    </div>
  );
}

/** 已发送消息里的附件：一行摘要，点开在右栏回看 */
export function SentAttachmentSummary({ items, onOpenAll, onOpen }: { items: QcAttachment[]; onOpenAll: () => void; onOpen: (id: string) => void }) {
  const used = items.filter(a => a.status === 'ready');
  const first = sortAttachments(used).slice(0, 2);
  const rest = used.length - first.length;
  return (
    <div className="flex max-w-full flex-wrap items-center justify-end gap-1.5" data-qc="sent-attachments">
      {first.map(a => (
        <button key={a.id} type="button" onClick={() => onOpen(a.id)} title={`回看 ${a.name}`}
          className="inline-flex h-8 max-md:h-11 max-w-[180px] items-center gap-1.5 rounded-[var(--radius-control)] border border-token-subtle bg-token-nested px-2 text-[12px] hover-bg-soft">
          <KindIcon kind={a.kind} size={13} /><span className="truncate text-token-primary">{a.name}</span>
        </button>
      ))}
      {rest > 0 && (
        <button type="button" data-qc="open-all-attachments" onClick={onOpenAll}
          className="inline-flex h-8 max-md:h-11 items-center rounded-[var(--radius-control)] border border-token-subtle px-2.5 text-[12px] text-token-secondary hover-bg-soft">
          全部 {used.length} 个附件
        </button>
      )}
    </div>
  );
}

/** 右栏的附件回看 */
export function AttachmentReview({ items, activeId, onSelect, onBack }: { items: QcAttachment[]; activeId?: string; onSelect: (id: string) => void; onBack: () => void }) {
  const used = items.filter(a => a.status === 'ready');
  const active = used.find(a => a.id === activeId) ?? used[0];
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 md:flex-row md:gap-4" data-qc="attachment-review">
      <div className="max-h-[200px] shrink-0 overflow-y-auto md:max-h-none md:w-[248px]">
        <GroupedList items={used} onOpen={onSelect} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col rounded-[var(--radius-card)] border border-token-subtle bg-token-nested">
        <div className="flex items-center gap-2 border-b border-token-subtle px-4 py-2.5">
          {active && <KindIcon kind={active.kind} />}
          <span className="min-w-0 truncate text-[14px] font-semibold text-token-primary">{active?.name}</span>
          <span className="text-[12px] text-token-muted">{active ? rowMeta(active) : ''}</span>
          <Button size="xs" variant="ghost" className="ml-auto max-md:min-h-11" onClick={onBack}>回到预览</Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap px-5 py-4 text-[13.5px] leading-7 text-token-secondary">
          {active?.kind === 'image' ? '这张图作为画面参考使用，不读入旁白。' : active?.excerpt ?? ''}
        </div>
      </div>
    </div>
  );
}
