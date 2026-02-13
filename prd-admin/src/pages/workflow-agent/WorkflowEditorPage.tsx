import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Play, Loader2, CheckCircle2, AlertCircle,
  Download, FileText, ArrowLeft, Save, Plus,
  ChevronDown, ChevronRight, Settings2, XCircle,
  Zap, FlaskConical, Trash2,
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
import { parseCurl, toCurl, headersToJson, prettyBody } from './parseCurl';

// ═══════════════════════════════════════════════════════════════
// 工作流直接编辑页
//
// 布局：
//   ┌────────────────────────────────────────────────┐
//   │ TabBar (工作流名称 + 操作按钮)                 │
//   ├──────────┬─────────────────────────────────────┤
//   │ 左侧     │ 右侧                               │
//   │ 舱目录   │ 已添加的舱列表 (从上至下)           │
//   │ (可选择  │ 点击展开配置/调试/结果面板          │
//   │  添加)   │                                     │
//   └──────────┴─────────────────────────────────────┘
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
                return (
                  <button
                    key={meta.typeKey}
                    onClick={() => onAddCapsule(meta.typeKey)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[8px] transition-colors text-left"
                    style={{
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.06)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(255,255,255,0.07)';
                      e.currentTarget.style.borderColor = `hsla(${meta.accentHue}, 60%, 55%, 0.2)`;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
                      e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)';
                    }}
                    title={meta.description}
                  >
                    <div
                      className="w-6 h-6 rounded-[6px] flex items-center justify-center flex-shrink-0"
                      style={{
                        background: `hsla(${meta.accentHue}, 60%, 55%, 0.12)`,
                        color: `hsla(${meta.accentHue}, 60%, 65%, 0.9)`,
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
                      </div>
                    </div>
                    <Plus className="w-3 h-3 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: 'var(--text-muted)' }} />
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
        className="w-full flex items-center justify-center gap-1.5 h-8 rounded-[8px] text-[11px] font-semibold transition-all duration-150 mb-2"
        style={{
          background: 'rgba(59,130,246,0.06)',
          border: '1px dashed rgba(59,130,246,0.2)',
          color: 'rgba(59,130,246,0.8)',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(59,130,246,0.12)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(59,130,246,0.06)'; }}
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
      className="w-full flex items-center justify-center gap-1.5 h-7 rounded-[8px] text-[11px] font-medium transition-all duration-150 disabled:opacity-30"
      style={{
        background: copied ? 'rgba(34,197,94,0.08)' : 'rgba(168,85,247,0.06)',
        border: `1px dashed ${copied ? 'rgba(34,197,94,0.25)' : 'rgba(168,85,247,0.2)'}`,
        color: copied ? 'rgba(34,197,94,0.9)' : 'rgba(168,85,247,0.8)',
      }}
      onMouseEnter={e => { if (!copied) e.currentTarget.style.background = 'rgba(168,85,247,0.12)'; }}
      onMouseLeave={e => { if (!copied) e.currentTarget.style.background = 'rgba(168,85,247,0.06)'; }}
    >
      {copied ? '✓ 已复制到剪贴板' : '⬆ 导出为 cURL 命令'}
    </button>
  );
}

// ──── 舱配置表单 ────

function CapsuleConfigForm({ fields, values, onChange, disabled, nodeType }: {
  fields: CapsuleConfigField[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
  nodeType?: string;
}) {
  const supportssCurl = nodeType === 'http-request' || nodeType === 'smart-http';

  if (fields.length === 0 && !supportssCurl) return (
    <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>此舱无需额外配置</p>
  );

  function handleCurlImport(parsed: { url: string; method: string; headers: string; body: string }) {
    if (parsed.url) onChange('url', parsed.url);
    if (parsed.method) onChange('method', parsed.method);
    if (parsed.headers) onChange('headers', parsed.headers);
    if (parsed.body) onChange('body', parsed.body);
    // smart-http: 也写入 curlCommand
    if (nodeType === 'smart-http') {
      onChange('curlCommand', `curl '${parsed.url}' -X ${parsed.method}${parsed.headers ? ` -H '...'` : ''}${parsed.body ? ` -d '...'` : ''}`);
    }
  }

  // curlCommand 文本框自动解析：粘贴 cURL 命令后自动填充 url/method/headers/body
  const [curlParsed, setCurlParsed] = useState(false);
  function handleCurlCommandPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    const parsed = parseCurl(text);
    if (parsed) {
      e.preventDefault();
      onChange('curlCommand', text);
      onChange('url', parsed.url);
      onChange('method', parsed.method);
      const h = headersToJson(parsed.headers);
      if (h) onChange('headers', h);
      const b = prettyBody(parsed.body);
      if (b) onChange('body', b);
      setCurlParsed(true);
      setTimeout(() => setCurlParsed(false), 2500);
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
                    onChange('url', parsed.url);
                    onChange('method', parsed.method);
                    const h = headersToJson(parsed.headers);
                    if (h) onChange('headers', h);
                    const b = prettyBody(parsed.body);
                    if (b) onChange('body', b);
                    setCurlParsed(true);
                    setTimeout(() => setCurlParsed(false), 2500);
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

// ──── 右侧舱卡片 ────

function CapsuleCard({ node, index, nodeExec, nodeOutput, isExpanded, onToggle, onRemove, onTestRun, onConfigChange, capsuleMeta, isRunning, testRunResult, isTestRunning }: {
  node: WorkflowNode;
  index: number;
  nodeExec?: NodeExecution;
  nodeOutput?: { logs: string; artifacts: ExecutionArtifact[] };
  isExpanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onTestRun: () => void;
  onConfigChange: (nodeId: string, config: Record<string, unknown>) => void;
  capsuleMeta?: CapsuleTypeMeta;
  isRunning: boolean;
  testRunResult?: import('@/services/contracts/workflowAgent').CapsuleTestRunResult | null;
  isTestRunning?: boolean;
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

  const [expandedArtifacts, setExpandedArtifacts] = useState<Set<string>>(new Set());

  function toggleArtifact(id: string) {
    setExpandedArtifacts((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <div>
      <GlassCard
        accentHue={accentHue}
        glow={isActive}
        padding="md"
        className={isActive ? 'ring-1 ring-white/10' : ''}
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
                  ? { background: 'rgba(214,178,106,0.18)', color: 'var(--accent-gold)' }
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
                style={{ width: '60%', background: 'var(--gold-gradient, linear-gradient(90deg, rgba(214,178,106,0.6), rgba(214,178,106,0.3)))' }}
              />
            </div>
            <span className="text-[10px]" style={{ color: 'var(--accent-gold)' }}>处理中...</span>
          </div>
        )}

        {/* 展开区域：配置 + 调试 + 产物 */}
        {isExpanded && (
          <div className="mt-3 ml-[68px] space-y-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 12 }}>
            {/* 输入/输出插槽详情 */}
            {(node.inputSlots.length > 0 || node.outputSlots.length > 0) && (
              <div
                className="rounded-[10px] p-2.5 space-y-2"
                style={{
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(255,255,255,0.06)',
                }}
              >
                {node.inputSlots.length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold mb-1" style={{ color: `hsla(${accentHue}, 55%, 65%, 0.8)` }}>
                      ← 输入
                    </div>
                    <div className="space-y-1">
                      {node.inputSlots.map(s => (
                        <div key={s.slotId} className="flex items-center gap-2 text-[10px]">
                          <span
                            className="px-1.5 py-0.5 rounded font-mono"
                            style={{
                              background: `hsla(${accentHue}, 50%, 50%, 0.08)`,
                              color: `hsla(${accentHue}, 55%, 70%, 0.85)`,
                              border: `1px solid hsla(${accentHue}, 50%, 50%, 0.12)`,
                            }}
                          >
                            {s.name}
                          </span>
                          <span
                            className="px-1 py-0.5 rounded"
                            style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)', fontSize: 9 }}
                          >
                            {s.dataType}
                          </span>
                          {s.required && <span style={{ color: 'var(--text-muted)', fontSize: 9 }}>必需</span>}
                          {s.description && (
                            <span style={{ color: 'var(--text-muted)' }} className="truncate">{s.description}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {node.outputSlots.length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold mb-1" style={{ color: 'rgba(34,197,94,0.8)' }}>
                      → 输出
                    </div>
                    <div className="space-y-1">
                      {node.outputSlots.map(s => (
                        <div key={s.slotId} className="flex items-center gap-2 text-[10px]">
                          <span
                            className="px-1.5 py-0.5 rounded font-mono"
                            style={{
                              background: 'rgba(34,197,94,0.06)',
                              color: 'rgba(34,197,94,0.8)',
                              border: '1px solid rgba(34,197,94,0.1)',
                            }}
                          >
                            {s.name}
                          </span>
                          <span
                            className="px-1 py-0.5 rounded"
                            style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)', fontSize: 9 }}
                          >
                            {s.dataType}
                          </span>
                          {s.description && (
                            <span style={{ color: 'var(--text-muted)' }} className="truncate">{s.description}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 舱配置表单 */}
            {capsuleMeta && capsuleMeta.configSchema.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <Settings2 className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                  <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>舱配置</span>
                </div>
                <CapsuleConfigForm
                  fields={capsuleMeta.configSchema}
                  values={configValues}
                  onChange={handleConfigFieldChange}
                  disabled={isRunning}
                  nodeType={node.nodeType}
                />
              </div>
            )}

            {/* 操作按钮 */}
            <div className="flex items-center gap-2">
              {capsuleMeta?.testable && (
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={(e) => { e.stopPropagation(); onTestRun(); }}
                  disabled={isRunning || isTestRunning}
                >
                  {isTestRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <FlaskConical className="w-3 h-3" />}
                  {isTestRunning ? '执行中...' : '单舱测试'}
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

            {/* 单舱测试结果 */}
            {testRunResult && (
              <div className="space-y-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 12 }}>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>测试结果</span>
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded-full"
                    style={
                      testRunResult.status === 'completed'
                        ? { background: 'rgba(34,197,94,0.12)', color: 'rgba(34,197,94,0.9)', border: '1px solid rgba(34,197,94,0.2)' }
                        : { background: 'rgba(239,68,68,0.1)', color: 'rgba(239,68,68,0.9)', border: '1px solid rgba(239,68,68,0.2)' }
                    }
                  >
                    {testRunResult.status === 'completed' ? `完成 (${testRunResult.durationMs}ms)` : '失败'}
                  </span>
                </div>

                {/* 执行日志 */}
                {testRunResult.logs && (
                  <pre
                    className="text-[10px] rounded-[8px] p-2.5 max-h-28 overflow-auto whitespace-pre-wrap font-mono leading-relaxed"
                    style={{
                      background: 'rgba(0,0,0,0.25)',
                      color: 'var(--text-secondary)',
                      border: '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    {testRunResult.logs}
                  </pre>
                )}

                {/* 产物 */}
                {testRunResult.artifacts && testRunResult.artifacts.length > 0 && (
                  <div className="space-y-1.5">
                    {testRunResult.artifacts.map((art, idx) => (
                      <div
                        key={idx}
                        className="rounded-[10px] overflow-hidden"
                        style={{
                          background: 'var(--nested-block-bg, rgba(255,255,255,0.03))',
                          border: '1px solid var(--nested-block-border, rgba(255,255,255,0.08))',
                        }}
                      >
                        <div className="flex items-center gap-2 px-3 py-2">
                          <FileText className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                          <span className="text-[12px] font-medium flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
                            {art.name}
                          </span>
                          <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                            {formatBytes(art.sizeBytes)}
                          </span>
                        </div>
                        {art.inlineContent && (
                          <div className="px-3 pb-2.5" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                            <pre
                              className="text-[11px] rounded-[8px] p-2.5 mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono leading-relaxed"
                              style={{
                                background: 'rgba(0,0,0,0.25)',
                                color: 'var(--text-secondary)',
                                border: '1px solid rgba(255,255,255,0.06)',
                              }}
                            >
                              {art.inlineContent}
                            </pre>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* 错误 */}
                {testRunResult.errorMessage && (
                  <div
                    className="text-[11px] rounded-[8px] px-3 py-2 leading-relaxed"
                    style={{
                      background: 'rgba(239,68,68,0.08)',
                      color: 'rgba(239,68,68,0.9)',
                      border: '1px solid rgba(239,68,68,0.15)',
                    }}
                  >
                    {testRunResult.errorMessage}
                  </div>
                )}
              </div>
            )}

            {/* 执行结果：日志 + 产物 */}
            {nodeOutput && (status === 'completed' || status === 'failed') && (
              <div className="space-y-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 12 }}>
                <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>执行结果</span>

                {/* 产物 */}
                {nodeOutput.artifacts.length > 0 && (
                  <div className="space-y-1.5">
                    {nodeOutput.artifacts.map((art) => (
                      <div
                        key={art.artifactId}
                        className="rounded-[10px] overflow-hidden"
                        style={{
                          background: 'var(--nested-block-bg, rgba(255,255,255,0.03))',
                          border: '1px solid var(--nested-block-border, rgba(255,255,255,0.08))',
                        }}
                      >
                        <div
                          className={`flex items-center gap-2 px-3 py-2 ${art.inlineContent ? 'cursor-pointer' : ''}`}
                          onClick={art.inlineContent ? () => toggleArtifact(art.artifactId) : undefined}
                        >
                          <FileText className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                          <span className="text-[12px] font-medium flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
                            {art.name}
                          </span>
                          <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                            {formatBytes(art.sizeBytes)}
                          </span>
                          {art.cosUrl && (
                            <a
                              href={art.cosUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="p-1 rounded-[6px] flex-shrink-0 transition-colors"
                              title="下载文件"
                              style={{ color: 'var(--accent-gold)' }}
                            >
                              <Download className="w-3.5 h-3.5" />
                            </a>
                          )}
                          {art.inlineContent && (
                            expandedArtifacts.has(art.artifactId)
                              ? <ChevronDown className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                              : <ChevronRight className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                          )}
                        </div>
                        {expandedArtifacts.has(art.artifactId) && art.inlineContent && (
                          <div className="px-3 pb-2.5" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                            <pre
                              className="text-[11px] rounded-[8px] p-2.5 mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono leading-relaxed"
                              style={{
                                background: 'rgba(0,0,0,0.25)',
                                color: 'var(--text-secondary)',
                                border: '1px solid rgba(255,255,255,0.06)',
                              }}
                            >
                              {art.inlineContent}
                            </pre>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* 日志 */}
                {nodeOutput.logs && nodeOutput.artifacts.length === 0 && (
                  <pre
                    className="text-[10px] rounded-[8px] p-2.5 max-h-28 overflow-auto whitespace-pre-wrap font-mono leading-relaxed"
                    style={{
                      background: 'rgba(0,0,0,0.25)',
                      color: 'var(--text-secondary)',
                      border: '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    {nodeOutput.logs.slice(0, 800)}
                    {nodeOutput.logs.length > 800 ? '\n...(更多日志请查看完整详情)' : ''}
                  </pre>
                )}

                {/* 错误信息 */}
                {nodeExec?.errorMessage && (
                  <div
                    className="text-[11px] rounded-[8px] px-3 py-2 leading-relaxed"
                    style={{
                      background: 'rgba(239,68,68,0.08)',
                      color: 'rgba(239,68,68,0.9)',
                      border: '1px solid rgba(239,68,68,0.15)',
                    }}
                  >
                    {nodeExec.errorMessage}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </GlassCard>
    </div>
  );
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

  // 变量
  const [vars, setVars] = useState<Record<string, string>>({});

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

          for (const ne of exec.nodeExecutions) {
            if (['completed', 'failed'].includes(ne.status) && !fetchedNodesRef.current.has(ne.nodeId)) {
              fetchedNodesRef.current.add(ne.nodeId);
              fetchNodeOutput(exec.id, ne.nodeId);
            }
          }

          if (['completed', 'failed', 'cancelled'].includes(exec.status)) {
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
        setNodeOutputs((prev) => ({
          ...prev,
          [nodeId]: { logs: res.data!.logs || '', artifacts: res.data!.artifacts || [] },
        }));
      }
    } catch { /* ignore */ }
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

    try {
      const res = await executeWorkflow({ id: workflow.id, variables: vars });
      if (res.success && res.data) {
        const exec = res.data.execution;
        setLatestExec(exec);
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

  async function handleTestRun(nodeId: string) {
    const node = workflow?.nodes.find(n => n.nodeId === nodeId);
    if (!node) return;

    setTestRunning(nodeId);
    setTestRunResult(null);
    try {
      const res = await testRunCapsule({
        typeKey: node.nodeType,
        config: node.config as Record<string, unknown>,
        mockInput: { _test: true },
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
        title={workflow.name || '编辑工作流'}
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

        {/* 右侧：已添加的舱列表 + 变量配置 */}
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
              <GlassCard>
                <div className="flex flex-col items-center py-8 gap-3">
                  <span className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
                    从左侧目录选择舱添加到工作流
                  </span>
                </div>
              </GlassCard>
            ) : (
              <div className="space-y-2">
                {workflow.nodes.map((node, idx) => (
                  <CapsuleCard
                    key={node.nodeId}
                    node={node}
                    index={idx}
                    nodeExec={latestExec?.nodeExecutions.find(ne => ne.nodeId === node.nodeId)}
                    nodeOutput={nodeOutputs[node.nodeId]}
                    isExpanded={expandedNodeId === node.nodeId}
                    onToggle={() => setExpandedNodeId(expandedNodeId === node.nodeId ? null : node.nodeId)}
                    onRemove={() => handleRemoveNode(node.nodeId)}
                    onTestRun={() => handleTestRun(node.nodeId)}
                    onConfigChange={handleNodeConfigChange}
                    capsuleMeta={capsuleTypes.find(ct => ct.typeKey === node.nodeType)}
                    isRunning={isRunning}
                    testRunResult={testRunResult?.nodeId === node.nodeId ? testRunResult.result : null}
                    isTestRunning={testRunning === node.nodeId}
                  />
                ))}
              </div>
            )}

            {/* 最终产物 */}
            {latestExec && ['completed', 'failed', 'cancelled'].includes(latestExec.status) && latestExec.finalArtifacts.length > 0 && (
              <GlassCard accentHue={latestExec.status === 'completed' ? 150 : 0} glow={latestExec.status === 'completed'}>
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
                      {art.cosUrl && (
                        <a
                          href={art.cosUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1 rounded-[6px] transition-colors"
                          title="下载"
                          style={{ color: 'var(--accent-gold)' }}
                        >
                          <Download className="w-4 h-4" />
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </GlassCard>
            )}
          </div>
        </div>
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
    <GlassCard>
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
