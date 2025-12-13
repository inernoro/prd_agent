import { useEffect, useState } from 'react';
import { Spin, Select, Table, Grid } from '@arco-design/web-react';
import type { ColumnProps } from '@arco-design/web-react/es/Table';
import { EChart, buildChartOption, colors, barSeriesDefaults, pieSeriesDefaults, legendDefaults } from '../components/Charts';
import { StatCard } from '../components/ui/StatCard';
import { PanelCard } from '../components/ui/PanelCard';
import { getTokenUsage, getActiveGroups, getGapStats } from '../services/api';

const { Row, Col } = Grid;
const Option = Select.Option;

interface TokenData {
  totalInput: number;
  totalOutput: number;
  totalTokens: number;
  dailyUsage: Array<{ date: string; input: number; output: number }>;
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
  byStatus: { pending: number; resolved: number; ignored: number };
  byType: Record<string, number>;
}

export default function StatsPage() {
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState<number>(7);
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

  // 判断 Token 数据是否为空
  const isTokenEmpty = !tokenData?.dailyUsage?.length || 
    tokenData.dailyUsage.every(d => d.input === 0 && d.output === 0);
  
  // 判断 Gap 数据是否为空
  const isGapEmpty = !gapStats || gapStats.total === 0;

  const tokenChartOption = buildChartOption({
    tooltip: { trigger: 'axis' },
    legend: { 
      ...legendDefaults,
      data: ['输入Token', '输出Token'], 
      bottom: 0,
    },
    xAxis: {
      data: tokenData?.dailyUsage.map((d) => d.date.slice(5)) || [],
    },
    yAxis: {},
    grid: { bottom: '18%', top: '8%' },
    series: [
      { 
        ...barSeriesDefaults,
        name: '输入Token', 
        stack: 'total', 
        data: tokenData?.dailyUsage.map((d) => d.input) || [], 
        itemStyle: { color: colors.accent, borderRadius: [0, 0, 0, 0] },
      },
      { 
        ...barSeriesDefaults,
        name: '输出Token', 
        stack: 'total', 
        data: tokenData?.dailyUsage.map((d) => d.output) || [], 
        itemStyle: { color: colors.success, borderRadius: [4, 4, 0, 0] },
      },
    ],
  });

  const gapChartOption = buildChartOption({
    tooltip: { trigger: 'item' },
    legend: { 
      ...legendDefaults,
      orient: 'vertical', 
      left: 'left', 
      top: 'center',
      itemWidth: 10,
      itemHeight: 10,
    },
    series: [{
      ...pieSeriesDefaults,
      center: ['60%', '50%'],
      data: gapStats ? [
        { value: gapStats.byStatus.pending, name: '待处理', itemStyle: { color: colors.warning } },
        { value: gapStats.byStatus.resolved, name: '已解决', itemStyle: { color: colors.success } },
        { value: gapStats.byStatus.ignored, name: '已忽略', itemStyle: { color: colors.textMuted } },
      ] : [],
    }],
  });

  const groupColumns: ColumnProps<GroupData>[] = [
    { 
      title: '群组名称', 
      dataIndex: 'groupName',
      render: (name) => <span className="table-cell-primary">{name}</span>
    },
    { 
      title: '成员', 
      dataIndex: 'memberCount', 
      width: 80,
      align: 'right',
      render: (count) => <span className="table-cell-secondary">{count}</span>
    },
    { 
      title: '消息', 
      dataIndex: 'messageCount', 
      width: 80,
      align: 'right',
      render: (count) => <span className="table-cell-accent">{count}</span>
    },
    { 
      title: '缺失', 
      dataIndex: 'gapCount', 
      width: 80,
      align: 'right',
      render: (count) => (
        <span className={count > 0 ? 'table-cell-warning' : 'table-cell-muted'}>
          {count}
        </span>
      )
    },
  ];

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
      <div className="page-header page-header-with-action">
        <div>
          <h1 className="page-title">Token统计</h1>
          <p className="page-subtitle">API 使用量与内容缺失分析</p>
        </div>
        <Select value={days} onChange={setDays} style={{ width: 110 }} size="small">
          <Option value={7}>最近7天</Option>
          <Option value={14}>最近14天</Option>
          <Option value={30}>最近30天</Option>
        </Select>
      </div>

      {/* 统计卡片 */}
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={8}>
          <StatCard 
            title="总输入Token" 
            value={tokenData?.totalInput || 0} 
            suffix="tokens" 
            valueColor={colors.accent}
          />
        </Col>
        <Col xs={24} sm={8}>
          <StatCard 
            title="总输出Token" 
            value={tokenData?.totalOutput || 0} 
            suffix="tokens"
            valueColor={colors.success}
          />
        </Col>
        <Col xs={24} sm={8}>
          <StatCard 
            title="总Token消耗" 
            value={tokenData?.totalTokens || 0} 
            suffix="tokens"
          />
        </Col>
      </Row>

      {/* 图表 */}
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={24} lg={16}>
          <PanelCard title="每日Token使用量" isEmpty={isTokenEmpty}>
            <EChart option={tokenChartOption} style={{ height: 240 }} />
          </PanelCard>
        </Col>
        <Col xs={24} lg={8}>
          <PanelCard title={`内容缺失统计（共${gapStats?.total || 0}条）`} isEmpty={isGapEmpty}>
            <EChart option={gapChartOption} style={{ height: 240 }} />
          </PanelCard>
        </Col>
      </Row>

      {/* 活跃群组 */}
      <PanelCard title="活跃群组 TOP 10" isEmpty={groups.length === 0}>
        <Table 
          columns={groupColumns} 
          data={groups} 
          rowKey="groupId" 
          pagination={false} 
          size="mini"
          border={false}
        />
      </PanelCard>
    </div>
  );
}
