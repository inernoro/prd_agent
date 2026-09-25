import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Plus, Send, Square, X, type LucideIcon } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';

/**
 * 生成工作台的公共部件：一个对话 + 一个预览。
 *
 * 版式契约（2026-09-24 用户：「一个对话框，一个预览框，而非点点点、戳戳戳」）：
 * - 左边只有对话流和底部一个输入框；资料、截图、风格都从输入框里加，不另开步骤。
 * - 右边永远是「此刻最接近成品的那一页」：样张 → 生成中的真实页面 → 成品 / 草稿。
 * - 每一屏都要让人预判下一步：按钮写清按下去得到什么，预览栏底部一句话说明接下来会怎样。
 */

export type WorkbenchPane = 'chat' | 'preview';

/** 桌面左右两栏；窄屏收成「对话 / 预览」两个页签，一次只显示一个。 */
export function WorkbenchLayout({ pane, conversation, composer, preview }: {
  pane: WorkbenchPane;
  conversation: ReactNode;
  composer: ReactNode;
  preview: ReactNode;
}) {
  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)]">
      <section
        aria-label="对话"
        data-workbench-pane="chat"
        className={`${pane === 'chat' ? 'flex' : 'hidden'} relative min-h-0 flex-col overflow-hidden rounded-[14px] lg:flex`}
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" style={{ overscrollBehavior: 'contain' }}>
          <div className="flex flex-col gap-3">{conversation}</div>
        </div>
        <div className="shrink-0 px-3 pb-3 pt-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          {composer}
        </div>
      </section>
      <section
        aria-label="预览"
        data-workbench-pane="preview"
        className={`${pane === 'preview' ? 'flex' : 'hidden'} min-h-0 flex-col lg:flex`}
      >
        {preview}
      </section>
    </div>
  );
}

/** 窄屏标题栏里的「对话 / 预览」切换。 */
export function PaneTabs({ pane, onChange, previewBadge }: {
  pane: WorkbenchPane;
  onChange: (pane: WorkbenchPane) => void;
  previewBadge?: string;
}) {
  const item = (value: WorkbenchPane, label: string, badge?: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={pane === value}
      onClick={() => onChange(value)}
      className="inline-flex h-8 items-center gap-1 rounded-md px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2"
      style={pane === value
        ? { background: 'var(--bg-elevated)', color: 'var(--text-primary)' }
        : { color: 'var(--text-secondary)' }}
    >
      {label}
      {badge && <span className="rounded px-1 text-[10px]" style={{ background: 'var(--selection-bg)', color: 'var(--accent-primary)' }}>{badge}</span>}
    </button>
  );
  return (
    <div role="tablist" aria-label="对话与预览" className="flex rounded-lg p-0.5 lg:hidden" style={{ background: 'var(--bg-tertiary)' }}>
      {item('chat', '对话')}
      {item('preview', '预览', previewBadge)}
    </div>
  );
}

export function UserBubble({ text, chips }: { text: string; chips?: string[] }) {
  return (
    <div
      className="ml-auto flex max-w-[92%] flex-col gap-1.5 rounded-xl px-3 py-2.5"
      style={{ background: 'var(--selection-bg)' }}
    >
      <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-token-primary">{text}</p>
      {chips && chips.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {chips.map((chip) => (
            <span key={chip} className="max-w-full truncate rounded-md px-1.5 py-0.5 text-[11px] text-token-secondary" style={{ background: 'var(--bg-tertiary)' }}>
              {chip}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function AssistantBubble({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'success' | 'warning' }) {
  const style = tone === 'success'
    ? { background: 'var(--semantic-success-soft)', border: '1px solid var(--semantic-success-border)' }
    : tone === 'warning'
      ? { background: 'var(--semantic-warning-soft)', border: '1px solid var(--semantic-warning-border)' }
      : { background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' };
  return (
    <div className="mr-auto flex w-full max-w-[96%] flex-col gap-2 rounded-xl px-3 py-2.5 text-[13px] leading-relaxed text-token-primary" style={style}>
      {children}
    </div>
  );
}

export interface ProgressStep {
  key: string;
  label: string;
  state: 'done' | 'active' | 'todo';
}

/**
 * 任务进行中的那条助手消息：做到哪一步、用了多久、实际用的哪个模型、模型此刻在想什么。
 * 静止的「生成中」超过 2 秒就是缺陷（AGENTS.md §6），所以这里每秒都有东西在变。
 */
export function RunProgressCard({
  title,
  clock,
  estimate,
  runtimeLabel,
  resolvedModel,
  provenance,
  steps,
  activity,
  thinking,
  onStop,
  stopRequested,
  canStop,
  stopHint,
}: {
  title: string;
  clock: string;
  estimate?: string;
  runtimeLabel?: string;
  resolvedModel?: { model: string; platform: string } | null;
  provenance?: string | null;
  steps: ProgressStep[];
  activity: string;
  thinking?: string;
  onStop?: () => void;
  stopRequested?: boolean;
  canStop?: boolean;
  stopHint: string;
}) {
  return (
    <AssistantBubble>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-semibold"><MapSpinner size={13} />{title}</div>
          {resolvedModel && (
            <p className="mt-0.5 font-mono text-[11px] text-token-muted">
              {/* ai-model-visibility：换了模型结果就会不同，所以摆在进度卡最上面，不藏进折叠区。 */}
              <span aria-hidden="true">●</span> {resolvedModel.model} · {resolvedModel.platform}
            </p>
          )}
          {provenance && <p className="mt-0.5 text-[11px] text-token-muted">{provenance}</p>}
        </div>
        <div className="shrink-0 text-right text-[11px] text-token-muted">
          <div className="font-mono text-[13px] tabular-nums text-token-primary">{clock}</div>
          {runtimeLabel && <div className="max-w-28 truncate">{runtimeLabel}</div>}
        </div>
      </div>
      <ol className="flex flex-col gap-1" aria-label="任务步骤">
        {steps.map((step) => (
          <li key={step.key} aria-current={step.state === 'active' ? 'step' : undefined} className="flex items-center gap-2 text-[12px]">
            <span
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
              style={step.state === 'done'
                ? { background: 'var(--semantic-success-soft)', color: 'var(--semantic-success-text)' }
                : step.state === 'active'
                  ? { background: 'var(--selection-bg)', color: 'var(--accent-primary)' }
                  : { border: '1px solid var(--border-default)' }}
            >
              {step.state === 'done' ? <Check size={10} strokeWidth={3} /> : step.state === 'active' ? <MapSpinner size={9} /> : null}
            </span>
            <span className={step.state === 'todo' ? 'text-token-muted' : 'text-token-primary'}>{step.label}</span>
          </li>
        ))}
      </ol>
      <p aria-live="polite" className="text-[11px] text-token-secondary">{activity}{estimate ? ` · ${estimate}` : ''}</p>
      {thinking && (
        <p className="line-clamp-3 rounded-lg px-2 py-1.5 text-[11px] text-token-muted" style={{ background: 'var(--bg-card)' }}>
          <span className="font-medium text-token-secondary">正在分析：</span>{thinking}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-token-muted">{stopHint}</p>
        {onStop && (
          <button
            type="button"
            onClick={onStop}
            disabled={!canStop || stopRequested}
            className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-lg px-2.5 text-[12px] font-medium transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2"
            style={{ border: '1px solid var(--semantic-danger-border)', color: 'var(--semantic-danger-text)' }}
          >
            {stopRequested ? <MapSpinner size={12} /> : <Square size={11} fill="currentColor" />}
            {stopRequested ? '正在停止' : '停止'}
          </button>
        )}
      </div>
    </AssistantBubble>
  );
}

export interface PlusMenuItem {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  onPick: () => void;
  /** 有值时置灰，并把原因写在描述位置——不许让用户点了没反应自己猜。 */
  disabledReason?: string;
}

export interface ComposerChip {
  key: string;
  label: string;
  /** 状态一句话：上传进度 / 可以用 / 失败原因。 */
  status?: string;
  tone?: 'default' | 'busy' | 'danger';
  onRemove?: () => void;
}

/**
 * 底部唯一的输入框。「+」加资料（知识库、上传、粘贴纪要、截图），这是叠加动作不是二选一；
 * 下面一行是本次生成的选项（风格、快慢）；最底下一个主按钮写清按下去得到什么。
 */
export function WorkbenchComposer({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  plusItems,
  chips,
  options,
  sendLabel,
  sendDisabled,
  sendDisabledReason,
  onSend,
  hint,
  onPaste,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
  plusItems: PlusMenuItem[];
  chips: ComposerChip[];
  options?: ReactNode;
  sendLabel: string;
  sendDisabled?: boolean;
  sendDisabledReason?: string;
  onSend: () => void;
  hint: string;
  onPaste?: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
}) {
  const [plusOpen, setPlusOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!plusOpen) return;
    const close = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setPlusOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setPlusOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [plusOpen]);

  return (
    <div className="flex flex-col gap-2">
      {chips.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="已放入的资料">
          {chips.map((chip) => (
            <li
              key={chip.key}
              className="flex max-w-full items-center gap-1.5 rounded-lg py-1 pl-2 pr-1 text-[12px]"
              style={{
                background: chip.tone === 'danger' ? 'var(--semantic-danger-soft)' : 'var(--bg-tertiary)',
                color: chip.tone === 'danger' ? 'var(--semantic-danger-text)' : 'var(--text-primary)',
              }}
            >
              {chip.tone === 'busy' && <MapSpinner size={11} />}
              <span className="max-w-[200px] truncate" title={chip.label}>{chip.label}</span>
              {chip.status && <span className="shrink-0 text-[11px] text-token-muted">{chip.status}</span>}
              {chip.onRemove && (
                <button
                  type="button"
                  aria-label={`移除 ${chip.label}`}
                  onClick={chip.onRemove}
                  disabled={disabled}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-token-muted hover-bg-soft disabled:opacity-40"
                >
                  <X size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div
        className="flex items-end gap-2 rounded-xl p-1.5"
        style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)' }}
      >
        <div ref={menuRef} className="relative shrink-0">
          <button
            type="button"
            aria-label="添加资料"
            aria-haspopup="menu"
            aria-expanded={plusOpen}
            disabled={disabled}
            onClick={() => setPlusOpen((current) => !current)}
            className="flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover-bg-soft disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2"
            style={{ border: '1px solid var(--border-default)', color: 'var(--text-primary)', background: plusOpen ? 'var(--bg-elevated)' : undefined }}
          >
            <Plus size={17} />
          </button>
          {plusOpen && (
            <div
              role="menu"
              aria-label="添加资料"
              className="absolute bottom-11 left-0 z-20 flex w-[288px] flex-col gap-0.5 rounded-xl p-1.5 shadow-lg"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
            >
              {plusItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    disabled={Boolean(item.disabledReason)}
                    onClick={() => { setPlusOpen(false); item.onPick(); }}
                    className="flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover-bg-soft disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}>
                      <Icon size={15} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium text-token-primary">{item.title}</span>
                      <span className="block text-[11px] leading-snug text-token-muted">{item.disabledReason || item.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <label htmlFor={id} className="sr-only">要求</label>
        <textarea
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !sendDisabled) {
              event.preventDefault();
              onSend();
            }
          }}
          disabled={disabled}
          rows={2}
          maxLength={4000}
          placeholder={placeholder}
          className="min-h-9 w-full flex-1 resize-none bg-transparent px-1 py-1.5 text-base leading-relaxed text-token-primary outline-none placeholder:text-token-muted disabled:opacity-60 sm:text-[13px]"
        />
      </div>
      {options && <div className="flex flex-wrap items-center gap-1.5">{options}</div>}
      <button
        type="button"
        onClick={onSend}
        disabled={sendDisabled}
        title={sendDisabled ? sendDisabledReason : undefined}
        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-[14px] font-bold transition-opacity disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2"
        style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-primary)' }}
      >
        <Send size={15} />
        {sendLabel}
      </button>
      <p className="text-[11px] leading-relaxed text-token-muted">{sendDisabled && sendDisabledReason ? sendDisabledReason : hint}</p>
    </div>
  );
}

/** 输入框下方的选项块：点开显示当前值，与「+」一样只在需要时出现。 */
export function OptionChip({ label, value, onClick, pressed, disabled, children }: {
  label: string;
  value?: ReactNode;
  onClick?: () => void;
  pressed?: boolean;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] transition-colors hover-bg-soft disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2"
      style={{
        border: '1px solid var(--border-default)',
        color: 'var(--text-primary)',
        background: pressed ? 'var(--bg-elevated)' : undefined,
      }}
    >
      {children}
      {value}
    </button>
  );
}

/** 两三个互斥选项的分段按钮（快速 / 精细、线上版 / 草稿）。 */
export function Segmented<T extends string>({ label, value, options, onChange, disabled }: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; title?: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg p-0.5" style={{ background: 'var(--bg-tertiary)' }}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          title={option.title}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className="inline-flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2"
          style={value === option.value
            ? { background: 'var(--bg-elevated)', color: 'var(--text-primary)' }
            : { color: 'var(--text-secondary)' }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 右边的预览栏：顶上一行说清「这是哪一版、谁能看到」，右上角是这一屏的主动作；
 * 底部一句话告诉用户接下来会怎样（预判下一步）。
 */
export function WorkbenchPreview({ title, note, actions, children, nextHint, toolbar }: {
  title: string;
  note: string;
  actions?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  nextHint: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold text-token-primary">{title}</div>
          <div className="truncate text-[12px] text-token-muted">{note}</div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {toolbar}
          {actions}
        </div>
      </div>
      <div className="relative min-h-[320px] flex-1 overflow-hidden rounded-[14px]" style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg-card)' }}>
        {children}
      </div>
      <p className="text-[12px] leading-relaxed text-token-secondary">{nextHint}</p>
    </div>
  );
}

/** 首稿到达之前的占位：画一页网页的骨架在呼吸，而不是一个居中转圈。 */
export function PageSkeleton({ caption, swatches }: { caption: string; swatches?: string[] }) {
  const bar = (width: string, height = 8) => (
    <div className="animate-pulse rounded motion-reduce:animate-none" style={{ width, height, background: 'var(--skeleton-base)' }} />
  );
  return (
    <div className="surface-reading flex h-full flex-col gap-3 p-6" aria-hidden="true">
      <div className="flex items-center justify-between gap-2 text-[12px] text-token-muted">
        <span>{caption}</span>
        {swatches && swatches.length > 0 && (
          <span className="flex gap-1">
            {swatches.map((color) => <span key={color} className="h-3 w-3 rounded-full" style={{ background: color, border: '1px solid var(--border-subtle)' }} />)}
          </span>
        )}
      </div>
      {bar('36%', 10)}
      {bar('82%', 26)}
      {bar('90%')}
      {bar('68%')}
      <div className="mt-2 grid grid-cols-3 gap-3">
        {[0, 1, 2].map((key) => (
          <div key={key} className="h-20 animate-pulse rounded-lg motion-reduce:animate-none" style={{ background: 'var(--skeleton-base)' }} />
        ))}
      </div>
      <div className="h-28 animate-pulse rounded-lg motion-reduce:animate-none" style={{ background: 'var(--skeleton-base)' }} />
    </div>
  );
}

/** 一块从对话区底部弹起的面板（选知识、贴纪要），不另开弹窗。 */
export function ComposerSheet({ title, onClose, children, footer }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-label={title}
      className="absolute inset-0 z-30 flex flex-col rounded-[14px]"
      // 必须不透明：bg-card 是半透明的，下面的对话会透上来（2026-09-24 验收撞见）。
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
      onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <span className="text-[14px] font-semibold text-token-primary">{title}</span>
        <button type="button" aria-label="关闭" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-token-muted hover-bg-soft">
          <X size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      {footer && <div className="shrink-0 px-4 py-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>{footer}</div>}
    </div>
  );
}

/**
 * 预览区里的一块不透明操作面板（选知识库等）：借右边的大区域操作，左边的对话与输入框保持原样。
 * 知识浏览器是「库列表 + 条目列表」两栏，挤进 420px 的对话栏里标题全被截断。
 */
export function PreviewPanel({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" style={{ background: 'var(--bg-elevated)', minHeight: 0 }}>
      {children}
    </div>
  );
}
