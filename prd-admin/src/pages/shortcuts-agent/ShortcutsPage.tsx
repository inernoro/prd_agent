import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { useState, useEffect, useCallback } from 'react';
import {
  Plus,
  Trash2,
  Zap,
  Bookmark,
  GitBranch,
  Bot,
  Smartphone,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  Cloud,
  ExternalLink,
  Download,
  RefreshCw,
  Clock,
  Inbox,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Dialog } from '@/components/ui/Dialog';
import { TipsEntryButton } from '@/components/daily-tips/TipsEntryButton';
import {
  listShortcuts,
  createShortcut,
  deleteShortcut,
  extendShortcut,
  listCollections,
  getBindingTargets,
  listTemplates,
  createTemplate,
  deleteTemplate,
  type ShortcutItem,
  type CreateShortcutInput,
  type BindingTarget,
  type ShortcutTemplateItem,
  type ShortcutCollectionItem,
} from '@/services/real/shortcutsAgent';
import { copyWithFeedback } from '@/lib/clipboard';

// ─── Binding type labels (收藏是必备功能，绑定是附加功能) ───
const BINDING_LABELS: Record<string, { label: string; icon: typeof Bookmark; color: string }> = {
  collect: { label: '仅收藏', icon: Bookmark, color: '#34c759' },
  workflow: { label: '工作流', icon: GitBranch, color: '#007aff' },
  agent: { label: '智能体', icon: Bot, color: '#af52de' },
};

// ─── Main Page ───
export default function ShortcutsPage() {
  const [shortcuts, setShortcuts] = useState<ShortcutItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createdResult, setCreatedResult] = useState<{
    name: string;
    token: string;
    installPageUrl: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listShortcuts();
    if (res.success && res.data) setShortcuts(res.data.items);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`确定删除「${name}」？关联的 token 将立即失效。`)) return;
    const res = await deleteShortcut(id);
    if (res.success) load();
  };

  const handleExtend = async (id: string) => {
    const res = await extendShortcut(id);
    if (res.success) load();
  };

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>
            快捷指令
          </h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
            创建快捷指令，自动收藏 + 绑定工作流/智能体，扫码安装到 iPhone
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <TipsEntryButton compact />
          <button
            onClick={() => setShowCreate(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 16px', borderRadius: 10,
              background: 'var(--accent)', color: '#fff',
              border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600,
            }}
          >
            <Plus size={16} /> 创建
          </button>
        </div>
      </div>

      {/* iCloud 模板配置 */}
      <ICloudTemplatePanel />

      <LiveCollectionsPanel />

      {/* List */}
      {loading ? (
        <MapSectionLoader />
      ) : shortcuts.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: '60px 20px',
          background: 'var(--surface-card)', borderRadius: 16,
        }}>
          <Zap size={48} style={{ color: 'var(--text-muted)', marginBottom: 16 }} />
          <p style={{ color: 'var(--text-secondary)', fontSize: 15 }}>还没有快捷指令</p>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>
            点击「创建」生成你的第一个快捷指令
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {shortcuts.map((s) => (
            <ShortcutCard
              key={s.id}
              item={s}
              onExtend={() => handleExtend(s.id)}
              onDelete={() => handleDelete(s.id, s.name)}
            />
          ))}
        </div>
      )}

      {/* Create Dialog */}
      {showCreate && (
        <CreateShortcutDialog
          open={showCreate}
          onClose={() => setShowCreate(false)}
          onCreated={(result) => {
            setShowCreate(false);
            setCreatedResult(result);
            load();
          }}
        />
      )}

      {/* QR Code Dialog (after creation) */}
      {createdResult && (
        <Dialog
          open={!!createdResult}
          onOpenChange={() => setCreatedResult(null)}
          title={`「${createdResult.name}」创建成功`}
          content={
            <QRCodePanel
              name={createdResult.name}
              token={createdResult.token}
              installPageUrl={createdResult.installPageUrl}
            />
          }
          maxWidth={420}
        />
      )}
    </div>
  );
}

// ─── iCloud Template Panel ───
function ICloudTemplatePanel() {
  const [template, setTemplate] = useState<ShortcutTemplateItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [iCloudUrl, setICloudUrl] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listTemplates();
    if (res.success && res.data?.items?.length) {
      setTemplate(res.data.items[0]);
    } else {
      setTemplate(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    const url = iCloudUrl.trim();
    if (!url) return;
    setSaving(true);
    // 先删旧的
    if (template) {
      await deleteTemplate(template.id);
    }
    const res = await createTemplate({
      name: 'PrdAgent 收藏',
      iCloudUrl: url,
      isDefault: true,
    });
    setSaving(false);
    if (res.success) {
      setICloudUrl('');
      setExpanded(false);
      load();
    }
  };

  const handleDelete = async () => {
    if (!template || !confirm('确定移除 iCloud 模板链接？')) return;
    await deleteTemplate(template.id);
    setTemplate(null);
  };

  if (loading) return null;

  // 已配置 iCloud 模板 — 显示紧凑状态
  if (template) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
        marginBottom: 16, borderRadius: 12,
        background: 'rgba(52, 199, 89, 0.06)',
        border: '1px solid rgba(52, 199, 89, 0.15)',
      }}>
        <Cloud size={15} style={{ color: '#34c759', flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: 13, color: 'var(--text-secondary)' }}>
          iCloud 模板已配置
        </span>
        <a
          href={template.iCloudUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 3 }}
        >
          <ExternalLink size={11} /> 查看
        </a>
        <button
          onClick={handleDelete}
          style={{
            fontSize: 12, color: 'var(--text-muted)', background: 'none',
            border: 'none', cursor: 'pointer', padding: '2px 6px',
          }}
        >
          移除
        </button>
      </div>
    );
  }

  // 未配置 — 显示配置引导
  return (
    <div style={{
      marginBottom: 16, borderRadius: 14, overflow: 'hidden',
      background: 'var(--surface-card)',
      border: '1px solid rgba(255, 149, 0, 0.2)',
    }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%',
          padding: '12px 16px', background: 'rgba(255, 149, 0, 0.06)',
          border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <Cloud size={16} style={{ color: '#ff9500', flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: '#ff9500' }}>
          配置 iCloud 模板（iOS 用户扫码安装需要）
        </span>
        {expanded ? <ChevronUp size={14} style={{ color: 'var(--text-muted)' }} /> : <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} />}
      </button>

      {expanded && (
        <div style={{ padding: '12px 16px 16px' }}>
          {/* 影响说明：先讲清「不配会怎样」，再讲怎么配，促使一次性配好 */}
          <div style={{
            fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 12,
            padding: '10px 12px', borderRadius: 10,
            background: 'rgba(255,149,0,0.08)', border: '1px solid rgba(255,149,0,0.18)',
          }}>
            <strong style={{ color: '#ff9500' }}>配一次，全站受益。</strong>
            未配置时，所有人扫码后只能<strong>手动新建快捷指令</strong>（步骤多、易出错）；
            配好这个 iCloud 模板后，全站用户扫码即可<strong>一键安装</strong>。
          </div>
          {/* 引导说明 */}
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 14 }}>
            iOS 15+ 要求通过 iCloud 链接安装快捷指令。只需一次性配置（需要一台 Mac）：
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
            {[
              { n: 1, icon: <Download size={12} />, text: '在 Mac 上下载模板文件', action: (
                <a
                  href="/api/shortcuts/template-download"
                  style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none', marginLeft: 6 }}
                >
                  下载
                </a>
              )},
              { n: 2, text: '双击安装到「快捷指令」App' },
              { n: 3, text: '右键 → 分享 → 拷贝 iCloud 链接' },
              { n: 4, text: '粘贴到下方输入框' },
            ].map(({ n, text, action }) => (
              <div key={n} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                fontSize: 12, color: 'var(--text-secondary)',
              }}>
                <span style={{
                  width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, fontWeight: 700,
                  background: 'rgba(255,149,0,0.12)', color: '#ff9500',
                }}>
                  {n}
                </span>
                <span>{text}</span>
                {action}
              </div>
            ))}
          </div>

          {/* iCloud URL 输入 */}
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={iCloudUrl}
              onChange={(e) => setICloudUrl(e.target.value)}
              placeholder="https://www.icloud.com/shortcuts/..."
              style={{
                flex: 1, padding: '8px 12px', borderRadius: 10, fontSize: 13,
                border: '1px solid var(--border-subtle)',
                background: 'var(--surface-card)', color: 'var(--text-primary)',
                outline: 'none',
              }}
            />
            <button
              onClick={handleSave}
              disabled={saving || !iCloudUrl.trim()}
              style={{
                padding: '8px 16px', borderRadius: 10, border: 'none',
                background: 'var(--accent)', color: '#fff', fontSize: 13,
                fontWeight: 600, cursor: 'pointer',
                opacity: saving || !iCloudUrl.trim() ? 0.5 : 1,
              }}
            >
              {saving ? '...' : '保存'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Live Inbox ───
function LiveCollectionsPanel() {
  const [items, setItems] = useState<ShortcutCollectionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    const res = await listCollections({ page: 1, pageSize: 10 });
    if (res.success && res.data) {
      setItems(res.data.items || []);
      setUpdatedAt(new Date());
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  return (
    <div style={{
      marginBottom: 16,
      padding: 16,
      borderRadius: 14,
      background: 'var(--surface-card)',
      border: '1px solid var(--border-subtle)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Inbox size={16} style={{ color: 'var(--accent)' }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
            实时收件箱
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            当前登录用户的快捷指令收藏记录，每 3 秒刷新一次
          </div>
        </div>
        <button
          onClick={load}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '7px 10px', borderRadius: 8,
            border: '1px solid var(--border-subtle)',
            background: 'transparent', color: 'var(--text-secondary)',
            cursor: 'pointer', fontSize: 12,
          }}
        >
          <RefreshCw size={13} /> 刷新
        </button>
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>加载中...</div>
      ) : items.length === 0 ? (
        <div style={{
          padding: '18px 12px',
          borderRadius: 10,
          background: 'rgba(255,255,255,0.03)',
          color: 'var(--text-muted)',
          fontSize: 13,
          textAlign: 'center',
        }}>
          暂无分享记录。添加快捷指令后，从手机分享任意链接即可在这里看到。
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((item) => (
            <div
              key={item.id}
              style={{
                padding: '10px 12px',
                borderRadius: 10,
                background: 'rgba(255,255,255,0.035)',
                border: '1px solid rgba(255,255,255,0.05)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  fontSize: 11,
                  padding: '2px 7px',
                  borderRadius: 999,
                  background: 'rgba(52,199,89,0.12)',
                  color: '#34c759',
                  flexShrink: 0,
                }}>
                  {item.status || 'saved'}
                </span>
                <span style={{
                  minWidth: 0,
                  flex: 1,
                  color: 'var(--text-primary)',
                  fontSize: 13,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {item.url || item.text || '(空内容)'}
                </span>
                <span style={{ color: 'var(--text-muted)', fontSize: 11, flexShrink: 0 }}>
                  {new Date(item.createdAt).toLocaleTimeString()}
                </span>
              </div>
              <div style={{ marginTop: 5, color: 'var(--text-muted)', fontSize: 11 }}>
                {item.shortcutName ? `来源：${item.shortcutName}` : '来源：快捷指令'}
              </div>
            </div>
          ))}
        </div>
      )}

      {updatedAt && (
        <div style={{ marginTop: 10, color: 'var(--text-muted)', fontSize: 11 }}>
          最近刷新：{updatedAt.toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}

// ─── Shortcut Card ───
function ShortcutCard({ item, onExtend, onDelete }: { item: ShortcutItem; onExtend: () => void; onDelete: () => void }) {
  const binding = BINDING_LABELS[item.bindingType] || BINDING_LABELS.collect;
  const BindingIcon = binding.icon;
  const expiresAt = item.expiresAt ? new Date(item.expiresAt) : null;
  const expired = !!expiresAt && expiresAt.getTime() <= Date.now();

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, padding: 16,
      background: 'var(--surface-card)', borderRadius: 14,
      border: '1px solid var(--border-subtle)',
    }}>
      {/* Icon */}
      <div style={{
        width: 48, height: 48, borderRadius: 12,
        background: item.color || '#007aff', display: 'flex',
        alignItems: 'center', justifyContent: 'center', fontSize: 24, flexShrink: 0,
      }}>
        {item.icon || '⚡'}
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
            {item.name}
          </span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            fontSize: 11, padding: '2px 8px', borderRadius: 6,
            background: 'rgba(52, 199, 89, 0.12)', color: '#34c759',
          }}>
            <Bookmark size={10} /> 收藏
          </span>
          {item.bindingType !== 'collect' && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              fontSize: 11, padding: '2px 8px', borderRadius: 6,
              background: `${binding.color}20`, color: binding.color,
            }}>
              <BindingIcon size={10} /> {binding.label}
            </span>
          )}
          {!item.isActive && (
            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, background: '#ff3b3020', color: '#ff3b30' }}>
              已禁用
            </span>
          )}
          {expired && (
            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, background: '#ff3b3020', color: '#ff3b30' }}>
              已过期
            </span>
          )}
        </div>
        {item.bindingTargetName && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            绑定: {item.bindingTargetName}
          </div>
        )}
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, display: 'flex', gap: 12 }}>
          <span><Smartphone size={11} /> {item.tokenPrefix}</span>
          <span>使用 {item.collectCount} 次</span>
          {item.lastUsedAt && <span>最近: {new Date(item.lastUsedAt).toLocaleDateString()}</span>}
          {expiresAt && <span><Clock size={11} /> 到期: {expiresAt.toLocaleDateString()}</span>}
        </div>
      </div>

      {/* Actions */}
      <button
        onClick={onExtend}
        style={{
          padding: '8px 10px', borderRadius: 8, background: 'transparent',
          border: '1px solid var(--border-subtle)', cursor: 'pointer', color: 'var(--text-secondary)',
          fontSize: 12,
        }}
        title="延长授权 3 年"
      >
        延长 3 年
      </button>
      <button
        onClick={onDelete}
        style={{
          padding: 8, borderRadius: 8, background: 'transparent',
          border: '1px solid var(--border-subtle)', cursor: 'pointer', color: 'var(--text-muted)',
        }}
        title="删除"
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}

// ─── Create Dialog ───
function CreateShortcutDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (result: { name: string; token: string; installPageUrl: string }) => void;
}) {
  const [name, setName] = useState('');
  const [bindingType, setBindingType] = useState<string>('collect');
  const [bindingTargetId, setBindingTargetId] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [icon, setIcon] = useState('⚡');
  const [color, setColor] = useState('#007AFF');
  const [submitting, setSubmitting] = useState(false);

  // Binding targets
  const [targets, setTargets] = useState<{ workflows: BindingTarget[]; agents: BindingTarget[] }>({
    workflows: [],
    agents: [],
  });

  useEffect(() => {
    getBindingTargets().then((res) => {
      if (res.success && res.data) setTargets(res.data);
    });
  }, []);

  const currentTargets = bindingType === 'workflow' ? targets.workflows : targets.agents;
  const selectedTarget = currentTargets.find((t) => t.id === bindingTargetId);

  const handleSubmit = async () => {
    setSubmitting(true);
    const input: CreateShortcutInput = {
      name: name.trim() || undefined,
      icon,
      color,
      bindingType,
      bindingTargetId: bindingType !== 'collect' ? bindingTargetId : undefined,
      bindingTargetName: selectedTarget?.name,
      clientBaseUrl: window.location.origin,
    };

    const res = await createShortcut(input);
    setSubmitting(false);

    if (res.success && res.data) {
      // 前端自己拼安装页 URL（指向前端公开路由，不走 /api/）
      const installUrl = `${window.location.origin}/s/shortcut/${res.data.id}?t=${encodeURIComponent(res.data.token)}`;
      onCreated({
        name: res.data.name,
        token: res.data.token,
        installPageUrl: installUrl,
      });
    }
  };

  const ICONS = ['⚡', '🌟', '📌', '🔖', '🚀', '💡', '🎯', '📎', '🔮', '⭐'];
  const COLORS = ['#007AFF', '#34C759', '#FF9500', '#AF52DE', '#FF3B30', '#5856D6', '#FF2D55', '#30B0C7'];

  return (
    <Dialog
      open={open}
      onOpenChange={onClose}
      title="创建快捷指令"
      maxWidth={480}
      content={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Name */}
          <div>
            <label style={labelStyle}>名称</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="天狼星"
              style={inputStyle}
              autoFocus
            />
          </div>

          {/* 收藏说明 — 收藏是必备功能 */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
            borderRadius: 10, background: 'rgba(52, 199, 89, 0.08)',
            border: '1px solid rgba(52, 199, 89, 0.2)',
          }}>
            <Bookmark size={14} style={{ color: '#34c759', flexShrink: 0 }} />
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              每次分享都会<strong style={{ color: '#34c759' }}>自动收藏</strong>，可额外绑定工作流或智能体
            </span>
          </div>

          {/* Binding Type — 附加绑定（可选） */}
          <div>
            <label style={labelStyle}>附加绑定（可选）</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {([
                { key: 'collect', label: '无', icon: Bookmark, color: 'var(--text-muted)' },
                { key: 'workflow', label: '工作流', icon: GitBranch, color: '#007aff' },
                { key: 'agent', label: '智能体', icon: Bot, color: '#af52de' },
              ] as const).map(({ key, label, icon: Icon, color: c }) => (
                <button
                  key={key}
                  onClick={() => { setBindingType(key); setBindingTargetId(''); }}
                  style={{
                    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    padding: '10px 0', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 13,
                    fontWeight: bindingType === key ? 600 : 400,
                    background: bindingType === key ? (key === 'collect' ? 'var(--surface-card)' : `${c}20`) : 'var(--surface-card)',
                    color: bindingType === key ? (key === 'collect' ? 'var(--text-primary)' : c) : 'var(--text-secondary)',
                    outline: bindingType === key ? `2px solid ${key === 'collect' ? 'var(--border-subtle)' : `${c}50`}` : '1px solid var(--border-subtle)',
                  }}
                >
                  <Icon size={14} /> {label}
                </button>
              ))}
            </div>
          </div>

          {/* Target Selector (workflow / agent) — 紧凑下拉 */}
          {bindingType !== 'collect' && (
            <div>
              <label style={labelStyle}>
                选择{bindingType === 'workflow' ? '工作流' : '智能体'}
              </label>
              {currentTargets.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  暂无可用的{bindingType === 'workflow' ? '工作流' : '智能体'}
                </p>
              ) : (
                <select
                  value={bindingTargetId}
                  onChange={(e) => setBindingTargetId(e.target.value)}
                  style={{
                    ...inputStyle,
                    cursor: 'pointer',
                    appearance: 'auto',
                  }}
                >
                  <option value="">请选择...</option>
                  {currentTargets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.icon || '📦'} {t.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* Advanced (collapsed by default) */}
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 13, color: 'var(--text-muted)', padding: 0,
            }}
          >
            {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            高级选项
          </button>

          {showAdvanced && (
            <div style={{ display: 'flex', gap: 16 }}>
              {/* Icon picker */}
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>图标</label>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {ICONS.map((ic) => (
                    <button
                      key={ic}
                      onClick={() => setIcon(ic)}
                      style={{
                        width: 30, height: 30, borderRadius: 6, fontSize: 15,
                        border: 'none', cursor: 'pointer',
                        background: icon === ic ? 'var(--accent-muted)' : 'var(--surface-card)',
                        outline: icon === ic ? '2px solid var(--accent)' : '1px solid var(--border-subtle)',
                      }}
                    >
                      {ic}
                    </button>
                  ))}
                </div>
              </div>

              {/* Color picker */}
              <div>
                <label style={labelStyle}>主题色</label>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: 140 }}>
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => setColor(c)}
                      style={{
                        width: 28, height: 28, borderRadius: 6, border: 'none', cursor: 'pointer',
                        background: c,
                        outline: color === c ? '2px solid var(--text-primary)' : 'none',
                        outlineOffset: 2,
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={submitting || (bindingType !== 'collect' && !bindingTargetId)}
            style={{
              padding: '12px 0', borderRadius: 10, border: 'none', cursor: 'pointer',
              fontSize: 15, fontWeight: 600,
              background: 'var(--accent)', color: '#fff',
              opacity: submitting || (bindingType !== 'collect' && !bindingTargetId) ? 0.5 : 1,
            }}
          >
            {submitting ? '创建中...' : '创建快捷指令'}
          </button>
        </div>
      }
    />
  );
}

// ─── QR Code Panel (shown after creation) ───
function QRCodePanel({
  name,
  token,
  installPageUrl,
}: {
  name: string;
  token: string;
  installPageUrl: string;
}) {
  const [copied, setCopied] = useState(false);
  const [configCopied, setConfigCopied] = useState(false);

  const installConfig = JSON.stringify({
    token,
    endpoint: `${window.location.origin}/api/shortcuts/collect`,
    name,
  });

  const copyToken = async () => {
    const ok = await copyWithFeedback(token, { successMessage: 'Token 已复制', label: 'Token' });
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copyConfig = async () => {
    const ok = await copyWithFeedback(installConfig, { successMessage: '安装配置已复制', label: '安装配置' });
    if (!ok) return;
    setConfigCopied(true);
    setTimeout(() => setConfigCopied(false), 2000);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, padding: '8px 0' }}>
      <p style={{ fontSize: 14, color: 'var(--text-secondary)', textAlign: 'center' }}>
        用 iPhone 相机扫描二维码，即可安装快捷指令
      </p>

      {/* QR Code */}
      <div style={{
        padding: 16, borderRadius: 16, background: '#ffffff',
      }}>
        <QRCodeSVG value={installPageUrl} size={220} level="H" />
      </div>

      {/* URL display */}
      <div style={{
        width: '100%', fontSize: 11, color: 'var(--text-muted)',
        wordBreak: 'break-all', textAlign: 'center', lineHeight: 1.4,
        padding: '0 8px',
      }}>
        {installPageUrl}
      </div>

      {/* Token (one-time display) */}
      <div style={{
        width: '100%', padding: 12, borderRadius: 10,
        background: 'var(--surface-card)', border: '1px solid var(--border-subtle)',
      }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
          安装配置（iCloud 模板需要复制这一整段，不是只复制 Token）
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <code style={{
            flex: 1, fontSize: 11, color: 'var(--text-primary)',
            wordBreak: 'break-all', fontFamily: 'monospace',
          }}>
            {installConfig}
          </code>
          <button
            onClick={copyConfig}
            style={{
              padding: 6, borderRadius: 6, background: 'none',
              border: '1px solid var(--border-subtle)', cursor: 'pointer',
              color: configCopied ? '#34c759' : 'var(--text-muted)',
            }}
            title="复制安装配置"
          >
            {configCopied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
          Token（排查用，单独复制它不能完成 iCloud 模板配置）
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <code style={{
            flex: 1, fontSize: 12, color: 'var(--text-primary)',
            wordBreak: 'break-all', fontFamily: 'monospace',
          }}>
            {token}
          </code>
          <button
            onClick={copyToken}
            style={{
              padding: 6, borderRadius: 6, background: 'none',
              border: '1px solid var(--border-subtle)', cursor: 'pointer',
              color: copied ? '#34c759' : 'var(--text-muted)',
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      </div>

      <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.5 }}>
        扫码后按安装页提示添加快捷指令<br />
        之后在任意 App 点击分享 → 选择「{name}」即可
      </p>
    </div>
  );
}

// ─── Styles ───
const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--text-secondary)',
  marginBottom: 6,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid var(--border-subtle)',
  background: 'var(--surface-card)',
  color: 'var(--text-primary)',
  fontSize: 14,
  outline: 'none',
};
