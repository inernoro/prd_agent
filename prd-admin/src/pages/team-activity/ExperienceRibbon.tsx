/**
 * 体验洞察闭环 ribbon：把「监测 → 预警 → AI 根因 → 转缺陷 → 修复追踪 → 复测回落」六阶段
 * 铺成一条横向流水带，挂在体验全景热力图卡片之上。状态 done/cur 高亮，cur 阶段脉冲。
 * 全部从已有 mapData(热力图) + insights items 现算，不额外请求后端，也不硬编码业务数字。
 */
import { useMemo } from 'react';
import type { BehaviorInsight, TeamActivityExperienceMapData, TeamActivityInsightsData } from '@/services/contracts/teamActivity';

type StepState = 'done' | 'cur' | '';
type Step = { name: string; sub: string; state: StepState };

function buildSteps(mapData: TeamActivityExperienceMapData | null, insights: TeamActivityInsightsData | null): Step[] {
  const items: BehaviorInsight[] = insights?.items ?? [];
  // 监测：路由信号 + 接口访问量 = 已采集的体验信号总量
  const behaviorCount = insights?.behaviorEventCount ?? 0;
  const totalRequests = mapData?.totalRequests ?? 0;
  const monitorTotal = behaviorCount + totalRequests;
  const monitorSub = monitorTotal > 0
    ? `已采 ${formatCount(monitorTotal)} 条信号（路由 ${formatCount(behaviorCount)} + 接口 ${formatCount(totalRequests)}）`
    : '等待信号采集';

  // 预警：突增百分比最高的痛点端点
  let burstLabel = '';
  let burstPctMax = -1;
  mapData?.groups.forEach((g) => {
    g.leaves.forEach((l) => {
      if (l.burstPct != null && l.burstPct > burstPctMax) {
        burstPctMax = l.burstPct;
        burstLabel = l.label;
      }
    });
  });
  const hasBurst = burstPctMax >= 0;
  const warnSub = hasBurst ? `${burstLabel} 突增 +${burstPctMax}%` : '暂无突增';

  // 处理状态分布（来自 insights 闭环操作）
  const confirmed = items.filter((i) => i.status === 'confirmed').length;
  const resolved = items.filter((i) => i.status === 'resolved').length;
  // 转缺陷 + 转需求 都算「已流转」（VOC 闭环收口含需求池）
  const defectCount = items.filter((i) => !!i.defectId).length;
  const requirementCount = items.filter((i) => !!i.requirementNo).length;
  const routedCount = items.filter((i) => !!i.defectId || !!i.requirementNo).length;
  const open = items.filter((i) => i.status !== 'resolved' && i.status !== 'ignored').length;

  // 复测回落：对比修复后坏请求基线，得出真回落 / 复发（仅有 reboundPct 的条目计入）
  const reboundItems = items.filter((i) => typeof i.reboundPct === 'number');
  const reboundDown = reboundItems.filter((i) => (i.reboundPct as number) <= -20).length;
  const reboundUp = reboundItems.filter((i) => (i.reboundPct as number) >= 20).length;
  const reboundSub = reboundItems.length > 0
    ? `${reboundDown} 个已回落 / ${reboundUp} 个复发`
    : resolved > 0
      ? `已修复 ${resolved} 处`
      : '—';

  const routedSub = (() => {
    if (routedCount === 0) return '待指派';
    const parts: string[] = [];
    if (defectCount > 0) parts.push(`缺陷 ${defectCount}`);
    if (requirementCount > 0) parts.push(`需求 ${requirementCount}`);
    return `已转 ${parts.join(' · ')}`;
  })();

  return [
    { name: '监测', sub: monitorSub, state: 'done' },
    { name: '预警', sub: warnSub, state: hasBurst ? 'done' : '' },
    // AI 根因：当前焦点（待诊断的痛点数）
    { name: 'AI 根因', sub: open > 0 ? `待诊断 ${open} 处` : '暂无待诊断', state: 'cur' },
    { name: '转缺陷/需求', sub: routedSub, state: routedCount > 0 ? 'done' : '' },
    { name: '修复追踪', sub: confirmed > 0 ? `修复中 ${confirmed} 处` : '—', state: confirmed > 0 ? 'done' : '' },
    { name: '复测回落', sub: reboundSub, state: resolved > 0 ? 'done' : '' },
  ];
}

function formatCount(n: number): string {
  if (n >= 100000) return `${(n / 10000).toFixed(1)} 万`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
  return n.toLocaleString();
}

const GREEN = '#34d399';
const VIOLET = '#a78bfa';

export function ExperienceRibbon({
  mapData,
  insights,
}: {
  mapData: TeamActivityExperienceMapData | null;
  insights: TeamActivityInsightsData | null;
}) {
  const steps = useMemo(() => buildSteps(mapData, insights), [mapData, insights]);

  return (
    <div
      className="flex items-center gap-0 rounded-2xl border border-white/[0.07] px-3.5 py-2.5 mb-3"
      style={{ background: 'linear-gradient(180deg,rgba(26,27,29,0.7),rgba(22,23,24,0.7))' }}
    >
      {steps.map((s, i) => {
        const dotStyle =
          s.state === 'done'
            ? { background: 'rgba(52,211,153,0.16)', color: GREEN, border: `1px solid rgba(52,211,153,0.4)` }
            : s.state === 'cur'
              ? { background: 'rgba(167,139,250,0.18)', color: VIOLET, border: `1px solid rgba(167,139,250,0.5)`, animation: 'voc-ribbon-pulse 1.4s ease-in-out infinite' }
              : { background: 'rgba(255,255,255,0.05)', color: 'rgba(236,236,239,0.4)', border: '1px solid rgba(255,255,255,0.07)' };
        return (
          <div key={s.name} className="flex items-center gap-2.5 flex-1 min-w-0">
            <span
              className="w-[25px] h-[25px] rounded-full flex items-center justify-center text-[11.5px] font-bold shrink-0"
              style={dotStyle}
            >
              {i + 1}
            </span>
            <span className="flex flex-col leading-[1.25] min-w-0">
              <b className="text-[12.5px] whitespace-nowrap font-semibold" style={{ color: s.state === 'cur' ? VIOLET : 'rgba(236,236,239,0.9)' }}>
                {s.name}
              </b>
              <span className="text-[10px] text-white/35 whitespace-nowrap overflow-hidden text-ellipsis">{s.sub}</span>
            </span>
            {i < steps.length - 1 ? (
              <span className="flex-1 h-px mx-2 min-w-[14px]" style={{ background: 'linear-gradient(90deg,rgba(255,255,255,0.13),transparent)' }} />
            ) : null}
          </div>
        );
      })}
      <style>{`@keyframes voc-ribbon-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(167,139,250,0); } 50% { box-shadow: 0 0 0 6px rgba(167,139,250,0.18); } }`}</style>
    </div>
  );
}
