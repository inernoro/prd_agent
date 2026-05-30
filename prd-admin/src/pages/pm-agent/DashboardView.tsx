import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Save, TrendingUp, Coins, Star, Clock, Wallet } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { getPmDashboard, updatePmRewardConfig, togglePmExcellence } from '@/services';
import type { PmDashboard, UpdateRewardConfigInput } from '@/services/contracts/pmAgent';
import {
  PROJECT_TYPE_REGISTRY, GRADE_REGISTRY, NPSS_GLOBAL_BASELINE, MORE_FRAMEWORK, OPERATION_SUBTYPE_REGISTRY,
} from './pmConstants';

interface Props {
  onBack: () => void;
}

const yuan = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 0 });

export function DashboardView({ onBack }: Props) {
  const [data, setData] = useState<PmDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [cfgEdit, setCfgEdit] = useState<UpdateRewardConfigInput>({});
  const [savingCfg, setSavingCfg] = useState(false);
  const [fiscalYear, setFiscalYear] = useState<number | null>(null);

  const load = useCallback(async (fy: number | null) => {
    const res = await getPmDashboard(fy ?? undefined);
    if (res.success) setData(res.data);
    else toast.error('加载失败', res.error?.message || '');
    setLoading(false);
  }, []);

  useEffect(() => { load(fiscalYear); }, [load, fiscalYear]);

  const toggleExcellent = async (id: string, next: boolean) => {
    const res = await togglePmExcellence(id, next);
    if (res.success) { toast.success(next ? '已评选为优秀项目' : '已取消优秀', ''); load(fiscalYear); }
    else toast.error('操作失败', res.error?.message || '');
  };

  const saveCfg = async () => {
    setSavingCfg(true);
    const res = await updatePmRewardConfig(cfgEdit);
    setSavingCfg(false);
    if (res.success) { toast.success('已保存奖金配置', ''); setCfgEdit({}); load(fiscalYear); }
    else toast.error('保存失败', res.error?.message || '');
  };

  if (loading) return <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在汇总组织 NPSS…" /></div>;
  if (!data) return null;

  const cfg = data.rewardConfig;
  const hasData = data.totalEvaluated > 0;
  const npssColor = !hasData ? 'var(--border-subtle)' : data.npss >= NPSS_GLOBAL_BASELINE ? '#10B981' : '#EF4444';
  const dist = [
    { ...GRADE_REGISTRY.success, count: data.successCount },
    { ...GRADE_REGISTRY.mediocre, count: data.mediocreCount },
    { ...GRADE_REGISTRY.fail, count: data.failCount },
  ];

  const num = (v: number | undefined, fallback: number) => (v ?? fallback);
  const cfgInputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' };

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      <div className="shrink-0">
        <button onClick={onBack} className="flex items-center gap-1 text-[12px] mb-2 hover:opacity-70" style={{ color: 'var(--text-muted)' }}>
          <ArrowLeft size={14} /> 返回项目列表
        </button>
        <div className="flex items-center gap-2 flex-wrap">
          <TrendingUp size={20} style={{ color: '#10B981' }} />
          <div className="flex flex-col">
            <h2 className="text-[17px] font-semibold" style={{ color: 'var(--text-primary)' }}>组织 NPSS 看板</h2>
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>公司级经营指标，仅统计战略 / 创新 / 运营级项目（普通项目不计入）</span>
          </div>
          <select
            className="ml-auto rounded-lg px-3 py-1.5 text-[12px] outline-none border"
            style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
            value={fiscalYear ?? ''}
            onChange={(e) => { setLoading(true); setFiscalYear(e.target.value ? Number(e.target.value) : null); }}
          >
            <option value="">全部财年</option>
            {data.availableFiscalYears.map((y) => <option key={y} value={y}>{y} 财年</option>)}
          </select>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4" style={{ overscrollBehavior: 'contain' }}>
        {/* NPSS 总览 */}
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          <div className="rounded-xl border p-4" style={{ borderColor: npssColor, background: `${npssColor}10` }}>
            <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>组织 NPSS（成功占比 − 失败占比）</div>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-[32px] font-bold" style={{ color: hasData ? npssColor : 'var(--text-muted)' }}>{hasData ? data.npss : '—'}</span>
              <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>全球基线 {data.baseline}</span>
            </div>
            <div className="text-[11px] mt-1" style={{ color: hasData ? npssColor : 'var(--text-muted)' }}>
              {!hasData
                ? '暂无已评价的分级项目'
                : data.npss >= data.baseline ? `高于全球基线 ${data.npss - data.baseline} 分` : `低于全球基线 ${data.baseline - data.npss} 分`}
            </div>
          </div>
          <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
            <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>已评价项目</div>
            <div className="text-[32px] font-bold mt-1" style={{ color: 'var(--text-primary)' }}>{data.totalEvaluated}</div>
            <div className="flex gap-2 mt-1">
              {dist.map((d) => <span key={d.label} className="text-[11px]" style={{ color: d.color }}>{d.label.replace('项目', '')} {d.count}</span>)}
            </div>
          </div>
          <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
            <div className="text-[12px] flex items-center gap-1" style={{ color: 'var(--text-muted)' }}><Coins size={13} />奖金测算总额</div>
            <div className="text-[28px] font-bold mt-1" style={{ color: '#F59E0B' }}>¥{yuan(data.totalBonus)}</div>
          </div>
        </div>

        {/* 等级分布条 */}
        {data.totalEvaluated > 0 && (
          <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
            <div className="text-[13px] font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>项目成功度分布</div>
            <div className="flex h-3 rounded-full overflow-hidden">
              {dist.map((d) => d.count > 0 && (
                <div key={d.label} style={{ width: `${(d.count / data.totalEvaluated) * 100}%`, background: d.color }} title={`${d.label} ${d.count}`} />
              ))}
            </div>
          </div>
        )}

        {/* 成本侧进度留痕 */}
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
            <div className="text-[12px] flex items-center gap-1" style={{ color: 'var(--text-muted)' }}><Clock size={13} />按时交付率</div>
            <div className="text-[26px] font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
              {data.costMetrics.onTimeRate < 0 ? '—' : `${data.costMetrics.onTimeRate}%`}
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{data.costMetrics.onTimeBase > 0 ? `基于 ${data.costMetrics.onTimeBase} 个有计划结案项目` : '暂无计划结案数据'}</div>
          </div>
          <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
            <div className="text-[12px] flex items-center gap-1" style={{ color: 'var(--text-muted)' }}><Wallet size={13} />预算控制率</div>
            <div className="text-[26px] font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
              {data.costMetrics.budgetControlRate < 0 ? '—' : `${data.costMetrics.budgetControlRate}%`}
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{data.costMetrics.budgetBase > 0 ? `基于 ${data.costMetrics.budgetBase} 个有预算项目` : '暂无预算/成本数据'}</div>
          </div>
          <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
            <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>预算 / 实际成本</div>
            <div className="text-[18px] font-bold mt-1" style={{ color: 'var(--text-primary)' }}>¥{yuan(data.costMetrics.totalBudget)} <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>/ ¥{yuan(data.costMetrics.totalActualCost)}</span></div>
            <div className="text-[11px]" style={{ color: data.costMetrics.totalActualCost > data.costMetrics.totalBudget ? '#EF4444' : '#10B981' }}>
              {data.costMetrics.totalActualCost > data.costMetrics.totalBudget ? '超支' : '预算内'}
            </div>
          </div>
        </div>

        {/* 季度盘点（选定财年时）*/}
        {data.quarters.length > 0 && (
          <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
            <div className="text-[13px] font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{data.fiscalYear} 财年 · 季度盘点</div>
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
              {data.quarters.map((q) => (
                <div key={q.quarter} className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-base)' }}>
                  <div className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Q{q.quarter}</div>
                  <div className="flex items-baseline gap-1 mt-1">
                    <span className="text-[20px] font-bold" style={{ color: q.stats.npss >= NPSS_GLOBAL_BASELINE ? '#10B981' : q.stats.totalEvaluated > 0 ? '#EF4444' : 'var(--text-muted)' }}>{q.stats.totalEvaluated > 0 ? q.stats.npss : '—'}</span>
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>NPSS</span>
                  </div>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{q.stats.totalEvaluated} 项 · 奖金 ¥{yuan(q.stats.totalBonus)}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* M.O.R.E 提升框架 */}
        <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
          <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>M.O.R.E 提升框架</div>
          <div className="text-[11px] mb-3" style={{ color: 'var(--text-muted)' }}>四要素都做到 NPSS 可达 94；一个都没做到仅 27。下方为组织自评（不参与 NPSS 计算）。</div>
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            {MORE_FRAMEWORK.map((m) => {
              const val = (cfgEdit[m.key] ?? cfg[m.key]) as number;
              return (
                <div key={m.key} className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-base)' }}>
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-md flex items-center justify-center text-[13px] font-bold" style={{ background: `${m.color}22`, color: m.color }}>{m.letter}</span>
                    <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>{m.label}</span>
                    <span className="text-[12px] font-mono ml-auto" style={{ color: m.color }}>{val}</span>
                  </div>
                  <div className="text-[10.5px] mt-1" style={{ color: 'var(--text-muted)' }}>{m.desc}</div>
                  <input type="range" min={0} max={100} step={5} value={val}
                    onChange={(e) => setCfgEdit((prev) => ({ ...prev, [m.key]: Number(e.target.value) }))}
                    className="w-full mt-2" style={{ accentColor: m.color }} />
                </div>
              );
            })}
          </div>
        </div>

        {/* 奖金配置（PMO 细则）*/}
        <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
          <div className="text-[13px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>奖金基数配置（PMO 细则）</div>
          <div className="text-[11px] mb-3" style={{ color: 'var(--text-muted)' }}>奖金 = 基数 × 价值系数 × (满意度/100)；满意度&lt;60 或 定向整改/专项督办 → 归零。</div>
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            {([
              { key: 'generalBase' as const, label: '普通项目基数', cur: cfg.generalBase },
              { key: 'strategicBase' as const, label: '战略级基数', cur: cfg.strategicBase },
              { key: 'innovationBase' as const, label: '创新级基数', cur: cfg.innovationBase },
              { key: 'operationRoutineBase' as const, label: '常规运营级基数', cur: cfg.operationRoutineBase },
              { key: 'excellenceBonusBase' as const, label: '优秀项目奖金基数', cur: cfg.excellenceBonusBase },
            ]).map((f) => (
              <div key={f.key}>
                <label className="text-[11px] block mb-1" style={{ color: 'var(--text-secondary)' }}>{f.label}（元）</label>
                <input type="number" min={0}
                  className="w-full rounded-lg px-3 py-1.5 text-[13px] outline-none border" style={cfgInputStyle}
                  value={num(cfgEdit[f.key], f.cur)}
                  onChange={(e) => setCfgEdit((prev) => ({ ...prev, [f.key]: Number(e.target.value) }))} />
              </div>
            ))}
            <div>
              <label className="text-[11px] block mb-1" style={{ color: 'var(--text-secondary)' }}>财年起始月（1-12）</label>
              <input type="number" min={1} max={12}
                className="w-full rounded-lg px-3 py-1.5 text-[13px] outline-none border" style={cfgInputStyle}
                value={num(cfgEdit.fiscalYearStartMonth, cfg.fiscalYearStartMonth)}
                onChange={(e) => setCfgEdit((prev) => ({ ...prev, fiscalYearStartMonth: Number(e.target.value) }))} />
            </div>
          </div>
          <div className="flex justify-end mt-3">
            <Button variant="primary" onClick={saveCfg} disabled={savingCfg}>{savingCfg ? <MapSpinner size={14} /> : <Save size={14} />}保存配置</Button>
          </div>
        </div>

        {/* 项目奖金明细 */}
        <div className="rounded-xl border" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="px-4 py-2.5 text-[13px] font-semibold border-b" style={{ color: 'var(--text-primary)', borderColor: 'var(--border-subtle)' }}>项目奖金明细</div>
          {data.projects.length === 0 ? (
            <div className="text-[12px] text-center py-8" style={{ color: 'var(--text-muted)' }}>暂无已评价项目。完成结案评价后，项目会出现在这里。</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                <thead>
                  <tr style={{ color: 'var(--text-muted)' }}>
                    {['项目', '类型', '满意度', '等级', '价值系数', '奖金(元)', '优秀'].map((h) => (
                      <th key={h} className="text-left font-medium px-4 py-2">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.projects.map((p) => {
                    const t = PROJECT_TYPE_REGISTRY[p.projectType];
                    const g = GRADE_REGISTRY[p.grade];
                    const sub = p.operationSubType ? OPERATION_SUBTYPE_REGISTRY[p.operationSubType]?.label : '';
                    return (
                      <tr key={p.id} className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                        <td className="px-4 py-2" style={{ color: 'var(--text-primary)' }}>{p.title}</td>
                        <td className="px-4 py-2"><span style={{ color: t.color }}>{t.short}</span>{sub ? ` · ${sub.replace('项目', '')}` : ''}</td>
                        <td className="px-4 py-2">{p.satisfactionScore}</td>
                        <td className="px-4 py-2"><span style={{ color: g.color }}>{g.label.replace('项目', '')}</span></td>
                        <td className="px-4 py-2">{p.valueCoefficient}</td>
                        <td className="px-4 py-2 font-medium" style={{ color: p.bonus > 0 ? '#F59E0B' : 'var(--text-muted)' }}>{p.bonus > 0 ? `¥${yuan(p.bonus)}` : '0'}</td>
                        <td className="px-4 py-2">
                          <button
                            onClick={() => toggleExcellent(p.id, !p.isExcellent)}
                            className="p-1 rounded transition-colors"
                            style={{ color: p.isExcellent ? '#F59E0B' : 'var(--text-muted)' }}
                            title={p.isExcellent ? '取消优秀项目' : '评选为优秀项目'}
                          >
                            <Star size={15} fill={p.isExcellent ? '#F59E0B' : 'none'} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
