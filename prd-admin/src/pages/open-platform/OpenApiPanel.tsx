import { useEffect, useState, useCallback } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { apiRequest } from '@/services/real/apiClient';
import { toast } from '@/lib/toast';
import { RefreshCw, ShieldAlert, Plug, X } from 'lucide-react';

/**
 * 开放平台 - 开放接口（OpenAI 兼容）对外网关：按 Key 模型白名单管理。
 *
 * 把「哪个客户(Key) 能用哪些模型」列出来（白名单），客户可在白名单内自选 model；
 * 白名单第一个为默认；空白名单=回落默认池。避免改总池误伤已绑定客户（用户明确诉求）。
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

interface EditState { chat: string[]; image: string[]; rate: string; dayReq: string; dayTok: string; }

interface OpenApiPanelProps { onActionsReady?: (actions: React.ReactNode) => void; }

export default function OpenApiPanel({ onActionsReady }: OpenApiPanelProps) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<BindingRow[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, EditState>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [bindRes, poolRes] = await Promise.all([
        apiRequest<BindingRow[]>('/api/open-api/bindings', { auth: true }),
        apiRequest<Pool[]>('/api/open-api/pools', { auth: true }),
      ]);
      if (bindRes.success && bindRes.data) {
        setRows(bindRes.data);
        const init: Record<string, EditState> = {};
        bindRes.data.forEach((r) => {
          init[r.keyId] = {
            chat: [...(r.chatModels ?? [])],
            image: [...(r.imageModels ?? [])],
            rate: r.rateLimitPerMin != null ? String(r.rateLimitPerMin) : '',
            dayReq: r.dailyRequestQuota != null ? String(r.dailyRequestQuota) : '',
            dayTok: r.dailyTokenQuota != null ? String(r.dailyTokenQuota) : '',
          };
        });
        setEdits(init);
      } else if (!bindRes.success) {
        toast.error(bindRes.error?.message ?? '加载绑定列表失败');
      }
      if (poolRes.success && poolRes.data) setPools(poolRes.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    onActionsReady?.(
      <Button variant="ghost" onClick={load} disabled={loading}><RefreshCw size={14} /> 刷新</Button>
    );
  }, [onActionsReady, load, loading]);

  const chatModelOptions = Array.from(new Set(pools.filter((p) => p.modelType === 'chat').flatMap((p) => p.models)));
  const imageModelOptions = Array.from(new Set(pools.filter((p) => p.modelType === 'generation').flatMap((p) => p.models)));

  const toNum = (s: string): number | null => {
    const t = s.trim(); if (!t) return null;
    const n = Number(t); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  };

  const save = async (keyId: string) => {
    const e = edits[keyId]; if (!e) return;
    setSavingId(keyId);
    try {
      const res = await apiRequest(`/api/open-api/bindings/${keyId}`, {
        method: 'PUT', auth: true,
        body: { chatModels: e.chat, imageModels: e.image, rateLimitPerMin: toNum(e.rate), dailyRequestQuota: toNum(e.dayReq), dailyTokenQuota: toNum(e.dayTok) },
      });
      if (res.success) { toast.success('已保存'); await load(); }
      else toast.error(res.error?.message ?? '保存失败');
    } finally { setSavingId(null); }
  };

  const dirty = (r: BindingRow) => {
    const e = edits[r.keyId]; if (!e) return false;
    const eqNum = (a: string, b: number | null) => (a.trim() ? Number(a) === b : b == null);
    return (
      e.chat.join('') !== (r.chatModels ?? []).join('') ||
      e.image.join('') !== (r.imageModels ?? []).join('') ||
      !eqNum(e.rate, r.rateLimitPerMin) || !eqNum(e.dayReq, r.dailyRequestQuota) || !eqNum(e.dayTok, r.dailyTokenQuota)
    );
  };

  if (loading) return <MapSectionLoader text="正在加载开放接口绑定…" />;

  return (
    <div className="h-full min-h-0 flex flex-col gap-4" style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
      <GlassCard className="p-4">
        <div className="flex items-start gap-3">
          <Plug size={18} className="text-white/50 mt-0.5 shrink-0" />
          <div className="text-[13px] text-white/70 leading-relaxed">
            <div className="font-medium text-white/85 mb-1">开放接口 · 对外网关模型白名单</div>
            外部调用方用标准 OpenAI 兼容方式接入：
            <code className="mx-1 px-1.5 py-0.5 rounded bg-white/[0.06] text-white/80">POST /api/v1/chat/completions</code>
            <code className="mx-1 px-1.5 py-0.5 rounded bg-white/[0.06] text-white/80">/api/v1/images/generations</code>。
            每个 <code className="px-1 rounded bg-white/[0.06]">sk-ak-*</code> Key（授予 <code className="px-1 rounded bg-white/[0.06]">open-api:call</code> scope）
            在此配置<span className="text-white/85">模型白名单</span>——客户可在白名单内用 <code className="px-1 rounded bg-white/[0.06]">model</code> 字段自选，<span className="text-white/85">第一个为默认</span>，填白名单外的报 400；
            白名单为空=回落默认池。改总池不会误伤已配置白名单的客户。
          </div>
        </div>
      </GlassCard>

      {rows.length === 0 ? (
        <GlassCard className="p-10 flex flex-col items-center justify-center text-center gap-3">
          <ShieldAlert size={32} className="text-white/30" />
          <div className="text-white/70 text-sm">还没有授予 <code className="px-1 rounded bg-white/[0.06]">open-api:call</code> 的 Key</div>
          <div className="text-white/45 text-xs max-w-md">
            在「接入 AI」弹窗创建 <code className="px-1 rounded bg-white/[0.06]">sk-ak-*</code> Key 并勾选 <code className="px-1 rounded bg-white/[0.06]">open-api:call</code> scope 后，
            即可在此为其配置模型白名单；未配置的 Key 默认走 default:chat / default:image。
          </div>
        </GlassCard>
      ) : (
        <GlassCard className="p-0">
          <div style={{ overflowX: 'auto' }}>
            <table className="w-full text-[13px]" style={{ minWidth: 1100 }}>
              <thead>
                <tr className="text-white/45 text-left border-b border-white/[0.08]">
                  <th className="px-3 py-3 font-medium">Key / 客户</th>
                  <th className="px-3 py-3 font-medium">Chat 白名单（第一个=默认）</th>
                  <th className="px-3 py-3 font-medium">生图白名单</th>
                  <th className="px-3 py-3 font-medium">默认解析</th>
                  <th className="px-3 py-3 font-medium" title="每分钟速率 / 每日请求 / 每日token，留空=不限">限额 <span className="text-white/30 font-normal">分·日req·日tok</span></th>
                  <th className="px-3 py-3 font-medium">今日用量</th>
                  <th className="px-3 py-3 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const e = edits[r.keyId] ?? { chat: [], image: [], rate: '', dayReq: '', dayTok: '' };
                  const patch = (p: Partial<EditState>) => setEdits((s) => ({ ...s, [r.keyId]: { ...e, ...p } }));
                  return (
                    <tr key={r.keyId} className="border-b border-white/[0.05] hover:bg-white/[0.02] align-top">
                      <td className="px-3 py-3">
                        <div className="text-white/85">{r.name}</div>
                        <div className="text-white/40 text-xs">{r.ownerName}{r.isActive ? '' : ' · 已禁用'}</div>
                      </td>
                      <td className="px-3 py-3"><WhitelistPicker options={chatModelOptions} value={e.chat} onChange={(v) => patch({ chat: v })} /></td>
                      <td className="px-3 py-3"><WhitelistPicker options={imageModelOptions} value={e.image} onChange={(v) => patch({ image: v })} /></td>
                      <td className="px-3 py-3">
                        <div className="text-white/70 text-xs flex items-center gap-1">
                          {r.chatResolvedModel ?? '—'}
                          {r.chatIsFallback && <span className="text-amber-400" title="专属模型不可用，已降级">降级</span>}
                        </div>
                        <div className="text-white/40 text-xs">{r.imageResolvedModel ?? '—'}</div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-1">
                          <LimitInput value={e.rate} onChange={(v) => patch({ rate: v })} />
                          <span className="text-white/30">/</span>
                          <LimitInput value={e.dayReq} onChange={(v) => patch({ dayReq: v })} />
                          <span className="text-white/30">/</span>
                          <LimitInput value={e.dayTok} onChange={(v) => patch({ dayTok: v })} wide />
                        </div>
                      </td>
                      <td className="px-3 py-3 text-xs text-white/60">
                        <div>{r.todayRequests} 次</div>
                        <div className="text-white/40">{r.todayTokens.toLocaleString()} tok</div>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <Button variant="ghost" disabled={!dirty(r) || savingId === r.keyId} onClick={() => save(r.keyId)}>
                          {savingId === r.keyId ? '保存中…' : '保存'}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </GlassCard>
      )}
    </div>
  );
}

function WhitelistPicker({ options, value, onChange }: { options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  const remaining = options.filter((o) => !value.includes(o));
  return (
    <div className="min-w-[220px]">
      <div className="flex flex-wrap gap-1 mb-1">
        {value.length === 0 && <span className="text-white/35 text-xs">默认池（未配置）</span>}
        {value.map((m, i) => (
          <span key={m} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/[0.07] text-white/80 text-xs">
            {i === 0 && <span className="text-emerald-400 text-[10px]" title="客户默认模型">默认</span>}
            {m}
            <button type="button" className="text-white/40 hover:text-white/80" onClick={() => onChange(value.filter((x) => x !== m))}><X size={11} /></button>
          </span>
        ))}
      </div>
      <select
        value=""
        onChange={(ev) => { if (ev.target.value) onChange([...value, ev.target.value]); }}
        className="bg-white/[0.04] border border-white/[0.12] rounded-md px-2 py-1 text-white/70 text-xs w-[200px] focus:outline-none focus:border-white/30"
      >
        <option value="" className="bg-[#1E1F20]">+ 添加模型…</option>
        {remaining.map((o) => <option key={o} value={o} className="bg-[#1E1F20]">{o}</option>)}
      </select>
    </div>
  );
}

function LimitInput({ value, onChange, wide }: { value: string; onChange: (v: string) => void; wide?: boolean }) {
  return (
    <input
      type="number" min={1} value={value} placeholder="∞"
      onChange={(ev) => onChange(ev.target.value)}
      className={`bg-white/[0.04] border border-white/[0.12] rounded-md px-1.5 py-1 text-white/85 text-xs focus:outline-none focus:border-white/30 ${wide ? 'w-20' : 'w-14'}`}
    />
  );
}
