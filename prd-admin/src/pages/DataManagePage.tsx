import { Button } from '@/components/design/Button';
import { Card } from '@/components/design/Card';
import { ConfirmTip } from '@/components/ui/ConfirmTip';
import { Tooltip } from '@/components/ui/Tooltip';
import { getDataSummary, purgeData } from '@/services';
import type { DataSummaryResponse } from '@/services/contracts/data';
import { DataTransferDialog } from '@/pages/model-manage/DataTransferDialog';
import { Database, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

function safeIdempotencyKey() {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && 'randomUUID' in c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function fmtNum(n: number | null | undefined) {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v.toLocaleString() : '0';
}

export default function DataManagePage() {
  const [summary, setSummary] = useState<DataSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [transferOpen, setTransferOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await getDataSummary();
      if (!res.success) {
        setErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '加载失败'}`);
        return;
      }
      setSummary(res.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const domainCards = useMemo(() => {
    const s = summary;
    const llmLogs = s ? s.llmRequestLogs : 0;
    const sessionsMessages = s ? (s.messages + s.imageMasterSessions + s.imageMasterMessages) : 0;
    const docsKb = s ? (s.documents + s.attachments + s.contentGaps + s.prdComments) : 0;
    return [
      { key: 'llmLogs', title: '请求日志（LLM）', count: llmLogs, domains: ['llmLogs'] },
      { key: 'sessionsMessages', title: '会话/消息/对话记录', count: sessionsMessages, domains: ['sessionsMessages'] },
      { key: 'documents', title: '文档/解析/知识库类', count: docsKb, domains: ['documents'] },
    ] as Array<{ key: string; title: string; count: number; domains: string[] }>;
  }, [summary]);

  const doPurge = async (domains: string[]) => {
    setMsg(null);
    setErr(null);
    const idem = safeIdempotencyKey();
    const res = await purgeData({ domains }, idem);
    if (!res.success) {
      setErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '清理失败'}`);
      return;
    }
    setMsg(`已执行清理：${domains.join(', ')}（本次删除：llmLogs=${fmtNum(res.data.llmRequestLogs)} messages=${fmtNum(res.data.messages)} documents=${fmtNum(res.data.documents)}）`);
    await load();
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>数据管理</div>
          <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            配置迁移（导入/导出）与数据概览/清理，仅管理员可用
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
            <RefreshCw size={16} />
            刷新
          </Button>
          <Button variant="primary" size="sm" onClick={() => setTransferOpen(true)}>
            <Database size={16} />
            配置导入/导出
          </Button>
        </div>
      </div>

      {err && (
        <div className="rounded-[14px] px-4 py-3 text-sm" style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.20)', color: 'rgba(255,120,120,0.95)' }}>
          {err}
        </div>
      )}
      {msg && (
        <div className="rounded-[14px] px-4 py-3 text-sm" style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.20)', color: 'rgba(34,197,94,0.95)' }}>
          {msg}
        </div>
      )}

      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <Card className="p-4">
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>数据概览</div>
          <div className="mt-3 grid gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <div className="flex items-center justify-between"><span>LLM 请求日志</span><span style={{ color: 'var(--text-primary)' }}>{fmtNum(summary?.llmRequestLogs ?? 0)}</span></div>
            <div className="flex items-center justify-between"><span>消息</span><span style={{ color: 'var(--text-primary)' }}>{fmtNum(summary?.messages ?? 0)}</span></div>
            <div className="flex items-center justify-between"><span>ImageMaster 会话</span><span style={{ color: 'var(--text-primary)' }}>{fmtNum(summary?.imageMasterSessions ?? 0)}</span></div>
            <div className="flex items-center justify-between"><span>ImageMaster 消息</span><span style={{ color: 'var(--text-primary)' }}>{fmtNum(summary?.imageMasterMessages ?? 0)}</span></div>
            <div className="h-px my-2" style={{ background: 'rgba(255,255,255,0.10)' }} />
            <div className="flex items-center justify-between"><span>文档</span><span style={{ color: 'var(--text-primary)' }}>{fmtNum(summary?.documents ?? 0)}</span></div>
            <div className="flex items-center justify-between"><span>附件</span><span style={{ color: 'var(--text-primary)' }}>{fmtNum(summary?.attachments ?? 0)}</span></div>
            <div className="flex items-center justify-between"><span>内容缺口</span><span style={{ color: 'var(--text-primary)' }}>{fmtNum(summary?.contentGaps ?? 0)}</span></div>
            <div className="flex items-center justify-between"><span>PRD 评论</span><span style={{ color: 'var(--text-primary)' }}>{fmtNum(summary?.prdComments ?? 0)}</span></div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>一键清理</div>
          <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
            清理会直接删除 MongoDB 数据并清掉相关缓存。请谨慎操作。
          </div>

          <div className="mt-4 grid gap-3">
            {domainCards.map((it) => (
              <div key={it.key} className="rounded-[14px] p-3 flex items-center justify-between gap-3" style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.18)' }}>
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{it.title}</div>
                  <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>当前数量：{fmtNum(it.count)}</div>
                </div>

                <Tooltip content="该操作不可恢复" side="top" align="end">
                  <span className="inline-flex">
                    <ConfirmTip
                      title="确认清理？"
                      description={`将清空：${it.title}（不可恢复）`}
                      confirmText="确认清理"
                      onConfirm={async () => {
                        await doPurge(it.domains);
                      }}
                      disabled={loading}
                      side="top"
                      align="end"
                    >
                      <Button variant="danger" size="sm" disabled={loading}>
                        <Trash2 size={16} />
                        清空
                      </Button>
                    </ConfirmTip>
                  </span>
                </Tooltip>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <DataTransferDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        onImported={async () => {
          await load();
        }}
      />
    </div>
  );
}


