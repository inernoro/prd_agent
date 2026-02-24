import { useState, useEffect, useCallback } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { Switch } from '@/components/design/Switch';
import { openPlatformService } from '@/services';
import { toast } from '@/lib/toast';
import {
  Eye,
  EyeOff,
  Send,
  Loader2,
  Check,
  X,
  AlertTriangle,
  Info,
  Clock,
} from 'lucide-react';
import type {
  OpenPlatformApp,
  WebhookConfigResponse,
  UpdateWebhookConfigRequest,
  WebhookLogItem,
} from '@/services/contracts/openPlatform';

interface WebhookConfigDialogProps {
  open: boolean;
  onClose: () => void;
  app: OpenPlatformApp | null;
}

function fmtDate(v?: string | null) {
  if (!v) return '-';
  return new Date(v).toLocaleString('zh-CN');
}

export function WebhookConfigDialog({ open, onClose, app }: WebhookConfigDialogProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  // 表单状态
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [tokenQuotaLimit, setTokenQuotaLimit] = useState(0);
  const [quotaWarningThreshold, setQuotaWarningThreshold] = useState(100000);
  const [notifyTarget, setNotifyTarget] = useState('none');

  // 配置数据
  const [config, setConfig] = useState<WebhookConfigResponse | null>(null);

  // 投递日志
  const [logs, setLogs] = useState<WebhookLogItem[]>([]);
  const [logsTotal, setLogsTotal] = useState(0);

  // 测试结果
  const [testResult, setTestResult] = useState<{
    success: boolean;
    statusCode?: number;
    durationMs?: number;
    errorMessage?: string;
  } | null>(null);

  const loadConfig = useCallback(async () => {
    if (!app) return;
    setLoading(true);
    try {
      const data = await openPlatformService.getWebhookConfig(app.id);
      setConfig(data);
      setWebhookUrl(data.webhookUrl || '');
      setWebhookSecret(data.webhookSecretMasked || '');
      setWebhookEnabled(data.webhookEnabled);
      setTokenQuotaLimit(data.tokenQuotaLimit);
      setQuotaWarningThreshold(data.quotaWarningThreshold);
      setNotifyTarget(data.notifyTarget || 'none');
    } catch (err) {
      toast.error('加载配置失败', String(err));
    } finally {
      setLoading(false);
    }
  }, [app]);

  const loadLogs = useCallback(async () => {
    if (!app) return;
    try {
      const data = await openPlatformService.getWebhookLogs(app.id, 1, 10);
      setLogs(data.items);
      setLogsTotal(data.total);
    } catch {
      // ignore
    }
  }, [app]);

  useEffect(() => {
    if (open && app) {
      loadConfig();
      loadLogs();
      setTestResult(null);
      setShowSecret(false);
    }
  }, [open, app, loadConfig, loadLogs]);

  const handleSave = async () => {
    if (!app) return;

    if (webhookEnabled && !webhookUrl) {
      toast.error('请填写 Webhook 地址');
      return;
    }
    if (webhookUrl && !webhookUrl.startsWith('https://')) {
      toast.error('Webhook 地址必须以 https:// 开头');
      return;
    }

    setSaving(true);
    try {
      const request: UpdateWebhookConfigRequest = {
        webhookUrl: webhookUrl || undefined,
        webhookSecret: webhookSecret || undefined,
        webhookEnabled,
        tokenQuotaLimit,
        quotaWarningThreshold,
        notifyTarget,
      };
      await openPlatformService.updateWebhookConfig(app.id, request);
      toast.success('Webhook 配置已保存');
      await loadConfig();
    } catch (err) {
      toast.error('保存失败', String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!app) return;
    if (!webhookUrl) {
      toast.error('请先填写 Webhook 地址');
      return;
    }

    setTesting(true);
    setTestResult(null);
    try {
      // 先保存配置
      await openPlatformService.updateWebhookConfig(app.id, {
        webhookUrl: webhookUrl || undefined,
        webhookSecret: webhookSecret || undefined,
        webhookEnabled,
        tokenQuotaLimit,
        quotaWarningThreshold,
        notifyTarget,
      });

      const result = await openPlatformService.testWebhook(app.id);
      setTestResult(result);
      if (result.success) {
        toast.success('Webhook 测试成功');
      } else {
        toast.error('Webhook 测试失败', result.errorMessage || `HTTP ${result.statusCode}`);
      }
      await loadLogs();
    } catch (err) {
      toast.error('测试失败', String(err));
    } finally {
      setTesting(false);
    }
  };

  const thresholdDollars = (quotaWarningThreshold * 0.20 / 100000).toFixed(2);
  const usedPercent = tokenQuotaLimit > 0
    ? Math.min(100, ((config?.tokensUsed ?? 0) / tokenQuotaLimit) * 100)
    : 0;

  if (!app) return null;

  const inputCls = "w-full px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 focus:border-blue-500/50 focus:outline-none text-sm";

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => !isOpen && onClose()}
      title="Webhook 配置"
      description={app.appName}
      maxWidth={640}
      contentClassName="max-h-[85vh] overflow-y-auto"
      titleAction={
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">启用</span>
          <Switch
            checked={webhookEnabled}
            onCheckedChange={setWebhookEnabled}
            ariaLabel="启用 Webhook 通知"
          />
        </div>
      }
      content={
        loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={20} className="animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-5">
            {/* Webhook URL + Secret */}
            <section className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  <span className="text-red-400">*</span> Webhook 地址
                </label>
                <input
                  type="url"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="请输入Webhook地址，例如：https://example.com/webhook"
                  className={inputCls}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  只支持https，系统将以 POST 方式发送通知，请确保地址可以接收 POST 请求
                </p>
              </div>

              <div>
                <div className="flex items-center gap-1 mb-1">
                  <label className="text-xs text-muted-foreground">接口凭证（可选）</label>
                  <span title="密钥将以 Bearer 方式添加到请求头中，用于验证webhook请求的合法性">
                    <Info size={12} className="text-muted-foreground" />
                  </span>
                </div>
                <div className="relative">
                  <input
                    type={showSecret ? 'text' : 'password'}
                    value={webhookSecret}
                    onChange={(e) => setWebhookSecret(e.target.value)}
                    placeholder="请输入密钥"
                    className={inputCls + ' pr-9'}
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret(!showSecret)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
            </section>

            {/* 请求结构说明 */}
            <div
              className="p-3 rounded-lg text-xs space-y-2"
              style={{ background: 'var(--nested-block-bg)', border: '1px solid var(--nested-block-border)' }}
            >
              <p className="font-medium text-muted-foreground">Webhook请求结构</p>
              <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap font-mono leading-relaxed">
{`{
  "type": "quota_exceed",    // 通知类型
  "title": "额度预警通知",    // 通知标题
  "content": "通知内容，支持 {{value}} 变量占位符",
  "values": ["$0.99"],       // 按顺序替换content中的 {{value}} 占位符
  "timestamp": 1739950503    // 时间戳
}`}
              </pre>
            </div>

            <div className="border-t border-white/10" />

            {/* 额度预警配置 */}
            <section className="space-y-3">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">额度预警</h3>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Token 额度上限</label>
                  <input
                    type="number"
                    value={tokenQuotaLimit}
                    onChange={(e) => setTokenQuotaLimit(Number(e.target.value))}
                    placeholder="0 = 不限制"
                    min={0}
                    className={inputCls}
                  />
                  <p className="text-xs text-muted-foreground mt-0.5">0 = 不限制</p>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">预警阈值 (tokens)</label>
                  <input
                    type="number"
                    value={quotaWarningThreshold}
                    onChange={(e) => setQuotaWarningThreshold(Number(e.target.value))}
                    min={0}
                    className={inputCls}
                  />
                </div>
              </div>

              {/* 阈值信息 */}
              <div
                className="p-3 rounded-lg"
                style={{
                  background: 'rgba(234,179,8,0.06)',
                  border: '1px solid rgba(234,179,8,0.15)',
                }}
              >
                <div className="flex items-start gap-2">
                  <AlertTriangle size={14} className="text-yellow-500 mt-0.5 flex-shrink-0" />
                  <div className="text-xs space-y-0.5">
                    <p className="text-yellow-400 font-medium">
                      额度预警阈值 等价金额：${thresholdDollars}
                    </p>
                    <p className="text-muted-foreground">{quotaWarningThreshold.toLocaleString()} tokens</p>
                    <p className="text-muted-foreground">当到余额度低于此数值时，系统将通过选择的方式发送通知</p>
                  </div>
                </div>
              </div>

              {/* 使用量进度 */}
              {tokenQuotaLimit > 0 && config && (
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>已使用 {(config.tokensUsed ?? 0).toLocaleString()} / {tokenQuotaLimit.toLocaleString()} tokens</span>
                    <span>{usedPercent.toFixed(1)}%</span>
                  </div>
                  <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-input-hover)' }}>
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${usedPercent}%`,
                        background: usedPercent > 80
                          ? 'rgb(239,68,68)'
                          : usedPercent > 50
                            ? 'rgb(234,179,8)'
                            : 'rgb(34,197,94)',
                      }}
                    />
                  </div>
                  {config.lastQuotaWarningAt && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock size={10} /> 上次预警：{fmtDate(config.lastQuotaWarningAt)}
                    </p>
                  )}
                </div>
              )}
            </section>

            <div className="border-t border-white/10" />

            {/* 站内信通知 */}
            <section className="space-y-3">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">站内信通知</h3>
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  触发额度预警时，除了发送 Webhook 外，还可以同步发送站内通知
                </p>
                <div className="flex gap-2">
                  {([
                    { value: 'none', label: '不发送' },
                    { value: 'owner', label: '仅绑定用户' },
                    { value: 'all', label: '全部用户' },
                  ] as const).map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setNotifyTarget(opt.value)}
                      className="px-3 py-1.5 rounded-lg text-xs border transition-colors"
                      style={{
                        background: notifyTarget === opt.value ? 'rgba(59,130,246,0.15)' : 'var(--nested-block-bg)',
                        borderColor: notifyTarget === opt.value ? 'rgba(59,130,246,0.4)' : 'var(--border-subtle)',
                        color: notifyTarget === opt.value ? 'rgb(147,197,253)' : undefined,
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            {/* 测试结果 */}
            {testResult && (
              <div
                className="p-3 rounded-lg"
                style={{
                  background: testResult.success ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)',
                  border: testResult.success
                    ? '1px solid rgba(34,197,94,0.2)'
                    : '1px solid rgba(239,68,68,0.2)',
                }}
              >
                <div className="flex items-center gap-2">
                  {testResult.success ? (
                    <Check size={14} className="text-green-400" />
                  ) : (
                    <X size={14} className="text-red-400" />
                  )}
                  <span className="text-xs font-medium">
                    {testResult.success ? '连通性测试成功' : '连通性测试失败'}
                  </span>
                  {testResult.statusCode && (
                    <Badge variant={testResult.success ? 'success' : 'danger'} size="sm">
                      HTTP {testResult.statusCode}
                    </Badge>
                  )}
                  {testResult.durationMs !== undefined && (
                    <span className="text-xs text-muted-foreground">{testResult.durationMs}ms</span>
                  )}
                </div>
                {testResult.errorMessage && (
                  <p className="text-xs text-red-400 mt-1">{testResult.errorMessage}</p>
                )}
              </div>
            )}

            {/* 投递日志 */}
            {logs.length > 0 && (
              <>
                <div className="border-t border-white/10" />
                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">投递记录</h3>
                    <span className="text-xs text-muted-foreground">共 {logsTotal} 条</span>
                  </div>
                  <div className="space-y-1">
                    {logs.map((log) => (
                      <div
                        key={log.id}
                        className="flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs"
                        style={{ background: 'var(--list-item-bg)' }}
                      >
                        <div className="flex items-center gap-2">
                          {log.success ? (
                            <Check size={11} className="text-green-400" />
                          ) : (
                            <X size={11} className="text-red-400" />
                          )}
                          <span>{log.title}</span>
                          <Badge variant="subtle" size="sm">{log.type}</Badge>
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground">
                          {log.statusCode && <span>HTTP {log.statusCode}</span>}
                          {log.durationMs !== undefined && <span>{log.durationMs}ms</span>}
                          {log.retryCount > 0 && <span>重试{log.retryCount}次</span>}
                          <span>{fmtDate(log.createdAt)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </>
            )}

            {/* 操作按钮 */}
            <div className="flex items-center justify-between pt-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleTest}
                disabled={testing || !webhookUrl}
              >
                {testing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                测试连通性
              </Button>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={onClose}>取消</Button>
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  {saving ? <Loader2 size={14} className="animate-spin" /> : null}
                  保存
                </Button>
              </div>
            </div>
          </div>
        )
      }
    />
  );
}
