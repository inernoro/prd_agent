import { useEffect, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { Switch } from '@/components/design/Switch';
import { Select } from '@/components/design/Select';
import { Dialog } from '@/components/ui/Dialog';
import {
  Mail, Server, AlertTriangle, CheckCircle, Loader2, RefreshCw, Eye, EyeOff,
  Play, Plus, Trash2, MoreVertical, Pencil, UserCheck,
} from 'lucide-react';
import { channelService, appCallersService, getUsers } from '@/services';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import type {
  ChannelStatsResponse, ChannelSettings, UpdateSettingsRequest,
  EmailWorkflow, CreateWorkflowRequest, UpdateWorkflowRequest,
  ChannelIdentityMapping, CreateIdentityMappingRequest, UpdateIdentityMappingRequest,
} from '@/services/contracts/channels';
import type { LLMAppCaller } from '@/types/appCaller';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

interface EmailChannelPanelProps {
  onActionsReady?: (actions: React.ReactNode) => void;
}

const EMAIL_PROVIDERS = [
  { name: 'Gmail', imap: 'imap.gmail.com', smtp: 'smtp.gmail.com', imapPort: 993, smtpPort: 587 },
  { name: 'Outlook', imap: 'outlook.office365.com', smtp: 'smtp.office365.com', imapPort: 993, smtpPort: 587 },
  { name: '163', imap: 'imap.163.com', smtp: 'smtp.163.com', imapPort: 993, smtpPort: 465 },
  { name: 'QQ', imap: 'imap.qq.com', smtp: 'smtp.qq.com', imapPort: 993, smtpPort: 465 },
];

export default function EmailChannelPanel({ onActionsReady }: EmailChannelPanelProps) {
  // ============ Settings State ============
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

  // ============ Workflows State ============
  const [workflows, setWorkflows] = useState<EmailWorkflow[]>([]);
  const [appCallers, setAppCallers] = useState<LLMAppCaller[]>([]);
  const [workflowDialogOpen, setWorkflowDialogOpen] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState<EmailWorkflow | null>(null);

  // ============ Whitelist State ============
  const [mappings, setMappings] = useState<ChannelIdentityMapping[]>([]);
  const [mappingDialogOpen, setMappingDialogOpen] = useState(false);
  const [editingMapping, setEditingMapping] = useState<ChannelIdentityMapping | null>(null);

  // ============ Load Data ============
  const loadData = async () => {
    setLoading(true);
    try {
      const [statsData, settingsData, workflowsData, appCallersData, mappingsData] = await Promise.all([
        channelService.getStats(),
        channelService.getSettings(),
        channelService.getWorkflows(1, 50),
        appCallersService.getAppCallers(1, 100),
        channelService.getIdentityMappings(1, 100, 'email'),
      ]);
      setStats(statsData);
      setSettings(settingsData);
      setWorkflows(workflowsData.items || []);
      setAppCallers(appCallersData.success && appCallersData.data ? appCallersData.data.items || [] : []);
      setMappings(mappingsData.items || []);
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

  // ============ Settings Handlers ============
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
        imapHost: form.imapHost || '',
        imapPort: form.imapPort || 993,
        imapUsername: form.imapUsername || '',
        imapPassword: form.imapPassword || settings?.imapPassword || '',
        imapUseSsl: form.imapUseSsl ?? true,
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

  // ============ Workflow Handlers ============
  const handleCreateWorkflow = async (req: CreateWorkflowRequest) => {
    try {
      await channelService.createWorkflow(req);
      toast.success('创建成功');
      setWorkflowDialogOpen(false);
      const res = await channelService.getWorkflows(1, 50);
      setWorkflows(res.items || []);
    } catch (err) { toast.error('创建失败', String(err)); }
  };

  const handleUpdateWorkflow = async (req: UpdateWorkflowRequest) => {
    if (!editingWorkflow) return;
    try {
      await channelService.updateWorkflow(editingWorkflow.id, req);
      toast.success('更新成功');
      setEditingWorkflow(null);
      const res = await channelService.getWorkflows(1, 50);
      setWorkflows(res.items || []);
    } catch (err) { toast.error('更新失败', String(err)); }
  };

  const handleDeleteWorkflow = async (id: string, name: string) => {
    const confirmed = await systemDialog.confirm({ title: '确认删除', message: `删除工作流"${name}"？`, tone: 'danger' });
    if (!confirmed) return;
    try {
      await channelService.deleteWorkflow(id);
      toast.success('删除成功');
      setWorkflows(workflows.filter(w => w.id !== id));
    } catch (err) { toast.error('删除失败', String(err)); }
  };

  const handleToggleWorkflow = async (id: string) => {
    try {
      await channelService.toggleWorkflow(id);
      toast.success('状态已切换');
      const res = await channelService.getWorkflows(1, 50);
      setWorkflows(res.items || []);
    } catch (err) { toast.error('操作失败', String(err)); }
  };

  // ============ Mapping Handlers ============
  const handleCreateMapping = async (req: CreateIdentityMappingRequest) => {
    try {
      await channelService.createIdentityMapping(req);
      toast.success('添加成功');
      setMappingDialogOpen(false);
      const res = await channelService.getIdentityMappings(1, 100, 'email');
      setMappings(res.items || []);
    } catch (err) { toast.error('添加失败', String(err)); }
  };

  const handleUpdateMapping = async (req: UpdateIdentityMappingRequest) => {
    if (!editingMapping) return;
    try {
      await channelService.updateIdentityMapping(editingMapping.id, req);
      toast.success('更新成功');
      setEditingMapping(null);
      const res = await channelService.getIdentityMappings(1, 100, 'email');
      setMappings(res.items || []);
    } catch (err) { toast.error('更新失败', String(err)); }
  };

  const handleDeleteMapping = async (id: string, identifier: string) => {
    const confirmed = await systemDialog.confirm({ title: '确认删除', message: `移除"${identifier}"？`, tone: 'danger' });
    if (!confirmed) return;
    try {
      await channelService.deleteIdentityMapping(id);
      toast.success('删除成功');
      setMappings(mappings.filter(m => m.id !== id));
    } catch (err) { toast.error('删除失败', String(err)); }
  };

  if (loading) return <div className="h-full flex items-center justify-center"><Loader2 className="animate-spin" size={24} /></div>;

  const emailDomain = settings?.imapUsername?.split('@')[1] || null;
  const inputCls = "w-full px-2.5 py-1.5 rounded bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none text-sm";

  return (
    <div className="h-full overflow-auto p-1">
      <GlassCard glow className="min-h-full">
        <div className="grid grid-cols-12">
          {/* ============ 左栏：服务器配置 + 工作流 ============ */}
          <div className="col-span-7 border-r border-white/10">
            {/* 服务器配置区 */}
            <div className="p-5 space-y-5 border-b border-white/10">
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

              {/* 轮询设置 */}
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <Play size={14} className="text-green-400" />
                  <span className="text-sm font-medium">邮件轮询</span>
                </div>
                <div className="flex items-center gap-6">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">检查间隔</span>
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
                    <CheckCircle size={10} />系统每 {form.pollIntervalMinutes} 分钟检查一次新邮件
                  </div>
                )}
              </section>
            </div>

            {/* 工作流邮箱区 */}
            <div className="p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="font-medium text-sm">工作流邮箱</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">不同邮箱前缀路由到不同处理流程</p>
                </div>
                <Button variant="secondary" size="sm" onClick={() => setWorkflowDialogOpen(true)} disabled={!emailDomain} className="whitespace-nowrap">
                  <Plus size={14} />添加
                </Button>
              </div>

              {!emailDomain ? (
                <div className="text-center py-6 text-muted-foreground text-sm">
                  请先配置 IMAP 邮箱地址
                </div>
              ) : workflows.length === 0 ? (
                <div className="text-center py-6 text-muted-foreground text-sm">
                  暂无工作流，点击添加创建
                </div>
              ) : (
                <div className="space-y-2">
                  {workflows.map((wf) => (
                    <div key={wf.id} className="flex items-center justify-between p-3 rounded-lg" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{wf.displayName}</span>
                          {!wf.isActive && <Badge variant="subtle" size="sm">禁用</Badge>}
                        </div>
                        <code className="text-xs text-blue-400 mt-0.5 block">{wf.addressPrefix}@{emailDomain}</code>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch checked={wf.isActive} onCheckedChange={() => handleToggleWorkflow(wf.id)} ariaLabel="切换状态" />
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger asChild>
                            <button className="p-1 rounded hover:bg-white/10 text-muted-foreground"><MoreVertical size={14} /></button>
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Portal>
                            <DropdownMenu.Content align="end" sideOffset={4} className="z-50 rounded-lg p-1 min-w-[100px]"
                              style={{ background: 'rgba(30,30,35,0.95)', border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(20px)' }}>
                              <DropdownMenu.Item className="flex items-center gap-2 px-2 py-1.5 text-xs rounded cursor-pointer outline-none hover:bg-white/10"
                                onSelect={() => setEditingWorkflow(wf)}><Pencil size={12} />编辑</DropdownMenu.Item>
                              <DropdownMenu.Item className="flex items-center gap-2 px-2 py-1.5 text-xs rounded cursor-pointer outline-none hover:bg-white/10 text-red-400"
                                onSelect={() => handleDeleteWorkflow(wf.id, wf.displayName)}><Trash2 size={12} />删除</DropdownMenu.Item>
                            </DropdownMenu.Content>
                          </DropdownMenu.Portal>
                        </DropdownMenu.Root>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ============ 右栏：快速配置 + 状态 + 发件人白名单 ============ */}
          <div className="col-span-5">
            {/* 快速配置 + 状态区 */}
            <div className="p-5 space-y-5 border-b border-white/10">
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
            </div>

            {/* 发件人白名单区 */}
            <div className="p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="font-medium text-sm">发件人白名单</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">允许向系统发送邮件的地址</p>
                </div>
                <Button variant="secondary" size="sm" onClick={() => setMappingDialogOpen(true)} className="whitespace-nowrap">
                  <Plus size={14} />添加
                </Button>
              </div>

              {mappings.length === 0 ? (
                <div className="text-center py-6 text-muted-foreground text-sm">
                  暂无白名单，点击添加
                </div>
              ) : (
                <div className="space-y-2">
                  {mappings.map((m) => (
                    <div key={m.id} className="flex items-center justify-between p-3 rounded-lg" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'rgba(59,130,246,0.1)' }}>
                          <Mail size={14} className="text-blue-400" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <code className="text-sm">{m.channelIdentifier}</code>
                            {m.isVerified && <UserCheck size={12} className="text-green-400" />}
                          </div>
                          {m.userName && <div className="text-xs text-muted-foreground">→ {m.userName}</div>}
                        </div>
                      </div>
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                          <button className="p-1 rounded hover:bg-white/10 text-muted-foreground"><MoreVertical size={14} /></button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content align="end" sideOffset={4} className="z-50 rounded-lg p-1 min-w-[100px]"
                            style={{ background: 'rgba(30,30,35,0.95)', border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(20px)' }}>
                            <DropdownMenu.Item className="flex items-center gap-2 px-2 py-1.5 text-xs rounded cursor-pointer outline-none hover:bg-white/10"
                              onSelect={() => setEditingMapping(m)}><Pencil size={12} />编辑</DropdownMenu.Item>
                            <DropdownMenu.Item className="flex items-center gap-2 px-2 py-1.5 text-xs rounded cursor-pointer outline-none hover:bg-white/10 text-red-400"
                              onSelect={() => handleDeleteMapping(m.id, m.channelIdentifier)}><Trash2 size={12} />删除</DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </GlassCard>

      {/* 工作流对话框 */}
      <WorkflowDialog
        open={workflowDialogOpen || !!editingWorkflow}
        onClose={() => { setWorkflowDialogOpen(false); setEditingWorkflow(null); }}
        onSubmit={(req) => editingWorkflow ? handleUpdateWorkflow(req as UpdateWorkflowRequest) : handleCreateWorkflow(req as CreateWorkflowRequest)}
        mode={editingWorkflow ? 'edit' : 'create'}
        workflow={editingWorkflow}
        emailDomain={emailDomain}
        appCallers={appCallers}
      />

      {/* 白名单对话框 */}
      <MappingDialog
        open={mappingDialogOpen || !!editingMapping}
        onClose={() => { setMappingDialogOpen(false); setEditingMapping(null); }}
        onSubmit={(req) => editingMapping ? handleUpdateMapping(req as UpdateIdentityMappingRequest) : handleCreateMapping(req as CreateIdentityMappingRequest)}
        mode={editingMapping ? 'edit' : 'create'}
        mapping={editingMapping}
      />
    </div>
  );
}

// ============ WorkflowDialog ============
function WorkflowDialog({ open, onClose, onSubmit, mode, workflow, emailDomain, appCallers }: {
  open: boolean; onClose: () => void;
  onSubmit: (req: CreateWorkflowRequest | UpdateWorkflowRequest) => void;
  mode: 'create' | 'edit'; workflow?: EmailWorkflow | null;
  emailDomain: string | null; appCallers: LLMAppCaller[];
}) {
  const [addressPrefix, setAddressPrefix] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [targetApp, setTargetApp] = useState('');

  useEffect(() => {
    if (mode === 'edit' && workflow) {
      setAddressPrefix(workflow.addressPrefix);
      setDisplayName(workflow.displayName);
      setDescription(workflow.description || '');
      setTargetApp(workflow.targetAgent || '');
    } else {
      setAddressPrefix(''); setDisplayName(''); setDescription(''); setTargetApp('');
    }
  }, [open, mode, workflow]);

  const handleSubmit = () => {
    if (!addressPrefix.trim()) { toast.warning('验证失败', '邮箱前缀不能为空'); return; }
    if (!displayName.trim()) { toast.warning('验证失败', '名称不能为空'); return; }
    onSubmit({
      addressPrefix: addressPrefix.trim().toLowerCase(),
      displayName: displayName.trim(),
      description: description.trim() || undefined,
      intentType: 'classify',
      targetAgent: targetApp || undefined,
      priority: 100,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()} title={mode === 'create' ? '添加工作流' : '编辑工作流'} maxWidth={420}
      content={
        <div className="space-y-4">
          {emailDomain && (
            <div className="p-3 rounded-lg" style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)' }}>
              <div className="text-xs text-muted-foreground mb-1">邮件地址</div>
              <code className="text-blue-400">{addressPrefix || 'prefix'}@{emailDomain}</code>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium mb-1">邮箱前缀 *</label>
            <input type="text" value={addressPrefix} onChange={(e) => setAddressPrefix(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none" placeholder="todo" disabled={mode === 'edit'} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">名称 *</label>
            <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none" placeholder="待办事项" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">绑定应用</label>
            <Select value={targetApp} onChange={(e) => setTargetApp(e.target.value)} uiSize="md">
              <option value="">自动处理</option>
              {appCallers.map((app) => <option key={app.id} value={app.appCode}>{app.displayName || app.appCode}</option>)}
            </Select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">描述</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
              className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none resize-none" placeholder="可选" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={onClose}>取消</Button>
            <Button onClick={handleSubmit}>{mode === 'create' ? '添加' : '保存'}</Button>
          </div>
        </div>
      }
    />
  );
}

// ============ MappingDialog ============
function MappingDialog({ open, onClose, onSubmit, mode, mapping }: {
  open: boolean; onClose: () => void;
  onSubmit: (req: CreateIdentityMappingRequest | UpdateIdentityMappingRequest) => void;
  mode: 'create' | 'edit'; mapping?: ChannelIdentityMapping | null;
}) {
  const [channelIdentifier, setChannelIdentifier] = useState('');
  const [userId, setUserId] = useState('');
  const [isVerified, setIsVerified] = useState(true);
  const [users, setUsers] = useState<Array<{ userId: string; username: string; displayName: string }>>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  useEffect(() => {
    if (open) {
      loadUsers();
      if (mode === 'edit' && mapping) {
        setChannelIdentifier(mapping.channelIdentifier);
        setUserId(mapping.userId);
        setIsVerified(mapping.isVerified);
      } else {
        setChannelIdentifier(''); setUserId(''); setIsVerified(true);
      }
    }
  }, [open, mode, mapping]);

  const loadUsers = async () => {
    setLoadingUsers(true);
    try {
      const res = await getUsers({ page: 1, pageSize: 100 });
      setUsers(res.success ? res.data?.items || [] : []);
    } catch { setUsers([]); }
    finally { setLoadingUsers(false); }
  };

  const handleSubmit = () => {
    if (mode === 'create') {
      if (!channelIdentifier.trim() || !channelIdentifier.includes('@')) { toast.warning('验证失败', '请输入有效邮箱'); return; }
      if (!userId) { toast.warning('验证失败', '请选择用户'); return; }
      onSubmit({ channelType: 'email', channelIdentifier: channelIdentifier.trim().toLowerCase(), userId, isVerified });
    } else {
      onSubmit({ userId, isVerified });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()} title={mode === 'create' ? '添加白名单' : '编辑白名单'} maxWidth={400}
      content={
        <div className="space-y-4">
          {mode === 'create' && (
            <div>
              <label className="block text-sm font-medium mb-1">邮箱地址 *</label>
              <input type="email" value={channelIdentifier} onChange={(e) => setChannelIdentifier(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none" placeholder="user@example.com" />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium mb-1">映射用户 *</label>
            <Select value={userId} onChange={(e) => setUserId(e.target.value)} disabled={loadingUsers} uiSize="md">
              <option value="">{loadingUsers ? '加载中...' : '请选择'}</option>
              {users.map((u) => <option key={u.userId} value={u.userId}>{u.displayName} (@{u.username})</option>)}
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={isVerified} onChange={(e) => setIsVerified(e.target.checked)} className="rounded" />
            标记为已验证
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={onClose}>取消</Button>
            <Button onClick={handleSubmit}>{mode === 'create' ? '添加' : '保存'}</Button>
          </div>
        </div>
      }
    />
  );
}
