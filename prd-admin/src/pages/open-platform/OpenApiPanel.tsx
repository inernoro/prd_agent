import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { apiRequest } from '@/services/real/apiClient';
import { toast } from '@/lib/toast';
import { RefreshCw, ShieldAlert, Plug, X, Settings2, Activity, Copy, Search } from 'lucide-react';

/**
 * 开放平台 - 开放接口（OpenAI 兼容）对外网关。
 *
 * 设计哲学（趋近 OpenRouter）：主列表极简（一眼看清每个客户用什么/用多少），
 * 配置与调试收进「管理」抽屉（渐进式披露）。抽屉含两段：① 配置（模型白名单 + 限额）；
 * ② 调用日志/调试（按 Key 拉最近请求，含 requestId 可回溯，给"某时刻给某客户排障"用）。
 */

interface BindingRow {
  keyId: string;
  name: string;
  ownerName: string;
  isActive: boolean;
  chatModels: string[];
  imageModels: string[];
  chatResolvedModel: string | null;
  imageResolvedModel: string | null;
  chatIsFallback: boolean;
  dailyTokenQuota: number | null;
  dailyRequestQuota: number | null;
  rateLimitPerMin: number | null;
  todayRequests: number;
  todayTokens: number;
}
interface Pool { id: string; name: string; code: string; modelType: string; isDefault: boolean; models: string[]; }

export default function OpenApiPanel({ onActionsReady }: { onActionsReady?: (a: React.ReactNode) => void }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<BindingRow[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [detail, setDetail] = useState<BindingRow | null>(null);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [b, p] = await Promise.all([
        apiRequest<BindingRow[]>('/api/open-api/bindings', { auth: true }),
        apiRequest<Pool[]>('/api/open-api/pools', { auth: true }),
      ]);
      if (b.success && b.data) setRows(b.data);
      else if (!b.success) toast.error(b.error?.message ?? '加载失败');
      if (p.success && p.data) setPools(p.data);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    onActionsReady?.(<Button variant="ghost" onClick={load} disabled={loading}><RefreshCw size={14} /> 刷新</Button>);
  }, [onActionsReady, load, loading]);

  const chatOptions = Array.from(new Set(pools.filter((p) => p.modelType === 'chat').flatMap((p) => p.models)));
  const imageOptions = Array.from(new Set(pools.filter((p) => p.modelType === 'generation').flatMap((p) => p.models)));

  const totalReq = rows.reduce((s, r) => s + r.todayRequests, 0);
  const totalTok = rows.reduce((s, r) => s + r.todayTokens, 0);
  const configured = rows.filter((r) => r.chatModels.length > 0 || r.imageModels.length > 0).length;
  const filtered = q.trim() ? rows.filter((r) => (r.name + r.ownerName).toLowerCase().includes(q.trim().toLowerCase())) : rows;

  if (loading) return <MapSectionLoader text="正在加载开放接口…" />;

  return (
    <div data-tour-id="open-api-root" className="h-full min-h-0 flex flex-col gap-4" style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
      {/* 概览：说明 + 指标 */}
      <div className="flex flex-col lg:flex-row gap-3">
        <GlassCard className="p-4 flex items-start gap-3 flex-1">
          <Plug size={18} className="text-white/50 mt-0.5 shrink-0" />
          <div className="text-[13px] text-white/70 leading-relaxed">
            <div className="font-medium text-white/85 mb-1">开放接口 · OpenAI 兼容对外网关</div>
            外部客户用标准 OpenAI 方式接入，Base URL <code className="px-1 rounded bg-white/[0.06]">/api/v1</code>，密钥 <code className="px-1 rounded bg-white/[0.06]">sk-ak-*</code>。点「管理」配模型白名单 / 限额，并查该客户调用日志排障。
          </div>
        </GlassCard>
        <div data-tour-id="open-api-stats" className="grid grid-cols-3 gap-2.5 lg:w-[420px] shrink-0">
          <StatTile label="授权 Key" value={String(rows.length)} sub={`${configured} 个已配白名单`} />
          <StatTile label="今日请求" value={totalReq.toLocaleString()} sub="全部客户合计" />
          <StatTile label="今日 token" value={fmtK(totalTok)} sub="全部客户合计" />
        </div>
      </div>

      <div data-tour-id="open-api-list" className="flex flex-col gap-4">
      {rows.length === 0 ? (
        <GlassCard className="p-10 flex flex-col items-center justify-center text-center gap-3">
          <ShieldAlert size={32} className="text-white/30" />
          <div className="text-white/70 text-sm">还没有授予 <code className="px-1 rounded bg-white/[0.06]">open-api:call</code> 的 Key</div>
          <div className="text-white/45 text-xs max-w-md">在「接入 AI」弹窗创建 sk-ak-* Key 并勾选 open-api:call scope 后即可在此管理。</div>
        </GlassCard>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <div className="relative flex-1 max-w-xs">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索 Key / 客户…"
                className="w-full bg-white/[0.04] border border-white/[0.1] rounded-lg pl-8 pr-3 py-1.5 text-xs text-white/85 focus:outline-none focus:border-white/25" />
            </div>
            <span className="text-white/35 text-xs">{filtered.length} / {rows.length}</span>
          </div>

          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))' }}>
            {filtered.map((r) => <KeyCard key={r.keyId} r={r} onManage={() => setDetail(r)} />)}
          </div>
        </>
      )}
      </div>

      {detail && (
        <KeyDetailDrawer row={detail} chatOptions={chatOptions} imageOptions={imageOptions}
          onClose={() => setDetail(null)} onSaved={() => { setDetail(null); load(); }} />
      )}
    </div>
  );
}

function fmtK(n: number): string { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <GlassCard className="p-3 flex flex-col justify-center">
      <div className="text-white/40 text-[11px]">{label}</div>
      <div className="text-white/90 text-lg font-semibold leading-tight mt-0.5">{value}</div>
      {sub && <div className="text-white/30 text-[10px] mt-0.5 truncate">{sub}</div>}
    </GlassCard>
  );
}

const AVATAR_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444'];
function avatarColor(s: string): string { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return AVATAR_COLORS[h % AVATAR_COLORS.length]; }

function KeyCard({ r, onManage }: { r: BindingRow; onManage: () => void }) {
  const color = avatarColor(r.keyId);
  const defaultModel = r.chatModels.length ? r.chatModels[0] : (r.chatResolvedModel ?? '默认池');
  const extra = Math.max(0, r.chatModels.length - 1);
  const quotaPct = r.dailyTokenQuota ? Math.min(100, Math.round((r.todayTokens / r.dailyTokenQuota) * 100)) : null;
  return (
    <GlassCard className="p-4 flex flex-col gap-3 transition-colors hover:border-white/20">
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center text-[13px] font-semibold shrink-0"
          style={{ background: `${color}26`, color }}>{(r.name || '?').slice(0, 1).toUpperCase()}</div>
        <div className="min-w-0 flex-1">
          <div className="text-white/90 text-sm truncate">{r.name}</div>
          <div className="text-white/40 text-xs truncate">{r.ownerName}</div>
        </div>
        <span className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded ${r.isActive ? 'text-emerald-300/90 bg-emerald-500/10' : 'text-white/40 bg-white/[0.05]'}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${r.isActive ? 'bg-emerald-400' : 'bg-white/30'}`} />{r.isActive ? '启用' : '禁用'}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/[0.06] text-white/75 text-[11px]">
          {r.chatModels.length ? <span className="text-emerald-400 text-[10px]">默认</span> : <span className="text-white/35 text-[10px]">默认池</span>}
          <span className="truncate max-w-[150px]">{defaultModel}</span>
        </span>
        {extra > 0 && <span className="px-1.5 py-0.5 rounded bg-white/[0.04] text-white/45 text-[11px]">+{extra}</span>}
        {r.chatIsFallback && <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 text-[11px]">降级</span>}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-white/40">今日用量</span>
          <span className="text-white/70">{r.todayRequests} 次 · {r.todayTokens.toLocaleString()} tok</span>
        </div>
        {quotaPct !== null && (
          <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${quotaPct}%`, background: quotaPct >= 90 ? '#ef4444' : quotaPct >= 70 ? '#f59e0b' : '#10b981' }} />
          </div>
        )}
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-white/[0.06]">
        <span className="text-white/35 text-[11px]">限速 {r.rateLimitPerMin ? `${r.rateLimitPerMin}/min` : '默认'}</span>
        <Button variant="ghost" onClick={onManage}><Settings2 size={13} /> 管理</Button>
      </div>
    </GlassCard>
  );
}


interface LogRow {
  requestId: string; endpoint: string; requestedModel: string | null; resolvedModel: string | null;
  resolvedPool: string | null; isFallback: boolean; promptTokens: number | null; completionTokens: number | null;
  statusCode: number; errorCode: string | null; durationMs: number; createdAt: string;
}


function KeyDetailDrawer({ row, chatOptions, imageOptions, onClose, onSaved }: {
  row: BindingRow; chatOptions: string[]; imageOptions: string[]; onClose: () => void; onSaved: () => void;
}) {
  const [tab, setTab] = useState<'config' | 'logs'>('config');
  const [chat, setChat] = useState<string[]>([...row.chatModels]);
  const [image, setImage] = useState<string[]>([...row.imageModels]);
  const [rate, setRate] = useState(row.rateLimitPerMin != null ? String(row.rateLimitPerMin) : '');
  const [dayReq, setDayReq] = useState(row.dailyRequestQuota != null ? String(row.dailyRequestQuota) : '');
  const [dayTok, setDayTok] = useState(row.dailyTokenQuota != null ? String(row.dailyTokenQuota) : '');
  const [saving, setSaving] = useState(false);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShown(true), 10);
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onEsc);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onEsc); };
  }, [onClose]);

  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const res = await apiRequest<LogRow[]>(`/api/open-api/logs?keyId=${encodeURIComponent(row.keyId)}&limit=100`, { auth: true });
      if (res.success && res.data) setLogs(res.data);
      else if (!res.success) toast.error(res.error?.message ?? '加载日志失败');
    } finally { setLogsLoading(false); }
  }, [row.keyId]);

  useEffect(() => { if (tab === 'logs') loadLogs(); }, [tab, loadLogs]);

  const toNum = (s: string) => { const t = s.trim(); if (!t) return null; const n = Number(t); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null; };

  const save = async () => {
    setSaving(true);
    try {
      const res = await apiRequest(`/api/open-api/bindings/${row.keyId}`, {
        method: 'PUT', auth: true,
        body: { chatModels: chat, imageModels: image, rateLimitPerMin: toNum(rate), dailyRequestQuota: toNum(dayReq), dailyTokenQuota: toNum(dayTok) },
      });
      if (res.success) { toast.success('已保存'); onSaved(); }
      else toast.error(res.error?.message ?? '保存失败');
    } finally { setSaving(false); }
  };

  const totalToday = `${row.todayRequests} 次 · ${row.todayTokens.toLocaleString()} tok`;

  const drawer = (
    <div className="fixed inset-0 z-[100] flex justify-end"
      style={{ background: shown ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0)', transition: 'background 200ms' }}
      onClick={onClose}>
      <div
        className="h-full bg-[#161618] border-l border-white/10 flex flex-col"
        style={{ width: 'min(560px, 100vw)', boxShadow: '-24px 0 60px rgba(0,0,0,0.45)', transform: shown ? 'translateX(0)' : 'translateX(100%)', transition: 'transform 220ms cubic-bezier(0.22,1,0.36,1)' }}
        onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="px-6 py-4 border-b border-white/[0.08] shrink-0 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-white/90 text-[15px] font-medium truncate">{row.name}</div>
            <div className="text-white/40 text-xs mt-1 flex items-center gap-2">
              <span>{row.ownerName}</span>
              <span className={`inline-flex items-center gap-1 ${row.isActive ? 'text-emerald-400/80' : 'text-white/35'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${row.isActive ? 'bg-emerald-400' : 'bg-white/30'}`} />
                {row.isActive ? '启用' : '已禁用'}
              </span>
              <span className="text-white/30">今日 {totalToday}</span>
            </div>
          </div>
          <button className="text-white/40 hover:text-white/85 -mr-1 mt-0.5" onClick={onClose}><X size={18} /></button>
        </div>

        {/* Segmented tabs */}
        <div className="px-6 pt-4 shrink-0">
          <div className="inline-flex rounded-lg bg-white/[0.05] p-0.5 text-xs">
            {([['config', '配置', Settings2], ['logs', '调用日志 / 调试', Activity]] as const).map(([k, label, Icon]) => (
              <button key={k} onClick={() => setTab(k)}
                className={`px-3.5 py-1.5 rounded-md flex items-center gap-1.5 transition-colors ${tab === k ? 'bg-white/[0.10] text-white/90' : 'text-white/45 hover:text-white/70'}`}>
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>
        </div>

        {/* Scroll content */}
        <div className="flex-1 px-6 py-5" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {tab === 'config' ? (
            <div className="flex flex-col gap-5">
              <Section title="模型白名单" hint="客户用 model 字段在白名单内自选；第一个为默认；留空=走默认池">
                <div className="flex flex-col gap-4">
                  <div>
                    <div className="text-white/55 text-xs mb-2">Chat（/v1/chat/completions）</div>
                    <WhitelistPicker options={chatOptions} value={chat} onChange={setChat} />
                  </div>
                  <div className="h-px bg-white/[0.06]" />
                  <div>
                    <div className="text-white/55 text-xs mb-2">生图（/v1/images/generations）</div>
                    <WhitelistPicker options={imageOptions} value={image} onChange={setImage} />
                  </div>
                </div>
              </Section>

              <Section title="调用限额" hint="留空 = 不限。超限返回 429 + Retry-After / X-RateLimit-*">
                <div className="grid grid-cols-3 gap-3">
                  <NumField label="每分钟" unit="次" value={rate} onChange={setRate} />
                  <NumField label="每日请求" unit="次" value={dayReq} onChange={setDayReq} />
                  <NumField label="每日 token" unit="tok" value={dayTok} onChange={setDayTok} />
                </div>
              </Section>
            </div>
          ) : (
            <div className="flex flex-col gap-3 h-full">
              <div className="flex items-center justify-between shrink-0">
                <div className="text-white/45 text-xs">最近调用 · 客户报错给响应 id 即可凭 requestId 定位</div>
                <Button variant="ghost" onClick={loadLogs} disabled={logsLoading}><RefreshCw size={13} /> 刷新</Button>
              </div>
              {logsLoading ? <MapSectionLoader text="加载日志…" />
                : logs.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center text-white/35 text-xs gap-2 py-12">
                    <Activity size={26} className="text-white/20" />暂无调用记录
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {logs.map((l) => (
                      <div key={l.requestId} className="rounded-lg bg-white/[0.03] border border-white/[0.06] px-3 py-2 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${l.statusCode >= 400 ? 'bg-rose-500/15 text-rose-300' : 'bg-emerald-500/15 text-emerald-300'}`}>{l.statusCode}</span>
                            <span className="text-white/55">{l.endpoint}</span>
                            {l.errorCode && <span className="text-rose-300/80">{l.errorCode}</span>}
                            {l.isFallback && <span className="text-amber-400">降级</span>}
                          </div>
                          <span className="text-white/35 shrink-0">{new Date(l.createdAt).toLocaleString('zh-CN', { hour12: false }).slice(5, 17)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-2 mt-1.5 text-white/45">
                          <span className="truncate">
                            <span className="text-white/35">{l.requestedModel ?? '(默认)'}</span>
                            <span className="text-white/25"> → </span>
                            <span className="text-white/70">{l.resolvedModel ?? '—'}</span>
                          </span>
                          <span className="shrink-0 flex items-center gap-3">
                            <span>{(l.promptTokens ?? 0) + (l.completionTokens ?? 0) || 0} tok</span>
                            <span>{l.durationMs}ms</span>
                            <button className="inline-flex items-center gap-1 hover:text-white/80" title="复制 requestId"
                              onClick={() => { navigator.clipboard?.writeText(l.requestId); toast.success('已复制 requestId'); }}>
                              {l.requestId.slice(0, 8)}<Copy size={11} />
                            </button>
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
            </div>
          )}
        </div>

        {/* Sticky footer (config only) */}
        {tab === 'config' && (
          <div className="px-6 py-3.5 border-t border-white/[0.08] shrink-0 flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>取消</Button>
            <Button variant="primary" onClick={save} disabled={saving}>{saving ? <MapSpinner size={14} /> : null} 保存配置</Button>
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(drawer, document.body);
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.015] p-4">
      <div className="text-white/80 text-[13px] font-medium">{title}</div>
      {hint && <div className="text-white/35 text-xs mt-0.5 mb-3">{hint}</div>}
      {!hint && <div className="mb-3" />}
      {children}
    </div>
  );
}

function NumField({ label, unit, value, onChange }: { label: string; unit: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-white/45 text-xs">{label}</span>
      <div className="flex items-center bg-white/[0.04] border border-white/[0.12] rounded-md focus-within:border-white/30">
        <input type="number" min={1} value={value} placeholder="不限" onChange={(e) => onChange(e.target.value)}
          className="bg-transparent px-2 py-1.5 text-white/85 text-xs w-full focus:outline-none" />
        <span className="text-white/30 text-[10px] pr-2 shrink-0">{unit}</span>
      </div>
    </label>
  );
}

function WhitelistPicker({ options, value, onChange }: { options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  const remaining = options.filter((o) => !value.includes(o));
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {value.length === 0 && <span className="text-white/30 text-xs py-1">未配置 · 走默认池</span>}
        {value.map((m, i) => (
          <span key={m} className="inline-flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-md bg-white/[0.07] border border-white/[0.08] text-white/80 text-xs">
            {i === 0 && <span className="text-emerald-400 text-[10px] font-medium">默认</span>}
            {m}
            <button type="button" className="text-white/35 hover:text-white/85" onClick={() => onChange(value.filter((x) => x !== m))}><X size={11} /></button>
          </span>
        ))}
      </div>
      {remaining.length > 0 && (
        <select value="" onChange={(e) => { if (e.target.value) onChange([...value, e.target.value]); }}
          className="bg-white/[0.04] border border-white/[0.12] rounded-md px-2 py-1.5 text-white/70 text-xs w-full focus:outline-none focus:border-white/30">
          <option value="" className="bg-[#1E1F20]">+ 添加模型…</option>
          {remaining.map((o) => <option key={o} value={o} className="bg-[#1E1F20]">{o}</option>)}
        </select>
      )}
    </div>
  );
}
