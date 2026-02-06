import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '../../lib/tauri';
import { isSystemErrorCode } from '../../lib/systemError';
import { useAuthStore } from '../../stores/authStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useGroupListStore } from '../../stores/groupListStore';
import { useMessageStore } from '../../stores/messageStore';
import type { ApiResponse, Document, Session, UserRole } from '../../types';
import GroupList from '../Group/GroupList';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { extractMarkdownTitle, isMeaninglessName, normalizeCandidateName, stripFileExtension } from '../utils/nameHeuristics';

export default function Sidebar() {
  const { user, logout } = useAuthStore();
  const { setSession, activeGroupId, documentLoaded, document: prdDocument, mode, sessionId, setMode, openPrdPreviewPage } = useSessionStore();
  const { loadGroups } = useGroupListStore();
  const clearCurrentContext = useMessageStore((s) => s.clearCurrentContext);
  const stopStreaming = useMessageStore((s) => s.stopStreaming);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [joinInput, setJoinInput] = useState('');
  const [groupNameInput, setGroupNameInput] = useState('');
  const [busy, setBusy] = useState<null | 'join' | 'create' | 'upload'>(null);
  const [inlineError, setInlineError] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const createPrdInputRef = useRef<HTMLInputElement | null>(null);
  const [createPrdFileName, setCreatePrdFileName] = useState<string>('');
  const [createPrdContent, setCreatePrdContent] = useState<string>('');

  const COLLAPSED_WIDTH = 56; // Tailwind w-14
  const DEFAULT_EXPANDED_WIDTH = 224; // Tailwind w-56
  const MIN_EXPANDED_WIDTH = 180;
  const MAX_EXPANDED_WIDTH = 420;
  const SIDEBAR_WIDTH_KEY = 'prdAgent.sidebarWidth';

  const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

  const [expandedWidth, setExpandedWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n)) return clamp(n, MIN_EXPANDED_WIDTH, MAX_EXPANDED_WIDTH);
    } catch {
      // ignore
    }
    return DEFAULT_EXPANDED_WIDTH;
  });

  const [isResizing, setIsResizing] = useState(false);
  const resizeStateRef = useRef<{ startX: number; startW: number } | null>(null);
  const currentWidth = isCollapsed ? COLLAPSED_WIDTH : expandedWidth;

  useEffect(() => {
    if (createOpen) {
      setGroupNameInput('');
      setInlineError('');
      setCreatePrdFileName('');
      setCreatePrdContent('');
    }
  }, [createOpen]);

  useEffect(() => {
    if (joinOpen) {
      setJoinInput('');
      setInlineError('');
    }
  }, [joinOpen]);

  useEffect(() => {
    // 折叠状态不写入；拖拽中也不频繁写入（在 pointerup 时落盘）
    if (isCollapsed) return;
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(expandedWidth));
    } catch {
      // ignore
    }
  }, [expandedWidth, isCollapsed]);

  const canSubmit = useMemo(() => !busy, [busy]);

  const openKnowledge = useCallback(async () => {
    setMode('Knowledge');
    void sessionId;
  }, [mode, sessionId, setMode]);

  const openDefect = useCallback(() => {
    setMode('Defect');
  }, [setMode]);

  const openPrdPreview = useCallback(() => {
    if (!documentLoaded || !prdDocument) return;
    openPrdPreviewPage();
  }, [documentLoaded, prdDocument, openPrdPreviewPage]);

  const openBindFromKnowledge = useCallback(() => {
    window.dispatchEvent(new Event('prdAgent:openBindPrdPicker'));
  }, []);

  const openGroupSession = async (groupId: string) => {
    const role: UserRole =
      user?.role === 'DEV' || user?.role === 'QA' || user?.role === 'PM'
        ? user.role
        : 'PM';

    const openResp = await invoke<ApiResponse<{ sessionId: string; groupId: string; documentId: string; currentRole: string }>>(
      'open_group_session',
      { groupId, userRole: role }
    );
    if (!openResp.success || !openResp.data) return;

    const docResp = await invoke<ApiResponse<Document>>('get_document', {
      documentId: openResp.data.documentId,
    });
    if (!docResp.success || !docResp.data) return;

    const session: Session = {
      sessionId: openResp.data.sessionId,
      groupId: openResp.data.groupId,
      documentId: openResp.data.documentId,
      currentRole: (openResp.data.currentRole as UserRole) || role,
      mode: 'QA',
    };

    setSession(session, docResp.data);
  };

  type GroupMemberInfo = { userId: string; isOwner: boolean };
  const [activeOwner, setActiveOwner] = useState<boolean>(false);
  const [, setActiveOwnerLoading] = useState<boolean>(false);
  const isAdmin = user?.role === 'ADMIN';

  // 缓存已查询过的群主信息，避免重复请求
  const ownerCacheRef = useRef<Map<string, { isOwner: boolean; timestamp: number }>>(new Map());
  const OWNER_CACHE_TTL = 60_000; // 缓存 60 秒

  // 只在 activeGroupId 或 userId 变化时才刷新群主信息
  useEffect(() => {
    const gid = String(activeGroupId || '').trim();
    if (!gid) {
      setActiveOwner(false);
      return;
    }
    if (isAdmin) {
      setActiveOwner(true);
      return;
    }
    if (!user?.userId) {
      setActiveOwner(false);
      return;
    }

    // 检查缓存
    const cacheKey = `${gid}:${user.userId}`;
    const cached = ownerCacheRef.current.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < OWNER_CACHE_TTL) {
      setActiveOwner(cached.isOwner);
      return;
    }

    let cancelled = false;

    const fetchOwnerStatus = async () => {
      try {
        setActiveOwnerLoading(true);
        const resp = await invoke<ApiResponse<GroupMemberInfo[]>>('get_group_members', { groupId: gid });
        if (cancelled) return;
        if (!resp.success || !resp.data) {
          setActiveOwner(false);
          return;
        }
        const ok = resp.data.some((m) => m.userId === user.userId && m.isOwner);
        // 写入缓存
        ownerCacheRef.current.set(cacheKey, { isOwner: ok, timestamp: Date.now() });
        setActiveOwner(ok);
      } catch {
        if (!cancelled) setActiveOwner(false);
      } finally {
        if (!cancelled) setActiveOwnerLoading(false);
      }
    };

    void fetchOwnerStatus();

    return () => {
      cancelled = true;
    };
  }, [activeGroupId, isAdmin, user?.userId]); // 移除 groups 和 invoke 依赖

  const canReplacePrd = useMemo(() => {
    if (!activeGroupId) return false;
    return Boolean(isAdmin || activeOwner);
  }, [activeGroupId, activeOwner, isAdmin]);

  const handleJoinGroup = async () => {
    // Tauri 环境下 window.prompt 可能不弹，改为应用内输入
    setJoinOpen(true);
  };

  const submitJoin = async () => {
    setInlineError('');
    const trimmed = joinInput.trim();
    const code = trimmed.includes('prdagent://join/')
      ? trimmed.split('prdagent://join/')[1]?.split(/[?#/\\s]/)[0]
      : trimmed.split(/[?#/\\s]/)[0];
    if (!code) {
      setInlineError('请输入有效的邀请码或邀请链接');
      return;
    }

    const role: UserRole =
      user?.role === 'DEV' || user?.role === 'QA' || user?.role === 'PM'
        ? user.role
        : 'PM';

    try {
      setBusy('join');
      const resp = await invoke<ApiResponse<{ groupId: string }>>('join_group', {
        inviteCode: code,
        userRole: role,
      });

      if (!resp.success || !resp.data) {
        const errorCode = resp.error?.code ?? null;
        if (errorCode === 'UNAUTHORIZED') {
          logout();
          return;
        }
        if (!isSystemErrorCode(errorCode)) {
          setInlineError(resp.error?.message || '加入群组失败');
        }
        return;
      }

      // 加入群组后强制刷新列表
      await loadGroups({ force: true });
      await openGroupSession(resp.data.groupId);
      setJoinOpen(false);
    } catch (err) {
      console.error('Failed to join group:', err);
    } finally {
      setBusy(null);
    }
  };

  const handleCreateGroup = async () => {
    // Tauri 环境下 window.prompt 可能不弹，改为应用内输入
    setCreateOpen(true);
  };

  const submitCreate = async () => {
    setInlineError('');
    const explicitGroupName = groupNameInput.trim();
    const hasPrd = !!createPrdContent.trim();

    try {
      setBusy('create');
      if (hasPrd) {
        // 1) 上传 PRD
        const uploadResp = await invoke<ApiResponse<{ sessionId: string; document: Document }>>('upload_document', {
          content: createPrdContent,
        });
        if (!uploadResp.success || !uploadResp.data) {
          const errorCode = uploadResp.error?.code ?? null;
          if (errorCode === 'UNAUTHORIZED') {
            logout();
            return;
          }
          if (!isSystemErrorCode(errorCode)) {
            setInlineError(uploadResp.error?.message || '上传 PRD 失败');
          }
          return;
        }

        // 2) 决定群名：用户手动填写优先；否则文件名有意义用文件名；无意义则用文档标题或默认名称
        // 意图模型生成群名的逻辑已移到后端异步执行，不再阻塞创建流程
        let groupNameFinal = explicitGroupName;
        if (!groupNameFinal) {
          const base = createPrdFileName ? normalizeCandidateName(stripFileExtension(createPrdFileName)) : '';
          if (base && !isMeaninglessName(base)) {
            groupNameFinal = base;
          } else {
            groupNameFinal = extractMarkdownTitle(createPrdContent) || uploadResp.data.document.title || '';
          }
        }

        // 关键：如果算出来的是“占位/模板名”，不要当作用户自定义群名传给后端；
        // 否则后端会认为已经有群名，从而不会触发异步意图模型命名。
        if (!explicitGroupName) {
          const t = String(groupNameFinal || '').trim();
          const placeholder = new Set(['未命名文档', '产品需求文档', '需求文档', '产品文档', '文档', '未命名群组', '新建群组']);
          if (placeholder.has(t)) {
            groupNameFinal = '';
          }
        }

        const resp = await invoke<ApiResponse<{ groupId: string; inviteCode: string }>>('create_group', {
          prdDocumentId: uploadResp.data.document.id,
          groupName: groupNameFinal ? groupNameFinal : undefined,
        });

        if (!resp.success || !resp.data) {
          const errorCode = resp.error?.code ?? null;
          if (errorCode === 'UNAUTHORIZED') {
            logout();
            return;
          }
          if (!isSystemErrorCode(errorCode)) {
            setInlineError(resp.error?.message || '创建群组失败');
          }
          return;
        }

        // 创建群组后强制刷新列表
        await loadGroups({ force: true });
        await openGroupSession(resp.data.groupId);
        setCreateOpen(false);

        // 启动短期轮询以获取后台生成的群名（轮询 3 次，每次间隔 2 秒）
        for (let i = 0; i < 3; i++) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          await loadGroups({ force: true });
        }
        return;
      }

      // 未上传 PRD：仅创建空群
      const resp = await invoke<ApiResponse<{ groupId: string; inviteCode: string }>>('create_group', {
        prdDocumentId: undefined,
        groupName: explicitGroupName || undefined,
      });

      if (!resp.success || !resp.data) {
        const errorCode = resp.error?.code ?? null;
        if (errorCode === 'UNAUTHORIZED') {
          logout();
          return;
        }
        if (!isSystemErrorCode(errorCode)) {
          setInlineError(resp.error?.message || '创建群组失败');
        }
        return;
      }

      const inviteLink = `prdagent://join/${resp.data.inviteCode}`;
      alert(`群组创建成功\\n邀请码：${resp.data.inviteCode}\\n邀请链接：${inviteLink}`);

      // 创建群组后强制刷新列表
      await loadGroups({ force: true });
      setCreateOpen(false);

      // 启动短期轮询以获取后台生成的群名（轮询 3 次，每次间隔 2 秒）
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await loadGroups({ force: true });
      }
    } catch (err) {
      console.error('Failed to create group:', err);
    } finally {
      setBusy(null);
    }
  };

  const handleCreatePrdFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.md')) {
      setInlineError('仅支持 .md 格式文件');
      return;
    }
    try {
      const content = await file.text();
      setCreatePrdFileName(file.name);
      setCreatePrdContent(content);
    } catch {
      setInlineError('读取文件失败，请重试');
    }
  }, []);

  const uploadAndBindToActiveGroup = useCallback(async (content: string) => {
    if (!activeGroupId) {
      alert('请先选择一个群组');
      return;
    }

    try {
      setBusy('upload');
      // 本地先停流并清理“当前对话上下文”，避免替换 PRD 时 UI 串话
      try { stopStreaming(); } catch {}
      try { clearCurrentContext(null); } catch {}
      const uploadResp = await invoke<ApiResponse<{ sessionId: string; document: Document }>>('upload_document', {
        content,
      });
      if (!uploadResp.success || !uploadResp.data) {
        const errorCode = uploadResp.error?.code ?? null;
        if (errorCode === 'UNAUTHORIZED') {
          logout();
          return;
        }
        if (!isSystemErrorCode(errorCode)) {
          alert(uploadResp.error?.message || '上传 PRD 失败');
        }
        return;
      }

      const bindResp = await invoke<ApiResponse<any>>('bind_group_prd', {
        groupId: activeGroupId,
        prdDocumentId: uploadResp.data.document.id,
      });
      if (!bindResp.success) {
        const errorCode = bindResp.error?.code ?? null;
        if (!isSystemErrorCode(errorCode)) {
          alert(bindResp.error?.message || '绑定 PRD 失败');
        }
        return;
      }

      // 绑定 PRD 后强制刷新列表（群组名称可能变化）
      await loadGroups({ force: true });
      await openGroupSession(activeGroupId);
    } catch (err) {
      console.error('Failed to upload/bind PRD:', err);
    } finally {
      setBusy(null);
    }
  }, [activeGroupId, loadGroups, logout, openGroupSession]);

  const openBindPrdPicker = useCallback(() => {
    if (!activeGroupId) {
      alert('请先选择一个群组');
      return;
    }
    if (!canReplacePrd) {
      alert('仅群主/管理员可更换 PRD');
      return;
    }
    fileInputRef.current?.click();
  }, [activeGroupId, canReplacePrd]);

  const handleFileSelectForBind = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    // 注意：在部分 WebView 中，提前清空 value 会让 files 变空（“选了文件但无反应”）
    const file = input.files?.[0] ?? null;
    // 允许下次选择同名文件也触发 change
    input.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.md')) {
      alert('仅支持 .md 格式文件');
      return;
    }
    try {
      const content = await file.text();
      await uploadAndBindToActiveGroup(content);
    } catch (err) {
      console.error('Failed to read selected file:', err);
      alert('读取文件失败，请重试');
    }
  }, [uploadAndBindToActiveGroup]);

  useEffect(() => {
    const handler = () => openBindPrdPicker();
    window.addEventListener('prdAgent:openBindPrdPicker', handler as EventListener);
    return () => window.removeEventListener('prdAgent:openBindPrdPicker', handler as EventListener);
  }, [openBindPrdPicker]);

  const onResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (isCollapsed) return;
    // 仅主键拖拽
    if (typeof e.button === 'number' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    resizeStateRef.current = { startX: e.clientX, startW: expandedWidth };

    // 捕获指针，避免拖出 handle 后丢事件
    try {
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    // 拖拽中避免文字被选中，并显示列调整光标
    try {
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    } catch {
      // ignore
    }
  }, [expandedWidth, isCollapsed]);

  const onResizePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isResizing || isCollapsed) return;
    const s = resizeStateRef.current;
    if (!s) return;
    const delta = e.clientX - s.startX;
    setExpandedWidth(clamp(s.startW + delta, MIN_EXPANDED_WIDTH, MAX_EXPANDED_WIDTH));
  }, [isResizing, isCollapsed]);

  const endResize = useCallback(() => {
    if (!isResizing) return;
    setIsResizing(false);
    resizeStateRef.current = null;
    try {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    } catch {
      // ignore
    }
  }, [isResizing]);

  return (
    <aside
      className={`relative flex-shrink-0 border-r ui-glass-bar ${isResizing ? '' : 'transition-[width] duration-150'}`}
      style={{ width: `${currentWidth}px` }}
    >
      <div className="h-full flex flex-col">
        {/* 头部：群组标题 + 操作按钮 */}
        <div className="p-3 border-b border-black/10 dark:border-white/10 flex items-center justify-between">
          {!isCollapsed && (
            <>
              <h2 className="text-sm font-medium text-text-secondary">群组</h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsCollapsed(true)}
                  title="折叠侧边栏"
                  className="h-7 w-7 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-black/5 dark:hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/25"
                  style={{ outline: 'none' }}
                  onFocus={(e) => {
                    // 强制清除 WebView 默认焦点 outline（该环境下仅靠 class 不稳定）
                    (e.currentTarget as HTMLButtonElement).style.outline = 'none';
                  }}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>

                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      title="群组操作"
                      className="h-7 w-7 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-black/5 dark:hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/25"
                      style={{ outline: 'none' }}
                      onFocus={(e) => {
                        // 强制清除 WebView 默认焦点 outline（该环境下仅靠 class 不稳定）
                        (e.currentTarget as HTMLButtonElement).style.outline = 'none';
                      }}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      sideOffset={6}
                      align="end"
                      className="z-50 min-w-[140px] rounded-md ui-glass-panel p-1"
                    >
                      <DropdownMenu.Item
                        className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 outline-none"
                        onSelect={handleCreateGroup}
                      >
                        创建群组
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 outline-none"
                        onSelect={handleJoinGroup}
                      >
                        加入群组
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        className={`px-2 py-1.5 text-sm rounded outline-none ${
                          activeGroupId
                            ? (canReplacePrd ? 'cursor-pointer hover:bg-black/5 dark:hover:bg-white/5' : 'opacity-50 cursor-not-allowed')
                            : 'opacity-50 cursor-not-allowed'
                        }`}
                        onSelect={(e) => {
                          // Radix：disabled 场景下仍会触发 onSelect，因此这里做一次显式保护
                          e.preventDefault();
                          if (!activeGroupId || !canReplacePrd) return;
                          openBindPrdPicker();
                        }}
                      >
                        更换 PRD
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            </>
          )}
          {isCollapsed && (
            <button
              onClick={() => setIsCollapsed(false)}
              className="mx-auto p-1 rounded hover:bg-black/5 dark:hover:bg-white/5"
              title="展开侧边栏"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </div>

        {/* 群组列表 */}
        {!isCollapsed && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <GroupList />
          </div>
        )}

        {/* 知识库（侧栏下段，参考 VSCode 分区） */}
        {!isCollapsed && (
          <div className="shrink-0 border-t border-black/10 dark:border-white/10">
            <div className="px-3 py-2 flex items-center justify-between">
              <div className="text-xs font-medium text-text-secondary">知识库</div>
              <button
                type="button"
                onClick={openKnowledge}
                className={`h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors ${
                  mode === 'Knowledge'
                    ? 'text-primary-600 dark:text-primary-300 bg-primary-50 dark:bg-white/5'
                    : 'text-text-secondary hover:text-primary-500 hover:bg-black/5 dark:hover:bg-white/5'
                }`}
                title="知识库管理"
                aria-label="知识库管理"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M11.983 13.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9c0 .7.41 1.33 1.04 1.61.3.13.62.2.95.2H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
                  />
                </svg>
              </button>
            </div>
            <div className="px-2 pb-2 max-h-44 overflow-y-auto space-y-1">

              <div
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (documentLoaded && prdDocument) openPrdPreview();
                  else openBindFromKnowledge();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (documentLoaded && prdDocument) openPrdPreview();
                    else openBindFromKnowledge();
                  }
                }}
                className={`w-full px-3 py-2 rounded-lg text-left text-sm transition-colors cursor-pointer ${
                  documentLoaded && prdDocument
                    ? 'hover:bg-black/5 dark:hover:bg-white/5 text-text-secondary hover:text-primary-500'
                    : 'hover:bg-black/5 dark:hover:bg-white/5 text-text-secondary hover:text-primary-500'
                }`}
                title={prdDocument?.title || '待上传'}
              >
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6M7 20h10a2 2 0 002-2V6a2 2 0 00-2-2H9l-2 2H7a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                    <span className="truncate">{prdDocument?.title || '待上传'}</span>
                  </div>
                  {documentLoaded && prdDocument ? (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          openPrdPreview();
                        }}
                        className="h-7 w-7 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                        title="预览 PRD"
                        aria-label="预览 PRD"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          openBindPrdPicker();
                        }}
                        className={`h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors ${
                          canReplacePrd
                            ? 'text-text-secondary hover:text-primary-500 hover:bg-black/5 dark:hover:bg-white/5'
                            : 'opacity-50 cursor-not-allowed text-text-secondary'
                        }`}
                        title={canReplacePrd ? '更换 PRD' : '仅群主/管理员可更换 PRD'}
                        aria-label="更换 PRD"
                        disabled={!canReplacePrd}
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v6h6M20 20v-6h-6M20 8a8 8 0 00-14.9-2M4 16a8 8 0 0014.9 2" />
                        </svg>
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 缺陷管理入口 */}
        {!isCollapsed && (
          <div className="shrink-0 border-t border-black/10 dark:border-white/10">
            <div className="px-3 py-2 flex items-center justify-between">
              <div className="text-xs font-medium text-text-secondary">缺陷管理</div>
              <button
                type="button"
                onClick={openDefect}
                className={`h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors ${
                  mode === 'Defect'
                    ? 'text-primary-600 dark:text-primary-300 bg-primary-50 dark:bg-white/5'
                    : 'text-text-secondary hover:text-primary-500 hover:bg-black/5 dark:hover:bg-white/5'
                }`}
                title="缺陷管理"
                aria-label="缺陷管理"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01M5.07 19H19a2.13 2.13 0 001.85-3.19L13.85 4.17a2.13 2.13 0 00-3.7 0L3.22 15.81A2.13 2.13 0 005.07 19z"
                  />
                </svg>
              </button>
            </div>
          </div>
        )}

            {/* 加入群组弹层（Portal 到 body，避免被 Sidebar 的 backdrop-filter 影响 fixed 参照系） */}
            {joinOpen &&
              (typeof document !== 'undefined'
                ? createPortal(
                    <div className="fixed inset-0 z-[1000] flex items-center justify-center">
                      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => (busy ? null : setJoinOpen(false))} />
                      <div className="relative w-full max-w-md mx-4 ui-glass-modal">
                        <div className="px-6 py-4 border-b border-black/10 dark:border-white/10">
                          <div className="text-lg font-semibold text-text-primary">加入群组</div>
                          <div className="mt-1 text-sm text-text-secondary">输入邀请码或邀请链接</div>
                        </div>
                        <div className="p-6 space-y-3">
                          <input
                            value={joinInput}
                            onChange={(e) => setJoinInput(e.target.value)}
                            placeholder="INV-XXXX 或 prdagent://join/INV-XXXX"
                            className="w-full px-4 py-3 ui-control transition-colors"
                            disabled={!canSubmit}
                            autoFocus
                          />
                          {inlineError ? (
                            <div className="p-3 bg-red-500/15 border border-red-500/35 rounded-lg text-red-700 dark:text-red-200 text-sm">
                              {inlineError}
                            </div>
                          ) : null}
                        </div>
                        <div className="flex gap-3 px-6 py-4 border-t border-black/10 dark:border-white/10">
                          <button
                            onClick={() => setJoinOpen(false)}
                            disabled={!!busy}
                            className="flex-1 py-2.5 ui-control text-text-secondary font-medium hover:bg-black/5 dark:hover:bg-white/10 transition-colors disabled:opacity-50"
                          >
                            取消
                          </button>
                          <button
                            onClick={submitJoin}
                            disabled={!canSubmit}
                            className="flex-1 py-2.5 bg-gradient-to-r from-cyan-500 to-purple-500 text-white font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
                          >
                            {busy === 'join' ? '加入中...' : '加入'}
                          </button>
                        </div>
                      </div>
                    </div>,
                    document.body
                  )
                : null)}

            {/* 创建群组弹层（Portal 到 body，避免被 Sidebar 的 backdrop-filter 影响 fixed 参照系） */}
            {createOpen &&
              (typeof document !== 'undefined'
                ? createPortal(
                    <div className="fixed inset-0 z-[1000] flex items-center justify-center">
                      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => (busy ? null : setCreateOpen(false))} />
                      <div className="relative w-full max-w-md mx-4 ui-glass-modal">
                        <div className="px-6 py-4 border-b border-black/10 dark:border-white/10">
                          <div className="text-lg font-semibold text-text-primary">创建群组</div>
                          <div className="mt-1 text-sm text-text-secondary">群组是容器；可在此处直接上传 PRD 自动创建</div>
                        </div>
                        <div className="p-6 space-y-3">
                          <input
                            value={groupNameInput}
                            onChange={(e) => setGroupNameInput(e.target.value)}
                            placeholder="未命名群组（可选）"
                            className="w-full px-4 py-3 ui-control transition-colors"
                            disabled={!canSubmit}
                            autoFocus
                          />

                          <div className="flex items-center gap-3">
                            <button
                              type="button"
                              onClick={() => createPrdInputRef.current?.click()}
                              disabled={!canSubmit}
                              className="shrink-0 inline-flex items-center gap-2 px-4 py-2.5 rounded-lg ui-control text-text-secondary hover:bg-black/5 dark:hover:bg-white/10 transition-colors disabled:opacity-50"
                              title="选择 PRD（.md）"
                            >
                              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                              </svg>
                              上传 PRD
                            </button>
                            <div className="min-w-0 flex-1 text-sm text-text-secondary truncate">
                              {createPrdFileName ? (
                                <span title={createPrdFileName}>{createPrdFileName}</span>
                              ) : (
                                <span>未选择文件（可选）</span>
                              )}
                            </div>
                          </div>

                          <input
                            ref={createPrdInputRef}
                            type="file"
                            accept=".md"
                            className="hidden"
                            onChange={handleCreatePrdFileSelect}
                          />

                          {inlineError ? (
                            <div className="p-3 bg-red-500/15 border border-red-500/35 rounded-lg text-red-700 dark:text-red-200 text-sm">
                              {inlineError}
                            </div>
                          ) : null}
                        </div>
                        <div className="flex gap-3 px-6 py-4 border-t border-black/10 dark:border-white/10">
                          <button
                            onClick={() => setCreateOpen(false)}
                            disabled={!!busy}
                            className="flex-1 py-2.5 ui-control text-text-secondary font-medium hover:bg-black/5 dark:hover:bg-white/10 transition-colors disabled:opacity-50"
                          >
                            取消
                          </button>
                          <button
                            onClick={submitCreate}
                            disabled={!canSubmit}
                            className="flex-1 py-2.5 bg-gradient-to-r from-cyan-500 to-purple-500 text-white font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
                          >
                            {busy === 'create' ? '创建中...' : '创建'}
                          </button>
                        </div>
                      </div>
                    </div>,
                    document.body
                  )
                : null)}

        {/* 即使侧边栏收起，也要能弹出文件选择（用于顶部"待上传"等触发） */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".md"
          className="hidden"
          onChange={handleFileSelectForBind}
        />
      </div>

      {/* 侧边栏拖拽调整宽度的 handle（覆盖在边界线上） */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度"
        className={`absolute top-0 right-0 h-full ${isCollapsed ? 'w-0' : 'w-1'} cursor-col-resize select-none`}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onLostPointerCapture={endResize}
        style={{
          touchAction: 'none',
        }}
      >
        {/* hover 提示（不改变边界线颜色，避免视觉跳动） */}
        <div className={`h-full w-full ${isCollapsed ? '' : 'hover:bg-primary-500/10'}`} />
      </div>
    </aside>
  );
}
