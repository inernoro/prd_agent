import { useState, useEffect } from 'react';
import { Plus, Pencil, Trash2, Users, UserPlus } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import {
  createReportTeam,
  updateReportTeam,
  deleteReportTeam,
  addReportTeamMember,
  removeReportTeamMember,
  updateReportTeamMember,
} from '@/services';
import { ReportTeamRole } from '@/services/contracts/reportAgent';

const roleLabels: Record<string, string> = {
  [ReportTeamRole.Leader]: '负责人',
  [ReportTeamRole.Deputy]: '副负责人',
  [ReportTeamRole.Member]: '成员',
};

export function TeamManager() {
  const { teams, users, currentTeam, currentTeamMembers, loadTeams, loadTeamDetail, loadUsers } = useReportAgentStore();
  const [showTeamDialog, setShowTeamDialog] = useState(false);
  const [showMemberDialog, setShowMemberDialog] = useState(false);
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);

  // Team form
  const [teamName, setTeamName] = useState('');
  const [teamDesc, setTeamDesc] = useState('');
  const [leaderUserId, setLeaderUserId] = useState('');

  // Member form
  const [memberUserId, setMemberUserId] = useState('');
  const [memberRole, setMemberRole] = useState<string>(ReportTeamRole.Member);
  const [memberJobTitle, setMemberJobTitle] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    if (selectedTeamId) {
      void loadTeamDetail(selectedTeamId);
    }
  }, [selectedTeamId, loadTeamDetail]);

  const handleCreateTeam = () => {
    setEditingTeamId(null);
    setTeamName('');
    setTeamDesc('');
    setLeaderUserId('');
    setShowTeamDialog(true);
  };

  const handleEditTeam = (id: string) => {
    const t = teams.find((team) => team.id === id);
    if (!t) return;
    setEditingTeamId(id);
    setTeamName(t.name);
    setTeamDesc(t.description || '');
    setLeaderUserId(t.leaderUserId);
    setShowTeamDialog(true);
  };

  const handleSaveTeam = async () => {
    if (!teamName.trim()) { toast.error('请输入团队名称'); return; }
    if (!leaderUserId) { toast.error('请选择负责人'); return; }
    setSaving(true);
    const res = editingTeamId
      ? await updateReportTeam({ id: editingTeamId, name: teamName.trim(), leaderUserId, description: teamDesc.trim() || undefined })
      : await createReportTeam({ name: teamName.trim(), leaderUserId, description: teamDesc.trim() || undefined });
    setSaving(false);
    if (res.success) {
      toast.success(editingTeamId ? '团队已更新' : '团队已创建');
      setShowTeamDialog(false);
      void loadTeams();
    } else {
      toast.error(res.error?.message || '操作失败');
    }
  };

  const handleDeleteTeam = async (id: string) => {
    if (!window.confirm('确认删除该团队？')) return;
    const res = await deleteReportTeam({ id });
    if (res.success) {
      toast.success('团队已删除');
      if (selectedTeamId === id) setSelectedTeamId(null);
      void loadTeams();
    } else {
      toast.error(res.error?.message || '删除失败');
    }
  };

  const handleAddMember = () => {
    setMemberUserId('');
    setMemberRole(ReportTeamRole.Member);
    setMemberJobTitle('');
    setShowMemberDialog(true);
  };

  const handleSaveMember = async () => {
    if (!selectedTeamId || !memberUserId) { toast.error('请选择用户'); return; }
    setSaving(true);
    const res = await addReportTeamMember({
      teamId: selectedTeamId,
      userId: memberUserId,
      role: memberRole,
      jobTitle: memberJobTitle.trim() || undefined,
    });
    setSaving(false);
    if (res.success) {
      toast.success('成员已添加');
      setShowMemberDialog(false);
      void loadTeamDetail(selectedTeamId);
    } else {
      toast.error(res.error?.message || '操作失败');
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!selectedTeamId || !window.confirm('确认移除该成员？')) return;
    const res = await removeReportTeamMember({ teamId: selectedTeamId, userId });
    if (res.success) {
      toast.success('成员已移除');
      void loadTeamDetail(selectedTeamId);
    } else {
      toast.error(res.error?.message || '操作失败');
    }
  };

  const handleChangeMemberRole = async (userId: string, role: string) => {
    if (!selectedTeamId) return;
    const res = await updateReportTeamMember({ teamId: selectedTeamId, userId, role });
    if (res.success) {
      toast.success('角色已更新');
      void loadTeamDetail(selectedTeamId);
    } else {
      toast.error(res.error?.message || '操作失败');
    }
  };

  return (
    <div className="flex gap-4 h-full min-h-0">
      {/* Left: Team list */}
      <div className="w-[280px] flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>团队列表</div>
          <Button variant="primary" size="sm" onClick={handleCreateTeam}>
            <Plus size={12} />
          </Button>
        </div>
        <div className="flex flex-col gap-2">
          {teams.map((team) => (
            <GlassCard
              key={team.id}
              className={`p-3 cursor-pointer transition-opacity ${selectedTeamId === team.id ? 'ring-1' : ''}`}
              style={selectedTeamId === team.id ? { borderColor: 'var(--accent-primary)' } : undefined}
              onClick={() => setSelectedTeamId(team.id)}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{team.name}</div>
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>负责人: {team.leaderName}</div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleEditTeam(team.id); }}>
                    <Pencil size={10} />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleDeleteTeam(team.id); }}>
                    <Trash2 size={10} />
                  </Button>
                </div>
              </div>
            </GlassCard>
          ))}
        </div>
      </div>

      {/* Right: Team detail / members */}
      <div className="flex-1 min-h-0">
        {selectedTeamId && currentTeam ? (
          <GlassCard variant="subtle" className="h-full p-0 flex flex-col">
            <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border-primary)' }}>
              <div className="flex items-center gap-2">
                <Users size={14} style={{ color: 'var(--text-muted)' }} />
                <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  {currentTeam.name} · {currentTeamMembers.length} 人
                </span>
              </div>
              <Button variant="secondary" size="sm" onClick={handleAddMember}>
                <UserPlus size={12} /> 添加成员
              </Button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
              <div className="divide-y" style={{ borderColor: 'var(--border-primary)' }}>
                {currentTeamMembers.map((m) => (
                  <div key={m.id} className="flex items-center justify-between px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-medium"
                        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                        {(m.userName || '?')[0]}
                      </div>
                      <div>
                        <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                          {m.userName || m.userId}
                        </div>
                        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          {roleLabels[m.role] || m.role}
                          {m.jobTitle && ` · ${m.jobTitle}`}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        className="px-2 py-1 rounded text-[11px]"
                        style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                        value={m.role}
                        onChange={(e) => handleChangeMemberRole(m.userId, e.target.value)}
                      >
                        {Object.entries(roleLabels).map(([k, v]) => (
                          <option key={k} value={k}>{v}</option>
                        ))}
                      </select>
                      <Button variant="ghost" size="sm" onClick={() => handleRemoveMember(m.userId)}>
                        <Trash2 size={12} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </GlassCard>
        ) : (
          <GlassCard variant="subtle" className="h-full flex items-center justify-center">
            <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>选择一个团队查看详情</div>
          </GlassCard>
        )}
      </div>

      {/* Team Dialog */}
      {showTeamDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.3)' }}>
          <GlassCard className="p-0 w-[400px]">
            <div className="px-4 py-3 font-medium text-[14px]" style={{ color: 'var(--text-primary)', borderBottom: '1px solid var(--border-primary)' }}>
              {editingTeamId ? '编辑团队' : '新建团队'}
            </div>
            <div className="px-4 py-3 flex flex-col gap-3">
              <input
                className="w-full px-3 py-2 rounded-lg text-[13px]"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                placeholder="团队名称"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
              />
              <input
                className="w-full px-3 py-2 rounded-lg text-[13px]"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                placeholder="团队描述（可选）"
                value={teamDesc}
                onChange={(e) => setTeamDesc(e.target.value)}
              />
              <select
                className="w-full px-3 py-2 rounded-lg text-[13px]"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                value={leaderUserId}
                onChange={(e) => setLeaderUserId(e.target.value)}
              >
                <option value="">选择负责人</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.displayName || u.username}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3" style={{ borderTop: '1px solid var(--border-primary)' }}>
              <Button variant="secondary" size="sm" onClick={() => setShowTeamDialog(false)}>取消</Button>
              <Button variant="primary" size="sm" onClick={handleSaveTeam} disabled={saving}>
                {saving ? '保存中...' : '保存'}
              </Button>
            </div>
          </GlassCard>
        </div>
      )}

      {/* Member Dialog */}
      {showMemberDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.3)' }}>
          <GlassCard className="p-0 w-[400px]">
            <div className="px-4 py-3 font-medium text-[14px]" style={{ color: 'var(--text-primary)', borderBottom: '1px solid var(--border-primary)' }}>
              添加成员
            </div>
            <div className="px-4 py-3 flex flex-col gap-3">
              <select
                className="w-full px-3 py-2 rounded-lg text-[13px]"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                value={memberUserId}
                onChange={(e) => setMemberUserId(e.target.value)}
              >
                <option value="">选择用户</option>
                {users
                  .filter((u) => !currentTeamMembers.some((m) => m.userId === u.id))
                  .map((u) => (
                    <option key={u.id} value={u.id}>{u.displayName || u.username}</option>
                  ))}
              </select>
              <select
                className="w-full px-3 py-2 rounded-lg text-[13px]"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                value={memberRole}
                onChange={(e) => setMemberRole(e.target.value)}
              >
                {Object.entries(roleLabels).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <input
                className="w-full px-3 py-2 rounded-lg text-[13px]"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                placeholder="岗位名称（可选）"
                value={memberJobTitle}
                onChange={(e) => setMemberJobTitle(e.target.value)}
              />
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3" style={{ borderTop: '1px solid var(--border-primary)' }}>
              <Button variant="secondary" size="sm" onClick={() => setShowMemberDialog(false)}>取消</Button>
              <Button variant="primary" size="sm" onClick={handleSaveMember} disabled={saving}>
                {saving ? '添加中...' : '添加'}
              </Button>
            </div>
          </GlassCard>
        </div>
      )}
    </div>
  );
}
