import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { Copy, Check, Link2 } from 'lucide-react';
import { createDefectShare } from '@/services';
import { useDefectStore } from '@/stores/defectStore';
import { toast } from '@/lib/toast';

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
  const [copied, setCopied] = useState(false);

  const handleGenerate = async () => {
    const ids =
      scope === 'single' && defectId ? [defectId] :
      scope === 'selected' && defectIds ? defectIds :
      undefined;

    if (scope === 'project' && !projectId) {
      toast.error('请选择项目');
      return;
    }

    setLoading(true);
    try {
      const res = await createDefectShare({
        shareScope: scope,
        defectIds: ids,
        projectId: scope === 'project' ? projectId : undefined,
        expiresInDays,
      });
      if (res.success && res.data) {
        const fullUrl = `${window.location.origin}${res.data.shareUrl}`;
        setShareUrl(fullUrl);
        navigator.clipboard.writeText(fullUrl).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        toast.error(res.error?.message || '创建分享失败');
      }
    } catch {
      toast.error('创建分享失败');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(shareUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleClose = () => {
    setShareUrl('');
    setCopied(false);
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

            <Button variant="primary" size="md" onClick={handleGenerate} disabled={loading} className="w-full">
              <Link2 size={14} />
              {loading ? '生成中...' : '生成分享链接'}
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

            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              将此链接发送给外部 AI Agent，Agent 可读取缺陷数据并提交修复分析报告。您将在收到报告时收到通知。
            </p>

            <Button variant="secondary" size="md" onClick={handleClose} className="w-full">
              关闭
            </Button>
          </div>
        )
      }
    />
  );
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
