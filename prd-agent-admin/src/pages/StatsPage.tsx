import { useEffect, useState } from 'react';
import { Card, Row, Col, Statistic, Spin, Select, Table } from 'antd';
import ReactECharts from 'echarts-for-react';
import { getTokenUsage, getActiveGroups, getGapStats } from '../services/api';

interface TokenData {
  totalInput: number;
  totalOutput: number;
  totalTokens: number;
  dailyUsage: Array<{
    date: string;
    input: number;
    output: number;
  }>;
}

interface GroupData {
  groupId: string;
  groupName: string;
  memberCount: number;
  messageCount: number;
  gapCount: number;
}

interface GapStats {
  total: number;
  byStatus: {
    pending: number;
    resolved: number;
    ignored: number;
  };
  byType: Record<string, number>;
}

export default function StatsPage() {
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(7);
  const [tokenData, setTokenData] = useState<TokenData | null>(null);
  const [groups, setGroups] = useState<GroupData[]>([]);
  const [gapStats, setGapStats] = useState<GapStats | null>(null);

  useEffect(() => {
    loadData();
  }, [days]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [tokenRes, groupsRes, gapRes] = await Promise.all([
        getTokenUsage(days),
        getActiveGroups(10),
        getGapStats(),
      ]) as any[];

      if (tokenRes.success) setTokenData(tokenRes.data);
      if (groupsRes.success) setGroups(groupsRes.data);
      if (gapRes.success) setGapStats(gapRes.data);
    } catch (error) {
      console.error('Failed to load stats:', error);
    } finally {
      setLoading(false);
    }
  };

  const tokenChartOption = {
    tooltip: {
      trigger: 'axis',
    },
    legend: {
      data: ['输入Token', '输出Token'],
      bottom: 0,
    },
    xAxis: {
      type: 'category',
      data: tokenData?.dailyUsage.map((d) => d.date.slice(5)) || [],
    },
    yAxis: {
      type: 'value',
    },
    series: [
      {
        name: '输入Token',
        type: 'bar',
        stack: 'total',
        data: tokenData?.dailyUsage.map((d) => d.input) || [],
        itemStyle: { color: '#0ea5e9' },
      },
      {
        name: '输出Token',
        type: 'bar',
        stack: 'total',
        data: tokenData?.dailyUsage.map((d) => d.output) || [],
        itemStyle: { color: '#8b5cf6' },
      },
    ],
    grid: {
      left: '3%',
      right: '4%',
      bottom: '15%',
      containLabel: true,
    },
  };

  const gapChartOption = {
    tooltip: {
      trigger: 'item',
    },
    legend: {
      orient: 'vertical',
      left: 'left',
    },
    series: [
      {
        type: 'pie',
        radius: '70%',
        data: gapStats
          ? [
              { value: gapStats.byStatus.pending, name: '待处理', itemStyle: { color: '#f59e0b' } },
              { value: gapStats.byStatus.resolved, name: '已解决', itemStyle: { color: '#10b981' } },
              { value: gapStats.byStatus.ignored, name: '已忽略', itemStyle: { color: '#6b7280' } },
            ]
          : [],
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowOffsetX: 0,
            shadowColor: 'rgba(0, 0, 0, 0.5)',
          },
        },
      },
    ],
  };

  const groupColumns = [
    {
      title: '群组名称',
      dataIndex: 'groupName',
      key: 'groupName',
    },
    {
      title: '成员数',
      dataIndex: 'memberCount',
      key: 'memberCount',
    },
    {
      title: '消息数',
      dataIndex: 'messageCount',
      key: 'messageCount',
    },
    {
      title: '缺失数',
      dataIndex: 'gapCount',
      key: 'gapCount',
    },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-800">Token统计</h1>
        <Select value={days} onChange={setDays} style={{ width: 120 }}>
          <Select.Option value={7}>最近7天</Select.Option>
          <Select.Option value={14}>最近14天</Select.Option>
          <Select.Option value={30}>最近30天</Select.Option>
        </Select>
      </div>

      <Row gutter={[16, 16]} className="mb-6">
        <Col xs={24} sm={8}>
          <Card>
            <Statistic
              title="总输入Token"
              value={tokenData?.totalInput || 0}
              suffix="tokens"
              valueStyle={{ color: '#0ea5e9' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic
              title="总输出Token"
              value={tokenData?.totalOutput || 0}
              suffix="tokens"
              valueStyle={{ color: '#8b5cf6' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic
              title="总Token消耗"
              value={tokenData?.totalTokens || 0}
              suffix="tokens"
              valueStyle={{ color: '#10b981' }}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          <Card title="每日Token使用量">
            <ReactECharts option={tokenChartOption} style={{ height: 300 }} />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title={`内容缺失统计（共${gapStats?.total || 0}条）`}>
            <ReactECharts option={gapChartOption} style={{ height: 300 }} />
          </Card>
        </Col>
      </Row>

      <Card title="活跃群组 TOP 10" className="mt-4">
        <Table
          columns={groupColumns}
          dataSource={groups}
          rowKey="groupId"
          pagination={false}
          size="small"
        />
      </Card>
    </div>
  );
}


