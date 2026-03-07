import { useState, useEffect, useCallback } from 'react';
import { Github, BookOpen, Plus, RefreshCw, Trash2, TestTube, Link2, Check, X, GitBranch } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import {
  listPersonalSources,
  createPersonalSource,
  updatePersonalSource,
  deletePersonalSource,
  testPersonalSource,
  syncPersonalSource,
  getPersonalStats,
} from '@/services';
import type { PersonalSource, PersonalStats } from '@/services/contracts/reportAgent';

const SOURCE_TYPES = [
  { value: 'github', label: 'GitHub', icon: Github, placeholder: 'https://github.com/user/repo' },
  { value: 'yuque', label: '语雀', icon: BookOpen, placeholder: '语雀空间 ID 或地址' },
  { value: 'gitlab', label: 'GitLab', icon: GitBranch, placeholder: 'https://gitlab.com/user/repo' },
] as const;

const statusColors: Record<string, string> = {
  success: 'var(--text-success, #22c55e)',
  failed: 'var(--text-error, #ef4444)',
  never: 'var(--text-tertiary)',
};

const statusLabels: Record<string, string> = {
  success: '已连接',
  failed: '连接失败',
  never: '未同步',
};

export function PersonalSourcesPanel() {
  const [sources, setSources] = useState<PersonalSource[]>([]);
  const [stats, setStats] = useState<PersonalStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  // Create form state
  const [formType, setFormType] = useState('github');
  const [formName, setFormName] = useState('');
  const [formRepoUrl, setFormRepoUrl] = useState('');
  const [formUsername, setFormUsername] = useState('');
  const [formToken, setFormToken] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [srcRes, statsRes] = await Promise.all([
        listPersonalSources(),
        getPersonalStats(),
      ]);
      if (srcRes.success && srcRes.data) setSources(srcRes.data.items);
      if (statsRes.success && statsRes.data) setStats(statsRes.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async () => {
    if (!formName.trim() || !formToken.trim()) return;
    const res = await createPersonalSource({
      sourceType: formType,
      displayName: formName.trim(),
      config: {
        repoUrl: formRepoUrl || undefined,
        username: formUsername || undefined,
      },
      token: formToken,
    });
    if (res.success) {
      setShowCreate(false);
      resetForm();
      void load();
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定解绑此数据源？')) return;
    const res = await deletePersonalSource({ id });
    if (res.success) void load();
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const res = await testPersonalSource({ id });
      alert(res.success && res.data?.success ? '连接成功' : '连接失败');
    } finally {
      setTestingId(null);
    }
  };

  const handleSync = async (id: string) => {
    setSyncingId(id);
    try {
      await syncPersonalSource({ id });
      void load();
    } finally {
      setSyncingId(null);
    }
  };

  const handleToggle = async (source: PersonalSource) => {
    await updatePersonalSource({ id: source.id, enabled: !source.enabled });
    void load();
  };

  const resetForm = () => {
    setFormType('github');
    setFormName('');
    setFormRepoUrl('');
    setFormUsername('');
    setFormToken('');
  };

  const getSourceIcon = (type: string) => {
    const found = SOURCE_TYPES.find(s => s.value === type);
    if (!found) return Link2;
    return found.icon;
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>我的数据源</h3>
          <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>绑定个人 GitHub / 语雀 / GitLab 账号，系统自动采集产出数据</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => load()} disabled={loading}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> 刷新
          </Button>
          <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
            <Plus size={12} /> 添加数据源
          </Button>
        </div>
      </div>

      {/* Stats Preview */}
      {stats && stats.sources.length > 0 && (
        <GlassCard className="p-3">
          <div className="text-[12px] font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>本周统计预览</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {stats.sources.map((s, i) => (
              <div key={i} className="flex flex-col gap-1">
                <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{s.displayName}</div>
                {Object.entries(s.summary).map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between text-[12px]">
                    <span style={{ color: 'var(--text-secondary)' }}>{key}</span>
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{value}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </GlassCard>
      )}

      {/* Source List */}
      {sources.length === 0 && !loading && (
        <GlassCard className="p-6 text-center">
          <Link2 size={24} className="mx-auto mb-2" style={{ color: 'var(--text-tertiary)' }} />
          <div className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>暂无数据源</div>
          <div className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>点击"添加数据源"绑定你的 GitHub 或语雀账号</div>
        </GlassCard>
      )}

      {sources.map((source) => {
        const Icon = getSourceIcon(source.sourceType);
        return (
          <GlassCard key={source.id} className="p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Icon size={16} style={{ color: 'var(--text-secondary)' }} />
                <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{source.displayName}</span>
                <span className="text-[11px] px-1.5 py-0.5 rounded" style={{
                  color: statusColors[source.lastSyncStatus] || 'var(--text-tertiary)',
                  background: 'var(--bg-secondary)',
                }}>
                  {statusLabels[source.lastSyncStatus] || source.lastSyncStatus}
                </span>
                {!source.enabled && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ color: 'var(--text-tertiary)', background: 'var(--bg-secondary)' }}>
                    已禁用
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => handleToggle(source)} title={source.enabled ? '禁用' : '启用'}>
                  {source.enabled ? <Check size={12} /> : <X size={12} />}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => handleTest(source.id)} disabled={testingId === source.id}>
                  <TestTube size={12} className={testingId === source.id ? 'animate-pulse' : ''} />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => handleSync(source.id)} disabled={syncingId === source.id}>
                  <RefreshCw size={12} className={syncingId === source.id ? 'animate-spin' : ''} />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => handleDelete(source.id)}>
                  <Trash2 size={12} />
                </Button>
              </div>
            </div>
            {source.config.repoUrl && (
              <div className="text-[11px] mt-1 ml-6" style={{ color: 'var(--text-tertiary)' }}>{source.config.repoUrl}</div>
            )}
            {source.lastSyncAt && (
              <div className="text-[11px] mt-1 ml-6" style={{ color: 'var(--text-tertiary)' }}>
                上次同步: {new Date(source.lastSyncAt).toLocaleString()}
              </div>
            )}
            {source.lastSyncError && (
              <div className="text-[11px] mt-1 ml-6" style={{ color: 'var(--text-error, #ef4444)' }}>{source.lastSyncError}</div>
            )}
          </GlassCard>
        );
      })}

      {/* Create Dialog */}
      {showCreate && (
        <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: 'rgba(0,0,0,0.5)' }}>
          <GlassCard className="w-[420px] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>添加数据源</h3>
              <Button variant="ghost" size="sm" onClick={() => { setShowCreate(false); resetForm(); }}>
                <X size={14} />
              </Button>
            </div>

            <div className="space-y-2">
              <label className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>数据源类型</label>
              <div className="flex gap-2">
                {SOURCE_TYPES.map(st => (
                  <button
                    key={st.value}
                    onClick={() => setFormType(st.value)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] transition-colors"
                    style={{
                      background: formType === st.value ? 'var(--accent-primary)' : 'var(--bg-secondary)',
                      color: formType === st.value ? '#fff' : 'var(--text-secondary)',
                    }}
                  >
                    <st.icon size={12} /> {st.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>显示名称</label>
              <input
                value={formName}
                onChange={e => setFormName(e.target.value)}
                placeholder={`我的 ${SOURCE_TYPES.find(s => s.value === formType)?.label || ''}`}
                className="w-full px-2.5 py-1.5 rounded text-[12px]"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
              />
            </div>

            <div className="space-y-2">
              <label className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                {formType === 'yuque' ? '空间地址（可选）' : '仓库地址（可选，留空采集全部）'}
              </label>
              <input
                value={formRepoUrl}
                onChange={e => setFormRepoUrl(e.target.value)}
                placeholder={SOURCE_TYPES.find(s => s.value === formType)?.placeholder || ''}
                className="w-full px-2.5 py-1.5 rounded text-[12px]"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
              />
            </div>

            {formType !== 'yuque' && (
              <div className="space-y-2">
                <label className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>用户名（可选）</label>
                <input
                  value={formUsername}
                  onChange={e => setFormUsername(e.target.value)}
                  placeholder="GitHub/GitLab 用户名"
                  className="w-full px-2.5 py-1.5 rounded text-[12px]"
                  style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                />
              </div>
            )}

            <div className="space-y-2">
              <label className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>Access Token</label>
              <input
                type="password"
                value={formToken}
                onChange={e => setFormToken(e.target.value)}
                placeholder={formType === 'github' ? 'ghp_...' : formType === 'yuque' ? '语雀 Token' : 'GitLab Token'}
                className="w-full px-2.5 py-1.5 rounded text-[12px]"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" size="sm" onClick={() => { setShowCreate(false); resetForm(); }}>取消</Button>
              <Button variant="primary" size="sm" onClick={handleCreate} disabled={!formName.trim() || !formToken.trim()}>确认绑定</Button>
            </div>
          </GlassCard>
        </div>
      )}
    </div>
  );
}
