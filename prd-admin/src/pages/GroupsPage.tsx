import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { Dialog } from '@/components/ui/Dialog';
import {
  deleteAdminGroup,
  generateAdminGapSummary,
  getAdminGroupGaps,
  getAdminGroupMembers,
  getAdminGroupMessages,
  getAdminGroups,
  regenerateAdminGroupInvite,
  removeAdminGroupMember,
  updateAdminGapStatus,
} from '@/services';
import { Trash2, RefreshCw, Copy, Search, Users2, MessageSquareText, AlertTriangle } from 'lucide-react';

type GroupRow = {
  groupId: string;
  groupName: string;
  owner?: { userId: string; username: string; displayName: string };
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
  content: string;
  timestamp: string;
  tokenUsage?: { input: number; output: number } | null;
};

function fmtDate(v?: string | null) {
  if (!v) return '-';
  return v;
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
  const [actionBusy, setActionBusy] = useState(false);

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
            owner: g.owner ? { userId: g.owner.userId, username: g.owner.username, displayName: g.owner.displayName } : undefined,
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
    const msgRes = await getAdminGroupMessages(g.groupId, { page: 1, pageSize: 20 });
    if (msgRes.success) {
      setMessages(
        msgRes.data.items.map((m) => ({
          id: m.id,
          sessionId: m.sessionId,
          role: m.role,
          senderId: m.senderId ?? null,
          content: m.content,
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
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>群组管理</div>
          <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>共 {total} 个群组</div>
        </div>
      </div>

      <Card>
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

          <select
            value={inviteStatus}
            onChange={(e) => {
              setInviteStatus(e.target.value as any);
              setPage(1);
            }}
            className="h-10 rounded-[14px] px-3 text-sm"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
          >
            <option value="all">邀请状态</option>
            <option value="valid">有效</option>
            <option value="expired">已过期</option>
          </select>

          {null}
        </div>

        <div className="mt-5 overflow-hidden rounded-[16px]" style={{ border: '1px solid var(--border-subtle)' }}>
          <table className="w-full text-sm">
            <thead style={{ background: 'rgba(255,255,255,0.03)' }}>
              <tr>
                <th className="text-left px-4 py-3" style={{ color: 'var(--text-secondary)' }}>群组</th>
                <th className="text-left px-4 py-3" style={{ color: 'var(--text-secondary)' }}>PRD</th>
                <th className="text-right px-4 py-3" style={{ color: 'var(--text-secondary)' }}>成员</th>
                <th className="text-right px-4 py-3" style={{ color: 'var(--text-secondary)' }}>消息</th>
                <th className="text-right px-4 py-3" style={{ color: 'var(--text-secondary)' }}>待处理缺失</th>
                <th className="text-left px-4 py-3" style={{ color: 'var(--text-secondary)' }}>邀请</th>
                <th className="text-right px-4 py-3" style={{ color: 'var(--text-secondary)' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center" style={{ color: 'var(--text-muted)' }}>暂无数据</td>
                </tr>
              ) : (
                items.map((g) => (
                  <tr key={g.groupId} className="hover:bg-white/2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <td className="px-4 py-3">
                      <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>{g.groupName}</div>
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{g.groupId}</div>
                      {g.owner && (
                        <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                          群主：{g.owner.displayName}（{g.owner.username}）
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {g.prdTitle ? (
                        <div className="text-sm font-semibold truncate max-w-[320px]" style={{ color: 'var(--text-primary)' }}>
                          {g.prdTitle}
                        </div>
                      ) : (
                        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>文档已过期/未快照</div>
                      )}
                      <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>创建：{fmtDate(g.createdAt)}</div>
                    </td>
                    <td className="px-4 py-3 text-right" style={{ color: 'var(--text-secondary)' }}>{g.memberCount}</td>
                    <td className="px-4 py-3 text-right" style={{ color: 'var(--accent-green)' }}>{g.messageCount ?? 0}</td>
                    <td
                      className="px-4 py-3 text-right"
                      style={{ color: (g.pendingGapCount ?? 0) > 0 ? 'rgba(245,158,11,0.95)' : 'rgba(247,247,251,0.45)' }}
                    >
                      {g.pendingGapCount ?? 0}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <code className="text-xs" style={{ color: 'var(--text-secondary)' }}>{g.inviteCode}</code>
                        {g.inviteExpireAt ? <Badge variant="new">可能已过期</Badge> : <Badge variant="success">长期有效</Badge>}
                      </div>
                      <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>到期：{fmtDate(g.inviteExpireAt)}</div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-2">
                        <Button variant="secondary" size="sm" onClick={() => openDetail(g)}>
                          <Users2 size={16} />
                          详情
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => onCopy(g.inviteLink)} title="复制邀请链接" aria-label="复制邀请链接">
                          <Copy size={16} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
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
      </Card>

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
                      const okConfirm = window.confirm(`确认删除群组「${selected.groupName}」？此操作会级联删除成员/缺失/消息。`);
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
                                const okConfirm = window.confirm(`确认将成员「${m.displayName}」移出群组？`);
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
                    {messages.map((m) => (
                      <div
                        key={m.id}
                        className="rounded-[16px] p-4"
                        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)' }}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                              {m.role === 'Assistant' ? 'AI' : '用户'} <span className="text-xs font-normal" style={{ color: 'var(--text-muted)' }}>{fmtDate(m.timestamp)}</span>
                            </div>
                            <div className="mt-2 text-sm whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary)' }}>
                              {m.content}
                            </div>
                          </div>
                          {m.tokenUsage ? (
                            <div className="text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>
                              tokens: in {m.tokenUsage.input} / out {m.tokenUsage.output}
                            </div>
                          ) : null}
                        </div>
                      </div>
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
    </div>
  );
}


