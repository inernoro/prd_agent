import { useState } from 'react';
import { Loader2, ShieldCheck, ShieldAlert, Copy, Check } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { WORKFLOW_TEMPLATES, type WorkflowTemplate, type TemplateInput } from './workflowTemplates';
import { validateTapdCookie } from '@/services';

// ═══════════════════════════════════════════════════════════════
// 工作流模板选择器 — 一键导入预定义工作流
// ═══════════════════════════════════════════════════════════════

interface TemplatePickerDialogProps {
  open: boolean;
  onClose: () => void;
  onImport: (template: WorkflowTemplate, inputs: Record<string, string>) => void;
  importing?: boolean;
}

export function TemplatePickerDialog({ open, onClose, onImport, importing }: TemplatePickerDialogProps) {
  const [selected, setSelected] = useState<WorkflowTemplate | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});

  if (!open) return null;

  function handleSelectTemplate(tpl: WorkflowTemplate) {
    setSelected(tpl);
    // 预填默认值
    const defaults: Record<string, string> = {};
    for (const input of tpl.requiredInputs) {
      if (input.defaultValue) defaults[input.key] = input.defaultValue;
    }
    setInputs(defaults);
  }

  function handleBack() {
    setSelected(null);
    setInputs({});
  }

  function handleImport() {
    if (!selected) return;
    onImport(selected, inputs);
  }

  const canImport = selected && selected.requiredInputs
    .filter(i => i.required)
    .every(i => (inputs[i.key] ?? '').trim() !== '');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-[640px] max-h-[85vh] flex flex-col rounded-[16px] overflow-hidden"
        style={{
          background: 'var(--surface-card, rgba(30,30,40,0.95))',
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.4)',
        }}
      >
        {/* 头部 */}
        <div
          className="flex items-center justify-between px-5 py-4 flex-shrink-0"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
        >
          <div className="flex items-center gap-2.5">
            {selected && (
              <button
                onClick={handleBack}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-[13px] transition-colors"
                style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: 'var(--text-secondary)',
                }}
              >
                ←
              </button>
            )}
            <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {selected ? selected.name : '从模板创建工作流'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-[12px] transition-colors"
            style={{ color: 'var(--text-muted)' }}
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
            />
          )}
        </div>

        {/* 底部操作 */}
        {selected && (
          <div
            className="flex items-center justify-between px-5 py-3.5 flex-shrink-0"
            style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
          >
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
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
      </div>
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
            {/* 图标 */}
            <div
              className="w-12 h-12 rounded-[12px] flex items-center justify-center text-[24px] flex-shrink-0"
              style={{
                background: 'rgba(99,102,241,0.08)',
                border: '1px solid rgba(99,102,241,0.12)',
              }}
            >
              {tpl.icon}
            </div>

            {/* 信息 */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {tpl.name}
                </h3>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full"
                  style={{
                    background: 'rgba(34,197,94,0.1)',
                    color: 'rgba(34,197,94,0.85)',
                    border: '1px solid rgba(34,197,94,0.2)',
                  }}
                >
                  模板
                </span>
              </div>
              <p className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>
                {tpl.description}
              </p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {tpl.tags.map((tag) => (
                  <span
                    key={tag}
                    className="text-[10px] px-1.5 py-0.5 rounded-full"
                    style={{
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      color: 'var(--text-muted)',
                    }}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>

            {/* 箭头 */}
            <div
              className="flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0 self-center opacity-40 group-hover:opacity-70 transition-opacity"
              style={{ color: 'var(--text-secondary)' }}
            >
              →
            </div>
          </div>
        </GlassCard>
      ))}

      {WORKFLOW_TEMPLATES.length === 0 && (
        <div className="text-center py-12 text-[13px]" style={{ color: 'var(--text-muted)' }}>
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
}: {
  template: WorkflowTemplate;
  inputs: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className="space-y-5">
      {/* 描述 */}
      <div
        className="rounded-[10px] p-3.5"
        style={{
          background: 'rgba(99,102,241,0.05)',
          border: '1px solid rgba(99,102,241,0.1)',
        }}
      >
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[18px]">{template.icon}</span>
          <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
            {template.name}
          </span>
        </div>
        <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
          {template.description}
        </p>
      </div>

      {/* 配置字段 */}
      {template.requiredInputs.length > 0 && (
        <div className="space-y-3.5">
          <h4 className="text-[12px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
            配置参数
          </h4>
          {template.requiredInputs.map((field) => (
            <FieldInput
              key={field.key}
              field={field}
              value={inputs[field.key] ?? ''}
              onChange={(v) => onChange(field.key, v)}
              allInputs={inputs}
              onBatchChange={(updates) => {
                for (const [k, v] of Object.entries(updates)) onChange(k, v);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── 单个字段输入 ─────────────────────────────────────────────

function FieldInput({
  field,
  value,
  onChange,
  allInputs,
  onBatchChange,
}: {
  field: TemplateInput;
  value: string;
  onChange: (v: string) => void;
  allInputs: Record<string, string>;
  onBatchChange: (updates: Record<string, string>) => void;
}) {
  const [validating, setValidating] = useState(false);
  const [curlCopied, setCurlCopied] = useState(false);
  const [validation, setValidation] = useState<{
    valid: boolean;
    userName?: string;
    workspaces?: { id: string; name: string }[];
    bugCount?: number;
    error?: string;
    debugCurls?: { name: string; curl: string }[];
  } | null>(null);

  const inputStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.1)',
    color: 'var(--text-primary)',
    outline: 'none',
  };

  const isCookieField = field.key === 'cookie';

  async function handleValidateCookie() {
    const cookie = value.trim();
    if (!cookie) return;
    setValidating(true);
    setValidation(null);
    try {
      const res = await validateTapdCookie({ cookie, workspaceId: allInputs.workspaceId });
      if (!res.success) {
        setValidation({ valid: false, error: res.error?.message || '请求失败' });
        return;
      }
      setValidation(res.data);
      if (res.data.valid && res.data.workspaces?.length && !allInputs.workspaceId) {
        onBatchChange({ workspaceId: res.data.workspaces[0].id });
      }
    } catch {
      setValidation({ valid: false, error: '请求失败，请检查网络' });
    } finally {
      setValidating(false);
    }
  }

  return (
    <div>
      <label className="flex items-center gap-1.5 mb-1.5">
        <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
          {field.label}
        </span>
        {field.required && (
          <span className="text-[10px]" style={{ color: 'rgba(239,68,68,0.7)' }}>*</span>
        )}
      </label>
      {field.type === 'select' && field.options ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full h-9 px-3 rounded-[8px] text-[13px]"
          style={inputStyle}
        >
          {field.options.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      ) : field.type === 'textarea' ? (
        <>
          <textarea
            value={value}
            onChange={(e) => { onChange(e.target.value); setValidation(null); }}
            placeholder={field.placeholder}
            rows={3}
            className="w-full px-3 py-2 rounded-[8px] text-[12px] resize-y font-mono"
            style={{ ...inputStyle, minHeight: 72 }}
          />
          {isCookieField && (
            <div className="mt-2 space-y-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={handleValidateCookie}
                  disabled={validating || !value.trim()}
                  className="flex items-center gap-1.5 h-7 px-3 rounded-[6px] text-[11px] font-medium transition-colors"
                  style={{
                    background: validating ? 'rgba(255,255,255,0.03)' : 'rgba(99,102,241,0.1)',
                    border: '1px solid rgba(99,102,241,0.2)',
                    color: validating ? 'var(--text-muted)' : 'rgba(99,102,241,0.9)',
                    cursor: validating || !value.trim() ? 'not-allowed' : 'pointer',
                    opacity: !value.trim() ? 0.5 : 1,
                  }}
                >
                  {validating ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
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
                    className="flex items-center gap-1 h-7 px-2.5 rounded-[6px] text-[11px] font-medium transition-colors"
                    style={{
                      background: curlCopied ? 'rgba(34,197,94,0.1)' : 'rgba(255,255,255,0.04)',
                      border: `1px solid ${curlCopied ? 'rgba(34,197,94,0.2)' : 'rgba(255,255,255,0.1)'}`,
                      color: curlCopied ? 'rgba(34,197,94,0.9)' : 'var(--text-muted)',
                    }}
                  >
                    {curlCopied ? <Check size={11} /> : <Copy size={11} />}
                    {curlCopied ? '已复制' : '复制 cURL'}
                  </button>
                )}
              </div>

              {validation && (
                <div
                  className="rounded-[8px] p-2.5 text-[11px] space-y-1"
                  style={{
                    background: validation.valid ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)',
                    border: `1px solid ${validation.valid ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'}`,
                  }}
                >
                  <div className="flex items-center gap-1.5" style={{ color: validation.valid ? 'rgba(34,197,94,0.9)' : 'rgba(239,68,68,0.9)' }}>
                    {validation.valid ? <ShieldCheck size={12} /> : <ShieldAlert size={12} />}
                    <span className="font-medium">
                      {validation.valid ? `Cookie 有效 — ${validation.userName || '已认证'}` : `Cookie 无效 — ${validation.error || '认证失败'}`}
                    </span>
                  </div>
                  {validation.valid && validation.workspaces && validation.workspaces.length > 0 && (
                    <div style={{ color: 'var(--text-muted)' }}>
                      <span>检测到 {validation.workspaces.length} 个工作空间：</span>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {validation.workspaces.slice(0, 5).map((ws) => (
                          <button
                            key={ws.id}
                            onClick={() => onBatchChange({ workspaceId: ws.id })}
                            className="px-1.5 py-0.5 rounded text-[10px] transition-colors"
                            style={{
                              background: allInputs.workspaceId === ws.id ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.05)',
                              border: `1px solid ${allInputs.workspaceId === ws.id ? 'rgba(99,102,241,0.3)' : 'rgba(255,255,255,0.08)'}`,
                              color: allInputs.workspaceId === ws.id ? 'rgba(99,102,241,0.9)' : 'var(--text-muted)',
                            }}
                          >
                            {ws.name || ws.id}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {validation.valid && validation.bugCount !== undefined && (
                    <div style={{ color: 'var(--text-muted)' }}>
                      当前工作空间缺陷数：{validation.bugCount}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      ) : field.type === 'month' ? (
        <input
          type="month"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className="w-full h-9 px-3 rounded-[8px] text-[13px]"
          style={inputStyle}
        />
      ) : (
        <input
          type={field.type === 'password' ? 'password' : 'text'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className="w-full h-9 px-3 rounded-[8px] text-[13px]"
          style={inputStyle}
        />
      )}
      {field.helpTip && (
        <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
          {field.helpTip}
        </p>
      )}
    </div>
  );
}
