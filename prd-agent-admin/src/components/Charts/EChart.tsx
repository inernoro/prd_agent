import { memo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';

interface EChartProps {
  option: EChartsOption;
  style?: React.CSSProperties;
  className?: string;
  loading?: boolean;
}

/**
 * 统一的 ECharts 封装组件
 * 
 * 特性：
 * - 使用 SVG 渲染器，支持 CSS 变量解析
 * - 默认开启 notMerge 和 lazyUpdate 优化性能
 * - 使用 memo 防止不必要的重渲染
 */
function EChartComponent({ option, style, className, loading }: EChartProps) {
  return (
    <ReactECharts
      option={option}
      style={style}
      className={className}
      opts={{ renderer: 'svg' }}
      notMerge={true}
      lazyUpdate={true}
      showLoading={loading}
      loadingOption={{
        text: '',
        color: '#6366f1',
        maskColor: 'rgba(13, 13, 15, 0.8)',
      }}
    />
  );
}

export const EChart = memo(EChartComponent);

export default EChart;

