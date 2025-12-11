import { useEffect, useState, memo } from 'react';
import { Card, Row, Col, Statistic, Spin } from 'antd';
import {
  UserOutlined,
  TeamOutlined,
  MessageOutlined,
  RiseOutlined,
} from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { getOverviewStats, getMessageTrend } from '../services/api';

// 使用 memo 包装 echarts 组件防止不必要的重渲染
const MemoizedChart = memo(({ option, style }: { option: any; style: React.CSSProperties }) => (
  <ReactECharts option={option} style={style} notMerge={true} lazyUpdate={true} />
));

interface OverviewData {
  totalUsers: number;
  activeUsers: number;
  newUsersThisWeek: number;
  totalGroups: number;
  totalMessages: number;
  todayMessages: number;
  usersByRole: {
    pm: number;
    dev: number;
    qa: number;
    admin: number;
  };
}

interface TrendItem {
  date: string;
  count: number;
}

export default function DashboardPage() {
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [trend, setTrend] = useState<TrendItem[]>([]);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [overviewRes, trendRes] = await Promise.all([
        getOverviewStats(),
        getMessageTrend(14),
      ]) as any[];

      if (overviewRes.success) {
        setOverview(overviewRes.data);
      }
      if (trendRes.success) {
        setTrend(trendRes.data);
      }
    } catch (error) {
      console.error('Failed to load dashboard data:', error);
    } finally {
      setLoading(false);
    }
  };

  const trendChartOption = {
    tooltip: { 
      trigger: 'axis',
      backgroundColor: 'rgba(18, 18, 26, 0.95)',
      borderColor: 'rgba(6, 182, 212, 0.2)',
      textStyle: { color: '#f1f5f9' }
    },
    xAxis: {
      type: 'category',
      data: trend.map((t) => t.date.slice(5)),
      axisLabel: { color: '#64748b' },
      axisLine: { lineStyle: { color: 'rgba(6, 182, 212, 0.1)' } },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#64748b' },
      splitLine: { lineStyle: { color: 'rgba(6, 182, 212, 0.05)' } },
    },
    series: [{
      data: trend.map((t) => t.count),
      type: 'line',
      smooth: true,
      areaStyle: {
        color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(6, 182, 212, 0.25)' },
            { offset: 1, color: 'rgba(6, 182, 212, 0.02)' },
          ],
        },
      },
      lineStyle: { color: '#06b6d4', width: 2 },
      itemStyle: { color: '#22d3ee' },
    }],
    grid: { left: '3%', right: '4%', bottom: '3%', containLabel: true },
  };

  const roleChartOption = {
    tooltip: { 
      trigger: 'item',
      backgroundColor: 'rgba(18, 18, 26, 0.95)',
      borderColor: 'rgba(6, 182, 212, 0.2)',
      textStyle: { color: '#f1f5f9' }
    },
    legend: { bottom: '5%', left: 'center', textStyle: { color: '#64748b' } },
    series: [{
      type: 'pie',
      radius: ['40%', '70%'],
      avoidLabelOverlap: false,
      itemStyle: { borderRadius: 8, borderColor: '#0a0a0f', borderWidth: 2 },
      label: { show: false },
      data: overview ? [
        { value: overview.usersByRole.pm, name: '产品经理', itemStyle: { color: '#06b6d4' } },
        { value: overview.usersByRole.dev, name: '开发', itemStyle: { color: '#8b5cf6' } },
        { value: overview.usersByRole.qa, name: '测试', itemStyle: { color: '#22d3ee' } },
        { value: overview.usersByRole.admin, name: '管理员', itemStyle: { color: '#f59e0b' } },
      ] : [],
    }],
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">仪表盘</h1>

      <Row gutter={[16, 16]} className="mb-6">
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="总用户数"
              value={overview?.totalUsers || 0}
              prefix={<UserOutlined className="text-cyan-400" />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="活跃用户"
              value={overview?.activeUsers || 0}
              prefix={<RiseOutlined className="text-cyan-400" />}
              suffix={<span className="text-sm text-gray-500">/ {overview?.totalUsers}</span>}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="群组数"
              value={overview?.totalGroups || 0}
              prefix={<TeamOutlined className="text-purple-500" />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="今日消息"
              value={overview?.todayMessages || 0}
              prefix={<MessageOutlined className="text-amber-400" />}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          <Card title="消息趋势（近14天）">
            <MemoizedChart option={trendChartOption} style={{ height: 300 }} />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="用户角色分布">
            <MemoizedChart option={roleChartOption} style={{ height: 300 }} />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
