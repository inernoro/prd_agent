import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  AlertCircle,
  Bug,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Send,
  Wand2,
} from 'lucide-react';
import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { PageHeader } from '@/components/design/PageHeader';
import { toast } from '@/lib/toast';
import { streamTapdBugPreviewReal, submitTapdBugReal } from '@/services/real/tapdBugAgent';
import type { TapdBugDraft, TapdBugSubmitResult } from '@/services/contracts/tapdBugAgent';

const DEFAULT_DRAFT: TapdBugDraft = {
  title: '',
  module: '附近门店组件精准筛选',
  severity: 'serious',
  priority: 'high',
  bugType: '逻辑错误',
  currentOwner: '黄卫杰;',
  versionReport: '附近门店组件精准筛选',
  preconditions: [],
  steps: [],
  actualResult: [],
  expectedResult: [],
  missingFields: ['标题', '前置条件', '复现步骤', '实际结果', '预期结果'],
};

const SEVERITY_LABEL: Record<TapdBugDraft['severity'], string> = {
  fatal: '致命',
  serious: '主要',
  normal: '普通',
  minor: '提示',
};

const PRIORITY_LABEL: Record<TapdBugDraft['priority'], string> = {
  urgent: 'P0 紧急',
  high: 'P1 高',
  medium: 'P2 中',
  low: 'P3 低',
};

const inputStyle: CSSProperties = {
  background: 'var(--bg-sunken)',
  border: '1px solid var(--border-default)',
  color: 'var(--text-primary)',
};

function linesToText(lines: string[]) {
  return lines.join('\n');
}

function textToLines(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function computeMissing(draft: TapdBugDraft) {
  const missing: string[] = [];
  if (!draft.title.trim()) missing.push('标题');
  if (draft.preconditions.length === 0) missing.push('前置条件');
  if (draft.steps.length === 0) missing.push('复现步骤');
  if (draft.actualResult.length === 0) missing.push('实际结果');
  if (draft.expectedResult.length === 0) missing.push('预期结果');
  return missing;
}

function normalizeDraft(draft: TapdBugDraft): TapdBugDraft {
  const next = {
    ...draft,
    title: draft.title.trim(),
    module: draft.module.trim() || DEFAULT_DRAFT.module,
    currentOwner: draft.currentOwner.trim() || DEFAULT_DRAFT.currentOwner,
    versionReport: draft.versionReport.trim() || DEFAULT_DRAFT.versionReport,
  };
  return { ...next, missingFields: computeMissing(next) };
}

function FieldLabel({ children, required }: { children: ReactNode; required?: boolean }) {
  return (
    <label className="text-[12px] font-semibold flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}>
      {children}
      {required && <span style={{ color: '#ef4444' }}>必填</span>}
    </label>
  );
}

function TextLinesEditor({
  label,
  value,
  onChange,
  placeholder,
  required,
}: {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
  placeholder: string;
  required?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <FieldLabel required={required}>{label}</FieldLabel>
      <textarea
        value={linesToText(value)}
        onChange={(e) => onChange(textToLines(e.target.value))}
        placeholder={placeholder}
        className="min-h-[88px] rounded-xl px-3 py-2 text-sm outline-none resize-y"
        style={inputStyle}
      />
      <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
        一行写一步，提交到 TAPD 时会自动转成编号列表。
      </p>
    </div>
  );
}

export function TapdBugReportPage() {
  const [tapdCookie, setTapdCookie] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [naturalText, setNaturalText] = useState('');
  const [draft, setDraft] = useState<TapdBugDraft>(DEFAULT_DRAFT);
  const [stageMessage, setStageMessage] = useState('等待输入缺陷描述');
  const [thinkingText, setThinkingText] = useState('');
  const [typingText, setTypingText] = useState('');
  const [modelLabel, setModelLabel] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [submitResult, setSubmitResult] = useState<TapdBugSubmitResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const normalizedDraft = useMemo(() => normalizeDraft(draft), [draft]);
  const readyToSubmit =
    normalizedDraft.missingFields.length === 0 &&
    tapdCookie.trim().length > 0 &&
    workspaceId.trim().length > 0;

  const patchDraft = (patch: Partial<TapdBugDraft>) => {
    setDraft((prev) => normalizeDraft({ ...prev, ...patch }));
  };

  const handlePreview = async () => {
    if (!naturalText.trim() && normalizedDraft.missingFields.length > 0) {
      toast.error('请先输入缺陷现象', '至少写清楚发生了什么，系统才能整理草稿');
      return;
    }
    setPreviewLoading(true);
    setError(null);
    setSubmitResult(null);
    setTypingText('');
    setThinkingText('');
    setStageMessage('正在整理缺陷草稿');
    try {
      await streamTapdBugPreviewReal(
        { naturalText, overrides: normalizedDraft },
        {
          onStage: (_stage, message) => message && setStageMessage(message),
          onModel: (model, platform) => setModelLabel(model ? `${model}${platform ? ` · ${platform}` : ''}` : ''),
          onThinking: (text) => setThinkingText((prev) => (prev + text).slice(-1600)),
          onTyping: (text) => setTypingText((prev) => (prev + text).slice(-3000)),
          onDraft: (nextDraft) => setDraft(normalizeDraft(nextDraft)),
        }
      );
      toast.success('草稿已生成', '请核对后再提交到 TAPD');
    } catch (e) {
      const message = e instanceof Error ? e.message : '生成草稿失败';
      setError(message);
      toast.error('生成草稿失败', message);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleSubmit = async () => {
    const finalDraft = normalizeDraft(draft);
    if (finalDraft.missingFields.length > 0) {
      toast.error('缺陷信息不完整', `请补齐：${finalDraft.missingFields.join('、')}`);
      return;
    }
    if (!tapdCookie || !workspaceId) {
      toast.error('TAPD 提交配置不完整', '请填写 Cookie 和工作空间 ID');
      return;
    }

    setSubmitLoading(true);
    setError(null);
    setSubmitResult(null);
    try {
      const res = await submitTapdBugReal({
        cookie: tapdCookie,
        workspaceId,
        confirmed: true,
        draft: finalDraft,
      });
      if (!res.success || !res.data?.result) {
        const message = res.error?.message || 'TAPD 提交失败';
        setError(message);
        toast.error('提交失败', message);
        return;
      }
      setSubmitResult(res.data.result);
      toast.success('TAPD 缺陷已提交', res.data.result.bugId ? `缺陷 ID：${res.data.result.bugId}` : '已收到 TAPD 返回');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'TAPD 提交异常';
      setError(message);
      toast.error('提交异常', message);
    } finally {
      setSubmitLoading(false);
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-5 p-6 overflow-y-auto">
      <PageHeader
        title="TAPD 缺陷自动提报"
        description={
          <span className="inline-flex items-center gap-2">
            <Bug size={14} />
            口语描述转标准四要素，确认后创建 TAPD 缺陷
          </span>
        }
      />

      <div className="grid grid-cols-1 xl:grid-cols-[420px_1fr] gap-5 items-start">
        <div className="flex flex-col gap-4">
          <GlassCard className="p-5">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  1. 输入缺陷现象
                </h2>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  像给同事讲问题一样写，系统会整理成 TAPD 的标准格式。
                </p>
              </div>
              <Badge variant="warning">需确认</Badge>
            </div>
            <textarea
              value={naturalText}
              onChange={(e) => setNaturalText(e.target.value)}
              placeholder="例如：H5 附近门店页右上角地区筛选选择阿坝后，列表还是显示全国门店，感觉筛选没生效。正确应该只显示阿坝门店。"
              className="w-full min-h-[180px] rounded-xl px-3 py-2 text-sm outline-none resize-y"
              style={inputStyle}
            />
            <Button className="mt-4 w-full" variant="primary" onClick={handlePreview} disabled={previewLoading}>
              {previewLoading ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
              {previewLoading ? '整理中' : '生成缺陷草稿'}
            </Button>
          </GlassCard>

          <GlassCard className="p-5">
            <div className="flex items-center gap-2 mb-4">
              <Bug size={16} style={{ color: 'var(--accent-gold-2)' }} />
              <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                2. TAPD 提交配置
              </h2>
            </div>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <FieldLabel required>TAPD Cookie</FieldLabel>
                <textarea
                  value={tapdCookie}
                  onChange={(e) => setTapdCookie(e.target.value)}
                  placeholder="从浏览器 Network 请求头复制完整 Cookie，例如：tapdsession=...; dsc-token=...; ..."
                  className="min-h-[110px] rounded-xl px-3 py-2 text-sm outline-none resize-y font-mono"
                  style={inputStyle}
                />
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Cookie 只随本次提交请求发送到后端，不保存到外部授权中心。
                </p>
              </div>
              <div className="grid grid-cols-1 gap-3">
                <div className="flex flex-col gap-2">
                  <FieldLabel required>工作空间 ID</FieldLabel>
                  <input
                    value={workspaceId}
                    onChange={(e) => setWorkspaceId(e.target.value)}
                    placeholder="例如：68401106"
                    className="h-10 rounded-xl px-3 text-sm outline-none"
                    style={inputStyle}
                  />
                </div>
              </div>
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                只需要 Cookie 和工作空间 ID。其他 TAPD 表单令牌由后端兼容处理。
              </p>
            </div>
          </GlassCard>
        </div>

        <div className="flex flex-col gap-4">
          <GlassCard className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  3. 缺陷摘要确认
                </h2>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  这就像快递面单，提交前请核对每一项。
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={normalizedDraft.missingFields.length ? 'warning' : 'success'}>
                  {normalizedDraft.missingFields.length ? '待补充' : '可提交'}
                </Badge>
                <Badge variant="subtle">{SEVERITY_LABEL[normalizedDraft.severity]}</Badge>
                <Badge variant="subtle">{PRIORITY_LABEL[normalizedDraft.priority]}</Badge>
              </div>
            </div>

            {modelLabel && (
              <div className="mb-3 text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
                模型：{modelLabel}
              </div>
            )}
            <div className="mb-3 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              当前阶段：{stageMessage}
            </div>

            {normalizedDraft.missingFields.length > 0 && (
              <div className="mb-4 rounded-xl p-3 border flex items-start gap-2" style={{ borderColor: 'rgba(245,158,11,0.35)', background: 'rgba(245,158,11,0.08)' }}>
                <AlertCircle size={16} style={{ color: '#f59e0b' }} />
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  还缺：{normalizedDraft.missingFields.join('、')}。请在下方补齐后再提交。
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="flex flex-col gap-2 lg:col-span-2">
                <FieldLabel required>标题</FieldLabel>
                <input
                  value={draft.title}
                  onChange={(e) => patchDraft({ title: e.target.value })}
                  className="h-10 rounded-xl px-3 text-sm outline-none"
                  style={inputStyle}
                  placeholder="场景 + 问题现象，不超过 30 字"
                />
              </div>
              <div className="flex flex-col gap-2">
                <FieldLabel>所属模块</FieldLabel>
                <input
                  value={draft.module}
                  onChange={(e) => patchDraft({ module: e.target.value })}
                  className="h-10 rounded-xl px-3 text-sm outline-none"
                  style={inputStyle}
                />
              </div>
              <div className="flex flex-col gap-2">
                <FieldLabel>所属版本</FieldLabel>
                <input
                  value={draft.versionReport}
                  onChange={(e) => patchDraft({ versionReport: e.target.value })}
                  className="h-10 rounded-xl px-3 text-sm outline-none"
                  style={inputStyle}
                />
              </div>
              <div className="flex flex-col gap-2">
                <FieldLabel>严重程度</FieldLabel>
                <select
                  value={draft.severity}
                  onChange={(e) => patchDraft({ severity: e.target.value as TapdBugDraft['severity'] })}
                  className="h-10 rounded-xl px-3 text-sm outline-none"
                  style={inputStyle}
                >
                  <option value="fatal">致命</option>
                  <option value="serious">主要</option>
                  <option value="normal">普通</option>
                  <option value="minor">提示</option>
                </select>
              </div>
              <div className="flex flex-col gap-2">
                <FieldLabel>优先级</FieldLabel>
                <select
                  value={draft.priority}
                  onChange={(e) => patchDraft({ priority: e.target.value as TapdBugDraft['priority'] })}
                  className="h-10 rounded-xl px-3 text-sm outline-none"
                  style={inputStyle}
                >
                  <option value="urgent">P0 紧急</option>
                  <option value="high">P1 高</option>
                  <option value="medium">P2 中</option>
                  <option value="low">P3 低</option>
                </select>
              </div>
              <div className="flex flex-col gap-2">
                <FieldLabel>缺陷类型</FieldLabel>
                <select
                  value={draft.bugType}
                  onChange={(e) => patchDraft({ bugType: e.target.value as TapdBugDraft['bugType'] })}
                  className="h-10 rounded-xl px-3 text-sm outline-none"
                  style={inputStyle}
                >
                  <option value="逻辑错误">逻辑错误</option>
                  <option value="界面展示">界面展示</option>
                  <option value="兼容性">兼容性</option>
                  <option value="性能">性能</option>
                  <option value="需求不符">需求不符</option>
                </select>
              </div>
              <div className="flex flex-col gap-2">
                <FieldLabel>处理人</FieldLabel>
                <input
                  value={draft.currentOwner}
                  onChange={(e) => patchDraft({ currentOwner: e.target.value })}
                  className="h-10 rounded-xl px-3 text-sm outline-none"
                  style={inputStyle}
                />
              </div>
              <TextLinesEditor
                label="前置条件"
                value={draft.preconditions}
                onChange={(value) => patchDraft({ preconditions: value })}
                placeholder="例如：品牌已开通防窜物流"
                required
              />
              <TextLinesEditor
                label="复现步骤"
                value={draft.steps}
                onChange={(value) => patchDraft({ steps: value })}
                placeholder="例如：进入 H5 附近门店页面"
                required
              />
              <TextLinesEditor
                label="实际结果"
                value={draft.actualResult}
                onChange={(value) => patchDraft({ actualResult: value })}
                placeholder="例如：选择地区后列表无变化"
                required
              />
              <TextLinesEditor
                label="预期结果"
                value={draft.expectedResult}
                onChange={(value) => patchDraft({ expectedResult: value })}
                placeholder="例如：仅展示所选地区门店"
                required
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 mt-5 pt-4 border-t" style={{ borderColor: 'var(--border-default)' }}>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                点击提交即表示已确认摘要无误，后端只会创建新缺陷，不会修改或删除已有缺陷。
              </p>
              <Button variant="primary" onClick={handleSubmit} disabled={!readyToSubmit || submitLoading}>
                {submitLoading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                {submitLoading ? '提交中' : '确认提交到 TAPD'}
              </Button>
            </div>
          </GlassCard>

          {(thinkingText || typingText) && (
            <GlassCard className="p-5">
              <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
                模型整理过程
              </h3>
              {thinkingText && (
                <div className="mb-3">
                  <div className="text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>思考过程</div>
                  <pre className="whitespace-pre-wrap text-xs rounded-xl p-3 max-h-[160px] overflow-auto" style={inputStyle}>
                    {thinkingText}
                  </pre>
                </div>
              )}
              {typingText && (
                <div>
                  <div className="text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>原始输出</div>
                  <pre className="whitespace-pre-wrap text-xs rounded-xl p-3 max-h-[180px] overflow-auto" style={inputStyle}>
                    {typingText}
                  </pre>
                </div>
              )}
            </GlassCard>
          )}

          {error && (
            <GlassCard className="p-5" style={{ borderColor: 'rgba(239,68,68,0.45)' }}>
              <div className="flex items-start gap-2">
                <AlertCircle size={18} style={{ color: '#ef4444' }} />
                <div>
                  <div className="text-sm font-semibold" style={{ color: '#ef4444' }}>操作失败</div>
                  <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{error}</div>
                </div>
              </div>
            </GlassCard>
          )}

          {submitResult && (
            <GlassCard className="p-5" style={{ borderColor: 'rgba(34,197,94,0.45)' }}>
              <div className="flex items-start gap-3">
                <CheckCircle2 size={20} style={{ color: '#22c55e' }} />
                <div className="flex-1">
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    缺陷提交成功
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3 text-sm">
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>缺陷 ID：</span>
                      <span style={{ color: 'var(--text-primary)' }}>{submitResult.bugId || 'TAPD 未返回'}</span>
                    </div>
                    <div className="sm:col-span-2">
                      <span style={{ color: 'var(--text-muted)' }}>标题：</span>
                      <span style={{ color: 'var(--text-primary)' }}>{submitResult.title}</span>
                    </div>
                  </div>
                  {submitResult.bugUrl && (
                    <Button className="mt-4" onClick={() => window.open(submitResult.bugUrl!, '_blank', 'noopener')}>
                      <ExternalLink size={14} />
                      打开 TAPD 缺陷
                    </Button>
                  )}
                </div>
              </div>
            </GlassCard>
          )}
        </div>
      </div>
    </div>
  );
}
