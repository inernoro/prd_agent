import { useEffect, useState } from 'react';
import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { PageHeader } from '@/components/design/PageHeader';
import { Dialog } from '@/components/ui/Dialog';
import { openPlatformService, getUsers, getAdminGroups } from '@/services';
import { Plus, Trash2, RefreshCw, Copy, Power, PowerOff, Eye } from 'lucide-react';
import { systemDialog } from '@/lib/systemDialog';
import type { OpenPlatformApp, CreateAppRequest, OpenPlatformRequestLog } from '@/services/contracts/openPlatform';

function fmtDate(v?: string | null) {
  if (!v) return '-';
  return new Date(v).toLocaleString('zh-CN');
}

export default function OpenPlatformPage() {
  const [apps, setApps] = useState<OpenPlatformApp[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [apiKeyDialogOpen, setApiKeyDialogOpen] = useState(false);
  const [newApiKey, setNewApiKey] = useState('');
  const [logsDialogOpen, setLogsDialogOpen] = useState(false);
  const [logs, setLogs] = useState<OpenPlatformRequestLog[]>([]);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsPage, setLogsPage] = useState(1);
  const [curlDialogOpen, setCurlDialogOpen] = useState(false);
  const [currentCurlCommand, setCurrentCurlCommand] = useState('');
  const [generatingCurl, setGeneratingCurl] = useState(false);

  const loadApps = async () => {
    setLoading(true);
    try {
      const res = await openPlatformService.getApps(page, pageSize, search || undefined);
      setApps(res.items);
      setTotal(res.total);
    } catch (err) {
      await systemDialog.alert({ title: '加载失败', message: String(err) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadApps();
  }, [page, search]);

  const handleCreate = async (request: CreateAppRequest) => {
    try {
      const res = await openPlatformService.createApp(request);
      setNewApiKey(res.apiKey);
      setApiKeyDialogOpen(true);
      setCreateDialogOpen(false);
      loadApps();
    } catch (err) {
      await systemDialog.alert({ title: '创建失败', message: String(err) });
    }
  };

  const handleDelete = async (id: string, name: string) => {
    const confirmed = await systemDialog.confirm({
      title: '确认删除',
      message: `确定要删除应用"${name}"吗？此操作不可恢复。`,
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      await openPlatformService.deleteApp(id);
      await systemDialog.alert('删除成功');
      loadApps();
    } catch (err) {
      await systemDialog.alert({ title: '删除失败', message: String(err) });
    }
  };

  const handleRegenerateKey = async (id: string, name: string) => {
    const confirmed = await systemDialog.confirm({
      title: '重新生成密钥',
      message: `确定要为应用"${name}"重新生成 API Key 吗？旧密钥将立即失效。`,
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      const res = await openPlatformService.regenerateKey(id);
      setNewApiKey(res.apiKey);
      setApiKeyDialogOpen(true);
      await systemDialog.alert('密钥已重新生成');
    } catch (err) {
      await systemDialog.alert({ title: '操作失败', message: String(err) });
    }
  };

  const handleToggleStatus = async (id: string) => {
    try {
      await openPlatformService.toggleAppStatus(id);
      await systemDialog.alert('状态已切换');
      loadApps();
    } catch (err) {
      await systemDialog.alert({ title: '操作失败', message: String(err) });
    }
  };

  const handleViewLogs = async (appId?: string) => {
    setLogsPage(1);
    setLogsDialogOpen(true);
    loadLogs(1, appId);
  };

  const loadLogs = async (p: number, appId?: string) => {
    try {
      const res = await openPlatformService.getLogs(p, 20, appId);
      setLogs(res.items);
      setLogsTotal(res.total);
      setLogsPage(p);
    } catch (err) {
      await systemDialog.alert({ title: '加载日志失败', message: String(err) });
    }
  };

  const buildCurlCommand = (app: OpenPlatformApp) => {
    const apiUrl = window.location.origin;
    const endpoint = `${apiUrl}/api/v1/open-platform/v1/chat/completions`;
    
    const curlCommand = `# 请将 YOUR_API_KEY 替换为应用的真实 API Key
# 应用: ${app.appName}
# 绑定群组: ${app.boundGroupName || '未绑定'}

curl -X POST '${endpoint}' \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer YOUR_API_KEY' \\
  -d '{
    "model": "prdagent",
    "messages": [
      {
        "role": "user",
        "content": "请介绍一下这个 PRD 的核心功能"
      }
    ],
    "stream": true
  }'`;
    
    return curlCommand;
  };

  const showCurlCommand = async (app: OpenPlatformApp) => {
    setGeneratingCurl(true);
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      const curl = buildCurlCommand(app);
      setCurrentCurlCommand(curl);
      setCurlDialogOpen(true);
    } finally {
      setGeneratingCurl(false);
    }
  };

  return (
    <div className="h-full w-full overflow-auto p-6">
      <PageHeader
        title="开放平台"
        description="管理 API 应用与调用日志"
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => handleViewLogs()}>
              查看所有日志
            </Button>
            <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
              <Plus size={16} className="mr-1" />
              新建应用
            </Button>
          </div>
        }
      />

      <Card className="mt-6">
        <div className="p-4 border-b border-border">
          <input
            type="text"
            placeholder="搜索应用名称或描述..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-3 py-2 bg-background border border-border rounded-md"
          />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium">应用名称</th>
                <th className="px-4 py-3 text-left text-sm font-medium">绑定用户</th>
                <th className="px-4 py-3 text-left text-sm font-medium">绑定群组</th>
                <th className="px-4 py-3 text-left text-sm font-medium">状态</th>
                <th className="px-4 py-3 text-left text-sm font-medium">API Key</th>
                <th className="px-4 py-3 text-left text-sm font-medium">总请求数</th>
                <th className="px-4 py-3 text-left text-sm font-medium">最后使用</th>
                <th className="px-4 py-3 text-left text-sm font-medium">创建时间</th>
                <th className="px-4 py-3 text-right text-sm font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => (
                <tr key={app.id} className="border-t border-border hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="font-medium">{app.appName}</div>
                    {app.description && <div className="text-sm text-muted-foreground">{app.description}</div>}
                  </td>
                  <td className="px-4 py-3 text-sm">{app.boundUserName}</td>
                  <td className="px-4 py-3 text-sm">{app.boundGroupName || '-'}</td>
                  <td className="px-4 py-3">
                    <Badge variant={app.isActive ? 'success' : 'subtle'}>
                      {app.isActive ? '启用' : '禁用'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <code className="text-xs bg-muted px-2 py-1 rounded">{app.apiKeyMasked}</code>
                  </td>
                  <td className="px-4 py-3 text-sm">{app.totalRequests}</td>
                  <td className="px-4 py-3 text-sm">{fmtDate(app.lastUsedAt)}</td>
                  <td className="px-4 py-3 text-sm">{fmtDate(app.createdAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => showCurlCommand(app)}
                        title="查看 curl 命令"
                        disabled={generatingCurl}
                      >
                        {generatingCurl ? (
                          <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                          </svg>
                        ) : (
                          <Copy size={14} />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleViewLogs(app.id)}
                        title="查看日志"
                      >
                        <Eye size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleToggleStatus(app.id)}
                        title={app.isActive ? '禁用' : '启用'}
                      >
                        {app.isActive ? <PowerOff size={14} /> : <Power size={14} />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRegenerateKey(app.id, app.appName)}
                        title="重新生成密钥"
                      >
                        <RefreshCw size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(app.id, app.appName)}
                        title="删除"
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {apps.length === 0 && !loading && (
            <div className="text-center py-12 text-muted-foreground">
              {search ? '未找到匹配的应用' : '暂无应用，点击右上角"新建应用"开始使用'}
            </div>
          )}
        </div>

        {total > pageSize && (
          <div className="p-4 border-t border-border flex justify-between items-center">
            <div className="text-sm text-muted-foreground">
              共 {total} 条，第 {page} / {Math.ceil(total / pageSize)} 页
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
                上一页
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= Math.ceil(total / pageSize)}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        )}
      </Card>

      <CreateAppDialog open={createDialogOpen} onClose={() => setCreateDialogOpen(false)} onCreate={handleCreate} />
      <ApiKeyDialog open={apiKeyDialogOpen} onClose={() => setApiKeyDialogOpen(false)} apiKey={newApiKey} />
      <LogsDialog open={logsDialogOpen} onClose={() => setLogsDialogOpen(false)} logs={logs} total={logsTotal} page={logsPage} onPageChange={loadLogs} />
      <CurlCommandDialog open={curlDialogOpen} onClose={() => setCurlDialogOpen(false)} curlCommand={currentCurlCommand} />
    </div>
  );
}

function CreateAppDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (req: CreateAppRequest) => void;
}) {
  const [appName, setAppName] = useState('');
  const [description, setDescription] = useState('');
  const [boundUserId, setBoundUserId] = useState('');
  const [boundGroupId, setBoundGroupId] = useState('');
  const [ignoreUserSystemPrompt, setIgnoreUserSystemPrompt] = useState(true);
  const [users, setUsers] = useState<Array<{ userId: string; username: string; displayName: string }>>([]);
  const [groups, setGroups] = useState<Array<{ groupId: string; groupName: string }>>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [loadingGroups, setLoadingGroups] = useState(false);

  useEffect(() => {
    if (open) {
      loadUsers();
      loadGroups();
    }
  }, [open]);

  const loadUsers = async () => {
    setLoadingUsers(true);
    try {
      const res = await getUsers({ page: 1, pageSize: 100 });
      if (!res.success) {
        await systemDialog.alert({ title: '加载用户失败', message: res.error?.message || '未知错误' });
        setUsers([]);
        return;
      }
      setUsers(res.data?.items || []);
    } catch (err) {
      await systemDialog.alert({ title: '加载用户失败', message: String(err) });
      setUsers([]);
    } finally {
      setLoadingUsers(false);
    }
  };

  const loadGroups = async () => {
    setLoadingGroups(true);
    try {
      const res = await getAdminGroups({ page: 1, pageSize: 100 });
      if (!res.success) {
        await systemDialog.alert({ title: '加载群组失败', message: res.error?.message || '未知错误' });
        setGroups([]);
        return;
      }
      setGroups(res.data?.items || []);
    } catch (err) {
      await systemDialog.alert({ title: '加载群组失败', message: String(err) });
      setGroups([]);
    } finally {
      setLoadingGroups(false);
    }
  };

  const handleSubmit = async () => {
    if (!appName.trim()) {
      await systemDialog.alert({ title: '验证失败', message: '应用名称不能为空' });
      return;
    }
    if (!boundGroupId) {
      await systemDialog.alert({ title: '验证失败', message: '必须绑定群组' });
      return;
    }
    if (!boundUserId) {
      await systemDialog.alert({ title: '验证失败', message: '必须绑定用户' });
      return;
    }

    onCreate({
      appName: appName.trim(),
      description: description.trim() || undefined,
      boundUserId,
      boundGroupId,
      ignoreUserSystemPrompt,
    });

    setAppName('');
    setDescription('');
    setBoundUserId('');
    setBoundGroupId('');
    setIgnoreUserSystemPrompt(true);
  };

  return (
    <Dialog 
      open={open} 
      onOpenChange={(isOpen) => !isOpen && onClose()} 
      title="新建应用"
      content={
        <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">应用名称 *</label>
          <input
            type="text"
            value={appName}
            onChange={(e) => setAppName(e.target.value)}
            className="w-full px-3 py-2 bg-background border border-border rounded-md"
            placeholder="输入应用名称"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">绑定群组 *</label>
          <select
            value={boundGroupId}
            onChange={(e) => setBoundGroupId(e.target.value)}
            className="w-full px-3 py-2 bg-background border border-border rounded-md"
            disabled={loadingGroups}
          >
            <option value="">{loadingGroups ? '加载中...' : '请选择群组'}</option>
            {(groups || []).map((g) => (
              <option key={g.groupId} value={g.groupId}>
                {g.groupName} (ID: {g.groupId})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">绑定用户 *</label>
          <select
            value={boundUserId}
            onChange={(e) => setBoundUserId(e.target.value)}
            className="w-full px-3 py-2 bg-background border border-border rounded-md"
            disabled={loadingUsers}
          >
            <option value="">{loadingUsers ? '加载中...' : '请选择用户'}</option>
            {(users || []).map((u) => (
              <option key={u.userId} value={u.userId}>
                {u.displayName} (@{u.username})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">应用描述</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full px-3 py-2 bg-background border border-border rounded-md"
            placeholder="输入应用描述（可选）"
            rows={3}
          />
        </div>

        <div className="flex items-start gap-3 p-3 bg-muted/30 rounded-md">
          <input
            type="checkbox"
            id="ignoreUserSystemPrompt"
            checked={ignoreUserSystemPrompt}
            onChange={(e) => setIgnoreUserSystemPrompt(e.target.checked)}
            className="mt-0.5 w-4 h-4 rounded border-border"
          />
          <div className="flex-1">
            <label htmlFor="ignoreUserSystemPrompt" className="text-sm font-medium cursor-pointer">
              忽略外部系统提示词
            </label>
            <p className="text-xs text-muted-foreground mt-1">
              启用后，API 调用时将过滤外部请求中的 system 消息（role=system），强制使用我们内部配置的专业提示词。推荐开启以防止外部不专业的提示词影响服务质量。
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-4">
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button onClick={handleSubmit}>创建</Button>
        </div>
      </div>
      }
    />
  );
}

function ApiKeyDialog({ open, onClose, apiKey }: { open: boolean; onClose: () => void; apiKey: string }) {
  const copyKey = async () => {
    navigator.clipboard.writeText(apiKey);
    await systemDialog.alert('已复制到剪贴板');
  };

  return (
    <Dialog 
      open={open} 
      onOpenChange={(isOpen) => !isOpen && onClose()} 
      title="API Key"
      content={
        <div className="space-y-4">
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-md p-4">
          <p className="text-sm text-yellow-600 dark:text-yellow-400 font-medium">重要提示</p>
          <p className="text-sm text-yellow-600 dark:text-yellow-400 mt-1">
            请立即复制并妥善保存此 API Key，关闭后将无法再次查看明文。
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">API Key</label>
          <div className="flex gap-2">
            <code className="flex-1 px-3 py-2 bg-muted rounded-md text-sm break-all">{apiKey}</code>
            <Button variant="secondary" size="sm" onClick={copyKey}>
              <Copy size={14} />
            </Button>
          </div>
        </div>

        <div className="flex justify-end pt-4">
          <Button onClick={onClose}>我已保存</Button>
        </div>
      </div>
      }
    />
  );
}

function LogsDialog({
  open,
  onClose,
  logs,
  total,
  page,
  onPageChange,
}: {
  open: boolean;
  onClose: () => void;
  logs: OpenPlatformRequestLog[];
  total: number;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const pageSize = 20;

  return (
    <Dialog 
      open={open} 
      onOpenChange={(isOpen) => !isOpen && onClose()} 
      title="调用日志"
      maxWidth={900}
      content={
        <div className="space-y-4">
        <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left">时间</th>
                <th className="px-3 py-2 text-left">应用</th>
                <th className="px-3 py-2 text-left">路径</th>
                <th className="px-3 py-2 text-left">状态码</th>
                <th className="px-3 py-2 text-left">耗时</th>
                <th className="px-3 py-2 text-left">Token</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="border-t border-border">
                  <td className="px-3 py-2">{fmtDate(log.startedAt)}</td>
                  <td className="px-3 py-2">{log.appName}</td>
                  <td className="px-3 py-2">
                    <code className="text-xs">{log.path}</code>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={log.statusCode >= 200 && log.statusCode < 300 ? 'success' : 'subtle'}>
                      {log.statusCode}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">{log.durationMs}ms</td>
                  <td className="px-3 py-2">
                    {log.inputTokens !== null && log.outputTokens !== null
                      ? `${log.inputTokens} / ${log.outputTokens}`
                      : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {logs.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">暂无调用日志</div>
          )}
        </div>

        {total > pageSize && (
          <div className="flex justify-between items-center pt-4">
            <div className="text-sm text-muted-foreground">
              共 {total} 条，第 {page} / {Math.ceil(total / pageSize)} 页
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page === 1} onClick={() => onPageChange(page - 1)}>
                上一页
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= Math.ceil(total / pageSize)}
                onClick={() => onPageChange(page + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        )}
      </div>
      }
    />
  );
}

function CurlCommandDialog({ open, onClose, curlCommand }: { open: boolean; onClose: () => void; curlCommand: string }) {
  const [isCopyingCurl, setIsCopyingCurl] = useState(false);

  const copyCommand = async () => {
    setIsCopyingCurl(true);
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      navigator.clipboard.writeText(curlCommand);
      await systemDialog.alert('已复制到剪贴板');
    } finally {
      setIsCopyingCurl(false);
    }
  };

  return (
    <Dialog 
      open={open} 
      onOpenChange={(isOpen) => !isOpen && onClose()} 
      title="curl 调用示例"
      maxWidth={800}
      content={
        <div className="space-y-4">
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-md p-4">
            <p className="text-sm text-yellow-600 dark:text-yellow-400 font-medium">使用说明</p>
            <p className="text-sm text-yellow-600 dark:text-yellow-400 mt-1">
              请将命令中的 <code className="bg-yellow-500/20 px-1 rounded">YOUR_API_KEY</code> 替换为应用的真实 API Key，然后在终端中执行。
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium">curl 命令</label>
              <Button variant="secondary" size="sm" onClick={copyCommand} disabled={isCopyingCurl}>
                {isCopyingCurl ? (
                  <svg className="w-3.5 h-3.5 animate-spin mr-1" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                ) : (
                  <Copy size={14} className="mr-1" />
                )}
                复制命令
              </Button>
            </div>
            <pre className="bg-muted p-4 rounded-md text-xs overflow-x-auto">
              <code>{curlCommand}</code>
            </pre>
          </div>

          <div className="flex justify-end pt-4">
            <Button onClick={onClose}>关闭</Button>
          </div>
        </div>
      }
    />
  );
}
