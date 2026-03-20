import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import {
  getMyAiReportPrompt,
  resetMyAiReportPrompt,
  updateMyAiReportPrompt,
} from '@/services';

export function AiPromptSettingsPanel() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [systemDefaultPrompt, setSystemDefaultPrompt] = useState('');
  const [customPrompt, setCustomPrompt] = useState<string>('');
  const [draftPrompt, setDraftPrompt] = useState('');
  const [usingSystemDefault, setUsingSystemDefault] = useState(true);
  const [maxLen, setMaxLen] = useState(4000);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getMyAiReportPrompt();
    setLoading(false);
    if (!res.success || !res.data) {
      toast.error(res.error?.message || '加载 Prompt 失败');
      return;
    }
    setSystemDefaultPrompt(res.data.systemDefaultPrompt || '');
    setCustomPrompt(res.data.customPrompt || '');
    setDraftPrompt(res.data.customPrompt || '');
    setUsingSystemDefault(!!res.data.usingSystemDefault);
    setMaxLen(res.data.maxCustomPromptLength || 4000);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = useCallback(async () => {
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
    const res = await updateMyAiReportPrompt({ prompt: normalized });
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
    toast.success('已保存 AI 生成周报 Prompt');
  }, [draftPrompt, maxLen]);

  const handleReset = useCallback(async () => {
    const ok = await systemDialog.confirm({
      title: '确认恢复默认 Prompt？',
      message: '恢复后将使用系统默认 Prompt 进行 AI 周报生成。',
      confirmText: '恢复默认',
      cancelText: '取消',
    });
    if (!ok) return;

    setResetting(true);
    const res = await resetMyAiReportPrompt();
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
    toast.success('已恢复系统默认 Prompt');
  }, [maxLen]);

  if (loading) {
    return (
      <GlassCard className="p-4">
        <div className="text-[12px] flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
          <RefreshCw size={12} className="animate-spin" />
          加载 Prompt 配置中...
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
              AI生成周报Prompt
            </div>
            <div className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>
              AI 生成时会按“数据源 + 该 Prompt + 模板要求”组合生成草稿。你可以在系统默认基础上进行个性化调整。
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
      </GlassCard>

      <GlassCard className="p-4">
        <div className="text-[12px] font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
          系统默认 Prompt（只读）
        </div>
        <textarea
          value={systemDefaultPrompt}
          readOnly
          className="w-full min-h-[170px] px-3 py-2 rounded-xl text-[12px] leading-6 resize-y"
          style={{
            background: 'var(--bg-secondary)',
            color: 'var(--text-muted)',
            border: '1px solid var(--border-primary)',
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
          placeholder="请输入你的周报生成 Prompt..."
          className="w-full min-h-[210px] px-3 py-2 rounded-xl text-[12px] leading-6 resize-y transition-colors"
          style={{
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-primary)',
          }}
        />
        <div className="mt-2 flex items-center justify-between text-[11px]" style={{ color: 'var(--text-muted)' }}>
          <span>保存后会立即用于“AI生成周报草稿 / AI重新生成草稿”</span>
          <span style={{ color: currentLength > maxLen ? 'rgba(239,68,68,0.95)' : 'var(--text-muted)' }}>
            {currentLength}/{maxLen}
          </span>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Button variant="primary" size="sm" onClick={() => { void handleSave(); }} disabled={saving || resetting}>
            {saving ? <><RefreshCw size={12} className="animate-spin" /> 保存中...</> : <><Sparkles size={12} /> 保存自定义 Prompt</>}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => { void handleReset(); }} disabled={saving || resetting || (!customPrompt && usingSystemDefault)}>
            {resetting ? '恢复中...' : '恢复系统默认'}
          </Button>
        </div>
      </GlassCard>
    </div>
  );
}
