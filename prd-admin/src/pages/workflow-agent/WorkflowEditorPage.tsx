import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Play, Loader2, CheckCircle2, AlertCircle,
  Download, FileText, ArrowLeft, Save, Plus,
  ChevronDown, ChevronRight, Settings2, XCircle,
  Zap, FlaskConical, Trash2, Wand2, Terminal, Eye,
} from 'lucide-react';
import {
  getWorkflow, updateWorkflow, executeWorkflow, getExecution,
  getNodeLogs, listExecutions, cancelExecution,
  listCapsuleTypes, testRunCapsule,
} from '@/services';
import type {
  Workflow, WorkflowNode, WorkflowExecution, ExecutionArtifact,
  NodeExecution, CapsuleTypeMeta, CapsuleCategoryInfo,
  CapsuleConfigField,
} from '@/services/contracts/workflowAgent';
import { GlassCard } from '@/components/design/GlassCard';
import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { TabBar } from '@/components/design/TabBar';
import {
  getCapsuleType, getIconForCapsule, getEmojiForCapsule, getCategoryEmoji,
} from './capsuleRegistry';
import { parseCurl, toCurl, headersToJson, prettyBody, type ParsedCurl } from './parseCurl';
import { HttpConfigPanel } from './HttpConfigPanel';
import { WorkflowChatPanel } from './WorkflowChatPanel';
import { ArtifactPreviewModal } from './ArtifactPreviewModal';
import type { WorkflowChatGenerated } from '@/services/contracts/workflowAgent';

// ═══════════════════════════════════════════════════════════════
// 工作流直接编辑页
//
// 布局：
//   ┌──────────────────────────────────────────────────────────┐
//   │ TabBar (工作流名称 + 操作按钮 + AI助手开关)              │
//   ├──────────┬──────────────────────────┬────────────────────┤
//   │ 左侧     │ 中间                     │ 右侧 (可选)       │
//   │ 舱目录   │ 已添加的舱列表           │ AI 聊天面板       │
//   │ (可选择  │ 点击展开配置/调试/结果   │ (WorkflowChat-    │
//   │  添加)   │                          │  Panel)           │
//   └──────────┴──────────────────────────┴────────────────────┘
// ═══════════════════════════════════════════════════════════════

// ──── 状态映射 ────

const EXEC_STATUS_MAP: Record<string, { label: string; variant: 'success' | 'danger' | 'warning' | 'featured' | 'subtle' }> = {
  queued: { label: '排队中', variant: 'warning' },
  running: { label: '执行中', variant: 'featured' },
  completed: { label: '已完成', variant: 'success' },
  failed: { label: '失败', variant: 'danger' },
  cancelled: { label: '已取消', variant: 'subtle' },
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function getDefaultMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 通用产物操作按钮：预览 + 下载 */
function ArtifactActionButtons({ artifact, onPreview, size = 'sm' }: {
  artifact: { name: string; mimeType: string; sizeBytes: number; inlineContent?: string; cosUrl?: string };
  onPreview?: (art: ExecutionArtifact) => void;
  size?: 'sm' | 'md';
}) {
  const iconSize = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4';
  const padding = size === 'sm' ? 'p-1' : 'p-1.5';
  return (
    <>
      {(artifact.inlineContent || artifact.cosUrl) && onPreview && (
        <button
          onClick={(e) => { e.stopPropagation(); onPreview(artifact as ExecutionArtifact); }}
          className={`${padding} rounded-[6px] flex-shrink-0 transition-colors`}
          title="预览"
          style={{ color: 'var(--accent-gold)' }}
        >
          <Eye className={iconSize} />
        </button>
      )}
      {artifact.cosUrl && (
        <a
          href={artifact.cosUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className={`${padding} rounded-[6px] flex-shrink-0 transition-colors`}
          title="下载"
          style={{ color: 'var(--text-muted)' }}
        >
          <Download className={iconSize} />
        </a>
      )}
      {!artifact.cosUrl && artifact.inlineContent && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            const blob = new Blob([artifact.inlineContent!], { type: artifact.mimeType || 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = artifact.name || 'output';
            a.click();
            URL.revokeObjectURL(url);
          }}
          className={`${padding} rounded-[6px] flex-shrink-0 transition-colors`}
          title="下载"
          style={{ color: 'var(--text-muted)' }}
        >
          <Download className={iconSize} />
        </button>
      )}
    </>
  );
}

// ──── 小组件 ────

function StepStatusBadge({ status, durationMs }: { status: string; durationMs?: number }) {
  if (status === 'completed') return (
    <Badge variant="success" size="sm" icon={<CheckCircle2 className="w-3 h-3" />}>
      完成{durationMs != null ? ` · ${(durationMs / 1000).toFixed(1)}s` : ''}
    </Badge>
  );
  if (status === 'running') return (
    <Badge variant="featured" size="sm" icon={<Loader2 className="w-3 h-3 animate-spin" />}>
      执行中
    </Badge>
  );
  if (status === 'failed') return (
    <Badge variant="danger" size="sm" icon={<AlertCircle className="w-3 h-3" />}>
      失败
    </Badge>
  );
  if (status === 'skipped') return <Badge variant="subtle" size="sm">已跳过</Badge>;
  return <Badge variant="subtle" size="sm">等待执行</Badge>;
}

// ──── 左侧舱目录面板 ────

function CapsuleSidebar({ capsuleTypes, categories, onAddCapsule }: {
  capsuleTypes: CapsuleTypeMeta[];
  categories: CapsuleCategoryInfo[];
  onAddCapsule: (typeKey: string) => void;
}) {
  const grouped = categories.reduce<Record<string, CapsuleTypeMeta[]>>((acc, cat) => {
    acc[cat.key] = capsuleTypes.filter(t => t.category === cat.key);
    return acc;
  }, {});

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          舱目录
        </span>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          点击添加
        </span>
      </div>

      {categories.map((cat) => {
        const types = grouped[cat.key] || [];
        if (types.length === 0) return null;
        return (
          <div key={cat.key}>
            <div className="text-[10px] font-medium mb-1.5 flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
              <span>{getCategoryEmoji(cat.key)}</span>
              {cat.label}
            </div>
            <div className="space-y-1">
              {types.map((meta) => {
                const Icon = getIconForCapsule(meta.icon);
                const emoji = getEmojiForCapsule(meta.typeKey);
                const frontDef = getCapsuleType(meta.typeKey);
                const disabledReason = (meta as any).disabledReason || frontDef?.disabledReason;
                const isDisabled = !!disabledReason;

                return (
                  <button
                    key={meta.typeKey}
                    onClick={() => !isDisabled && onAddCapsule(meta.typeKey)}
                    className="surface-row w-full flex items-center gap-2 px-2 py-1.5 rounded-[8px] transition-colors text-left"
                    style={{
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.06)',
                      opacity: isDisabled ? 0.4 : 1,
                      cursor: isDisabled ? 'not-allowed' : 'pointer',
                    }}
                    title={isDisabled ? disabledReason : meta.description}
                  >
                    <div
                      className="w-6 h-6 rounded-[6px] flex items-center justify-center flex-shrink-0"
                      style={{
                        background: `hsla(${meta.accentHue}, 60%, 55%, ${isDisabled ? '0.06' : '0.12'})`,
                        color: `hsla(${meta.accentHue}, 60%, 65%, ${isDisabled ? '0.4' : '0.9'})`,
                      }}
                    >
                      <Icon className="w-3 h-3" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1">
                        <span className="text-[11px]">{emoji}</span>
                        <span className="text-[11px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                          {meta.name}
                        </span>
                        {isDisabled && (
                          <span className="text-[9px] ml-auto flex-shrink-0" style={{ color: 'var(--text-muted)' }}>开发中</span>
                        )}
                      </div>
                    </div>
                    {!isDisabled && (
                      <Plus className="w-3 h-3 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: 'var(--text-muted)' }} />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ──── cURL 导入面板 ────

function CurlImportPanel({ onImport, disabled }: {
  onImport: (parsed: { url: string; method: string; headers: string; body: string }) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState('');
  const [error, setError] = useState('');

  function handleParse() {
    setError('');
    const parsed = parseCurl(raw);
    if (!parsed) {
      setError('无法解析，请粘贴有效的 curl 命令');
      return;
    }
    onImport({
      url: parsed.url,
      method: parsed.method,
      headers: headersToJson(parsed.headers),
      body: prettyBody(parsed.body),
    });
    setOpen(false);
    setRaw('');
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="surface-row w-full flex items-center justify-center gap-1.5 h-8 rounded-[8px] text-[11px] font-semibold transition-all duration-150 mb-2"
        style={{
          background: 'rgba(59,130,246,0.06)',
          border: '1px dashed rgba(59,130,246,0.2)',
          color: 'rgba(59,130,246,0.8)',
        }}
      >
        ⌘ 从浏览器粘贴 cURL
      </button>
    );
  }

  return (
    <div
      className="rounded-[10px] p-3 mb-3 space-y-2"
      style={{
        background: 'rgba(59,130,246,0.04)',
        border: '1px solid rgba(59,130,246,0.12)',
      }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold" style={{ color: 'rgba(59,130,246,0.85)' }}>
          粘贴 cURL 命令
        </span>
        <button
          onClick={() => { setOpen(false); setRaw(''); setError(''); }}
          className="text-[10px] px-2 py-0.5 rounded-full"
          style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,0.05)' }}
        >
          取消
        </button>
      </div>
      <textarea
        value={raw}
        onChange={e => setRaw(e.target.value)}
        placeholder={"curl 'https://api.example.com/data' \\\n  -H 'Authorization: Bearer token' \\\n  -X POST \\\n  -d '{\"key\":\"value\"}'"}
        rows={5}
        className="prd-field w-full px-3 py-2 rounded-[8px] text-[11px] outline-none resize-y font-mono"
        autoFocus
      />
      {error && (
        <p className="text-[10px]" style={{ color: 'rgba(239,68,68,0.85)' }}>{error}</p>
      )}
      <button
        onClick={handleParse}
        disabled={!raw.trim()}
        className="w-full h-7 rounded-[8px] text-[11px] font-semibold transition-all duration-150 disabled:opacity-40"
        style={{
          background: 'rgba(59,130,246,0.12)',
          border: '1px solid rgba(59,130,246,0.2)',
          color: 'rgba(59,130,246,0.9)',
        }}
      >
        ⚡ 解析并填入
      </button>
    </div>
  );
}

// ──── cURL 导出按钮 ────

function CurlExportButton({ values }: { values: Record<string, string> }) {
  const [copied, setCopied] = useState(false);

  function handleExport() {
    const url = values.url || values.curlCommand || '';
    if (!url) return;
    const cmd = toCurl({
      url,
      method: values.method,
      headers: values.headers,
      body: values.body,
    });
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const hasUrl = !!(values.url || values.curlCommand);

  return (
    <button
      onClick={handleExport}
      disabled={!hasUrl}
      className="surface-row w-full flex items-center justify-center gap-1.5 h-7 rounded-[8px] text-[11px] font-medium transition-all duration-150 disabled:opacity-30"
      style={{
        background: copied ? 'rgba(34,197,94,0.08)' : 'rgba(168,85,247,0.06)',
        border: `1px dashed ${copied ? 'rgba(34,197,94,0.25)' : 'rgba(168,85,247,0.2)'}`,
        color: copied ? 'rgba(34,197,94,0.9)' : 'rgba(168,85,247,0.8)',
      }}
    >
      {copied ? '✓ 已复制到剪贴板' : '⬆ 导出为 cURL 命令'}
    </button>
  );
}

// ──── 舱配置表单 ────

function CapsuleConfigForm({ fields, values, onChange, onBatchChange, disabled, nodeType }: {
  fields: CapsuleConfigField[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onBatchChange: (changes: Record<string, string>) => void;
  disabled?: boolean;
  nodeType?: string;
}) {
  const supportssCurl = nodeType === 'http-request' || nodeType === 'smart-http';

  if (fields.length === 0 && !supportssCurl) return (
    <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>此舱无需额外配置</p>
  );

  // 将 parseCurl 结果一次性写入所有配置字段（避免多次 onChange 导致 stale state 覆盖）
  function applyCurlParsed(parsed: ParsedCurl, rawText?: string) {
    const batch: Record<string, string> = {};
    batch.url = parsed.url;
    batch.method = parsed.method;
    const h = headersToJson(parsed.headers);
    if (h) batch.headers = h;
    const b = prettyBody(parsed.body);
    if (b) batch.body = b;
    if (nodeType === 'smart-http' && rawText) batch.curlCommand = rawText;
    onBatchChange(batch);
    setCurlParsed(true);
    setTimeout(() => setCurlParsed(false), 2500);
  }

  function handleCurlImport(parsed: { url: string; method: string; headers: string; body: string }) {
    const batch: Record<string, string> = {};
    if (parsed.url) batch.url = parsed.url;
    if (parsed.method) batch.method = parsed.method;
    if (parsed.headers) batch.headers = parsed.headers;
    if (parsed.body) batch.body = parsed.body;
    if (nodeType === 'smart-http') {
      batch.curlCommand = `curl '${parsed.url}' -X ${parsed.method}${parsed.headers ? ` -H '...'` : ''}${parsed.body ? ` -d '...'` : ''}`;
    }
    onBatchChange(batch);
  }

  // curlCommand 文本框自动解析：粘贴 cURL 命令后自动填充 url/method/headers/body
  const [curlParsed, setCurlParsed] = useState(false);
  function handleCurlCommandPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    const parsed = parseCurl(text);
    if (parsed) {
      e.preventDefault();
      applyCurlParsed(parsed, text);
    }
  }

  return (
    <div className="space-y-3">
      {/* cURL 导入 + 导出（仅 http-request / smart-http） */}
      {supportssCurl && (
        <>
          <CurlImportPanel onImport={handleCurlImport} disabled={disabled} />
          <CurlExportButton values={values} />
        </>
      )}

      {fields.map((field) => (
        <div key={field.key}>
          <label className="flex items-center gap-1.5 text-[11px] mb-1" style={{ color: 'var(--text-secondary)' }}>
            {field.label}
            {field.key === 'curlCommand' && curlParsed && (
              <span className="text-[10px] font-medium" style={{ color: 'rgba(34,197,94,0.9)' }}>
                ✓ 已解析并填入下方字段
              </span>
            )}
          </label>
          {field.fieldType === 'textarea' || field.fieldType === 'code' ? (
            <textarea
              value={values[field.key] || field.defaultValue || ''}
              onChange={(e) => onChange(field.key, e.target.value)}
              onPaste={field.key === 'curlCommand' && supportssCurl ? handleCurlCommandPaste : undefined}
              placeholder={field.placeholder}
              disabled={disabled}
              rows={field.fieldType === 'code' ? 8 : 4}
              className="prd-field w-full px-3 py-2 rounded-[8px] text-[12px] outline-none disabled:opacity-50 transition-all resize-y font-mono"
            />
          ) : field.fieldType === 'json' ? (
            <textarea
              value={values[field.key] || field.defaultValue || ''}
              onChange={(e) => onChange(field.key, e.target.value)}
              placeholder={field.placeholder}
              disabled={disabled}
              rows={3}
              className="prd-field w-full px-3 py-2 rounded-[8px] text-[12px] outline-none disabled:opacity-50 transition-all resize-y font-mono"
            />
          ) : field.fieldType === 'select' && field.options ? (
            <select
              value={values[field.key] || field.defaultValue || ''}
              onChange={(e) => onChange(field.key, e.target.value)}
              disabled={disabled}
              className="prd-field w-full h-[32px] px-3 rounded-[8px] text-[12px] outline-none disabled:opacity-50"
            >
              <option value="">{field.placeholder || '请选择'}</option>
              {field.options.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          ) : (
            <input
              type={field.fieldType === 'password' ? 'password' : field.fieldType === 'number' ? 'number' : 'text'}
              value={values[field.key] || field.defaultValue || ''}
              onChange={(e) => onChange(field.key, e.target.value)}
              onPaste={field.key === 'url' && supportssCurl ? (e) => {
                const text = e.clipboardData.getData('text/plain');
                if (text && /^\s*curl[\s.]/i.test(text)) {
                  const parsed = parseCurl(text);
                  if (parsed) {
                    e.preventDefault();
                    applyCurlParsed(parsed);
                  }
                }
              } : undefined}
              placeholder={field.placeholder}
              disabled={disabled}
              className="prd-field w-full h-[32px] px-3 rounded-[8px] text-[12px] outline-none disabled:opacity-50 transition-all"
            />
          )}
          {field.helpTip && (
            <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{field.helpTip}</p>
          )}
        </div>
      ))}
    </div>
  );
}

// ──── 区域框（输入/配置/输出 三段分区） ────

const SECTION_STYLES = {
  input: {
    bg: 'rgba(59,130,246,0.03)',
    border: 'rgba(59,130,246,0.12)',
    headerBg: 'rgba(59,130,246,0.06)',
    title: 'rgba(59,130,246,0.85)',
  },
  config: {
    bg: 'rgba(99,102,241,0.02)',
    border: 'rgba(99,102,241,0.12)',
    headerBg: 'rgba(99,102,241,0.05)',
    title: 'rgba(99,102,241,0.85)',
  },
  output: {
    bg: 'rgba(34,197,94,0.03)',
    border: 'rgba(34,197,94,0.12)',
    headerBg: 'rgba(34,197,94,0.06)',
    title: 'rgba(34,197,94,0.85)',
  },
} as const;

function SectionBox({ title, type, children }: {
  title: string;
  type: keyof typeof SECTION_STYLES;
  children: React.ReactNode;
}) {
  const s = SECTION_STYLES[type];
  return (
    <div className="rounded-[10px] overflow-hidden" style={{ border: `1px solid ${s.border}` }}>
      <div
        className="px-3 py-1.5 flex items-center gap-1.5"
        style={{ background: s.headerBg, borderBottom: `1px solid ${s.border}` }}
      >
        <span className="text-[11px] font-semibold" style={{ color: s.title }}>{title}</span>
      </div>
      <div className="p-3" style={{ background: s.bg }}>{children}</div>
    </div>
  );
}

// ──── 右侧舱卡片 ────

function CapsuleCard({ node, index, nodeExec, nodeOutput, isExpanded, onToggle, onRemove, onTestRun, onConfigChange, capsuleMeta, isRunning, testRunResult, isTestRunning, formatWarnings, onPreviewArtifact }: {
  node: WorkflowNode;
  index: number;
  nodeExec?: NodeExecution;
  nodeOutput?: { logs: string; artifacts: ExecutionArtifact[] };
  isExpanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onTestRun: (testInput?: string) => void;
  onConfigChange: (nodeId: string, config: Record<string, unknown>) => void;
  capsuleMeta?: CapsuleTypeMeta;
  isRunning: boolean;
  testRunResult?: import('@/services/contracts/workflowAgent').CapsuleTestRunResult | null;
  isTestRunning?: boolean;
  formatWarnings?: { nodeId: string; message: string }[];
  onPreviewArtifact?: (art: ExecutionArtifact) => void;
}) {
  const typeDef = getCapsuleType(node.nodeType);
  const status = nodeExec?.status || 'idle';
  const isActive = status === 'running';
  const accentHue = typeDef?.accentHue ?? capsuleMeta?.accentHue ?? 210;
  const CIcon = typeDef?.Icon;
  const emoji = typeDef?.emoji ?? '📦';

  // 配置值直接从 node.config 读取（由父组件管理状态）
  const configValues: Record<string, string> = {};
  if (node.config) {
    for (const [k, v] of Object.entries(node.config)) {
      configValues[k] = String(v ?? '');
    }
  }

  function handleConfigFieldChange(key: string, val: string) {
    const updated = { ...node.config, [key]: val };
    onConfigChange(node.nodeId, updated);
  }

  function handleConfigBatchChange(changes: Record<string, string>) {
    const updated = { ...node.config, ...changes };
    onConfigChange(node.nodeId, updated);
  }

  const [expandedArtifacts, setExpandedArtifacts] = useState<Set<string>>(new Set());
  const [testInput, setTestInput] = useState('');

  function toggleArtifact(id: string) {
    setExpandedArtifacts((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // 判断此舱是否需要输入（有 required 输入插槽）
  const hasRequiredInput = node.inputSlots.some(s => s.required);
  const hasAnyInputSlot = node.inputSlots.length > 0;
  const isHttpType = node.nodeType === 'http-request' || node.nodeType === 'smart-http';

  // 统一结果：合并测试结果和执行结果为同一面板
  // 只要有执行记录即显示（含刷新后从 API 加载的历史执行结果）
  const currentExecOutput = (nodeOutput && nodeExec && (status === 'completed' || status === 'failed'))
    ? {
        status: status === 'completed' ? 'completed' as const : 'failed' as const,
        durationMs: nodeExec.durationMs ?? 0,
        logs: nodeOutput.logs,
        artifacts: nodeOutput.artifacts.map(a => ({
          name: a.name,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          inlineContent: a.inlineContent,
          cosUrl: a.cosUrl,
          artifactId: a.artifactId,
        })),
        errorMessage: nodeExec.errorMessage,
      }
    : null;

  const unifiedResult = testRunResult || currentExecOutput;
  const resultSource: 'test' | 'exec' | null = testRunResult ? 'test' : currentExecOutput ? 'exec' : null;

  return (
    <div className={isActive ? 'capsule-running-border' : ''}>
      <GlassCard
        animated
        accentHue={accentHue}
        glow={isActive}
        padding="md"
        className=""
      >
        {/* 头部：点击展开/折叠 */}
        <div
          className="flex items-center gap-3 cursor-pointer select-none"
          onClick={onToggle}
        >
          {/* 序号 */}
          <span
            className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0"
            style={
              status === 'completed'
                ? { background: 'rgba(34,197,94,0.2)', color: 'rgba(34,197,94,0.95)' }
                : status === 'running'
                  ? { background: 'rgba(99,102,241,0.18)', color: 'var(--accent-gold)' }
                  : status === 'failed'
                    ? { background: 'rgba(239,68,68,0.15)', color: 'rgba(239,68,68,0.9)' }
                    : { background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }
            }
          >
            {status === 'completed' ? '✓' : index + 1}
          </span>

          {/* 图标 + 名称 */}
          <div
            className="w-8 h-8 rounded-[8px] flex items-center justify-center flex-shrink-0"
            style={{
              background: `hsla(${accentHue}, 60%, 55%, 0.12)`,
              color: `hsla(${accentHue}, 60%, 65%, 0.9)`,
            }}
          >
            {CIcon ? <CIcon className="w-4 h-4" /> : <span>{emoji}</span>}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                {node.name}
              </h3>
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  color: 'var(--text-muted)',
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                {typeDef?.name ?? node.nodeType}
              </span>
              {/* 紧凑插槽标识：蓝圈=输入  绿圈=输出  悬浮显示详情 */}
              {node.inputSlots.length > 0 && (
                <span
                  className="relative group px-1 py-0.5 rounded text-[9px] font-mono cursor-default"
                  style={{ background: `hsla(${accentHue}, 50%, 50%, 0.1)`, color: `hsla(${accentHue}, 55%, 70%, 0.85)`, border: `1px solid hsla(${accentHue}, 50%, 50%, 0.15)` }}
                >
                  ← {node.inputSlots.length}
                  <span className="absolute left-0 top-full mt-1 z-50 hidden group-hover:block whitespace-nowrap rounded-[8px] px-2.5 py-1.5 text-[10px] leading-relaxed"
                    style={{ background: 'rgba(0,0,0,0.85)', color: 'var(--text-primary)', border: '1px solid rgba(255,255,255,0.12)', backdropFilter: 'blur(12px)' }}>
                    {node.inputSlots.map(s => `${s.name} (${s.dataType})${s.required ? ' *' : ''}`).join('\n')}
                  </span>
                </span>
              )}
              {node.outputSlots.length > 0 && (
                <span
                  className="relative group px-1 py-0.5 rounded text-[9px] font-mono cursor-default"
                  style={{ background: 'rgba(34,197,94,0.08)', color: 'rgba(34,197,94,0.8)', border: '1px solid rgba(34,197,94,0.12)' }}
                >
                  → {node.outputSlots.length}
                  <span className="absolute left-0 top-full mt-1 z-50 hidden group-hover:block whitespace-nowrap rounded-[8px] px-2.5 py-1.5 text-[10px] leading-relaxed"
                    style={{ background: 'rgba(0,0,0,0.85)', color: 'var(--text-primary)', border: '1px solid rgba(255,255,255,0.12)', backdropFilter: 'blur(12px)' }}>
                    {node.outputSlots.map(s => `${s.name} (${s.dataType})`).join('\n')}
                  </span>
                </span>
              )}
            </div>
          </div>

          {/* 状态 */}
          <StepStatusBadge status={status} durationMs={nodeExec?.durationMs} />

          {/* 展开/折叠 */}
          {isExpanded
            ? <ChevronDown className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
            : <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
          }
        </div>

        {/* 执行中进度条 */}
        {status === 'running' && (
          <div className="mt-2 flex items-center gap-2 ml-[68px]">
            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
              <div
                className="h-full rounded-full animate-pulse"
                style={{ width: '60%', background: 'var(--gold-gradient, linear-gradient(90deg, rgba(99,102,241,0.6), rgba(99,102,241,0.3)))' }}
              />
            </div>
            <span className="text-[10px]" style={{ color: 'var(--accent-gold)' }}>处理中...</span>
          </div>
        )}

        {/* ════════ 展开区域：输入 → 配置 → 输出 ════════ */}
        {isExpanded && (
          <div className="mt-4 ml-[68px] space-y-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 16 }}>

            {/* 格式兼容性警告 */}
            {formatWarnings && formatWarnings.length > 0 && (
              <div>
                {formatWarnings.map((w, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-1.5 text-[10px] px-3 py-1.5 rounded-[8px] mb-1"
                    style={{
                      background: 'rgba(245,158,11,0.08)',
                      color: 'rgba(245,158,11,0.9)',
                      border: '1px solid rgba(245,158,11,0.15)',
                    }}
                  >
                    ⚠ {w.message}
                  </div>
                ))}
              </div>
            )}

            {/* ──── 📥 输入区 ──── */}
            {hasAnyInputSlot && capsuleMeta?.testable && (
              <SectionBox title="📥 输入" type="input">
                <div className="space-y-2">
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {isHttpType
                      ? '上游数据 — JSON 对象，键名对应 URL/Headers/Body 中的 {{变量}} 占位符'
                      : hasRequiredInput ? '此舱需要输入数据才能测试' : '测试输入（可选，空则使用模拟数据）'}
                  </div>
                  <textarea
                    value={testInput}
                    onChange={(e) => setTestInput(e.target.value)}
                    placeholder={isHttpType
                      ? '{"userId": "123", "token": "xxx"}'
                      : hasRequiredInput
                        ? '粘贴 JSON 数据或上传文件内容…'
                        : '空则使用默认模拟数据'}
                    rows={2}
                    className="prd-field w-full px-3 py-2 rounded-[8px] text-[11px] outline-none resize-y font-mono"
                  />
                  <div className="flex items-center gap-2">
                    <label
                      className="text-[10px] px-2 py-0.5 rounded-[6px] cursor-pointer transition-colors"
                      style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-secondary)', border: '1px solid rgba(255,255,255,0.08)' }}
                    >
                      📎 上传
                      <input
                        type="file"
                        className="hidden"
                        accept=".json,.csv,.txt,.xml"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          const reader = new FileReader();
                          reader.onload = () => setTestInput(reader.result as string);
                          reader.readAsText(file);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    <button
                      className="text-[10px] px-2 py-0.5 rounded-[6px] transition-colors"
                      style={{ color: 'var(--text-muted)' }}
                      onClick={() => {
                        try { setTestInput(JSON.stringify(JSON.parse(testInput), null, 2)); } catch { /* not json */ }
                      }}
                    >
                      格式化
                    </button>
                  </div>
                </div>
              </SectionBox>
            )}

            {/* ──── ⚙ 配置区 ──── */}
            {(isHttpType || (capsuleMeta && capsuleMeta.configSchema.length > 0)) && (
              <SectionBox title="⚙ 配置" type="config">
                {isHttpType ? (
                  <HttpConfigPanel
                    values={configValues}
                    onBatchChange={handleConfigBatchChange}
                    disabled={isRunning}
                  />
                ) : (
                  <CapsuleConfigForm
                    fields={capsuleMeta!.configSchema}
                    values={configValues}
                    onChange={handleConfigFieldChange}
                    onBatchChange={handleConfigBatchChange}
                    disabled={isRunning}
                    nodeType={node.nodeType}
                  />
                )}
              </SectionBox>
            )}

            {/* ──── 操作栏 ──── */}
            <div className="flex items-center gap-2">
              {capsuleMeta?.testable && (
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTestRun(testInput || undefined);
                  }}
                  disabled={isRunning || isTestRunning || (hasRequiredInput && !testInput.trim())}
                >
                  {isTestRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <FlaskConical className="w-3 h-3" />}
                  {isTestRunning ? '执行中...' : '▶ 单舱测试'}
                </Button>
              )}
              <Button
                size="xs"
                variant="danger"
                onClick={(e) => { e.stopPropagation(); onRemove(); }}
                disabled={isRunning}
              >
                <Trash2 className="w-3 h-3" />
                移除
              </Button>
            </div>

            {/* ──── 📤 输出 / 结果 ──── */}
            {unifiedResult && (
              <SectionBox title="📤 输出" type="output">
                <UnifiedResultPanel
                  result={unifiedResult}
                  source={resultSource!}
                  expandedArtifacts={expandedArtifacts}
                  toggleArtifact={toggleArtifact}
                  onPreviewArtifact={onPreviewArtifact}
                />
              </SectionBox>
            )}
          </div>
        )}
      </GlassCard>
    </div>
  );
}

// ──── 统一结果面板（测试结果 + 执行结果 合并为单窗口） ────

function UnifiedResultPanel({ result, source, expandedArtifacts, toggleArtifact, onPreviewArtifact }: {
  result: {
    status: string;
    durationMs?: number;
    logs?: string;
    artifacts?: { name: string; mimeType: string; sizeBytes: number; inlineContent?: string; cosUrl?: string; artifactId?: string }[];
    errorMessage?: string;
  };
  source: 'test' | 'exec';
  expandedArtifacts: Set<string>;
  toggleArtifact: (id: string) => void;
  onPreviewArtifact?: (art: ExecutionArtifact) => void;
}) {
  const isOk = result.status === 'completed';
  const label = source === 'test' ? '单舱测试结果' : '执行结果';
  const artifacts = result.artifacts || [];

  return (
    <div
      className="rounded-[10px] overflow-hidden"
      style={{
        border: `1px solid ${isOk ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'}`,
        background: isOk ? 'rgba(34,197,94,0.03)' : 'rgba(239,68,68,0.03)',
      }}
    >
      {/* 结果头部 */}
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{
          background: isOk ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <span className="text-[12px]">{isOk ? '✅' : '❌'}</span>
        <span className="text-[11px] font-semibold flex-1" style={{ color: isOk ? 'rgba(34,197,94,0.9)' : 'rgba(239,68,68,0.9)' }}>
          {label}
        </span>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {isOk ? `完成` : '失败'}
          {result.durationMs ? ` · ${result.durationMs}ms` : ''}
        </span>
      </div>

      <div className="p-3 space-y-2">
        {/* 错误信息 */}
        {result.errorMessage && (
          <div
            className="text-[11px] rounded-[8px] px-3 py-2 leading-relaxed"
            style={{ background: 'rgba(239,68,68,0.08)', color: 'rgba(239,68,68,0.9)', border: '1px solid rgba(239,68,68,0.15)' }}
          >
            {result.errorMessage}
          </div>
        )}

        {/* 执行日志 */}
        {result.logs && (
          <div>
            <div className="text-[10px] mb-1 font-medium" style={{ color: 'var(--text-muted)' }}>日志</div>
            <pre
              className="text-[10px] rounded-[8px] p-2.5 max-h-28 overflow-auto whitespace-pre-wrap font-mono leading-relaxed"
              style={{ background: 'rgba(0,0,0,0.25)', color: 'var(--text-secondary)', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              {result.logs.slice(0, 800)}
              {result.logs.length > 800 ? '\n...(更多日志请查看完整详情)' : ''}
            </pre>
          </div>
        )}

        {/* 产物列表 */}
        {artifacts.length > 0 && (
          <div>
            <div className="text-[10px] mb-1 font-medium" style={{ color: 'var(--text-muted)' }}>
              产物 ({artifacts.length})
            </div>
            <div className="space-y-1.5">
              {artifacts.map((art, idx) => {
                const artKey = art.artifactId || `art-${idx}`;
                const isExpanded = expandedArtifacts.has(artKey);
                return (
                  <div
                    key={artKey}
                    className="rounded-[8px] overflow-hidden"
                    style={{
                      background: 'var(--nested-block-bg, rgba(255,255,255,0.03))',
                      border: '1px solid var(--nested-block-border, rgba(255,255,255,0.08))',
                    }}
                  >
                    <div
                      className={`flex items-center gap-2 px-3 py-2 ${art.inlineContent ? 'cursor-pointer' : ''}`}
                      onClick={art.inlineContent ? () => toggleArtifact(artKey) : undefined}
                    >
                      <FileText className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                      <span className="text-[12px] font-medium flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
                        {art.name}
                      </span>
                      <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                        {formatBytes(art.sizeBytes)}
                      </span>
                      <ArtifactActionButtons artifact={art} onPreview={onPreviewArtifact} />
                      {art.inlineContent && (
                        isExpanded
                          ? <ChevronDown className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                          : <ChevronRight className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                      )}
                    </div>
                    {isExpanded && art.inlineContent && (
                      <div className="px-3 pb-2.5" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                        <pre
                          className="text-[11px] rounded-[8px] p-2.5 mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono leading-relaxed"
                          style={{ background: 'rgba(0,0,0,0.25)', color: 'var(--text-secondary)', border: '1px solid rgba(255,255,255,0.06)' }}
                        >
                          {art.inlineContent}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ──── 格式兼容性检查 ────

/** DataType 兼容矩阵：输出 → 输入 是否可直连 */
const FORMAT_COMPAT: Record<string, string[]> = {
  json: ['json', 'text'],
  text: ['text', 'json'],   // text 可以被 json 输入尝试解析
  image: ['image', 'binary'],
  binary: ['binary'],
};

function checkSlotCompatibility(
  nodes: import('@/services/contracts/workflowAgent').WorkflowNode[],
  edges: import('@/services/contracts/workflowAgent').WorkflowEdge[],
): { nodeId: string; message: string }[] {
  const warnings: { nodeId: string; message: string }[] = [];

  for (const edge of edges) {
    const srcNode = nodes.find(n => n.nodeId === edge.sourceNodeId);
    const tgtNode = nodes.find(n => n.nodeId === edge.targetNodeId);
    if (!srcNode || !tgtNode) continue;

    // 找到对应的输出/输入插槽
    const srcSlot = srcNode.outputSlots.find(s => s.slotId === edge.sourceSlotId)
      ?? srcNode.outputSlots[0]; // fallback 到第一个
    const tgtSlot = tgtNode.inputSlots.find(s => s.slotId === edge.targetSlotId)
      ?? tgtNode.inputSlots[0];

    if (!srcSlot || !tgtSlot) continue;

    const srcType = srcSlot.dataType || 'text';
    const tgtType = tgtSlot.dataType || 'text';
    const compatibles = FORMAT_COMPAT[srcType] || [srcType];

    if (!compatibles.includes(tgtType)) {
      warnings.push({
        nodeId: tgtNode.nodeId,
        message: `输入格式不匹配：上游「${srcNode.name}」输出 ${srcType}，但此舱期望 ${tgtType}`,
      });
    }
  }

  return warnings;
}

// ═══════════════════════════════════════════════════════════════
// 主页面
// ═══════════════════════════════════════════════════════════════

interface NodeOutput {
  logs: string;
  artifacts: ExecutionArtifact[];
}

export function WorkflowEditorPage() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const navigate = useNavigate();

  // 数据
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [latestExec, setLatestExec] = useState<WorkflowExecution | null>(null);
  const [nodeOutputs, setNodeOutputs] = useState<Record<string, NodeOutput>>({});

  // 舱类型
  const [capsuleTypes, setCapsuleTypes] = useState<CapsuleTypeMeta[]>([]);
  const [categories, setCategories] = useState<CapsuleCategoryInfo[]>([]);

  // UI
  const [pageLoading, setPageLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);

  // 标题编辑
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  // 变量
  const [vars, setVars] = useState<Record<string, string>>({});

  // 右侧面板模式: 'chat' | 'log'
  const [rightPanel, setRightPanel] = useState<'chat' | 'log' | null>(null);

  // 实时日志
  interface LogEntry {
    id: string;
    ts: string;
    level: 'info' | 'success' | 'error' | 'warn';
    nodeId?: string;
    nodeName?: string;
    message: string;
  }
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const logIdRef = useRef(0);

  // 产物预览弹窗
  const [previewArtifact, setPreviewArtifact] = useState<ExecutionArtifact | null>(null);
  // 记录上次轮询已知的节点状态，用于生成增量日志
  const prevNodeStatusRef = useRef<Record<string, string>>({});

  function addLog(level: LogEntry['level'], message: string, opts?: { nodeId?: string; nodeName?: string }) {
    setLogEntries(prev => [...prev, {
      id: `log-${logIdRef.current++}`,
      ts: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      level,
      message,
      ...opts,
    }]);
  }

  // 轮询
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetchedNodesRef = useRef(new Set<string>());

  // ── 初始化 ──

  useEffect(() => {
    if (workflowId) init(workflowId);
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId]);

  useEffect(() => {
    listCapsuleTypes().then((res) => {
      if (res.success && res.data) {
        setCapsuleTypes(res.data.items);
        setCategories(res.data.categories);
      }
    });
  }, []);

  async function init(id: string) {
    setPageLoading(true);
    try {
      const wfRes = await getWorkflow(id);
      if (wfRes.success && wfRes.data) {
        const wf = wfRes.data.workflow;
        setWorkflow(wf);

        // 初始化变量默认值
        const defaultVars: Record<string, string> = {};
        for (const v of wf.variables) {
          defaultVars[v.key] = v.defaultValue || '';
        }
        // 特殊处理：月份默认当前月
        if (wf.variables.some(v => v.key === 'TARGET_MONTH') && !defaultVars['TARGET_MONTH']) {
          defaultVars['TARGET_MONTH'] = getDefaultMonth();
        }
        setVars(defaultVars);

        // 加载最近执行
        const execRes = await listExecutions({ workflowId: id, pageSize: 1 });
        if (execRes.success && execRes.data?.items?.length) {
          const latest = execRes.data.items[0];
          setLatestExec(latest);
          if (['queued', 'running'].includes(latest.status)) {
            startPolling(latest.id);
          } else {
            fetchAllNodeOutputs(latest);
          }
        }
      }
    } catch { /* ignore */ }
    setPageLoading(false);
  }

  // ── 轮询 ──

  function startPolling(execId: string) {
    stopPolling();
    pollingRef.current = setInterval(async () => {
      try {
        const res = await getExecution(execId);
        if (res.success && res.data) {
          const exec = res.data.execution;
          setLatestExec(exec);

          // 生成增量日志
          for (const ne of exec.nodeExecutions) {
            const prev = prevNodeStatusRef.current[ne.nodeId];
            if (ne.status !== prev) {
              prevNodeStatusRef.current[ne.nodeId] = ne.status;
              if (ne.status === 'running' && prev !== 'running') {
                addLog('info', '开始执行', { nodeId: ne.nodeId, nodeName: ne.nodeName });
              } else if (ne.status === 'completed' && prev !== 'completed') {
                addLog('success', `完成${ne.durationMs ? ` (${(ne.durationMs / 1000).toFixed(1)}s)` : ''}`, { nodeId: ne.nodeId, nodeName: ne.nodeName });
              } else if (ne.status === 'failed') {
                addLog('error', `失败: ${ne.errorMessage || '未知错误'}`, { nodeId: ne.nodeId, nodeName: ne.nodeName });
              } else if (ne.status === 'skipped') {
                addLog('warn', '已跳过', { nodeId: ne.nodeId, nodeName: ne.nodeName });
              }
            }

            if (['completed', 'failed'].includes(ne.status) && !fetchedNodesRef.current.has(ne.nodeId)) {
              fetchedNodesRef.current.add(ne.nodeId);
              fetchNodeOutput(exec.id, ne.nodeId);
            }
          }

          if (['completed', 'failed', 'cancelled'].includes(exec.status)) {
            if (exec.status === 'completed') {
              addLog('success', `工作流执行完成${exec.completedAt && exec.startedAt ? ` · 总耗时 ${((new Date(exec.completedAt).getTime() - new Date(exec.startedAt).getTime()) / 1000).toFixed(1)}s` : ''}`);
            } else if (exec.status === 'failed') {
              addLog('error', `工作流执行失败: ${exec.errorMessage || '未知错误'}`);
            } else {
              addLog('warn', '工作流已取消');
            }
            stopPolling();
          }
        }
      } catch { /* ignore */ }
    }, 2500);
  }

  function stopPolling() {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }

  async function fetchNodeOutput(execId: string, nodeId: string) {
    try {
      const res = await getNodeLogs({ executionId: execId, nodeId });
      if (res.success && res.data) {
        const logs = res.data!.logs || '';
        const artifacts = res.data!.artifacts || [];
        setNodeOutputs((prev) => ({
          ...prev,
          [nodeId]: { logs, artifacts },
        }));
        // 将后端详细日志注入到右侧日志面板
        injectBackendLogs(nodeId, logs, artifacts);
      }
    } catch { /* ignore */ }
  }

  /** 将后端舱执行详细日志注入到右侧日志面板 */
  function injectBackendLogs(nodeId: string, logs: string, artifacts: ExecutionArtifact[]) {
    if (!logs && artifacts.length === 0) return;
    const nodeName = workflow?.nodes.find(n => n.nodeId === nodeId)?.name
      || latestExec?.nodeExecutions.find(n => n.nodeId === nodeId)?.nodeName
      || nodeId;
    // 解析后端日志中的关键信息
    if (logs) {
      const lines = logs.split('\n').filter(l => l.trim());
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('[') && trimmed.endsWith(']')) continue;
        // 关键信息行
        if (trimmed.startsWith('Model:') || trimmed.startsWith('Tokens:') ||
            trimmed.startsWith('InputArtifacts:') || trimmed.startsWith('InputText:') ||
            trimmed.startsWith('Response:') || trimmed.startsWith('Output:') ||
            trimmed.startsWith('Content:') || trimmed.startsWith('FileName:') ||
            trimmed.startsWith('Format:') || trimmed.startsWith('Preview:') ||
            trimmed.startsWith('ResolutionType:') || trimmed.startsWith('AppCallerCode:') ||
            trimmed.includes('⚠️')) {
          const level = trimmed.includes('⚠️') ? 'warn' as const : 'info' as const;
          addLog(level, trimmed, { nodeId, nodeName });
        }
      }
    }
    // 产物摘要
    if (artifacts.length > 0) {
      const summary = artifacts.map(a => `${a.name} (${formatBytes(a.sizeBytes)})`).join(', ');
      addLog('info', `产物: ${summary}`, { nodeId, nodeName });
    }
  }

  function fetchAllNodeOutputs(exec: WorkflowExecution) {
    for (const ne of exec.nodeExecutions) {
      if (['completed', 'failed'].includes(ne.status)) {
        fetchedNodesRef.current.add(ne.nodeId);
        fetchNodeOutput(exec.id, ne.nodeId);
      }
    }
  }

  // ── 保存 ──

  async function handleSave() {
    if (!workflow) return;
    setSaving(true);
    try {
      const res = await updateWorkflow({
        id: workflow.id,
        name: workflow.name,
        nodes: workflow.nodes,
        edges: workflow.edges,
        variables: workflow.variables,
      });
      if (res.success && res.data) {
        setWorkflow(res.data.workflow);
        setDirty(false);
      }
    } catch { /* ignore */ }
    setSaving(false);
  }

  // ── 添加舱 ──

  function handleAddCapsule(typeKey: string) {
    if (!workflow) return;
    const meta = capsuleTypes.find(t => t.typeKey === typeKey);
    if (!meta) return;

    const nodeId = `n-${Date.now()}`;
    const newNode: WorkflowNode = {
      nodeId,
      name: meta.name,
      nodeType: meta.typeKey,
      config: {},
      inputSlots: meta.defaultInputSlots || [],
      outputSlots: meta.defaultOutputSlots || [],
    };

    setWorkflow((prev) => prev ? {
      ...prev,
      nodes: [...prev.nodes, newNode],
    } : prev);
    setDirty(true);
    setExpandedNodeId(nodeId);
  }

  // ── 舱配置变更 ──

  function handleNodeConfigChange(nodeId: string, config: Record<string, unknown>) {
    setWorkflow((prev) => prev ? {
      ...prev,
      nodes: prev.nodes.map(n => n.nodeId === nodeId ? { ...n, config } : n),
    } : prev);
    setDirty(true);
  }

  // ── 移除舱 ──

  function handleRemoveNode(nodeId: string) {
    if (!workflow) return;
    setWorkflow((prev) => prev ? {
      ...prev,
      nodes: prev.nodes.filter(n => n.nodeId !== nodeId),
      edges: prev.edges.filter(e => e.sourceNodeId !== nodeId && e.targetNodeId !== nodeId),
    } : prev);
    setDirty(true);
    if (expandedNodeId === nodeId) setExpandedNodeId(null);
  }

  // ── 执行 ──

  async function handleExecute() {
    if (!workflow) return;

    // 验证必填变量
    for (const v of workflow.variables) {
      if (v.required && !vars[v.key]) {
        alert(`请填写「${v.label}」`);
        return;
      }
    }

    // 先保存
    if (dirty) await handleSave();

    setIsExecuting(true);
    setNodeOutputs({});
    fetchedNodesRef.current.clear();
    prevNodeStatusRef.current = {};
    setLogEntries([]);
    addLog('info', '提交执行请求...');
    setRightPanel('log');  // 自动打开日志面板

    try {
      const res = await executeWorkflow({ id: workflow.id, variables: vars });
      if (res.success && res.data) {
        const exec = res.data.execution;
        setLatestExec(exec);
        addLog('info', `工作流已入队，共 ${exec.nodeExecutions.length} 个节点`);
        startPolling(exec.id);
      } else {
        alert('执行失败: ' + (res.error?.message || '未知错误'));
      }
    } catch (e: unknown) {
      alert('执行出错: ' + (e instanceof Error ? e.message : '未知错误'));
    }
    setIsExecuting(false);
  }

  async function handleCancel() {
    if (!latestExec || !confirm('确定取消当前执行？')) return;
    await cancelExecution(latestExec.id);
    stopPolling();
    try {
      const res = await getExecution(latestExec.id);
      if (res.success && res.data) setLatestExec(res.data.execution);
    } catch { /* ignore */ }
  }

  // ── 单舱测试 ──

  const [testRunResult, setTestRunResult] = useState<{ nodeId: string; result: import('@/services/contracts/workflowAgent').CapsuleTestRunResult } | null>(null);
  const [testRunning, setTestRunning] = useState<string | null>(null);

  async function handleTestRun(nodeId: string, testInput?: string) {
    const node = workflow?.nodes.find(n => n.nodeId === nodeId);
    if (!node) return;

    // 构造 mockInput：优先使用用户提供的测试输入
    let mockInput: unknown = { _test: true };
    if (testInput?.trim()) {
      try {
        mockInput = JSON.parse(testInput);
      } catch {
        // 非 JSON 输入作为纯文本传递
        mockInput = testInput;
      }
    }

    setTestRunning(nodeId);
    setTestRunResult(null);
    try {
      const res = await testRunCapsule({
        typeKey: node.nodeType,
        config: node.config as Record<string, unknown>,
        mockInput,
      });
      if (res.success && res.data?.result) {
        setTestRunResult({ nodeId, result: res.data.result });
      } else {
        setTestRunResult({
          nodeId,
          result: {
            typeKey: node.nodeType, typeName: node.name,
            status: 'failed', startedAt: '', completedAt: '', durationMs: 0,
            errorMessage: res.error?.message || '未知错误',
          },
        });
      }
    } catch (e: unknown) {
      setTestRunResult({
        nodeId,
        result: {
          typeKey: node.nodeType, typeName: node.name,
          status: 'failed', startedAt: '', completedAt: '', durationMs: 0,
          errorMessage: e instanceof Error ? e.message : '请求失败',
        },
      });
    } finally {
      setTestRunning(null);
    }
  }

  // ── AI 聊天面板回调 ──

  function handleApplyWorkflow(generated: WorkflowChatGenerated, newWorkflowId?: string) {
    if (newWorkflowId && newWorkflowId !== workflowId) {
      // 新建的工作流 — 跳转到对应的编辑页
      navigate(`/workflow-agent/${newWorkflowId}`);
      return;
    }
    // 修改现有工作流 — 更新节点/边/变量
    setWorkflow((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        name: generated.name ?? prev.name,
        description: generated.description ?? prev.description,
        nodes: generated.nodes ?? prev.nodes,
        edges: generated.edges ?? prev.edges,
        variables: generated.variables ?? prev.variables,
      };
    });
    setDirty(true);
  }

  // ── UI helpers ──

  const isRunning = !!(latestExec && ['queued', 'running'].includes(latestExec.status));
  const completedCount = latestExec?.nodeExecutions.filter(ne => ne.status === 'completed').length || 0;
  const totalNodes = workflow?.nodes.length || 0;
  const execStatusInfo = latestExec ? EXEC_STATUS_MAP[latestExec.status] : null;

  // ═══ 渲染 ═══

  if (pageLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-muted)' }} />
        <span className="ml-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>加载工作流...</span>
      </div>
    );
  }

  if (!workflow) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4">
        <AlertCircle className="w-8 h-8" style={{ color: 'rgba(239,68,68,0.6)' }} />
        <span className="text-[13px]" style={{ color: 'var(--text-muted)' }}>工作流不存在</span>
        <Button variant="secondary" size="sm" onClick={() => navigate('/workflow-agent')}>
          <ArrowLeft className="w-4 h-4" /> 返回列表
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* 顶部工具栏 */}
      <TabBar
        title={
          editingTitle ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => {
                const name = titleDraft.trim();
                if (name && name !== workflow.name) {
                  setWorkflow(prev => prev ? { ...prev, name } : prev);
                  setDirty(true);
                }
                setEditingTitle(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') { setEditingTitle(false); }
              }}
              className="text-[14px] font-semibold bg-transparent outline-none px-1 rounded-[6px]"
              style={{ color: 'var(--text-primary)', border: '1px solid rgba(99,102,241,0.3)', minWidth: 120 }}
            />
          ) : (
            <span
              onDoubleClick={() => { setEditingTitle(true); setTitleDraft(workflow.name || ''); }}
              className="cursor-text"
              title="双击编辑名称"
            >
              {workflow.name || '未命名工作流'}
            </span>
          )
        }
        icon={<Zap size={16} />}
        actions={
          <div className="flex items-center gap-2">
            {isRunning ? (
              <>
                <Badge variant="featured" size="sm" icon={<Loader2 className="w-3 h-3 animate-spin" />}>
                  执行中 {completedCount}/{totalNodes}
                </Badge>
                <Button variant="danger" size="xs" onClick={handleCancel}>
                  <XCircle className="w-3.5 h-3.5" />
                  取消
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                size="xs"
                onClick={handleExecute}
                disabled={isExecuting || workflow.nodes.length === 0}
              >
                {isExecuting
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />提交中...</>
                  : <><Play className="w-3.5 h-3.5" />{latestExec ? '重新执行' : '执行'}</>
                }
              </Button>
            )}
            <Button
              variant={dirty ? 'primary' : 'secondary'}
              size="xs"
              onClick={handleSave}
              disabled={saving || !dirty}
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {dirty ? '保存*' : '已保存'}
            </Button>
            <Button
              variant={rightPanel === 'log' ? 'primary' : 'secondary'}
              size="xs"
              onClick={() => setRightPanel(p => p === 'log' ? null : 'log')}
            >
              <Terminal className="w-3.5 h-3.5" />
              日志{logEntries.length > 0 ? ` (${logEntries.length})` : ''}
            </Button>
            <Button
              variant={rightPanel === 'chat' ? 'primary' : 'secondary'}
              size="xs"
              onClick={() => setRightPanel(p => p === 'chat' ? null : 'chat')}
            >
              <Wand2 className="w-3.5 h-3.5" />
              AI 助手
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => navigate('/workflow-agent')}
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              返回
            </Button>
          </div>
        }
      />

      {/* 主内容区：左侧面板 + 右侧列表 */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* 左侧：舱目录 */}
        <div
          className="w-56 flex-shrink-0 overflow-y-auto border-r"
          style={{
            background: 'rgba(0,0,0,0.15)',
            borderColor: 'rgba(255,255,255,0.08)',
          }}
        >
          <CapsuleSidebar
            capsuleTypes={capsuleTypes}
            categories={categories}
            onAddCapsule={handleAddCapsule}
          />
        </div>

        {/* 中间：已添加的舱列表 + 变量配置 */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-5 py-4 space-y-4 max-w-3xl">
            {/* 变量配置区 (折叠) */}
            {workflow.variables.length > 0 && (
              <VariablesSection
                variables={workflow.variables}
                values={vars}
                onChange={(key, val) => setVars(prev => ({ ...prev, [key]: val }))}
                disabled={isRunning}
              />
            )}

            {/* 执行状态摘要 */}
            {latestExec && execStatusInfo && (
              <div className="flex items-center gap-2">
                <Badge variant={execStatusInfo.variant} size="sm">{execStatusInfo.label}</Badge>
                {latestExec.completedAt && latestExec.startedAt && (
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    耗时 {((new Date(latestExec.completedAt).getTime() - new Date(latestExec.startedAt).getTime()) / 1000).toFixed(1)}s
                  </span>
                )}
              </div>
            )}

            {/* 舱列表 */}
            {workflow.nodes.length === 0 ? (
              <GlassCard animated>
                <div className="flex flex-col items-center py-8 gap-3">
                  <span className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
                    从左侧目录选择舱添加到工作流
                  </span>
                </div>
              </GlassCard>
            ) : (
              <div className="space-y-2">
                {(() => {
                  const slotWarnings = checkSlotCompatibility(workflow.nodes, workflow.edges);
                  return workflow.nodes.map((node, idx) => {
                    const warnings = slotWarnings.filter(w => w.nodeId === node.nodeId);
                    return (
                      <CapsuleCard
                        key={node.nodeId}
                        node={node}
                        index={idx}
                        nodeExec={latestExec?.nodeExecutions.find(ne => ne.nodeId === node.nodeId)}
                        nodeOutput={nodeOutputs[node.nodeId]}
                        isExpanded={expandedNodeId === node.nodeId}
                        onToggle={() => setExpandedNodeId(expandedNodeId === node.nodeId ? null : node.nodeId)}
                        onRemove={() => handleRemoveNode(node.nodeId)}
                        onTestRun={(testInput) => handleTestRun(node.nodeId, testInput)}
                        onConfigChange={handleNodeConfigChange}
                        capsuleMeta={capsuleTypes.find(ct => ct.typeKey === node.nodeType)}
                        isRunning={isRunning}
                        testRunResult={testRunResult?.nodeId === node.nodeId ? testRunResult.result : null}
                        isTestRunning={testRunning === node.nodeId}
                        formatWarnings={warnings}
                        onPreviewArtifact={setPreviewArtifact}
                      />
                    );
                  });
                })()}
              </div>
            )}

            {/* 最终产物 */}
            {latestExec && ['completed', 'failed', 'cancelled'].includes(latestExec.status) && latestExec.finalArtifacts.length > 0 && (
              <GlassCard animated accentHue={latestExec.status === 'completed' ? 150 : 0} glow={latestExec.status === 'completed'}>
                <div className="flex items-center gap-2 mb-3">
                  {latestExec.status === 'completed'
                    ? <CheckCircle2 className="w-5 h-5" style={{ color: 'rgba(34,197,94,0.9)' }} />
                    : <AlertCircle className="w-5 h-5" style={{ color: 'rgba(239,68,68,0.9)' }} />
                  }
                  <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    最终产物
                  </span>
                </div>
                <div className="space-y-1.5">
                  {latestExec.finalArtifacts.map((art) => (
                    <div
                      key={art.artifactId}
                      className="flex items-center gap-2 px-3 py-2 rounded-[10px]"
                      style={{
                        background: 'var(--nested-block-bg, rgba(255,255,255,0.03))',
                        border: '1px solid var(--nested-block-border, rgba(255,255,255,0.08))',
                      }}
                    >
                      <FileText className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                      <span className="text-[12px] font-medium flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
                        {art.name}
                      </span>
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {formatBytes(art.sizeBytes)}
                      </span>
                      <ArtifactActionButtons artifact={art} onPreview={setPreviewArtifact} size="md" />
                    </div>
                  ))}
                </div>
              </GlassCard>
            )}
          </div>
        </div>

        {/* 右侧面板：日志 or AI 聊天 */}
        {rightPanel === 'log' && (
          <ExecutionLogPanel
            entries={logEntries}
            onClear={() => setLogEntries([])}
            onClose={() => setRightPanel(null)}
          />
        )}
        {rightPanel === 'chat' && (
          <WorkflowChatPanel
            workflowId={workflowId}
            onApplyWorkflow={handleApplyWorkflow}
            onClose={() => setRightPanel(null)}
          />
        )}
      </div>

      {/* 产物预览弹窗 */}
      {previewArtifact && (
        <ArtifactPreviewModal
          artifact={previewArtifact}
          onClose={() => setPreviewArtifact(null)}
        />
      )}
    </div>
  );
}

// ──── 执行日志面板 ────

const LOG_LEVEL_COLORS: Record<string, string> = {
  info: 'rgba(99,102,241,0.9)',
  success: 'rgba(34,197,94,0.9)',
  error: 'rgba(239,68,68,0.9)',
  warn: 'rgba(234,179,8,0.9)',
};

function ExecutionLogPanel({ entries, onClear, onClose }: {
  entries: { id: string; ts: string; level: string; nodeId?: string; nodeName?: string; message: string }[];
  onClear: () => void;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  function handleScroll() {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  }

  return (
    <div
      className="flex flex-col h-full"
      style={{
        width: 340,
        flexShrink: 0,
        borderLeft: '1px solid rgba(255,255,255,0.08)',
        background: 'rgba(0,0,0,0.2)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2.5 flex-shrink-0"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <Terminal className="w-3.5 h-3.5" style={{ color: 'rgba(99,102,241,0.8)' }} />
        <span className="text-[12px] font-semibold flex-1" style={{ color: 'var(--text-primary)' }}>
          执行日志
        </span>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {entries.length} 条
        </span>
        {entries.length > 0 && (
          <button
            onClick={onClear}
            className="p-1 rounded-[6px] transition-colors"
            style={{ color: 'var(--text-muted)' }}
            title="清空日志"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
        <button
          onClick={onClose}
          className="p-1 rounded-[6px] transition-colors"
          style={{ color: 'var(--text-muted)' }}
          title="关闭"
        >
          <XCircle className="w-3 h-3" />
        </button>
      </div>

      {/* Log entries */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5"
        onScroll={handleScroll}
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' }}
      >
        {entries.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 opacity-40">
            <Terminal className="w-6 h-6" />
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              执行工作流后日志将在此显示
            </span>
          </div>
        )}

        {entries.map((entry) => (
          <div
            key={entry.id}
            className="flex items-start gap-1.5 px-2 py-1 rounded-[6px] transition-colors"
            style={{ background: entry.level === 'error' ? 'rgba(239,68,68,0.04)' : 'transparent' }}
          >
            {/* Level dot */}
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0 mt-[5px]"
              style={{ background: LOG_LEVEL_COLORS[entry.level] || LOG_LEVEL_COLORS.info }}
            />
            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                  {entry.ts}
                </span>
                {entry.nodeName && (
                  <span
                    className="text-[9px] px-1.5 py-0 rounded-[4px] font-medium"
                    style={{
                      background: 'rgba(99,102,241,0.1)',
                      color: 'rgba(99,102,241,0.8)',
                      border: '1px solid rgba(99,102,241,0.15)',
                    }}
                  >
                    {entry.nodeName}
                  </span>
                )}
              </div>
              <div className="text-[10px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                {entry.message}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ──── 变量配置折叠区 ────

function VariablesSection({ variables, values, onChange, disabled }: {
  variables: { key: string; label: string; type: string; required: boolean; isSecret: boolean }[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  disabled: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <GlassCard animated>
      <div
        className="flex items-center gap-2 cursor-pointer select-none"
        onClick={() => setCollapsed(!collapsed)}
      >
        <Settings2 className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
        <span className="text-[13px] font-semibold flex-1" style={{ color: 'var(--text-primary)' }}>
          执行变量
        </span>
        {collapsed
          ? <ChevronRight className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
          : <ChevronDown className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
        }
      </div>
      {!collapsed && (
        <div className="mt-3 space-y-3">
          {variables.map((v) => (
            <div key={v.key}>
              <label className="flex items-center text-[11px] mb-1" style={{ color: 'var(--text-secondary)' }}>
                {v.label}
              </label>
              <input
                type={v.isSecret ? 'password' : v.type === 'month' ? 'month' : 'text'}
                value={values[v.key] || ''}
                onChange={(e) => onChange(v.key, e.target.value)}
                disabled={disabled}
                className="prd-field w-full h-[32px] px-3 rounded-[8px] text-[12px] outline-none disabled:opacity-50 transition-all"
              />
            </div>
          ))}
        </div>
      )}
    </GlassCard>
  );
}
