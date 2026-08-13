/**
 * 站内确认弹窗，替代 window.confirm / window.prompt。
 *
 * 原生弹窗有四个实打实的毛病，外部验收在 2026-08-11 点了其中一条（自动化盖不住）：
 *   - 自动化和部分嵌入式浏览器根本看不到它，破坏性操作没法验收
 *   - 不受主题控制，浅色/深色下都是系统灰框，和控制台割裂
 *   - 移动端弹在屏幕正中、字号不可控，长文案会被截断
 *   - 文案只能是纯文本，「输入平台名才能删」这种要求没法把要输的内容高亮出来
 *
 * 用法（Promise 化，替换点几乎是一比一）：
 *   const ok = await confirm({ title: '清除密钥？', description: '...' });
 *   const typed = await promptText({ title: '删除上游', requireExact: p.name });
 * confirm 返回 boolean，promptText 返回 string | null（null = 取消，与 window.prompt 一致）。
 *
 * 模态三硬约束照 frontend-modal.md：createPortal 到 body、尺寸走 inline style、
 * 滚动区 minHeight:0 + overflowY:auto。ESC 与点蒙版都能关（等价于取消）。
 * z-index 1500，与 BugReportDialog 同层——两者不会同时出现。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui';

export type ConfirmOptions = {
  title: string;
  /** 讲清后果。换行用 \n，会按行渲染。 */
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 破坏性操作用 danger，确认键变红 */
  tone?: 'default' | 'danger';
};

export type PromptOptions = ConfirmOptions & {
  placeholder?: string;
  defaultValue?: string;
  /**
   * 要求逐字输入这个值才能确认（删除类操作用）。
   * 填了它，确认键在输入不一致时保持禁用——用户不必点了才知道自己打错。
   */
  requireExact?: string;
  /** 提示要输入什么，渲染在输入框上方 */
  inputLabel?: string;
};

type Pending =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void };

type DialogApi = {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  promptText: (options: PromptOptions) => Promise<string | null>;
};

const DialogContext = createContext<DialogApi | null>(null);

/** 没有 Provider 时退回原生弹窗，保证组件在测试或独立渲染下也不会炸。 */
const FALLBACK: DialogApi = {
  confirm: async (options) => window.confirm([options.title, options.description].filter(Boolean).join('\n')),
  promptText: async (options) => window.prompt([options.title, options.description].filter(Boolean).join('\n'), options.defaultValue ?? ''),
};

export function useDialogs(): DialogApi {
  return useContext(DialogContext) ?? FALLBACK;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const api = useRef<DialogApi>({
    confirm: (options) => new Promise<boolean>((resolve) => {
      setValue('');
      setPending({ kind: 'confirm', options, resolve });
    }),
    promptText: (options) => new Promise<string | null>((resolve) => {
      setValue(options.defaultValue ?? '');
      setPending({ kind: 'prompt', options, resolve });
    }),
  }).current;

  const close = useCallback((confirmed: boolean, text: string) => {
    setPending((current) => {
      if (!current) return null;
      if (current.kind === 'confirm') current.resolve(confirmed);
      else current.resolve(confirmed ? text : null);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!pending) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close(false, '');
    };
    window.addEventListener('keydown', onKey);
    // 弹出即聚焦输入框：要输东西的场景不该让用户再点一下
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(timer);
    };
  }, [pending, close]);

  const options = pending?.options;
  const promptOptions = pending?.kind === 'prompt' ? pending.options : null;
  const mismatched = !!promptOptions?.requireExact && value.trim() !== promptOptions.requireExact;
  const emptyRequired = pending?.kind === 'prompt' && !promptOptions?.requireExact && value.trim().length === 0;
  const blocked = mismatched || emptyRequired;

  const modal = pending && options ? (
    <div
      role="presentation"
      onMouseDown={(event) => { if (event.currentTarget === event.target) close(false, ''); }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1500,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={options.title}
        data-dialog="confirm"
        style={{
          width: 'min(440px, 100%)',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 'var(--radius-lg, 12px)',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          boxShadow: '0 18px 48px rgba(0,0,0,0.35)',
        }}
      >
        <div style={{ padding: '16px 18px 0', flexShrink: 0 }}>
          <p style={{ margin: 0, fontSize: 'var(--fs-heading)', fontWeight: 600, color: 'var(--text-primary)' }}>
            {options.title}
          </p>
        </div>

        <div style={{ padding: '10px 18px 0', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {options.description
            ? options.description.split('\n').map((line, index) => (
              <p key={index} style={{ margin: '0 0 6px', fontSize: 'var(--fs-secondary)', lineHeight: 1.7, color: 'var(--text-secondary)' }}>
                {line}
              </p>
            ))
            : null}

          {promptOptions ? (
            <label style={{ display: 'block', marginTop: 8 }}>
              {promptOptions.inputLabel ? (
                <span style={{ display: 'block', marginBottom: 4, fontSize: 'var(--fs-micro)', color: 'var(--text-muted)' }}>
                  {promptOptions.inputLabel}
                </span>
              ) : null}
              <input
                ref={inputRef}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter' && !blocked) close(true, value); }}
                placeholder={promptOptions.placeholder}
                aria-label={promptOptions.inputLabel ?? options.title}
                style={{
                  width: '100%',
                  height: 34,
                  borderRadius: 'var(--radius-sm, 6px)',
                  border: `1px solid ${mismatched && value.length > 0 ? 'var(--err)' : 'var(--border-subtle)'}`,
                  background: 'var(--bg-input)',
                  color: 'var(--text-primary)',
                  padding: '0 10px',
                  fontSize: 'var(--fs-body)',
                }}
              />
              {promptOptions.requireExact ? (
                <span style={{ display: 'block', marginTop: 4, fontSize: 'var(--fs-micro)', color: mismatched && value.length > 0 ? 'var(--err)' : 'var(--text-muted)' }}>
                  需与「{promptOptions.requireExact}」完全一致
                </span>
              ) : null}
            </label>
          ) : null}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '14px 18px 16px', flexShrink: 0 }}>
          <Button size="sm" variant="ghost" onClick={() => close(false, '')}>
            {options.cancelLabel ?? '取消'}
          </Button>
          <Button
            size="sm"
            variant={options.tone === 'danger' ? 'primary' : 'primary'}
            disabled={blocked}
            onClick={() => close(true, value)}
            style={options.tone === 'danger' ? { background: 'var(--err)', borderColor: 'var(--err)' } : undefined}
          >
            {options.confirmLabel ?? '确认'}
          </Button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <DialogContext.Provider value={api}>
      {children}
      {modal ? createPortal(modal, document.body) : null}
    </DialogContext.Provider>
  );
}
