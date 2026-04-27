import { useEffect, useState, useMemo, useCallback } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { Dialog } from '@/components/ui/Dialog';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import {
  Plus,
  Trash2,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Key,
  ExternalLink,
  Lock,
} from 'lucide-react';
import {
  listAuthorizations,
  listAuthorizationTypes,
  createAuthorization,
  updateAuthorization,
  revokeAuthorization,
  validateAuthorization,
  type AuthorizationSummary,
  type AuthTypeInfo,
} from '@/services/real/authorizations';

interface Props {
  onActionsReady?: (actions: React.ReactNode) => void;
}

const TYPE_ICONS: Record<string, string> = {
  tapd: '🐛',
  yuque: '📝',
  github: '🐙',
};

function statusBadge(status: string, readOnly?: boolean) {
  if (readOnly) return <Badge variant="subtle">只读</Badge>;
  if (status === 'active') return <Badge variant="success">有效</Badge>;
  if (status === 'expired') return <Badge variant="warning">已过期</Badge>;
  if (status === 'revoked') return <Badge variant="danger">已撤销</Badge>;
  return <Badge variant="subtle">{status}</Badge>;
}

function formatTime(iso: string | null | undefined) {
  if (!iso) return '-';
  const d = new Date(iso);
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  // 未来时间走未来格式，避免负值被误判为"刚刚"
  if (diffMin < 0) return formatFutureTime(d);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)} 小时前`;
  const days = Math.floor(diffMin / 1440);
  if (days < 30) return `${days} 天前`;
  return d.toLocaleDateString('zh-CN');
}

function formatFutureTime(d: Date) {
  const diffMin = Math.floor((d.getTime() - Date.now()) / 60000);
  if (diffMin < 60) return `${diffMin} 分钟后`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)} 小时后`;
  const days = Math.floor(diffMin / 1440);
  if (days < 30) return `${days} 天后`;
  return d.toLocaleDateString('zh-CN');
}

export default function AuthorizationsPanel({ onActionsReady }: Props) {
  const [items, setItems] = useState<AuthorizationSummary[]>([]);
  const [types, setTypes] = useState<AuthTypeInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<AuthorizationSummary | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [listRes, typesRes] = await Promise.all([listAuthorizations(), listAuthorizationTypes()]);
      if (listRes.success) setItems(listRes.data || []);
      if (typesRes.success) setTypes(typesRes.data || []);
    } catch (e) {
      toast.error('加载授权列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const actions = useMemo(() => (
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
        <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        刷新
      </Button>
      <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
        <Plus size={14} /> 添加授权
      </Button>
    </div>
  ), [load, loading]);

  useEffect(() => { onActionsReady?.(actions); }, [actions, onActionsReady]);

  async function handleValidate(id: string) {
    if (id.startsWith('github:')) {
      toast.info('GitHub 授权由 PR 审查模块管理');
      return;
    }
    const res = await validateAuthorization(id);
    if (res.success && res.data?.ok) {
      toast.success('验证通过');
      load();
    } else {
      toast.error(res.data?.errorMessage || res.error?.message || '验证失败');
      load();
    }
  }

  async function handleRevoke(item: AuthorizationSummary) {
    if (item.readOnly) {
      toast.info('只读映射，请前往原模块撤销');
      return;
    }
    const ok = await systemDialog.confirm({
      title: '撤销授权',
      message: `撤销「${item.name}」后，所有引用该授权的工作流将无法执行，是否继续？`,
      confirmText: '撤销',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await revokeAuthorization(item.id);
    if (res.success) {
      toast.success('已撤销');
      load();
    } else {
      toast.error(res.error?.message || '撤销失败');
    }
  }

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      {loading && items.length === 0 && (
        <GlassCard className="flex items-center justify-center py-12 text-white/50 text-sm">
          正在加载授权列表…
        </GlassCard>
      )}

      {!loading && items.length === 0 && (
        <GlassCard className="py-16 text-center">
          <Lock size={32} className="mx-auto text-white/40 mb-3" />
          <div className="text-white/70 text-base font-medium mb-2">还没有外部系统授权</div>
          <div className="text-white/40 text-xs mb-5">
            授权 TAPD / 语雀 / GitHub 后，工作流可以直接引用，无需每次粘贴凭证
          </div>
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            <Plus size={14} /> 添加第一个授权
          </Button>
        </GlassCard>
      )}

      {items.length > 0 && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <GlassCard>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-white/50 border-b border-white/10">
                  <th className="text-left py-2 px-3 font-medium">类型</th>
                  <th className="text-left py-2 px-3 font-medium">名称</th>
                  <th className="text-left py-2 px-3 font-medium">状态</th>
                  <th className="text-left py-2 px-3 font-medium">元数据</th>
                  <th className="text-left py-2 px-3 font-medium">最近使用</th>
                  <th className="text-left py-2 px-3 font-medium">过期</th>
                  <th className="text-right py-2 px-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id} className="border-b border-white/5 hover:bg-white/[0.03]">
                    <td className="py-3 px-3">
                      <span className="text-lg mr-2">{TYPE_ICONS[it.type] || '🔌'}</span>
                      <span className="text-white/70 text-xs uppercase">{it.type}</span>
                    </td>
                    <td className="py-3 px-3 text-white/90">{it.name}</td>
                    <td className="py-3 px-3">{statusBadge(it.status, it.readOnly)}</td>
                    <td className="py-3 px-3 text-white/60 text-xs">
                      {Object.entries(it.metadata || {}).slice(0, 2).map(([k, v]) => (
                        <div key={k}>{k}: {String(v).substring(0, 40)}</div>
                      ))}
                    </td>
                    <td className="py-3 px-3 text-white/60 text-xs">{formatTime(it.lastUsedAt)}</td>
                    <td className="py-3 px-3 text-white/60 text-xs">
                      {it.expiresAt ? formatTime(it.expiresAt) : '-'}
                    </td>
                    <td className="py-3 px-3 text-right">
                      <div className="inline-flex items-center gap-1">
                        {!it.readOnly && (
                          <button
                            onClick={() => handleValidate(it.id)}
                            className="p-1.5 rounded hover:bg-white/10 text-white/60 hover:text-white/90"
                            title="验证"
                          >
                            <CheckCircle2 size={14} />
                          </button>
                        )}
                        {!it.readOnly && (
                          <button
                            onClick={() => setEditing(it)}
                            className="p-1.5 rounded hover:bg-white/10 text-white/60 hover:text-white/90"
                            title="编辑"
                          >
                            <Key size={14} />
                          </button>
                        )}
                        <button
                          onClick={() => handleRevoke(it)}
                          className="p-1.5 rounded hover:bg-red-500/20 text-white/60 hover:text-red-400"
                          title={it.readOnly ? '原模块处理' : '撤销'}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </GlassCard>
        </div>
      )}

      {addOpen && (
        <AddAuthorizationDialog
          types={types}
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); load(); }}
        />
      )}

      {editing && (
        <EditAuthorizationDialog
          item={editing}
          types={types}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function AddAuthorizationDialog({
  types,
  onClose,
  onSaved,
}: {
  types: AuthTypeInfo[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selectedType, setSelectedType] = useState<string>('');
  const [name, setName] = useState('');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // GitHub 不在本中心添加
  const available = types.filter(t => t.typeKey !== 'github');
  const current = types.find(t => t.typeKey === selectedType);

  async function handleSave() {
    if (!selectedType || !name.trim()) {
      toast.error('请选择类型并填写名称');
      return;
    }
    // 必填校验
    for (const f of current?.fields || []) {
      if (f.required && !credentials[f.key]?.trim()) {
        toast.error(`${f.label} 不能为空`);
        return;
      }
    }
    setSaving(true);
    try {
      const res = await createAuthorization({ type: selectedType, name: name.trim(), credentials });
      if (res.success) {
        const status = (res.data as any)?.status;
        if (status === 'active') {
          toast.success('授权成功，验证通过');
        } else {
          toast.info('已保存，但凭证验证未通过，请检查');
        }
        onSaved();
      } else {
        toast.error(res.error?.message || '保存失败');
      }
    } finally {
      setSaving(false);
    }
  }

  const body = (
    <>
      <div style={{ minHeight: 0, maxHeight: '60vh', overflowY: 'auto' }} className="flex flex-col gap-4 px-1">
        {!selectedType ? (
          <>
            <div className="text-xs text-white/60 mb-1">选择要授权的系统</div>
            <div className="grid grid-cols-2 gap-2">
              {available.map(t => (
                <button
                  key={t.typeKey}
                  onClick={() => setSelectedType(t.typeKey)}
                  className="p-4 rounded-lg border border-white/10 hover:border-white/30 hover:bg-white/5 text-left transition"
                >
                  <div className="text-2xl mb-1">{TYPE_ICONS[t.typeKey] || '🔌'}</div>
                  <div className="text-white/90 text-sm font-medium">{t.displayName}</div>
                  <div className="text-white/40 text-xs mt-1">{t.fields.length} 个字段</div>
                </button>
              ))}
            </div>
            <div className="p-3 rounded bg-blue-500/10 border border-blue-500/30 text-xs text-white/70">
              <ExternalLink size={12} className="inline mr-1" />
              GitHub 授权请前往「PR 审查」模块发起 OAuth Device Flow
            </div>
          </>
        ) : (
          <>
            <div>
              <div className="text-xs text-white/60 mb-1">类型</div>
              <div className="flex items-center gap-2 p-2 rounded bg-white/5 border border-white/10">
                <span className="text-xl">{TYPE_ICONS[selectedType]}</span>
                <span className="text-white/90">{current?.displayName}</span>
                <button onClick={() => { setSelectedType(''); setCredentials({}); }} className="ml-auto text-xs text-white/50 hover:text-white/80">
                  切换
                </button>
              </div>
            </div>

            <div>
              <div className="text-xs text-white/60 mb-1">名称 <span className="text-red-400">*</span></div>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：生产 TAPD 账号"
                className="w-full px-3 py-2 rounded bg-white/5 border border-white/10 focus:border-white/30 text-white text-sm outline-none"
              />
            </div>

            {current?.fields.map(f => (
              <div key={f.key}>
                <div className="text-xs text-white/60 mb-1">
                  {f.label} {f.required && <span className="text-red-400">*</span>}
                </div>
                {f.type === 'textarea' ? (
                  <textarea
                    value={credentials[f.key] || ''}
                    onChange={(e) => setCredentials({ ...credentials, [f.key]: e.target.value })}
                    placeholder={f.placeholder}
                    rows={3}
                    className="w-full px-3 py-2 rounded bg-white/5 border border-white/10 focus:border-white/30 text-white text-sm outline-none font-mono"
                  />
                ) : (
                  <input
                    type={f.type === 'password' ? 'password' : 'text'}
                    value={credentials[f.key] || ''}
                    onChange={(e) => setCredentials({ ...credentials, [f.key]: e.target.value })}
                    placeholder={f.placeholder}
                    className="w-full px-3 py-2 rounded bg-white/5 border border-white/10 focus:border-white/30 text-white text-sm outline-none"
                  />
                )}
                {f.helpText && (
                  <div className="text-[11px] text-white/40 mt-1">{f.helpText}</div>
                )}
              </div>
            ))}

            <div className="p-2 rounded bg-amber-500/10 border border-amber-500/30 text-xs text-white/70 flex gap-2">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5 text-amber-400" />
              <div>
                保存时会自动调用第三方 API 验证凭证。验证通过状态为「有效」，否则记为「已过期」但仍保留数据。
              </div>
            </div>
          </>
        )}
      </div>

      <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-white/10">
        <Button variant="ghost" onClick={onClose} disabled={saving}>取消</Button>
        <Button variant="primary" onClick={handleSave} disabled={saving || !selectedType}>
          {saving ? '保存中…' : '保存并验证'}
        </Button>
      </div>
    </>
  );

  return <Dialog open onOpenChange={(v) => !v && onClose()} title="添加外部授权" content={body} />;
}

function EditAuthorizationDialog({
  item,
  types,
  onClose,
  onSaved,
}: {
  item: AuthorizationSummary;
  types: AuthTypeInfo[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const current = types.find(t => t.typeKey === item.type);

  async function handleSave() {
    setSaving(true);
    try {
      const input: any = {};
      if (name.trim() !== item.name) input.name = name.trim();
      if (Object.keys(credentials).length > 0) {
        // 只更新填了的字段，保留未变的（后端收到的credentials如果有字段就整体替换）
        input.credentials = credentials;
      }
      if (Object.keys(input).length === 0) {
        toast.info('没有变更');
        onClose();
        return;
      }
      const res = await updateAuthorization(item.id, input);
      if (res.success) {
        toast.success('已更新');
        onSaved();
      } else {
        toast.error(res.error?.message || '更新失败');
      }
    } finally {
      setSaving(false);
    }
  }

  const body = (
    <>
      <div style={{ minHeight: 0, maxHeight: '60vh', overflowY: 'auto' }} className="flex flex-col gap-4 px-1">
        <div>
          <div className="text-xs text-white/60 mb-1">名称</div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 rounded bg-white/5 border border-white/10 focus:border-white/30 text-white text-sm outline-none"
          />
        </div>

        <div className="p-3 rounded bg-blue-500/10 border border-blue-500/30 text-xs text-white/70">
          <Clock size={12} className="inline mr-1" />
          仅填写需要更新的字段。留空的字段保持原值。
        </div>

        {current?.fields.map(f => (
          <div key={f.key}>
            <div className="text-xs text-white/60 mb-1">{f.label}</div>
            {f.type === 'textarea' ? (
              <textarea
                value={credentials[f.key] || ''}
                onChange={(e) => setCredentials({ ...credentials, [f.key]: e.target.value })}
                placeholder="留空保持原值"
                rows={3}
                className="w-full px-3 py-2 rounded bg-white/5 border border-white/10 focus:border-white/30 text-white text-sm outline-none font-mono"
              />
            ) : (
              <input
                type={f.type === 'password' ? 'password' : 'text'}
                value={credentials[f.key] || ''}
                onChange={(e) => setCredentials({ ...credentials, [f.key]: e.target.value })}
                placeholder="留空保持原值"
                className="w-full px-3 py-2 rounded bg-white/5 border border-white/10 focus:border-white/30 text-white text-sm outline-none"
              />
            )}
          </div>
        ))}
      </div>

      <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-white/10">
        <Button variant="ghost" onClick={onClose} disabled={saving}>取消</Button>
        <Button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </div>
    </>
  );

  return <Dialog open onOpenChange={(v) => !v && onClose()} title="编辑授权" content={body} />;
}
