import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { useDefectStore } from '@/stores/defectStore';
import { createDefectShareLink, getDefectShareLogs, previewApiLogs } from '@/services';
import { DefectStatus } from '@/services/contracts/defectAgent';
import { toast } from '@/lib/toast';
import { Copy, Link2, RefreshCw, FileSearch } from 'lucide-react';

export function DefectTransferDialog({ onClose }: { onClose: () => void }) {
  const defects = useDefectStore((s) => s.defects);
  const unresolved = useMemo(
    () => defects.filter((d) => ![DefectStatus.Closed, DefectStatus.Resolved].includes(d.status as never)),
    [defects]
  );

  const [selectedId, setSelectedId] = useState<string>(unresolved[0]?.id || '');
  const [creating, setCreating] = useState(false);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [logText, setLogText] = useState('');
  const [accessLogText, setAccessLogText] = useState('');
  const selected = unresolved.find((d) => d.id === selectedId);

  const buildTransferBrief = () => {
    if (!selected) return '';
    const sections = [
      `【缺陷】${selected.defectNo} ${selected.title || ''}`,
      `状态: ${selected.status}`,
      `内容:\n${selected.rawContent || '(空)'}`,
      shareUrl ? `外链(3天): ${shareUrl}` : '外链: （未生成）',
      logText ? `\n【相关 API 日志】\n${logText}` : '',
      accessLogText ? `\n【外链访问日志】\n${accessLogText}` : '',
      '\n请输出：\n1) 是否值得修复(可信度0-100)\n2) 修复清单(批量)\n3) 风险点\n4) 修复后验收要点',
    ].filter(Boolean);
    return sections.join('\n\n');
  };

  const handleCreateLink = async () => {
    if (!selected) return;
    setCreating(true);
    try {
      const res = await createDefectShareLink({ id: selected.id, expiresInDays: 3 });
      if (!res.success || !res.data) {
        toast.error(res.error?.message || '创建外链失败');
        return;
      }
      setShareUrl(res.data.url);
      await navigator.clipboard.writeText(res.data.url);
      toast.success('外链已生成并复制（3天有效）');
    } finally {
      setCreating(false);
    }
  };

  const handleLoadLogs = async () => {
    if (!selected) return;
    setLoadingLogs(true);
    try {
      const [apiLogRes, accessRes] = await Promise.all([
        previewApiLogs(),
        getDefectShareLogs({ id: selected.id, limit: 20 }),
      ]);

      if (apiLogRes.success && apiLogRes.data) {
        const lines = (apiLogRes.data.items || []).slice(0, 20).map((l) =>
          `${l.time} ${l.method} ${l.path} [${l.statusCode}] ${l.durationMs}ms ${l.hasError ? `ERR:${l.errorCode || '-'}` : 'OK'}`
        );
        setLogText(lines.join('\n'));
      }

      if (accessRes.success && accessRes.data) {
        const lines = (accessRes.data.items || []).map((l) =>
          `${new Date(l.accessedAt).toLocaleString()} ${l.result} ip=${l.ip || '-'} ua=${l.userAgent || '-'}`
        );
        setAccessLogText(lines.join('\n'));
      }

      toast.success('日志已获取，可一键填充');
    } catch {
      toast.error('获取日志失败');
    } finally {
      setLoadingLogs(false);
    }
  };

  const brief = buildTransferBrief();

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title="缺陷传输（外部协作）"
      maxWidth={860}
      contentStyle={{ maxHeight: '80vh' }}
      content={(
        <div className="space-y-3 overflow-y-auto">
          <GlassCard>
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2 items-center">
              <select
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                className="h-9 px-2 rounded-lg text-[13px] outline-none"
                style={{ background: 'var(--bg-input-hover)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
              >
                {unresolved.map((d) => (
                  <option key={d.id} value={d.id}>{d.defectNo} - {d.title || '(无标题)'}</option>
                ))}
              </select>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={handleLoadLogs} disabled={!selected || loadingLogs}>
                  {loadingLogs ? <RefreshCw size={14} className="animate-spin" /> : <FileSearch size={14} />} 获取日志
                </Button>
                <Button variant="primary" size="sm" onClick={handleCreateLink} disabled={!selected || creating}>
                  <Link2 size={14} /> {creating ? '生成中...' : '生成外链'}
                </Button>
              </div>
            </div>
            {shareUrl && (
              <div className="mt-2 text-[12px] flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                <span className="truncate">{shareUrl}</span>
                <Button variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(shareUrl)}>
                  <Copy size={12} />复制
                </Button>
              </div>
            )}
          </GlassCard>

          <GlassCard>
            <div className="text-[12px] mb-2" style={{ color: 'var(--text-muted)' }}>发送给外部 Agent 的建议内容（已包含缺陷+日志+访问监控）</div>
            <textarea
              value={brief}
              readOnly
              className="w-full min-h-[260px] px-3 py-2 rounded-lg text-[12px] outline-none"
              style={{ background: 'var(--bg-input-hover)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
            />
            <div className="mt-2 flex justify-end">
              <Button variant="secondary" size="sm" onClick={async () => { await navigator.clipboard.writeText(brief); toast.success('传输内容已复制'); }}>
                <Copy size={12} />复制传输内容
              </Button>
            </div>
          </GlassCard>
        </div>
      )}
    />
  );
}
