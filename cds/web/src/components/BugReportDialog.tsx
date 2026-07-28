/**
 * 全局快捷提 bug（Ctrl+B / Command+B）。
 *
 * 挂载在 App 根，跨路由常驻，提供三个入口：
 *   1. 快捷键 Ctrl+B（Mac 上 Command+B），输入框聚焦时不抢占（见 BugReportCore）；
 *   2. 右下角常驻按钮（带文字标签 + 快捷键提示，不靠用户猜快捷键）；
 *   3. window 事件 OPEN_BUG_REPORT_EVENT，其它组件可携预填打开。
 *
 * 模态三硬约束：createPortal 到 document.body、尺寸走 inline style、
 * 滚动区 minHeight:0 + overflowY:auto + overscrollBehavior:contain。
 * z-index：遮罩 300（portal 顶层）——本弹窗由 App 根 portal 出来，必须盖住
 * 全局悬浮 chrome（站内通知 220 / CommitInbox 190 / 更新徽章 200），
 * 与 ui/dropdown-menu 同属顶层带；常驻入口按钮取 120（全局 chrome 带下沿，
 * 不遮挡其它 chrome）。见 .claude/rules/cds-theme-tokens.md §4。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { Bug, ImagePlus, Loader2, Paperclip, X } from 'lucide-react';

import { apiRequest } from '@/lib/api';
import {
  BUG_SEVERITY_OPTIONS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  buildBugReportPayload,
  collectBugReportEnvironment,
  describeSubmitResult,
  shortcutHint,
  shouldTriggerBugReportShortcut,
  validateBugReportDraft,
  type BugReportAttachment,
  type BugReportSubmitResult,
  type BugSeverity,
} from '@/components/BugReportCore';
import { useOverlayDock } from '@/lib/useOverlayDock';

/** 其它组件可派发该事件打开面板（可携带预填描述）。 */
export const OPEN_BUG_REPORT_EVENT = 'cds:open-bug-report';

/** 未登录 / 过渡类页面不显示常驻入口（提交需要 CDS 登录态）。 */
const HIDDEN_ENTRY_PATHS = new Set(['/login', '/auth/sso', '/preview-preparing']);

interface PendingAttachment extends BugReportAttachment {
  previewUrl?: string;
}

/** 读文件为 base64（去掉 data: 前缀）。 */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.split(',')[1] || '');
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

export function BugReportDialog(): JSX.Element | null {
  // 坞解析走共享 hook（lib/useOverlayDock），不在这里内联一份 querySelector——
  // 两个坞、多个消费方各写一遍必然漂移。
  const actionStackEl = useOverlayDock('.cds-global-action-stack');

  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<BugSeverity>('major');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [result, setResult] = useState<BugReportSubmitResult | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<PendingAttachment[]>([]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  const hint = shortcutHint(typeof navigator === 'undefined' ? undefined : navigator.userAgent);

  // 提交期间每秒推进一次计时，配合「最多等 10 秒会转本地留存」的说明，
  // 不让用户对着静止的转圈猜还要多久（禁止空白等待）。
  useEffect(() => {
    if (!submitting) {
      setElapsedSeconds(0);
      return;
    }
    const timer = window.setInterval(() => setElapsedSeconds((prev) => prev + 1), 1000);
    return () => window.clearInterval(timer);
  }, [submitting]);

  const resetForm = useCallback(() => {
    attachmentsRef.current.forEach((item) => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
    attachmentsRef.current = [];
    setAttachments([]);
    setDescription('');
    setSeverity('major');
    setErrorText(null);
    setResult(null);
  }, []);

  const closeDialog = useCallback(() => {
    setOpen(false);
    resetForm();
  }, [resetForm]);

  // 全局快捷键。用捕获阶段监听，保证在页面局部处理之前判定；
  // 判定本身走纯函数 shouldTriggerBugReportShortcut（有单测覆盖）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        closeDialog();
        return;
      }
      if (!shouldTriggerBugReportShortcut({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        repeat: event.repeat,
        target: event.target,
      })) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setOpen((prev) => !prev);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [closeDialog, open]);

  // 事件入口：其它组件派发 OPEN_BUG_REPORT_EVENT，可携 detail.description 预填。
  useEffect(() => {
    const onOpen = (event: Event): void => {
      const detail = (event as CustomEvent<{ description?: string }>).detail;
      if (detail?.description) setDescription(detail.description);
      setOpen(true);
    };
    window.addEventListener(OPEN_BUG_REPORT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_BUG_REPORT_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 60);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => () => {
    attachmentsRef.current.forEach((item) => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
  }, []);

  const addFiles = useCallback(async (files: File[]): Promise<void> => {
    const accepted: PendingAttachment[] = [];
    for (const file of files) {
      if (attachmentsRef.current.length + accepted.length >= MAX_ATTACHMENT_COUNT) {
        setErrorText(`最多上传 ${MAX_ATTACHMENT_COUNT} 个附件`);
        break;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setErrorText(`「${file.name}」超过 5 MB，已跳过`);
        continue;
      }
      try {
        const dataBase64 = await readAsBase64(file);
        accepted.push({
          name: file.name || 'screenshot.png',
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          dataBase64,
          previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
        });
      } catch {
        setErrorText(`「${file.name}」读取失败`);
      }
    }
    if (accepted.length > 0) setAttachments((prev) => [...prev, ...accepted]);
  }, []);

  const removeAttachment = useCallback((index: number): void => {
    setAttachments((prev) => {
      const target = prev[index];
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const handlePaste = useCallback((event: React.ClipboardEvent): void => {
    const files: File[] = [];
    for (const item of Array.from(event.clipboardData.items)) {
      if (!item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  }, [addFiles]);

  const handleDrop = useCallback((event: React.DragEvent): void => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) void addFiles(files);
  }, [addFiles]);

  const handleSubmit = useCallback(async (): Promise<void> => {
    const draft = {
      title: '',
      description,
      severity,
      attachments: attachments.map(({ name, mimeType, size, dataBase64 }) => ({ name, mimeType, size, dataBase64 })),
    };
    const invalid = validateBugReportDraft(draft);
    if (invalid) {
      setErrorText(invalid);
      return;
    }
    setErrorText(null);
    setSubmitting(true);
    try {
      const payload = buildBugReportPayload({
        source: 'cds',
        draft,
        environment: collectBugReportEnvironment(typeof window === 'undefined' ? undefined : window),
      });
      const response = await apiRequest<BugReportSubmitResult>('/api/bug-reports', {
        method: 'POST',
        body: payload,
      });
      setResult(response);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setErrorText(`提交失败：${message}`);
    } finally {
      setSubmitting(false);
    }
  }, [attachments, description, severity]);

  const launcher = HIDDEN_ENTRY_PATHS.has(location.pathname) ? null : (
    <button
      type="button"
      onClick={() => setOpen(true)}
      title={`提交缺陷（${hint}）`}
      aria-label={`提交缺陷，快捷键 ${hint}`}
      // 不再自己 fixed 定位：入口是 .cds-global-action-stack（AppShell 的右下角
      // 唯一系统提醒区）的一员，由那个坞统一竖向排布。此前自己贴 bottom-4 right-4
      // 与坞里的更新徽章几何重合、被压住半句（用户 2026-07-28 反馈的遮挡之一）。
      className="pointer-events-auto inline-flex w-max items-center gap-2 self-end rounded-full border border-border bg-card px-3 py-2 text-xs text-card-foreground shadow-lg transition-colors hover:bg-accent"
    >
      <Bug className="size-4" />
      <span>提交缺陷</span>
      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{hint}</span>
    </button>
  );

  const dialog = open ? (
    <div
      className="fixed inset-0 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
      style={{ zIndex: 300 }}
      onClick={closeDialog}
      role="presentation"
    >
      <div
        className="flex w-full max-w-[680px] flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-xl"
        style={{ maxHeight: '86vh' }}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="提交缺陷"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Bug className="size-5 text-primary" />
            提交缺陷
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{hint}</span>
          </div>
          <button
            type="button"
            onClick={closeDialog}
            aria-label="关闭"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-5" />
          </button>
        </div>

        <div
          className="flex flex-col gap-3 px-4 py-3"
          style={{ minHeight: 0, flex: 1, overflowY: 'auto', overscrollBehavior: 'contain' }}
          onDrop={handleDrop}
          onDragOver={(event) => event.preventDefault()}
        >
          {result ? (
            <div
              className={`rounded-md border px-3 py-3 text-sm ${
                result.delivery === 'forwarded'
                  ? 'border-border bg-muted text-foreground'
                  : 'border-border bg-muted text-muted-foreground'
              }`}
            >
              <div className="font-medium text-foreground">{describeSubmitResult(result)}</div>
              <div className="mt-1 text-xs text-muted-foreground">编号 {result.id}</div>
            </div>
          ) : null}

          <label className="text-xs text-muted-foreground" htmlFor="cds-bug-report-description">
            问题描述（第一行会作为标题；可直接 Ctrl+V 粘贴截图）
          </label>
          <textarea
            id="cds-bug-report-description"
            ref={textareaRef}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onPaste={handlePaste}
            placeholder={'描述你遇到的问题…\n\n第一行将作为标题\n支持粘贴截图或把文件拖进来\n页面地址、路由、主题、浏览器信息会自动带上，不用手写'}
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
            style={{ minHeight: 180 }}
          />

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">严重程度</span>
            {BUG_SEVERITY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setSeverity(option.value)}
                className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                  severity === option.value
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-muted-foreground hover:bg-accent'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          {attachments.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {attachments.map((item, index) => (
                <div
                  key={`${item.name}-${index}`}
                  className="relative flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground"
                >
                  {item.previewUrl ? (
                    <img src={item.previewUrl} alt={item.name} className="size-8 rounded object-cover" />
                  ) : (
                    <Paperclip className="size-4" />
                  )}
                  <span className="max-w-[140px] truncate">{item.name}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(index)}
                    aria-label={`移除附件 ${item.name}`}
                    className="rounded p-0.5 hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {submitting ? (
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              正在提交缺陷…已等待 {elapsedSeconds}s（超过 10 秒会转为本地留存并如实告知）
            </div>
          ) : null}

          {errorText ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {errorText}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.target.files || []);
              if (files.length > 0) void addFiles(files);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ImagePlus className="size-4" />
            添加截图
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={closeDialog}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {result ? '关闭' : '取消'}
          </button>
          <button
            type="button"
            onClick={() => (result ? resetForm() : void handleSubmit())}
            disabled={submitting || (!result && !description.trim())}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <Bug className="size-4" />}
            {submitting ? '提交中…' : result ? '再提交一条' : '提交缺陷'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  if (typeof document === 'undefined') return null;
  // 入口与弹窗挂到**不同**的宿主：
  //   - 入口 pill 进 .cds-global-action-stack（右下角唯一系统提醒区），由那个坞
  //     统一竖向排布，天然不会和更新徽章 / 导入审批 / 授权请求互相遮挡；
  //   - 弹窗仍按模态三硬约束 portal 到 body（坞有 overflow-y:auto，模态挂进去会被裁）。
  // 坞还没挂上时（登录页等不渲染 AppShell 的路由）入口就不显示——那些页面本来
  // 也不该有常驻入口。
  const dock = actionStackEl;
  return (
    <>
      {dock ? createPortal(launcher, dock) : null}
      {createPortal(dialog, document.body)}
    </>
  );
}
