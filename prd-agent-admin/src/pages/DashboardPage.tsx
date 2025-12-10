import { useEffect, useState } from 'react';
import { Card, Row, Col, Statistic, Spin } from 'antd';
import {
  UserOutlined,
  TeamOutlined,
  MessageOutlined,
  RiseOutlined,
} from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { getOverviewStats, getMessageTrend } from '../services/api';

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
    },
    xAxis: {
      type: 'category',
      data: trend.map((t) => t.date.slice(5)),
      axisLabel: {
        color: '#64748b',
      },
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        color: '#64748b',
      },
    },
    series: [
      {
        data: trend.map((t) => t.count),
        type: 'line',
        smooth: true,
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(14, 165, 233, 0.3)' },
              { offset: 1, color: 'rgba(14, 165, 233, 0.05)' },
            ],
          },
        },
        lineStyle: {
          color: '#0ea5e9',
          width: 3,
        },
        itemStyle: {
          color: '#0ea5e9',
        },
      },
    ],
    grid: {
      left: '3%',
      right: '4%',
      bottom: '3%',
      containLabel: true,
    },
  };

  const roleChartOption = {
    tooltip: {
      trigger: 'item',
    },
    legend: {
      bottom: '5%',
      left: 'center',
    },
    series: [
      {
        type: 'pie',
        radius: ['40%', '70%'],
        avoidLabelOverlap: false,
        itemStyle: {
          borderRadius: 10,
          borderColor: '#fff',
          borderWidth: 2,
        },
        label: {
          show: false,
        },
        data: overview
          ? [
              { value: overview.usersByRole.pm, name: '产品经理', itemStyle: { color: '#0ea5e9' } },
              { value: overview.usersByRole.dev, name: '开发', itemStyle: { color: '#8b5cf6' } },
              { value: overview.usersByRole.qa, name: '测试', itemStyle: { color: '#10b981' } },
              { value: overview.usersByRole.admin, name: '管理员', itemStyle: { color: '#f59e0b' } },
            ]
          : [],
      },
    ],
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
      <h1 className="text-2xl font-bold text-gray-800 mb-6">仪表盘</h1>

      <Row gutter={[16, 16]} className="mb-6">
        <Col xs={24} sm={12} lg={6}>
          <Card className="stat-card">
            <Statistic
              title="总用户数"
              value={overview?.totalUsers || 0}
              prefix={<UserOutlined className="text-blue-500" />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="stat-card">
            <Statistic
              title="活跃用户"
              value={overview?.activeUsers || 0}
              prefix={<RiseOutlined className="text-green-500" />}
              suffix={<span className="text-sm text-gray-400">/ {overview?.totalUsers}</span>}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="stat-card">
            <Statistic
              title="群组数"
              value={overview?.totalGroups || 0}
              prefix={<TeamOutlined className="text-purple-500" />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="stat-card">
            <Statistic
              title="今日消息"
              value={overview?.todayMessages || 0}
              prefix={<MessageOutlined className="text-orange-500" />}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          <Card title="消息趋势（近14天）">
            <ReactECharts option={trendChartOption} style={{ height: 300 }} />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="用户角色分布">
            <ReactECharts option={roleChartOption} style={{ height: 300 }} />
          </Card>
        </Col>
      </Row>
    </div>
  );
}

