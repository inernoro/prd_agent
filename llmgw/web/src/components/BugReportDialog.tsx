/**
 * 网关控制台的全局快捷提 bug（Ctrl+B / Command+B）。
 *
 * 三个入口：快捷键、右下角常驻按钮（带文字标签 + 快捷键提示）、
 * window 事件 OPEN_BUG_REPORT_EVENT（可携预填描述）。
 *
 * 模态三硬约束：createPortal 到 document.body、尺寸走 inline style、
 * 滚动区 minHeight:0 + overflowY:auto + overscrollBehavior:contain。
 * z-index：遮罩 1500（高于实体抽屉 1200 与 theme.css 现有最高层 1400），
 * 常驻入口 1100（低于抽屉，不遮挡业务浮层）。
 * 颜色全部走 theme.css 的 var() token，暗/浅双主题自动翻转。
 */
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { Bug, ImagePlus, Paperclip, X } from 'lucide-react';

import { API_BASE, getToken } from '@/lib/api';
import { Spinner } from '@/components/ui';
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

/** 其它组件可派发该事件打开面板（可携带预填描述）。 */
export const OPEN_BUG_REPORT_EVENT = 'llmgw:open-bug-report';

/** 未登录 / 过渡类页面不显示常驻入口（提交需要登录态）。 */
const HIDDEN_ENTRY_PATHS = new Set(['/login', '/auth/map', '/change-password']);

interface PendingAttachment extends BugReportAttachment {
  previewUrl?: string;
}

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

export function BugReportDialog() {
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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

  useEffect(() => {
    const onOpen = (event: Event) => {
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

  const addFiles = useCallback(async (files: File[]) => {
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

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => {
      const target = prev[index];
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const handlePaste = useCallback((event: ClipboardEvent) => {
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

  const handleDrop = useCallback((event: DragEvent) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) void addFiles(files);
  }, [addFiles]);

  const handleSubmit = useCallback(async () => {
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
        source: 'llmgw',
        draft,
        environment: collectBugReportEnvironment(typeof window === 'undefined' ? undefined : window),
      });
      const token = getToken();
      const res = await fetch(`${API_BASE}/bug-reports`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }
      const envelope = parsed as
        | { success?: boolean; data?: BugReportSubmitResult; error?: { message?: string } }
        | null;
      if (!res.ok || envelope?.success === false || !envelope?.data) {
        setErrorText(envelope?.error?.message || `提交失败（HTTP ${res.status}），请稍后重试`);
        return;
      }
      setResult(envelope.data);
    } catch (e) {
      setErrorText(`提交失败：${e instanceof Error ? e.message : String(e)}`);
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
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 1100,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        height: 36,
        padding: '0 12px',
        borderRadius: 999,
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-surface)',
        color: 'var(--text-secondary)',
        fontSize: 'var(--fs-caption)',
      }}
    >
      <Bug size={16} />
      <span>提交缺陷</span>
      <span
        style={{
          padding: '1px 6px',
          borderRadius: 4,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          color: 'var(--text-muted)',
          fontSize: 'var(--fs-micro)',
        }}
      >
        {hint}
      </span>
    </button>
  );

  const dialog = open ? (
    <div
      role="presentation"
      onClick={closeDialog}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1500,
        display: 'grid',
        placeItems: 'center',
        padding: 16,
        background: 'var(--drawer-backdrop)',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="提交缺陷"
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 'min(680px, 100%)',
          maxHeight: '86vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--border-subtle)',
          background: 'var(--bg-surface)',
          color: 'var(--text-primary)',
          boxShadow: 'var(--shadow-drawer)',
        }}
      >
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '12px 16px',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-body)', fontWeight: 600 }}>
            <Bug size={18} style={{ color: 'var(--accent)' }} />
            提交缺陷
            <span
              style={{
                padding: '1px 6px',
                borderRadius: 4,
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-muted)',
                fontSize: 'var(--fs-micro)',
                fontWeight: 500,
              }}
            >
              {hint}
            </span>
          </span>
          <button
            type="button"
            onClick={closeDialog}
            aria-label="关闭"
            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', padding: 4, display: 'inline-flex' }}
          >
            <X size={18} />
          </button>
        </div>

        <div
          onDrop={handleDrop}
          onDragOver={(event) => event.preventDefault()}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            padding: '14px 16px',
          }}
        >
          {result ? (
            <div
              role="status"
              style={{
                padding: '10px 12px',
                borderRadius: 'var(--radius-sm)',
                border: `1px solid ${result.delivery === 'forwarded' ? 'var(--ok)' : 'var(--border-subtle)'}`,
                background: result.delivery === 'forwarded' ? 'var(--ok-bg)' : 'var(--bg-elevated)',
                fontSize: 'var(--fs-secondary)',
              }}
            >
              <div style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{describeSubmitResult(result)}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-caption)', marginTop: 4 }}>编号 {result.id}</div>
            </div>
          ) : null}

          <label htmlFor="llmgw-bug-report-description" style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-caption)' }}>
            问题描述（第一行会作为标题；可直接 Ctrl+V 粘贴截图）
          </label>
          <textarea
            id="llmgw-bug-report-description"
            ref={textareaRef}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onPaste={handlePaste}
            placeholder={'描述你遇到的问题…\n\n第一行将作为标题\n支持粘贴截图或把文件拖进来\n页面地址、路由、主题、浏览器信息会自动带上，不用手写'}
            style={{
              minHeight: 180,
              resize: 'none',
              width: '100%',
              padding: '10px 12px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-subtle)',
              background: 'var(--bg-input)',
              color: 'var(--text-primary)',
              fontFamily: 'inherit',
              fontSize: 'var(--fs-secondary)',
              lineHeight: 1.6,
            }}
          />

          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-caption)' }}>严重程度</span>
            {BUG_SEVERITY_OPTIONS.map((option) => {
              const active = severity === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setSeverity(option.value)}
                  style={{
                    height: 28,
                    padding: '0 10px',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 'var(--fs-caption)',
                    border: `1px solid ${active ? 'transparent' : 'var(--border-subtle)'}`,
                    background: active ? 'var(--accent)' : 'var(--bg-input)',
                    color: active ? 'var(--accent-contrast)' : 'var(--text-secondary)',
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          {attachments.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {attachments.map((item, index) => (
                <div
                  key={`${item.name}-${index}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '4px 8px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-input)',
                    color: 'var(--text-muted)',
                    fontSize: 'var(--fs-caption)',
                  }}
                >
                  {item.previewUrl ? (
                    <img
                      src={item.previewUrl}
                      alt={item.name}
                      style={{ width: 32, height: 32, borderRadius: 4, objectFit: 'cover' }}
                    />
                  ) : (
                    <Paperclip size={14} />
                  )}
                  <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(index)}
                    aria-label={`移除附件 ${item.name}`}
                    style={{ background: 'transparent', border: 'none', color: 'inherit', display: 'inline-flex', padding: 0 }}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {submitting ? (
            <div
              role="status"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-subtle)',
                background: 'var(--bg-elevated)',
                color: 'var(--text-muted)',
                fontSize: 'var(--fs-caption)',
              }}
            >
              <Spinner size={14} />
              正在提交缺陷…已等待 {elapsedSeconds}s（超过 10 秒会转为本地留存并如实告知）
            </div>
          ) : null}

          {errorText ? (
            <div
              role="alert"
              style={{
                padding: '8px 12px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--err)',
                background: 'var(--err-bg)',
                color: 'var(--err)',
                fontSize: 'var(--fs-caption)',
              }}
            >
              {errorText}
            </div>
          ) : null}
        </div>

        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 16px',
            borderTop: '1px solid var(--border-subtle)',
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(event) => {
              const files = Array.from(event.target.files || []);
              if (files.length > 0) void addFiles(files);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            style={{
              height: 30,
              padding: '0 10px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-subtle)',
              background: 'var(--bg-input)',
              color: 'var(--text-secondary)',
              fontSize: 'var(--fs-caption)',
            }}
          >
            <ImagePlus size={14} />
            添加截图
          </button>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={closeDialog}
            style={{
              height: 30,
              padding: '0 12px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-subtle)',
              background: 'var(--bg-input)',
              color: 'var(--text-secondary)',
              fontSize: 'var(--fs-caption)',
            }}
          >
            {result ? '关闭' : '取消'}
          </button>
          <button
            type="button"
            onClick={() => (result ? resetForm() : void handleSubmit())}
            disabled={submitting || (!result && !description.trim())}
            style={{
              height: 30,
              padding: '0 12px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              borderRadius: 'var(--radius-sm)',
              border: '1px solid transparent',
              background: 'var(--accent)',
              color: 'var(--accent-contrast)',
              fontSize: 'var(--fs-caption)',
              opacity: submitting || (!result && !description.trim()) ? 0.5 : 1,
              cursor: submitting || (!result && !description.trim()) ? 'not-allowed' : 'pointer',
            }}
          >
            {submitting ? <Spinner size={14} /> : <Bug size={14} />}
            {submitting ? '提交中…' : result ? '再提交一条' : '提交缺陷'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  if (typeof document === 'undefined') return null;
  return createPortal(
    <>
      {launcher}
      {dialog}
    </>,
    document.body,
  );
}
