import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { X, RotateCcw, XCircle, Clock, User, Mail, FileText, AlertCircle, Download } from 'lucide-react';
import type { ChannelTask } from '@/services/contracts/channels';
import {
  ChannelTypeDisplayNames,
  TaskStatusDisplayNames,
  TaskStatus,
  TaskIntents,
} from '@/services/contracts/channels';

interface TaskDetailDrawerProps {
  open: boolean;
  onClose: () => void;
  task: ChannelTask | null;
  onRetry: (task: ChannelTask) => void;
  onCancel: (task: ChannelTask) => void;
}

function fmtDate(v?: string | null) {
  if (!v) return '-';
  return new Date(v).toLocaleString('zh-CN');
}

const statusColors: Record<string, string> = {
  pending: 'rgba(234,179,8,0.15)',
  processing: 'rgba(59,130,246,0.15)',
  completed: 'rgba(34,197,94,0.15)',
  failed: 'rgba(239,68,68,0.15)',
  cancelled: 'rgba(107,114,128,0.15)',
};

const statusBorderColors: Record<string, string> = {
  pending: 'rgba(234,179,8,0.3)',
  processing: 'rgba(59,130,246,0.3)',
  completed: 'rgba(34,197,94,0.3)',
  failed: 'rgba(239,68,68,0.3)',
  cancelled: 'rgba(107,114,128,0.3)',
};

const statusTextColors: Record<string, string> = {
  pending: 'rgb(234,179,8)',
  processing: 'rgb(96,165,250)',
  completed: 'rgb(34,197,94)',
  failed: 'rgb(239,68,68)',
  cancelled: 'rgb(156,163,175)',
};

const badgeVariants: Record<string, 'success' | 'subtle' | 'discount' | 'new' | 'featured'> = {
  pending: 'new',
  processing: 'featured',
  completed: 'success',
  failed: 'discount',
  cancelled: 'subtle',
};

export function TaskDetailDrawer({
  open,
  onClose,
  task,
  onRetry,
  onCancel,
}: TaskDetailDrawerProps) {
  if (!open || !task) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />

      {/* Drawer */}
      <div
        className="relative w-full max-w-lg h-full overflow-y-auto"
        style={{
          background: 'linear-gradient(180deg, rgba(20,20,25,0.98) 0%, rgba(15,15,20,0.98) 100%)',
          borderLeft: '1px solid rgba(255,255,255,0.1)',
          backdropFilter: 'blur(40px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="sticky top-0 z-10 p-4 border-b"
          style={{
            background: 'rgba(255,255,255,0.02)',
            borderColor: 'rgba(255,255,255,0.08)',
          }}
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">任务详情</h2>
              <code className="text-xs text-muted-foreground">{task.id}</code>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose}>
              <X size={18} />
            </Button>
          </div>
        </div>

        {/* Content */}
        <div className="p-5 space-y-5">
          {/* 状态卡片 */}
          <div
            className="p-4 rounded-lg flex items-center justify-between"
            style={{
              background: statusColors[task.status],
              border: `1px solid ${statusBorderColors[task.status]}`,
            }}
          >
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center"
                style={{ background: 'rgba(255,255,255,0.1)' }}
              >
                {task.status === 'completed' && <FileText size={20} style={{ color: statusTextColors[task.status] }} />}
                {task.status === 'failed' && <AlertCircle size={20} style={{ color: statusTextColors[task.status] }} />}
                {task.status === 'pending' && <Clock size={20} style={{ color: statusTextColors[task.status] }} />}
                {task.status === 'processing' && <Clock size={20} style={{ color: statusTextColors[task.status] }} />}
                {task.status === 'cancelled' && <XCircle size={20} style={{ color: statusTextColors[task.status] }} />}
              </div>
              <div>
                <div className="text-sm font-medium" style={{ color: statusTextColors[task.status] }}>
                  {TaskStatusDisplayNames[task.status] || task.status}
                </div>
                <div className="text-xs text-muted-foreground">
                  {task.durationMs ? `耗时 ${task.durationMs}ms` : '处理中...'}
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              {(task.status === TaskStatus.Failed || task.status === TaskStatus.Cancelled) && (
                <Button variant="secondary" size="sm" onClick={() => onRetry(task)}>
                  <RotateCcw size={14} />
                  重试
                </Button>
              )}
              {(task.status === TaskStatus.Pending || task.status === TaskStatus.Processing) && (
                <Button variant="secondary" size="sm" onClick={() => onCancel(task)}>
                  <XCircle size={14} />
                  取消
                </Button>
              )}
            </div>
          </div>

          <div className="border-t border-white/10" />

          {/* 基本信息 */}
          <Section title="基本信息" icon={<FileText size={16} />}>
            <InfoRow label="通道" value={ChannelTypeDisplayNames[task.channelType] || task.channelType} />
            <InfoRow label="意图" value={TaskIntents[task.intent || 'unknown'] || task.intent || '未识别'} />
            <InfoRow label="目标 Agent" value={task.targetAgent || '未指定'} />
            {task.originalSubject && <InfoRow label="主题" value={task.originalSubject} />}
          </Section>

          <div className="border-t border-white/10" />

          {/* 发送者信息 */}
          <Section title="发送者" icon={<User size={16} />}>
            <InfoRow label="标识" value={task.senderIdentifier} />
            {task.senderDisplayName && <InfoRow label="显示名" value={task.senderDisplayName} />}
            {task.mappedUserId && (
              <InfoRow label="映射用户" value={task.mappedUserName || task.mappedUserId} />
            )}
            {task.whitelistId && <InfoRow label="白名单 ID" value={task.whitelistId} mono />}
          </Section>

          <div className="border-t border-white/10" />

          {/* 原始内容 */}
          <Section title="原始内容" icon={<Mail size={16} />}>
            <div
              className="p-3 rounded-lg text-sm whitespace-pre-wrap"
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.08)',
                maxHeight: '200px',
                overflow: 'auto',
              }}
            >
              {task.originalContent || '(无内容)'}
            </div>
          </Section>

          {/* 解析参数 */}
          {Object.keys(task.parsedParameters).length > 0 && (
            <>
              <div className="border-t border-white/10" />
              <Section title="解析参数">
                <div
                  className="p-3 rounded-lg text-xs font-mono"
                  style={{
                    background: 'rgba(0,0,0,0.3)',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  <pre className="overflow-auto">{JSON.stringify(task.parsedParameters, null, 2)}</pre>
                </div>
              </Section>
            </>
          )}

          {/* 附件 */}
          {task.attachments.length > 0 && (
            <>
              <div className="border-t border-white/10" />
              <Section title={`附件 (${task.attachments.length})`}>
                <div className="space-y-2">
                  {task.attachments.map((att) => (
                    <div
                      key={att.id}
                      className="flex items-center justify-between p-3 rounded-lg"
                      style={{
                        background: 'rgba(255,255,255,0.03)',
                        border: '1px solid rgba(255,255,255,0.08)',
                      }}
                    >
                      <div>
                        <div className="text-sm font-medium">{att.fileName}</div>
                        <div className="text-xs text-muted-foreground">
                          {att.mimeType} · {formatFileSize(att.fileSize)}
                        </div>
                      </div>
                      {att.url && (
                        <a
                          href={att.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300"
                        >
                          <Download size={14} />
                          下载
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            </>
          )}

          {/* 执行结果 */}
          {task.result && (
            <>
              <div className="border-t border-white/10" />
              <Section title="执行结果">
                <InfoRow label="类型" value={task.result.type} />
                {task.result.textContent && (
                  <div
                    className="mt-2 p-3 rounded-lg text-sm whitespace-pre-wrap"
                    style={{
                      background: 'rgba(34,197,94,0.08)',
                      border: '1px solid rgba(34,197,94,0.2)',
                    }}
                  >
                    {task.result.textContent}
                  </div>
                )}
                {task.result.imageUrl && (
                  <img
                    src={task.result.imageUrl}
                    alt="结果图片"
                    className="mt-2 rounded-lg max-w-full"
                    style={{ border: '1px solid rgba(255,255,255,0.1)' }}
                  />
                )}
              </Section>
            </>
          )}

          {/* 错误信息 */}
          {task.error && (
            <>
              <div className="border-t border-white/10" />
              <Section title="错误信息" icon={<AlertCircle size={16} />}>
                <div
                  className="p-3 rounded-lg text-sm"
                  style={{
                    background: 'rgba(239,68,68,0.08)',
                    border: '1px solid rgba(239,68,68,0.2)',
                  }}
                >
                  {task.errorCode && (
                    <div className="font-mono text-xs mb-1 text-red-400">[{task.errorCode}]</div>
                  )}
                  <div className="text-red-400">{task.error}</div>
                </div>
              </Section>
            </>
          )}

          <div className="border-t border-white/10" />

          {/* 时间线 */}
          <Section title="时间线" icon={<Clock size={16} />}>
            <InfoRow label="创建时间" value={fmtDate(task.createdAt)} />
            {task.startedAt && <InfoRow label="开始时间" value={fmtDate(task.startedAt)} />}
            {task.completedAt && <InfoRow label="完成时间" value={fmtDate(task.completedAt)} />}
            {task.durationMs !== null && task.durationMs !== undefined && (
              <InfoRow label="执行耗时" value={`${task.durationMs}ms`} highlight />
            )}
            <InfoRow label="重试次数" value={`${task.retryCount} / ${task.maxRetries}`} />
          </Section>

          {/* 状态历史 */}
          {task.statusHistory.length > 0 && (
            <>
              <div className="border-t border-white/10" />
              <Section title="状态历史">
                <div className="space-y-2">
                  {task.statusHistory.map((change, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-3 p-2 rounded-lg"
                      style={{
                        background: statusColors[change.status],
                        border: `1px solid ${statusBorderColors[change.status]}`,
                      }}
                    >
                      <Badge variant={badgeVariants[change.status]} size="sm">
                        {TaskStatusDisplayNames[change.status] || change.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground flex-1">{fmtDate(change.at)}</span>
                      {change.note && <span className="text-xs">({change.note})</span>}
                    </div>
                  ))}
                </div>
              </Section>
            </>
          )}

          {/* 响应记录 */}
          {task.responsesSent.length > 0 && (
            <>
              <div className="border-t border-white/10" />
              <Section title="响应记录">
                <div className="space-y-2">
                  {task.responsesSent.map((resp, idx) => (
                    <div
                      key={idx}
                      className="p-3 rounded-lg"
                      style={{
                        background: 'rgba(255,255,255,0.03)',
                        border: '1px solid rgba(255,255,255,0.08)',
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <Badge variant="subtle" size="sm">{resp.type}</Badge>
                        <span className="text-xs text-muted-foreground">{fmtDate(resp.sentAt)}</span>
                      </div>
                      {resp.messageId && (
                        <div className="text-xs text-muted-foreground mt-2 font-mono px-2 py-1 rounded" style={{ background: 'rgba(0,0,0,0.2)' }}>
                          {resp.messageId}
                        </div>
                      )}
                      {resp.error && (
                        <div className="text-xs text-red-400 mt-2">{resp.error}</div>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            </>
          )}

          {/* 元数据 */}
          {Object.keys(task.metadata).length > 0 && (
            <>
              <div className="border-t border-white/10" />
              <Section title="元数据">
                <div
                  className="p-3 rounded-lg text-xs font-mono"
                  style={{
                    background: 'rgba(0,0,0,0.3)',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  <pre className="overflow-auto">{JSON.stringify(task.metadata, null, 2)}</pre>
                </div>
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        {icon && <span className="text-muted-foreground">{icon}</span>}
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function InfoRow({
  label,
  value,
  mono,
  highlight,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-start justify-between py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span
        className={`text-sm text-right ${mono ? 'font-mono text-xs' : ''} ${highlight ? 'text-blue-400' : ''}`}
      >
        {value}
      </span>
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
