import { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2, RefreshCw, CheckCircle, XCircle, GitBranch } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import {
  listDataSources,
  createDataSource,
  updateDataSource,
  deleteDataSource,
  testDataSource,
  syncDataSource,
} from '@/services';
import type { ReportDataSource } from '@/services/contracts/reportAgent';

interface UserMappingEntry {
  gitAuthor: string;
  userId: string;
}

export function DataSourceManager() {
  const { teams, users, loadUsers } = useReportAgentStore();
  const [dataSources, setDataSources] = useState<ReportDataSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form state
  const [teamId, setTeamId] = useState(teams[0]?.id || '');
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [branchFilter, setBranchFilter] = useState('');
  const [pollInterval, setPollInterval] = useState(30);
  const [userMapping, setUserMapping] = useState<UserMappingEntry[]>([]);
  const [saving, setSaving] = useState(false);

  const [testingId, setTestingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  const loadDataSources = useCallback(async () => {
    setLoading(true);
    const res = await listDataSources();
    if (res.success && res.data) {
      setDataSources(res.data.items);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadDataSources();
    void loadUsers();
  }, [loadDataSources, loadUsers]);

  const resetForm = () => {
    setName('');
    setRepoUrl('');
    setAccessToken('');
    setBranchFilter('');
    setPollInterval(30);
    setUserMapping([]);
    setTeamId(teams[0]?.id || '');
    setEditingId(null);
  };

  const handleCreate = () => {
    resetForm();
    setShowDialog(true);
  };

  const handleEdit = (ds: ReportDataSource) => {
    setEditingId(ds.id);
    setName(ds.name);
    setRepoUrl(ds.repoUrl);
    setAccessToken(''); // never expose token
    setBranchFilter(ds.branchFilter || '');
    setPollInterval(ds.pollIntervalMinutes);
    setTeamId(ds.teamId);
    setUserMapping(
      Object.entries(ds.userMapping || {}).map(([gitAuthor, userId]) => ({
        gitAuthor,
        userId,
      }))
    );
    setShowDialog(true);
  };

  const handleSave = async () => {
    if (!name.trim()) { toast.error('请输入数据源名称'); return; }
    if (!repoUrl.trim()) { toast.error('请输入仓库地址'); return; }
    if (!teamId) { toast.error('请选择团队'); return; }

    const mappingObj: Record<string, string> = {};
    for (const entry of userMapping) {
      if (entry.gitAuthor.trim() && entry.userId.trim()) {
        mappingObj[entry.gitAuthor.trim()] = entry.userId.trim();
      }
    }

    setSaving(true);
    if (editingId) {
      const res = await updateDataSource({
        id: editingId,
        name: name.trim(),
        repoUrl: repoUrl.trim(),
        accessToken: accessToken || undefined,
        branchFilter: branchFilter.trim() || undefined,
        pollIntervalMinutes: pollInterval,
        userMapping: mappingObj,
      });
      setSaving(false);
      if (res.success) {
        toast.success('数据源已更新');
        setShowDialog(false);
        void loadDataSources();
      } else {
        toast.error(res.error?.message || '更新失败');
      }
    } else {
      const res = await createDataSource({
        teamId,
        name: name.trim(),
        repoUrl: repoUrl.trim(),
        accessToken: accessToken || undefined,
        branchFilter: branchFilter.trim() || undefined,
        pollIntervalMinutes: pollInterval,
        userMapping: mappingObj,
      });
      setSaving(false);
      if (res.success) {
        toast.success('数据源已创建');
        setShowDialog(false);
        void loadDataSources();
      } else {
        toast.error(res.error?.message || '创建失败');
      }
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('确认删除该数据源？')) return;
    const res = await deleteDataSource({ id });
    if (res.success) {
      toast.success('已删除');
      void loadDataSources();
    } else {
      toast.error(res.error?.message || '删除失败');
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    const res = await testDataSource({ id });
    setTestingId(null);
    if (res.success && res.data?.success) {
      toast.success('连接成功');
    } else {
      toast.error(res.data?.error || res.error?.message || '连接失败');
    }
  };

  const handleSync = async (id: string) => {
    setSyncingId(id);
    const res = await syncDataSource({ id });
    setSyncingId(null);
    if (res.success && res.data) {
      if (res.data.error) {
        toast.error(res.data.error);
      } else {
        toast.success(`同步完成，获取 ${res.data.syncedCommits} 条提交`);
      }
      void loadDataSources();
    } else {
      toast.error(res.error?.message || '同步失败');
    }
  };

  const addMappingEntry = () => {
    setUserMapping((prev) => [...prev, { gitAuthor: '', userId: '' }]);
  };

  const removeMappingEntry = (idx: number) => {
    setUserMapping((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateMappingEntry = (idx: number, field: keyof UserMappingEntry, value: string) => {
    setUserMapping((prev) => prev.map((e, i) => (i === idx ? { ...e, [field]: value } : e)));
  };

  if (loading) {
    return (
      <GlassCard className="p-8 text-center">
        <div className="text-[12px] flex items-center gap-2 justify-center" style={{ color: 'var(--text-muted)' }}>
          <RefreshCw size={12} className="animate-spin" /> 加载数据源...
        </div>
      </GlassCard>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
          共 {dataSources.length} 个数据源
        </div>
        <Button variant="primary" size="sm" onClick={handleCreate}>
          <Plus size={14} /> 添加数据源
        </Button>
      </div>

      {dataSources.length === 0 ? (
        <GlassCard variant="subtle" className="py-12 text-center">
          <GitBranch size={40} style={{ color: 'var(--text-muted)', opacity: 0.5, margin: '0 auto' }} />
          <div className="text-[13px] mt-3" style={{ color: 'var(--text-secondary)' }}>
            暂无数据源，请添加 Git 仓库
          </div>
        </GlassCard>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {dataSources.map((ds) => {
            const team = teams.find((t) => t.id === ds.teamId);
            return (
              <GlassCard key={ds.id} className="p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <GitBranch size={14} style={{ color: 'var(--text-muted)' }} />
                      <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                        {ds.name}
                      </span>
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded"
                        style={{
                          color: ds.enabled ? 'rgba(34, 197, 94, 0.9)' : 'rgba(156, 163, 175, 0.9)',
                          background: ds.enabled ? 'rgba(34, 197, 94, 0.1)' : 'rgba(156, 163, 175, 0.1)',
                        }}
                      >
                        {ds.enabled ? '启用' : '停用'}
                      </span>
                    </div>
                    <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                      {ds.repoUrl}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => handleEdit(ds)}>
                      <Pencil size={12} />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(ds.id)}>
                      <Trash2 size={12} />
                    </Button>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {team && <span>团队: {team.name}</span>}
                  <span>轮询: {ds.pollIntervalMinutes}min</span>
                  {ds.lastSyncAt && (
                    <span>上次同步: {new Date(ds.lastSyncAt).toLocaleString('zh-CN')}</span>
                  )}
                </div>
                {ds.lastSyncError && (
                  <div className="mt-2 flex items-center gap-1 text-[11px]" style={{ color: 'rgba(239, 68, 68, 0.9)' }}>
                    <XCircle size={12} /> {ds.lastSyncError}
                  </div>
                )}
                <div className="flex items-center gap-2 mt-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleTest(ds.id)}
                    disabled={testingId === ds.id}
                  >
                    {testingId === ds.id ? (
                      <><RefreshCw size={12} className="animate-spin" /> 测试中...</>
                    ) : (
                      <><CheckCircle size={12} /> 测试连接</>
                    )}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleSync(ds.id)}
                    disabled={syncingId === ds.id}
                  >
                    {syncingId === ds.id ? (
                      <><RefreshCw size={12} className="animate-spin" /> 同步中...</>
                    ) : (
                      <><RefreshCw size={12} /> 手动同步</>
                    )}
                  </Button>
                </div>
              </GlassCard>
            );
          })}
        </div>
      )}

      {/* Create/Edit Dialog */}
      {showDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.3)' }}>
          <GlassCard className="p-0 w-[560px] max-h-[80vh] flex flex-col">
            <div className="px-4 py-3 font-medium text-[14px]" style={{ color: 'var(--text-primary)', borderBottom: '1px solid var(--border-primary)' }}>
              {editingId ? '编辑数据源' : '添加数据源'}
            </div>
            <div className="flex-1 min-h-0 overflow-auto px-4 py-3 flex flex-col gap-3">
              <div>
                <label className="text-[12px] font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>名称</label>
                <input
                  className="w-full px-3 py-2 rounded-lg text-[13px]"
                  style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                  placeholder="例如: 前端仓库"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              {!editingId && (
                <div>
                  <label className="text-[12px] font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>团队</label>
                  <select
                    className="w-full px-3 py-2 rounded-lg text-[13px]"
                    style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                    value={teamId}
                    onChange={(e) => setTeamId(e.target.value)}
                  >
                    <option value="">请选择团队</option>
                    {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="text-[12px] font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>仓库地址</label>
                <input
                  className="w-full px-3 py-2 rounded-lg text-[13px]"
                  style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                  placeholder="https://github.com/owner/repo"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                />
              </div>
              <div>
                <label className="text-[12px] font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>
                  Access Token {editingId && <span className="text-[10px] font-normal">(留空保持不变)</span>}
                </label>
                <input
                  type="password"
                  className="w-full px-3 py-2 rounded-lg text-[13px]"
                  style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                  placeholder="ghp_xxxx"
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="text-[12px] font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>分支过滤（可选）</label>
                  <input
                    className="w-full px-3 py-2 rounded-lg text-[13px]"
                    style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                    placeholder="main,develop"
                    value={branchFilter}
                    onChange={(e) => setBranchFilter(e.target.value)}
                  />
                </div>
                <div className="w-32">
                  <label className="text-[12px] font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>轮询间隔</label>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      className="w-full px-3 py-2 rounded-lg text-[13px]"
                      style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                      value={pollInterval}
                      min={5}
                      onChange={(e) => setPollInterval(Number(e.target.value))}
                    />
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>min</span>
                  </div>
                </div>
              </div>

              {/* User Mapping */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>用户映射</label>
                  <Button variant="ghost" size="sm" onClick={addMappingEntry}>
                    <Plus size={12} /> 添加映射
                  </Button>
                </div>
                <div className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>
                  将 Git 提交者邮箱映射到系统用户，用于自动归属周报条目
                </div>
                {userMapping.map((entry, idx) => (
                  <div key={idx} className="flex items-center gap-2 mb-2">
                    <input
                      className="flex-1 px-2 py-1.5 rounded text-[12px]"
                      style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                      placeholder="Git 邮箱/用户名"
                      value={entry.gitAuthor}
                      onChange={(e) => updateMappingEntry(idx, 'gitAuthor', e.target.value)}
                    />
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>→</span>
                    <select
                      className="flex-1 px-2 py-1.5 rounded text-[12px]"
                      style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                      value={entry.userId}
                      onChange={(e) => updateMappingEntry(idx, 'userId', e.target.value)}
                    >
                      <option value="">选择用户</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>{u.displayName || u.username}</option>
                      ))}
                    </select>
                    <Button variant="ghost" size="sm" onClick={() => removeMappingEntry(idx)}>
                      <Trash2 size={12} />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3" style={{ borderTop: '1px solid var(--border-primary)' }}>
              <Button variant="secondary" size="sm" onClick={() => setShowDialog(false)}>取消</Button>
              <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
                {saving ? '保存中...' : '保存'}
              </Button>
            </div>
          </GlassCard>
        </div>
      )}
    </div>
  );
}
