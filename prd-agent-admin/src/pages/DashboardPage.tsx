import { useEffect, useState } from 'react';
import { Spin, Grid } from '@arco-design/web-react';
import { IconUser, IconUserGroup, IconMessage, IconArrowRise } from '@arco-design/web-react/icon';
import { EChart, buildChartOption, colors, lineSeriesDefaults, pieSeriesDefaults, legendDefaults } from '../components/Charts';
import { StatCard } from '../components/ui/StatCard';
import { PanelCard } from '../components/ui/PanelCard';
import { getOverviewStats, getMessageTrend } from '../services/api';

const { Row, Col } = Grid;

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

  // 判断趋势数据是否为空
  const isTrendEmpty = !trend.length || trend.every(t => t.count === 0);
  
  // 判断角色数据是否为空
  const isRoleEmpty = !overview || Object.values(overview.usersByRole).every(v => v === 0);

  const trendChartOption = buildChartOption({
    tooltip: { trigger: 'axis' },
    xAxis: {
      data: trend.map((t) => t.date.slice(5)),
    },
    yAxis: {},
    grid: { bottom: '5%', top: '5%', left: '3%', right: '3%' },
    series: [{
      ...lineSeriesDefaults,
      data: trend.map((t) => t.count),
      areaStyle: {
        color: {
          type: 'linear',
          x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(99, 102, 241, 0.2)' },
            { offset: 1, color: 'rgba(99, 102, 241, 0.01)' },
          ],
        },
      },
      lineStyle: { color: colors.accent, width: 2.5 },
      itemStyle: { color: colors.accent },
      smooth: true,
    }],
  });

  const roleChartOption = buildChartOption({
    tooltip: { 
      trigger: 'item',
      formatter: '{b}: {c} ({d}%)',
    },
    legend: { 
      ...legendDefaults,
      bottom: '8%', 
      left: 'center',
    },
    series: [{
      ...pieSeriesDefaults,
      center: ['50%', '40%'],
      radius: ['50%', '75%'],
      data: overview ? [
        { value: overview.usersByRole.pm, name: '产品经理', itemStyle: { color: colors.accent } },
        { value: overview.usersByRole.dev, name: '开发', itemStyle: { color: colors.success } },
        { value: overview.usersByRole.qa, name: '测试', itemStyle: { color: colors.warning } },
        { value: overview.usersByRole.admin, name: '管理员', itemStyle: { color: colors.error } },
      ] : [],
    }],
  });

  if (loading) {
    return (
      <div className="page-loading">
        <Spin size={32} />
      </div>
    );
  }

  return (
    <div className="page-container animate-fadeIn">
      {/* 页面标题 */}
      <div className="page-header">
        <h1 className="page-title">仪表盘</h1>
        <p className="page-subtitle">系统运行概览</p>
      </div>

      {/* 统计卡片 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
        <Col xs={24} sm={12} lg={6}>
          <StatCard
            title="总用户数"
            value={overview?.totalUsers || 0}
            icon={<IconUser />}
            iconColor={colors.accent}
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard
            title="活跃用户"
            value={overview?.activeUsers || 0}
            icon={<IconArrowRise />}
            iconColor={colors.success}
            suffix={`/ ${overview?.totalUsers || 0}`}
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard
            title="群组数"
            value={overview?.totalGroups || 0}
            icon={<IconUserGroup />}
            iconColor="#8b5cf6"
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard
            title="今日消息"
            value={overview?.todayMessages || 0}
            icon={<IconMessage />}
            iconColor={colors.warning}
          />
        </Col>
      </Row>

      {/* 图表 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          <PanelCard title="消息趋势（近14天）" isEmpty={isTrendEmpty} emptyText="暂无消息趋势数据">
            <EChart option={trendChartOption} style={{ height: 280, width: '100%' }} />
          </PanelCard>
        </Col>
        <Col xs={24} lg={8}>
          <PanelCard title="用户角色分布" isEmpty={isRoleEmpty} emptyText="暂无用户数据">
            <EChart option={roleChartOption} style={{ height: 280, width: '100%' }} />
          </PanelCard>
        </Col>
      </Row>
    </div>
  );
}
