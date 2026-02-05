import { useEffect, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { Mail, Server, AlertTriangle, CheckCircle, Loader2, RefreshCw, Eye, EyeOff, ArrowRight, Zap, Shield, Play } from 'lucide-react';
import { channelService } from '@/services';
import { toast } from '@/lib/toast';
import type { ChannelStatsResponse, ChannelSettings, UpdateSettingsRequest } from '@/services/contracts/channels';

interface SettingsPanelProps {
  onActionsReady?: (actions: React.ReactNode) => void;
}

const EMAIL_PROVIDERS = [
  { name: 'Gmail', imap: 'imap.gmail.com', smtp: 'smtp.gmail.com', imapPort: 993, smtpPort: 587 },
  { name: 'Outlook', imap: 'outlook.office365.com', smtp: 'smtp.office365.com', imapPort: 993, smtpPort: 587 },
  { name: '163', imap: 'imap.163.com', smtp: 'smtp.163.com', imapPort: 993, smtpPort: 465 },
  { name: 'QQ', imap: 'imap.qq.com', smtp: 'smtp.qq.com', imapPort: 993, smtpPort: 465 },
];

export default function SettingsPanel({ onActionsReady }: SettingsPanelProps) {
  const [stats, setStats] = useState<ChannelStatsResponse | null>(null);
  const [settings, setSettings] = useState<ChannelSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showImapPwd, setShowImapPwd] = useState(false);
  const [showSmtpPwd, setShowSmtpPwd] = useState(false);

  const [form, setForm] = useState<UpdateSettingsRequest>({
    imapHost: '', imapPort: 993, imapUsername: '', imapPassword: '', imapUseSsl: true,
    smtpHost: '', smtpPort: 587, smtpUsername: '', smtpPassword: '', smtpUseSsl: true,
    pollIntervalMinutes: 5, isEnabled: false,
  });

  const loadData = async () => {
    setLoading(true);
    try {
      const [statsData, settingsData] = await Promise.all([channelService.getStats(), channelService.getSettings()]);
      setStats(statsData);
      setSettings(settingsData);
      setForm({
        imapHost: settingsData.imapHost || '', imapPort: settingsData.imapPort || 993,
        imapUsername: settingsData.imapUsername || '', imapPassword: '',
        imapUseSsl: settingsData.imapUseSsl ?? true,
        smtpHost: settingsData.smtpHost || '', smtpPort: settingsData.smtpPort || 587,
        smtpUsername: settingsData.smtpUsername || '', smtpPassword: '',
        smtpUseSsl: settingsData.smtpUseSsl ?? true,
        pollIntervalMinutes: settingsData.pollIntervalMinutes || 5,
        isEnabled: settingsData.isEnabled ?? false,
      });
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    onActionsReady?.(
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={handleTest} disabled={testing || !form.imapHost}>
          {testing && <Loader2 className="animate-spin mr-1" size={14} />}测试连接
        </Button>
        <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="animate-spin mr-1" size={14} />}保存配置
        </Button>
      </div>
    );
  }, [onActionsReady, testing, saving, form]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await channelService.updateSettings(form);
      setSettings(updated);
      toast.success('配置已保存');
    } catch (err) { toast.error('保存失败', err instanceof Error ? err.message : ''); }
    finally { setSaving(false); }
  };

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const result = await channelService.testConnection({
        imapHost: form.imapHost, imapPort: form.imapPort, imapUsername: form.imapUsername,
        imapPassword: form.imapPassword || settings?.imapPassword || '', imapUseSsl: form.imapUseSsl,
      });
      setTestResult(result);
    } catch (err) { setTestResult({ success: false, message: err instanceof Error ? err.message : '测试失败' }); }
    finally { setTesting(false); }
  };

  const handlePoll = async () => {
    setPolling(true);
    try {
      const result = await channelService.triggerPoll();
      if (result.success) toast.success('轮询完成', `${result.emailCount ?? 0} 封`);
      else toast.error('轮询失败', result.message);
      setStats(await channelService.getStats());
    } catch (err) { toast.error('轮询失败'); }
    finally { setPolling(false); }
  };

  const set = (k: keyof UpdateSettingsRequest, v: string | number | boolean) => setForm(p => ({ ...p, [k]: v }));

  const apply = (p: typeof EMAIL_PROVIDERS[0]) => {
    set('imapHost', p.imap); set('imapPort', p.imapPort);
    set('smtpHost', p.smtp); set('smtpPort', p.smtpPort);
    toast.success(`已应用 ${p.name}`);
  };

  if (loading) return <div className="h-full flex items-center justify-center"><Loader2 className="animate-spin" size={24} /></div>;

  const steps = [
    { done: !!settings?.imapHost, label: 'IMAP' },
    { done: !!settings?.smtpHost, label: 'SMTP' },
    { done: settings?.lastPollResult === 'success', label: '测试' },
    { done: settings?.isEnabled, label: '启用' },
  ];

  const inputCls = "w-full px-2.5 py-1.5 rounded bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none text-sm";

  return (
    <div className="h-full overflow-auto">
      <GlassCard glow className="m-1">
        <div className="grid grid-cols-12 divide-x divide-white/10">
          {/* 左栏：配置 */}
          <div className="col-span-7 p-5 space-y-5">
            {/* IMAP */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Mail size={14} className="text-blue-400" />
                <span className="text-sm font-medium">IMAP 收信</span>
                {settings?.imapHost && <Badge variant="success" size="sm" className="ml-auto">已配置</Badge>}
              </div>
              <div className="grid grid-cols-4 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs text-muted-foreground mb-1">服务器</label>
                  <input type="text" value={form.imapHost} onChange={e => set('imapHost', e.target.value)} placeholder="imap.gmail.com" className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">端口</label>
                  <input type="number" value={form.imapPort} onChange={e => set('imapPort', +e.target.value || 993)} className={inputCls} />
                </div>
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input type="checkbox" checked={form.imapUseSsl} onChange={e => set('imapUseSsl', e.target.checked)} className="rounded" />SSL
                  </label>
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-muted-foreground mb-1">邮箱</label>
                  <input type="text" value={form.imapUsername} onChange={e => set('imapUsername', e.target.value)} placeholder="agent@example.com" className={inputCls} />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-muted-foreground mb-1">密码</label>
                  <div className="relative">
                    <input type={showImapPwd ? 'text' : 'password'} value={form.imapPassword} onChange={e => set('imapPassword', e.target.value)}
                      placeholder={settings?.imapPassword ? '••••••' : ''} className={`${inputCls} pr-7`} />
                    <button type="button" onClick={() => setShowImapPwd(!showImapPwd)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                      {showImapPwd ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                  </div>
                </div>
              </div>
            </section>

            <div className="border-t border-white/10" />

            {/* SMTP */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Server size={14} className="text-purple-400" />
                <span className="text-sm font-medium">SMTP 发信</span>
                {settings?.smtpHost && <Badge variant="success" size="sm" className="ml-auto">已配置</Badge>}
              </div>
              <div className="grid grid-cols-4 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs text-muted-foreground mb-1">服务器</label>
                  <input type="text" value={form.smtpHost} onChange={e => set('smtpHost', e.target.value)} placeholder="smtp.gmail.com" className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">端口</label>
                  <input type="number" value={form.smtpPort} onChange={e => set('smtpPort', +e.target.value || 587)} className={inputCls} />
                </div>
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input type="checkbox" checked={form.smtpUseSsl} onChange={e => set('smtpUseSsl', e.target.checked)} className="rounded" />SSL
                  </label>
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-muted-foreground mb-1">用户名</label>
                  <input type="text" value={form.smtpUsername} onChange={e => set('smtpUsername', e.target.value)} placeholder="与IMAP相同" className={inputCls} />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-muted-foreground mb-1">密码</label>
                  <div className="relative">
                    <input type={showSmtpPwd ? 'text' : 'password'} value={form.smtpPassword} onChange={e => set('smtpPassword', e.target.value)}
                      placeholder={settings?.smtpPassword ? '••••••' : ''} className={`${inputCls} pr-7`} />
                    <button type="button" onClick={() => setShowSmtpPwd(!showSmtpPwd)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                      {showSmtpPwd ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                  </div>
                </div>
              </div>
            </section>

            <div className="border-t border-white/10" />

            {/* 启用 */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Play size={14} className="text-green-400" />
                <span className="text-sm font-medium">启用通道</span>
              </div>
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">轮询间隔</span>
                  <input type="number" value={form.pollIntervalMinutes} onChange={e => set('pollIntervalMinutes', +e.target.value || 5)}
                    min={1} max={60} className="w-14 px-2 py-1 rounded bg-white/5 border border-white/10 text-sm text-center" />
                  <span className="text-xs text-muted-foreground">分钟</span>
                </div>
                <button onClick={() => set('isEnabled', !form.isEnabled)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-2 ${
                    form.isEnabled ? 'bg-green-500/20 border border-green-500/40 text-green-400' : 'bg-white/5 border border-white/10 hover:bg-white/10'
                  }`}>
                  <div className={`w-2 h-2 rounded-full ${form.isEnabled ? 'bg-green-400 animate-pulse' : 'bg-gray-500'}`} />
                  {form.isEnabled ? '运行中' : '已停止'}
                </button>
              </div>
              {form.isEnabled && (
                <div className="mt-2 text-xs text-green-400 flex items-center gap-1">
                  <CheckCircle size={10} />每 {form.pollIntervalMinutes} 分钟检查新邮件
                </div>
              )}
            </section>
          </div>

          {/* 右栏：操作与监控 */}
          <div className="col-span-5 p-5 space-y-5">
            {/* 快速配置 */}
            <section>
              <div className="text-xs text-muted-foreground mb-2">快速填充</div>
              <div className="flex flex-wrap gap-1.5">
                {EMAIL_PROVIDERS.map(p => (
                  <button key={p.name} onClick={() => apply(p)}
                    className="px-2.5 py-1 rounded bg-white/5 hover:bg-white/10 border border-white/10 text-xs transition-all">
                    {p.name}
                  </button>
                ))}
              </div>
            </section>

            <div className="border-t border-white/10" />

            {/* 配置进度 */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground">配置进度</span>
                <span className="text-xs">{steps.filter(s => s.done).length}/4</span>
              </div>
              <div className="flex gap-1">
                {steps.map((s, i) => (
                  <div key={i} className="flex-1">
                    <div className={`h-1 rounded-full ${s.done ? 'bg-green-500' : 'bg-white/10'}`} />
                    <div className={`text-[10px] mt-1 text-center ${s.done ? 'text-green-400' : 'text-muted-foreground'}`}>{s.label}</div>
                  </div>
                ))}
              </div>
            </section>

            <div className="border-t border-white/10" />

            {/* 测试结果 */}
            {testResult && (
              <>
                <div className={`p-2 rounded text-xs flex items-center gap-1.5 ${testResult.success ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                  {testResult.success ? <CheckCircle size={12} /> : <AlertTriangle size={12} />}
                  {testResult.message}
                </div>
                <div className="border-t border-white/10" />
              </>
            )}

            {/* 运行状态 */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-muted-foreground">运行状态</span>
                <Badge variant={settings?.isEnabled ? 'success' : 'subtle'} size="sm">
                  {settings?.isEnabled ? '运行中' : '已停止'}
                </Badge>
              </div>
              <div className="grid grid-cols-3 gap-2 mb-3">
                <div className="text-center p-2 rounded bg-white/5">
                  <div className="text-lg font-semibold">{stats?.todayTaskCount ?? 0}</div>
                  <div className="text-[10px] text-muted-foreground">今日任务</div>
                </div>
                <div className="text-center p-2 rounded bg-white/5">
                  <div className="text-lg font-semibold text-green-400">{stats?.successRate ?? 0}%</div>
                  <div className="text-[10px] text-muted-foreground">成功率</div>
                </div>
                <div className="text-center p-2 rounded bg-white/5">
                  <div className="text-lg font-semibold">{stats?.processingCount ?? 0}</div>
                  <div className="text-[10px] text-muted-foreground">处理中</div>
                </div>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  上次轮询：{settings?.lastPollAt ? new Date(settings.lastPollAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '从未'}
                </span>
                <Button variant="ghost" size="sm" onClick={handlePoll} disabled={polling || !settings?.isEnabled} className="h-6 px-2">
                  {polling ? <Loader2 className="animate-spin" size={12} /> : <RefreshCw size={12} />}
                </Button>
              </div>
            </section>

            <div className="border-t border-white/10" />

            {/* 功能说明 */}
            <section>
              <div className="text-xs text-muted-foreground mb-2">功能说明</div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Zap size={10} className="text-yellow-400" />转发创建待办
                </div>
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Shield size={10} className="text-green-400" />白名单授权
                </div>
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Mail size={10} className="text-blue-400" />自动回复
                </div>
              </div>
            </section>
          </div>
        </div>
      </GlassCard>
    </div>
  );
}
