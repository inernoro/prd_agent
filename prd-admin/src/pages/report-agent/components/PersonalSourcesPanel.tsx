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
  { value: 'github', label: 'GitHub', icon: Github, color: 'rgba(36, 41, 47, 0.9)', bg: 'rgba(36, 41, 47, 0.08)', placeholder: 'https://github.com/user/repo' },
  { value: 'yuque', label: '语雀', icon: BookOpen, color: 'rgba(52, 199, 89, 0.9)', bg: 'rgba(52, 199, 89, 0.08)', placeholder: '语雀空间 ID 或地址' },
  { value: 'gitlab', label: 'GitLab', icon: GitBranch, color: 'rgba(226, 67, 41, 0.9)', bg: 'rgba(226, 67, 41, 0.08)', placeholder: 'https://gitlab.com/user/repo' },
] as const;

const statusStyles: Record<string, { label: string; color: string; bg: string }> = {
  success: { label: '已连接', color: 'rgba(34, 197, 94, 0.9)', bg: 'rgba(34, 197, 94, 0.08)' },
  failed:  { label: '连接失败', color: 'rgba(239, 68, 68, 0.9)', bg: 'rgba(239, 68, 68, 0.08)' },
  never:   { label: '未同步', color: 'rgba(156, 163, 175, 0.7)', bg: 'rgba(156, 163, 175, 0.08)' },
};

export function PersonalSourcesPanel() {
  const [sources, setSources] = useState<PersonalSource[]>([]);
  const [stats, setStats] = useState<PersonalStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);

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

  const getSourceType = (type: string) => {
    return SOURCE_TYPES.find(s => s.value === type) || { value: type, label: type, icon: Link2, color: 'var(--text-muted)', bg: 'var(--bg-tertiary)', placeholder: '' };
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Header — card-wrapped */}
      <GlassCard variant="subtle" className="px-5 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'rgba(59, 130, 246, 0.06)' }}>
              <Link2 size={16} style={{ color: 'rgba(59, 130, 246, 0.8)' }} />
            </div>
            <div>
              <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>我的数据源</h3>
              <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                绑定个人 GitHub / 语雀 / GitLab 账号，系统自动采集产出数据
              </p>
            </div>
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
      </GlassCard>

      {/* Stats Preview */}
      {stats && stats.sources.length > 0 && (
        <GlassCard variant="subtle" className="p-4">
          <div className="text-[12px] font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>本周统计预览</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {stats.sources.map((s, i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{s.displayName}</div>
                {Object.entries(s.summary).map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between text-[12px]">
                    <span style={{ color: 'var(--text-secondary)' }}>{key}</span>
                    <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </GlassCard>
      )}

      {/* Empty state */}
      {sources.length === 0 && !loading && (
        <div className="flex items-center justify-center" style={{ minHeight: 320 }}>
          <div className="flex flex-col items-center gap-5 text-center max-w-sm">
            <div className="w-20 h-20 rounded-2xl flex items-center justify-center" style={{ background: 'var(--bg-tertiary)' }}>
              <Link2 size={32} style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
            </div>
            <div>
              <div className="text-[15px] font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>暂无数据源</div>
              <div className="text-[13px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                绑定 GitHub、语雀 或 GitLab 账号后，系统将自动采集你的代码提交和文档产出
              </div>
            </div>
            <div className="flex gap-3">
              {SOURCE_TYPES.map(stype => (
                <div
                  key={stype.value}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[12px]"
                  style={{ background: stype.bg, color: stype.color, border: `1px solid ${stype.color.replace('0.9', '0.15')}` }}
                >
                  <stype.icon size={13} /> {stype.label}
                </div>
              ))}
            </div>
            <Button variant="primary" onClick={() => setShowCreate(true)}>
              <Plus size={14} /> 添加数据源
            </Button>
          </div>
        </div>
      )}

      {/* Source cards */}
      <div className="flex flex-col gap-3">
        {sources.map((source) => {
          const st = getSourceType(source.sourceType);
          const Icon = st.icon;
          const ss = statusStyles[source.lastSyncStatus] || statusStyles.never;

          return (
            <div
              key={source.id}
              className="rounded-xl transition-all duration-200"
              style={{
                background: 'var(--surface-glass)',
                backdropFilter: 'blur(12px)',
                border: '1px solid var(--border-primary)',
                borderLeft: `3px solid ${st.color}`,
                opacity: source.enabled ? 1 : 0.6,
              }}
            >
              <div className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center"
                      style={{ background: st.bg }}
                    >
                      <Icon size={15} style={{ color: st.color }} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                          {source.displayName}
                        </span>
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded-full"
                          style={{ color: ss.color, background: ss.bg }}
                        >
                          {ss.label}
                        </span>
                        {!source.enabled && (
                          <span
                            className="text-[10px] px-1.5 py-0.5 rounded-full"
                            style={{ color: 'var(--text-muted)', background: 'var(--bg-tertiary)' }}
                          >
                            已禁用
                          </span>
                        )}
                      </div>
                      {source.config.repoUrl && (
                        <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                          {source.config.repoUrl}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => handleToggle(source)} title={source.enabled ? '禁用' : '启用'}>
                      {source.enabled ? <Check size={13} /> : <X size={13} />}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleTest(source.id)} disabled={testingId === source.id} title="测试连接">
                      <TestTube size={13} className={testingId === source.id ? 'animate-pulse' : ''} />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleSync(source.id)} disabled={syncingId === source.id} title="同步数据">
                      <RefreshCw size={13} className={syncingId === source.id ? 'animate-spin' : ''} />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(source.id)} title="解除绑定">
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </div>
                {source.lastSyncAt && (
                  <div className="text-[10px] mt-2 ml-11" style={{ color: 'var(--text-muted)' }}>
                    上次同步: {new Date(source.lastSyncAt).toLocaleString()}
                  </div>
                )}
                {source.lastSyncError && (
                  <div className="text-[10px] mt-1 ml-11" style={{ color: 'rgba(239, 68, 68, 0.85)' }}>
                    {source.lastSyncError}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Create Dialog */}
      {showCreate && (
        <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: 'rgba(0,0,0,0.4)' }}>
          <GlassCard className="w-[440px] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>添加数据源</h3>
              <Button variant="ghost" size="sm" onClick={() => { setShowCreate(false); resetForm(); }}>
                <X size={14} />
              </Button>
            </div>

            <div className="space-y-2">
              <label className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>数据源类型</label>
              <div className="flex gap-2">
                {SOURCE_TYPES.map(stype => {
                  const isActive = formType === stype.value;
                  return (
                    <button
                      key={stype.value}
                      onClick={() => setFormType(stype.value)}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[12px] transition-all duration-200"
                      style={{
                        background: isActive ? stype.bg : 'var(--bg-secondary)',
                        color: isActive ? stype.color : 'var(--text-secondary)',
                        border: `1px solid ${isActive ? stype.color.replace('0.9', '0.3') : 'var(--border-primary)'}`,
                      }}
                    >
                      <stype.icon size={13} /> {stype.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>显示名称</label>
              <input
                value={formName}
                onChange={e => setFormName(e.target.value)}
                placeholder={`我的 ${SOURCE_TYPES.find(s => s.value === formType)?.label || ''}`}
                className="w-full px-3 py-2 rounded-xl text-[13px]"
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
                className="w-full px-3 py-2 rounded-xl text-[13px]"
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
                  className="w-full px-3 py-2 rounded-xl text-[13px]"
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
                className="w-full px-3 py-2 rounded-xl text-[13px]"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" size="sm" onClick={() => { setShowCreate(false); resetForm(); }}>取消</Button>
              <Button variant="primary" size="sm" onClick={handleCreate} disabled={!formName.trim() || !formToken.trim()}>确认绑定</Button>
            </div>
          </GlassCard>
        </div>
      )}
    </div>
  );
}
