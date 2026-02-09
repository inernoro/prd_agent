import { useState, useMemo } from 'react';
import {
  Crown, Users, Bot, DollarSign, Link2, TrendingUp, TrendingDown,
  MessageSquare, Image, Bug, FileText, Eye, Clock, Activity,
  BarChart3, Zap, ChevronRight, ArrowUpRight, ArrowDownRight,
} from 'lucide-react';
import { TabBar } from '@/components/design/TabBar';
import { GlassCard } from '@/components/design/GlassCard';
import { KpiCard } from '@/components/design/KpiCard';
import { EChart } from '@/components/charts/EChart';
import type { EChartsOption } from 'echarts';

// ─── Mock Data ──────────────────────────────────────────────────────

const MOCK_USERS = [
  { id: 'u1', name: '张三', role: 'PM', avatar: null, activeDays: 5, messages: 127, tokens: 123000, agents: { 'prd-agent': 68, 'defect-agent': 25, 'visual-agent': 7 }, defectsCreated: 8, defectsResolved: 5, images: 15, comments: 23, gaps: 12 },
  { id: 'u2', name: '李四', role: 'DEV', avatar: null, activeDays: 4, messages: 89, tokens: 87000, agents: { 'visual-agent': 55, 'prd-agent': 30, 'defect-agent': 15 }, defectsCreated: 3, defectsResolved: 2, images: 42, comments: 8, gaps: 5 },
  { id: 'u3', name: '王五', role: 'QA', avatar: null, activeDays: 5, messages: 56, tokens: 42000, agents: { 'defect-agent': 60, 'prd-agent': 30, 'visual-agent': 10 }, defectsCreated: 15, defectsResolved: 12, images: 3, comments: 18, gaps: 8 },
  { id: 'u4', name: '赵六', role: 'DEV', avatar: null, activeDays: 3, messages: 45, tokens: 38000, agents: { 'prd-agent': 50, 'visual-agent': 40, 'literary-agent': 10 }, defectsCreated: 2, defectsResolved: 0, images: 20, comments: 5, gaps: 3 },
  { id: 'u5', name: '孙七', role: 'PM', avatar: null, activeDays: 4, messages: 98, tokens: 95000, agents: { 'prd-agent': 72, 'defect-agent': 20, 'literary-agent': 8 }, defectsCreated: 6, defectsResolved: 4, images: 5, comments: 31, gaps: 15 },
  { id: 'u6', name: '周八', role: 'QA', avatar: null, activeDays: 2, messages: 23, tokens: 18000, agents: { 'defect-agent': 80, 'prd-agent': 20 }, defectsCreated: 10, defectsResolved: 8, images: 0, comments: 4, gaps: 2 },
];

const MOCK_AGENTS = [
  { key: 'prd-agent', name: 'PRD Agent', users: 6, calls: 1234, tokens: 1800000, avgDepth: 8.2, color: 'rgba(59,130,246,0.95)' },
  { key: 'defect-agent', name: 'Defect Agent', users: 5, calls: 456, tokens: 520000, avgDepth: 5.1, color: 'rgba(239,68,68,0.85)' },
  { key: 'visual-agent', name: 'Visual Agent', users: 4, calls: 289, tokens: 3200000, avgDepth: 6.7, color: 'rgba(168,85,247,0.95)' },
  { key: 'literary-agent', name: 'Literary Agent', users: 2, calls: 78, tokens: 450000, avgDepth: 3.4, color: 'rgba(34,197,94,0.95)' },
];

const MOCK_MODELS = [
  { name: 'gpt-4o', calls: 523, tokens: 3800000, cost: 11.40, platform: 'OpenAI' },
  { name: 'claude-sonnet', calls: 312, tokens: 2200000, cost: 6.60, platform: 'Anthropic' },
  { name: 'deepseek-v3', calls: 198, tokens: 950000, cost: 0.47, platform: 'DeepSeek' },
  { name: 'dall-e-3', calls: 89, tokens: 0, cost: 8.90, platform: 'OpenAI' },
  { name: 'gemini-pro', calls: 67, tokens: 420000, cost: 0.21, platform: 'Google' },
];

function gen30DayTrend(base: number, variance: number) {
  return Array.from({ length: 30 }, (_, i) => ({
    date: new Date(Date.now() - (29 - i) * 86400000).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }),
    value: Math.max(0, Math.round(base + (Math.random() - 0.4) * variance + i * (variance * 0.01))),
  }));
}

const MOCK_DAILY_MESSAGES = gen30DayTrend(80, 40);
const MOCK_DAILY_TOKENS = gen30DayTrend(200000, 100000);
const MOCK_DAILY_USERS = gen30DayTrend(8, 5);

// Heatmap data: hour (0-23) x weekday (0-6)
const MOCK_HEATMAP = Array.from({ length: 24 * 7 }, (_, i) => {
  const hour = i % 24;
  const day = Math.floor(i / 24);
  const isWorkHour = hour >= 9 && hour <= 18 && day < 5;
  const isLunch = hour >= 12 && hour <= 13;
  return [day, hour, isWorkHour ? (isLunch ? 2 : Math.floor(Math.random() * 6) + 4) : Math.floor(Math.random() * 2)];
});

// ─── Chart Helpers ──────────────────────────────────────────────────

const chartTextColor = 'rgba(247,247,251,0.55)';
const chartAxisLine = 'rgba(255,255,255,0.06)';
const chartTooltipBg = 'rgba(18,18,22,0.95)';

function makeTrendOption(data: { date: string; value: number }[], color: string, unit: string): EChartsOption {
  return {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', backgroundColor: chartTooltipBg, borderColor: 'rgba(255,255,255,0.08)', textStyle: { color: '#f7f7fb', fontSize: 12 }, formatter: (p: any) => `${p[0].name}<br/>${p[0].value.toLocaleString()} ${unit}` },
    grid: { left: 0, right: 0, top: 8, bottom: 0, containLabel: true },
    xAxis: { type: 'category', data: data.map(d => d.date), axisLine: { lineStyle: { color: chartAxisLine } }, axisLabel: { color: chartTextColor, fontSize: 10, interval: 6 }, axisTick: { show: false } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: chartAxisLine } }, axisLabel: { color: chartTextColor, fontSize: 10, formatter: (v: number) => v >= 10000 ? `${(v / 10000).toFixed(0)}万` : v.toLocaleString() } },
    series: [{ type: 'line', data: data.map(d => d.value), smooth: true, symbol: 'none', lineStyle: { width: 2, color }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: color.replace('0.95', '0.25').replace(')', ',0.25)').replace(',,', ',') }, { offset: 1, color: 'transparent' }] } } }],
  };
}

function makeHeatmapOption(): EChartsOption {
  const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const hours = Array.from({ length: 24 }, (_, i) => `${i}:00`);
  return {
    backgroundColor: 'transparent',
    tooltip: { backgroundColor: chartTooltipBg, borderColor: 'rgba(255,255,255,0.08)', textStyle: { color: '#f7f7fb', fontSize: 12 }, formatter: (p: any) => `${days[p.value[0]]} ${hours[p.value[1]]}<br/>活跃用户: ${p.value[2]}` },
    grid: { left: 40, right: 10, top: 10, bottom: 30 },
    xAxis: { type: 'category', data: days, axisLine: { lineStyle: { color: chartAxisLine } }, axisLabel: { color: chartTextColor, fontSize: 10 }, axisTick: { show: false } },
    yAxis: { type: 'category', data: hours, axisLine: { lineStyle: { color: chartAxisLine } }, axisLabel: { color: chartTextColor, fontSize: 10, interval: 3 }, axisTick: { show: false } },
    visualMap: { show: false, min: 0, max: 10, inRange: { color: ['rgba(255,255,255,0.02)', 'rgba(59,130,246,0.15)', 'rgba(59,130,246,0.35)', 'rgba(59,130,246,0.55)', 'rgba(59,130,246,0.8)'] } },
    series: [{ type: 'heatmap', data: MOCK_HEATMAP, itemStyle: { borderColor: 'transparent', borderWidth: 2, borderRadius: 3 } }],
  };
}

function makePieOption(agents: typeof MOCK_AGENTS): EChartsOption {
  return {
    backgroundColor: 'transparent',
    tooltip: { backgroundColor: chartTooltipBg, borderColor: 'rgba(255,255,255,0.08)', textStyle: { color: '#f7f7fb', fontSize: 12 } },
    series: [{ type: 'pie', radius: ['50%', '75%'], center: ['50%', '50%'], padAngle: 3, itemStyle: { borderRadius: 6 }, label: { show: true, color: chartTextColor, fontSize: 11, formatter: '{b}\n{d}%' }, data: agents.map(a => ({ name: a.name, value: a.calls, itemStyle: { color: a.color } })) }],
  };
}

function makeCostBarOption(): EChartsOption {
  return {
    backgroundColor: 'transparent',
    tooltip: { backgroundColor: chartTooltipBg, borderColor: 'rgba(255,255,255,0.08)', textStyle: { color: '#f7f7fb', fontSize: 12 }, formatter: (p: any) => `${p.name}<br/>$${p.value.toFixed(2)}` },
    grid: { left: 0, right: 0, top: 8, bottom: 0, containLabel: true },
    xAxis: { type: 'category', data: MOCK_MODELS.map(m => m.name), axisLine: { lineStyle: { color: chartAxisLine } }, axisLabel: { color: chartTextColor, fontSize: 10, rotate: 20 }, axisTick: { show: false } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: chartAxisLine } }, axisLabel: { color: chartTextColor, fontSize: 10, formatter: '${value}' } },
    series: [{ type: 'bar', data: MOCK_MODELS.map(m => m.cost), barWidth: 28, itemStyle: { borderRadius: [4, 4, 0, 0], color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(214,178,106,0.8)' }, { offset: 1, color: 'rgba(214,178,106,0.2)' }] } } }],
  };
}

// ─── Sub-components ─────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[13px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
      {children}
    </h3>
  );
}

function StatRow({ label, value, sub, icon: Icon }: { label: string; value: string | number; sub?: string; icon?: any }) {
  return (
    <div className="flex items-center justify-between py-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div className="flex items-center gap-2">
        {Icon && <Icon size={14} style={{ color: 'var(--text-muted)' }} />}
        <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      </div>
      <div className="text-right">
        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{typeof value === 'number' ? value.toLocaleString() : value}</span>
        {sub && <span className="text-[11px] ml-1.5" style={{ color: 'var(--text-muted)' }}>{sub}</span>}
      </div>
    </div>
  );
}

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="h-1.5 rounded-full w-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

function UserCard({ user, onClick }: { user: typeof MOCK_USERS[0]; onClick: () => void }) {
  const roleColor = user.role === 'PM' ? 'rgba(59,130,246,0.95)' : user.role === 'DEV' ? 'rgba(34,197,94,0.95)' : 'rgba(239,68,68,0.85)';
  return (
    <GlassCard interactive className="cursor-pointer" onClick={onClick}>
      <div className="flex items-center gap-3 mb-3">
        <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold" style={{ background: `${roleColor}22`, color: roleColor }}>
          {user.name[0]}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{user.name}</div>
          <div className="text-[11px]" style={{ color: roleColor }}>{user.role}</div>
        </div>
        <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{user.activeDays}/7 天</div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-[17px] font-bold" style={{ color: 'var(--text-primary)' }}>{user.messages}</div>
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>消息</div>
        </div>
        <div>
          <div className="text-[17px] font-bold" style={{ color: 'var(--text-primary)' }}>{(user.tokens / 10000).toFixed(1)}万</div>
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Token</div>
        </div>
        <div>
          <div className="text-[17px] font-bold" style={{ color: 'var(--text-primary)' }}>{user.defectsCreated + user.images}</div>
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>产出</div>
        </div>
      </div>
      {/* Mini agent bar */}
      <div className="flex gap-0.5 mt-3 h-1.5 rounded-full overflow-hidden">
        {Object.entries(user.agents).map(([key, pct]) => {
          const agentColor = key === 'prd-agent' ? 'rgba(59,130,246,0.8)' : key === 'defect-agent' ? 'rgba(239,68,68,0.7)' : key === 'visual-agent' ? 'rgba(168,85,247,0.8)' : 'rgba(34,197,94,0.8)';
          return <div key={key} style={{ width: `${pct}%`, background: agentColor }} />;
        })}
      </div>
    </GlassCard>
  );
}

function UserDetailPanel({ user, onClose }: { user: typeof MOCK_USERS[0]; onClose: () => void }) {
  const roleColor = user.role === 'PM' ? 'rgba(59,130,246,0.95)' : user.role === 'DEV' ? 'rgba(34,197,94,0.95)' : 'rgba(239,68,68,0.85)';
  const agentNames: Record<string, string> = { 'prd-agent': 'PRD Agent', 'defect-agent': 'Defect Agent', 'visual-agent': 'Visual Agent', 'literary-agent': 'Literary Agent' };

  return (
    <GlassCard glow variant="gold">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full flex items-center justify-center text-lg font-bold" style={{ background: `${roleColor}22`, color: roleColor }}>
            {user.name[0]}
          </div>
          <div>
            <div className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{user.name}</div>
            <div className="text-xs" style={{ color: roleColor }}>{user.role} · 本周活跃 {user.activeDays}/7 天</div>
          </div>
        </div>
        <button onClick={onClose} className="text-sm px-3 py-1 rounded-md" style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}>关闭</button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Left: Agent usage + stats */}
        <div>
          <SectionTitle>Agent 使用占比</SectionTitle>
          <div className="space-y-2">
            {Object.entries(user.agents).map(([key, pct]) => {
              const agentColor = key === 'prd-agent' ? 'rgba(59,130,246,0.8)' : key === 'defect-agent' ? 'rgba(239,68,68,0.7)' : key === 'visual-agent' ? 'rgba(168,85,247,0.8)' : 'rgba(34,197,94,0.8)';
              return (
                <div key={key}>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span style={{ color: 'var(--text-secondary)' }}>{agentNames[key] || key}</span>
                    <span style={{ color: agentColor }}>{pct}%</span>
                  </div>
                  <ProgressBar value={pct} max={100} color={agentColor} />
                </div>
              );
            })}
          </div>

          <div className="mt-4">
            <SectionTitle>本周产出</SectionTitle>
            <StatRow icon={MessageSquare} label="发送消息" value={user.messages} />
            <StatRow icon={FileText} label="PRD 评论" value={user.comments} />
            <StatRow icon={Eye} label="内容缺失" value={user.gaps} />
            <StatRow icon={Bug} label="缺陷提交 / 解决" value={`${user.defectsCreated} / ${user.defectsResolved}`} />
            <StatRow icon={Image} label="生成图片" value={user.images} sub="张" />
          </div>
        </div>

        {/* Right: Token trend + active hours */}
        <div>
          <SectionTitle>Token 消耗趋势</SectionTitle>
          <div className="h-[160px]">
            <EChart option={makeTrendOption(gen30DayTrend(user.tokens / 30, user.tokens / 60), roleColor, 'tokens')} height={160} />
          </div>

          <div className="mt-4">
            <SectionTitle>活跃时段</SectionTitle>
            <div className="grid grid-cols-7 gap-1">
              {['一', '二', '三', '四', '五', '六', '日'].map(d => (
                <div key={d} className="text-[9px] text-center" style={{ color: 'var(--text-muted)' }}>{d}</div>
              ))}
              {Array.from({ length: 7 * 6 }, (_, i) => {
                const day = i % 7;
                const hour = Math.floor(i / 7) + 8; // 8:00 - 13:00 simplified
                const active = day < 5 && hour >= 9 && hour <= 12;
                return <div key={i} className="h-3 rounded-sm" style={{ background: active ? `${roleColor}${Math.floor(Math.random() * 40 + 30).toString(16)}` : 'rgba(255,255,255,0.03)' }} />;
              })}
            </div>
          </div>

          <div className="mt-4">
            <SectionTitle>外部协作</SectionTitle>
            <div className="space-y-1.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              <div className="flex items-center gap-2"><Zap size={12} style={{ color: 'var(--accent-gold)' }} /> Claude Code: 5 session, 12 commits</div>
              <div className="flex items-center gap-2"><Link2 size={12} style={{ color: 'rgba(59,130,246,0.8)' }} /> Jira: 完成 8 任务</div>
              <div className="flex items-center gap-2"><Activity size={12} style={{ color: 'rgba(168,85,247,0.8)' }} /> GitLab: 合并 2 MR</div>
            </div>
          </div>
        </div>
      </div>
    </GlassCard>
  );
}

// ─── Tab: Overview ──────────────────────────────────────────────────

function OverviewTab() {
  return (
    <div className="space-y-6">
      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <KpiCard title="今日活跃用户" value={12} accent="blue" trend="up" trendLabel="↑20% vs 昨日" />
        <KpiCard title="本周对话数" value={347} accent="gold" trend="up" trendLabel="↑15% vs 上周" />
        <KpiCard title="本周 Token" value="283万" accent="purple" trend="down" trendLabel="↓8% vs 上周" />
        <KpiCard title="AI 渗透率" value="87%" accent="green" trend="up" trendLabel="↑5% vs 上周" />
        <KpiCard title="平均响应时间" value="1.2s" accent="blue" trend="down" trendLabel="↓18% 更快" />
        <KpiCard title="缺陷解决率" value="76%" accent="gold" trend="up" trendLabel="↑12% vs 上周" />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <GlassCard glow className="lg:col-span-2">
          <SectionTitle>30 天使用趋势</SectionTitle>
          <EChart option={makeTrendOption(MOCK_DAILY_MESSAGES, 'rgba(59,130,246,0.95)', '条消息')} height={260} />
        </GlassCard>
        <GlassCard glow>
          <SectionTitle>Agent 使用分布</SectionTitle>
          <EChart option={makePieOption(MOCK_AGENTS)} height={260} />
        </GlassCard>
      </div>

      {/* Heatmap + Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <GlassCard glow>
          <SectionTitle>活跃时段热力图</SectionTitle>
          <EChart option={makeHeatmapOption()} height={300} />
        </GlassCard>
        <GlassCard glow>
          <SectionTitle>最近动态</SectionTitle>
          <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
            {[
              { user: '张三', action: '通过 PRD Agent 解读了《用户登录模块》', time: '3 分钟前', icon: FileText, color: 'rgba(59,130,246,0.8)' },
              { user: '王五', action: '提交缺陷 DEF-2026-0089（严重）', time: '12 分钟前', icon: Bug, color: 'rgba(239,68,68,0.8)' },
              { user: '李四', action: '生成 4 张概念图（文生图）', time: '25 分钟前', icon: Image, color: 'rgba(168,85,247,0.8)' },
              { user: '孙七', action: '发现 3 个内容缺失项', time: '1 小时前', icon: Eye, color: 'rgba(214,178,106,0.8)' },
              { user: '赵六', action: '通过 Claude Code 提交 5 个 commit', time: '2 小时前', icon: Zap, color: 'rgba(34,197,94,0.8)' },
              { user: '周八', action: '解决缺陷 DEF-2026-0085', time: '3 小时前', icon: Bug, color: 'rgba(34,197,94,0.8)' },
              { user: '张三', action: '创建 PRD 评论 × 5', time: '4 小时前', icon: MessageSquare, color: 'rgba(59,130,246,0.8)' },
            ].map((item, i) => (
              <div key={i} className="flex items-start gap-3 py-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <item.icon size={14} className="mt-0.5 shrink-0" style={{ color: item.color }} />
                <div className="flex-1 min-w-0">
                  <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{item.user}</span>
                  <span className="text-[12px] ml-1" style={{ color: 'var(--text-secondary)' }}>{item.action}</span>
                </div>
                <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>{item.time}</span>
              </div>
            ))}
          </div>
        </GlassCard>
      </div>
    </div>
  );
}

// ─── Tab: Team Insights ─────────────────────────────────────────────

function TeamInsightsTab() {
  const [selectedUser, setSelectedUser] = useState<typeof MOCK_USERS[0] | null>(null);

  return (
    <div className="space-y-6">
      {selectedUser && (
        <UserDetailPanel user={selectedUser} onClose={() => setSelectedUser(null)} />
      )}

      <GlassCard glow>
        <SectionTitle>团队排名 — 按 AI 使用活跃度</SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {MOCK_USERS.sort((a, b) => b.messages - a.messages).map(u => (
            <UserCard key={u.id} user={u} onClick={() => setSelectedUser(u)} />
          ))}
        </div>
      </GlassCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <GlassCard glow>
          <SectionTitle>角色分布</SectionTitle>
          <div className="flex gap-6 mt-2">
            {[
              { role: 'PM', count: 2, color: 'rgba(59,130,246,0.95)' },
              { role: 'DEV', count: 2, color: 'rgba(34,197,94,0.95)' },
              { role: 'QA', count: 2, color: 'rgba(239,68,68,0.85)' },
            ].map(r => (
              <div key={r.role} className="text-center flex-1">
                <div className="w-12 h-12 rounded-full mx-auto flex items-center justify-center text-lg font-bold" style={{ background: `${r.color}15`, color: r.color }}>
                  {r.count}
                </div>
                <div className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)' }}>{r.role}</div>
              </div>
            ))}
          </div>
        </GlassCard>
        <GlassCard glow>
          <SectionTitle>Token 消耗 Top 5</SectionTitle>
          {MOCK_USERS.sort((a, b) => b.tokens - a.tokens).slice(0, 5).map((u, i) => (
            <div key={u.id} className="flex items-center gap-3 py-1.5">
              <span className="text-[11px] font-bold w-4 text-right" style={{ color: i < 3 ? 'var(--accent-gold)' : 'var(--text-muted)' }}>{i + 1}</span>
              <span className="text-sm flex-1" style={{ color: 'var(--text-primary)' }}>{u.name}</span>
              <span className="text-sm font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>{(u.tokens / 10000).toFixed(1)}万</span>
            </div>
          ))}
        </GlassCard>
      </div>
    </div>
  );
}

// ─── Tab: Agent Usage ───────────────────────────────────────────────

function AgentUsageTab() {
  const totalActiveUsers = MOCK_USERS.length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {MOCK_AGENTS.map(agent => (
          <GlassCard key={agent.key} glow accentHue={agent.key === 'prd-agent' ? 217 : agent.key === 'defect-agent' ? 0 : agent.key === 'visual-agent' ? 270 : 142}>
            <div className="flex items-center gap-2 mb-3">
              <Bot size={16} style={{ color: agent.color }} />
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{agent.name}</span>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-[11px]">
                <span style={{ color: 'var(--text-muted)' }}>采纳率</span>
                <span style={{ color: agent.color }}>{Math.round(agent.users / totalActiveUsers * 100)}%</span>
              </div>
              <ProgressBar value={agent.users} max={totalActiveUsers} color={agent.color} />
              <StatRow label="调用次数" value={agent.calls} />
              <StatRow label="Token 消耗" value={`${(agent.tokens / 10000).toFixed(0)}万`} />
              <StatRow label="平均对话深度" value={`${agent.avgDepth} 轮`} />
            </div>
          </GlassCard>
        ))}
      </div>

      <GlassCard glow>
        <SectionTitle>技能矩阵 — 用户 x Agent</SectionTitle>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                <th className="text-left py-2 pr-4 font-medium" style={{ color: 'var(--text-muted)' }}>用户</th>
                {MOCK_AGENTS.map(a => (
                  <th key={a.key} className="text-center py-2 px-3 font-medium" style={{ color: a.color }}>{a.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MOCK_USERS.map(user => (
                <tr key={user.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td className="py-2 pr-4">
                    <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{user.name}</span>
                    <span className="text-[10px] ml-1" style={{ color: 'var(--text-muted)' }}>{user.role}</span>
                  </td>
                  {MOCK_AGENTS.map(agent => {
                    const pct = user.agents[agent.key as keyof typeof user.agents] || 0;
                    const stars = pct >= 50 ? 3 : pct >= 20 ? 2 : pct > 0 ? 1 : 0;
                    return (
                      <td key={agent.key} className="text-center py-2 px-3">
                        <span style={{ color: stars > 0 ? agent.color : 'rgba(255,255,255,0.1)' }}>
                          {stars > 0 ? '★'.repeat(stars) + '☆'.repeat(3 - stars) : '—'}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </GlassCard>
    </div>
  );
}

// ─── Tab: Cost Center ───────────────────────────────────────────────

function CostCenterTab() {
  const totalCost = MOCK_MODELS.reduce((s, m) => s + m.cost, 0);
  const budget = 50;
  const pctUsed = (totalCost / budget) * 100;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard title="本月成本" value={`$${totalCost.toFixed(2)}`} accent="gold" trend="down" trendLabel="↓12% vs 上月" />
        <KpiCard title="月度预算" value={`$${budget}`} accent="default" />
        <KpiCard title="预算使用" value={`${pctUsed.toFixed(0)}%`} accent={pctUsed > 80 ? 'gold' : 'green'} trend={pctUsed > 80 ? 'up' : 'neutral'} trendLabel={pctUsed > 80 ? '接近上限' : '正常'} />
        <KpiCard title="本月 Token" value="597万" accent="purple" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <GlassCard glow>
          <SectionTitle>按模型成本分布</SectionTitle>
          <EChart option={makeCostBarOption()} height={280} />
        </GlassCard>
        <GlassCard glow>
          <SectionTitle>模型使用明细</SectionTitle>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                  <th className="text-left py-2 font-medium" style={{ color: 'var(--text-muted)' }}>模型</th>
                  <th className="text-right py-2 font-medium" style={{ color: 'var(--text-muted)' }}>平台</th>
                  <th className="text-right py-2 font-medium" style={{ color: 'var(--text-muted)' }}>调用</th>
                  <th className="text-right py-2 font-medium" style={{ color: 'var(--text-muted)' }}>Token</th>
                  <th className="text-right py-2 font-medium" style={{ color: 'var(--text-muted)' }}>成本</th>
                </tr>
              </thead>
              <tbody>
                {MOCK_MODELS.map(m => (
                  <tr key={m.name} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <td className="py-2 font-medium" style={{ color: 'var(--text-primary)' }}>{m.name}</td>
                    <td className="py-2 text-right" style={{ color: 'var(--text-secondary)' }}>{m.platform}</td>
                    <td className="py-2 text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>{m.calls}</td>
                    <td className="py-2 text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>{m.tokens > 0 ? `${(m.tokens / 10000).toFixed(0)}万` : '-'}</td>
                    <td className="py-2 text-right tabular-nums font-semibold" style={{ color: 'var(--accent-gold)' }}>${m.cost.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </GlassCard>
      </div>

      <GlassCard glow>
        <SectionTitle>按用户成本排名</SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {MOCK_USERS.sort((a, b) => b.tokens - a.tokens).map(u => {
            const cost = (u.tokens / 1000000) * 3; // rough estimate $3/M
            const topAgent = Object.entries(u.agents).sort((a, b) => b[1] - a[1])[0];
            const agentNames: Record<string, string> = { 'prd-agent': 'PRD', 'defect-agent': 'Defect', 'visual-agent': 'Visual', 'literary-agent': 'Literary' };
            return (
              <div key={u.id} className="flex items-center gap-3 p-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.02)' }}>
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold" style={{ background: 'rgba(214,178,106,0.1)', color: 'var(--accent-gold)' }}>{u.name[0]}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{u.name}</div>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>主用 {agentNames[topAgent[0]] || topAgent[0]}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold tabular-nums" style={{ color: 'var(--accent-gold)' }}>${cost.toFixed(2)}</div>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{(u.tokens / 10000).toFixed(1)}万 tk</div>
                </div>
              </div>
            );
          })}
        </div>
      </GlassCard>
    </div>
  );
}

// ─── Tab: Integrations ──────────────────────────────────────────────

function IntegrationsTab() {
  const integrations = [
    { source: 'Claude Code', icon: Zap, color: 'rgba(214,178,106,0.95)', active: true, lastSync: '5 分钟前', stats: { sessions: 23, commits: 45, lines: '2,340' } },
    { source: 'Jira', icon: BarChart3, color: 'rgba(59,130,246,0.95)', active: true, lastSync: '1 小时前', stats: { tasks: 34, completed: 28, inProgress: 6 } },
    { source: 'GitLab', icon: Activity, color: 'rgba(168,85,247,0.95)', active: false, lastSync: '未连接', stats: { mrs: 0, reviews: 0, pipelines: 0 } },
    { source: '飞书', icon: MessageSquare, color: 'rgba(34,197,94,0.95)', active: false, lastSync: '未连接', stats: {} },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {integrations.map(int => (
          <GlassCard key={int.source} glow interactive className="cursor-pointer">
            <div className="flex items-center gap-2.5 mb-3">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${int.color}15` }}>
                <int.icon size={16} style={{ color: int.color }} />
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{int.source}</div>
                <div className="text-[10px]" style={{ color: int.active ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                  {int.active ? `已连接 · ${int.lastSync}` : '未连接'}
                </div>
              </div>
              <div className="w-2 h-2 rounded-full" style={{ background: int.active ? 'var(--accent-green)' : 'rgba(255,255,255,0.15)' }} />
            </div>
            {int.active && (
              <div className="grid grid-cols-3 gap-2 text-center pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                {Object.entries(int.stats).map(([k, v]) => (
                  <div key={k}>
                    <div className="text-[15px] font-bold" style={{ color: 'var(--text-primary)' }}>{v}</div>
                    <div className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{k}</div>
                  </div>
                ))}
              </div>
            )}
          </GlassCard>
        ))}
      </div>

      <GlassCard glow>
        <SectionTitle>近期外部协作动态</SectionTitle>
        <div className="space-y-2">
          {[
            { source: 'Claude Code', user: '赵六', action: '完成 session: PRD Agent 前端重构', detail: '3 commits, +450/-120 行', time: '2 小时前', color: 'rgba(214,178,106,0.8)' },
            { source: 'Claude Code', user: '李四', action: '完成 session: Visual Agent 画布修复', detail: '5 commits, +230/-80 行', time: '4 小时前', color: 'rgba(214,178,106,0.8)' },
            { source: 'Jira', user: '张三', action: 'PRD-156 用户登录模块 → 已完成', detail: '3 story points', time: '5 小时前', color: 'rgba(59,130,246,0.8)' },
            { source: 'Jira', user: '王五', action: 'BUG-089 表单校验异常 → 已指派', detail: 'P1 优先级', time: '6 小时前', color: 'rgba(59,130,246,0.8)' },
            { source: 'Claude Code', user: '张三', action: '完成 session: 缺陷 Agent 测试补全', detail: '2 commits, +180 行', time: '昨天', color: 'rgba(214,178,106,0.8)' },
          ].map((item, i) => (
            <div key={i} className="flex items-start gap-3 py-2.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <div className="w-6 h-6 rounded flex items-center justify-center shrink-0 mt-0.5" style={{ background: `${item.color}15` }}>
                {item.source === 'Claude Code' ? <Zap size={12} style={{ color: item.color }} /> : <BarChart3 size={12} style={{ color: item.color }} />}
              </div>
              <div className="flex-1 min-w-0">
                <div>
                  <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{item.user}</span>
                  <span className="text-[10px] mx-1.5 px-1.5 py-0.5 rounded" style={{ background: `${item.color}15`, color: item.color }}>{item.source}</span>
                </div>
                <div className="text-[12px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>{item.action}</div>
                <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{item.detail}</div>
              </div>
              <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>{item.time}</span>
            </div>
          ))}
        </div>
      </GlassCard>

      <GlassCard>
        <SectionTitle>添加新集成</SectionTitle>
        <p className="text-[12px] mb-3" style={{ color: 'var(--text-secondary)' }}>
          通过 Webhook 协议接入第三方系统。所有数据统一写入 external_activities 集合，在个人画像和周报中自动展示。
        </p>
        <div className="text-[11px] font-mono p-3 rounded-lg" style={{ background: 'rgba(0,0,0,0.3)', color: 'var(--text-muted)' }}>
          POST /api/executive/external-activities<br />
          {'{'} "source": "your-tool", "userId": "...", "activityType": "...", "summary": "..." {'}'}
        </div>
      </GlassCard>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────

const TABS = [
  { key: 'overview', label: '全局概览', icon: <TrendingUp size={14} /> },
  { key: 'team', label: '团队洞察', icon: <Users size={14} /> },
  { key: 'agents', label: 'Agent 使用', icon: <Bot size={14} /> },
  { key: 'cost', label: '成本中心', icon: <DollarSign size={14} /> },
  { key: 'integrations', label: '外部协作', icon: <Link2 size={14} /> },
];

export default function ExecutiveDashboardPage() {
  const [activeTab, setActiveTab] = useState('overview');

  return (
    <div className="space-y-6">
      <TabBar
        items={TABS}
        activeKey={activeTab}
        onChange={setActiveTab}
        icon={<Crown size={16} />}
        variant="gold"
      />

      {activeTab === 'overview' && <OverviewTab />}
      {activeTab === 'team' && <TeamInsightsTab />}
      {activeTab === 'agents' && <AgentUsageTab />}
      {activeTab === 'cost' && <CostCenterTab />}
      {activeTab === 'integrations' && <IntegrationsTab />}
    </div>
  );
}
