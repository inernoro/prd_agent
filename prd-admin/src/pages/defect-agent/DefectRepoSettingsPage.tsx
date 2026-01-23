import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import type { DefectRepoConfig, CreateRepoConfigInput, GitHubAuthMethod } from '@/services/contracts/defectAgent';
import {
  listRepoConfigsReal,
  createRepoConfigReal,
  deleteRepoConfigReal,
} from '@/services/real/defectAgent';
import { ArrowLeft, Plus, Trash2, GitBranch } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

export function DefectRepoSettingsPage() {
  const navigate = useNavigate();
  const [configs, setConfigs] = useState<DefectRepoConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [repoOwner, setRepoOwner] = useState('');
  const [repoName, setRepoName] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [authMethod, setAuthMethod] = useState<GitHubAuthMethod>('PersonalAccessToken');
  const [saving, setSaving] = useState(false);

  const loadConfigs = async () => {
    setLoading(true);
    try {
      const res = await listRepoConfigsReal();
      if (res.success && res.data) {
        setConfigs(res.data.configs);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConfigs();
  }, []);

  const handleCreate = async () => {
    if (!repoOwner.trim() || !repoName.trim()) return;
    setSaving(true);
    try {
      const input: CreateRepoConfigInput = {
        repoOwner: repoOwner.trim(),
        repoName: repoName.trim(),
        defaultBranch: defaultBranch.trim() || 'main',
        authMethod,
      };
      const res = await createRepoConfigReal(input);
      if (res.success) {
        setShowForm(false);
        setRepoOwner('');
        setRepoName('');
        setDefaultBranch('main');
        await loadConfigs();
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const res = await deleteRepoConfigReal(id);
    if (res.success) {
      await loadConfigs();
    }
  };

  return (
    <div className="h-full flex flex-col p-4 gap-4 overflow-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate('/defect-agent')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <h1 className="text-lg font-semibold text-white/90">仓库配置</h1>
        <div className="flex-1" />
        <Button size="sm" onClick={() => setShowForm(true)}>
          <Plus className="w-4 h-4 mr-1" /> 添加仓库
        </Button>
      </div>

      {/* Add Form */}
      {showForm && (
        <GlassCard className="p-4 max-w-xl">
          <h3 className="text-sm font-medium text-white/70 mb-3">添加仓库配置</h3>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-white/40 mb-0.5">仓库 Owner *</label>
                <input
                  type="text"
                  className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white/90"
                  placeholder="org-name"
                  value={repoOwner}
                  onChange={(e) => setRepoOwner(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-white/40 mb-0.5">仓库名称 *</label>
                <input
                  type="text"
                  className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white/90"
                  placeholder="repo-name"
                  value={repoName}
                  onChange={(e) => setRepoName(e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-white/40 mb-0.5">默认分支</label>
                <input
                  type="text"
                  className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white/90"
                  value={defaultBranch}
                  onChange={(e) => setDefaultBranch(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-white/40 mb-0.5">授权方式</label>
                <select
                  className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white/90"
                  value={authMethod}
                  onChange={(e) => setAuthMethod(e.target.value as GitHubAuthMethod)}
                >
                  <option value="PersonalAccessToken">Personal Access Token</option>
                  <option value="GitHubApp">GitHub App</option>
                  <option value="OAuth">OAuth</option>
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>取消</Button>
              <Button size="sm" onClick={handleCreate} disabled={saving || !repoOwner.trim() || !repoName.trim()}>
                保存
              </Button>
            </div>
          </div>
        </GlassCard>
      )}

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center h-32 text-white/40 text-sm">加载中...</div>
      ) : configs.length === 0 ? (
        <div className="flex items-center justify-center h-32 text-white/40 text-sm">暂无仓库配置</div>
      ) : (
        <div className="space-y-2">
          {configs.map((c) => (
            <GlassCard key={c.id} className="p-4 flex items-center gap-3">
              <GitBranch className="w-5 h-5 text-white/30" />
              <div className="flex-1">
                <div className="text-sm text-white/90 font-mono">{c.repoOwner}/{c.repoName}</div>
                <div className="text-xs text-white/40 mt-0.5">
                  分支: {c.defaultBranch} | 授权: {c.authMethod} | {c.isActive ? '活跃' : '禁用'}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => handleDelete(c.id)}>
                <Trash2 className="w-3.5 h-3.5 text-red-400/60" />
              </Button>
            </GlassCard>
          ))}
        </div>
      )}
    </div>
  );
}
