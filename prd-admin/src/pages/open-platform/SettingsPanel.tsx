import { useEffect, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import {
  Mail, Server, Clock, AlertTriangle, CheckCircle, Loader2, RefreshCw, Eye, EyeOff,
  ArrowRight, Zap, Shield, MessageSquare, Settings, Play
} from 'lucide-react';
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
  const [currentStep, setCurrentStep] = useState(1);

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
      // Determine current step based on config status
      if (settingsData.isEnabled) {
        setCurrentStep(4);
      } else if (settingsData.imapHost && settingsData.smtpHost) {
        setCurrentStep(3);
      } else if (settingsData.imapHost) {
        setCurrentStep(2);
      }
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

  // 用户故事步骤
  const steps = [
    {
      id: 1,
      title: '配置收信服务',
      subtitle: 'IMAP 设置',
      description: '配置 IMAP 服务器，让系统能够接收邮件',
      icon: Mail,
      completed: !!settings?.imapHost,
    },
    {
      id: 2,
      title: '配置发信服务',
      subtitle: 'SMTP 设置',
      description: '配置 SMTP 服务器，让系统能够发送回复',
      icon: Server,
      completed: !!settings?.smtpHost,
    },
    {
      id: 3,
      title: '测试连接',
      subtitle: '验证配置',
      description: '测试邮箱连接是否正常，确保配置无误',
      icon: CheckCircle,
      completed: settings?.lastPollResult === 'success',
    },
    {
      id: 4,
      title: '启用通道',
      subtitle: '开始接收',
      description: '启用后系统将定时轮询邮件并自动处理',
      icon: Play,
      completed: settings?.isEnabled ?? false,
    },
  ];

  return (
    <div className="h-full overflow-auto p-1">
      <div className="grid grid-cols-12 gap-6 pb-6">
        {/* 左栏：用户故事引导 */}
        <div className="col-span-4 space-y-4">
          {/* 功能介绍卡片 */}
          <GlassCard glow className="p-5">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-gradient-to-br from-blue-500/30 to-purple-500/30">
                <MessageSquare size={20} className="text-blue-400" />
              </div>
              <div>
                <h3 className="font-semibold">邮件交互通道</h3>
                <p className="text-xs text-muted-foreground">Email Channel</p>
              </div>
            </div>

            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground leading-relaxed">
                通过邮件与 AI Agent 交互，无需打开应用。发送邮件即可创建待办、分类邮件、生成摘要等。
              </p>

              <div className="pt-3 border-t border-white/10 space-y-2">
                <h4 className="font-medium text-xs text-muted-foreground uppercase tracking-wider">解决的问题</h4>
                <ul className="space-y-2">
                  <li className="flex items-start gap-2">
                    <Zap size={14} className="text-yellow-400 mt-0.5 shrink-0" />
                    <span className="text-muted-foreground">快速记录 - 邮件转发即创建待办</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Shield size={14} className="text-green-400 mt-0.5 shrink-0" />
                    <span className="text-muted-foreground">白名单控制 - 仅授权邮箱可用</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <MessageSquare size={14} className="text-blue-400 mt-0.5 shrink-0" />
                    <span className="text-muted-foreground">自动回复 - 处理结果即时反馈</span>
                  </li>
                </ul>
              </div>
            </div>
          </GlassCard>

          {/* 配置步骤卡片 */}
          <GlassCard glow className="p-5">
            <div className="flex items-center gap-2 mb-4">
              <Settings size={16} className="text-muted-foreground" />
              <h3 className="font-medium">配置步骤</h3>
            </div>

            <div className="space-y-1">
              {steps.map((step, index) => {
                const Icon = step.icon;
                const isActive = currentStep === step.id;
                const isCompleted = step.completed;

                return (
                  <button
                    key={step.id}
                    onClick={() => setCurrentStep(step.id)}
                    className={`w-full text-left p-3 rounded-xl transition-all ${
                      isActive
                        ? 'bg-blue-500/15 border border-blue-500/30'
                        : 'hover:bg-white/5 border border-transparent'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                        isCompleted
                          ? 'bg-green-500/20 text-green-400'
                          : isActive
                            ? 'bg-blue-500/20 text-blue-400'
                            : 'bg-white/5 text-muted-foreground'
                      }`}>
                        {isCompleted ? <CheckCircle size={16} /> : <Icon size={16} />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`font-medium text-sm ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}>
                            {step.title}
                          </span>
                          {isCompleted && (
                            <Badge variant="success" size="sm">已完成</Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">
                          {step.description}
                        </p>
                      </div>
                      {isActive && <ArrowRight size={14} className="text-blue-400 mt-2" />}
                    </div>
                  </button>
                );
              })}
            </div>
          </GlassCard>

          {/* 运行状态卡片 */}
          <GlassCard glow className="p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-medium">运行状态</h3>
              <Badge variant={form.isEnabled ? 'success' : 'subtle'}>
                {form.isEnabled ? '运行中' : '已停止'}
              </Badge>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-xl bg-white/5 text-center">
                <div className="text-2xl font-bold text-foreground">{stats?.todayTaskCount ?? 0}</div>
                <div className="text-xs text-muted-foreground">今日任务</div>
              </div>
              <div className="p-3 rounded-xl bg-white/5 text-center">
                <div className="text-2xl font-bold text-green-400">{stats?.successRate ?? 0}%</div>
                <div className="text-xs text-muted-foreground">成功率</div>
              </div>
            </div>

            <div className="mt-4 p-3 rounded-xl bg-white/5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">上次轮询</span>
                <span>
                  {settings?.lastPollAt
                    ? new Date(settings.lastPollAt).toLocaleString('zh-CN', {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                      })
                    : '从未'}
                </span>
              </div>
            </div>

            <Button
              variant="secondary"
              size="sm"
              onClick={handleTriggerPoll}
              disabled={polling || !form.isEnabled}
              className="w-full mt-3"
            >
              {polling ? <Loader2 className="animate-spin mr-1" size={14} /> : <RefreshCw size={14} className="mr-1" />}
              立即轮询
            </Button>
          </GlassCard>
        </div>

        {/* 右栏：配置表单 */}
        <div className="col-span-8 space-y-4">
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

          {/* Step 1: IMAP 配置 */}
          {currentStep === 1 && (
            <GlassCard glow className="p-6">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-blue-500/20">
                  <Mail size={20} className="text-blue-400" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold">IMAP 收信配置</h3>
                  <p className="text-sm text-muted-foreground">配置邮件接收服务器</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1.5">IMAP 服务器地址 *</label>
                  <input
                    type="text"
                    value={form.imapHost}
                    onChange={e => updateForm('imapHost', e.target.value)}
                    placeholder="如：imap.gmail.com"
                    className="w-full px-3 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
                  />
                  <p className="text-xs text-muted-foreground mt-1">Gmail: imap.gmail.com | Outlook: outlook.office365.com</p>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5">端口</label>
                  <input
                    type="number"
                    value={form.imapPort}
                    onChange={e => updateForm('imapPort', parseInt(e.target.value) || 993)}
                    className="w-full px-3 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
                  />
                  <p className="text-xs text-muted-foreground mt-1">SSL 默认 993，非 SSL 默认 143</p>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5">用户名（邮箱地址）*</label>
                  <input
                    type="text"
                    value={form.imapUsername}
                    onChange={e => updateForm('imapUsername', e.target.value)}
                    placeholder="如：agent@company.com"
                    className="w-full px-3 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5">密码 *</label>
                  <div className="relative">
                    <input
                      type={showImapPassword ? 'text' : 'password'}
                      value={form.imapPassword}
                      onChange={e => updateForm('imapPassword', e.target.value)}
                      placeholder={settings?.imapPassword ? '••••••••（已配置）' : '输入密码或应用专用密码'}
                      className="w-full px-3 py-2.5 pr-10 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowImapPassword(!showImapPassword)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showImapPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">Gmail 需使用"应用专用密码"</p>
                </div>
                <div className="col-span-2 flex items-center gap-2 p-3 rounded-lg bg-white/5">
                  <input
                    type="checkbox"
                    id="imapSsl"
                    checked={form.imapUseSsl}
                    onChange={e => updateForm('imapUseSsl', e.target.checked)}
                    className="rounded"
                  />
                  <label htmlFor="imapSsl" className="text-sm">使用 SSL/TLS 加密（推荐）</label>
                </div>
              </div>

              <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-white/10">
                <Button variant="secondary" onClick={handleTestConnection} disabled={testing || !form.imapHost}>
                  {testing && <Loader2 className="animate-spin mr-1" size={14} />}
                  测试 IMAP 连接
                </Button>
                <Button onClick={() => { handleSave(); setCurrentStep(2); }}>
                  保存并继续
                  <ArrowRight size={14} className="ml-1" />
                </Button>
              </div>
            </GlassCard>
          )}

          {/* Step 2: SMTP 配置 */}
          {currentStep === 2 && (
            <GlassCard glow className="p-6">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-purple-500/20">
                  <Server size={20} className="text-purple-400" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold">SMTP 发信配置</h3>
                  <p className="text-sm text-muted-foreground">配置邮件发送服务器（用于自动回复）</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1.5">SMTP 服务器地址 *</label>
                  <input
                    type="text"
                    value={form.smtpHost}
                    onChange={e => updateForm('smtpHost', e.target.value)}
                    placeholder="如：smtp.gmail.com"
                    className="w-full px-3 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
                  />
                  <p className="text-xs text-muted-foreground mt-1">Gmail: smtp.gmail.com | Outlook: smtp.office365.com</p>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5">端口</label>
                  <input
                    type="number"
                    value={form.smtpPort}
                    onChange={e => updateForm('smtpPort', parseInt(e.target.value) || 587)}
                    className="w-full px-3 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
                  />
                  <p className="text-xs text-muted-foreground mt-1">TLS 默认 587，SSL 默认 465</p>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5">用户名</label>
                  <input
                    type="text"
                    value={form.smtpUsername}
                    onChange={e => updateForm('smtpUsername', e.target.value)}
                    placeholder="通常与 IMAP 用户名相同"
                    className="w-full px-3 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5">密码</label>
                  <div className="relative">
                    <input
                      type={showSmtpPassword ? 'text' : 'password'}
                      value={form.smtpPassword}
                      onChange={e => updateForm('smtpPassword', e.target.value)}
                      placeholder={settings?.smtpPassword ? '••••••••（已配置）' : '通常与 IMAP 密码相同'}
                      className="w-full px-3 py-2.5 pr-10 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
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
                <div className="col-span-2 flex items-center gap-2 p-3 rounded-lg bg-white/5">
                  <input
                    type="checkbox"
                    id="smtpSsl"
                    checked={form.smtpUseSsl}
                    onChange={e => updateForm('smtpUseSsl', e.target.checked)}
                    className="rounded"
                  />
                  <label htmlFor="smtpSsl" className="text-sm">使用 SSL/TLS 加密（推荐）</label>
                </div>
              </div>

              <div className="flex justify-between gap-3 mt-6 pt-4 border-t border-white/10">
                <Button variant="ghost" onClick={() => setCurrentStep(1)}>
                  返回上一步
                </Button>
                <Button onClick={() => { handleSave(); setCurrentStep(3); }}>
                  保存并继续
                  <ArrowRight size={14} className="ml-1" />
                </Button>
              </div>
            </GlassCard>
          )}

          {/* Step 3: 测试连接 */}
          {currentStep === 3 && (
            <GlassCard glow className="p-6">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-green-500/20">
                  <CheckCircle size={20} className="text-green-400" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold">测试连接</h3>
                  <p className="text-sm text-muted-foreground">验证邮箱配置是否正确</p>
                </div>
              </div>

              <div className="space-y-4">
                <div className="p-4 rounded-xl bg-white/5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Mail size={18} className="text-blue-400" />
                      <div>
                        <div className="font-medium">IMAP 收信服务</div>
                        <div className="text-sm text-muted-foreground">{form.imapHost}:{form.imapPort}</div>
                      </div>
                    </div>
                    <Badge variant={settings?.imapHost ? 'success' : 'subtle'}>
                      {settings?.imapHost ? '已配置' : '未配置'}
                    </Badge>
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-white/5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Server size={18} className="text-purple-400" />
                      <div>
                        <div className="font-medium">SMTP 发信服务</div>
                        <div className="text-sm text-muted-foreground">{form.smtpHost}:{form.smtpPort}</div>
                      </div>
                    </div>
                    <Badge variant={settings?.smtpHost ? 'success' : 'subtle'}>
                      {settings?.smtpHost ? '已配置' : '未配置'}
                    </Badge>
                  </div>
                </div>

                <div className="p-4 rounded-xl border border-dashed border-white/20 text-center">
                  <p className="text-muted-foreground mb-3">点击下方按钮测试邮箱连接是否正常</p>
                  <Button onClick={handleTestConnection} disabled={testing}>
                    {testing && <Loader2 className="animate-spin mr-1" size={14} />}
                    测试连接
                  </Button>
                </div>

                {testResult && (
                  <div className={`p-4 rounded-xl ${testResult.success ? 'bg-green-500/10 border border-green-500/30' : 'bg-red-500/10 border border-red-500/30'}`}>
                    <div className="flex items-center gap-2">
                      {testResult.success ? (
                        <CheckCircle className="text-green-400" size={18} />
                      ) : (
                        <AlertTriangle className="text-red-400" size={18} />
                      )}
                      <span className={testResult.success ? 'text-green-400' : 'text-red-400'}>
                        {testResult.message}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex justify-between gap-3 mt-6 pt-4 border-t border-white/10">
                <Button variant="ghost" onClick={() => setCurrentStep(2)}>
                  返回上一步
                </Button>
                <Button onClick={() => setCurrentStep(4)} disabled={!testResult?.success && !settings?.lastPollResult}>
                  继续
                  <ArrowRight size={14} className="ml-1" />
                </Button>
              </div>
            </GlassCard>
          )}

          {/* Step 4: 启用通道 */}
          {currentStep === 4 && (
            <GlassCard glow className="p-6">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-yellow-500/20">
                  <Play size={20} className="text-yellow-400" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold">启用通道</h3>
                  <p className="text-sm text-muted-foreground">配置轮询间隔并启用邮件通道</p>
                </div>
              </div>

              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1.5">轮询间隔（分钟）</label>
                    <input
                      type="number"
                      value={form.pollIntervalMinutes}
                      onChange={e => updateForm('pollIntervalMinutes', parseInt(e.target.value) || 5)}
                      min={1}
                      max={60}
                      className="w-full px-3 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none"
                    />
                    <p className="text-xs text-muted-foreground mt-1">建议 5-15 分钟，太频繁可能触发邮箱限制</p>
                  </div>
                  <div className="flex items-end">
                    <div
                      className={`w-full p-4 rounded-xl cursor-pointer transition-all ${
                        form.isEnabled
                          ? 'bg-green-500/15 border border-green-500/30'
                          : 'bg-white/5 border border-white/10 hover:border-white/20'
                      }`}
                      onClick={() => updateForm('isEnabled', !form.isEnabled)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className={`w-3 h-3 rounded-full ${form.isEnabled ? 'bg-green-400' : 'bg-gray-500'}`} />
                          <span className="font-medium">{form.isEnabled ? '通道已启用' : '通道已禁用'}</span>
                        </div>
                        <Badge variant={form.isEnabled ? 'success' : 'subtle'}>
                          {form.isEnabled ? 'ON' : 'OFF'}
                        </Badge>
                      </div>
                    </div>
                  </div>
                </div>

                {form.isEnabled && (
                  <div className="p-4 rounded-xl bg-green-500/10 border border-green-500/20">
                    <div className="flex items-start gap-3">
                      <CheckCircle size={18} className="text-green-400 mt-0.5" />
                      <div>
                        <p className="text-green-400 font-medium">通道已启用</p>
                        <p className="text-sm text-muted-foreground mt-1">
                          系统将每 {form.pollIntervalMinutes} 分钟检查一次新邮件，并自动处理符合条件的邮件。
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
                  <div className="flex items-start gap-2">
                    <AlertTriangle size={14} className="text-amber-400 mt-0.5" />
                    <div className="text-sm">
                      <span className="text-amber-400 font-medium">下一步建议：</span>
                      <span className="text-muted-foreground ml-1">
                        前往"通道白名单"标签页配置允许发送请求的邮箱，或前往"邮件工作流"配置处理规则。
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex justify-between gap-3 mt-6 pt-4 border-t border-white/10">
                <Button variant="ghost" onClick={() => setCurrentStep(3)}>
                  返回上一步
                </Button>
                <Button onClick={handleSave} disabled={saving}>
                  {saving && <Loader2 className="animate-spin mr-1" size={14} />}
                  保存配置
                </Button>
              </div>
            </GlassCard>
          )}

          {/* 快速导航 */}
          <GlassCard className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">配置完成后，继续下一步：</span>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => window.location.href = '/open-platform?tab=whitelist'}>
                  配置白名单
                </Button>
                <Button variant="ghost" size="sm" onClick={() => window.location.href = '/open-platform?tab=workflows'}>
                  配置工作流
                </Button>
                <Button variant="ghost" size="sm" onClick={() => window.location.href = '/open-platform?tab=tasks'}>
                  查看任务
                </Button>
              </div>
            </div>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}
