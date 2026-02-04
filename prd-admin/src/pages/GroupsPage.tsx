import { useEffect, useMemo, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { TabBar } from '@/components/design/TabBar';
import { Select } from '@/components/design/Select';
import { Dialog } from '@/components/ui/Dialog';
import {
  deleteAdminGroup,
  deleteAdminGroupMessages,
  generateAdminGapSummary,
  getAdminGroupGaps,
  getAdminGroupMembers,
  getAdminGroupMessages,
  getAdminGroups,
  regenerateAdminGroupInvite,
  removeAdminGroupMember,
  simulateMessage,
  simulateStreamMessages,
  updateAdminGapStatus,
} from '@/services';
import { Trash2, RefreshCw, Copy, Search, Users2, MessageSquareText, AlertTriangle, Send, FolderKanban, FileText, Calendar, User } from 'lucide-react';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { LlmRequestDetailDialog } from '@/components/llm/LlmRequestDetailDialog';

type TopMember = {
  userId: string;
  displayName: string;
  avatarFileName?: string | null;
};

type GroupRow = {
  groupId: string;
  groupName: string;
  owner?: { userId: string; username: string; displayName: string; role?: string };
  memberCount: number;
  prdTitle?: string | null;
  inviteCode: string;
  inviteLink: string;
  inviteExpireAt?: string | null;
  maxMembers?: number;
  createdAt: string;
  lastMessageAt?: string | null;
  messageCount?: number;
  pendingGapCount?: number;
  topMembers?: TopMember[];
};

type MemberRow = {
  userId: string;
  username: string;
  displayName: string;
  role: 'PM' | 'DEV' | 'QA' | 'ADMIN';
  joinedAt: string;
  isOwner?: boolean;
};

type GapRow = {
  gapId: string;
  question: string;
  gapType: string;
  askedAt: string;
  status: 'pending' | 'resolved' | 'ignored';
  askedBy?: { userId: string; displayName: string; role: 'PM' | 'DEV' | 'QA' | 'ADMIN' };
};

type MessageRow = {
  id: string;
  sessionId: string;
  role: 'User' | 'Assistant';
  senderId?: string | null;
  senderName?: string | null;
  senderRole?: 'PM' | 'DEV' | 'QA' | 'ADMIN' | null;
  content: string;
  llmRequestId?: string | null;
  timestamp: string;
  tokenUsage?: { input: number; output: number } | null;
};

function fmtDate(v?: string | null) {
  if (!v) return '-';
  return v;
}

/**
 * LLM 经常用 ```markdown / ```md 包裹"本来就想渲染的 Markdown"，
 * 这会导致 ReactMarkdown 将其当作代码块显示（<pre><code>），而非解析内部的 markdown 语法。
 * 这里仅解包 markdown/md 语言标记，其它代码块保持不动。
 */
function unwrapMarkdownFences(text: string): string {
  if (!text) return text;
  return text.replace(/```(?:markdown|md)\s*\n([\s\S]*?)\n```/g, '$1');
}

function MessageMarkdown({ content }: { content: string }) {
  const text = (content ?? '').trim();
  return (
    <div className="prd-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={{
          a: ({ href, children, ...props }) => (
            <a href={href} target="_blank" rel="noreferrer" {...props}>
              {children}
            </a>
          ),
        }}
      >
        {unwrapMarkdownFences(text) || '（空内容）'}
      </ReactMarkdown>
    </div>
  );
}

/** 头像堆叠组件 */
function AvatarStack({ members, total, max = 5 }: { members: TopMember[]; total: number; max?: number }) {
  const displayed = members.slice(0, max);
  const remaining = total - displayed.length;

  // 根据头像文件名生成URL（如果有配置的base URL）
  const getAvatarUrl = (fileName?: string | null) => {
    if (!fileName) return null;
    // 假设头像存储在 /avatars/ 路径下，实际可配置
    return `/avatars/${fileName}`;
  };

  // 生成基于名字的渐变色
  const getGradient = (name: string) => {
    const hash = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const hue = hash % 360;
    return `linear-gradient(135deg, hsl(${hue}, 60%, 45%), hsl(${(hue + 40) % 360}, 70%, 35%))`;
  };

  return (
    <div className="flex items-center">
      <div className="flex -space-x-2">
        {displayed.map((member, i) => {
          const avatarUrl = getAvatarUrl(member.avatarFileName);
          return (
            <div
              key={member.userId}
              className="w-8 h-8 rounded-full border-2 flex items-center justify-center text-xs font-semibold text-white overflow-hidden"
              style={{
                borderColor: 'var(--bg-primary)',
                background: avatarUrl ? `url(${avatarUrl}) center/cover` : getGradient(member.displayName),
                zIndex: max - i,
              }}
              title={member.displayName}
            >
              {!avatarUrl && (member.displayName?.[0] || '?').toUpperCase()}
            </div>
          );
        })}
        {remaining > 0 && (
          <div
            className="w-8 h-8 rounded-full border-2 flex items-center justify-center text-xs font-semibold"
            style={{
              borderColor: 'var(--bg-primary)',
              background: 'rgba(255,255,255,0.1)',
              color: 'var(--text-secondary)',
              zIndex: 0,
            }}
          >
            +{remaining}
          </div>
        )}
      </div>
    </div>
  );
}

/** 邀请状态计算 */
function getInviteStatus(expireAt?: string | null): { label: string; variant: 'success' | 'discount' | 'subtle' } {
  if (!expireAt) return { label: '长期有效', variant: 'success' };
  const exp = new Date(expireAt);
  const now = new Date();
  if (exp < now) return { label: '已过期', variant: 'subtle' };
  return { label: '有效', variant: 'success' };
}

/** 格式化日期为简短格式 */
function formatShortDate(dateStr?: string | null): string {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function GroupsPage() {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<GroupRow[]>([]);
  const [total, setTotal] = useState(0);

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [inviteStatus, setInviteStatus] = useState<'all' | 'valid' | 'expired'>('all');

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<GroupRow | null>(null);
  const [tab, setTab] = useState<'members' | 'gaps' | 'messages'>('members');

  const [members, setMembers] = useState<MemberRow[]>([]);
  const [gaps, setGaps] = useState<GapRow[]>([]);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [messagesTotal, setMessagesTotal] = useState(0);
  const [messagesPage, setMessagesPage] = useState(1);
  const [messagesLoadingMore, setMessagesLoadingMore] = useState(false);
  const [messagesClearing, setMessagesClearing] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  const [llmDetailOpen, setLlmDetailOpen] = useState(false);
  const [llmDetailRequestId, setLlmDetailRequestId] = useState<string | null>(null);

  // 模拟发送消息
  const [simulateDialogOpen, setSimulateDialogOpen] = useState(false);
  const [simulateContent, setSimulateContent] = useState('');
  const [simulateTriggerAi, setSimulateTriggerAi] = useState(false);
  const [simulateBusy, setSimulateBusy] = useState(false);

  const query = useMemo(
    () => ({ page, pageSize: 20, search: search.trim() || undefined, inviteStatus }),
    [page, search, inviteStatus]
  );

  const load = async () => {
    setLoading(true);
    try {
      const res = await getAdminGroups({ page, pageSize: 20, search: search.trim() || undefined, inviteStatus });
      if (res.success) {
        setTotal(res.data.total);
        setItems(
          res.data.items.map((g) => ({
            groupId: g.groupId,
            groupName: g.groupName,
            owner: g.owner ? { userId: g.owner.userId, username: g.owner.username, displayName: g.owner.displayName, role: g.owner.role } : undefined,
            memberCount: g.memberCount,
            prdTitle: g.prdTitleSnapshot ?? null,
            inviteCode: g.inviteCode,
            inviteLink: `prdagent://join/${g.inviteCode}`,
            inviteExpireAt: g.inviteExpireAt ?? null,
            maxMembers: g.maxMembers,
            createdAt: g.createdAt,
            lastMessageAt: g.lastMessageAt ?? null,
            messageCount: g.messageCount,
            pendingGapCount: g.pendingGapCount,
            topMembers: g.topMembers?.map(m => ({
              userId: m.userId,
              displayName: m.displayName,
              avatarFileName: m.avatarFileName ?? null,
            })) ?? [],
          }))
        );
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.page, query.search, query.inviteStatus]);

  const openDetail = async (g: GroupRow) => {
    setSelected(g);
    setOpen(true);
    setTab('members');
    // members
    const mRes = await getAdminGroupMembers(g.groupId);
    if (mRes.success) {
      setMembers(
        mRes.data.map((m) => ({
          userId: m.userId,
          username: m.username,
          displayName: m.displayName,
          role: m.role,
          joinedAt: m.joinedAt,
          isOwner: m.isOwner,
        }))
      );
    }

    // gaps
    const gapRes = await getAdminGroupGaps(g.groupId, { page: 1, pageSize: 50 });
    if (gapRes.success) {
      setGaps(
        gapRes.data.items.map((x) => ({
          gapId: x.gapId,
          question: x.question,
          gapType: x.gapType,
          askedAt: x.askedAt,
          status: x.status,
          askedBy: x.askedBy ? { userId: x.askedBy.userId, displayName: x.askedBy.displayName, role: x.askedBy.role } : undefined,
        }))
      );
    }

    // messages
    setMessagesPage(1);
    setMessagesTotal(0);
    const msgRes = await getAdminGroupMessages(g.groupId, { page: 1, pageSize: 20 });
    if (msgRes.success) {
      setMessagesTotal(msgRes.data.total ?? 0);
      setMessages(
        msgRes.data.items.map((m) => ({
          id: m.id,
          sessionId: m.sessionId,
          role: m.role,
          senderId: m.senderId ?? null,
          senderName: (m as any).senderName ?? null,
          senderRole: (m as any).senderRole ?? null,
          content: m.content,
          llmRequestId: m.llmRequestId ?? null,
          timestamp: m.timestamp,
          tokenUsage: m.tokenUsage ?? null,
        }))
      );
    }
  };

  const onCopy = async (text: string) => {
    await navigator.clipboard.writeText(text);
  };

  return (
    <div className="h-full flex flex-col gap-6">
      <TabBar
        title="群组管理"
        icon={<FolderKanban size={16} />}
      />

      <GlassCard glow className="flex-1 min-h-0 flex flex-col">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[240px]">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                className="h-10 w-full rounded-[14px] pl-9 pr-4 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                placeholder="搜索群组名/群组ID/群主"
              />
            </div>
          </div>

          <Select
            value={inviteStatus}
            onChange={(e) => {
              setInviteStatus(e.target.value as 'all' | 'valid' | 'expired');
              setPage(1);
            }}
            uiSize="md"
          >
            <option value="all">邀请状态</option>
            <option value="valid">有效</option>
            <option value="expired">已过期</option>
          </Select>

          {null}
        </div>

        <div className="mt-5 flex-1 min-h-0 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center py-20" style={{ color: 'var(--text-muted)' }}>
              加载中...
            </div>
          ) : items.length === 0 ? (
            <div className="flex items-center justify-center py-20" style={{ color: 'var(--text-muted)' }}>
              暂无数据
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {items.map((g) => {
                const inviteStatus = getInviteStatus(g.inviteExpireAt);
                return (
                  <div
                    key={g.groupId}
                    className="rounded-[20px] p-5 flex flex-col cursor-pointer transition-all hover:scale-[1.02]"
                    style={{
                      background: 'rgba(30, 32, 40, 0.85)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      boxShadow: '0 4px 24px rgba(0,0,0,0.2)',
                    }}
                    onClick={() => openDetail(g)}
                  >
                    {/* 头部：群组名 + 状态标签 */}
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="min-w-0 flex-1">
                        <h3 className="text-xl font-bold truncate" style={{ color: 'var(--text-primary)' }}>
                          {g.groupName}
                        </h3>
                        <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                          {g.groupId}
                        </div>
                      </div>
                      <Badge variant={inviteStatus.variant}>{inviteStatus.label}</Badge>
                    </div>

                    {/* 群主信息 */}
                    {g.owner && (
                      <div className="flex items-center gap-2 mb-4 text-sm" style={{ color: 'var(--text-muted)' }}>
                        <User size={14} />
                        <span>群主：{g.owner.role || 'PM'} ({g.owner.displayName})</span>
                      </div>
                    )}

                    {/* 标签区域：PRD + 创建时间 */}
                    <div className="flex flex-wrap gap-2 mb-4">
                      {g.prdTitle ? (
                        <div
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
                          style={{
                            background: 'rgba(168, 85, 247, 0.15)',
                            border: '1px solid rgba(168, 85, 247, 0.35)',
                            color: 'rgba(216, 180, 254, 0.95)',
                          }}
                        >
                          <FileText size={12} />
                          <span className="truncate max-w-[140px]">{g.prdTitle}</span>
                        </div>
                      ) : (
                        <div
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
                          style={{
                            background: 'rgba(100, 100, 100, 0.15)',
                            border: '1px solid rgba(100, 100, 100, 0.35)',
                            color: 'rgba(180, 180, 180, 0.8)',
                          }}
                        >
                          <FileText size={12} />
                          无PRD
                        </div>
                      )}
                      <div
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
                        style={{
                          background: 'rgba(168, 85, 247, 0.15)',
                          border: '1px solid rgba(168, 85, 247, 0.35)',
                          color: 'rgba(216, 180, 254, 0.95)',
                        }}
                      >
                        <Calendar size={12} />
                        {formatShortDate(g.createdAt)}
                      </div>
                    </div>

                    {/* 分割线 */}
                    <div className="border-t my-2" style={{ borderColor: 'rgba(255,255,255,0.08)' }} />

                    {/* Footer：头像堆叠 + 统计数字 */}
                    <div className="flex items-center justify-between mt-2">
                      <AvatarStack members={g.topMembers || []} total={g.memberCount} max={5} />

                      <div className="flex items-center gap-4">
                        <div className="flex items-center gap-1.5" title="消息数">
                          <MessageSquareText size={16} style={{ color: 'var(--text-muted)' }} />
                          <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                            {g.messageCount ?? 0}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5" title="待处理缺失">
                          <AlertTriangle
                            size={16}
                            style={{ color: (g.pendingGapCount ?? 0) > 0 ? 'rgba(245,158,11,0.95)' : 'var(--text-muted)' }}
                          />
                          <span
                            className="text-sm font-medium"
                            style={{ color: (g.pendingGapCount ?? 0) > 0 ? 'rgba(245,158,11,0.95)' : 'var(--text-secondary)' }}
                          >
                            {g.pendingGapCount ?? 0}
                          </span>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            onCopy(g.inviteLink);
                          }}
                          title="复制邀请链接"
                          aria-label="复制邀请链接"
                        >
                          <Copy size={16} />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center justify-between">
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>第 {page} 页 / 共 {Math.max(1, Math.ceil(total / 20))} 页</div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              上一页
            </Button>
            <Button variant="secondary" size="sm" disabled={page >= Math.ceil(total / 20)} onClick={() => setPage((p) => p + 1)}>
              下一页
            </Button>
          </div>
        </div>
      </GlassCard>

      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) setSelected(null);
        }}
        title={selected ? `群组详情：${selected.groupName}` : '群组详情'}
        description={selected ? selected.groupId : undefined}
        maxWidth={980}
        contentStyle={{ height: 'min(84vh, 760px)' }}
        content={
          !selected ? (
            <div className="py-10 text-center" style={{ color: 'var(--text-muted)' }}>暂无选择</div>
          ) : (
            <div className="h-full min-h-0 flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Button variant={tab === 'members' ? 'secondary' : 'ghost'} size="sm" onClick={() => setTab('members')}>
                    <Users2 size={16} />
                    成员
                  </Button>
                  <Button variant={tab === 'gaps' ? 'secondary' : 'ghost'} size="sm" onClick={() => setTab('gaps')}>
                    <AlertTriangle size={16} />
                    缺失
                  </Button>
                  <Button variant={tab === 'messages' ? 'secondary' : 'ghost'} size="sm" onClick={() => setTab('messages')}>
                    <MessageSquareText size={16} />
                    消息
                  </Button>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setSimulateDialogOpen(true)}
                    title="模拟发送消息（测试推送）"
                    aria-label="模拟发送消息"
                  >
                    <Send size={16} />
                    模拟发送
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={async () => {
                      if (!selected) return;
                      const confirmed = await systemDialog.confirm({
                        title: '模拟流发送',
                        message: `将向群组「${selected.groupName}」发送3条流消息（PM、DEV、QA 机器人），用于测试多机器人并发场景。是否继续？`,
                      });
                      if (!confirmed) return;
                      setActionBusy(true);
                      try {
                        const res = await simulateStreamMessages({ groupId: selected.groupId });
                        if (res.success) {
                          toast.success('发送成功', res.data.message || '已启动模拟流式发送');
                        } else {
                          toast.error('发送失败', res.error?.message || '未知错误');
                        }
                      } finally {
                        setActionBusy(false);
                      }
                    }}
                    title="模拟流发送（测试多机器人并发）"
                    aria-label="模拟流发送"
                  >
                    <Send size={16} />
                    模拟流发送
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onCopy(selected.inviteLink)}
                    title="复制邀请链接"
                    aria-label="复制邀请链接"
                  >
                    <Copy size={16} />
                    复制邀请
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={actionBusy}
                    onClick={async () => {
                      if (!selected) return;
                      setActionBusy(true);
                      try {
                        const res = await regenerateAdminGroupInvite(selected.groupId);
                        if (res.success) {
                          const newLink = res.data.inviteLink || `prdagent://join/${res.data.inviteCode}`;
                          setSelected({ ...selected, inviteCode: res.data.inviteCode, inviteLink: newLink, inviteExpireAt: res.data.inviteExpireAt ?? null });
                          setItems((prev) => prev.map((x) => (x.groupId === selected.groupId ? { ...x, inviteCode: res.data.inviteCode, inviteLink: newLink, inviteExpireAt: res.data.inviteExpireAt ?? null } : x)));
                        }
                      } finally {
                        setActionBusy(false);
                      }
                    }}
                    title="重置邀请码"
                    aria-label="重置邀请码"
                  >
                    <RefreshCw size={16} />
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={actionBusy}
                    onClick={async () => {
                      if (!selected) return;
                      const okConfirm = await systemDialog.confirm({
                        title: '确认删除',
                        message: `确认删除群组「${selected.groupName}」？此操作会级联删除成员/缺失/消息。`,
                        tone: 'danger',
                        confirmText: '删除',
                        cancelText: '取消',
                      });
                      if (!okConfirm) return;
                      setActionBusy(true);
                      try {
                        const res = await deleteAdminGroup(selected.groupId);
                        if (res.success) {
                          setOpen(false);
                          setSelected(null);
                          await load();
                        }
                      } finally {
                        setActionBusy(false);
                      }
                    }}
                    title="删除群组"
                    aria-label="删除群组"
                  >
                    <Trash2 size={16} />
                    删除
                  </Button>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-auto rounded-[16px]" style={{ border: '1px solid var(--border-subtle)' }}>
                {tab === 'members' ? (
                  <table className="w-full text-sm">
                    <thead style={{ background: 'rgba(255,255,255,0.03)' }}>
                      <tr>
                        <th className="text-left px-4 py-3" style={{ color: 'var(--text-secondary)' }}>成员</th>
                        <th className="text-left px-4 py-3" style={{ color: 'var(--text-secondary)' }}>角色</th>
                        <th className="text-left px-4 py-3" style={{ color: 'var(--text-secondary)' }}>加入时间</th>
                        <th className="text-right px-4 py-3" style={{ color: 'var(--text-secondary)' }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((m) => (
                        <tr key={m.userId} className="hover:bg-white/2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                          <td className="px-4 py-3">
                            <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                              {m.username}
                              {m.isOwner ? <span className="ml-2"><Badge variant="featured">群主</Badge></span> : null}
                            </div>
                            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{m.displayName}</div>
                          </td>
                          <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>{m.role}</td>
                          <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>{fmtDate(m.joinedAt)}</td>
                          <td className="px-4 py-3 text-right">
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={!!m.isOwner || actionBusy}
                              onClick={async () => {
                                if (!selected) return;
                                if (m.isOwner) return;
                                const okConfirm = await systemDialog.confirm({
                                  title: '确认移除成员',
                                  message: `确认将成员「${m.displayName}」移出群组？`,
                                  tone: 'danger',
                                  confirmText: '移除',
                                  cancelText: '取消',
                                });
                                if (!okConfirm) return;
                                setActionBusy(true);
                                try {
                                  const res = await removeAdminGroupMember(selected.groupId, m.userId);
                                  if (res.success) {
                                    const mRes = await getAdminGroupMembers(selected.groupId);
                                    if (mRes.success) setMembers(mRes.data.map((x) => ({
                                      userId: x.userId,
                                      username: x.username,
                                      displayName: x.displayName,
                                      role: x.role,
                                      joinedAt: x.joinedAt,
                                      isOwner: x.isOwner,
                                    })));
                                    await load();
                                  }
                                } finally {
                                  setActionBusy(false);
                                }
                              }}
                            >
                              移除
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : tab === 'gaps' ? (
                  <>
                    <div className="p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>缺失列表</div>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={actionBusy}
                          onClick={async () => {
                            if (!selected) return;
                            setActionBusy(true);
                            try {
                              await generateAdminGapSummary(selected.groupId);
                            } finally {
                              setActionBusy(false);
                            }
                          }}
                        >
                          生成汇总报告
                        </Button>
                      </div>
                    </div>
                    <table className="w-full text-sm">
                    <thead style={{ background: 'rgba(255,255,255,0.03)' }}>
                      <tr>
                        <th className="text-left px-4 py-3" style={{ color: 'var(--text-secondary)' }}>问题</th>
                        <th className="text-left px-4 py-3" style={{ color: 'var(--text-secondary)' }}>类型</th>
                        <th className="text-left px-4 py-3" style={{ color: 'var(--text-secondary)' }}>状态</th>
                        <th className="text-right px-4 py-3" style={{ color: 'var(--text-secondary)' }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gaps.map((g) => (
                        <tr key={g.gapId} className="hover:bg-white/2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                          <td className="px-4 py-3">
                            <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>{g.question}</div>
                            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                              {g.askedBy ? `${g.askedBy.displayName}(${g.askedBy.role})` : '-'} · {fmtDate(g.askedAt)}
                            </div>
                          </td>
                          <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>{g.gapType}</td>
                          <td className="px-4 py-3">
                            {g.status === 'pending' ? <Badge variant="discount">待处理</Badge> : g.status === 'resolved' ? <Badge variant="success">已解决</Badge> : <Badge variant="subtle">已忽略</Badge>}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="inline-flex items-center gap-2">
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={actionBusy || g.status === 'resolved'}
                                onClick={async () => {
                                  if (!selected) return;
                                  setActionBusy(true);
                                  try {
                                    const res = await updateAdminGapStatus(selected.groupId, g.gapId, 'resolved');
                                    if (res.success) {
                                      const gapRes = await getAdminGroupGaps(selected.groupId, { page: 1, pageSize: 50 });
                                      if (gapRes.success) {
                                        setGaps(gapRes.data.items.map((x) => ({
                                          gapId: x.gapId,
                                          question: x.question,
                                          gapType: x.gapType,
                                          askedAt: x.askedAt,
                                          status: x.status,
                                          askedBy: x.askedBy ? { userId: x.askedBy.userId, displayName: x.askedBy.displayName, role: x.askedBy.role } : undefined,
                                        })));
                                      }
                                      await load();
                                    }
                                  } finally {
                                    setActionBusy(false);
                                  }
                                }}
                              >
                                标记已解决
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={actionBusy || g.status === 'ignored'}
                                onClick={async () => {
                                  if (!selected) return;
                                  setActionBusy(true);
                                  try {
                                    const res = await updateAdminGapStatus(selected.groupId, g.gapId, 'ignored');
                                    if (res.success) {
                                      const gapRes = await getAdminGroupGaps(selected.groupId, { page: 1, pageSize: 50 });
                                      if (gapRes.success) {
                                        setGaps(gapRes.data.items.map((x) => ({
                                          gapId: x.gapId,
                                          question: x.question,
                                          gapType: x.gapType,
                                          askedAt: x.askedAt,
                                          status: x.status,
                                          askedBy: x.askedBy ? { userId: x.askedBy.userId, displayName: x.askedBy.displayName, role: x.askedBy.role } : undefined,
                                        })));
                                      }
                                      await load();
                                    }
                                  } finally {
                                    setActionBusy(false);
                                  }
                                }}
                              >
                                忽略
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    </table>
                  </>
                ) : (
                  <div className="p-4 space-y-3">
                    <style>{`
                      .prd-md { font-size: 13px; line-height: 1.65; color: var(--text-secondary); }
                      .prd-md h1,.prd-md h2,.prd-md h3 { color: var(--text-primary); font-weight: 700; margin: 14px 0 8px; }
                      .prd-md h1 { font-size: 18px; }
                      .prd-md h2 { font-size: 16px; }
                      .prd-md h3 { font-size: 14px; }
                      .prd-md p { margin: 8px 0; }
                      .prd-md ul,.prd-md ol { margin: 8px 0; padding-left: 18px; }
                      .prd-md li { margin: 4px 0; }
                      .prd-md hr { border: 0; border-top: 1px solid rgba(255,255,255,0.10); margin: 12px 0; }
                      .prd-md blockquote { margin: 10px 0; padding: 6px 10px; border-left: 3px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.04); color: var(--text-secondary); border-radius: 10px; }
                      .prd-md a { color: rgba(147, 197, 253, 0.95); text-decoration: underline; }
                      .prd-md code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.10); padding: 0 6px; border-radius: 8px; }
                      .prd-md pre { background: rgba(0,0,0,0.28); border: 1px solid rgba(255,255,255,0.10); border-radius: 14px; padding: 12px; overflow: auto; }
                      .prd-md pre code { background: transparent; border: 0; padding: 0; }
                      .prd-md table { width: 100%; border-collapse: collapse; margin: 10px 0; }
                      .prd-md th,.prd-md td { border: 1px solid rgba(255,255,255,0.10); padding: 6px 8px; }
                      .prd-md th { color: var(--text-primary); background: rgba(255,255,255,0.03); }
                    `}</style>
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        已加载 {messages.length} / {messagesTotal || messages.length} 条
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={!selected || actionBusy || messagesClearing}
                          onClick={async () => {
                            if (!selected) return;
                            const ok = await systemDialog.confirm({
                              title: '确认清空群聊天数据',
                              message: `将删除群组「${selected.groupName}」的所有聊天消息（数据库 messages），且不可恢复。群组/成员/缺失不受影响。是否继续？`,
                              tone: 'danger',
                              confirmText: '清空',
                              cancelText: '取消',
                            });
                            if (!ok) return;
                            const ok2 = await systemDialog.confirm({
                              title: '再次确认',
                              message: '这会永久删除该群全部聊天消息，且不可恢复。是否继续？',
                              tone: 'danger',
                              confirmText: '确认清空',
                              cancelText: '取消',
                            });
                            if (!ok2) return;
                            setMessagesClearing(true);
                            try {
                              const res = await deleteAdminGroupMessages(selected.groupId);
                              if (res.success) {
                                setMessages([]);
                                setMessagesTotal(0);
                                setMessagesPage(1);
                                // 刷新群组列表的 messageCount/lastMessageAt
                                await load();
                              } else {
                                toast.error('清空失败', res.error?.message || '未知错误');
                              }
                            } finally {
                              setMessagesClearing(false);
                            }
                          }}
                          title="清空该群全部聊天消息（不可恢复）"
                          aria-label="清空该群全部聊天消息"
                        >
                          {messagesClearing ? '清空中...' : '清空群消息'}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={
                            !selected ||
                            messagesLoadingMore ||
                            messagesClearing ||
                            (messagesTotal > 0 ? messages.length >= messagesTotal : false)
                          }
                          onClick={async () => {
                            if (!selected) return;
                            if (messagesLoadingMore) return;
                            if (messagesClearing) return;
                            // 若后端总数未知，则允许至少再拉一次；若总数已知，按总数判断是否还能拉
                            if (messagesTotal > 0 && messages.length >= messagesTotal) return;
                            const nextPage = (messagesPage || 1) + 1;
                            setMessagesLoadingMore(true);
                            try {
                              const res = await getAdminGroupMessages(selected.groupId, { page: nextPage, pageSize: 20 });
                              if (res.success) {
                                setMessagesTotal(res.data.total ?? messagesTotal);
                                setMessagesPage(nextPage);
                                const mapped = res.data.items.map((m) => ({
                                  id: m.id,
                                  sessionId: m.sessionId,
                                  role: m.role,
                                  senderId: m.senderId ?? null,
                                  senderName: (m as any).senderName ?? null,
                                  senderRole: (m as any).senderRole ?? null,
                                  content: m.content,
                                  llmRequestId: m.llmRequestId ?? null,
                                  timestamp: m.timestamp,
                                  tokenUsage: m.tokenUsage ?? null,
                                }));
                                // 追加并按 id 去重（避免后端排序/分页边界变化导致重复）
                                setMessages((prev) => {
                                  const seen = new Set(prev.map((x) => x.id));
                                  const appended = mapped.filter((x) => !seen.has(x.id));
                                  return [...prev, ...appended];
                                });
                              }
                            } finally {
                              setMessagesLoadingMore(false);
                            }
                          }}
                          title="加载更多消息（按时间倒序分页）"
                          aria-label="加载更多消息"
                        >
                          {messagesLoadingMore ? '加载中...' : '加载更多'}
                        </Button>
                      </div>
                    </div>
                    {messages.map((m) => (
                      (() => {
                        const isAi = m.role === 'Assistant';
                        const titleColor = isAi ? 'rgba(147, 197, 253, 0.95)' : 'rgba(252, 165, 165, 0.95)';
                        const box = isAi
                          ? { background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.18)' }
                          : { background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.18)' };
                        const rid = (m.llmRequestId ?? '').trim();
                        const senderLabel = (() => {
                          if (isAi) return 'AI';
                          const name = String(m.senderName ?? '').trim();
                          const id = String(m.senderId ?? '').trim();
                          const role = String(m.senderRole ?? '').trim();
                          const roleZh =
                            role === 'ADMIN' ? '超级管理员' :
                            role === 'PM' ? '产品经理' :
                            role === 'DEV' ? '开发者' :
                            role === 'QA' ? '测试' : '';
                          const who = name || id;
                          return who ? `用户（${who}${roleZh ? ` · ${roleZh}` : ''}）` : '用户';
                        })();
                        return (
                      <div
                        key={m.id}
                        className="rounded-[16px] p-4"
                        style={box}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold" style={{ color: titleColor }}>
                              {senderLabel} <span className="text-xs font-normal" style={{ color: 'var(--text-muted)' }}>{fmtDate(m.timestamp)}</span>
                            </div>
                            <div className="mt-2 text-sm break-words">
                              <MessageMarkdown content={m.content} />
                            </div>
                          </div>
                          <div className="shrink-0 flex flex-col items-end gap-2">
                            {rid ? (
                              <button
                                type="button"
                                className="text-[11px] font-semibold rounded-full px-2.5 h-6 inline-flex items-center"
                                style={{
                                  color: 'rgba(147, 197, 253, 0.95)',
                                  border: '1px solid rgba(59,130,246,0.28)',
                                  background: 'rgba(59,130,246,0.10)',
                                }}
                                title={`查看本次 LLM 调用请求详情：${rid}`}
                                onClick={() => {
                                  setLlmDetailRequestId(rid);
                                  setLlmDetailOpen(true);
                                }}
                              >
                                requestId: {rid.length > 10 ? `${rid.slice(0, 10)}…` : rid}
                              </button>
                            ) : null}
                            {m.tokenUsage ? (
                              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                tokens: in {m.tokenUsage.input} / out {m.tokenUsage.output}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                        );
                      })()
                    ))}
                  </div>
                )}
              </div>

              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                提示：PRD 原文不落盘；此处展示的是群组/成员/缺失与消息数据（将按后端落库与脱敏策略实现）。
              </div>
            </div>
          )
        }
      />

      <LlmRequestDetailDialog
        open={llmDetailOpen}
        onOpenChange={(v) => {
          setLlmDetailOpen(v);
          if (!v) setLlmDetailRequestId(null);
        }}
        requestId={llmDetailRequestId}
        jumpToLogsHref={llmDetailRequestId ? `/logs?tab=llm&requestId=${encodeURIComponent(llmDetailRequestId)}` : undefined}
      />

      <Dialog
        open={simulateDialogOpen}
        onOpenChange={(v) => {
          setSimulateDialogOpen(v);
          if (!v) {
            setSimulateContent('');
            setSimulateTriggerAi(false);
          }
        }}
        title="模拟发送消息"
        description={selected ? `向群组「${selected.groupName}」发送测试消息` : '发送测试消息'}
        maxWidth={480}
        content={
          <div className="flex flex-col gap-4">
            <div>
              <label className="text-sm font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>
                消息内容
              </label>
              <textarea
                className="w-full px-3 py-2 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                style={{
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-primary)',
                  minHeight: 120,
                }}
                placeholder="输入测试消息内容..."
                value={simulateContent}
                onChange={(e) => setSimulateContent(e.target.value)}
                disabled={simulateBusy}
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="triggerAi"
                checked={simulateTriggerAi}
                onChange={(e) => setSimulateTriggerAi(e.target.checked)}
                disabled={simulateBusy}
                className="w-4 h-4 rounded cursor-pointer"
              />
              <label htmlFor="triggerAi" className="text-sm cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                触发 AI 回复
              </label>
            </div>
            <div className="flex justify-end gap-2 mt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSimulateDialogOpen(false)}
                disabled={simulateBusy}
              >
                取消
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={simulateBusy || !simulateContent.trim()}
                onClick={async () => {
                  if (!selected || !simulateContent.trim()) return;
                  setSimulateBusy(true);
                  try {
                    const res = await simulateMessage({
                      groupId: selected.groupId,
                      content: simulateContent.trim(),
                      triggerAiReply: simulateTriggerAi,
                    });
                    if (res.success) {
                      toast.success('发送成功', `消息已发送，seq=${res.data.groupSeq}${res.data.triggerAiReply ? '，AI 回复已触发（异步）' : ''}`);
                      setSimulateDialogOpen(false);
                      setSimulateContent('');
                      setSimulateTriggerAi(false);
                    } else {
                      toast.error('发送失败', res.error?.message || '未知错误');
                    }
                  } finally {
                    setSimulateBusy(false);
                  }
                }}
              >
                {simulateBusy ? '发送中...' : '发送'}
              </Button>
            </div>
          </div>
        }
      />
    </div>
  );
}


