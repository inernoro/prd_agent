import { useEffect, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { Mail, Server, Clock, AlertTriangle, Info } from 'lucide-react';
import { channelService } from '@/services';
import type { ChannelStatsResponse } from '@/services/contracts/channels';

interface SettingsPanelProps {
  onActionsReady?: (actions: React.ReactNode) => void;
}

export default function SettingsPanel({ onActionsReady }: SettingsPanelProps) {
  const [stats, setStats] = useState<ChannelStatsResponse | null>(null);

  const loadStats = async () => {
    try {
      const data = await channelService.getStats();
      setStats(data);
    } catch (err) {
      console.error('Load stats failed:', err);
    }
  };

  useEffect(() => { loadStats(); }, []);

  useEffect(() => {
    onActionsReady?.(null);
  }, [onActionsReady]);

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-4xl mx-auto space-y-6 pb-6">
        {/* 使用指南 */}
        <GlassCard glow className="p-6">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-blue-500/20 text-blue-400">
              <Info size={20} />
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-semibold mb-2">开放平台配置指南</h3>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p><strong>什么是开放平台？</strong></p>
                <p>开放平台允许用户通过外部渠道（如邮件）与 AI Agent 进行交互。用户可以发送邮件给指定邮箱，系统会自动处理并回复。</p>

                <p className="mt-4"><strong>配置步骤：</strong></p>
                <ol className="list-decimal list-inside space-y-2 ml-2">
                  <li><strong>通道白名单</strong> - 配置允许哪些邮箱发送请求（支持通配符如 *@company.com）</li>
                  <li><strong>邮箱绑定</strong> - 将外部邮箱地址绑定到系统用户，以该用户身份执行操作</li>
                  <li><strong>API 应用</strong> - 如需通过 API 方式集成，可以创建应用并获取 API Key</li>
                  <li><strong>任务监控</strong> - 查看邮件处理任务的执行状态</li>
                  <li><strong>调用日志</strong> - 查看 API 调用的历史记录</li>
                </ol>

                <div className="mt-4 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                  <p className="text-yellow-400 flex items-center gap-2">
                    <AlertTriangle size={14} />
                    <span>邮箱服务器配置（IMAP/SMTP）需要在系统配置文件中设置，请联系管理员。</span>
                  </p>
                </div>
              </div>
            </div>
          </div>
        </GlassCard>

        {/* 通道状态 */}
        <GlassCard glow className="p-6">
          <div className="flex items-center gap-3 mb-6">
            <Server size={20} />
            <h3 className="text-lg font-semibold">通道状态</h3>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {stats?.channels?.map(channel => (
              <div
                key={channel.channelType}
                className="p-4 rounded-xl border"
                style={{
                  background: 'rgba(255,255,255,0.02)',
                  borderColor: channel.isEnabled ? 'rgba(34,197,94,0.3)' : 'rgba(255,255,255,0.1)',
                }}
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Mail size={16} />
                    <span className="font-medium">{channel.displayName}</span>
                  </div>
                  <Badge variant={channel.isEnabled ? 'success' : 'subtle'}>
                    {channel.isEnabled ? '已启用' : '未配置'}
                  </Badge>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                  <div>
                    <div className="text-lg font-semibold text-foreground">{channel.todayRequestCount}</div>
                    <div>今日请求</div>
                  </div>
                  <div>
                    <div className="text-lg font-semibold text-green-400">{channel.todaySuccessCount}</div>
                    <div>成功</div>
                  </div>
                  <div>
                    <div className="text-lg font-semibold text-red-400">{channel.todayFailCount}</div>
                    <div>失败</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </GlassCard>

        {/* 今日统计 */}
        <GlassCard glow className="p-6">
          <div className="flex items-center gap-3 mb-6">
            <Clock size={20} />
            <h3 className="text-lg font-semibold">今日统计</h3>
          </div>

          <div className="grid grid-cols-4 gap-6">
            <StatCard label="总任务数" value={stats?.todayTaskCount ?? 0} />
            <StatCard label="处理中" value={stats?.processingCount ?? 0} color="blue" />
            <StatCard label="成功率" value={`${stats?.successRate ?? 0}%`} color="green" />
            <StatCard label="平均耗时" value={`${stats?.avgDurationSeconds ?? 0}s`} />
          </div>
        </GlassCard>

        {/* 快速操作 */}
        <GlassCard glow className="p-6">
          <h3 className="text-lg font-semibold mb-4">快速开始</h3>
          <div className="flex gap-3">
            <Button variant="secondary" onClick={() => window.location.href = '/open-platform?tab=channels'}>
              配置白名单
            </Button>
            <Button variant="secondary" onClick={() => window.location.href = '/open-platform?tab=binding'}>
              绑定邮箱
            </Button>
            <Button variant="secondary" onClick={() => window.location.href = '/open-platform?tab=apps'}>
              创建 API 应用
            </Button>
          </div>
        </GlassCard>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  const colorClass = color === 'green' ? 'text-green-400' : color === 'blue' ? 'text-blue-400' : 'text-foreground';
  return (
    <div className="text-center">
      <div className={`text-2xl font-bold ${colorClass}`}>{value}</div>
      <div className="text-sm text-muted-foreground">{label}</div>
    </div>
  );
}
