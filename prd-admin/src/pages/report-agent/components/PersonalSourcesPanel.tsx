import { useState, useEffect, useCallback, useRef } from 'react';
import { Github, BookOpen, Plus, RefreshCw, Trash2, TestTube, Link2, Check, X, Database } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import {
  listMyAiSources,
  updateMyAiSource,
  listPersonalSources,
  updatePersonalSource,
  deletePersonalSource,
  testPersonalSource,
  syncPersonalSource,
  getPersonalStats,
} from '@/services';
import type { ReportAiSource, PersonalSource, PersonalStats } from '@/services/contracts/reportAgent';

const SOURCE_TYPES = [
  {
    value: 'github',
    label: 'GitHub',
    icon: Github,
    color: 'rgba(96, 165, 250, 0.95)',
    bg: 'rgba(59, 130, 246, 0.14)',
    placeholder: 'https://github.com/user/repo',
  },
  {
    value: 'yuque',
    label: '语雀',
    icon: BookOpen,
    color: 'rgba(74, 222, 128, 0.95)',
    bg: 'rgba(34, 197, 94, 0.14)',
    placeholder: '如：123456 / your-space / https://www.yuque.com/xxx/yyy',
  },
] as const;

const statusStyles: Record<string, { label: string; color: string; bg: string }> = {
  success: { label: '已连接', color: 'rgba(34, 197, 94, 0.9)', bg: 'rgba(34, 197, 94, 0.08)' },
  failed:  { label: '连接失败', color: 'rgba(239, 68, 68, 0.9)', bg: 'rgba(239, 68, 68, 0.08)' },
  never:   { label: '未同步', color: 'rgba(156, 163, 175, 0.7)', bg: 'rgba(156, 163, 175, 0.08)' },
};

export function PersonalSourcesPanel() {
  const [aiSources, setAiSources] = useState<ReportAiSource[]>([]);
  const [sources, setSources] = useState<PersonalSource[]>([]);
  const [stats, setStats] = useState<PersonalStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [togglingAiSourceKey, setTogglingAiSourceKey] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const lastComingSoonNoticeAtRef = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [aiRes, srcRes, statsRes] = await Promise.all([
        listMyAiSources(),
        listPersonalSources(),
        getPersonalStats(),
      ]);
      if (aiRes.success && aiRes.data) setAiSources(aiRes.data.items);
      if (srcRes.success && srcRes.data) setSources(srcRes.data.items);
      if (statsRes.success && statsRes.data) setStats(statsRes.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleDelete = async (id: string) => {
    const ok = await systemDialog.confirm({
      title: '确认解绑此扩展数据源？',
      message: '解绑后将不会再采集该来源的数据。',
      tone: 'danger',
      confirmText: '确认解绑',
      cancelText: '取消',
    });
    if (!ok) return;
    const res = await deletePersonalSource({ id });
    if (res.success) {
      toast.success('已解绑');
      void load();
    } else {
      toast.error(res.error?.message || '解绑失败');
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const res = await testPersonalSource({ id });
      if (res.success && res.data?.success) {
        toast.success('连接成功');
      } else {
        toast.error('连接失败');
      }
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

  const handleToggleAiSource = async (source: ReportAiSource) => {
    if (source.locked) return;
    setTogglingAiSourceKey(source.key);
    try {
      const nextEnabled = !source.enabled;
      const res = await updateMyAiSource({ key: source.key, enabled: nextEnabled });
      if (res.success) {
        setAiSources((prev) => prev.map((s) => (s.key === source.key ? { ...s, enabled: nextEnabled } : s)));
        toast.success(nextEnabled ? '已开启' : '已关闭');
      } else {
        toast.error(res.error?.message || '更新失败');
      }
    } finally {
      setTogglingAiSourceKey(null);
    }
  };

  const handleAddExtensionSourceComingSoon = useCallback(() => {
    const now = Date.now();
    if (now - lastComingSoonNoticeAtRef.current < 1000) return;
    lastComingSoonNoticeAtRef.current = now;
    toast.info(
      '添加扩展源功能正在精细打磨中，敬请期待',
      '送你一束鲜花，感谢你的耐心支持'
    );
  }, []);

  const getSourceType = (type: string) => {
    return SOURCE_TYPES.find(s => s.value === type) || { value: type, label: type, icon: Link2, color: 'var(--text-muted)', bg: 'var(--bg-tertiary)', placeholder: '' };
  };

  return (
    <div className="flex flex-col gap-5">
      <GlassCard variant="subtle" className="px-5 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'rgba(59, 130, 246, 0.06)' }}>
              <Link2 size={16} style={{ color: 'rgba(59, 130, 246, 0.8)' }} />
            </div>
            <div>
              <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>我的数据源</h3>
              <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                已添加数据源会作为 AI 生成周报草稿的上下文
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => load()} disabled={loading}>
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> 刷新
            </Button>
          </div>
        </div>
      </GlassCard>

      <GlassCard variant="subtle" className="p-4">
        <div className="text-[12px] font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>
          已添加数据源
        </div>
        <div className="flex flex-col gap-3">
          {aiSources.map((source) => (
            <div
              key={source.key}
              className="rounded-xl p-4 flex items-start justify-between gap-3"
              style={{
                background: 'var(--surface-glass)',
                border: '1px solid var(--border-primary)',
              }}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Database size={14} style={{ color: 'var(--text-muted)' }} />
                  <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {source.name}
                  </span>
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded-full"
                    style={{
                      color: source.enabled ? 'rgba(34, 197, 94, 0.95)' : 'rgba(156, 163, 175, 0.95)',
                      background: source.enabled ? 'rgba(34, 197, 94, 0.12)' : 'rgba(156, 163, 175, 0.12)',
                    }}
                  >
                    {source.enabled ? '已开启' : '已关闭'}
                  </span>
                  {source.locked && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded-full"
                      style={{ color: 'var(--text-muted)', background: 'var(--bg-tertiary)' }}
                    >
                      默认开启
                    </span>
                  )}
                </div>
                <div className="text-[12px] mt-1 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  {source.description}
                </div>
              </div>
              <Button
                variant={source.enabled ? 'secondary' : 'primary'}
                size="sm"
                onClick={() => { void handleToggleAiSource(source); }}
                disabled={source.locked || togglingAiSourceKey === source.key}
                className="whitespace-nowrap"
              >
                {togglingAiSourceKey === source.key ? (
                  <><RefreshCw size={12} className="animate-spin" /> 更新中...</>
                ) : source.enabled ? (
                  <><Check size={12} /> 已开启</>
                ) : (
                  <><X size={12} /> 去开启</>
                )}
              </Button>
            </div>
          ))}
        </div>
      </GlassCard>

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

      <GlassCard variant="subtle" className="px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              扩展数据源（可选）
            </div>
            <div className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              可额外绑定 GitHub / 语雀来源用于数据采集与统计
            </div>
          </div>
          <Button variant="primary" size="sm" onClick={handleAddExtensionSourceComingSoon}>
            <Plus size={12} /> 添加扩展源
          </Button>
        </div>
      </GlassCard>

      {sources.length === 0 && !loading && (
        <div className="flex items-center justify-center" style={{ minHeight: 320 }}>
          <div className="flex flex-col items-center gap-5 text-center max-w-sm">
            <div className="w-20 h-20 rounded-2xl flex items-center justify-center" style={{ background: 'var(--bg-tertiary)' }}>
              <Link2 size={32} style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
            </div>
            <div>
              <div className="text-[15px] font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>暂无数据源</div>
              <div className="text-[13px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                绑定 GitHub 或语雀账号后，系统将自动采集你的代码提交和文档产出
              </div>
            </div>
            <div className="flex gap-3">
              {SOURCE_TYPES.map(stype => (
                <div
                  key={stype.value}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[12px]"
                  style={{ background: stype.bg, color: stype.color, border: `1px solid ${stype.color.replace('0.95', '0.42')}` }}
                >
                  <stype.icon size={13} /> {stype.label}
                </div>
              ))}
            </div>
            <Button variant="primary" onClick={handleAddExtensionSourceComingSoon}>
              <Plus size={14} /> 添加扩展源
            </Button>
          </div>
        </div>
      )}

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
                      {(source.config.repoUrl || source.config.spaceId) && (
                        <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                          {source.config.repoUrl || `语雀空间：${source.config.spaceId}`}
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

    </div>
  );
}
