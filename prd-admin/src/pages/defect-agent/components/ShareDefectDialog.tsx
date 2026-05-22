import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { Copy, Check, Link2, KeyRound } from 'lucide-react';
import { createAgentApiKey, createDefectShare } from '@/services';
import { useDefectStore } from '@/stores/defectStore';
import { toast } from '@/lib/toast';
import type { DefectAgentLaunch } from '@/services/contracts/defectAgent';

interface ShareDefectDialogProps {
  open: boolean;
  onClose: () => void;
  /** 单个缺陷分享时传入 */
  defectId?: string;
  /** 批量选择分享时传入 */
  defectIds?: string[];
}

export function ShareDefectDialog({ open, onClose, defectId, defectIds }: ShareDefectDialogProps) {
  const { projects } = useDefectStore();

  const [scope, setScope] = useState<'single' | 'project' | 'selected'>(
    defectId ? 'single' : defectIds?.length ? 'selected' : 'project'
  );
  const [projectId, setProjectId] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(3);
  const [loading, setLoading] = useState(false);

  // Step 2: result
  const [shareUrl, setShareUrl] = useState('');
  const [agentLaunch, setAgentLaunch] = useState<DefectAgentLaunch | null>(null);
  const [copied, setCopied] = useState(false);
  const [tempApiKey, setTempApiKey] = useState('');
  const [tempKeyExpiresAt, setTempKeyExpiresAt] = useState<string | null>(null);
  const [creatingKey, setCreatingKey] = useState(false);

  const createTempKeyForUrl = async (url: string) => {
    const res = await createAgentApiKey({
      name: `缺陷修复临时密钥 ${new Date().toLocaleString('zh-CN')}`,
      description: `缺陷分享临时访问：${url}`,
      scopes: ['defect-agent:fix'],
      ttlDays: 1,
    });
    if (!res.success || !res.data?.apiKey) {
      throw new Error(res.error?.message || '创建临时密钥失败');
    }
    return {
      key: res.data.apiKey,
      expiresAt: res.data.item.expiresAt ?? null,
    };
  };

  const handleGenerate = async (withTempKey = false) => {
    const ids =
      scope === 'single' && defectId ? [defectId] :
      scope === 'selected' && defectIds ? defectIds :
      undefined;

    if (scope === 'project' && !projectId) {
      toast.error('请选择项目');
      return;
    }

    setLoading(true);
    setCreatingKey(withTempKey);
    try {
      const res = await createDefectShare({
        shareScope: scope,
        defectIds: ids,
        projectId: scope === 'project' ? projectId : undefined,
        expiresInDays,
      });
      if (res.success && res.data) {
        const fullUrl = `${window.location.origin}${res.data.shareUrl}`;
        const launch = res.data.agentLaunch ?? null;
        setShareUrl(fullUrl);
        setAgentLaunch(launch);
        if (withTempKey) {
          const created = await createTempKeyForUrl(fullUrl);
          setTempApiKey(created.key);
          setTempKeyExpiresAt(created.expiresAt);
          navigator.clipboard.writeText(buildAgentPrompt(fullUrl, created.key, created.expiresAt, launch)).catch(() => {});
          toast.success('分享链接和临时密钥已创建');
        } else {
          navigator.clipboard.writeText(buildAgentPrompt(fullUrl, undefined, undefined, launch)).catch(() => {});
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        toast.error(res.error?.message || '创建分享失败');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建分享失败');
    } finally {
      setLoading(false);
      setCreatingKey(false);
    }
  };

  const handleCopy = () => {
    const prompt = buildAgentPrompt(shareUrl, tempApiKey || undefined, tempKeyExpiresAt, agentLaunch);
    navigator.clipboard.writeText(prompt).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCreateTempKey = async () => {
    if (!shareUrl || creatingKey) return;
    setCreatingKey(true);
    try {
      const created = await createTempKeyForUrl(shareUrl);
      const nextKey = created.key;
      const expiresAt = created.expiresAt;
      setTempApiKey(nextKey);
      setTempKeyExpiresAt(expiresAt);
      navigator.clipboard.writeText(buildAgentPrompt(shareUrl, nextKey, expiresAt, agentLaunch)).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success('临时密钥已创建');
    } catch {
      toast.error('创建临时密钥失败');
    } finally {
      setCreatingKey(false);
    }
  };

  const handleClose = () => {
    setShareUrl('');
    setAgentLaunch(null);
    setCopied(false);
    setTempApiKey('');
    setTempKeyExpiresAt(null);
    setCreatingKey(false);
    setLoading(false);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && handleClose()}
      title="分享缺陷给外部 Agent"
      content={
        !shareUrl ? (
          <div className="space-y-4 mt-2">
            {/* Scope */}
            <div>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--text-secondary)' }}>
                分享范围
              </label>
              <div className="flex gap-2">
                {defectId && (
                  <ScopeBtn active={scope === 'single'} onClick={() => setScope('single')}>
                    当前缺陷
                  </ScopeBtn>
                )}
                <ScopeBtn active={scope === 'project'} onClick={() => setScope('project')}>
                  按项目
                </ScopeBtn>
                {defectIds && defectIds.length > 0 && (
                  <ScopeBtn active={scope === 'selected'} onClick={() => setScope('selected')}>
                    已选 ({defectIds.length})
                  </ScopeBtn>
                )}
              </div>
            </div>

            {/* Project picker */}
            {scope === 'project' && (
              <div>
                <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--text-secondary)' }}>
                  选择项目
                </label>
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="w-full h-9 rounded-lg px-3 text-sm"
                  style={{
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    color: 'var(--text-primary)',
                  }}
                >
                  <option value="">请选择...</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Expiry */}
            <div>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--text-secondary)' }}>
                有效期
              </label>
              <div className="flex gap-2">
                {[1, 3, 7, 30].map((d) => (
                  <ScopeBtn key={d} active={expiresInDays === d} onClick={() => setExpiresInDays(d)}>
                    {d} 天
                  </ScopeBtn>
                ))}
              </div>
            </div>

            <Button variant="primary" size="md" onClick={() => handleGenerate(false)} disabled={loading} className="w-full">
              <Link2 size={14} />
              {loading ? '生成中...' : '生成分享链接'}
            </Button>

            <Button variant="secondary" size="md" onClick={() => handleGenerate(true)} disabled={loading} className="w-full">
              <KeyRound size={14} />
              {creatingKey ? '创建中...' : '生成分享链接并创建 1 天临时密钥'}
            </Button>
          </div>
        ) : (
          <div className="space-y-3 mt-2">
            <div
              className="flex items-center gap-2 p-3 rounded-lg"
              style={{ background: 'rgba(120, 220, 180, 0.1)', border: '1px solid rgba(120, 220, 180, 0.25)' }}
            >
              <Check size={16} style={{ color: 'rgba(120, 220, 180, 0.95)' }} />
              <span className="text-sm" style={{ color: 'rgba(120, 220, 180, 0.95)' }}>链接已生成并复制到剪贴板</span>
            </div>

            <div className="flex items-center gap-2">
              <input
                readOnly
                value={shareUrl}
                className="flex-1 h-9 rounded-lg px-3 text-sm"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: 'var(--text-primary)',
                }}
              />
              <Button variant="secondary" size="sm" onClick={handleCopy}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </Button>
            </div>

            <div className="rounded-lg p-3 text-xs" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-muted)' }}>
              <div>域名：{agentLaunch?.domain || window.location.origin}</div>
              <div>认证：{tempApiKey ? 'Authorization: Bearer <临时密钥>' : '未签发；打开分享链接后一键创建临时密钥'}</div>
              <div>范围：{agentLaunch?.scope.type || scope} {agentLaunch?.scope.defectCount ? `(${agentLaunch.scope.defectCount} 个缺陷)` : ''}</div>
              <div>技能：{agentLaunch?.skill.name || 'ai-defect-resolve'} &gt;= {agentLaunch?.skill.minVersion || '1.1.0'}</div>
            </div>

            <Button variant="secondary" size="md" onClick={handleCreateTempKey} disabled={creatingKey} className="w-full">
              <KeyRound size={14} />
              {creatingKey ? '创建中...' : '创建 1 天临时密钥并复制提示词'}
            </Button>

            {tempApiKey && (
              <div className="space-y-2">
                <label className="text-xs font-medium block" style={{ color: 'var(--text-secondary)' }}>
                  临时密钥
                </label>
                <input
                  readOnly
                  value={tempApiKey}
                  className="w-full h-9 rounded-lg px-3 text-xs font-mono"
                  style={{
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    color: 'var(--text-primary)',
                  }}
                />
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  明文密钥只显示一次，过期时间：{formatExpiry(tempKeyExpiresAt)}
                </p>
              </div>
            )}

            <Button variant="secondary" size="md" onClick={handleClose} className="w-full">
              关闭
            </Button>
          </div>
        )
      }
    />
  );
}

function buildAgentPrompt(viewUrl: string, accessKey?: string, expiresAt?: string | null, launch?: DefectAgentLaunch | null): string {
  const domain = launch?.domain || new URL(viewUrl).origin;
  const shareUrl = launch?.scope.shareUrl || new URL(viewUrl).pathname;
  const skillName = launch?.skill.name || 'ai-defect-resolve';
  const minVersion = launch?.skill.minVersion || '1.1.0';
  const downloadUrl = launch?.skill.downloadUrl || `${domain}/api/official-skills/${skillName}/download`;
  const scopeText = launch
    ? `${launch.scope.type}${launch.scope.defectIds?.length ? ` / ${launch.scope.defectIds.length} 个缺陷` : ''}${launch.scope.projectName ? ` / ${launch.scope.projectName}` : ''}`
    : '当前分享链接覆盖的缺陷';
  const authLine = accessKey ? `Authorization: Bearer ${accessKey}` : `未提供；不要猜测环境变量或复用旧 key`;
  return [
    `使用 ${skillName} 技能处理缺陷。`,
    ``,
    `参数：`,
    `- domain: ${domain}`,
    `- auth: ${authLine}`,
    `- scope: ${scopeText}`,
    `- shareUrl: ${shareUrl}`,
    ``,
    `技能：`,
    `- name: ${skillName}`,
    `- minVersion: ${minVersion}`,
    `- download: ${downloadUrl}`,
    `- priority: repo-builtin > user-installed > official-download > hosted-marketplace`,
    ``,
    `如果当前仓库已有内置 ${skillName} 技能，必须使用仓库内置版本，不能用托管/市场技能覆盖。`,
    `如果没有该技能，请从 download 地址安装后再执行。`,
    ``,
    accessKey
      ? `临时 key 过期时间：${formatExpiry(expiresAt)}`
      : `缺少认证时：先询问用户“你的 MAP/PrdAgent 主站是什么？”，或让用户打开 ${viewUrl}，点击“创建 1 天临时密钥并复制提示词”后再执行。`,
  ].filter((line): line is string => line !== null).join('\n');
}

function formatExpiry(value?: string | null) {
  if (!value) return '1 天后';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN');
}

function ScopeBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-8 px-3 rounded-lg text-xs font-medium transition-all"
      style={{
        background: active ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)',
        border: `1px solid ${active ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.08)'}`,
        color: active ? 'var(--text-primary)' : 'var(--text-muted)',
      }}
    >
      {children}
    </button>
  );
}
