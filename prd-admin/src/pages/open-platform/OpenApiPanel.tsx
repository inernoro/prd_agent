import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { apiRequest } from '@/services/real/apiClient';
import { toast } from '@/lib/toast';
import { RefreshCw, ShieldAlert, Plug, X, Settings2, Activity, Copy } from 'lucide-react';

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

  if (loading) return <MapSectionLoader text="正在加载开放接口…" />;

  return (
    <div className="h-full min-h-0 flex flex-col gap-4" style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
      <GlassCard className="p-4">
        <div className="flex items-start gap-3">
          <Plug size={18} className="text-white/50 mt-0.5 shrink-0" />
          <div className="text-[13px] text-white/70 leading-relaxed">
            <div className="font-medium text-white/85 mb-1">开放接口 · OpenAI 兼容对外网关</div>
            外部客户用标准 OpenAI 方式接入，Base URL <code className="px-1 rounded bg-white/[0.06]">/api/v1</code>，密钥 <code className="px-1 rounded bg-white/[0.06]">sk-ak-*</code>（scope <code className="px-1 rounded bg-white/[0.06]">open-api:call</code>）。
            点「管理」配模型白名单 / 限额，并查该客户调用日志排障。
          </div>
        </div>
      </GlassCard>

      {rows.length === 0 ? (
        <GlassCard className="p-10 flex flex-col items-center justify-center text-center gap-3">
          <ShieldAlert size={32} className="text-white/30" />
          <div className="text-white/70 text-sm">还没有授予 <code className="px-1 rounded bg-white/[0.06]">open-api:call</code> 的 Key</div>
          <div className="text-white/45 text-xs max-w-md">在「接入 AI」弹窗创建 sk-ak-* Key 并勾选 open-api:call scope 后即可在此管理。</div>
        </GlassCard>
      ) : (
        <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
          {rows.map((r) => (
            <GlassCard key={r.keyId} className="p-3.5 flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-white/90 text-sm truncate">{r.name}</div>
                  <div className="text-white/40 text-xs truncate">{r.ownerName}{r.isActive ? '' : ' · 已禁用'}</div>
                </div>
                <Button variant="ghost" onClick={() => setDetail(r)}><Settings2 size={13} /> 管理</Button>
              </div>
              <div className="text-xs text-white/55 flex flex-col gap-0.5">
                <div className="flex items-center gap-1">
                  <span className="text-white/35 w-12 shrink-0">默认</span>
                  <span className="truncate">{r.chatModels.length ? r.chatModels[0] : (r.chatResolvedModel ?? '默认池')}</span>
                  {r.chatIsFallback && <span className="text-amber-400">降级</span>}
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-white/35 w-12 shrink-0">白名单</span>
                  <span className="truncate text-white/45">{r.chatModels.length ? `${r.chatModels.length} 个模型` : '未配置（默认池）'}</span>
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-white/35">今日 <span className="text-white/70">{r.todayRequests}</span> 次 / <span className="text-white/70">{r.todayTokens.toLocaleString()}</span> tok</span>
                  <span className="text-white/35">限速 {r.rateLimitPerMin ?? '默认'}/min</span>
                </div>
              </div>
            </GlassCard>
          ))}
        </div>
      )}

      {detail && (
        <KeyDetailDrawer
          row={detail}
          chatOptions={chatOptions}
          imageOptions={imageOptions}
          onClose={() => setDetail(null)}
          onSaved={() => { setDetail(null); load(); }}
        />
      )}
    </div>
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

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
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

  const modal = (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={onClose}>
      <div
        className="rounded-xl border border-white/10 bg-[#131314] flex flex-col w-[min(880px,94vw)]"
        style={{ height: '85vh', maxHeight: '85vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.08] shrink-0">
          <div className="min-w-0">
            <div className="text-white/90 text-sm">{row.name}</div>
            <div className="text-white/40 text-xs">{row.ownerName}</div>
          </div>
          <button className="text-white/40 hover:text-white/80" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="flex gap-1 px-5 pt-3 shrink-0">
          {([['config', '配置', Settings2], ['logs', '调用日志 / 调试', Activity]] as const).map(([k, label, Icon]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-3 py-1.5 rounded-md text-xs flex items-center gap-1.5 ${tab === k ? 'bg-white/[0.08] text-white/90' : 'text-white/50 hover:text-white/75'}`}
            >
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>

        <div className="flex-1 px-5 py-4" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {tab === 'config' ? (
            <div className="flex flex-col gap-5 text-[13px]">
              <Field label="Chat 模型白名单" hint="客户用 model 字段在此集合内自选；第一个为默认；留空=默认池">
                <WhitelistPicker options={chatOptions} value={chat} onChange={setChat} />
              </Field>
              <Field label="生图模型白名单" hint="同上，用于 /v1/images/generations">
                <WhitelistPicker options={imageOptions} value={image} onChange={setImage} />
              </Field>
              <Field label="限额（留空=不限）">
                <div className="flex items-center gap-3 flex-wrap">
                  <LabeledNum label="每分钟" value={rate} onChange={setRate} />
                  <LabeledNum label="每日请求" value={dayReq} onChange={setDayReq} />
                  <LabeledNum label="每日 token" value={dayTok} onChange={setDayTok} wide />
                </div>
              </Field>
              <div className="flex justify-end">
                <Button variant="primary" onClick={save} disabled={saving}>{saving ? <MapSpinner size={14} /> : null} 保存配置</Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="text-white/45 text-xs">该 Key 最近调用（按 requestId 可回溯；客户报错给 id 直接定位）</div>
                <Button variant="ghost" onClick={loadLogs} disabled={logsLoading}><RefreshCw size={13} /> 刷新</Button>
              </div>
              {logsLoading ? <MapSectionLoader text="加载日志…" /> : logs.length === 0 ? (
                <div className="text-white/40 text-xs py-10 text-center">暂无调用记录</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="w-full text-[12px]" style={{ minWidth: 720 }}>
                    <thead>
                      <tr className="text-white/40 text-left border-b border-white/[0.08]">
                        <th className="px-2 py-2 font-medium">时间</th>
                        <th className="px-2 py-2 font-medium">端点</th>
                        <th className="px-2 py-2 font-medium">请求→解析模型</th>
                        <th className="px-2 py-2 font-medium">状态</th>
                        <th className="px-2 py-2 font-medium">tokens</th>
                        <th className="px-2 py-2 font-medium">耗时</th>
                        <th className="px-2 py-2 font-medium">requestId</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.map((l) => (
                        <tr key={l.requestId} className="border-b border-white/[0.05]">
                          <td className="px-2 py-1.5 text-white/55 whitespace-nowrap">{new Date(l.createdAt).toLocaleString('zh-CN', { hour12: false }).slice(5)}</td>
                          <td className="px-2 py-1.5 text-white/60">{l.endpoint}</td>
                          <td className="px-2 py-1.5 text-white/70">
                            <span className="text-white/40">{l.requestedModel ?? '—'}</span>
                            <span className="text-white/30"> → </span>
                            {l.resolvedModel ?? '—'}
                            {l.isFallback && <span className="text-amber-400 ml-1">降级</span>}
                          </td>
                          <td className="px-2 py-1.5">
                            <span className={l.statusCode >= 400 ? 'text-rose-400' : 'text-emerald-400'}>{l.statusCode}</span>
                            {l.errorCode && <span className="text-rose-300/70 ml-1">{l.errorCode}</span>}
                          </td>
                          <td className="px-2 py-1.5 text-white/55">{(l.promptTokens ?? 0) + (l.completionTokens ?? 0) || '—'}</td>
                          <td className="px-2 py-1.5 text-white/45">{l.durationMs}ms</td>
                          <td className="px-2 py-1.5 text-white/40">
                            <button className="inline-flex items-center gap-1 hover:text-white/70" title="复制 requestId"
                              onClick={() => { navigator.clipboard?.writeText(l.requestId); toast.success('已复制 requestId'); }}>
                              {l.requestId.slice(0, 8)}… <Copy size={11} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-white/75">{label}</div>
      {hint && <div className="text-white/35 text-xs">{hint}</div>}
      {children}
    </div>
  );
}

function LabeledNum({ label, value, onChange, wide }: { label: string; value: string; onChange: (v: string) => void; wide?: boolean }) {
  return (
    <label className="flex items-center gap-1.5 text-white/55">
      {label}
      <input type="number" min={1} value={value} placeholder="∞" onChange={(e) => onChange(e.target.value)}
        className={`bg-white/[0.04] border border-white/[0.12] rounded-md px-2 py-1 text-white/85 text-xs focus:outline-none focus:border-white/30 ${wide ? 'w-24' : 'w-16'}`} />
    </label>
  );
}

function WhitelistPicker({ options, value, onChange }: { options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  const remaining = options.filter((o) => !value.includes(o));
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-1.5">
        {value.length === 0 && <span className="text-white/35 text-xs">未配置（走默认池）</span>}
        {value.map((m, i) => (
          <span key={m} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white/[0.07] text-white/80 text-xs">
            {i === 0 && <span className="text-emerald-400 text-[10px]" title="客户默认模型">默认</span>}
            {m}
            <button type="button" className="text-white/40 hover:text-white/80" onClick={() => onChange(value.filter((x) => x !== m))}><X size={11} /></button>
          </span>
        ))}
      </div>
      <select value="" onChange={(e) => { if (e.target.value) onChange([...value, e.target.value]); }}
        className="bg-white/[0.04] border border-white/[0.12] rounded-md px-2 py-1 text-white/70 text-xs w-[240px] focus:outline-none focus:border-white/30">
        <option value="" className="bg-[#1E1F20]">+ 添加模型…</option>
        {remaining.map((o) => <option key={o} value={o} className="bg-[#1E1F20]">{o}</option>)}
      </select>
    </div>
  );
}
