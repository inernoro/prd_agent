/**
 * 产品管理智能体 — RTM 需求可追溯矩阵（P0 补齐原始需求）。
 *
 * 行 = 需求；列 = 归属版本 / 实现功能 / 关联客户 / 追溯缺陷。覆盖缺口高亮：
 * 未实现(无功能)的需求标红、无来源需求的功能单列出来，便于一眼看出断链。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Puzzle } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getRtm, type RtmData } from '@/services/real/productAgent';
import { ITEM_GRADE_LABEL } from './types';
import './product-cards.css';

export function RtmMatrix({ productId }: { productId: string }) {
  const navigate = useNavigate();
  const [data, setData] = useState<RtmData | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await getRtm(productId);
    if (res.success) setData(res.data);
    setLoading(false);
  }, [productId]);
  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading) return <MapSectionLoader text="正在生成追溯矩阵…" />;
  if (!data) return <div className="text-sm text-white/40 py-10 text-center">加载失败</div>;

  const go = (kind: string, id: string) => navigate(`/product-agent/p/${productId}/${kind}/${id}`);

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      {/* 统计 */}
      <div className="shrink-0 flex items-center gap-3 flex-wrap">
        <Stat label="需求总数" value={data.stats.total} />
        <Stat label="未实现(无功能)" value={data.stats.withoutFeature} warn={data.stats.withoutFeature > 0} />
        <Stat label="未规划版本" value={data.stats.withoutVersion} warn={data.stats.withoutVersion > 0} />
        <Stat label="无来源需求的功能" value={data.stats.orphanFeatures} warn={data.stats.orphanFeatures > 0} />
      </div>

      {/* 矩阵表 */}
      <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-white/10" style={{ overscrollBehavior: 'contain' }}>
        {data.rows.length === 0 ? (
          <div className="text-center text-white/40 text-sm py-16">还没有需求。先去「需求」新建，矩阵会自动串联版本/功能/客户/缺陷。</div>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-10 bg-[#16181d]">
              <tr className="text-left text-[11px] text-white/45">
                <th className="px-3 py-2 font-medium">需求</th>
                <th className="px-3 py-2 font-medium">分级</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">归属版本</th>
                <th className="px-3 py-2 font-medium">实现功能</th>
                <th className="px-3 py-2 font-medium">关联客户</th>
                <th className="px-3 py-2 font-medium">追溯缺陷</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const noFeature = r.features.length === 0;
                return (
                  <tr key={r.id} className="border-t border-white/5 hover:bg-white/[0.03] align-top">
                    <td className="px-3 py-2.5" style={noFeature ? { boxShadow: 'inset 3px 0 0 #ef4444' } : undefined}>
                      <button onClick={() => go('requirement', r.id)} className="text-left">
                        <div className="text-white/90 hover:text-cyan-300 line-clamp-2 max-w-[220px]">{r.title}</div>
                        <div className="text-[10px] text-white/35 font-mono mt-0.5">{r.requirementNo}{noFeature && <span className="text-red-300/80 ml-1.5">未实现</span>}</div>
                      </button>
                    </td>
                    <td className="px-3 py-2.5"><span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/70">{ITEM_GRADE_LABEL[r.grade as keyof typeof ITEM_GRADE_LABEL] ?? r.grade}</span></td>
                    <td className="px-3 py-2.5 text-white/55 text-xs">{r.currentState || '-'}</td>
                    <td className="px-3 py-2.5"><CellChips items={r.versions.map((v) => ({ key: v.id, label: v.name }))} empty="未规划" /></td>
                    <td className="px-3 py-2.5"><CellChips items={r.features.map((f) => ({ key: f.id, label: f.title, onClick: () => go('feature', f.id) }))} empty="未实现" emptyWarn /></td>
                    <td className="px-3 py-2.5"><CellChips items={r.customers.map((c) => ({ key: c.id, label: c.name }))} empty="—" /></td>
                    <td className="px-3 py-2.5"><CellChips items={r.defects.map((d) => ({ key: d.id, label: d.defectNo, onClick: () => go('defect', d.id) }))} empty="—" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 无来源需求的功能 */}
      {data.orphanFeatures.length > 0 && (
        <div className="shrink-0 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3">
          <div className="flex items-center gap-1.5 text-xs text-amber-200/90 mb-2">
            <AlertTriangle size={13} /> 无来源需求的功能（{data.orphanFeatures.length}）—— 建议补上对应需求，保持可追溯
          </div>
          <div className="flex flex-wrap gap-1.5">
            {data.orphanFeatures.map((f) => (
              <button key={f.id} onClick={() => go('feature', f.id)} className="text-[11px] px-2 py-1 rounded bg-white/8 text-white/75 border border-white/10 hover:bg-white/15 inline-flex items-center gap-1">
                <Puzzle size={11} /> {f.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className={`pa-card rounded-lg border px-3 py-2 ${warn ? 'border-red-500/30 bg-red-500/[0.06]' : 'border-white/10 bg-white/[0.02]'}`}>
      <div className={`text-lg font-semibold leading-none ${warn ? 'text-red-300' : 'text-white/90'}`}>{value}</div>
      <div className="text-[10px] text-white/45 mt-1">{label}</div>
    </div>
  );
}

function CellChips({ items, empty, emptyWarn }: { items: { key: string; label: string; onClick?: () => void }[]; empty: string; emptyWarn?: boolean }) {
  if (items.length === 0) return <span className={`text-[11px] ${emptyWarn ? 'text-red-300/70' : 'text-white/30'}`}>{empty}</span>;
  return (
    <div className="flex flex-wrap gap-1 max-w-[260px]">
      {items.map((it) => (
        <span
          key={it.key}
          onClick={it.onClick ? (e) => { e.stopPropagation(); it.onClick!(); } : undefined}
          className={`text-[11px] px-1.5 py-0.5 rounded bg-white/8 text-white/70 border border-white/10 truncate max-w-[120px] ${it.onClick ? 'cursor-pointer hover:bg-cyan-500/15 hover:text-cyan-200' : ''}`}
          title={it.label}
        >
          {it.label}
        </span>
      ))}
    </div>
  );
}
