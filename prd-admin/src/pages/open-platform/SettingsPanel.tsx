import { useEffect, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { Mail, Server, Clock, AlertTriangle, Info, CheckCircle, Loader2, RefreshCw, Eye, EyeOff } from 'lucide-react';
import { channelService } from '@/services';
import type { ChannelStatsResponse, ChannelSettings, UpdateSettingsRequest } from '@/services/contracts/channels';

interface SettingsPanelProps {
  onActionsReady?: (actions: React.ReactNode) => void;
}

export default function SettingsPanel({ onActionsReady }: SettingsPanelProps) {
  const [stats, setStats] = useState<ChannelStatsResponse | null>(null);
  const [settings, setSettings] = useState<ChannelSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [pollResult, setPollResult] = useState<{ success: boolean; message: string; emailCount?: number } | null>(null);
  const [showImapPassword, setShowImapPassword] = useState(false);
  const [showSmtpPassword, setShowSmtpPassword] = useState(false);

  // Form state
  const [form, setForm] = useState<UpdateSettingsRequest>({
    imapHost: '',
    imapPort: 993,
    imapUsername: '',
    imapPassword: '',
    imapUseSsl: true,
    smtpHost: '',
    smtpPort: 587,
    smtpUsername: '',
    smtpPassword: '',
    smtpUseSsl: true,
    pollIntervalMinutes: 5,
    isEnabled: false,
  });

  const loadData = async () => {
    setLoading(true);
    try {
      const [statsData, settingsData] = await Promise.all([
        channelService.getStats(),
        channelService.getSettings(),
      ]);
      setStats(statsData);
      setSettings(settingsData);
      // Populate form with existing settings
      setForm({
        imapHost: settingsData.imapHost || '',
        imapPort: settingsData.imapPort || 993,
        imapUsername: settingsData.imapUsername || '',
        imapPassword: '', // Don't show existing password
        imapUseSsl: settingsData.imapUseSsl ?? true,
        smtpHost: settingsData.smtpHost || '',
        smtpPort: settingsData.smtpPort || 587,
        smtpUsername: settingsData.smtpUsername || '',
        smtpPassword: '', // Don't show existing password
        smtpUseSsl: settingsData.smtpUseSsl ?? true,
        pollIntervalMinutes: settingsData.pollIntervalMinutes || 5,
        isEnabled: settingsData.isEnabled ?? false,
      });
    } catch (err) {
      console.error('Load data failed:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    onActionsReady?.(
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={handleTestConnection}
          disabled={testing || !form.imapHost || !form.imapUsername}
          className="whitespace-nowrap"
        >
          {testing ? <Loader2 className="animate-spin mr-1" size={14} /> : null}
          测试连接
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          disabled={saving}
          className="whitespace-nowrap"
        >
          {saving ? <Loader2 className="animate-spin mr-1" size={14} /> : null}
          保存配置
        </Button>
      </div>
    );
  }, [onActionsReady, testing, saving, form]);

  const handleSave = async () => {
    setSaving(true);
    setTestResult(null);
    try {
      const updated = await channelService.updateSettings(form);
      setSettings(updated);
      setTestResult({ success: true, message: '配置已保存' });
    } catch (err) {
      setTestResult({ success: false, message: err instanceof Error ? err.message : '保存失败' });
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await channelService.testConnection({
        imapHost: form.imapHost || '',
        imapPort: form.imapPort || 993,
        imapUsername: form.imapUsername || '',
        imapPassword: form.imapPassword || settings?.imapPassword || '',
        imapUseSsl: form.imapUseSsl ?? true,
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({ success: false, message: err instanceof Error ? err.message : '测试失败' });
    } finally {
      setTesting(false);
    }
  };

  const handleTriggerPoll = async () => {
    setPolling(true);
    setPollResult(null);
    try {
      const result = await channelService.triggerPoll();
      setPollResult(result);
      // Refresh stats after poll
      const statsData = await channelService.getStats();
      setStats(statsData);
    } catch (err) {
      setPollResult({ success: false, message: err instanceof Error ? err.message : '轮询失败' });
    } finally {
      setPolling(false);
    }
  };

  const updateForm = (key: keyof UpdateSettingsRequest, value: string | number | boolean) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

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
              <h3 className="text-lg font-semibold mb-2">邮件通道配置指南</h3>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p><strong>什么是邮件通道？</strong></p>
                <p>邮件通道允许用户通过发送邮件给指定邮箱与 AI Agent 进行交互。系统会定时轮询收件箱，处理邮件并自动回复。</p>

                <p className="mt-4"><strong>配置步骤：</strong></p>
                <ol className="list-decimal list-inside space-y-2 ml-2">
                  <li><strong>配置 IMAP</strong> - 用于接收邮件（支持 Gmail、Outlook、企业邮箱等）</li>
                  <li><strong>配置 SMTP</strong> - 用于发送回复邮件</li>
                  <li><strong>测试连接</strong> - 验证邮箱配置是否正确</li>
                  <li><strong>启用通道</strong> - 开启后系统将定时轮询邮件</li>
                  <li><strong>配置白名单</strong> - 限制哪些邮箱可以发送请求（在"通道白名单"标签页）</li>
                </ol>

                <div className="mt-4 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                  <p className="text-yellow-400 flex items-center gap-2">
                    <AlertTriangle size={14} />
                    <span>建议使用专用邮箱账号，避免与个人邮件混淆。如使用 Gmail 需开启"应用专用密码"。</span>
                  </p>
                </div>
              </div>
            </div>
          </div>
        </GlassCard>

        {/* 测试/轮询结果提示 */}
        {(testResult || pollResult) && (
          <GlassCard className={`p-4 ${(testResult?.success ?? pollResult?.success) ? 'border-green-500/30' : 'border-red-500/30'}`}>
            <div className="flex items-center gap-2">
              {(testResult?.success ?? pollResult?.success) ? (
                <CheckCircle className="text-green-400" size={18} />
              ) : (
                <AlertTriangle className="text-red-400" size={18} />
              )}
              <span className={(testResult?.success ?? pollResult?.success) ? 'text-green-400' : 'text-red-400'}>
                {testResult?.message || pollResult?.message}
                {pollResult?.emailCount !== undefined && ` (获取 ${pollResult.emailCount} 封邮件)`}
              </span>
            </div>
          </GlassCard>
        )}

        {/* IMAP 收信配置 */}
        <GlassCard glow className="p-6">
          <div className="flex items-center gap-3 mb-6">
            <Mail size={20} />
            <h3 className="text-lg font-semibold">IMAP 收信配置</h3>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">IMAP 服务器地址</label>
              <input
                type="text"
                value={form.imapHost}
                onChange={e => updateForm('imapHost', e.target.value)}
                placeholder="如：imap.gmail.com"
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">端口</label>
              <input
                type="number"
                value={form.imapPort}
                onChange={e => updateForm('imapPort', parseInt(e.target.value) || 993)}
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">用户名（邮箱地址）</label>
              <input
                type="text"
                value={form.imapUsername}
                onChange={e => updateForm('imapUsername', e.target.value)}
                placeholder="如：agent@company.com"
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">密码</label>
              <div className="relative">
                <input
                  type={showImapPassword ? 'text' : 'password'}
                  value={form.imapPassword}
                  onChange={e => updateForm('imapPassword', e.target.value)}
                  placeholder={settings?.imapPassword ? '••••••••（已配置）' : '输入密码'}
                  className="w-full px-3 py-2 pr-10 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowImapPassword(!showImapPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showImapPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <div className="col-span-2 flex items-center gap-2">
              <input
                type="checkbox"
                id="imapSsl"
                checked={form.imapUseSsl}
                onChange={e => updateForm('imapUseSsl', e.target.checked)}
                className="rounded"
              />
              <label htmlFor="imapSsl" className="text-sm">使用 SSL/TLS 加密</label>
            </div>
          </div>
        </GlassCard>

        {/* SMTP 发信配置 */}
        <GlassCard glow className="p-6">
          <div className="flex items-center gap-3 mb-6">
            <Server size={20} />
            <h3 className="text-lg font-semibold">SMTP 发信配置</h3>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">SMTP 服务器地址</label>
              <input
                type="text"
                value={form.smtpHost}
                onChange={e => updateForm('smtpHost', e.target.value)}
                placeholder="如：smtp.gmail.com"
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">端口</label>
              <input
                type="number"
                value={form.smtpPort}
                onChange={e => updateForm('smtpPort', parseInt(e.target.value) || 587)}
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">用户名</label>
              <input
                type="text"
                value={form.smtpUsername}
                onChange={e => updateForm('smtpUsername', e.target.value)}
                placeholder="通常与 IMAP 用户名相同"
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">密码</label>
              <div className="relative">
                <input
                  type={showSmtpPassword ? 'text' : 'password'}
                  value={form.smtpPassword}
                  onChange={e => updateForm('smtpPassword', e.target.value)}
                  placeholder={settings?.smtpPassword ? '••••••••（已配置）' : '输入密码'}
                  className="w-full px-3 py-2 pr-10 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowSmtpPassword(!showSmtpPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showSmtpPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <div className="col-span-2 flex items-center gap-2">
              <input
                type="checkbox"
                id="smtpSsl"
                checked={form.smtpUseSsl}
                onChange={e => updateForm('smtpUseSsl', e.target.checked)}
                className="rounded"
              />
              <label htmlFor="smtpSsl" className="text-sm">使用 SSL/TLS 加密</label>
            </div>
          </div>
        </GlassCard>

        {/* 轮询配置 */}
        <GlassCard glow className="p-6">
          <div className="flex items-center gap-3 mb-6">
            <Clock size={20} />
            <h3 className="text-lg font-semibold">轮询配置</h3>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">轮询间隔（分钟）</label>
              <input
                type="number"
                value={form.pollIntervalMinutes}
                onChange={e => updateForm('pollIntervalMinutes', parseInt(e.target.value) || 5)}
                min={1}
                max={60}
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
              />
            </div>
            <div className="flex items-end">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="isEnabled"
                    checked={form.isEnabled}
                    onChange={e => updateForm('isEnabled', e.target.checked)}
                    className="rounded"
                  />
                  <label htmlFor="isEnabled" className="text-sm font-medium">启用邮件通道</label>
                </div>
                <Badge variant={form.isEnabled ? 'success' : 'subtle'}>
                  {form.isEnabled ? '已启用' : '未启用'}
                </Badge>
              </div>
            </div>
            <div className="col-span-2">
              <div className="flex items-center justify-between p-3 rounded-lg bg-white/5">
                <div className="text-sm">
                  <span className="text-muted-foreground">上次轮询：</span>
                  <span className="ml-2">
                    {settings?.lastPollAt
                      ? new Date(settings.lastPollAt).toLocaleString()
                      : '从未'}
                  </span>
                  {settings?.lastPollResult && (
                    <Badge
                      variant={settings.lastPollResult === 'success' ? 'success' : 'danger'}
                      className="ml-2"
                    >
                      {settings.lastPollResult === 'success' ? '成功' : '失败'}
                    </Badge>
                  )}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleTriggerPoll}
                  disabled={polling || !form.isEnabled}
                  className="whitespace-nowrap"
                >
                  {polling ? <Loader2 className="animate-spin mr-1" size={14} /> : <RefreshCw size={14} className="mr-1" />}
                  立即轮询
                </Button>
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
          <h3 className="text-lg font-semibold mb-4">下一步</h3>
          <div className="flex gap-3">
            <Button variant="secondary" onClick={() => window.location.href = '/open-platform?tab=channels'} className="whitespace-nowrap">
              配置白名单
            </Button>
            <Button variant="secondary" onClick={() => window.location.href = '/open-platform?tab=binding'} className="whitespace-nowrap">
              绑定邮箱
            </Button>
            <Button variant="secondary" onClick={() => window.location.href = '/open-platform?tab=tasks'} className="whitespace-nowrap">
              查看任务
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
