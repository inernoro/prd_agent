import { useEffect, useState, useCallback } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { apiRequest } from '@/services/real/apiClient';
import { toast } from '@/lib/toast';
import { RefreshCw, ShieldAlert, Plug } from 'lucide-react';

/**
 * 开放平台 - OpenApi 对外网关绑定管理。
 *
 * 把「哪个客户(Key) 用哪个固定模型/池」列出来，避免改总池误伤客户（用户明确诉求）。
 * 支持为每个授予 open-api:call 的 Key 设置 chat / image 的固定模型池绑定；
 * 留空 = 回落默认池（default:chat / default:image）。
 */

interface BindingRow {
  keyId: string;
  name: string;
  ownerName: string;
  isActive: boolean;
  chatBinding: string | null;
  imageBinding: string | null;
  chatResolvedModel: string | null;
  chatResolutionType: string | null;
  chatIsFallback: boolean;
  imageResolvedModel: string | null;
  imageResolutionType: string | null;
  dailyTokenQuota: number | null;
  dailyRequestQuota: number | null;
  rateLimitPerMin: number | null;
  todayRequests: number;
  todayTokens: number;
  totalRequests: number;
  lastUsedAt: string | null;
}

interface EditState {
  chat: string;
  image: string;
  rate: string;
  dayReq: string;
  dayTok: string;
}

interface Pool {
  id: string;
  name: string;
  code: string;
  modelType: string;
  isDefault: boolean;
  models: string[];
}

interface OpenApiPanelProps {
  onActionsReady?: (actions: React.ReactNode) => void;
}

export default function OpenApiPanel({ onActionsReady }: OpenApiPanelProps) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<BindingRow[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);
  // 本地编辑态：keyId -> EditState
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
            chat: r.chatBinding ?? '',
            image: r.imageBinding ?? '',
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

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    onActionsReady?.(
      <Button variant="ghost" onClick={load} disabled={loading}>
        <RefreshCw size={14} /> 刷新
      </Button>
    );
  }, [onActionsReady, load, loading]);

  const chatPools = pools.filter((p) => p.modelType === 'chat');
  const imagePools = pools.filter((p) => p.modelType === 'generation');

  const toNum = (s: string): number | null => {
    const t = s.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  };

  const save = async (keyId: string) => {
    const edit = edits[keyId];
    if (!edit) return;
    setSavingId(keyId);
    try {
      const res = await apiRequest(`/api/open-api/bindings/${keyId}`, {
        method: 'PUT',
        auth: true,
        body: {
          chatBinding: edit.chat || null,
          imageBinding: edit.image || null,
          rateLimitPerMin: toNum(edit.rate),
          dailyRequestQuota: toNum(edit.dayReq),
          dailyTokenQuota: toNum(edit.dayTok),
        },
      });
      if (res.success) {
        toast.success('绑定已保存');
        await load();
      } else {
        toast.error(res.error?.message ?? '保存失败');
      }
    } finally {
      setSavingId(null);
    }
  };

  const dirty = (r: BindingRow) => {
    const e = edits[r.keyId];
    if (!e) return false;
    const eq = (a: string, b: number | null) => (a.trim() ? Number(a) === b : b == null);
    return (
      e.chat !== (r.chatBinding ?? '') ||
      e.image !== (r.imageBinding ?? '') ||
      !eq(e.rate, r.rateLimitPerMin) ||
      !eq(e.dayReq, r.dailyRequestQuota) ||
      !eq(e.dayTok, r.dailyTokenQuota)
    );
  };

  if (loading) return <MapSectionLoader text="正在加载 OpenApi 绑定…" />;

  return (
    <div className="h-full min-h-0 flex flex-col gap-4" style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
      <GlassCard className="p-4">
        <div className="flex items-start gap-3">
          <Plug size={18} className="text-white/50 mt-0.5 shrink-0" />
          <div className="text-[13px] text-white/70 leading-relaxed">
            <div className="font-medium text-white/85 mb-1">开放接口 · 对外网关固定模型绑定</div>
            外部调用方用标准 OpenAI 兼容方式接入：
            <code className="mx-1 px-1.5 py-0.5 rounded bg-white/[0.06] text-white/80">POST /api/v1/chat/completions</code>
            <code className="mx-1 px-1.5 py-0.5 rounded bg-white/[0.06] text-white/80">/api/v1/images/generations</code>。
            每个 <code className="px-1 rounded bg-white/[0.06]">sk-ak-*</code> Key（需授予 <code className="px-1 rounded bg-white/[0.06]">open-api:call</code> scope）
            在此绑定自己的固定模型池——<span className="text-white/85">留空即回落默认池</span>，互不影响，改总池不会误伤已绑定客户。
          </div>
        </div>
      </GlassCard>

      {rows.length === 0 ? (
        <GlassCard className="p-10 flex flex-col items-center justify-center text-center gap-3">
          <ShieldAlert size={32} className="text-white/30" />
          <div className="text-white/70 text-sm">还没有授予 <code className="px-1 rounded bg-white/[0.06]">open-api:call</code> 的 Key</div>
          <div className="text-white/45 text-xs max-w-md">
            在「接入 AI」弹窗创建 <code className="px-1 rounded bg-white/[0.06]">sk-ak-*</code> Key 并勾选 <code className="px-1 rounded bg-white/[0.06]">open-api:call</code> scope 后，
            即可在此为其绑定固定模型；未绑定的 Key 默认走 default:chat / default:image。
          </div>
        </GlassCard>
      ) : (
        <GlassCard className="p-0">
          <div style={{ overflowX: 'auto' }}>
          <table className="w-full text-[13px]" style={{ minWidth: 860 }}>
            <thead>
              <tr className="text-white/45 text-left border-b border-white/[0.08]">
                <th className="px-3 py-3 font-medium">Key / 客户</th>
                <th className="px-3 py-3 font-medium">Chat 绑定</th>
                <th className="px-3 py-3 font-medium">生图绑定</th>
                <th className="px-3 py-3 font-medium">实际解析</th>
                <th className="px-3 py-3 font-medium" title="每分钟速率 / 每日请求 / 每日token，留空=不限">限额 <span className="text-white/30 font-normal">分·日req·日tok</span></th>
                <th className="px-3 py-3 font-medium">今日用量</th>
                <th className="px-3 py-3 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const e = edits[r.keyId] ?? { chat: '', image: '', rate: '', dayReq: '', dayTok: '' };
                const patch = (p: Partial<EditState>) => setEdits((s) => ({ ...s, [r.keyId]: { ...e, ...p } }));
                return (
                  <tr key={r.keyId} className="border-b border-white/[0.05] hover:bg-white/[0.02] align-top">
                    <td className="px-3 py-3">
                      <div className="text-white/85">{r.name}</div>
                      <div className="text-white/40 text-xs">{r.ownerName}{r.isActive ? '' : ' · 已禁用'}</div>
                    </td>
                    <td className="px-3 py-3">
                      <BindingSelect pools={chatPools} value={e.chat} onChange={(v) => patch({ chat: v })} />
                    </td>
                    <td className="px-3 py-3">
                      <BindingSelect pools={imagePools} value={e.image} onChange={(v) => patch({ image: v })} />
                    </td>
                    <td className="px-3 py-3">
                      <div className="text-white/70 text-xs flex items-center gap-1">
                        {r.chatResolvedModel ?? '—'}
                        {r.chatIsFallback && (
                          <span className="text-amber-400" title="专属模型不可用，已降级">降级</span>
                        )}
                      </div>
                      <div className="text-white/40 text-xs">{r.imageResolvedModel ?? '—'}</div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-1">
                        <LimitInput value={e.rate} onChange={(v) => patch({ rate: v })} ph="∞" />
                        <span className="text-white/30">/</span>
                        <LimitInput value={e.dayReq} onChange={(v) => patch({ dayReq: v })} ph="∞" />
                        <span className="text-white/30">/</span>
                        <LimitInput value={e.dayTok} onChange={(v) => patch({ dayTok: v })} ph="∞" wide />
                      </div>
                    </td>
                    <td className="px-3 py-3 text-xs text-white/60">
                      <div>{r.todayRequests} 次</div>
                      <div className="text-white/40">{r.todayTokens.toLocaleString()} tok</div>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <Button
                        variant="ghost"
                        disabled={!dirty(r) || savingId === r.keyId}
                        onClick={() => save(r.keyId)}
                      >
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

function LimitInput({ value, onChange, ph, wide }: { value: string; onChange: (v: string) => void; ph: string; wide?: boolean }) {
  return (
    <input
      type="number"
      min={1}
      value={value}
      placeholder={ph}
      onChange={(ev) => onChange(ev.target.value)}
      className={`bg-white/[0.04] border border-white/[0.12] rounded-md px-1.5 py-1 text-white/85 text-xs focus:outline-none focus:border-white/30 ${wide ? 'w-20' : 'w-14'}`}
    />
  );
}

function BindingSelect({
  pools,
  value,
  onChange,
}: {
  pools: Pool[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(ev) => onChange(ev.target.value)}
      className="bg-white/[0.04] border border-white/[0.12] rounded-md px-2 py-1.5 text-white/85 text-xs w-[150px] focus:outline-none focus:border-white/30"
    >
      <option value="" className="bg-[#1E1F20]">默认池（不绑定）</option>
      {pools.map((p) => (
        <option key={p.id} value={p.code} className="bg-[#1E1F20]">
          {p.name}{p.isDefault ? '（默认）' : ''} · {p.code}
        </option>
      ))}
    </select>
  );
}
