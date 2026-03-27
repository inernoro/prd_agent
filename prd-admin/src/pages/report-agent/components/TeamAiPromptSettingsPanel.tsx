import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import {
  getTeamAiSummaryPrompt,
  listReportTeams,
  resetTeamAiSummaryPrompt,
  updateTeamAiSummaryPrompt,
} from '@/services';
import { ReportTeamRole } from '@/services/contracts/reportAgent';
import type { ReportTeam } from '@/services/contracts/reportAgent';

function pickManageableTeams(items: ReportTeam[]): ReportTeam[] {
  // 仅展示当前用户是负责人或副负责人的团队，普通成员不应出现在此列表
  return items.filter(
    (team) => team.myRole === ReportTeamRole.Leader || team.myRole === ReportTeamRole.Deputy
  );
}

export function TeamAiPromptSettingsPanel() {
  const [loadingTeams, setLoadingTeams] = useState(true);
  const [teams, setTeams] = useState<ReportTeam[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [forbidden, setForbidden] = useState(false);

  const [loadingPrompt, setLoadingPrompt] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [systemDefaultPrompt, setSystemDefaultPrompt] = useState('');
  const [customPrompt, setCustomPrompt] = useState<string>('');
  const [draftPrompt, setDraftPrompt] = useState('');
  const [usingSystemDefault, setUsingSystemDefault] = useState(true);
  const [maxLen, setMaxLen] = useState(4000);

  const selectedTeam = useMemo(
    () => teams.find((team) => team.id === selectedTeamId) ?? null,
    [selectedTeamId, teams]
  );

  const loadTeams = useCallback(async () => {
    setLoadingTeams(true);
    setForbidden(false);
    const res = await listReportTeams();
    setLoadingTeams(false);
    if (!res.success || !res.data) {
      toast.error(res.error?.message || '加载团队列表失败');
      return;
    }

    const items = pickManageableTeams(res.data.items ?? []);
    setTeams(items);
    setSelectedTeamId((prev) => {
      if (prev && items.some((team) => team.id === prev)) return prev;
      return items[0]?.id ?? '';
    });
  }, []);

  const loadPrompt = useCallback(async (teamId: string) => {
    if (!teamId) return;
    setLoadingPrompt(true);
    const res = await getTeamAiSummaryPrompt({ teamId });
    setLoadingPrompt(false);
    if (!res.success || !res.data) {
      if (res.error?.code === 'PERMISSION_DENIED') {
        setForbidden(true);
        setTeams([]);
        setSelectedTeamId('');
        return;
      }
      toast.error(res.error?.message || '加载团队 Prompt 失败');
      return;
    }
    setForbidden(false);
    setSystemDefaultPrompt(res.data.systemDefaultPrompt || '');
    setCustomPrompt(res.data.customPrompt || '');
    setDraftPrompt(res.data.customPrompt || '');
    setUsingSystemDefault(!!res.data.usingSystemDefault);
    setMaxLen(res.data.maxCustomPromptLength || 4000);
  }, []);

  useEffect(() => {
    void loadTeams();
  }, [loadTeams]);

  useEffect(() => {
    if (!selectedTeamId) return;
    void loadPrompt(selectedTeamId);
  }, [loadPrompt, selectedTeamId]);

  const handleSave = useCallback(async () => {
    if (!selectedTeamId) {
      toast.error('请先选择团队');
      return;
    }

    const normalized = draftPrompt.trim();
    if (!normalized) {
      toast.error('请先输入自定义 Prompt');
      return;
    }
    if (normalized.length > maxLen) {
      toast.error(`Prompt 不能超过 ${maxLen} 字符`);
      return;
    }

    setSaving(true);
    const res = await updateTeamAiSummaryPrompt({ teamId: selectedTeamId, prompt: normalized });
    setSaving(false);
    if (!res.success || !res.data) {
      toast.error(res.error?.message || '保存失败');
      return;
    }

    setSystemDefaultPrompt(res.data.systemDefaultPrompt || '');
    setCustomPrompt(res.data.customPrompt || '');
    setDraftPrompt(res.data.customPrompt || '');
    setUsingSystemDefault(!!res.data.usingSystemDefault);
    setMaxLen(res.data.maxCustomPromptLength || maxLen);
    toast.success('已保存团队 AI 分析 Prompt');
  }, [draftPrompt, maxLen, selectedTeamId]);

  const handleReset = useCallback(async () => {
    if (!selectedTeamId) {
      toast.error('请先选择团队');
      return;
    }

    const ok = await systemDialog.confirm({
      title: '确认恢复默认 Prompt？',
      message: `恢复后「${selectedTeam?.name || '当前团队'}」将使用系统默认 Prompt 进行团队周报AI分析。`,
      confirmText: '恢复默认',
      cancelText: '取消',
    });
    if (!ok) return;

    setResetting(true);
    const res = await resetTeamAiSummaryPrompt({ teamId: selectedTeamId });
    setResetting(false);
    if (!res.success || !res.data) {
      toast.error(res.error?.message || '恢复默认失败');
      return;
    }

    setSystemDefaultPrompt(res.data.systemDefaultPrompt || '');
    setCustomPrompt(res.data.customPrompt || '');
    setDraftPrompt(res.data.customPrompt || '');
    setUsingSystemDefault(!!res.data.usingSystemDefault);
    setMaxLen(res.data.maxCustomPromptLength || maxLen);
    toast.success('已恢复团队系统默认 Prompt');
  }, [maxLen, selectedTeam?.name, selectedTeamId]);

  if (loadingTeams) {
    return (
      <GlassCard className="p-4">
        <div className="text-[12px] flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
          <RefreshCw size={12} className="animate-spin" />
          加载团队配置中...
        </div>
      </GlassCard>
    );
  }

  if (!selectedTeamId || teams.length === 0) {
    return (
      <GlassCard className="p-4">
        <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
          {forbidden
            ? '你没有团队周报AI分析 Prompt 的管理权限。'
            : '暂无可管理团队，暂不能配置“团队周报AI分析Prompt”。'}
        </div>
      </GlassCard>
    );
  }

  if (loadingPrompt) {
    return (
      <GlassCard className="p-4">
        <div className="text-[12px] flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
          <RefreshCw size={12} className="animate-spin" />
          加载团队 Prompt 配置中...
        </div>
      </GlassCard>
    );
  }

  const currentLength = draftPrompt.trim().length;

  return (
    <div className="flex flex-col gap-4">
      <GlassCard className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              团队周报AI分析Prompt
            </div>
            <div className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>
              团队周报 AI 分析时会按“团队已提交周报 + 该 Prompt”生成管理汇总。你可以基于系统默认进行团队级定制。
            </div>
          </div>
          <span
            className="text-[11px] px-2 py-1 rounded-full"
            style={{
              color: usingSystemDefault ? 'rgba(59,130,246,0.95)' : 'rgba(168,85,247,0.95)',
              background: usingSystemDefault ? 'rgba(59,130,246,0.12)' : 'rgba(168,85,247,0.12)',
              border: `1px solid ${usingSystemDefault ? 'rgba(59,130,246,0.28)' : 'rgba(168,85,247,0.28)'}`,
            }}
          >
            {usingSystemDefault ? '当前使用系统默认' : '当前使用自定义 Prompt'}
          </span>
        </div>

        <div className="mt-3">
          <div className="text-[11px] mb-1.5" style={{ color: 'var(--text-muted)' }}>
            选择团队
          </div>
          <select
            value={selectedTeamId}
            onChange={(e) => setSelectedTeamId(e.target.value)}
            className="w-full px-3 py-2 rounded-xl text-[12px]"
            style={{
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-primary)',
            }}
          >
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </div>
      </GlassCard>

      <GlassCard className="p-4">
        <div className="text-[12px] font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
          系统默认 Prompt（只读）
        </div>
        <textarea
          value={systemDefaultPrompt}
          readOnly
          rows={14}
          className="w-full px-3 py-2 rounded-xl text-[12px] leading-6 resize-y"
          style={{
            background: 'var(--bg-secondary)',
            color: 'var(--text-muted)',
            border: '1px solid var(--border-primary)',
            minHeight: 360,
          }}
        />
      </GlassCard>

      <GlassCard className="p-4">
        <div className="text-[12px] font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
          自定义 Prompt（可编辑）
        </div>
        <textarea
          value={draftPrompt}
          onChange={(e) => setDraftPrompt(e.target.value)}
          placeholder="请输入团队周报AI分析 Prompt..."
          rows={12}
          className="w-full px-3 py-2 rounded-xl text-[12px] leading-6 resize-y transition-colors"
          style={{
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-primary)',
            minHeight: 300,
          }}
        />
        <div className="mt-2 flex items-center justify-between text-[11px]" style={{ color: 'var(--text-muted)' }}>
          <span>保存后会立即用于“团队周报AI分析”的生成汇总与重新生成</span>
          <span style={{ color: currentLength > maxLen ? 'rgba(239,68,68,0.95)' : 'var(--text-muted)' }}>
            {currentLength}/{maxLen}
          </span>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Button variant="primary" size="sm" onClick={() => { void handleSave(); }} disabled={saving || resetting}>
            {saving ? <><RefreshCw size={12} className="animate-spin" /> 保存中...</> : <><Sparkles size={12} /> 保存团队自定义 Prompt</>}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => { void handleReset(); }}
            disabled={saving || resetting || (!customPrompt && usingSystemDefault)}
          >
            {resetting ? '恢复中...' : '恢复系统默认'}
          </Button>
        </div>
      </GlassCard>
    </div>
  );
}
