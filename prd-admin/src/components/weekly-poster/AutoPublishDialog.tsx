import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Play, Send, Calendar, Repeat, X, Sparkles, Eye, ChevronDown } from 'lucide-react';
import {
  listWorkflows,
  executeWorkflow,
  createWorkflowSchedule,
  type Workflow,
  type WeeklyPosterPresentationMode,
  type WeeklyPosterTemplateKey,
} from '@/services';
import { POSTER_TEMPLATES_SEED } from '@/lib/posterTemplates';
import { toast } from '@/lib/toast';

type ScheduleMode = 'now' | 'once' | 'cron';

const PRESENTATION_OPTIONS: { value: WeeklyPosterPresentationMode; label: string; hint: string }[] = [
  { value: 'feed-card', label: 'feed-card 短视频卡', hint: '抖音/TikTok 风格的视频卡，9:16 / 16:9 自适应' },
  { value: 'ad-4-3', label: 'ad-4-3 横屏海报', hint: '4:3 横版广告位，标题 + 主图 + CTA' },
  { value: 'ad-rich-text', label: 'ad-rich-text 图文混排', hint: '左图右文，适合长文案' },
  { value: 'static', label: 'static 静态图片', hint: '不带交互，纯展示' },
];

const POSTER_TIPS = [
  '【博主id】= 抖音/TikTok 主页 URL 里 `secUid=` 后面那串',
  '【视频个数】= 拉取最近 N 条视频，建议 3 ~ 10',
  '工作流变量会覆盖工作流节点配置；留空则用工作流默认值',
];

export interface AutoPublishDialogProps {
  /** 弹窗 mounted 但未开 = false；开了 = true */
  open: boolean;
  onClose: () => void;
  /** 创建/触发成功后回调，用于上层刷新海报列表 */
  onPublished?: () => void;
}

/**
 * 海报编辑页"自动发布"入口：把工作流执行/调度收口到这里。
 * Tab：立即执行 / 定时一次 / 循环 (Cron)
 * 用户只需选工作流 + 填变量（博主id、视频个数等）+ 选模板/版式/品牌色，
 * 不必再去工作流编辑器里手动改配置 + 手动跑一次 + 等海报出现在首页。
 *
 * 遵守 .claude/rules/frontend-modal.md 三硬约束：createPortal、inline 高度、min-h-0 滚动
 */
export function AutoPublishDialog({ open, onClose, onPublished }: AutoPublishDialogProps) {
  const [mode, setMode] = useState<ScheduleMode>('now');
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loadingWorkflows, setLoadingWorkflows] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>('');
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [presentationMode, setPresentationMode] = useState<WeeklyPosterPresentationMode>('feed-card');
  const [templateKey, setTemplateKey] = useState<WeeklyPosterTemplateKey>('promo');
  const [accentColor, setAccentColor] = useState('#ff0050');
  const [scheduleName, setScheduleName] = useState('');
  // 默认 30 分钟后
  const defaultRunAt = useRef(new Date(Date.now() + 30 * 60 * 1000));
  const [runAtLocal, setRunAtLocal] = useState(() => formatDatetimeLocal(defaultRunAt.current));
  const [cronExpression, setCronExpression] = useState('0 9 * * *');
  const [submitting, setSubmitting] = useState(false);

  // 拉取工作流
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingWorkflows(true);
    listWorkflows({ pageSize: 50 })
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.data) {
          setWorkflows(res.data.items);
          if (res.data.items.length > 0 && !selectedWorkflowId) {
            setSelectedWorkflowId(res.data.items[0].id);
          }
        } else if (!res.success) {
          toast.error(res.error?.message || '加载工作流失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingWorkflows(false);
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, submitting, onClose]);

  // 切换工作流时根据其 variables 重置默认值
  const selectedWorkflow = useMemo(
    () => workflows.find((w) => w.id === selectedWorkflowId),
    [workflows, selectedWorkflowId],
  );
  useEffect(() => {
    if (!selectedWorkflow) return;
    const next: Record<string, string> = {};
    for (const v of selectedWorkflow.variables) {
      next[v.key] = v.defaultValue ?? '';
    }
    setVariables(next);
  }, [selectedWorkflow]);

  if (!open) return null;

  const handleSubmit = async () => {
    if (!selectedWorkflowId) {
      toast.error('请先选择一个工作流');
      return;
    }
    // 必填变量校验
    if (selectedWorkflow) {
      for (const v of selectedWorkflow.variables) {
        if (v.required && !variables[v.key]) {
          toast.error(`请填写「${v.label || v.key}」`);
          return;
        }
      }
    }

    // 把 presentationMode / templateKey / accentColor 注入变量，让 WeeklyPosterPublisher 兜底取
    const finalVars: Record<string, string> = {
      ...variables,
      presentationMode,
      templateKey,
      accentColor,
    };

    setSubmitting(true);
    try {
      if (mode === 'now') {
        const res = await executeWorkflow({ id: selectedWorkflowId, variables: finalVars });
        if (res.success) {
          toast.success('已入队执行，几秒后查看首页弹窗');
          onPublished?.();
          onClose();
        } else {
          toast.error(res.error?.message || '执行失败');
        }
      } else if (mode === 'once') {
        const runAtUtc = new Date(runAtLocal).toISOString();
        const res = await createWorkflowSchedule({
          workflowId: selectedWorkflowId,
          name: scheduleName.trim(),
          mode: 'once',
          runAtUtc,
          variables: finalVars,
        });
        if (res.success) {
          toast.success(`定时调度已创建，将在 ${formatDisplayTime(runAtLocal)} 触发`);
          onPublished?.();
          onClose();
        } else {
          toast.error(res.error?.message || '创建调度失败');
        }
      } else {
        const res = await createWorkflowSchedule({
          workflowId: selectedWorkflowId,
          name: scheduleName.trim(),
          mode: 'cron',
          cronExpression,
          variables: finalVars,
        });
        if (res.success) {
          toast.success('循环调度已创建并启用');
          onPublished?.();
          onClose();
        } else {
          toast.error(res.error?.message || '创建调度失败');
        }
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '未知错误');
    } finally {
      setSubmitting(false);
    }
  };

  const dialog = (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center"
      style={{
        background: 'rgba(3,3,6,0.78)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
      onClick={() => { if (!submitting) onClose(); }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative flex flex-col overflow-hidden"
        style={{
          width: 'min(720px, calc(100vw - 32px))',
          height: 'min(90vh, 820px)',
          maxHeight: '90vh',
          minHeight: 0,
          background: '#0f1014',
          borderRadius: 24,
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 40px 80px -20px rgba(0,0,0,0.6), 0 0 120px rgba(124,58,237,0.18)',
        }}
      >
        {/* Header */}
        <div className="shrink-0 px-6 py-5 flex items-center justify-between border-b" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
          <div>
            <div className="text-[16px] font-semibold text-white inline-flex items-center gap-2">
              <Sparkles size={16} className="text-pink-400" />
              新建自动发布
            </div>
            <div className="text-[12px] text-white/55 mt-1">把工作流执行/调度收口到海报编辑页 — 选工作流、填博主信息、选版式即可发布</div>
          </div>
          <button
            type="button"
            aria-label="关闭"
            disabled={submitting}
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-white/10 disabled:opacity-40"
            style={{ color: 'rgba(255,255,255,0.7)' }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Mode Tabs */}
        <div className="shrink-0 px-6 pt-4">
          <div className="grid grid-cols-3 gap-2 p-1 rounded-xl" style={{ background: 'rgba(255,255,255,0.04)' }}>
            <ModeTab active={mode === 'now'} onClick={() => setMode('now')} icon={<Play size={14} />} label="立即执行" />
            <ModeTab active={mode === 'once'} onClick={() => setMode('once')} icon={<Calendar size={14} />} label="定时一次" />
            <ModeTab active={mode === 'cron'} onClick={() => setMode('cron')} icon={<Repeat size={14} />} label="循环 (Cron)" />
          </div>
        </div>

        {/* Body — 滚动区域 */}
        <div
          className="flex-1 px-6 py-4 space-y-4"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {/* 工作流选择 */}
          <Field label="选择工作流" required>
            {loadingWorkflows ? (
              <div className="text-[12px] text-white/55 inline-flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> 加载中…</div>
            ) : workflows.length === 0 ? (
              <div className="text-[12px] text-white/55">还没有工作流，先去工作流编辑器创建一个</div>
            ) : (
              <SelectInput
                value={selectedWorkflowId}
                onChange={setSelectedWorkflowId}
                options={workflows.map((w) => ({ value: w.id, label: w.name || '未命名' }))}
              />
            )}
          </Field>

          {/* 调度参数 */}
          {mode === 'once' && (
            <Field label="执行时间" required>
              <input
                type="datetime-local"
                value={runAtLocal}
                onChange={(e) => setRunAtLocal(e.target.value)}
                className="w-full h-9 px-3 rounded-lg text-[13px] outline-none"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: 'rgba(255,255,255,0.92)',
                  colorScheme: 'dark',
                }}
              />
            </Field>
          )}
          {mode === 'cron' && (
            <Field label="Cron 表达式 (5 字段：分 时 日 月 周)" required>
              <input
                type="text"
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
                placeholder="0 9 * * *"
                className="w-full h-9 px-3 rounded-lg text-[13px] outline-none font-mono"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: 'rgba(255,255,255,0.92)',
                }}
              />
              <div className="text-[11px] text-white/45 mt-1">
                例：<code className="text-white/70">0 9 * * *</code> 每天 9 点；<code className="text-white/70">0 9 * * 1</code> 每周一 9 点
              </div>
            </Field>
          )}
          {(mode === 'once' || mode === 'cron') && (
            <Field label="调度别名 (可选)">
              <input
                type="text"
                value={scheduleName}
                onChange={(e) => setScheduleName(e.target.value)}
                placeholder="例：每天早 9 点抓博主视频"
                className="w-full h-9 px-3 rounded-lg text-[13px] outline-none"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: 'rgba(255,255,255,0.92)',
                }}
              />
            </Field>
          )}

          {/* 工作流变量 */}
          {selectedWorkflow && selectedWorkflow.variables.length > 0 && (
            <div className="space-y-2 pt-2">
              <div className="text-[12px] font-semibold text-white/75">工作流变量</div>
              {selectedWorkflow.variables.map((v) => (
                <Field
                  key={v.key}
                  label={`${v.label || v.key}${v.required ? ' *' : ''}`}
                  hint={v.key}
                >
                  <input
                    type={v.isSecret ? 'password' : 'text'}
                    value={variables[v.key] ?? ''}
                    onChange={(e) => setVariables((p) => ({ ...p, [v.key]: e.target.value }))}
                    placeholder={v.defaultValue ?? ''}
                    className="w-full h-9 px-3 rounded-lg text-[13px] outline-none"
                    style={{
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      color: 'rgba(255,255,255,0.92)',
                    }}
                  />
                </Field>
              ))}
            </div>
          )}
          {selectedWorkflow && selectedWorkflow.variables.length === 0 && (
            <div className="text-[11px] text-white/45 px-3 py-2 rounded-md" style={{ background: 'rgba(255,255,255,0.04)' }}>
              该工作流未声明变量。如需传入博主id/视频个数，请去工作流编辑器为这些字段加变量绑定。
            </div>
          )}

          {/* 海报版式 */}
          <div className="space-y-2 pt-2">
            <div className="text-[12px] font-semibold text-white/75">海报版式（运行时覆盖工作流配置）</div>
            <Field label="presentationMode 版式">
              <SelectInput
                value={presentationMode}
                onChange={(v) => setPresentationMode(v as WeeklyPosterPresentationMode)}
                options={PRESENTATION_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              />
              <div className="text-[11px] text-white/45 mt-1">
                {PRESENTATION_OPTIONS.find((o) => o.value === presentationMode)?.hint}
              </div>
            </Field>
            <Field label="templateKey 模板">
              <SelectInput
                value={templateKey}
                onChange={(v) => setTemplateKey(v as WeeklyPosterTemplateKey)}
                options={POSTER_TEMPLATES_SEED.map((t) => ({ value: t.key, label: `${t.label} · ${t.description}` }))}
              />
            </Field>
            <Field label="品牌色 (accentColor)">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={accentColor}
                  onChange={(e) => setAccentColor(e.target.value)}
                  className="w-10 h-9 rounded-lg cursor-pointer"
                  style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.12)' }}
                />
                <input
                  type="text"
                  value={accentColor}
                  onChange={(e) => setAccentColor(e.target.value)}
                  className="w-32 h-9 px-3 rounded-lg text-[13px] outline-none font-mono"
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    color: 'rgba(255,255,255,0.92)',
                  }}
                />
              </div>
            </Field>
          </div>

          {/* Tips */}
          <div className="pt-2">
            <div className="text-[11px] font-semibold text-white/55 mb-1">提示</div>
            <ul className="text-[11px] text-white/45 space-y-0.5 list-disc pl-4">
              {POSTER_TIPS.map((t) => <li key={t}>{t}</li>)}
            </ul>
          </div>
        </div>

        {/* Footer */}
        <div
          className="shrink-0 px-6 py-4 flex items-center justify-between border-t"
          style={{ borderColor: 'rgba(255,255,255,0.08)', background: 'rgba(0,0,0,0.2)' }}
        >
          <div className="text-[11px] text-white/40 inline-flex items-center gap-1">
            <Eye size={12} /> 预览效果与首页弹窗完全一致（同一 PosterCarousel 组件）
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="h-9 px-4 rounded-lg text-[13px] disabled:opacity-40"
              style={{
                background: 'rgba(255,255,255,0.06)',
                color: 'rgba(255,255,255,0.78)',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !selectedWorkflowId}
              className="h-9 px-5 rounded-lg text-[13px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-40"
              style={{
                background: 'linear-gradient(90deg, rgba(255,0,80,0.85), rgba(255,77,140,0.9))',
                color: '#fff',
                border: '1px solid rgba(255,77,140,0.4)',
              }}
            >
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {mode === 'now' ? '立即执行' : '创建调度'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}

function ModeTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-8 rounded-lg text-[12px] font-medium inline-flex items-center justify-center gap-1.5 transition-all"
      style={{
        background: active ? 'rgba(255,0,80,0.16)' : 'transparent',
        color: active ? '#ff4d8c' : 'rgba(255,255,255,0.7)',
        border: active ? '1px solid rgba(255,77,140,0.32)' : '1px solid transparent',
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-medium text-white/65 mb-1.5 inline-flex items-center gap-2">
        <span>{label}{required && <span className="text-pink-400 ml-0.5">*</span>}</span>
        {hint && <code className="text-[10px] text-white/35 font-mono">{hint}</code>}
      </div>
      {children}
    </div>
  );
}

function SelectInput({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-9 px-3 pr-8 rounded-lg text-[13px] outline-none appearance-none"
        style={{
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.12)',
          color: 'rgba(255,255,255,0.92)',
          colorScheme: 'dark',
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} style={{ background: '#1a1b22', color: '#fff' }}>{o.label}</option>
        ))}
      </select>
      <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-white/40" />
    </div>
  );
}

/** Date → "YYYY-MM-DDTHH:mm" 本地时间 */
function formatDatetimeLocal(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDisplayTime(local: string): string {
  // 本地时间字符串 → 友好展示
  const d = new Date(local);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
