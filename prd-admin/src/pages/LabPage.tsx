import { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { adminImpersonate, getUsers, isMockMode } from '@/services';
import type { AdminUser, UserRole } from '@/types/admin';
import type { ApiResponse } from '@/types/api';

type Actor = {
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
  token: string;
  expiresIn: number;
  issuedAt: number;
};

function getApiBaseUrl() {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:5000';
  return raw.trim().replace(/\/+$/, '');
}

function joinUrl(base: string, path: string) {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  if (!b) return `/${p}`;
  return `${b}/${p}`;
}

async function tryParseJson(text: string): Promise<unknown> {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isApiResponseLike(x: unknown): x is { success: boolean; data: unknown; error: unknown } {
  if (!x || typeof x !== 'object') return false;
  const obj = x as any;
  return typeof obj.success === 'boolean' && 'data' in obj && 'error' in obj;
}

async function apiRequestWithToken<T>(
  token: string | null,
  path: string,
  options?: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; auth?: boolean; accept?: string }
): Promise<ApiResponse<T>> {
  const method = options?.method ?? 'GET';
  const url = joinUrl(getApiBaseUrl(), path);
  const headers: Record<string, string> = { Accept: options?.accept ?? 'application/json' };
  const auth = options?.auth ?? true;
  if (auth && token) headers.Authorization = `Bearer ${token}`;

  let body: string | undefined;
  if (options && 'body' in options) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body ?? {});
  }

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body });
  } catch (e) {
    return { success: false, data: null as any, error: { code: 'NETWORK_ERROR', message: e instanceof Error ? e.message : '网络错误' } };
  }

  const text = await res.text();
  const json = await tryParseJson(text);
  if (isApiResponseLike(json)) return json as ApiResponse<T>;

  if (!res.ok) {
    const message = (json as any)?.error?.message || (json as any)?.message || text || `HTTP ${res.status} ${res.statusText}`;
    const code = (json as any)?.error?.code || (res.status === 401 ? 'UNAUTHORIZED' : 'UNKNOWN');
    return { success: false, data: null as any, error: { code, message } };
  }

  return { success: true, data: (json as T) ?? (null as any), error: null };
}

async function readSseStream(
  res: Response,
  onEvent: (evt: { event?: string; data?: string }) => void,
  signal: AbortSignal
): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder('utf-8');
  let buf = '';
  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    while (true) {
      const idx = buf.indexOf('\n\n');
      if (idx < 0) break;
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      const lines = raw.split('\n').map((l) => l.trimEnd());
      let event: string | undefined;
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
        if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
      }
      onEvent({ event, data: dataLines.length ? dataLines.join('\n') : undefined });
    }
  }
}

export default function LabPage() {
  // 用户检索（用于选择演员）
  const [userSearch, setUserSearch] = useState('');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);

  // 演员（被冒充的用户）
  const [actors, setActors] = useState<Actor[]>([]);
  const [activeActorId, setActiveActorId] = useState<string>('');

  const activeActor = useMemo(() => actors.find((a) => a.userId === activeActorId) ?? null, [actors, activeActorId]);

  // 群组
  const [groupName, setGroupName] = useState('');
  const [groupId, setGroupId] = useState<string>('');
  const [inviteCode, setInviteCode] = useState<string>('');
  const [inviteLink, setInviteLink] = useState<string>('');
  const [groupInfoJson, setGroupInfoJson] = useState<string>('');

  // PRD
  const [prdContent, setPrdContent] = useState<string>('');
  const [documentId, setDocumentId] = useState<string>('');
  const [uploadSessionId, setUploadSessionId] = useState<string>('');

  // 会话
  const [sessionId, setSessionId] = useState<string>('');

  // Chat SSE
  const [chatInput, setChatInput] = useState('');
  const [chatText, setChatText] = useState('');
  const [chatMeta, setChatMeta] = useState<string>('');
  const chatAbortRef = useRef<AbortController | null>(null);

  // Guide SSE
  const [guideLog, setGuideLog] = useState<string>('');
  const guideAbortRef = useRef<AbortController | null>(null);

  // Gaps
  const [gapsJson, setGapsJson] = useState<string>('');
  const [gapSummaryJson, setGapSummaryJson] = useState<string>('');

  const loadUsers = async () => {
    setUsersLoading(true);
    try {
      const res = await getUsers({ page: 1, pageSize: 20, search: userSearch.trim() || undefined });
      if (res.success) setUsers(res.data.items);
    } finally {
      setUsersLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addActor = async (u: AdminUser) => {
    const res = await adminImpersonate(u.userId, 900);
    if (!res.success) {
      alert(res.error?.message || '冒充失败');
      return;
    }

    const a: Actor = {
      userId: res.data.user.userId,
      username: res.data.user.username,
      displayName: res.data.user.displayName,
      role: res.data.user.role,
      token: res.data.accessToken,
      expiresIn: res.data.expiresIn,
      issuedAt: Date.now(),
    };

    setActors((prev) => {
      const next = prev.filter((x) => x.userId !== a.userId).concat(a);
      return next;
    });
    setActiveActorId((prev) => prev || a.userId);
  };

  const createGroup = async () => {
    if (!activeActor) {
      alert('请先选择一个演员');
      return;
    }

    const body: any = {
      groupName: groupName.trim() || undefined,
      prdDocumentId: documentId || undefined,
    };

    const res = await apiRequestWithToken<any>(activeActor.token, '/api/v1/groups', { method: 'POST', body });
    setGroupInfoJson(JSON.stringify(res, null, 2));
    if (!res.success) return;

    const g = res.data;
    setGroupId(g.groupId);
    setInviteCode(g.inviteCode);
    setInviteLink(g.inviteLink);
  };

  const joinGroupAsActor = async (a: Actor) => {
    if (!groupId || !inviteCode) {
      alert('请先创建群组');
      return;
    }
    const res = await apiRequestWithToken<any>(a.token, '/api/v1/groups/join', {
      method: 'POST',
      body: { inviteCode, userRole: a.role },
    });
    if (!res.success) {
      alert(res.error?.message || '加入失败');
      return;
    }
    setGroupInfoJson(JSON.stringify(res, null, 2));
  };

  const uploadPrd = async () => {
    if (!prdContent.trim()) {
      alert('请粘贴 PRD 内容');
      return;
    }

    const res = await apiRequestWithToken<any>(activeActor?.token ?? null, '/api/v1/documents', {
      method: 'POST',
      body: { content: prdContent },
      auth: false, // 后端该接口不强制鉴权
    });

    setGroupInfoJson(JSON.stringify(res, null, 2));
    if (!res.success) return;

    setDocumentId(res.data.document?.id ?? '');
    setUploadSessionId(res.data.sessionId ?? '');
  };

  const bindPrdToGroup = async () => {
    if (!activeActor) return alert('请先选择一个演员');
    if (!groupId) return alert('请先创建群组');
    if (!documentId) return alert('请先上传 PRD');

    const res = await apiRequestWithToken<any>(activeActor.token, `/api/v1/groups/${encodeURIComponent(groupId)}/prd`, {
      method: 'PUT',
      body: { prdDocumentId: documentId },
    });
    setGroupInfoJson(JSON.stringify(res, null, 2));
  };

  const unbindPrdFromGroup = async () => {
    if (!activeActor) return alert('请先选择一个演员');
    if (!groupId) return alert('请先创建群组');
    const res = await apiRequestWithToken<any>(activeActor.token, `/api/v1/groups/${encodeURIComponent(groupId)}/prd`, {
      method: 'DELETE',
    });
    setGroupInfoJson(JSON.stringify(res, null, 2));
  };

  const openSession = async () => {
    if (!activeActor) return alert('请先选择一个演员');
    if (!groupId) return alert('请先创建群组');

    const res = await apiRequestWithToken<any>(activeActor.token, `/api/v1/groups/${encodeURIComponent(groupId)}/session`, {
      method: 'POST',
      body: { userRole: activeActor.role },
    });
    setGroupInfoJson(JSON.stringify(res, null, 2));
    if (!res.success) return;
    setSessionId(res.data.sessionId);
  };

  const stopChat = () => {
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
  };

  const sendChat = async () => {
    if (!activeActor) return alert('请先选择一个演员');
    if (!sessionId) return alert('请先打开会话');
    if (!chatInput.trim()) return;

    stopChat();
    setChatText('');
    setChatMeta('');
    const ac = new AbortController();
    chatAbortRef.current = ac;

    const url = joinUrl(getApiBaseUrl(), `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${activeActor.token}`,
      },
      body: JSON.stringify({ content: chatInput, role: activeActor.role }),
      signal: ac.signal,
    });

    if (!res.ok) {
      const t = await res.text();
      setChatMeta(t || `HTTP ${res.status}`);
      return;
    }

    await readSseStream(
      res,
      (evt) => {
        if (!evt.data) return;
        try {
          const obj = JSON.parse(evt.data);
          if (obj.type === 'delta' && typeof obj.content === 'string') {
            setChatText((p) => p + obj.content);
          } else if (obj.type === 'done') {
            setChatMeta(JSON.stringify(obj, null, 2));
          } else if (obj.type === 'error') {
            setChatMeta(JSON.stringify(obj, null, 2));
          }
        } catch {
          setChatMeta(evt.data);
        }
      },
      ac.signal
    );
  };

  const stopGuide = () => {
    guideAbortRef.current?.abort();
    guideAbortRef.current = null;
  };

  const startGuide = async () => {
    if (!activeActor) return alert('请先选择一个演员');
    if (!sessionId) return alert('请先打开会话');

    stopGuide();
    setGuideLog('');
    const ac = new AbortController();
    guideAbortRef.current = ac;

    const url = joinUrl(getApiBaseUrl(), `/api/v1/sessions/${encodeURIComponent(sessionId)}/guide/start`);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${activeActor.token}`,
      },
      body: JSON.stringify({ role: activeActor.role }),
      signal: ac.signal,
    });

    if (!res.ok) {
      const t = await res.text();
      setGuideLog(t || `HTTP ${res.status}`);
      return;
    }

    await readSseStream(
      res,
      (evt) => {
        if (!evt.data) return;
        setGuideLog((p) => (p ? `${p}\n` : '') + evt.data);
      },
      ac.signal
    );
  };

  const loadGaps = async () => {
    if (!activeActor) return alert('请先选择一个演员');
    if (!groupId) return alert('请先创建群组');
    const res = await apiRequestWithToken<any>(activeActor.token, `/api/v1/groups/${encodeURIComponent(groupId)}/gaps?page=1&pageSize=50`, {
      method: 'GET',
    });
    setGapsJson(JSON.stringify(res, null, 2));
  };

  const generateGapSummary = async () => {
    if (!activeActor) return alert('请先选择一个演员');
    if (!groupId) return alert('请先创建群组');
    // 后端会从 group 读取 PRD 文档内容，如果未绑定会返回文档不存在
    const res = await apiRequestWithToken<any>(activeActor.token, `/api/v1/groups/${encodeURIComponent(groupId)}/gaps/summary-report`, {
      method: 'POST',
      body: {},
    });
    setGapSummaryJson(JSON.stringify(res, null, 2));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
            实验室
          </div>
          <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            模拟 Desktop：建群/邀请/上传绑定PRD/会话/聊天与引导（SSE）/缺失处理
          </div>
        </div>
        {isMockMode ? <Badge variant="subtle">mock</Badge> : null}
      </div>

      <div className="grid gap-5" style={{ gridTemplateColumns: '420px 1fr' }}>
        <div className="space-y-5">
          <Card>
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                演员（冒充用户）
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => loadUsers()}
                disabled={usersLoading}
                title="刷新用户列表"
              >
                刷新
              </Button>
            </div>

            <div className="mt-3 flex gap-3">
              <input
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                className="h-10 flex-1 rounded-[14px] px-3 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                placeholder="搜索用户名/昵称"
              />
              <Button
                onClick={() => loadUsers()}
                disabled={usersLoading}
              >
                搜索
              </Button>
            </div>

            <div className="mt-4 space-y-2">
              {users.length === 0 ? (
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  暂无用户
                </div>
              ) : (
                users.map((u) => (
                  <div
                    key={u.userId}
                    className="flex items-center justify-between rounded-[14px] px-3 py-2"
                    style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                        {u.displayName}（{u.username}）
                      </div>
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {u.userId} · {u.role} · {u.status}
                      </div>
                    </div>
                    <Button size="sm" onClick={() => addActor(u)}>
                      添加
                    </Button>
                  </div>
                ))
              )}
            </div>

            <div className="mt-4">
              <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
                当前操作演员
              </div>
              <select
                value={activeActorId}
                onChange={(e) => setActiveActorId(e.target.value)}
                className="h-10 w-full rounded-[14px] px-3 text-sm"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
              >
                <option value="">请选择</option>
                {actors.map((a) => (
                  <option key={a.userId} value={a.userId}>
                    {a.displayName}（{a.role}）
                  </option>
                ))}
              </select>
              {activeActor ? (
                <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  token 有效期：{Math.max(0, Math.floor((activeActor.issuedAt + activeActor.expiresIn * 1000 - Date.now()) / 1000))} 秒
                </div>
              ) : null}
            </div>
          </Card>

          <Card>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              群组
            </div>

            <div className="mt-3 grid gap-3" style={{ gridTemplateColumns: '1fr 120px' }}>
              <input
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                className="h-10 rounded-[14px] px-3 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                placeholder="群组名称（可选）"
              />
              <Button onClick={createGroup} disabled={!activeActor}>
                创建
              </Button>
            </div>

            <div className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
              groupId：{groupId || '-'}
            </div>
            <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              inviteCode：{inviteCode || '-'}
            </div>
            <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              inviteLink：{inviteLink || '-'}
            </div>

            <div className="mt-4">
              <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
                用其他演员加入群组
              </div>
              <div className="flex flex-wrap gap-2">
                {actors
                  .filter((a) => a.userId !== activeActorId)
                  .map((a) => (
                    <Button key={a.userId} size="sm" variant="ghost" onClick={() => joinGroupAsActor(a)} disabled={!inviteCode}>
                      {a.displayName}（{a.role}）加入
                    </Button>
                  ))}
              </div>
            </div>
          </Card>

          <Card>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              PRD（上传与绑定）
            </div>

            <textarea
              value={prdContent}
              onChange={(e) => setPrdContent(e.target.value)}
              className="mt-3 h-32 w-full rounded-[14px] px-3 py-2 text-sm outline-none"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
              placeholder="粘贴 Markdown PRD 内容（不落盘，仅缓存）"
            />

            <div className="mt-3 flex gap-2">
              <Button onClick={uploadPrd}>上传PRD</Button>
              <Button variant="ghost" onClick={bindPrdToGroup} disabled={!activeActor || !groupId || !documentId}>
                绑定到群组
              </Button>
              <Button variant="ghost" onClick={unbindPrdFromGroup} disabled={!activeActor || !groupId}>
                解绑
              </Button>
            </div>

            <div className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
              documentId：{documentId || '-'}
            </div>
            <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              uploadSessionId：{uploadSessionId || '-'}
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  会话与 SSE
                </div>
                <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  需要群组已绑定 PRD 才能打开会话
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={openSession} disabled={!activeActor || !groupId}>
                  打开会话
                </Button>
                <Button variant="ghost" onClick={() => { stopChat(); stopGuide(); }}>
                  停止流
                </Button>
              </div>
            </div>

            <div className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
              sessionId：{sessionId || '-'}
            </div>

            <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: '1fr 120px' }}>
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                className="h-10 rounded-[14px] px-3 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                placeholder="输入一条消息（SSE流式）"
              />
              <Button onClick={sendChat} disabled={!activeActor || !sessionId}>
                发送
              </Button>
            </div>

            <div className="mt-3 grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <div className="rounded-[14px] p-3" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}>
                <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
                  Chat 输出
                </div>
                <pre className="text-xs whitespace-pre-wrap break-words" style={{ color: 'var(--text-primary)' }}>
                  {chatText || '（等待输出）'}
                </pre>
                {chatMeta ? (
                  <pre className="mt-3 text-xs whitespace-pre-wrap break-words" style={{ color: 'var(--text-muted)' }}>
                    {chatMeta}
                  </pre>
                ) : null}
              </div>

              <div className="rounded-[14px] p-3" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}>
                <div className="flex items-center justify-between">
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    引导（Guide SSE）
                  </div>
                  <Button size="sm" variant="ghost" onClick={startGuide} disabled={!activeActor || !sessionId}>
                    启动
                  </Button>
                </div>
                <pre className="mt-2 text-xs whitespace-pre-wrap break-words" style={{ color: 'var(--text-primary)' }}>
                  {guideLog || '（等待输出）'}
                </pre>
              </div>
            </div>
          </Card>

          <Card>
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                内容缺失（Gaps）
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={loadGaps} disabled={!activeActor || !groupId}>
                  拉取列表
                </Button>
                <Button size="sm" variant="ghost" onClick={generateGapSummary} disabled={!activeActor || !groupId}>
                  生成汇总
                </Button>
              </div>
            </div>

            <div className="mt-3 grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <pre className="text-xs whitespace-pre-wrap break-words rounded-[14px] p-3" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)', color: 'var(--text-primary)' }}>
                {gapsJson || '（暂无）'}
              </pre>
              <pre className="text-xs whitespace-pre-wrap break-words rounded-[14px] p-3" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)', color: 'var(--text-primary)' }}>
                {gapSummaryJson || '（暂无）'}
              </pre>
            </div>
          </Card>

          <Card>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              原始返回（最近一次）
            </div>
            <pre className="mt-3 text-xs whitespace-pre-wrap break-words rounded-[14px] p-3" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)', color: 'var(--text-primary)' }}>
              {groupInfoJson || '（暂无）'}
            </pre>
          </Card>
        </div>
      </div>
    </div>
  );
}

