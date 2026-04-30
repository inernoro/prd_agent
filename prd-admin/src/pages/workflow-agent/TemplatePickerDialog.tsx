import { useState, useEffect, useRef, useCallback } from 'react';
import { ShieldCheck, ShieldAlert, Copy, Check, ChevronDown, Clock, Trash2 } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Surface } from '@/components/design/Surface';
import { WORKFLOW_TEMPLATES, type WorkflowTemplate, type TemplateInput } from './workflowTemplates';
import { validateTapdCookie } from '@/services';
import { AuthPicker } from '@/components/AuthPicker';

// ═══════════════════════════════════════════════════════════════
// 工作流模板选择器 — 一键导入预定义工作流
// ═══════════════════════════════════════════════════════════════

// ── Cookie 历史管理 ──────────────────────────────────────────

const COOKIE_HISTORY_KEY = 'tapd-cookie-history';
const MAX_COOKIE_HISTORY = 10;

interface CookieHistoryEntry {
  cookie: string;
  label: string;  // 截取前 40 字符作为标签
  userName?: string;
  savedAt: string;
}

function loadCookieHistory(): CookieHistoryEntry[] {
  try {
    const raw = sessionStorage.getItem(COOKIE_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveCookieToHistory(cookie: string, userName?: string) {
  const history = loadCookieHistory();
  // 去重（同一 cookie 不重复存储）
  const filtered = history.filter(h => h.cookie !== cookie);
  const label = cookie.length > 40 ? cookie.slice(0, 40) + '…' : cookie;
  filtered.unshift({ cookie, label, userName, savedAt: new Date().toISOString() });
  // 保留最近 N 条
  sessionStorage.setItem(COOKIE_HISTORY_KEY, JSON.stringify(filtered.slice(0, MAX_COOKIE_HISTORY)));
}

function removeCookieFromHistory(cookie: string) {
  const history = loadCookieHistory();
  const filtered = history.filter(h => h.cookie !== cookie);
  sessionStorage.setItem(COOKIE_HISTORY_KEY, JSON.stringify(filtered));
}

// ── 工作空间历史管理 ──────────────────────────────────────────

const WORKSPACE_HISTORY_KEY = 'tapd-workspace-history';

interface WorkspaceHistoryEntry {
  id: string;
  name: string;
  savedAt: string;
}

function loadWorkspaceHistory(): WorkspaceHistoryEntry[] {
  try {
    const raw = sessionStorage.getItem(WORKSPACE_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveWorkspaceToHistory(id: string, name: string) {
  const history = loadWorkspaceHistory();
  const filtered = history.filter(h => h.id !== id);
  filtered.unshift({ id, name, savedAt: new Date().toISOString() });
  sessionStorage.setItem(WORKSPACE_HISTORY_KEY, JSON.stringify(filtered.slice(0, 20)));
}

// ═══════════════════════════════════════════════════════════════

interface TemplatePickerDialogProps {
  open: boolean;
  onClose: () => void;
  onImport: (template: WorkflowTemplate, inputs: Record<string, string>) => void;
  importing?: boolean;
}

const fieldInputStyle: React.CSSProperties = {
  background: 'var(--bg-input)',
  border: '1px solid var(--border-subtle)',
  color: 'var(--text-primary)',
  outline: 'none',
};

export function TemplatePickerDialog({ open, onClose, onImport, importing }: TemplatePickerDialogProps) {
  const [selected, setSelected] = useState<WorkflowTemplate | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [validation, setValidation] = useState<{
    valid: boolean;
    userName?: string;
    workspaces?: { id: string; name: string }[];
    bugCount?: number;
    error?: string;
    debugCurls?: { name: string; curl: string }[];
    apiResults?: { api: string; method: string; status: number; response: string }[];
  } | null>(null);

  if (!open) return null;

  function handleSelectTemplate(tpl: WorkflowTemplate) {
    setSelected(tpl);
    const defaults: Record<string, string> = {};
    for (const input of tpl.requiredInputs) {
      if (input.defaultValue) defaults[input.key] = input.defaultValue;
    }
    setInputs(defaults);
    setValidation(null);
  }

  function handleBack() {
    setSelected(null);
    setInputs({});
    setValidation(null);
  }

  function handleImport() {
    if (!selected) return;
    // 保存 cookie 到历史
    if (inputs.cookie?.trim()) {
      saveCookieToHistory(inputs.cookie.trim(), validation?.userName);
    }
    // 保存工作空间到历史
    if (inputs.workspaceId?.trim()) {
      const ws = validation?.workspaces?.find(w => w.id === inputs.workspaceId);
      saveWorkspaceToHistory(inputs.workspaceId, ws?.name || inputs.workspaceId);
    }
    onImport(selected, inputs);
  }

  const canImport = selected && selected.requiredInputs
    .filter(i => i.required)
    .every(i => (inputs[i.key] ?? '').trim() !== '');

  return (
    <div
      className="surface-backdrop fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <Surface
        variant="raised"
        className="w-full max-w-[640px] max-h-[85vh] flex flex-col rounded-[16px] overflow-hidden"
      >
        {/* 头部 */}
        <div className="surface-panel-header flex items-center justify-between px-5 py-4 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            {selected && (
              <button
                onClick={handleBack}
                className="surface-action w-7 h-7 rounded-lg flex items-center justify-center text-[13px] transition-colors"
              >
                ←
              </button>
            )}
            <h2 className="text-[15px] font-semibold text-token-primary">
              {selected ? selected.name : '从模板创建工作流'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-[12px] text-token-muted transition-colors hover-bg-soft"
          >
            ✕
          </button>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto p-5">
          {!selected ? (
            <TemplateGallery onSelect={handleSelectTemplate} />
          ) : (
            <TemplateConfigForm
              template={selected}
              inputs={inputs}
              onChange={(key, value) => setInputs(prev => ({ ...prev, [key]: value }))}
              onBatchChange={(updates) => setInputs(prev => ({ ...prev, ...updates }))}
              validation={validation}
              onValidationChange={setValidation}
            />
          )}
        </div>

        {/* 底部操作 */}
        {selected && (
          <div className="surface-panel-footer flex items-center justify-between px-5 py-3.5 flex-shrink-0">
            <div className="text-[11px] text-token-muted">
              {selected.requiredInputs.filter(i => i.required).length > 0
                ? '填写必填项后即可导入'
                : '点击导入创建工作流'}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleImport}
                disabled={!canImport || importing}
              >
                {importing ? '导入中...' : '一键导入'}
              </Button>
            </div>
          </div>
        )}
      </Surface>
    </div>
  );
}

// ── 模板画廊 ─────────────────────────────────────────────────

function TemplateGallery({ onSelect }: { onSelect: (tpl: WorkflowTemplate) => void }) {
  return (
    <div className="grid grid-cols-1 gap-3">
      {WORKFLOW_TEMPLATES.map((tpl) => (
        <GlassCard
          key={tpl.id}
          interactive
          animated
          padding="none"
          onClick={() => onSelect(tpl)}
          className="group"
        >
          <div className="p-4 flex items-start gap-4">
            <div
              className="surface-inset w-12 h-12 rounded-[12px] flex items-center justify-center text-[24px] flex-shrink-0"
            >
              {tpl.icon}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-[14px] font-semibold text-token-primary">
                  {tpl.name}
                </h3>
                <span
                  className="surface-action surface-action-success text-[10px] px-1.5 py-0.5 rounded-full"
                >
                  模板
                </span>
              </div>
              <p className="text-[12px] mt-1 text-token-muted">
                {tpl.description}
              </p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {tpl.tags.map((tag) => (
                  <span
                    key={tag}
                    className="surface-inset text-token-muted text-[10px] px-1.5 py-0.5 rounded-full"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
            <div
              className="flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0 self-center opacity-40 group-hover:opacity-70 text-token-secondary transition-opacity"
            >
              →
            </div>
          </div>
        </GlassCard>
      ))}

      {WORKFLOW_TEMPLATES.length === 0 && (
        <div className="text-center py-12 text-[13px] text-token-muted">
          暂无可用模板
        </div>
      )}
    </div>
  );
}

// ── 模板配置表单 ─────────────────────────────────────────────

function TemplateConfigForm({
  template,
  inputs,
  onChange,
  onBatchChange,
  validation,
  onValidationChange,
}: {
  template: WorkflowTemplate;
  inputs: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onBatchChange: (updates: Record<string, string>) => void;
  validation: {
    valid: boolean;
    userName?: string;
    workspaces?: { id: string; name: string }[];
    bugCount?: number;
    error?: string;
    debugCurls?: { name: string; curl: string }[];
    apiResults?: { api: string; method: string; status: number; response: string }[];
  } | null;
  onValidationChange: (v: typeof validation) => void;
}) {
  return (
    <div className="space-y-5">
      {/* 描述 */}
      <Surface variant="inset" className="rounded-[10px] p-3.5">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[18px]">{template.icon}</span>
          <span className="text-[13px] font-medium text-token-primary">
            {template.name}
          </span>
        </div>
        <p className="text-[12px] text-token-muted">
          {template.description}
        </p>
      </Surface>

      {/* 配置字段 */}
      {template.requiredInputs.length > 0 && (
        <div className="space-y-3.5">
          <h4 className="text-[12px] font-semibold uppercase tracking-wider text-token-muted">
            配置参数
          </h4>
          {template.requiredInputs.map((field) =>
            field.key === 'cookie' ? (
              <CookieFieldInput
                key={field.key}
                field={field}
                value={inputs[field.key] ?? ''}
                onChange={(v) => onChange(field.key, v)}
                allInputs={inputs}
                onBatchChange={onBatchChange}
                validation={validation}
                onValidationChange={onValidationChange}
              />
            ) : field.key === 'workspaceId' ? (
              <WorkspaceFieldInput
                key={field.key}
                field={field}
                value={inputs[field.key] ?? ''}
                onChange={(v) => onChange(field.key, v)}
                validation={validation}
              />
            ) : (
              <GenericFieldInput
                key={field.key}
                field={field}
                value={inputs[field.key] ?? ''}
                onChange={(v) => onChange(field.key, v)}
              />
            )
          )}
        </div>
      )}
    </div>
  );
}

// ── Cookie 专属字段 ──────────────────────────────────────────

function CookieFieldInput({
  field,
  value,
  onChange,
  allInputs,
  onBatchChange,
  validation,
  onValidationChange,
}: {
  field: TemplateInput;
  value: string;
  onChange: (v: string) => void;
  allInputs: Record<string, string>;
  onBatchChange: (updates: Record<string, string>) => void;
  validation: {
    valid: boolean;
    userName?: string;
    workspaces?: { id: string; name: string }[];
    bugCount?: number;
    error?: string;
    debugCurls?: { name: string; curl: string }[];
    apiResults?: { api: string; method: string; status: number; response: string }[];
  } | null;
  onValidationChange: (v: typeof validation) => void;
}) {
  const [validating, setValidating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [curlCopied, setCurlCopied] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showApiDetails, setShowApiDetails] = useState(false);
  const [cookieHistory, setCookieHistory] = useState<CookieHistoryEntry[]>([]);
  const historyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCookieHistory(loadCookieHistory());
  }, []);

  // 点击外部关闭历史下拉
  useEffect(() => {
    if (!showHistory) return;
    function handleClick(e: MouseEvent) {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setShowHistory(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showHistory]);

  const handleCopy = useCallback(() => {
    if (!value) return;
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [value]);

  async function handleValidateCookie() {
    const cookie = value.trim();
    if (!cookie) return;
    setValidating(true);
    onValidationChange(null);
    try {
      const res = await validateTapdCookie({ cookie, workspaceId: allInputs.workspaceId });
      if (!res.success) {
        onValidationChange({ valid: false, error: res.error?.message || '请求失败' });
        return;
      }
      onValidationChange(res.data);
      // 验证成功后自动选中第一个工作空间
      if (res.data.valid && res.data.workspaces?.length && !allInputs.workspaceId) {
        onBatchChange({ workspaceId: res.data.workspaces[0].id });
      }
      // 验证成功自动保存到历史
      if (res.data.valid) {
        saveCookieToHistory(cookie, res.data.userName);
        setCookieHistory(loadCookieHistory());
      }
    } catch {
      onValidationChange({ valid: false, error: '请求失败，请检查网络' });
    } finally {
      setValidating(false);
    }
  }

  function handleSelectHistory(entry: CookieHistoryEntry) {
    onChange(entry.cookie);
    onValidationChange(null);
    setShowHistory(false);
  }

  function handleDeleteHistory(e: React.MouseEvent, cookie: string) {
    e.stopPropagation();
    removeCookieFromHistory(cookie);
    setCookieHistory(loadCookieHistory());
  }

  return (
    <div>
      <label className="flex items-center gap-1.5 mb-1.5">
        <span className="text-[12px] font-medium text-token-secondary">
          {field.label}
        </span>
        {field.required && (
          <span className="text-[10px] text-token-error">*</span>
        )}
      </label>

      {/* Cookie 输入区域 */}
      <div className="relative" ref={historyRef}>
        <div className="relative">
          <textarea
            value={value}
            onChange={(e) => { onChange(e.target.value); onValidationChange(null); }}
            placeholder={field.placeholder}
            rows={3}
            className="prd-field prd-textarea-min w-full px-3 py-2 pr-20 rounded-[8px] text-[12px] resize-y font-mono"
          />
          {/* 右侧按钮组 */}
          <div className="absolute top-2 right-2 flex gap-1">
            {/* 历史记录按钮 */}
            {cookieHistory.length > 0 && (
              <button
                onClick={() => setShowHistory(!showHistory)}
                className={`surface-action flex items-center justify-center w-7 h-7 rounded-[6px] transition-colors ${showHistory ? 'surface-action-accent' : ''}`}
                title="历史记录"
              >
                <Clock size={13} />
              </button>
            )}
            {/* 一键复制按钮 */}
            <button
              onClick={handleCopy}
              disabled={!value}
              className={`surface-action flex items-center justify-center w-7 h-7 rounded-[6px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${copied ? 'surface-action-success' : ''}`}
              title="复制 Cookie"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
        </div>

        {/* 历史记录下拉 */}
        {showHistory && cookieHistory.length > 0 && (
          <div
            className="surface-popover max-h-popover absolute top-full left-0 right-0 z-10 mt-1 rounded-[8px] overflow-y-auto overflow-hidden"
          >
            <div className="surface-panel-header px-3 py-2 text-[11px] font-medium text-token-muted">
              历史记录
            </div>
            {cookieHistory.map((entry, i) => (
              <button
                key={i}
                onClick={() => handleSelectHistory(entry)}
                className={`surface-row w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${i < cookieHistory.length - 1 ? 'border-b border-token-nested' : ''}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-mono truncate text-token-secondary">
                    {entry.label}
                  </div>
                  <div className="text-[10px] mt-0.5 text-token-muted">
                    {entry.userName ? `${entry.userName} · ` : ''}{new Date(entry.savedAt).toLocaleDateString()}
                  </div>
                </div>
                <button
                  onClick={(e) => handleDeleteHistory(e, entry.cookie)}
                  className="surface-action surface-action-danger flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-[4px] transition-colors"
                  title="删除此记录"
                >
                  <Trash2 size={11} />
                </button>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 验证按钮行 */}
      <div className="mt-2 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleValidateCookie}
            disabled={validating || !value.trim()}
            className={`surface-action flex items-center gap-1.5 h-7 px-3 rounded-[6px] text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${validating ? '' : 'surface-action-accent'}`}
          >
            {validating ? <MapSpinner size={12} /> : <ShieldCheck size={12} />}
            {validating ? '验证中...' : '验证 Cookie'}
          </button>
          {validation?.debugCurls && validation.debugCurls.length > 0 && (
            <button
              onClick={() => {
                const text = validation.debugCurls!
                  .map((c) => `# ${c.name}\n${c.curl}`)
                  .join('\n\n');
                navigator.clipboard.writeText(text);
                setCurlCopied(true);
                setTimeout(() => setCurlCopied(false), 2000);
              }}
              className={`surface-action flex items-center gap-1 h-7 px-2.5 rounded-[6px] text-[11px] font-medium transition-colors ${curlCopied ? 'surface-action-success' : ''}`}
            >
              {curlCopied ? <Check size={11} /> : <Copy size={11} />}
              {curlCopied ? '已复制' : '复制 cURL'}
            </button>
          )}
          {validation?.apiResults && validation.apiResults.length > 0 && (
            <button
              onClick={() => setShowApiDetails(prev => !prev)}
              className="surface-action flex items-center gap-1 h-7 px-2.5 rounded-[6px] text-[11px] font-medium transition-colors"
            >
              {showApiDetails ? '收起详情' : '查看 API 调用详情'}
            </button>
          )}
        </div>

        {/* 验证结果 */}
        {validation && (
          <div
            className={`rounded-[8px] p-2.5 text-[11px] space-y-2 ${validation.valid ? 'surface-state-success' : 'surface-state-danger'}`}
          >
            <div className="flex items-center gap-1.5">
              {validation.valid ? <ShieldCheck size={12} /> : <ShieldAlert size={12} />}
              <span className="font-medium">
                {validation.valid ? `Cookie 有效 — ${validation.userName || '已认证'}` : `Cookie 无效 — ${validation.error || '认证失败'}`}
              </span>
            </div>

            {/* API 调用详情 */}
            {showApiDetails && validation.apiResults && validation.apiResults.length > 0 && (
              <div className="space-y-1.5 pt-1 border-t border-token-nested">
                <div className="font-medium text-token-muted">后端请求了以下接口：</div>
                {validation.apiResults.map((r, i) => (
                  <div key={i} className="surface-code rounded-[6px] p-2">
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={`px-1 py-0.5 rounded text-[9px] font-bold ${r.status >= 200 && r.status < 300 ? 'surface-action-success' : 'surface-action-danger'}`}
                      >
                        {r.method} {r.status || 'ERR'}
                      </span>
                      <span className="font-mono text-[10px] truncate text-token-secondary">
                        {r.api}
                      </span>
                    </div>
                    <pre
                      className="text-[10px] font-mono whitespace-pre-wrap break-all max-h-[80px] overflow-y-auto text-token-muted"
                    >
                      {r.response}
                    </pre>
                  </div>
                ))}
              </div>
            )}

            {validation.valid && validation.bugCount != null && (
              <div className="text-token-muted">
                当前工作空间缺陷数：{validation.bugCount}
              </div>
            )}
          </div>
        )}
      </div>

      {field.helpTip && (
        <p className="text-[11px] mt-1 text-token-muted opacity-70">
          {field.helpTip}
        </p>
      )}
    </div>
  );
}

// ── 工作空间专属字段（支持 API 加载 + 历史） ──────────────────

function WorkspaceFieldInput({
  field,
  value,
  onChange,
  validation,
}: {
  field: TemplateInput;
  value: string;
  onChange: (v: string) => void;
  validation: {
    valid: boolean;
    workspaces?: { id: string; name: string }[];
  } | null;
}) {
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const wsHistory = loadWorkspaceHistory();

  // 合并来源：API 加载的 + 历史记录（去重）
  const apiWorkspaces = validation?.valid && validation.workspaces ? validation.workspaces : [];
  const mergedWorkspaces: { id: string; name: string; source: 'api' | 'history' }[] = [];
  const seenIds = new Set<string>();

  for (const ws of apiWorkspaces) {
    mergedWorkspaces.push({ ...ws, source: 'api' });
    seenIds.add(ws.id);
  }
  for (const ws of wsHistory) {
    if (!seenIds.has(ws.id)) {
      mergedWorkspaces.push({ id: ws.id, name: ws.name, source: 'history' });
      seenIds.add(ws.id);
    }
  }

  const hasOptions = mergedWorkspaces.length > 0;

  useEffect(() => {
    if (!showDropdown) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showDropdown]);

  const selectedWs = mergedWorkspaces.find(ws => ws.id === value);

  return (
    <div>
      <label className="flex items-center gap-1.5 mb-1.5">
        <span className="text-[12px] font-medium text-token-secondary">
          {field.label}
        </span>
        {field.required && (
          <span className="text-[10px] text-token-error">*</span>
        )}
        {!validation?.valid && !hasOptions && (
          <span className="text-[10px] text-token-muted opacity-70">
            验证 Cookie 后可选择工作空间
          </span>
        )}
      </label>

      <div className="relative" ref={dropdownRef}>
        {/* 输入框 + 下拉触发 */}
        <div className="relative">
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder}
            className={`prd-field w-full h-9 px-3 rounded-[8px] text-[13px] ${hasOptions ? 'pr-9' : ''}`}
          />
          {hasOptions && (
            <button
              onClick={() => setShowDropdown(!showDropdown)}
              className="absolute right-1 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded-[6px] text-token-muted transition-colors hover-bg-soft"
            >
              <ChevronDown size={14} className={`transition-transform ${showDropdown ? 'rotate-180' : ''}`} />
            </button>
          )}
        </div>

        {/* 当前选中的名称提示 */}
        {selectedWs && selectedWs.name !== selectedWs.id && (
          <div className="mt-1 text-[11px] text-token-accent">
            {selectedWs.name}
          </div>
        )}

        {/* 下拉列表 */}
        {showDropdown && hasOptions && (
          <div
            className="surface-popover max-h-popover absolute top-full left-0 right-0 z-10 mt-1 rounded-[8px] overflow-y-auto overflow-hidden"
          >
            {/* API 加载的工作空间 */}
            {apiWorkspaces.length > 0 && (
              <>
                <div className="surface-panel-header px-3 py-1.5 text-[10px] font-medium text-token-muted">
                  当前 Cookie 的工作空间
                </div>
                {apiWorkspaces.map((ws) => (
                  <button
                    key={ws.id}
                    onClick={() => { onChange(ws.id); setShowDropdown(false); }}
                    className="surface-row w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
                    data-active={value === ws.id}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] text-token-primary">
                        {ws.name || ws.id}
                      </div>
                      {ws.name && ws.name !== ws.id && (
                        <div className="text-[10px] font-mono text-token-muted">
                          ID: {ws.id}
                        </div>
                      )}
                    </div>
                    {value === ws.id && <Check size={12} className="text-token-accent" />}
                  </button>
                ))}
              </>
            )}

            {/* 历史工作空间 */}
            {mergedWorkspaces.filter(w => w.source === 'history').length > 0 && (
              <>
                <div className={`surface-panel-header px-3 py-1.5 text-[10px] font-medium text-token-muted ${apiWorkspaces.length > 0 ? 'border-t border-token-nested' : ''}`}>
                  历史使用
                </div>
                {mergedWorkspaces.filter(w => w.source === 'history').map((ws) => (
                  <button
                    key={ws.id}
                    onClick={() => { onChange(ws.id); setShowDropdown(false); }}
                    className="surface-row w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
                    data-active={value === ws.id}
                  >
                    <Clock size={11} className="text-token-muted flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] text-token-primary">
                        {ws.name || ws.id}
                      </div>
                      {ws.name && ws.name !== ws.id && (
                        <div className="text-[10px] font-mono text-token-muted">
                          ID: {ws.id}
                        </div>
                      )}
                    </div>
                    {value === ws.id && <Check size={12} className="text-token-accent" />}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {field.helpTip && (
        <p className="text-[11px] mt-1 text-token-muted opacity-70">
          {field.helpTip}
        </p>
      )}
    </div>
  );
}

// ── 通用字段输入 ─────────────────────────────────────────────

function GenericFieldInput({
  field,
  value,
  onChange,
}: {
  field: TemplateInput;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="flex items-center gap-1.5 mb-1.5">
        <span className="text-[12px] font-medium text-token-secondary">
          {field.label}
        </span>
        {field.required && (
          <span className="text-[10px] text-token-error">*</span>
        )}
      </label>
      {field.type === 'select' && field.options ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="prd-field w-full h-9 px-3 rounded-[8px] text-[13px]"
        >
          {field.options.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      ) : field.type === 'textarea' ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          rows={3}
          className="prd-field prd-textarea-min w-full px-3 py-2 rounded-[8px] text-[12px] resize-y font-mono"
        />
      ) : field.type === 'month' ? (
        <input
          type="month"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className="prd-field w-full h-9 px-3 rounded-[8px] text-[13px]"
        />
      ) : field.type === 'auth-picker' ? (
        <AuthPicker
          authType={field.authType || 'tapd'}
          value={value}
          onChange={onChange}
          inputStyle={fieldInputStyle}
        />
      ) : (
        <input
          type={field.type === 'password' ? 'password' : 'text'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className="prd-field w-full h-9 px-3 rounded-[8px] text-[13px]"
        />
      )}
      {field.helpTip && (
        <p className="text-[11px] mt-1 text-token-muted opacity-70">
          {field.helpTip}
        </p>
      )}
    </div>
  );
}
