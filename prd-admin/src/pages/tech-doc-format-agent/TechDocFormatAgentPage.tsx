import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  FileText,
  RefreshCw,
  ShieldCheck,
  Upload,
  Wand2,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming/StreamingText';
import { toast } from '@/lib/toast';
import { streamDirectChat } from '@/services/real/aiToolbox';
import {
  buildPm2502Draft,
  buildTechDocGenerationPrompt,
  buildTechDocRepairPrompt,
  PM2502_TECH_DOC_TEMPLATE,
  validateTechDocFormat,
  type TechDocDraftInput,
  type TechDocIssue,
} from '@/lib/techDocFormat';

type ActiveTab = 'generate' | 'check' | 'template';
type RunPhase = 'idle' | 'streaming' | 'done' | 'error';

const DEFAULT_FORM: TechDocDraftInput = {
  projectName: '',
  appName: '',
  moduleName: '',
  featureName: '',
  requirementText: '',
  projectLinks: '',
  uiLink: '',
  showdocLink: '',
  testCaseLink: '',
};

function severityLabel(severity: TechDocIssue['severity']): string {
  if (severity === 'error') return '必须修复';
  if (severity === 'warning') return '建议修复';
  return '提示';
}

function stageText(seconds: number): string {
  if (seconds < 5) return '正在读取 PM2502 模板与用户输入';
  if (seconds < 20) return '正在按固定章节归档内容';
  if (seconds < 45) return '正在补齐接口、流程、影响范围与实施规划';
  return '内容较多，仍在生成并保持流式输出';
}

function downloadMarkdown(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function TechDocFormatAgentPage() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('generate');
  const [form, setForm] = useState<TechDocDraftInput>(DEFAULT_FORM);
  const [checkDoc, setCheckDoc] = useState('');
  const [checkFileName, setCheckFileName] = useState('');
  const [generatedDoc, setGeneratedDoc] = useState('');
  const [phase, setPhase] = useState<RunPhase>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [modelInfo, setModelInfo] = useState<{ model?: string; platform?: string } | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const abortRef = useRef<(() => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (phase !== 'streaming') {
      setElapsedSec(0);
      return;
    }
    const timer = window.setInterval(() => setElapsedSec((prev) => prev + 1), 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    return () => abortRef.current?.();
  }, []);

  const generatedValidation = useMemo(
    () => validateTechDocFormat(generatedDoc),
    [generatedDoc],
  );

  const checkValidation = useMemo(
    () => validateTechDocFormat(checkDoc),
    [checkDoc],
  );

  const canGenerate = form.requirementText.trim().length > 0 || form.projectLinks.trim().length > 0;

  const updateForm = useCallback((key: keyof TechDocDraftInput, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const copyText = useCallback(async (content: string, label: string) => {
    if (!content.trim()) {
      toast.warning('暂无可复制内容');
      return;
    }
    await navigator.clipboard.writeText(content);
    toast.success(`${label}已复制`);
  }, []);

  const handleBuildDraft = useCallback(() => {
    const draft = buildPm2502Draft(form);
    setGeneratedDoc(draft);
    setPhase('done');
    setErrorMsg('');
    setModelInfo(null);
    setActiveTab('generate');
    toast.success('已生成 PM2502 底稿', '底稿已自动完成模板校验');
  }, [form]);

  const runPrompt = useCallback((prompt: string) => {
    abortRef.current?.();
    setGeneratedDoc('');
    setErrorMsg('');
    setModelInfo(null);
    setPhase('streaming');

    abortRef.current = streamDirectChat({
      message: prompt,
      onStart: (info) => {
        setModelInfo(info);
      },
      onText: (chunk) => {
        setGeneratedDoc((prev) => prev + chunk);
      },
      onError: (message) => {
        setPhase('error');
        setErrorMsg(message || '生成失败');
      },
      onDone: () => {
        setPhase('done');
        abortRef.current = null;
      },
    });
  }, []);

  const handleAiGenerate = useCallback(() => {
    if (!canGenerate) {
      toast.warning('请先填写功能说明或项目链接');
      return;
    }
    runPrompt(buildTechDocGenerationPrompt(form));
  }, [canGenerate, form, runPrompt]);

  const handleRepair = useCallback(() => {
    if (!generatedDoc.trim()) {
      toast.warning('暂无可修复文档');
      return;
    }
    const issues = generatedValidation.issues.filter((issue) => issue.severity !== 'info');
    if (issues.length === 0) {
      toast.success('当前文档已通过格式校验');
      return;
    }
    runPrompt(buildTechDocRepairPrompt(generatedDoc, issues));
  }, [generatedDoc, generatedValidation.issues, runPrompt]);

  const handleStop = useCallback(() => {
    abortRef.current?.();
    abortRef.current = null;
    setPhase('idle');
    toast.info('已停止生成');
  }, []);

  const handleFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setCheckFileName(file.name);
    setCheckDoc(text);
    setActiveTab('check');
    event.target.value = '';
  }, []);

  const inputClass =
    'w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-[color:var(--text-primary)] placeholder:text-[color:var(--text-muted)] outline-none focus:border-indigo-400/50';

  return (
    <div className="h-full min-h-0 flex flex-col gap-4 p-5">
      <header className="shrink-0 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl border border-indigo-400/20 bg-indigo-500/10 p-3">
            <FileText size={24} className="text-indigo-200" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-[color:var(--text-primary)]">技术分析文档格式校验 Agent</h1>
            <p className="mt-1 max-w-3xl text-sm text-[color:var(--text-secondary)]">
              根据功能和项目链接生成 PM2502 技术分析文档，或上传已有技术分析文档检查标题、表格、红字、引用块和微格式。
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={activeTab === 'generate' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setActiveTab('generate')}
          >
            <Wand2 size={14} />
            生成文档
          </Button>
          <Button
            variant={activeTab === 'check' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setActiveTab('check')}
          >
            <ShieldCheck size={14} />
            检查文档
          </Button>
          <Button
            variant={activeTab === 'template' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setActiveTab('template')}
          >
            <FileText size={14} />
            模板真源
          </Button>
        </div>
      </header>

      {activeTab === 'generate' && (
        <div className="min-h-0 flex-1 grid gap-4 xl:grid-cols-[420px_minmax(0,1fr)]">
          <GlassCard className="min-h-0 flex flex-col gap-4 p-4" overflow="hidden">
            <div className="shrink-0">
              <h2 className="text-base font-semibold text-[color:var(--text-primary)]">输入功能与项目资料</h2>
              <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
                信息不足时会按模板补“待定/不涉及”，不会删除 PM2502 固定栏目。
              </p>
            </div>
            <div
              className="min-h-0 flex-1 space-y-3 pr-1"
              style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs text-[color:var(--text-secondary)]">
                  项目名称
                  <input className={inputClass} value={form.projectName} onChange={(e) => updateForm('projectName', e.target.value)} placeholder="例如 PM2603 技术分析" />
                </label>
                <label className="space-y-1 text-xs text-[color:var(--text-secondary)]">
                  应用
                  <input className={inputClass} value={form.appName} onChange={(e) => updateForm('appName', e.target.value)} placeholder="例如 米多总后台" />
                </label>
                <label className="space-y-1 text-xs text-[color:var(--text-secondary)]">
                  模块
                  <input className={inputClass} value={form.moduleName} onChange={(e) => updateForm('moduleName', e.target.value)} placeholder="例如 百宝箱" />
                </label>
                <label className="space-y-1 text-xs text-[color:var(--text-secondary)]">
                  功能
                  <input className={inputClass} value={form.featureName} onChange={(e) => updateForm('featureName', e.target.value)} placeholder="例如 技术分析文档校验" />
                </label>
              </div>

              <label className="block space-y-1 text-xs text-[color:var(--text-secondary)]">
                方案/项目链接
                <textarea
                  className={`${inputClass} min-h-[72px] resize-y`}
                  value={form.projectLinks}
                  onChange={(e) => updateForm('projectLinks', e.target.value)}
                  placeholder="粘贴功能、项目、代码仓库、需求文档等链接"
                />
              </label>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs text-[color:var(--text-secondary)]">
                  UI 设计图
                  <input className={inputClass} value={form.uiLink} onChange={(e) => updateForm('uiLink', e.target.value)} placeholder="可选" />
                </label>
                <label className="space-y-1 text-xs text-[color:var(--text-secondary)]">
                  Showdoc 地址
                  <input className={inputClass} value={form.showdocLink} onChange={(e) => updateForm('showdocLink', e.target.value)} placeholder="可选" />
                </label>
              </div>

              <label className="block space-y-1 text-xs text-[color:var(--text-secondary)]">
                测试用例
                <input className={inputClass} value={form.testCaseLink} onChange={(e) => updateForm('testCaseLink', e.target.value)} placeholder="可选" />
              </label>

              <label className="block space-y-1 text-xs text-[color:var(--text-secondary)]">
                功能与需求说明
                <textarea
                  className={`${inputClass} min-h-[180px] resize-y`}
                  value={form.requirementText}
                  onChange={(e) => updateForm('requirementText', e.target.value)}
                  placeholder="描述要分析的功能、输入输出、接口、前端交互、排期约束等"
                />
              </label>
            </div>
            <div className="shrink-0 flex flex-wrap gap-2 border-t border-white/10 pt-3">
              <Button variant="secondary" size="sm" onClick={handleBuildDraft}>
                <FileText size={14} />
                生成底稿
              </Button>
              <Button variant="primary" size="sm" onClick={handleAiGenerate} disabled={phase === 'streaming'}>
                {phase === 'streaming' ? <MapSpinner size={14} /> : <Wand2 size={14} />}
                AI 生成并校验
              </Button>
              {phase === 'streaming' && (
                <Button variant="danger" size="sm" onClick={handleStop}>
                  停止
                </Button>
              )}
            </div>
          </GlassCard>

          <GlassCard className="min-h-0 flex flex-col p-4" overflow="hidden">
            <div className="shrink-0 flex flex-col gap-2 border-b border-white/10 pb-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-base font-semibold text-[color:var(--text-primary)]">输出文档与自动校验</h2>
                <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
                  生成完成后会用同一套 PM2502 校验器检查，未通过可一键修复。
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={() => copyText(generatedDoc, '生成文档')}>
                  <Copy size={14} />
                  复制
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => downloadMarkdown(generatedDoc, 'pm2502-tech-analysis.md')}
                  disabled={!generatedDoc.trim()}
                >
                  <Download size={14} />
                  下载
                </Button>
                <Button variant="secondary" size="sm" onClick={handleRepair} disabled={!generatedDoc.trim() || phase === 'streaming'}>
                  <RefreshCw size={14} />
                  修复格式
                </Button>
              </div>
            </div>

            <div className="shrink-0 mt-3 flex flex-wrap items-center gap-2 text-xs">
              {phase === 'streaming' && (
                <span className="inline-flex items-center gap-2 rounded-full border border-indigo-400/20 bg-indigo-500/10 px-3 py-1 text-indigo-100">
                  <MapSpinner size={12} />
                  {stageText(elapsedSec)}，已等待 {elapsedSec} 秒
                </span>
              )}
              {modelInfo?.model && (
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[color:var(--text-secondary)]">
                  模型：{modelInfo.model}{modelInfo.platform ? ` / ${modelInfo.platform}` : ''}
                </span>
              )}
              {phase === 'error' && (
                <span className="inline-flex items-center gap-1 rounded-full border border-red-400/20 bg-red-500/10 px-3 py-1 text-red-200">
                  <XCircle size={12} />
                  {errorMsg}
                </span>
              )}
              {generatedDoc.trim() && phase !== 'streaming' && (
                <ValidationBadge result={generatedValidation} />
              )}
            </div>

            <div
              className="mt-3 min-h-0 flex-1 rounded-xl border border-white/10 bg-black/20 p-3"
              style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}
            >
              {generatedDoc ? (
                <StreamingText
                  text={generatedDoc}
                  streaming={phase === 'streaming'}
                  mode="blur"
                  className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-[color:var(--text-primary)]"
                />
              ) : (
                <div className="flex h-full min-h-[260px] flex-col items-center justify-center text-center text-[color:var(--text-secondary)]">
                  <FileText size={36} className="mb-3 opacity-60" />
                  <p className="text-sm font-medium text-[color:var(--text-primary)]">等待生成 PM2502 技术分析文档</p>
                  <p className="mt-1 max-w-md text-xs">先填写左侧信息，可生成本地底稿，也可调用 AI 生成完整技术分析文档。</p>
                </div>
              )}
            </div>

            {generatedDoc.trim() && phase !== 'streaming' && (
              <IssueList issues={generatedValidation.issues} />
            )}
          </GlassCard>
        </div>
      )}

      {activeTab === 'check' && (
        <div className="min-h-0 flex-1 grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
          <GlassCard className="min-h-0 flex flex-col p-4" overflow="hidden">
            <div className="shrink-0 flex flex-col gap-2 border-b border-white/10 pb-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-base font-semibold text-[color:var(--text-primary)]">上传或粘贴技术分析文档</h2>
                <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
                  支持 Markdown 或纯文本文件，检查按 PM2502 模板严格执行。
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,.markdown,.txt,text/markdown,text/plain"
                  className="hidden"
                  onChange={handleFileChange}
                />
                <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
                  <Upload size={14} />
                  上传文档
                </Button>
                <Button variant="secondary" size="sm" onClick={() => copyText(checkDoc, '待检查文档')}>
                  <Copy size={14} />
                  复制
                </Button>
              </div>
            </div>
            {checkFileName && (
              <div className="shrink-0 mt-3 text-xs text-[color:var(--text-secondary)]">当前文件：{checkFileName}</div>
            )}
            <textarea
              className="mt-3 min-h-0 flex-1 resize-none rounded-xl border border-white/10 bg-black/20 p-3 font-mono text-xs leading-relaxed text-[color:var(--text-primary)] outline-none focus:border-indigo-400/50"
              style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}
              value={checkDoc}
              onChange={(e) => setCheckDoc(e.target.value)}
              placeholder="粘贴技术分析文档 Markdown 正文，或点击上传文档"
            />
          </GlassCard>

          <GlassCard className="min-h-0 flex flex-col p-4" overflow="hidden">
            <div className="shrink-0 flex items-center justify-between border-b border-white/10 pb-3">
              <div>
                <h2 className="text-base font-semibold text-[color:var(--text-primary)]">检查结果</h2>
                <p className="mt-1 text-xs text-[color:var(--text-secondary)]">错误为交付阻断项，建议项用于模板细节对齐。</p>
              </div>
              <ValidationBadge result={checkValidation} />
            </div>
            <div className="shrink-0 mt-4 grid grid-cols-3 gap-2 text-center">
              <MetricCard label="得分" value={`${checkValidation.score}`} />
              <MetricCard label="错误" value={`${checkValidation.summary.errorCount}`} tone="error" />
              <MetricCard label="建议" value={`${checkValidation.summary.warningCount}`} tone="warning" />
            </div>
            <IssueList issues={checkValidation.issues} compact />
          </GlassCard>
        </div>
      )}

      {activeTab === 'template' && (
        <GlassCard className="min-h-0 flex-1 flex flex-col p-4" overflow="hidden">
          <div className="shrink-0 flex flex-col gap-2 border-b border-white/10 pb-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-base font-semibold text-[color:var(--text-primary)]">PM2502 模板真源</h2>
              <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
                生成和检查均以这份模板为格式真源，除非用户显式指定其他模板。
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => copyText(PM2502_TECH_DOC_TEMPLATE, 'PM2502 模板')}>
                <Copy size={14} />
                复制模板
              </Button>
              <Button variant="secondary" size="sm" onClick={() => downloadMarkdown(PM2502_TECH_DOC_TEMPLATE, 'xxx技术分析PM2502.md')}>
                <Download size={14} />
                下载模板
              </Button>
            </div>
          </div>
          <pre
            className="mt-3 min-h-0 flex-1 whitespace-pre-wrap rounded-xl border border-white/10 bg-black/20 p-3 font-mono text-xs leading-relaxed text-[color:var(--text-primary)]"
            style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}
          >
            {PM2502_TECH_DOC_TEMPLATE}
          </pre>
        </GlassCard>
      )}
    </div>
  );
}

function ValidationBadge({ result }: { result: ReturnType<typeof validateTechDocFormat> }) {
  if (result.passed) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-200">
        <CheckCircle2 size={12} />
        已通过
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/20 bg-amber-500/10 px-3 py-1 text-xs text-amber-100">
      <AlertTriangle size={12} />
      待修复
    </span>
  );
}

function MetricCard({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'error' | 'warning';
}) {
  const toneClass =
    tone === 'error'
      ? 'text-red-200'
      : tone === 'warning'
        ? 'text-amber-100'
        : 'text-[color:var(--text-primary)]';

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
      <div className={`text-lg font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-1 text-xs text-[color:var(--text-secondary)]">{label}</div>
    </div>
  );
}

function IssueList({ issues, compact = false }: { issues: TechDocIssue[]; compact?: boolean }) {
  const visibleIssues = compact ? issues : issues.slice(0, 8);

  if (issues.length === 0) {
    return (
      <div className="mt-3 rounded-xl border border-emerald-400/20 bg-emerald-500/10 p-3 text-sm text-emerald-100">
        未发现 PM2502 格式阻断项。
      </div>
    );
  }

  return (
    <div
      className="mt-3 min-h-0 space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-3"
      style={compact ? { overflowY: 'auto', overscrollBehavior: 'contain' } : undefined}
    >
      {visibleIssues.map((issue) => (
        <div key={issue.id} className="rounded-lg border border-white/10 bg-black/20 p-3">
          <div className="flex items-start gap-2">
            {issue.severity === 'error' ? (
              <XCircle size={14} className="mt-0.5 shrink-0 text-red-300" />
            ) : (
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-200" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-[color:var(--text-primary)]">{issue.title}</span>
                <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-[color:var(--text-secondary)]">
                  {severityLabel(issue.severity)}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-[color:var(--text-secondary)]">{issue.detail}</p>
              <p className="mt-1 text-xs leading-relaxed text-indigo-100">修复建议：{issue.fix}</p>
            </div>
          </div>
        </div>
      ))}
      {!compact && issues.length > visibleIssues.length && (
        <div className="text-center text-xs text-[color:var(--text-secondary)]">
          还有 {issues.length - visibleIssues.length} 条问题，可到“检查文档”页查看完整列表。
        </div>
      )}
    </div>
  );
}
