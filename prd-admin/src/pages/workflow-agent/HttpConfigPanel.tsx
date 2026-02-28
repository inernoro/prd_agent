import { useState, useMemo, useCallback } from 'react';
import { parseCurl, toCurl, headersToJson, prettyBody } from './parseCurl';

// ═══════════════════════════════════════════════════════════════
// HttpConfigPanel — Postman 风格的 HTTP 请求配置器
//
// 布局：
//   ┌─────────────────────────────────────────────────┐
//   │ [GET ▾] [http://example.com/api?key=val     ]   │
//   ├─────────────────────────────────────────────────┤
//   │ Params(2) │ Headers(3) │ Body │ cURL            │
//   ├─────────────────────────────────────────────────┤
//   │ Key-Value table / Body editor / cURL panel      │
//   └─────────────────────────────────────────────────┘
// ═══════════════════════════════════════════════════════════════

// ── 数据结构 ──

interface KvEntry {
  key: string;
  value: string;
  enabled: boolean;
}

// ── URL 解析工具 ──

function parseUrlParams(url: string): { base: string; params: KvEntry[] } {
  if (!url) return { base: '', params: [] };
  try {
    const idx = url.indexOf('?');
    if (idx === -1) return { base: url, params: [] };
    const base = url.substring(0, idx);
    const search = url.substring(idx + 1);
    const params: KvEntry[] = [];
    for (const pair of search.split('&')) {
      if (!pair) continue;
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) {
        params.push({ key: decodeURIComponent(pair), value: '', enabled: true });
      } else {
        params.push({
          key: decodeURIComponent(pair.substring(0, eqIdx)),
          value: decodeURIComponent(pair.substring(eqIdx + 1)),
          enabled: true,
        });
      }
    }
    return { base, params };
  } catch {
    return { base: url, params: [] };
  }
}

function rebuildUrl(base: string, params: KvEntry[]): string {
  const active = params.filter(p => p.enabled && p.key.trim());
  if (active.length === 0) return base;
  const qs = active
    .map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
    .join('&');
  return `${base}?${qs}`;
}

// ── Headers JSON ↔ KvEntry ──

function parseHeadersToKv(json: string): KvEntry[] {
  if (!json?.trim()) return [];
  try {
    const obj = JSON.parse(json);
    return Object.entries(obj).map(([key, value]) => ({
      key,
      value: String(value ?? ''),
      enabled: true,
    }));
  } catch {
    return [];
  }
}

function serializeKvToHeaders(entries: KvEntry[]): string {
  const obj: Record<string, string> = {};
  for (const e of entries) {
    if (e.enabled && e.key.trim()) obj[e.key] = e.value;
  }
  return Object.keys(obj).length > 0 ? JSON.stringify(obj, null, 2) : '';
}

// ── HTTP 方法 ──

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const METHOD_COLORS: Record<string, string> = {
  GET: 'rgba(34,197,94,0.85)',
  POST: 'rgba(245,158,11,0.85)',
  PUT: 'rgba(59,130,246,0.85)',
  PATCH: 'rgba(168,85,247,0.85)',
  DELETE: 'rgba(239,68,68,0.85)',
  HEAD: 'rgba(34,197,94,0.6)',
  OPTIONS: 'rgba(107,114,128,0.85)',
};

// ── Tab 定义 ──

type TabKey = 'params' | 'headers' | 'body' | 'curl';

// ── Key-Value 编辑表格 ──

function KvTable({ entries, onChange, placeholder }: {
  entries: KvEntry[];
  onChange: (entries: KvEntry[]) => void;
  placeholder?: { key: string; value: string };
}) {
  // 确保末尾总有一行空行用于新增
  const rows = [...entries];
  const hasEmpty = rows.length === 0 || (rows[rows.length - 1].key.trim() !== '' || rows[rows.length - 1].value.trim() !== '');
  if (hasEmpty) rows.push({ key: '', value: '', enabled: true });

  function update(idx: number, field: 'key' | 'value' | 'enabled', val: string | boolean) {
    const next = [...entries];
    // 如果编辑的是尾部空行，先推一条新条目
    if (idx >= entries.length) {
      next.push({ key: '', value: '', enabled: true });
    }
    if (field === 'enabled') {
      next[idx] = { ...next[idx], enabled: val as boolean };
    } else {
      next[idx] = { ...next[idx], [field]: val as string };
    }
    onChange(next);
  }

  function remove(idx: number) {
    const next = entries.filter((_, i) => i !== idx);
    onChange(next);
  }

  return (
    <div className="border rounded-[8px] overflow-hidden" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
      {/* 表头 */}
      <div
        className="grid grid-cols-[28px_1fr_1fr_28px] text-[10px] font-medium px-1"
        style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}
      >
        <div className="py-1.5 text-center" />
        <div className="py-1.5 px-2">Key</div>
        <div className="py-1.5 px-2">Value</div>
        <div className="py-1.5" />
      </div>
      {/* 行 */}
      {rows.map((row, idx) => {
        const isPlaceholder = idx >= entries.length;
        return (
          <div
            key={idx}
            className="grid grid-cols-[28px_1fr_1fr_28px] items-center px-1"
            style={{
              borderBottom: idx < rows.length - 1 ? '1px solid rgba(255,255,255,0.04)' : undefined,
              opacity: isPlaceholder ? 0.5 : row.enabled ? 1 : 0.4,
            }}
          >
            {/* checkbox */}
            <div className="flex justify-center">
              {!isPlaceholder ? (
                <input
                  type="checkbox"
                  checked={row.enabled}
                  onChange={(e) => update(idx, 'enabled', e.target.checked)}
                  className="w-3 h-3 rounded accent-current"
                />
              ) : (
                <span className="w-3 h-3" />
              )}
            </div>
            {/* key */}
            <input
              className="bg-transparent outline-none px-2 py-1.5 text-[11px] w-full font-mono"
              style={{ color: 'var(--text-primary)' }}
              value={row.key}
              onChange={(e) => update(idx, 'key', e.target.value)}
              placeholder={isPlaceholder ? (placeholder?.key || 'Key') : undefined}
            />
            {/* value */}
            <input
              className="bg-transparent outline-none px-2 py-1.5 text-[11px] w-full font-mono"
              style={{ color: 'var(--text-secondary)' }}
              value={row.value}
              onChange={(e) => update(idx, 'value', e.target.value)}
              placeholder={isPlaceholder ? (placeholder?.value || 'Value') : undefined}
            />
            {/* delete */}
            <div className="flex justify-center">
              {!isPlaceholder && (
                <button
                  onClick={() => remove(idx)}
                  className="surface-row w-5 h-5 rounded flex items-center justify-center text-[11px] transition-colors"
                  style={{ color: 'var(--text-muted)' }}
                >
                  ×
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 主组件
// ═══════════════════════════════════════════════════════════════

export function HttpConfigPanel({ values, onBatchChange, disabled }: {
  values: Record<string, string>;
  onBatchChange: (changes: Record<string, string>) => void;
  disabled?: boolean;
}) {
  const [activeTab, setActiveTab] = useState<TabKey>('params');
  const [curlRaw, setCurlRaw] = useState('');
  const [curlError, setCurlError] = useState('');
  const [curlCopied, setCurlCopied] = useState(false);

  // ── 解析当前值 ──
  const method = values.method || 'GET';
  const url = values.url || '';
  const { base: urlBase, params: urlParams } = useMemo(() => parseUrlParams(url), [url]);
  const headerEntries = useMemo(() => parseHeadersToKv(values.headers || ''), [values.headers]);

  const paramCount = urlParams.filter(p => p.key.trim()).length;
  const headerCount = headerEntries.filter(e => e.key.trim()).length;

  // ── 更新方法 ──

  const setMethod = useCallback((m: string) => {
    onBatchChange({ method: m });
  }, [onBatchChange]);

  const setUrl = useCallback((u: string) => {
    onBatchChange({ url: u });
  }, [onBatchChange]);

  const setParams = useCallback((params: KvEntry[]) => {
    onBatchChange({ url: rebuildUrl(urlBase, params) });
  }, [onBatchChange, urlBase]);

  const setHeaders = useCallback((entries: KvEntry[]) => {
    onBatchChange({ headers: serializeKvToHeaders(entries) });
  }, [onBatchChange]);

  const setBody = useCallback((body: string) => {
    onBatchChange({ body });
  }, [onBatchChange]);

  // ── cURL 导入 ──
  function handleCurlImport() {
    setCurlError('');
    const parsed = parseCurl(curlRaw);
    if (!parsed) {
      setCurlError('无法解析，请粘贴有效的 curl 命令');
      return;
    }
    const batch: Record<string, string> = {};
    batch.url = parsed.url;
    batch.method = parsed.method;
    const h = headersToJson(parsed.headers);
    if (h) batch.headers = h;
    const b = prettyBody(parsed.body);
    if (b) batch.body = b;
    onBatchChange(batch);
    setCurlRaw('');
    setActiveTab('params');
  }

  // ── cURL 粘贴自动解析 ──
  function handleCurlPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    const parsed = parseCurl(text);
    if (parsed) {
      e.preventDefault();
      const batch: Record<string, string> = {};
      batch.url = parsed.url;
      batch.method = parsed.method;
      const h = headersToJson(parsed.headers);
      if (h) batch.headers = h;
      const b = prettyBody(parsed.body);
      if (b) batch.body = b;
      onBatchChange(batch);
      setCurlRaw('');
      setActiveTab('params');
    }
  }

  // ── cURL 导出 ──
  function handleCurlExport() {
    const cmd = toCurl({ url, method, headers: values.headers, body: values.body });
    navigator.clipboard.writeText(cmd).then(() => {
      setCurlCopied(true);
      setTimeout(() => setCurlCopied(false), 2000);
    });
  }

  // ── URL 输入框也支持粘贴 cURL ──
  function handleUrlPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text/plain');
    if (text && /^\s*curl[\s.]/i.test(text)) {
      const parsed = parseCurl(text);
      if (parsed) {
        e.preventDefault();
        const batch: Record<string, string> = {};
        batch.url = parsed.url;
        batch.method = parsed.method;
        const h = headersToJson(parsed.headers);
        if (h) batch.headers = h;
        const b = prettyBody(parsed.body);
        if (b) batch.body = b;
        onBatchChange(batch);
      }
    }
  }

  // ── Tab 数据 ──
  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: 'params', label: 'Params', count: paramCount || undefined },
    { key: 'headers', label: 'Headers', count: headerCount || undefined },
    { key: 'body', label: 'Body' },
    { key: 'curl', label: 'cURL' },
  ];

  const methodColor = METHOD_COLORS[method] || 'var(--text-primary)';

  return (
    <div className="space-y-0">
      {/* ── URL 栏 ── */}
      <div
        className="flex items-center gap-0 rounded-t-[10px] overflow-hidden"
        style={{ border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.03)' }}
      >
        {/* Method 下拉 */}
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          disabled={disabled}
          className="h-[36px] px-2.5 text-[12px] font-bold outline-none border-r bg-transparent"
          style={{ color: methodColor, borderColor: 'rgba(255,255,255,0.08)', minWidth: 80 }}
        >
          {HTTP_METHODS.map(m => (
            <option key={m} value={m} style={{ color: '#333', background: '#fff' }}>{m}</option>
          ))}
        </select>
        {/* URL 输入 */}
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onPaste={handleUrlPaste}
          disabled={disabled}
          placeholder="请求 URL（支持直接粘贴 cURL）"
          className="flex-1 h-[36px] px-3 text-[12px] font-mono outline-none bg-transparent"
          style={{ color: 'var(--text-primary)' }}
        />
      </div>

      {/* ── Tab 栏 ── */}
      <div
        className="flex items-center gap-0"
        style={{ borderLeft: '1px solid rgba(255,255,255,0.1)', borderRight: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.02)' }}
      >
        {tabs.map(tab => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className="px-3 py-2 text-[11px] font-medium relative transition-colors"
              style={{
                color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
                borderBottom: isActive ? '2px solid rgba(99,102,241,0.7)' : '2px solid transparent',
              }}
            >
              {tab.label}
              {tab.count != null && (
                <span
                  className="ml-1 text-[9px] px-1 rounded-full"
                  style={{ background: 'rgba(34,197,94,0.12)', color: 'rgba(34,197,94,0.85)' }}
                >
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Tab 内容 ── */}
      <div
        className="rounded-b-[10px] p-3"
        style={{ border: '1px solid rgba(255,255,255,0.1)', borderTop: 'none', background: 'rgba(0,0,0,0.1)' }}
      >
        {/* Params */}
        {activeTab === 'params' && (
          <div className="space-y-2">
            <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Query Parameters — 编辑后自动同步到 URL
            </div>
            <KvTable
              entries={urlParams}
              onChange={setParams}
              placeholder={{ key: 'parameter', value: 'value' }}
            />
          </div>
        )}

        {/* Headers */}
        {activeTab === 'headers' && (
          <div className="space-y-2">
            <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              请求头 — 取消勾选可临时禁用
            </div>
            <KvTable
              entries={headerEntries}
              onChange={setHeaders}
              placeholder={{ key: 'Header-Name', value: 'header value' }}
            />
          </div>
        )}

        {/* Body */}
        {activeTab === 'body' && (
          <div className="space-y-2">
            <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              请求体（JSON / Form Data / 原始文本）
            </div>
            <textarea
              value={values.body || ''}
              onChange={(e) => setBody(e.target.value)}
              disabled={disabled}
              placeholder='{"key": "value"}'
              rows={6}
              className="prd-field w-full px-3 py-2 rounded-[8px] text-[12px] outline-none resize-y font-mono"
            />
            <div className="flex items-center gap-2">
              <button
                className="text-[10px] px-2 py-0.5 rounded-[6px] transition-colors"
                style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
                onClick={() => {
                  try {
                    const formatted = JSON.stringify(JSON.parse(values.body || ''), null, 2);
                    setBody(formatted);
                  } catch { /* not json */ }
                }}
              >
                格式化 JSON
              </button>
            </div>
          </div>
        )}

        {/* cURL */}
        {activeTab === 'curl' && (
          <div className="space-y-3">
            {/* 导入 */}
            <div className="space-y-2">
              <div className="text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                导入 — 粘贴 cURL 命令自动解析
              </div>
              <textarea
                value={curlRaw}
                onChange={e => setCurlRaw(e.target.value)}
                onPaste={handleCurlPaste}
                placeholder={"curl 'https://api.example.com/data' \\\n  -H 'Authorization: Bearer token' \\\n  -X POST \\\n  -d '{\"key\":\"value\"}'"}
                rows={4}
                disabled={disabled}
                className="prd-field w-full px-3 py-2 rounded-[8px] text-[11px] outline-none resize-y font-mono"
                autoFocus
              />
              {curlError && (
                <p className="text-[10px]" style={{ color: 'rgba(239,68,68,0.85)' }}>{curlError}</p>
              )}
              <button
                onClick={handleCurlImport}
                disabled={!curlRaw.trim() || disabled}
                className="h-7 px-4 rounded-[8px] text-[11px] font-semibold transition-colors disabled:opacity-40"
                style={{
                  background: 'rgba(59,130,246,0.1)',
                  border: '1px solid rgba(59,130,246,0.2)',
                  color: 'rgba(59,130,246,0.9)',
                }}
              >
                ⚡ 解析并填入
              </button>
            </div>

            {/* 分割线 */}
            <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }} />

            {/* 导出 */}
            <div className="space-y-2">
              <div className="text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                导出 — 复制当前配置为 cURL 命令
              </div>
              <button
                onClick={handleCurlExport}
                disabled={!url || disabled}
                className="h-7 px-4 rounded-[8px] text-[11px] font-medium transition-colors disabled:opacity-30"
                style={{
                  background: curlCopied ? 'rgba(34,197,94,0.08)' : 'rgba(168,85,247,0.06)',
                  border: `1px solid ${curlCopied ? 'rgba(34,197,94,0.25)' : 'rgba(168,85,247,0.2)'}`,
                  color: curlCopied ? 'rgba(34,197,94,0.9)' : 'rgba(168,85,247,0.8)',
                }}
              >
                {curlCopied ? '✓ 已复制' : '⬆ 复制 cURL'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── 响应提取（非 tab 内容，独立字段） ── */}
      {values.responseExtract !== undefined && (
        <div className="mt-3">
          <label className="text-[10px] mb-1 block" style={{ color: 'var(--text-muted)' }}>
            响应提取 (JSONPath)
          </label>
          <input
            value={values.responseExtract || ''}
            onChange={(e) => onBatchChange({ responseExtract: e.target.value })}
            disabled={disabled}
            placeholder="$.data 或留空返回完整响应"
            className="prd-field w-full h-[32px] px-3 rounded-[8px] text-[12px] outline-none font-mono"
          />
        </div>
      )}
    </div>
  );
}
