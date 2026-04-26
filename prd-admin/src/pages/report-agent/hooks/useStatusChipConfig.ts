import { useMemo } from 'react';
import { WeeklyReportStatus } from '@/services/contracts/reportAgent';
import { getSemantic, type SemanticTriplet } from './lightModeColors';

/**
 * 周报状态 chip 颜色 SSOT。
 *
 * 历史问题:MyReportsList / ReportMainView / ReportDetailPage / WeekNavRail
 * 各自手写 statusConfig,alpha 在 0.08 / 0.10 / 0.4 / 0.5 之间混乱,
 * 同一个状态在不同文件颜色不一致;且浅色下 alpha < 0.5 的色阶
 * 对比度不足,违反 WCAG AA 4.5:1。
 *
 * 现在统一走 getSemantic(isLight, hue):
 * - 浅色:LIGHT_SEMANTIC 的 alpha 1.0 文字 + 0.10/0.22 alpha bg/border (达标 AA)
 * - 暗色:rgba 0.9/0.08/0.15 (保持原暗色发光感)
 *
 * 仅返回颜色三元组(color/bg/border)。Icon / Label 仍由各组件保留,
 * 避免 hook 把 lucide-react 类型也吞进来导致 import 链路膨胀。
 */
export function useStatusChipConfig(isLight: boolean): Record<string, SemanticTriplet> {
  return useMemo(() => ({
    [WeeklyReportStatus.NotStarted]: getSemantic(isLight, 'slate'),
    [WeeklyReportStatus.Draft]:      getSemantic(isLight, 'slate'),
    [WeeklyReportStatus.Submitted]:  getSemantic(isLight, 'blue'),
    [WeeklyReportStatus.Reviewed]:   getSemantic(isLight, 'green'),
    [WeeklyReportStatus.Returned]:   getSemantic(isLight, 'red'),
    [WeeklyReportStatus.Overdue]:    getSemantic(isLight, 'red'),
    [WeeklyReportStatus.Vacation]:   getSemantic(isLight, 'slate'),
    [WeeklyReportStatus.Viewed]:     getSemantic(isLight, 'sky'),
  }), [isLight]);
}
