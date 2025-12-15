/**
 * ECharts 暗色主题配置
 * 
 * 注意：这里使用硬编码的颜色值而不是 CSS 变量
 * 因为即使使用 SVG 渲染器，ECharts 内部某些计算也需要实际颜色值
 */

// 暗色主题调色板
export const colors = {
  // 背景
  bgBase: '#0d0d0f',
  bgElevated: '#18181b',
  bgCard: 'rgba(255, 255, 255, 0.03)',
  
  // 文本
  textPrimary: '#fafafa',
  textSecondary: '#b3b3bd',
  textMuted: '#7a7a86',
  
  // 边框/网格
  border: 'rgba(255, 255, 255, 0.08)',
  gridLine: 'rgba(255, 255, 255, 0.10)',
  axisLine: 'rgba(255, 255, 255, 0.12)',
  
  // 强调色
  accent: '#6366f1',
  accentHover: '#818cf8',
  
  // 状态色
  success: '#22c55e',
  warning: '#f59e0b',
  error: '#ef4444',
  info: '#3b82f6',
};

// 图表系列默认调色板
export const seriesColors = [
  colors.accent,
  colors.success,
  colors.warning,
  colors.error,
  colors.info,
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
];

// 通用坐标轴配置
export const axisCommon = {
  axisLabel: {
    color: colors.textMuted,
    fontSize: 12,
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
    margin: 10,
  },
  axisLine: {
    lineStyle: {
      color: colors.axisLine,
      width: 1,
    },
  },
  axisTick: {
    show: false,
  },
  splitLine: {
    lineStyle: {
      color: colors.gridLine,
      type: 'solid' as const,
      width: 1,
    },
  },
};

// X轴配置
export const xAxisDefaults = {
  type: 'category' as const,
  ...axisCommon,
  splitLine: { show: false },
};

// Y轴配置
export const yAxisDefaults = {
  type: 'value' as const,
  ...axisCommon,
  axisLine: { show: false },
};

// Tooltip 配置
export const tooltipDefaults = {
  backgroundColor: colors.bgElevated,
  borderColor: colors.border,
  borderWidth: 1,
  textStyle: {
    color: colors.textPrimary,
    fontSize: 12,
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
  },
  padding: [8, 12],
  extraCssText: 'box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25); border-radius: 8px;',
};

// Legend 配置
export const legendDefaults = {
  textStyle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
  },
  itemWidth: 14,
  itemHeight: 14,
  itemGap: 20,
  icon: 'roundRect',
};

// Grid 配置
export const gridDefaults = {
  left: '2%',
  right: '2%',
  bottom: '3%',
  top: '8%',
  containLabel: true,
};

// 折线图系列默认配置
export const lineSeriesDefaults = {
  type: 'line' as const,
  smooth: true,
  symbol: 'circle',
  symbolSize: 6,
  lineStyle: {
    width: 2,
  },
};

// 柱状图系列默认配置
export const barSeriesDefaults = {
  type: 'bar' as const,
  barMaxWidth: 24,
  itemStyle: {
    borderRadius: [4, 4, 0, 0],
  },
};

// 饼图系列默认配置
export const pieSeriesDefaults = {
  type: 'pie' as const,
  radius: ['45%', '70%'],
  center: ['50%', '50%'],
  itemStyle: {
    borderColor: colors.bgElevated,
    borderWidth: 2,
    borderRadius: 6,
  },
  label: {
    show: false,
  },
  emphasis: {
    scale: true,
    scaleSize: 4,
  },
};

// 构建完整的图表 option（合并默认值）
export function buildChartOption(
  customOption: Record<string, unknown>
): Record<string, unknown> {
  const { xAxis, yAxis, tooltip, legend, grid, series, ...rest } = customOption;
  
  return {
    tooltip: tooltip !== false ? { ...tooltipDefaults, ...(tooltip as object || {}) } : undefined,
    legend: legend ? { ...legendDefaults, ...(legend as object) } : undefined,
    grid: { ...gridDefaults, ...(grid as object || {}) },
    xAxis: xAxis ? { ...xAxisDefaults, ...(xAxis as object) } : undefined,
    yAxis: yAxis ? { ...yAxisDefaults, ...(yAxis as object) } : undefined,
    series,
    ...rest,
  };
}

