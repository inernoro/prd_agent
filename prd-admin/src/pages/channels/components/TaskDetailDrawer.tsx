import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { X, RotateCcw, XCircle, Clock, User, Mail, FileText, AlertCircle } from 'lucide-react';
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
  pending: 'warning',
  processing: 'info',
  completed: 'success',
  failed: 'danger',
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
          background: 'var(--bg-base)',
          borderLeft: '1px solid rgba(255,255,255,0.08)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="sticky top-0 z-10 flex items-center justify-between p-4 border-b"
          style={{
            background: 'var(--bg-base)',
            borderColor: 'rgba(255,255,255,0.08)',
          }}
        >
          <div>
            <h2 className="text-lg font-semibold">任务详情</h2>
            <code className="text-xs text-muted-foreground">{task.id}</code>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X size={18} />
          </Button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-6">
          {/* 状态和操作 */}
          <div className="flex items-center justify-between">
            <Badge
              variant={statusColors[task.status] as 'success' | 'warning' | 'danger' | 'info' | 'subtle'}
              size="lg"
            >
              {TaskStatusDisplayNames[task.status] || task.status}
            </Badge>
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

          {/* 基本信息 */}
          <Section title="基本信息" icon={<FileText size={16} />}>
            <InfoRow label="通道" value={ChannelTypeDisplayNames[task.channelType] || task.channelType} />
            <InfoRow label="意图" value={TaskIntents[task.intent || 'unknown'] || task.intent || '未识别'} />
            <InfoRow label="目标 Agent" value={task.targetAgent || '未指定'} />
            {task.originalSubject && <InfoRow label="主题" value={task.originalSubject} />}
          </Section>

          {/* 发送者信息 */}
          <Section title="发送者" icon={<User size={16} />}>
            <InfoRow label="标识" value={task.senderIdentifier} />
            {task.senderDisplayName && <InfoRow label="显示名" value={task.senderDisplayName} />}
            {task.mappedUserId && (
              <InfoRow label="映射用户" value={task.mappedUserName || task.mappedUserId} />
            )}
            {task.whitelistId && <InfoRow label="白名单 ID" value={task.whitelistId} mono />}
          </Section>

          {/* 原始内容 */}
          <Section title="原始内容" icon={<Mail size={16} />}>
            <div
              className="p-3 rounded-lg text-sm whitespace-pre-wrap"
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.06)',
                maxHeight: '200px',
                overflow: 'auto',
              }}
            >
              {task.originalContent || '(无内容)'}
            </div>
          </Section>

          {/* 解析参数 */}
          {Object.keys(task.parsedParameters).length > 0 && (
            <Section title="解析参数">
              <div
                className="p-3 rounded-lg text-xs font-mono"
                style={{
                  background: 'rgba(0,0,0,0.2)',
                  border: '1px solid rgba(255,255,255,0.06)',
                }}
              >
                <pre>{JSON.stringify(task.parsedParameters, null, 2)}</pre>
              </div>
            </Section>
          )}

          {/* 附件 */}
          {task.attachments.length > 0 && (
            <Section title={`附件 (${task.attachments.length})`}>
              <div className="space-y-2">
                {task.attachments.map((att) => (
                  <div
                    key={att.id}
                    className="flex items-center justify-between p-2 rounded-lg"
                    style={{
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.06)',
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
                        className="text-sm text-primary hover:underline"
                      >
                        下载
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* 执行结果 */}
          {task.result && (
            <Section title="执行结果">
              <InfoRow label="类型" value={task.result.type} />
              {task.result.textContent && (
                <div
                  className="mt-2 p-3 rounded-lg text-sm whitespace-pre-wrap"
                  style={{
                    background: 'rgba(34,197,94,0.1)',
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
          )}

          {/* 错误信息 */}
          {task.error && (
            <Section title="错误信息" icon={<AlertCircle size={16} />}>
              <div
                className="p-3 rounded-lg text-sm"
                style={{
                  background: 'rgba(239,68,68,0.1)',
                  border: '1px solid rgba(239,68,68,0.2)',
                  color: 'rgba(239,68,68,0.95)',
                }}
              >
                {task.errorCode && (
                  <div className="font-mono text-xs mb-1">[{task.errorCode}]</div>
                )}
                {task.error}
              </div>
            </Section>
          )}

          {/* 时间线 */}
          <Section title="时间线" icon={<Clock size={16} />}>
            <InfoRow label="创建时间" value={fmtDate(task.createdAt)} />
            {task.startedAt && <InfoRow label="开始时间" value={fmtDate(task.startedAt)} />}
            {task.completedAt && <InfoRow label="完成时间" value={fmtDate(task.completedAt)} />}
            {task.durationMs !== null && task.durationMs !== undefined && (
              <InfoRow label="执行耗时" value={`${task.durationMs}ms`} />
            )}
            <InfoRow label="重试次数" value={`${task.retryCount} / ${task.maxRetries}`} />
          </Section>

          {/* 状态历史 */}
          {task.statusHistory.length > 0 && (
            <Section title="状态历史">
              <div className="space-y-2">
                {task.statusHistory.map((change, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-3 text-sm"
                  >
                    <Badge variant={statusColors[change.status] as 'success' | 'warning' | 'danger' | 'info' | 'subtle'} size="sm">
                      {TaskStatusDisplayNames[change.status] || change.status}
                    </Badge>
                    <span className="text-muted-foreground">{fmtDate(change.at)}</span>
                    {change.note && <span className="text-xs">({change.note})</span>}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* 响应记录 */}
          {task.responsesSent.length > 0 && (
            <Section title="响应记录">
              <div className="space-y-2">
                {task.responsesSent.map((resp, idx) => (
                  <div
                    key={idx}
                    className="p-2 rounded-lg text-sm"
                    style={{
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <Badge variant="subtle" size="sm">{resp.type}</Badge>
                      <span className="text-xs text-muted-foreground">{fmtDate(resp.sentAt)}</span>
                    </div>
                    {resp.messageId && (
                      <div className="text-xs text-muted-foreground mt-1 font-mono">
                        {resp.messageId}
                      </div>
                    )}
                    {resp.error && (
                      <div className="text-xs text-red-400 mt-1">{resp.error}</div>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* 元数据 */}
          {Object.keys(task.metadata).length > 0 && (
            <Section title="元数据">
              <div
                className="p-3 rounded-lg text-xs font-mono"
                style={{
                  background: 'rgba(0,0,0,0.2)',
                  border: '1px solid rgba(255,255,255,0.06)',
                }}
              >
                <pre>{JSON.stringify(task.metadata, null, 2)}</pre>
              </div>
            </Section>
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
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between py-1">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`text-sm text-right ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
