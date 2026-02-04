import { useEffect, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import {
  Mail, Server, AlertTriangle, CheckCircle, Loader2, RefreshCw, Eye, EyeOff,
  ArrowRight, Zap, Shield, MessageSquare, Play, ExternalLink, Copy
} from 'lucide-react';
import { channelService } from '@/services';
import { toast } from '@/lib/toast';
import type { ChannelStatsResponse, ChannelSettings, UpdateSettingsRequest } from '@/services/contracts/channels';

interface SettingsPanelProps {
  onActionsReady?: (actions: React.ReactNode) => void;
}

// 常用邮箱服务商配置
const EMAIL_PROVIDERS = [
  { name: 'Gmail', imap: 'imap.gmail.com', smtp: 'smtp.gmail.com', imapPort: 993, smtpPort: 587, note: '需开启应用专用密码' },
  { name: 'Outlook', imap: 'outlook.office365.com', smtp: 'smtp.office365.com', imapPort: 993, smtpPort: 587, note: '' },
  { name: '163邮箱', imap: 'imap.163.com', smtp: 'smtp.163.com', imapPort: 993, smtpPort: 465, note: '需开启IMAP服务' },
  { name: 'QQ邮箱', imap: 'imap.qq.com', smtp: 'smtp.qq.com', imapPort: 993, smtpPort: 465, note: '需开启授权码' },
];

export default function SettingsPanel({ onActionsReady }: SettingsPanelProps) {
  const [stats, setStats] = useState<ChannelStatsResponse | null>(null);
  const [settings, setSettings] = useState<ChannelSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
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
      setForm({
        imapHost: settingsData.imapHost || '',
        imapPort: settingsData.imapPort || 993,
        imapUsername: settingsData.imapUsername || '',
        imapPassword: '',
        imapUseSsl: settingsData.imapUseSsl ?? true,
        smtpHost: settingsData.smtpHost || '',
        smtpPort: settingsData.smtpPort || 587,
        smtpUsername: settingsData.smtpUsername || '',
        smtpPassword: '',
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
        <Button variant="secondary" size="sm" onClick={handleTestConnection} disabled={testing || !form.imapHost}>
          {testing ? <Loader2 className="animate-spin mr-1" size={14} /> : null}
          测试连接
        </Button>
        <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
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
      toast.success('配置已保存');
    } catch (err) {
      toast.error('保存失败', err instanceof Error ? err.message : '未知错误');
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
    try {
      const result = await channelService.triggerPoll();
      if (result.success) {
        toast.success('轮询完成', `获取 ${result.emailCount ?? 0} 封邮件`);
      } else {
        toast.error('轮询失败', result.message);
      }
      const statsData = await channelService.getStats();
      setStats(statsData);
    } catch (err) {
      toast.error('轮询失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setPolling(false);
    }
  };

  const updateForm = (key: keyof UpdateSettingsRequest, value: string | number | boolean) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const applyProvider = (provider: typeof EMAIL_PROVIDERS[0]) => {
    updateForm('imapHost', provider.imap);
    updateForm('imapPort', provider.imapPort);
    updateForm('smtpHost', provider.smtp);
    updateForm('smtpPort', provider.smtpPort);
    toast.success(`已应用 ${provider.name} 配置`);
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  // 计算配置完成度
  const configSteps = [
    { done: !!settings?.imapHost, label: 'IMAP' },
    { done: !!settings?.smtpHost, label: 'SMTP' },
    { done: settings?.lastPollResult === 'success', label: '测试' },
    { done: settings?.isEnabled ?? false, label: '启用' },
  ];
  const completedSteps = configSteps.filter(s => s.done).length;

  return (
    <div className="h-full overflow-auto p-1">
      <div className="grid grid-cols-12 gap-5 pb-6">
        {/* 左栏 */}
        <div className="col-span-5 space-y-5">
          {/* 功能介绍 + 用户故事 */}
          <GlassCard glow className="p-5">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-gradient-to-br from-blue-500/30 to-purple-500/30 shrink-0">
                <MessageSquare size={24} className="text-blue-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-lg">邮件交互通道</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  通过邮件与 AI Agent 交互。转发邮件即可创建待办、智能分类、生成摘要。
                </p>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-3 gap-3">
              <div className="p-3 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
                <Zap size={18} className="text-yellow-400 mb-2" />
                <div className="text-sm font-medium">快速记录</div>
                <div className="text-xs text-muted-foreground mt-0.5">转发即创建待办</div>
              </div>
              <div className="p-3 rounded-xl bg-green-500/10 border border-green-500/20">
                <Shield size={18} className="text-green-400 mb-2" />
                <div className="text-sm font-medium">安全可控</div>
                <div className="text-xs text-muted-foreground mt-0.5">白名单授权</div>
              </div>
              <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20">
                <Mail size={18} className="text-blue-400 mb-2" />
                <div className="text-sm font-medium">自动回复</div>
                <div className="text-xs text-muted-foreground mt-0.5">结果即时反馈</div>
              </div>
            </div>

            {/* 配置进度 */}
            <div className="mt-5 pt-4 border-t border-white/10">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium">配置进度</span>
                <span className="text-sm text-muted-foreground">{completedSteps}/4 步</span>
              </div>
              <div className="flex gap-2">
                {configSteps.map((step, i) => (
                  <div key={i} className="flex-1">
                    <div className={`h-2 rounded-full ${step.done ? 'bg-green-500' : 'bg-white/10'}`} />
                    <div className={`text-xs mt-1 text-center ${step.done ? 'text-green-400' : 'text-muted-foreground'}`}>
                      {step.label}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </GlassCard>

          {/* 快速配置 - 服务商选择 */}
          <GlassCard glow className="p-5">
            <h4 className="font-medium mb-3 flex items-center gap-2">
              <Server size={16} className="text-muted-foreground" />
              快速配置
            </h4>
            <div className="grid grid-cols-2 gap-2">
              {EMAIL_PROVIDERS.map(provider => (
                <button
                  key={provider.name}
                  onClick={() => applyProvider(provider)}
                  className="p-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 transition-all text-left group"
                >
                  <div className="font-medium text-sm">{provider.name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                    <span>点击自动填充</span>
                    <ArrowRight size={10} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              选择邮箱服务商后会自动填充服务器地址和端口，你只需填写账号密码。
            </p>
          </GlassCard>

          {/* 运行状态 */}
          <GlassCard glow className="p-5">
            <div className="flex items-center justify-between mb-4">
              <h4 className="font-medium">运行状态</h4>
              <Badge variant={form.isEnabled ? 'success' : 'subtle'}>
                {form.isEnabled ? '运行中' : '已停止'}
              </Badge>
            </div>

            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="p-3 rounded-xl bg-white/5 text-center">
                <div className="text-xl font-bold">{stats?.todayTaskCount ?? 0}</div>
                <div className="text-xs text-muted-foreground">今日任务</div>
              </div>
              <div className="p-3 rounded-xl bg-white/5 text-center">
                <div className="text-xl font-bold text-green-400">{stats?.successRate ?? 0}%</div>
                <div className="text-xs text-muted-foreground">成功率</div>
              </div>
              <div className="p-3 rounded-xl bg-white/5 text-center">
                <div className="text-xl font-bold">{stats?.processingCount ?? 0}</div>
                <div className="text-xs text-muted-foreground">处理中</div>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-white/5 flex items-center justify-between">
              <div className="text-sm">
                <span className="text-muted-foreground">上次轮询：</span>
                <span className="ml-1">
                  {settings?.lastPollAt
                    ? new Date(settings.lastPollAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                    : '从未'}
                </span>
              </div>
              <Button variant="ghost" size="sm" onClick={handleTriggerPoll} disabled={polling || !form.isEnabled}>
                {polling ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}
              </Button>
            </div>
          </GlassCard>
        </div>

        {/* 右栏 - 配置表单 */}
        <div className="col-span-7 space-y-5">
          {/* 测试结果提示 */}
          {testResult && (
            <GlassCard className={`p-4 ${testResult.success ? 'border-green-500/30' : 'border-red-500/30'}`}>
              <div className="flex items-center gap-2">
                {testResult.success ? <CheckCircle className="text-green-400" size={18} /> : <AlertTriangle className="text-red-400" size={18} />}
                <span className={testResult.success ? 'text-green-400' : 'text-red-400'}>{testResult.message}</span>
              </div>
            </GlassCard>
          )}

          {/* IMAP + SMTP 配置合并 */}
          <GlassCard glow className="p-5">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-blue-500/20">
                <Mail size={20} className="text-blue-400" />
              </div>
              <div>
                <h3 className="font-semibold">IMAP 收信配置</h3>
                <p className="text-xs text-muted-foreground">配置邮件接收服务器，用于读取收件箱</p>
              </div>
              {settings?.imapHost && <Badge variant="success" className="ml-auto">已配置</Badge>}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1.5">服务器地址</label>
                <input
                  type="text"
                  value={form.imapHost}
                  onChange={e => updateForm('imapHost', e.target.value)}
                  placeholder="imap.gmail.com"
                  className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">端口</label>
                <input
                  type="number"
                  value={form.imapPort}
                  onChange={e => updateForm('imapPort', parseInt(e.target.value) || 993)}
                  className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">邮箱地址</label>
                <input
                  type="text"
                  value={form.imapUsername}
                  onChange={e => updateForm('imapUsername', e.target.value)}
                  placeholder="agent@company.com"
                  className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">密码 / 授权码</label>
                <div className="relative">
                  <input
                    type={showImapPassword ? 'text' : 'password'}
                    value={form.imapPassword}
                    onChange={e => updateForm('imapPassword', e.target.value)}
                    placeholder={settings?.imapPassword ? '••••••••' : '输入密码'}
                    className="w-full px-3 py-2 pr-9 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none text-sm"
                  />
                  <button type="button" onClick={() => setShowImapPassword(!showImapPassword)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    {showImapPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
              <div className="col-span-2 flex items-center gap-4 p-3 rounded-lg bg-white/5">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={form.imapUseSsl} onChange={e => updateForm('imapUseSsl', e.target.checked)} className="rounded" />
                  使用 SSL/TLS
                </label>
                <Button variant="ghost" size="sm" onClick={handleTestConnection} disabled={testing || !form.imapHost} className="ml-auto">
                  {testing && <Loader2 className="animate-spin mr-1" size={14} />}
                  测试 IMAP
                </Button>
              </div>
            </div>
          </GlassCard>

          <GlassCard glow className="p-5">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-purple-500/20">
                <Server size={20} className="text-purple-400" />
              </div>
              <div>
                <h3 className="font-semibold">SMTP 发信配置</h3>
                <p className="text-xs text-muted-foreground">配置邮件发送服务器，用于自动回复</p>
              </div>
              {settings?.smtpHost && <Badge variant="success" className="ml-auto">已配置</Badge>}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1.5">服务器地址</label>
                <input
                  type="text"
                  value={form.smtpHost}
                  onChange={e => updateForm('smtpHost', e.target.value)}
                  placeholder="smtp.gmail.com"
                  className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">端口</label>
                <input
                  type="number"
                  value={form.smtpPort}
                  onChange={e => updateForm('smtpPort', parseInt(e.target.value) || 587)}
                  className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">用户名</label>
                <input
                  type="text"
                  value={form.smtpUsername}
                  onChange={e => updateForm('smtpUsername', e.target.value)}
                  placeholder="与 IMAP 相同"
                  className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">密码</label>
                <div className="relative">
                  <input
                    type={showSmtpPassword ? 'text' : 'password'}
                    value={form.smtpPassword}
                    onChange={e => updateForm('smtpPassword', e.target.value)}
                    placeholder={settings?.smtpPassword ? '••••••••' : '与 IMAP 相同'}
                    className="w-full px-3 py-2 pr-9 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none text-sm"
                  />
                  <button type="button" onClick={() => setShowSmtpPassword(!showSmtpPassword)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    {showSmtpPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
              <div className="col-span-2 flex items-center gap-2 p-3 rounded-lg bg-white/5">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={form.smtpUseSsl} onChange={e => updateForm('smtpUseSsl', e.target.checked)} className="rounded" />
                  使用 SSL/TLS
                </label>
              </div>
            </div>
          </GlassCard>

          {/* 启用通道 */}
          <GlassCard glow className="p-5">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-green-500/20">
                <Play size={20} className="text-green-400" />
              </div>
              <div>
                <h3 className="font-semibold">启用通道</h3>
                <p className="text-xs text-muted-foreground">配置轮询间隔并启动邮件通道</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1.5">轮询间隔</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={form.pollIntervalMinutes}
                    onChange={e => updateForm('pollIntervalMinutes', parseInt(e.target.value) || 5)}
                    min={1}
                    max={60}
                    className="w-24 px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none text-sm"
                  />
                  <span className="text-sm text-muted-foreground">分钟</span>
                </div>
              </div>
              <div className="flex items-end">
                <button
                  onClick={() => updateForm('isEnabled', !form.isEnabled)}
                  className={`flex-1 p-3 rounded-xl transition-all flex items-center justify-between ${
                    form.isEnabled
                      ? 'bg-green-500/15 border border-green-500/30'
                      : 'bg-white/5 border border-white/10 hover:border-white/20'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-3 h-3 rounded-full ${form.isEnabled ? 'bg-green-400 animate-pulse' : 'bg-gray-500'}`} />
                    <span className="font-medium text-sm">{form.isEnabled ? '通道运行中' : '通道已停止'}</span>
                  </div>
                  <Badge variant={form.isEnabled ? 'success' : 'subtle'}>{form.isEnabled ? 'ON' : 'OFF'}</Badge>
                </button>
              </div>
            </div>

            {form.isEnabled && (
              <div className="mt-4 p-3 rounded-xl bg-green-500/10 border border-green-500/20 text-sm">
                <div className="flex items-center gap-2">
                  <CheckCircle size={16} className="text-green-400" />
                  <span className="text-green-400">系统将每 {form.pollIntervalMinutes} 分钟检查新邮件</span>
                </div>
              </div>
            )}
          </GlassCard>

          {/* 下一步 */}
          <GlassCard className="p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm">
                <span className="text-muted-foreground">配置完成后：</span>
                <span className="ml-1">添加白名单以允许特定邮箱发送请求</span>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => window.location.href = '/open-platform?tab=whitelist'}>
                  配置白名单
                  <ExternalLink size={12} className="ml-1" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => window.location.href = '/open-platform?tab=workflows'}>
                  配置工作流
                  <ExternalLink size={12} className="ml-1" />
                </Button>
              </div>
            </div>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}
