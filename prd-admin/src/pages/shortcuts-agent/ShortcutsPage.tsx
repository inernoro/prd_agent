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
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Dialog } from '@/components/ui/Dialog';
import {
  listShortcuts,
  createShortcut,
  deleteShortcut,
  getBindingTargets,
  type ShortcutItem,
  type CreateShortcutInput,
  type BindingTarget,
} from '@/services/real/shortcutsAgent';

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

      {/* List */}
      {loading ? (
        <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 40 }}>加载中...</p>
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
            <ShortcutCard key={s.id} item={s} onDelete={() => handleDelete(s.id, s.name)} />
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

// ─── Shortcut Card ───
function ShortcutCard({ item, onDelete }: { item: ShortcutItem; onDelete: () => void }) {
  const binding = BINDING_LABELS[item.bindingType] || BINDING_LABELS.collect;
  const BindingIcon = binding.icon;

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
        </div>
      </div>

      {/* Actions */}
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
    };

    const res = await createShortcut(input);
    setSubmitting(false);

    if (res.success && res.data) {
      onCreated({
        name: res.data.name,
        token: res.data.token,
        installPageUrl: res.data.installPageUrl,
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

  const copyToken = () => {
    navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
          Token（仅显示一次，请妥善保管）
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
        扫码后点击「下载并安装快捷指令」→ iOS 提示添加 → 完成<br />
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
