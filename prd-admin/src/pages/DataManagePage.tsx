import { Button } from '@/components/design/Button';
import { Card } from '@/components/design/Card';
import { Badge } from '@/components/design/Badge';
import { PageHeader } from '@/components/design/PageHeader';
import { Dialog } from '@/components/ui/Dialog';
import { ConfirmTip } from '@/components/ui/ConfirmTip';
import { Tooltip } from '@/components/ui/Tooltip';
import { getDataSummary, previewUsersPurge, purgeData, purgeUsers } from '@/services';
import type { AdminUserPreviewItem, AdminUsersPurgePreviewResponse, DataSummaryResponse } from '@/services/contracts/data';
import { DataTransferDialog } from '@/pages/model-manage/DataTransferDialog';
import {
  AlertTriangle,
  Database,
  FileText,
  HardDrive,
  MessageSquare,
  RefreshCw,
  Server,
  Trash2,
  Users,
  Zap,
} from 'lucide-react';
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

function fmtDate(s: string | null | undefined) {
  if (!s) return '-';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 统计卡片组件
function StatCard({
  icon,
  label,
  value,
  subValue,
  accent = 'default',
  loading,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  subValue?: string;
  accent?: 'default' | 'gold' | 'blue' | 'green' | 'purple';
  loading?: boolean;
}) {
  const accentColors = {
    default: 'rgba(255,255,255,0.08)',
    gold: 'rgba(250,204,21,0.12)',
    blue: 'rgba(59,130,246,0.12)',
    green: 'rgba(34,197,94,0.12)',
    purple: 'rgba(168,85,247,0.12)',
  };

  const iconColors = {
    default: 'rgba(255,255,255,0.65)',
    gold: 'rgba(250,204,21,0.95)',
    blue: 'rgba(59,130,246,0.95)',
    green: 'rgba(34,197,94,0.95)',
    purple: 'rgba(168,85,247,0.95)',
  };

  return (
    <div
      className="relative overflow-hidden rounded-[16px] p-4 transition-all duration-200 hover:scale-[1.02]"
      style={{
        background: `linear-gradient(135deg, ${accentColors[accent]} 0%, rgba(0,0,0,0.20) 100%)`,
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 4px 20px -4px rgba(0,0,0,0.3)',
      }}
    >
      {/* 装饰性光晕 */}
      <div
        className="absolute -top-8 -right-8 w-24 h-24 rounded-full opacity-30 blur-2xl"
        style={{ background: accentColors[accent] }}
      />

      <div className="relative flex items-start gap-3">
        <div
          className="shrink-0 w-10 h-10 rounded-[12px] flex items-center justify-center"
          style={{
            background: accentColors[accent],
            border: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <span style={{ color: iconColors[accent] }}>{icon}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium truncate" style={{ color: 'var(--text-muted)' }}>
            {label}
          </div>
          <div
            className="mt-1 text-2xl font-bold tabular-nums tracking-tight"
            style={{ color: 'var(--text-primary)', letterSpacing: '-0.02em' }}
          >
            {loading ? (
              <span className="inline-block w-16 h-7 rounded-md animate-pulse" style={{ background: 'rgba(255,255,255,0.06)' }} />
            ) : (
              value
            )}
          </div>
          {subValue && (
            <div className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
              {subValue}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// 数据域卡片组件
function DomainCard({
  icon,
  title,
  description,
  items,
  total,
  domains,
  loading,
  onPurge,
  purging,
  accent = 'default',
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  items: Array<{ label: string; value: number }>;
  total: number;
  domains: string[];
  loading?: boolean;
  onPurge: (domains: string[]) => Promise<void>;
  purging?: boolean;
  accent?: 'default' | 'blue' | 'green' | 'purple';
}) {
  const accentColors = {
    default: { bg: 'rgba(255,255,255,0.06)', border: 'rgba(255,255,255,0.12)', icon: 'rgba(255,255,255,0.75)' },
    blue: { bg: 'rgba(59,130,246,0.15)', border: 'rgba(59,130,246,0.30)', icon: 'rgba(59,130,246,0.95)' },
    green: { bg: 'rgba(34,197,94,0.15)', border: 'rgba(34,197,94,0.30)', icon: 'rgba(34,197,94,0.95)' },
    purple: { bg: 'rgba(168,85,247,0.15)', border: 'rgba(168,85,247,0.30)', icon: 'rgba(168,85,247,0.95)' },
  };

  const colors = accentColors[accent];

  return (
    <div
      className="rounded-[18px] overflow-hidden transition-all duration-200"
      style={{
        backgroundColor: 'var(--bg-elevated)',
        backgroundImage: 'linear-gradient(180deg, rgba(30,30,35,0.98) 0%, rgba(18,18,22,0.99) 100%)',
        border: '1px solid rgba(255,255,255,0.10)',
        boxShadow: '0 8px 32px -8px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.02) inset',
      }}
    >
      {/* 头部 */}
      <div
        className="px-5 py-4 flex items-center justify-between gap-4"
        style={{
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          background: 'linear-gradient(180deg, rgba(255,255,255,0.03) 0%, transparent 100%)',
        }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="shrink-0 w-10 h-10 rounded-[12px] flex items-center justify-center"
            style={{
              background: colors.bg,
              border: `1px solid ${colors.border}`,
              boxShadow: `0 4px 12px -4px ${colors.bg}`,
            }}
          >
            <span style={{ color: colors.icon }}>{icon}</span>
          </div>
          <div className="min-w-0">
            <div className="text-sm font-bold truncate" style={{ color: 'var(--text-primary)' }}>
              {title}
            </div>
            <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
              {description}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge size="sm" variant="subtle">
            {loading ? '-' : fmtNum(total)}
          </Badge>
        </div>
      </div>

      {/* 数据列表 */}
      <div className="px-5 py-4">
        <div className="space-y-3">
          {items.map((item) => (
            <div
              key={item.label}
              className="flex items-center justify-between gap-3 px-3 py-2 rounded-[10px]"
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.05)',
              }}
            >
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {item.label}
              </span>
              <span className="text-sm font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>
                {loading ? '-' : fmtNum(item.value)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* 底部操作 */}
      <div
        className="px-5 py-3 flex items-center justify-end"
        style={{
          borderTop: '1px solid rgba(255,255,255,0.08)',
          background: 'rgba(0,0,0,0.20)',
        }}
      >
        <ConfirmTip
          title="确认清理？"
          description={`将清空：${title}（不可恢复）`}
          confirmText="确认清理"
          onConfirm={async () => {
            await onPurge(domains);
          }}
          disabled={loading || purging}
          side="top"
          align="end"
        >
          <Button variant="danger" size="xs" disabled={loading || purging || total === 0}>
            <Trash2 size={14} />
            清空数据
          </Button>
        </ConfirmTip>
      </div>
    </div>
  );
}

// 危险操作卡片组件
function DangerActionCard({
  title,
  description,
  buttonText,
  onAction,
  loading,
  confirmTitle,
  confirmDescription,
}: {
  title: string;
  description: string;
  buttonText: string;
  onAction: () => void | Promise<void>;
  loading?: boolean;
  confirmTitle?: string;
  confirmDescription?: string;
}) {
  const needsConfirm = confirmTitle && confirmDescription;

  return (
    <div
      className="rounded-[14px] p-4 transition-all duration-200"
      style={{
        background: 'linear-gradient(135deg, rgba(239,68,68,0.06) 0%, rgba(0,0,0,0.15) 100%)',
        border: '1px solid rgba(239,68,68,0.15)',
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="shrink-0 w-8 h-8 rounded-[8px] flex items-center justify-center mt-0.5"
          style={{
            background: 'rgba(239,68,68,0.12)',
            border: '1px solid rgba(239,68,68,0.20)',
          }}
        >
          <AlertTriangle size={16} style={{ color: 'rgba(239,68,68,0.85)' }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {title}
          </div>
          <div className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {description}
          </div>
        </div>
        <div className="shrink-0 ml-2">
          {needsConfirm ? (
            <ConfirmTip
              title={confirmTitle}
              description={confirmDescription}
              confirmText={buttonText}
              onConfirm={async () => {
                await onAction();
              }}
              disabled={loading}
              side="top"
              align="end"
            >
              <Button variant="danger" size="xs" disabled={loading}>
                <Trash2 size={14} />
                {buttonText}
              </Button>
            </ConfirmTip>
          ) : (
            <Tooltip content="该操作不可恢复" side="top" align="end">
              <span>
                <Button variant="danger" size="xs" disabled={loading} onClick={() => void onAction()}>
                  <Trash2 size={14} />
                  {buttonText}
                </Button>
              </span>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

export default function DataManagePage() {
  const [summary, setSummary] = useState<DataSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [transferOpen, setTransferOpen] = useState(false);

  const [usersPurgeOpen, setUsersPurgeOpen] = useState(false);
  const [usersPurgeStep, setUsersPurgeStep] = useState<1 | 2>(1);
  const [usersPreviewLoading, setUsersPreviewLoading] = useState(false);
  const [usersPreview, setUsersPreview] = useState<AdminUsersPurgePreviewResponse | null>(null);
  const [usersConfirmText, setUsersConfirmText] = useState('');

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

  // 计算总数据量
  const totalRecords = useMemo(() => {
    if (!summary) return 0;
    return (
      (summary.llmRequestLogs ?? 0) +
      (summary.messages ?? 0) +
      (summary.imageMasterSessions ?? 0) +
      (summary.imageMasterMessages ?? 0) +
      (summary.documents ?? 0) +
      (summary.attachments ?? 0) +
      (summary.contentGaps ?? 0) +
      (summary.prdComments ?? 0)
    );
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

    const isDevReset = domains.some((d) => d.toLowerCase().includes('devreset') || d.toLowerCase().includes('resetkeepmodels'));

    if (isDevReset) {
      setMsg(`清理完成：开发重置（删除集合：${res.data.otherDeleted ?? 0}个，日志：${fmtNum(res.data.llmRequestLogs)}，消息：${fmtNum(res.data.messages)}，文档：${fmtNum(res.data.documents)}）`);
    } else {
      setMsg(`清理完成：${domains.join(', ')}（日志：${fmtNum(res.data.llmRequestLogs)}，消息：${fmtNum(res.data.messages)}，文档：${fmtNum(res.data.documents)}）`);
    }

    await load();
  };

  const openUsersPurge = async () => {
    setUsersPurgeOpen(true);
    setUsersPurgeStep(1);
    setUsersConfirmText('');
    setUsersPreview(null);

    setUsersPreviewLoading(true);
    try {
      const res = await previewUsersPurge(20);
      if (!res.success) {
        setErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '加载预览失败'}`);
        return;
      }
      setUsersPreview(res.data);
    } finally {
      setUsersPreviewLoading(false);
    }
  };

  const doPurgeUsers = async () => {
    setMsg(null);
    setErr(null);
    const idem = safeIdempotencyKey();
    const res = await purgeUsers({ confirmed: true }, idem);
    if (!res.success) {
      setErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '清理失败'}`);
      return;
    }
    setMsg(`用户清理完成：删除用户 ${fmtNum(res.data.usersDeleted)} 个，群组成员 ${fmtNum(res.data.groupMembersDeleted)} 条`);
    setUsersPurgeOpen(false);
    await load();
  };

  const UserRow = ({ u }: { u: AdminUserPreviewItem }) => {
    return (
      <div
        className="grid gap-2 rounded-[10px] px-3 py-2.5 transition-colors hover:bg-white/3"
        style={{
          gridTemplateColumns: '1.2fr 1fr 0.6fr 0.6fr 1fr',
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.05)',
        }}
      >
        <div className="min-w-0">
          <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
            {u.username || '-'}
          </div>
          <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
            {u.displayName || '-'}
          </div>
        </div>
        <div className="min-w-0 text-xs font-mono self-center truncate" style={{ color: 'var(--text-secondary)' }}>
          {u.userId?.slice(0, 8) || '-'}...
        </div>
        <div className="text-xs self-center" style={{ color: 'var(--text-secondary)' }}>
          {u.role}
        </div>
        <div className="text-xs self-center" style={{ color: 'var(--text-secondary)' }}>
          {u.status}
        </div>
        <div className="text-xs self-center" style={{ color: 'var(--text-muted)' }}>
          {fmtDate(u.createdAt)}
        </div>
      </div>
    );
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-5 overflow-x-hidden">
      {/* 页面头部 */}
      <PageHeader
        title="数据管理"
        description="数据概览、清理与配置迁移，仅管理员可用"
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              刷新
            </Button>
            <Button variant="primary" size="sm" onClick={() => setTransferOpen(true)}>
              <Database size={16} />
              配置导入/导出
            </Button>
          </>
        }
      />

      {/* 消息提示 */}
      {err && (
        <div
          className="rounded-[12px] px-4 py-3 text-sm flex items-center gap-3"
          style={{
            background: 'linear-gradient(135deg, rgba(239,68,68,0.12) 0%, rgba(239,68,68,0.06) 100%)',
            border: '1px solid rgba(239,68,68,0.25)',
            color: 'rgba(239,68,68,0.95)',
          }}
        >
          <AlertTriangle size={16} />
          {err}
        </div>
      )}
      {msg && (
        <div
          className="rounded-[12px] px-4 py-3 text-sm flex items-center gap-3"
          style={{
            background: 'linear-gradient(135deg, rgba(34,197,94,0.12) 0%, rgba(34,197,94,0.06) 100%)',
            border: '1px solid rgba(34,197,94,0.25)',
            color: 'rgba(34,197,94,0.95)',
          }}
        >
          <Zap size={16} />
          {msg}
        </div>
      )}

      {/* 核心数据概览（开发期清库会保留） */}
      <Card className="p-5" variant="gold">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div>
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              核心数据
            </h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              系统基础配置（开发期清库会保留）
            </p>
          </div>
          <Badge variant={loading ? 'subtle' : 'success'} size="sm">
            {loading ? '同步中...' : '已同步'}
          </Badge>
        </div>

        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={<Users size={18} />}
            label="用户账号"
            value={fmtNum(summary?.users ?? 0)}
            subValue="系统用户"
            accent="gold"
            loading={loading}
          />
          <StatCard
            icon={<Server size={18} />}
            label="LLM 平台"
            value={fmtNum(summary?.llmPlatforms ?? 0)}
            subValue="已配置平台"
            accent="blue"
            loading={loading}
          />
          <StatCard
            icon={<Zap size={18} />}
            label="模型总数"
            value={fmtNum(summary?.llmModelsTotal ?? 0)}
            subValue="所有模型"
            accent="green"
            loading={loading}
          />
          <StatCard
            icon={<Zap size={18} />}
            label="启用模型"
            value={fmtNum(summary?.llmModelsEnabled ?? 0)}
            subValue="可用模型"
            accent="purple"
            loading={loading}
          />
        </div>
      </Card>

      {/* 业务数据概览（可清理） */}
      <Card className="p-5">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div>
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              业务数据
            </h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              运行时产生的数据（可按领域清理）
            </p>
          </div>
          <Badge variant="subtle" size="sm">
            共 {loading ? '-' : fmtNum(totalRecords)} 条
          </Badge>
        </div>

        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={<Server size={18} />}
            label="LLM 请求日志"
            value={fmtNum(summary?.llmRequestLogs ?? 0)}
            subValue="调用记录"
            accent="blue"
            loading={loading}
          />
          <StatCard
            icon={<MessageSquare size={18} />}
            label="PRD 消息"
            value={fmtNum(summary?.messages ?? 0)}
            subValue="问答交互"
            accent="green"
            loading={loading}
          />
          <StatCard
            icon={<FileText size={18} />}
            label="文档"
            value={fmtNum(summary?.documents ?? 0)}
            subValue="PRD 文档"
            accent="purple"
            loading={loading}
          />
          <StatCard
            icon={<HardDrive size={18} />}
            label="附件"
            value={fmtNum(summary?.attachments ?? 0)}
            subValue="上传文件"
            accent="default"
            loading={loading}
          />
        </div>

        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mt-3">
          <StatCard
            icon={<MessageSquare size={18} />}
            label="ImageMaster 会话"
            value={fmtNum(summary?.imageMasterSessions ?? 0)}
            subValue="图像会话"
            accent="blue"
            loading={loading}
          />
          <StatCard
            icon={<MessageSquare size={18} />}
            label="ImageMaster 消息"
            value={fmtNum(summary?.imageMasterMessages ?? 0)}
            subValue="图像交互"
            accent="green"
            loading={loading}
          />
          <StatCard
            icon={<AlertTriangle size={18} />}
            label="内容缺口"
            value={fmtNum(summary?.contentGaps ?? 0)}
            subValue="待补充项"
            accent="default"
            loading={loading}
          />
          <StatCard
            icon={<MessageSquare size={18} />}
            label="PRD 评论"
            value={fmtNum(summary?.prdComments ?? 0)}
            subValue="文档评论"
            accent="default"
            loading={loading}
          />
        </div>
      </Card>

      {/* 数据域管理 - 分列布局 */}
      <div className="grid gap-4 md:grid-cols-3">
        <DomainCard
          icon={<Server size={18} />}
          title="LLM 请求日志"
          description="大模型调用记录"
          items={[{ label: 'LLM 请求日志', value: summary?.llmRequestLogs ?? 0 }]}
          total={summary?.llmRequestLogs ?? 0}
          domains={['llmLogs']}
          loading={loading}
          onPurge={doPurge}
          accent="blue"
        />

        <DomainCard
          icon={<MessageSquare size={18} />}
          title="会话与消息"
          description="对话历史记录"
          items={[
            { label: 'PRD 消息', value: summary?.messages ?? 0 },
            { label: 'ImageMaster 会话', value: summary?.imageMasterSessions ?? 0 },
            { label: 'ImageMaster 消息', value: summary?.imageMasterMessages ?? 0 },
          ]}
          total={(summary?.messages ?? 0) + (summary?.imageMasterSessions ?? 0) + (summary?.imageMasterMessages ?? 0)}
          domains={['sessionsMessages']}
          loading={loading}
          onPurge={doPurge}
          accent="green"
        />

        <DomainCard
          icon={<FileText size={18} />}
          title="文档与知识库"
          description="PRD 文档及相关数据"
          items={[
            { label: '文档', value: summary?.documents ?? 0 },
            { label: '附件', value: summary?.attachments ?? 0 },
            { label: '内容缺口', value: summary?.contentGaps ?? 0 },
            { label: 'PRD 评论', value: summary?.prdComments ?? 0 },
          ]}
          total={(summary?.documents ?? 0) + (summary?.attachments ?? 0) + (summary?.contentGaps ?? 0) + (summary?.prdComments ?? 0)}
          domains={['documents']}
          loading={loading}
          onPurge={doPurge}
          accent="purple"
        />
      </div>

      {/* 危险操作区域 */}
      <Card className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <AlertTriangle size={16} style={{ color: 'rgba(239,68,68,0.75)' }} />
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
            危险操作
          </h2>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <DangerActionCard
            title="清理非管理员账号"
            description="删除所有非管理员用户账号及其关联数据，管理员账号将保留。此操作需要预览确认。"
            buttonText="预览并删除"
            onAction={openUsersPurge}
            loading={loading}
          />

          <DangerActionCard
            title="开发期一键重置"
            description="删除 users/llmplatforms/启用的 llmmodels 之外的所有集合数据，并清理未启用的模型配置。"
            buttonText="一键删除"
            onAction={async () => {
              await doPurge(['devReset']);
            }}
            loading={loading}
            confirmTitle="确认执行开发清库？"
            confirmDescription="将删除除 users / llmplatforms / 启用 llmmodels 外的所有数据，并清掉相关缓存（不可恢复）。"
          />
        </div>
      </Card>

      {/* 用户清理弹窗 */}
      <Dialog
        open={usersPurgeOpen}
        onOpenChange={(open) => {
          setUsersPurgeOpen(open);
          if (!open) {
            setUsersPurgeStep(1);
            setUsersConfirmText('');
            setUsersPreview(null);
          }
        }}
        title={usersPurgeStep === 1 ? '预览：清理用户数据' : '二次确认：删除用户数据'}
        description={usersPurgeStep === 1 ? '将删除非管理员用户账号（ADMIN 保留）。' : '该操作不可恢复。'}
        maxWidth={900}
        content={
          <div className="min-h-0 flex flex-col gap-4">
            {usersPurgeStep === 1 ? (
              <>
                {/* 统计概览 */}
                <div
                  className="rounded-[12px] p-4"
                  style={{
                    background: 'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(0,0,0,0.08) 100%)',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  {usersPreviewLoading ? (
                    <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                      <RefreshCw size={14} className="animate-spin" />
                      加载预览中...
                    </div>
                  ) : usersPreview ? (
                    <div className="grid grid-cols-4 gap-4">
                      <div>
                        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>总用户</div>
                        <div className="text-xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                          {fmtNum(usersPreview.totalUsers)}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>管理员</div>
                        <div className="text-xl font-bold mt-1" style={{ color: 'rgba(34,197,94,0.95)' }}>
                          {fmtNum(usersPreview.adminUsers)}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>将删除</div>
                        <div className="text-xl font-bold mt-1" style={{ color: 'rgba(239,68,68,0.95)' }}>
                          {fmtNum(usersPreview.willDeleteUsers)}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>将保留</div>
                        <div className="text-xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                          {fmtNum(usersPreview.willKeepUsers)}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm" style={{ color: 'var(--text-muted)' }}>暂无预览数据</div>
                  )}
                </div>

                {/* 备注 */}
                {usersPreview?.notes?.length ? (
                  <div className="text-xs space-y-1" style={{ color: 'var(--text-muted)' }}>
                    {usersPreview.notes.map((t, idx) => (
                      <div key={idx}>- {t}</div>
                    ))}
                  </div>
                ) : null}

                {/* 将删除的用户 */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Users size={14} style={{ color: 'rgba(239,68,68,0.75)' }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      将删除的用户（示例）
                    </span>
                  </div>
                  <div
                    className="rounded-[12px] p-3 space-y-2 max-h-[200px] overflow-y-auto"
                    style={{
                      background: 'rgba(0,0,0,0.15)',
                      border: '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    {/* 表头 */}
                    <div
                      className="grid gap-2 px-3 py-2 rounded-[8px] text-[10px] font-semibold uppercase tracking-wider"
                      style={{
                        gridTemplateColumns: '1.2fr 1fr 0.6fr 0.6fr 1fr',
                        color: 'var(--text-muted)',
                        background: 'rgba(255,255,255,0.03)',
                      }}
                    >
                      <div>账号</div>
                      <div>UserId</div>
                      <div>Role</div>
                      <div>Status</div>
                      <div>CreatedAt</div>
                    </div>
                    {usersPreviewLoading ? (
                      <div className="text-sm py-4 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
                    ) : usersPreview?.sampleWillDeleteUsers?.length ? (
                      usersPreview.sampleWillDeleteUsers.map((u) => <UserRow key={u.userId} u={u} />)
                    ) : (
                      <div className="text-sm py-4 text-center" style={{ color: 'var(--text-muted)' }}>
                        无（可能只有管理员账号）
                      </div>
                    )}
                  </div>
                </div>

                {/* 将保留的管理员 */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Users size={14} style={{ color: 'rgba(34,197,94,0.75)' }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      将保留的管理员（示例）
                    </span>
                  </div>
                  <div
                    className="rounded-[12px] p-3 space-y-2 max-h-[150px] overflow-y-auto"
                    style={{
                      background: 'rgba(0,0,0,0.15)',
                      border: '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    {usersPreview?.sampleWillKeepAdmins?.length ? (
                      usersPreview.sampleWillKeepAdmins.map((u) => <UserRow key={u.userId} u={u} />)
                    ) : (
                      <div className="text-sm py-4 text-center" style={{ color: 'var(--text-muted)' }}>
                        无管理员账号（异常）
                      </div>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* 警告提示 */}
                <div
                  className="rounded-[12px] px-4 py-3 text-sm flex items-center gap-3"
                  style={{
                    background: 'linear-gradient(135deg, rgba(239,68,68,0.15) 0%, rgba(239,68,68,0.08) 100%)',
                    border: '1px solid rgba(239,68,68,0.30)',
                    color: 'rgba(239,68,68,0.95)',
                  }}
                >
                  <AlertTriangle size={18} />
                  将删除非管理员用户账号，该操作不可恢复。
                </div>

                {/* 确认输入 */}
                <div className="space-y-3">
                  <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    请输入 <code className="px-1.5 py-0.5 rounded bg-white/5 font-mono">DELETE</code> 以确认
                  </div>
                  <input
                    value={usersConfirmText}
                    onChange={(e) => setUsersConfirmText(e.target.value)}
                    placeholder="DELETE"
                    className="w-full h-[44px] rounded-[12px] px-4 text-sm outline-none transition-all prd-field"
                    autoFocus
                  />
                </div>
              </>
            )}

            {/* 操作按钮 */}
            <div className="pt-3 flex items-center justify-end gap-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  if (usersPurgeStep === 1) {
                    setUsersPurgeOpen(false);
                  } else {
                    setUsersPurgeStep(1);
                    setUsersConfirmText('');
                  }
                }}
              >
                {usersPurgeStep === 1 ? '取消' : '返回预览'}
              </Button>
              {usersPurgeStep === 1 ? (
                <Button variant="primary" size="sm" disabled={usersPreviewLoading} onClick={() => setUsersPurgeStep(2)}>
                  下一步
                </Button>
              ) : (
                <Button variant="danger" size="sm" disabled={usersConfirmText !== 'DELETE' || loading} onClick={doPurgeUsers}>
                  确认删除
                </Button>
              )}
            </div>
          </div>
        }
      />

      {/* 配置迁移弹窗 */}
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
