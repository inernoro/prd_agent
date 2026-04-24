import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { useToolboxStore } from '@/stores/toolboxStore';
import { useAuthStore } from '@/stores/authStore';
import { formatDistanceToNow } from '@/lib/dateUtils';
import {
  streamDirectChat,
  uploadAttachment,
  listToolboxSessions,
  createToolboxSession,
  deleteToolboxSession,
  renameToolboxSession,
  listToolboxMessages,
  appendToolboxMessage,
  toggleSessionArchive,
  toggleSessionPin,
  submitMessageFeedback,
  createToolboxShareLink,
} from '@/services/real/aiToolbox';
import type { DirectChatMessage, ToolboxSessionInfo, TokenInfo } from '@/services/real/aiToolbox';
import {
  ArrowLeft, Edit, Trash2, Zap, Tag, Calendar, User, Send,
  FileText, Palette, PenTool, Bug, Code2, Languages, FileSearch, BarChart3,
  Bot, Lightbulb, Target, Wrench, Sparkles, Rocket, MessageSquare,
  Brain, Cpu, Database, Globe, Image, Music, Video, BookOpen,
  GraduationCap, Briefcase, Heart, Star, Shield, Lock, Search, Layers,
  Swords, Paperclip, ImagePlus, X, File,
  Plus, MessageCircle, Link2, Globe2, AlertCircle,
  Square, Copy, Check, RotateCcw, RefreshCw, Download, Eraser,
  ThumbsUp, ThumbsDown, Pencil, Archive, Pin, ChevronDown,
  Eye, ChevronRight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { MapSpinner } from '@/components/ui/VideoLoader';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import 'katex/dist/katex.min.css';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import { SseTypingBlock } from '@/components/sse/SseTypingBlock';

// 图标组件映射
const ICON_MAP: Record<string, LucideIcon> = {
  FileText, Palette, PenTool, Bug, Code2, Languages, FileSearch, BarChart3,
  Bot, Lightbulb, Target, Wrench, Sparkles, Rocket, MessageSquare, Zap,
  Brain, Cpu, Database, Globe, Image, Music, Video, BookOpen,
  GraduationCap, Briefcase, Heart, Star, Shield, Lock, Search, Layers, Swords,
};

const ICON_HUE_MAP: Record<string, number> = {
  FileText: 210, Palette: 330, PenTool: 45, Bug: 0, Code2: 180, Languages: 200,
  FileSearch: 50, BarChart3: 270, Bot: 210, Lightbulb: 45, Target: 0, Wrench: 30,
  Sparkles: 280, Rocket: 210, MessageSquare: 180, Zap: 45, Brain: 270, Cpu: 200,
  Database: 220, Globe: 180, Image: 330, Music: 300, Video: 0, BookOpen: 140,
  GraduationCap: 220, Briefcase: 30, Heart: 350, Star: 45, Shield: 210, Lock: 200,
  Search: 180, Layers: 240, Swords: 30,
};

function getIconComponent(iconName: string): LucideIcon {
  return ICON_MAP[iconName] || Bot;
}

function getAccentHue(iconName: string): number {
  return ICON_HUE_MAP[iconName] ?? 210;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: Array<{ id: string; name: string; type: 'file' | 'image'; url?: string; size?: number }>;
  attachmentIds?: string[];
  timestamp: Date;
  isStreaming?: boolean;
  feedback?: 'up' | 'down' | null;
  totalTokens?: number;
  thinkingContent?: string;
}

interface Attachment {
  id: string;
  file: File;
  name: string;
  type: 'file' | 'image';
  preview?: string;
  uploadStatus?: 'pending' | 'uploading' | 'done' | 'error';
  uploadError?: string;
}

// File validation
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB (matches backend)
const SUPPORTED_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.txt', '.md', '.json', '.csv', '.xlsx', '.xls', '.ppt', '.pptx',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp',
]);

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function validateFile(file: File): string | null {
  if (file.size > MAX_FILE_SIZE) {
    return `文件过大 (${formatFileSize(file.size)})，上限 ${MAX_FILE_SIZE / 1024 / 1024}MB`;
  }
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return `不支持的文件类型 (${ext})`;
  }
  return null;
}

export function ToolDetail() {
  const { selectedItem, backToGrid, startEdit, deleteItem, togglePublish, forkItem, setCategory } = useToolboxStore();
  const currentUser = useAuthStore((s) => s.user);
  const [input, setInput] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Session management
  const [sessions, setSessions] = useState<ToolboxSessionInfo[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  // Session search/sort/filter
  const [sessionSearch, setSessionSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sessionSortBy, setSessionSortBy] = useState('lastActive');
  const [showArchived, setShowArchived] = useState(false);
  const [showSortDropdown, setShowSortDropdown] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Publish state
  const [isPublic, setIsPublic] = useState(false);

  // Current model info (from SSE start event)
  const [currentModel, setCurrentModel] = useState<string | null>(null);

  // Session rename
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Prompt visibility (Agent D)
  const [promptExpanded, setPromptExpanded] = useState(false);

  // Share state (Agent C)
  const [isSharing, setIsSharing] = useState(false);

  // Fork（创建副本）正在执行 — 需要放在所有 early return 之前，避免违反 Rules of Hooks
  const [isForking, setIsForking] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 150) + 'px';
    }
  }, [input]);

  useEffect(() => {
    return () => { abortRef.current?.(); };
  }, []);

  // Debounce session search
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(sessionSearch);
    }, 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [sessionSearch]);

  // Load sessions when item changes
  useEffect(() => {
    if (!selectedItem) return;
    setIsPublic(!!selectedItem.isPublic);
    loadSessions();
  }, [selectedItem?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reload sessions when search/sort/archive changes
  useEffect(() => {
    loadSessions();
  }, [debouncedSearch, sessionSortBy, showArchived]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadSessions = useCallback(async () => {
    if (!selectedItem) return;
    setSessionsLoading(true);
    try {
      const res = await listToolboxSessions(selectedItem.id, {
        search: debouncedSearch || undefined,
        sortBy: sessionSortBy,
        includeArchived: showArchived,
      });
      if (res.success && res.data) {
        setSessions(res.data.sessions);
        // Auto-select the most recent session if none selected, or none
        if (!currentSessionId && res.data.sessions.length > 0) {
          await switchToSession(res.data.sessions[0].id);
        }
      }
    } catch { /* silent */ }
    finally { setSessionsLoading(false); }
  }, [selectedItem?.id, debouncedSearch, sessionSortBy, showArchived]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchToSession = async (sessionId: string) => {
    setCurrentSessionId(sessionId);
    setMessages([]);
    try {
      const res = await listToolboxMessages(sessionId);
      if (res.success && res.data) {
        // Collect all unique attachmentIds to batch-fetch their URLs
        const allAttIds = res.data.messages
          .flatMap(m => m.attachmentIds ?? [])
          .filter((v, i, a) => a.indexOf(v) === i);

        // Fetch attachment details in parallel
        const attMap = new Map<string, { url: string; fileName: string; mimeType: string }>();
        if (allAttIds.length > 0) {
          const results = await Promise.allSettled(
            allAttIds.map(id =>
              fetch(`/api/v1/attachments/${id}`, {
                headers: { Authorization: `Bearer ${useAuthStore.getState().token ?? ''}` },
              }).then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
              })
            )
          );
          results.forEach((r, i) => {
            if (r.status === 'fulfilled' && r.value?.data) {
              const d = r.value.data;
              attMap.set(allAttIds[i], { url: d.url, fileName: d.fileName, mimeType: d.mimeType });
            }
          });
        }

        setMessages(res.data.messages.map(m => {
          const ids = m.attachmentIds?.length ? m.attachmentIds : undefined;
          // Build attachments array with real URLs for rendering
          const attachments = ids?.map(id => {
            const info = attMap.get(id);
            if (!info) return { id, name: '附件不可用', type: 'file' as const };
            const isImage = info.mimeType?.startsWith('image/');
            return {
              id,
              name: info.fileName,
              type: (isImage ? 'image' : 'file') as 'image' | 'file',
              url: info.url,
            };
          });
          return {
            id: m.id,
            role: m.role,
            content: m.content,
            attachmentIds: ids,
            attachments,
            timestamp: new Date(m.createdAt),
          };
        }));
      }
    } catch { /* silent */ }
  };

  const handleNewSession = async () => {
    if (!selectedItem) return;
    try {
      const res = await createToolboxSession(selectedItem.id);
      if (res.success && res.data) {
        setSessions(prev => [res.data!, ...prev]);
        setCurrentSessionId(res.data.id);
        setMessages([]);
      }
    } catch { /* silent */ }
  };

  const handleDeleteSession = async (sessionId: string) => {
    try {
      await deleteToolboxSession(sessionId);
      setSessions(prev => prev.filter(s => s.id !== sessionId));
      if (currentSessionId === sessionId) {
        setCurrentSessionId(null);
        setMessages([]);
      }
    } catch { /* silent */ }
  };

  const handleRenameSession = async (sessionId: string) => {
    const title = renameValue.trim();
    if (!title) { setRenamingSessionId(null); return; }
    try {
      const res = await renameToolboxSession(sessionId, title);
      if (res.success) {
        setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, title } : s));
      }
    } catch { /* silent */ }
    setRenamingSessionId(null);
  };

  const handleToggleArchive = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await toggleSessionArchive(sessionId);
      if (res.success) {
        setSessions(prev => prev.map(s =>
          s.id === sessionId ? { ...s, isArchived: res.data!.isArchived } : s
        ));
        // If not showing archived and session was just archived, remove from list
        if (!showArchived && res.data?.isArchived) {
          setSessions(prev => prev.filter(s => s.id !== sessionId));
          if (currentSessionId === sessionId) {
            setCurrentSessionId(null);
            setMessages([]);
          }
        }
      }
    } catch { /* silent */ }
  };

  const handleTogglePin = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await toggleSessionPin(sessionId);
      if (res.success) {
        setSessions(prev => prev.map(s =>
          s.id === sessionId ? { ...s, isPinned: res.data!.isPinned } : s
        ));
      }
    } catch { /* silent */ }
  };

  const handleTogglePublish = async () => {
    if (!selectedItem) return;
    const newValue = !isPublic;
    // 公开是面向全体用户的动作，加一次确认避免误点
    if (newValue) {
      const ok = await systemDialog.confirm({
        title: '确认公开发布',
        message:
          '公开发布后，其他用户会在百宝箱首页的「全部 / 别人的」筛选里看到这个智能体' +
          '（包含名称、描述、提示词、标签；对话 7 天内会带 NEW 徽章）。\n\n' +
          '其他用户默认使用的是你的原版（数据存在他们自己名下）；只有显式点「创建副本」才会复制一份独立修改。',
        confirmText: '公开发布',
        cancelText: '取消',
      });
      if (!ok) return;
    }
    const ok = await togglePublish(selectedItem.id, newValue);
    if (ok) {
      setIsPublic(newValue);
      toast.success(newValue ? '已公开发布到市场' : '已取消公开');
    }
  };

  // Share conversation (Agent C)
  const handleShare = async () => {
    if (messages.length === 0) return;
    setIsSharing(true);
    try {
      const res = await createToolboxShareLink(
        messages.map(m => ({
          role: m.role,
          content: m.content,
          createdAt: m.timestamp.toISOString(),
        })),
        selectedItem?.name,
        currentSessionId ?? undefined,
      );
      if (res.success && res.data?.url) {
        const fullUrl = `${window.location.origin}${res.data.url}`;
        await navigator.clipboard.writeText(fullUrl);
        toast.success('分享链接已复制');
      } else {
        toast.error('创建分享链接失败', res.error?.message);
      }
    } catch {
      toast.error('创建分享链接失败');
    } finally {
      setIsSharing(false);
    }
  };

  if (!selectedItem) return null;

  const IconComponent = getIconComponent(selectedItem.icon);
  const accentHue = getAccentHue(selectedItem.icon);
  // 严格判定"用户自建"：必须不是 BUILTIN + 有 custom 标志或后端返回的创建者 id。
  // 不能用 createdByName 兜底，因为 BUILTIN普通版硬编码 createdByName='官方'，会误伤。
  const isBuiltin = selectedItem.type === 'builtin';
  const isCustom =
    !isBuiltin &&
    (selectedItem.type === 'custom' || !!selectedItem.createdByUserId || !!selectedItem.createdBy);
  // 严格"我创建的"判定：用 createdByUserId 对比当前登录用户 — 只有这种情况才能编辑/删除/发布
  const isMineAuthored =
    isCustom &&
    !!currentUser?.userId &&
    ((selectedItem.createdByUserId && selectedItem.createdByUserId === currentUser.userId) ||
      (selectedItem.createdBy && selectedItem.createdBy === currentUser.userId) ||
      // 前端 store 标记兜底：ownership='mine' 时一律视为我的
      selectedItem.ownership === 'mine');
  // "别人的公开条目"：自定义条目 + 非 BUILTIN + 不是我创建的
  const isOthersPublic = isCustom && !isMineAuthored;

  // Get welcome message and starters from item (custom) or defaults (builtin)
  const welcomeMessage = selectedItem.welcomeMessage || getWelcomeText(selectedItem.agentKey);
  const conversationStarters: string[] = selectedItem.conversationStarters || [];

  const handleSend = async (
    overrideMessage?: string,
    overrideAttachmentIds?: string[],
    messagesSnapshot?: ChatMessage[],
    regenerateOnly?: boolean, // true = don't re-add user message, just regenerate assistant
  ) => {
    const messageText = (overrideMessage || input).trim();
    if (!messageText && attachments.length === 0 && !overrideAttachmentIds?.length) return;
    if (!selectedItem) return;

    // Ensure we have a session
    let sessionId = currentSessionId;
    if (!sessionId) {
      try {
        const res = await createToolboxSession(selectedItem.id);
        if (res.success && res.data) {
          sessionId = res.data.id;
          setSessions(prev => [res.data!, ...prev]);
          setCurrentSessionId(sessionId);
        }
      } catch { /* continue without session */ }
    }

    const assistantId = (Date.now() + 1).toString();

    if (regenerateOnly) {
      // Regenerate mode: only add assistant placeholder, user message already exists
      setMessages(prev => [
        ...prev,
        { id: assistantId, role: 'assistant', content: '', timestamp: new Date(), isStreaming: true },
      ]);
      setIsLoading(true);
    } else {
      // Normal send: create user message + assistant placeholder
      const userMessage: ChatMessage = {
        id: Date.now().toString(),
        role: 'user',
        content: messageText,
        attachments: attachments.map(a => ({ id: a.id, name: a.name, type: a.type, url: a.preview, size: a.file.size })),
        attachmentIds: [], // will be filled after upload
        timestamp: new Date(),
      };

      const currentAttachments = [...attachments];
      const hasNewAttachments = !overrideAttachmentIds && currentAttachments.length > 0;

      setMessages(prev => [
        ...prev,
        userMessage,
        { id: assistantId, role: 'assistant', content: '', timestamp: new Date(), isStreaming: true },
      ]);
      setInput('');
      setAttachments([]);
      setIsLoading(true);

      // Handle file uploads for new messages — sequential with per-file progress
      const uploadedIds: string[] = [];
      if (hasNewAttachments) {
        const total = currentAttachments.length;
        for (let i = 0; i < total; i++) {
          const att = currentAttachments[i];
          setMessages(prev => prev.map(m =>
            m.id === assistantId
              ? { ...m, content: `⬆ 正在上传 (${i + 1}/${total})：${att.name}  [${formatFileSize(att.file.size)}]` }
              : m
          ));
          try {
            const res = await uploadAttachment(att.file);
            if (res.success && res.data?.attachmentId) {
              uploadedIds.push(res.data.attachmentId);
            } else {
              toast.error(`"${att.name}" 上传失败`, res.error?.message || '未知错误');
            }
          } catch {
            toast.error(`"${att.name}" 上传异常`);
          }
        }
        if (uploadedIds.length === 0) {
          setMessages(prev => prev.map(m =>
            m.id === assistantId ? { ...m, content: '所有文件上传失败，请重试。', isStreaming: false } : m
          ));
          setIsLoading(false);
          return;
        }
        const failCount = total - uploadedIds.length;
        if (failCount > 0) {
          toast.warning(`${failCount} 个文件上传失败，已跳过`);
        }
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: '' } : m
        ));
      }

      // Merge uploaded IDs with override IDs
      if (!overrideAttachmentIds) {
        overrideAttachmentIds = uploadedIds.length > 0 ? uploadedIds : undefined;
      }

      // Store attachmentIds on the user message
      if (overrideAttachmentIds && overrideAttachmentIds.length > 0) {
        setMessages(prev => prev.map(m => m.id === userMessage.id ? { ...m, attachmentIds: overrideAttachmentIds! } : m));
      }

      // Persist user message to backend
      if (sessionId) {
        appendToolboxMessage(sessionId, {
          role: 'user', content: messageText, attachmentIds: overrideAttachmentIds ?? [],
        }).then(() => {
          // Backend auto-sets title from first message — sync locally
          const currentSession = sessions.find(s => s.id === sessionId);
          if (currentSession && currentSession.messageCount === 0) {
            const title = messageText.length > 50 ? messageText.slice(0, 50) + '...' : messageText;
            setSessions(prev => prev.map(s =>
              s.id === sessionId ? { ...s, title, messageCount: s.messageCount + 1 } : s
            ));
          } else {
            setSessions(prev => prev.map(s =>
              s.id === sessionId ? { ...s, messageCount: s.messageCount + 1 } : s
            ));
          }
        }).catch(() => {});
      }
    }

    // Build history (include attachmentIds so backend can inject images for multi-turn context)
    const attachmentIds: string[] = overrideAttachmentIds ? [...overrideAttachmentIds] : [];
    const historySource = messagesSnapshot ?? messages;
    const history: DirectChatMessage[] = historySource.map(m => ({
      role: m.role,
      content: m.content,
      ...(m.attachmentIds?.length ? { attachmentIds: m.attachmentIds } : {}),
    }));

    let fullContent = '';

    const abort = streamDirectChat({
      message: messageText,
      agentKey: selectedItem.agentKey,
      itemId: isCustom ? selectedItem.id : undefined,
      sessionId: sessionId ?? undefined,
      history,
      attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      onStart: (info) => {
        if (info.model) setCurrentModel(info.model);
      },
      onThinking: (content) => {
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, thinkingContent: (m.thinkingContent || '') + content }
            : m
        ));
      },
      onText: (content) => {
        fullContent += content;
        setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: m.content + content } : m));
      },
      onError: (error) => {
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: m.content || `[错误] ${error}`, isStreaming: false } : m
        ));
        setIsLoading(false);
        abortRef.current = null;
      },
      onDone: (tokenInfo?: TokenInfo) => {
        setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, isStreaming: false, totalTokens: tokenInfo?.totalTokens } : m));
        setIsLoading(false);
        abortRef.current = null;
        // Persist assistant message
        if (sessionId && fullContent) {
          appendToolboxMessage(sessionId, { role: 'assistant', content: fullContent }).then(() => {
            setSessions(prev => prev.map(s =>
              s.id === sessionId ? { ...s, messageCount: s.messageCount + 1 } : s
            ));
          }).catch(() => {});
        }
      },
    });

    abortRef.current = abort;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>, type: 'file' | 'image') => {
    const files = e.target.files;
    if (!files) return;
    const valid: Attachment[] = [];
    Array.from(files).forEach(file => {
      const error = validateFile(file);
      if (error) {
        toast.error(`"${file.name}" 无法上传`, error);
        return;
      }
      const att: Attachment = {
        id: Math.random().toString(36).substr(2, 9),
        file,
        name: file.name,
        type,
        uploadStatus: 'pending',
      };
      if (type === 'image' && file.type.startsWith('image/')) att.preview = URL.createObjectURL(file);
      valid.push(att);
    });
    if (valid.length > 0) setAttachments(prev => [...prev, ...valid]);
    e.target.value = '';
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => {
      const att = prev.find(a => a.id === id);
      if (att?.preview) URL.revokeObjectURL(att.preview);
      return prev.filter(a => a.id !== id);
    });
  };

  const handleDelete = async () => {
    const ok = await systemDialog.confirm({
      title: `删除「${selectedItem.name}」？`,
      message: '此操作不可恢复。如果已经公开过，其他用户的历史会话数据会保留在他们自己名下但无法继续对话。',
      tone: 'danger',
      confirmText: '删除',
      cancelText: '取消',
    });
    if (!ok) return;
    setIsDeleting(true);
    await deleteItem(selectedItem.id);
    setIsDeleting(false);
  };

  // 消费者显式点击「创建副本」才触发 Fork —— 不再由卡片点击隐式触发，防止反复误操作
  const handleCreateFork = async () => {
    if (isForking) return;
    const ok = await systemDialog.confirm({
      title: `创建「${selectedItem.name}」的副本？`,
      message:
        '复制后你将拥有独立的副本，可自由修改提示词、模型等参数；原作者的更新不会再同步给你。\n\n' +
        '只是想使用原版的话，直接在右侧对话即可，不需要创建副本。',
      confirmText: '创建副本',
      cancelText: '取消',
    });
    if (!ok) return;
    setIsForking(true);
    try {
      const forked = await forkItem(selectedItem.id);
      if (forked) {
        toast.success('已创建副本', '已切换到「我的」筛选；打开副本即可编辑');
        setCategory('mine');
        backToGrid();
      } else {
        toast.error('创建副本失败，请稍后重试');
      }
    } finally {
      setIsForking(false);
    }
  };

  const handleRegenerate = (assistantMsgId: string) => {
    if (isLoading) return;
    const idx = messages.findIndex(m => m.id === assistantMsgId);
    if (idx < 1) return;
    const prevUserMsg = [...messages].slice(0, idx).reverse().find(m => m.role === 'user');
    if (!prevUserMsg) return;
    // Remove the old assistant message, keep user message intact (with attachments)
    const filteredMessages = messages.filter(m => m.id !== assistantMsgId);
    setMessages(filteredMessages);
    // Regenerate only: don't duplicate user message, just create new assistant response
    handleSend(prevUserMsg.content, prevUserMsg.attachmentIds, filteredMessages, true);
  };

  const handleExportChat = () => {
    if (messages.length === 0) return;
    const lines = messages.map(m => {
      const time = m.timestamp.toLocaleString('zh-CN');
      const role = m.role === 'user' ? '我' : selectedItem.name;
      return `### ${role}  (${time})\n\n${m.content}\n`;
    });
    const md = `# ${selectedItem.name} — 对话记录\n\n${lines.join('\n---\n\n')}`;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedItem.name}_chat_${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('对话已导出');
  };

  const handleClearChat = async () => {
    if (messages.length === 0) return;
    const ok = await systemDialog.confirm({
      title: '清空当前会话？',
      message: '将清除当前会话中所有消息（仅从前端界面移除，服务端已保存的历史不受影响）。',
      tone: 'danger',
      confirmText: '清空',
      cancelText: '取消',
    });
    if (!ok) return;
    setMessages([]);
  };

  // Keyboard shortcuts (Agent D)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        handleNewSession();
      } else if (mod && e.shiftKey && e.key === 'Backspace') {
        e.preventDefault();
        void handleClearChat();
      } else if (mod && e.shiftKey && e.key === 'E') {
        e.preventDefault();
        handleExportChat();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        abortRef.current?.();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      {/* Header */}
      <TabBar
        title={selectedItem.name}
        icon={<IconComponent size={18} style={{ color: `hsla(${accentHue}, 70%, 70%, 1)` }} />}
        items={[]}
        activeKey=""
        onChange={() => {}}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={backToGrid}>
              <ArrowLeft size={14} />
              返回
            </Button>
            {messages.length > 0 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleShare}
                disabled={isSharing}
                title="生成只读链接，复制给别人查看本次对话"
              >
                <Link2 size={14} />
                分享对话
              </Button>
            )}
            {isMineAuthored ? (
              // 我创建的：可以发布/取消发布、编辑、删除
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleTogglePublish}
                  title={
                    isPublic
                      ? '已公开 — 其他用户在首页的「全部/别人的」筛选里能看到并使用；点击取消公开'
                      : '公开后其他用户能在首页的「全部/别人的」里看到并直接使用；想复制修改要显式点「创建副本」'
                  }
                  style={isPublic ? { color: '#6ee7b7', borderColor: 'rgba(16, 185, 129, 0.45)' } : undefined}
                >
                  <Globe2 size={14} />
                  {isPublic ? '已公开' : '公开发布'}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => startEdit(selectedItem)}>
                  <Edit size={14} />
                  编辑
                </Button>
                <Button variant="secondary" size="sm" onClick={handleDelete} disabled={isDeleting} style={{ color: 'var(--status-error)' }}>
                  <Trash2 size={14} />
                  删除
                </Button>
              </>
            ) : isOthersPublic ? (
              // 别人公开的：不能编辑 / 删除 / 再次发布；只能「使用原版（右侧对话）」或「显式创建副本」
              <Button
                variant="secondary"
                size="sm"
                onClick={handleCreateFork}
                disabled={isForking}
                title="把这个公开条目复制成我的副本，复制后可独立修改；只想使用原版直接在右侧对话即可（数据存在我自己名下）"
              >
                <Copy size={14} />
                {isForking ? '复制中…' : '创建副本'}
              </Button>
            ) : !selectedItem.routePath && (
              // BUILTIN 非定制版：保留原有"复制并编辑为我的新智能体"能力
              <Button
                variant="secondary"
                size="sm"
                title="复制一份内置工具到我的百宝箱，复制后可自由修改提示词、模型等参数"
                onClick={() => {
                  // Fork built-in agent into a custom copy for editing
                  startEdit({
                    ...selectedItem,
                    id: '', // no id = create new
                    name: `${selectedItem.name}（我的副本）`,
                    category: 'custom',
                    type: 'custom',
                    prompt: selectedItem.systemPrompt,
                  } as any);
                }}
              >
                <Copy size={14} />
                复制并编辑
              </Button>
            )}
          </div>
        }
      />

      <div className="flex-1 min-h-0 flex gap-4">
        {/* Left: Info + Sessions Panel */}
        <div className="w-72 flex-shrink-0 flex flex-col gap-3 overflow-y-auto">
          <GlassCard animated className="p-4" variant="subtle">
            <div className="flex items-center gap-3 mb-3">
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center"
                style={{
                  background: `linear-gradient(135deg, hsla(${accentHue}, 70%, 60%, 0.18) 0%, hsla(${accentHue}, 70%, 40%, 0.1) 100%)`,
                  boxShadow: `0 4px 16px -4px hsla(${accentHue}, 70%, 50%, 0.35), inset 0 1px 0 0 rgba(255,255,255,0.12)`,
                  border: `1px solid hsla(${accentHue}, 60%, 60%, 0.25)`,
                }}
              >
                <IconComponent size={24} style={{ color: `hsla(${accentHue}, 70%, 70%, 1)` }} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm truncate" style={{ color: 'var(--text-primary)' }}>{selectedItem.name}</div>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full truncate max-w-[12rem]"
                  style={{
                    background: isOthersPublic
                      ? 'rgba(59, 130, 246, 0.18)'
                      : isCustom
                      ? 'rgba(34, 197, 94, 0.15)'
                      : `hsla(${accentHue}, 60%, 50%, 0.15)`,
                    color: isOthersPublic
                      ? '#93c5fd'
                      : isCustom
                      ? 'rgb(74, 222, 128)'
                      : `hsla(${accentHue}, 70%, 70%, 1)`,
                  }}
                  title={
                    isOthersPublic
                      ? `由「${selectedItem.createdByName || '未知用户'}」公开发布。你可以直接使用（你的对话记录会单独存在自己名下），或创建副本后自由修改。`
                      : undefined
                  }
                >
                  {isOthersPublic
                    ? `由 ${selectedItem.createdByName || '未知用户'} 发布`
                    : isCustom
                    ? '自定义'
                    : '内置工具'}
                </span>
              </div>
            </div>
            <div className="text-xs mb-3 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{selectedItem.description}</div>
            <div className="space-y-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {currentModel && <div className="flex items-center gap-1.5"><Cpu size={11} /><span>{currentModel}</span></div>}
              {selectedItem.usageCount > 0 && <div className="flex items-center gap-1.5"><Zap size={11} /><span>已使用 {selectedItem.usageCount} 次</span></div>}
              {(selectedItem.createdByName || isOthersPublic) && (
                <div className="flex items-center gap-1.5">
                  <User size={11} />
                  <span>
                    {selectedItem.createdByName ||
                      (selectedItem.createdByUserId
                        ? `用户 #${selectedItem.createdByUserId.slice(-6)}`
                        : '未知用户')}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-1.5"><Calendar size={11} /><span>{formatDistanceToNow(new Date(selectedItem.createdAt))}</span></div>
            </div>
            {selectedItem.tags.length > 0 && (
              <div className="mt-3 pt-3 border-t" style={{ borderColor: 'rgba(255, 255, 255, 0.06)' }}>
                <div className="flex items-center gap-1 text-[10px] mb-1.5" style={{ color: 'var(--text-muted)' }}><Tag size={10} /> 标签</div>
                <div className="flex flex-wrap gap-1">
                  {selectedItem.tags.map(tag => (
                    <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(255, 255, 255, 0.05)', color: 'var(--text-secondary)' }}>{tag}</span>
                  ))}
                </div>
              </div>
            )}

            {/* System Prompt Visibility (Agent D) */}
            {(selectedItem.systemPrompt || selectedItem.prompt) && (
              <div className="mt-3 pt-3 border-t" style={{ borderColor: 'rgba(255, 255, 255, 0.06)' }}>
                <button
                  onClick={() => setPromptExpanded(!promptExpanded)}
                  className="flex items-center gap-1 text-[10px] mb-1.5 w-full hover:opacity-80 transition-opacity"
                  style={{ color: 'var(--text-muted)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                >
                  <Eye size={10} />
                  <span>系统提示词</span>
                  {promptExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                </button>
                {!promptExpanded ? (
                  <div
                    className="text-[11px] leading-relaxed truncate"
                    style={{ color: 'var(--text-muted)', fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace' }}
                  >
                    {(selectedItem.systemPrompt || selectedItem.prompt || '').slice(0, 80)}...
                  </div>
                ) : (
                  <div
                    className="text-[11px] leading-relaxed overflow-y-auto whitespace-pre-wrap"
                    style={{
                      color: 'var(--text-muted)',
                      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
                      maxHeight: '200px',
                      background: 'rgba(0, 0, 0, 0.15)',
                      borderRadius: '6px',
                      padding: '8px',
                    }}
                  >
                    {selectedItem.systemPrompt || selectedItem.prompt}
                  </div>
                )}
              </div>
            )}
          </GlassCard>

          {/* Sessions List */}
          <GlassCard animated className="flex-1 min-h-0 flex flex-col" padding="none" overflow="hidden" variant="subtle">
            {/* Session header with sort & new */}
            <div className="p-2 border-b" style={{ borderColor: 'rgba(255, 255, 255, 0.06)' }}>
              <div className="flex items-center justify-between mb-1.5 px-1">
                <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>会话列表</span>
                <div className="flex items-center gap-1">
                  <div className="relative">
                    <button
                      onClick={() => setShowSortDropdown(!showSortDropdown)}
                      className="flex items-center gap-0.5 px-1 py-0.5 rounded hover:bg-white/10 transition-colors text-[10px]"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {{ lastActive: '最近活跃', created: '创建时间', messageCount: '消息数', title: '标题' }[sessionSortBy]}
                      <ChevronDown size={10} />
                    </button>
                    {showSortDropdown && (
                      <div
                        className="absolute right-0 top-full mt-1 py-1 rounded-lg shadow-lg z-10 min-w-[90px]"
                        style={{ background: 'var(--bg-elevated)', border: '1px solid rgba(255, 255, 255, 0.1)' }}
                      >
                        {([['lastActive', '最近活跃'], ['created', '创建时间'], ['messageCount', '消息数'], ['title', '标题']] as const).map(([val, label]) => (
                          <button
                            key={val}
                            onClick={() => { setSessionSortBy(val); setShowSortDropdown(false); }}
                            className="w-full text-left px-3 py-1 text-[11px] hover:bg-white/10 transition-colors"
                            style={{ color: val === sessionSortBy ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button onClick={handleNewSession} className="p-1 rounded-lg hover:bg-white/10 transition-colors" title="新建会话">
                    <Plus size={14} style={{ color: 'var(--text-muted)' }} />
                  </button>
                </div>
              </div>
              {/* Search */}
              <div
                className="flex items-center gap-1.5 px-2 py-1 rounded-lg"
                style={{ background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)' }}
              >
                <Search size={12} style={{ color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  value={sessionSearch}
                  onChange={e => setSessionSearch(e.target.value)}
                  placeholder="搜索会话..."
                  className="flex-1 bg-transparent border-none outline-none text-[11px]"
                  style={{ color: 'var(--text-primary)' }}
                />
                {sessionSearch && (
                  <button onClick={() => setSessionSearch('')} className="hover:bg-white/10 rounded p-0.5 transition-colors">
                    <X size={10} style={{ color: 'var(--text-muted)' }} />
                  </button>
                )}
              </div>
              {/* Show archived toggle */}
              <label className="flex items-center gap-1.5 mt-1.5 px-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={e => setShowArchived(e.target.checked)}
                  className="w-3 h-3 rounded accent-current"
                />
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>显示已归档</span>
              </label>
            </div>

            {/* Session items */}
            <div className="flex-1 min-h-0 overflow-y-auto py-1">
              {sessionsLoading && <div className="text-[11px] text-center py-2" style={{ color: 'var(--text-muted)' }}>加载中...</div>}
              {!sessionsLoading && sessions.length === 0 && (
                <div className="text-[11px] text-center py-4 px-3" style={{ color: 'var(--text-muted)' }}>
                  {debouncedSearch ? '未找到匹配的会话' : '暂无会话，发送消息自动创建'}
                </div>
              )}
              {sessions.map(s => (
                <div
                  key={s.id}
                  className="group relative flex items-center gap-2 px-3 py-1.5 mx-1 rounded-lg cursor-pointer transition-colors"
                  style={{
                    background: s.id === currentSessionId ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
                    opacity: s.isArchived ? 0.5 : 1,
                  }}
                  onClick={() => switchToSession(s.id)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setRenamingSessionId(s.id);
                    setRenameValue(s.title);
                  }}
                >
                  {s.isPinned ? (
                    <Pin size={12} style={{ color: 'var(--accent-primary, #818cf8)', flexShrink: 0 }} />
                  ) : (
                    <MessageCircle size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                  )}
                  <div className="flex-1 min-w-0">
                    {renamingSessionId === s.id ? (
                      <input
                        autoFocus
                        className="text-[11px] w-full bg-transparent border-b outline-none"
                        style={{ color: 'var(--text-primary)', borderColor: 'var(--accent-primary)' }}
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => handleRenameSession(s.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRenameSession(s.id);
                          if (e.key === 'Escape') setRenamingSessionId(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <div className="text-[11px] truncate" style={{ color: 'var(--text-primary)' }}>{s.title}</div>
                    )}
                    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{s.messageCount} 条消息</div>
                  </div>
                  {/* Hover actions */}
                  <div className="absolute right-1 top-1 hidden group-hover:flex items-center gap-0.5">
                    <button
                      onClick={(e) => handleTogglePin(s.id, e)}
                      className="p-0.5 rounded hover:bg-white/10 transition-colors"
                      title={s.isPinned ? '取消置顶' : '置顶'}
                    >
                      <Pin size={10} style={{ color: s.isPinned ? 'var(--accent-primary, #818cf8)' : 'var(--text-muted)' }} />
                    </button>
                    <button
                      onClick={(e) => handleToggleArchive(s.id, e)}
                      className="p-0.5 rounded hover:bg-white/10 transition-colors"
                      title={s.isArchived ? '取消归档' : '归档'}
                    >
                      <Archive size={10} style={{ color: 'var(--text-muted)' }} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteSession(s.id); }}
                      className="p-0.5 rounded hover:bg-white/10 transition-colors"
                    >
                      <X size={10} style={{ color: 'var(--text-muted)' }} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </GlassCard>
        </div>

        {/* Right: Chat Interface */}
        <GlassCard animated className="flex-1 min-w-0 flex flex-col" padding="none" overflow="hidden">
          {/* Chat toolbar */}
          {messages.length > 0 && (
            <div className="flex items-center justify-end gap-1 px-4 pt-2">
              <button
                onClick={handleExportChat}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] hover:bg-white/10 transition-colors"
                style={{ color: 'var(--text-muted)' }}
                title="导出对话"
              >
                <Download size={12} />
                <span>导出</span>
              </button>
              <button
                onClick={handleClearChat}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] hover:bg-white/10 transition-colors"
                style={{ color: 'var(--text-muted)' }}
                title="清空对话"
              >
                <Eraser size={12} />
                <span>清空</span>
              </button>
            </div>
          )}
          {/* Chat Messages */}
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center px-8">
                <div
                  className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
                  style={{
                    background: `linear-gradient(135deg, hsla(${accentHue}, 70%, 60%, 0.15) 0%, hsla(${accentHue}, 70%, 40%, 0.08) 100%)`,
                    border: `1px solid hsla(${accentHue}, 60%, 60%, 0.2)`,
                  }}
                >
                  <IconComponent size={32} style={{ color: `hsla(${accentHue}, 70%, 70%, 0.8)` }} />
                </div>
                <div className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                  {selectedItem.name}
                </div>
                <div className="text-xs max-w-sm mb-4" style={{ color: 'var(--text-muted)' }}>
                  {welcomeMessage}
                </div>
                {/* Conversation Starters */}
                {conversationStarters.length > 0 && (
                  <div className="flex flex-wrap gap-2 justify-center max-w-md">
                    {conversationStarters.map((starter, i) => (
                      <button
                        key={i}
                        className="text-xs px-3 py-1.5 rounded-full transition-colors hover:bg-white/10"
                        style={{ border: '1px solid rgba(255, 255, 255, 0.1)', color: 'var(--text-secondary)' }}
                        onClick={() => handleSend(starter)}
                      >
                        {starter}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <>
                {messages.map((message, idx) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    accentHue={accentHue}
                    onCopy={message.role === 'assistant' && message.content && !message.isStreaming ? () => {
                      navigator.clipboard.writeText(message.content);
                      toast.success('已复制到剪贴板');
                    } : undefined}
                    onRegenerate={message.role === 'assistant' && !message.isStreaming && message.content && !isLoading ? () => {
                      handleRegenerate(message.id);
                    } : undefined}
                    onRetry={message.content?.startsWith('[错误]') && idx === messages.length - 1 ? () => {
                      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
                      if (lastUserMsg) {
                        const filtered = messages.filter(m => m.id !== message.id);
                        setMessages(filtered);
                        handleSend(lastUserMsg.content, lastUserMsg.attachmentIds, filtered, true);
                      }
                    } : undefined}
                    onFeedback={message.role === 'assistant' && message.content && !message.isStreaming ? () => {} : undefined}
                    onEditMessage={message.role === 'user' && !isLoading ? (newContent: string) => {
                      // Remove this message and all subsequent messages, then resend
                      const msgIdx = messages.findIndex(m => m.id === message.id);
                      const truncated = messages.slice(0, msgIdx);
                      setMessages(truncated);
                      handleSend(newContent, message.attachmentIds, truncated);
                    } : undefined}
                  />
                ))}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          {/* Attachments Preview */}
          {attachments.length > 0 && (
            <div className="px-4 py-2 border-t flex flex-wrap gap-2" style={{ borderColor: 'rgba(255, 255, 255, 0.06)' }}>
              {attachments.map(attachment => (
                <div
                  key={attachment.id}
                  className="relative group flex items-center gap-2 px-2.5 py-2 rounded-lg transition-all"
                  style={{
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid rgba(255, 255, 255, 0.06)',
                  }}
                >
                  {attachment.type === 'image' && attachment.preview
                    ? <img src={attachment.preview} alt="" className="w-10 h-10 rounded object-cover flex-shrink-0" />
                    : <File size={18} className="flex-shrink-0" style={{ color: 'var(--text-muted)' }} />}
                  <div className="min-w-0">
                    <span className="text-xs truncate block max-w-[140px]" style={{ color: 'var(--text-secondary)' }}>{attachment.name}</span>
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{formatFileSize(attachment.file.size)}</span>
                  </div>
                  <button onClick={() => removeAttachment(attachment.id)} className="p-0.5 rounded hover:bg-white/10 transition-colors flex-shrink-0">
                    <X size={12} style={{ color: 'var(--text-muted)' }} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Input Area */}
          <div className="p-4 border-t" style={{ borderColor: 'rgba(255, 255, 255, 0.06)' }}>
            <div className="flex items-end gap-2 p-2 rounded-xl" style={{ background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
              <div className="flex items-center gap-1 pb-1">
                <button onClick={() => fileInputRef.current?.click()} className="p-1.5 rounded-lg hover:bg-white/10 transition-colors" title="上传文件">
                  <Paperclip size={18} style={{ color: 'var(--text-muted)' }} />
                </button>
                <button onClick={() => imageInputRef.current?.click()} className="p-1.5 rounded-lg hover:bg-white/10 transition-colors" title="上传图片">
                  <ImagePlus size={18} style={{ color: 'var(--text-muted)' }} />
                </button>
              </div>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入你的消息..."
                rows={1}
                className="flex-1 bg-transparent border-none outline-none resize-none text-sm py-1.5"
                style={{ color: 'var(--text-primary)', maxHeight: '150px' }}
              />
              {isLoading ? (
                <Button variant="secondary" size="sm" onClick={() => { abortRef.current?.(); setIsLoading(false); }} className="mb-0.5" title="停止生成">
                  <Square size={14} />
                </Button>
              ) : (
                <Button variant="primary" size="sm" onClick={() => handleSend()} disabled={!input.trim() && attachments.length === 0} className="mb-0.5">
                  <Send size={16} />
                </Button>
              )}
            </div>
            <div className="flex items-center justify-between mt-1 px-1">
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Enter 发送 · Shift+Enter 换行 · Ctrl+Shift+N 新对话 · Esc 停止
              </span>
              <span className="text-[10px]" style={{ color: input.length > 4000 ? 'var(--status-error)' : 'var(--text-muted)' }}>
                {input.length > 0 && `${input.length} 字`}
              </span>
            </div>
            <input ref={fileInputRef} type="file" multiple className="hidden" accept=".pdf,.doc,.docx,.txt,.md,.json,.csv,.xlsx,.xls,.ppt,.pptx" onChange={(e) => handleFileSelect(e, 'file')} />
            <input ref={imageInputRef} type="file" multiple className="hidden" accept="image/*" onChange={(e) => handleFileSelect(e, 'image')} />
          </div>
        </GlassCard>
      </div>
    </div>
  );
}

// Allow KaTeX class names and styles through sanitizer
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span || []), 'className', 'style'],
    div: [...(defaultSchema.attributes?.div || []), 'className', 'style'],
    math: ['xmlns'],
  },
  tagNames: [...(defaultSchema.tagNames || []), 'math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mover', 'munder', 'mtable', 'mtr', 'mtd', 'mtext', 'annotation'],
};

const AssistantMarkdown = memo(function AssistantMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeKatex]}
      components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '');
          const codeStr = String(children ?? '').replace(/\n$/, '');
          // 块级判断：有 language- 类名 或 内容含换行（兼容未指定语言的 fenced block）
          const isBlock = !!match || codeStr.includes('\n');
          if (!isBlock) {
            return (
              <code className="px-1 py-0.5 rounded text-xs" style={{ background: 'rgba(255, 255, 255, 0.1)' }} {...props}>{children}</code>
            );
          }
          // 块级且指定语言 → Prism 高亮
          if (match) {
            return (
              <div className="relative group/code my-2">
                <div className="flex items-center justify-between px-3 py-1 rounded-t-lg text-[10px]" style={{ background: 'rgba(0, 0, 0, 0.5)', color: 'var(--text-muted)' }}>
                  <span>{match[1]}</span>
                  <button
                    onClick={() => { navigator.clipboard.writeText(codeStr); toast.success('代码已复制'); }}
                    className="opacity-0 group-hover/code:opacity-100 flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-white/10 transition-all"
                  >
                    <Copy size={10} /> 复制
                  </button>
                </div>
                <SyntaxHighlighter
                  style={oneDark}
                  language={match[1]}
                  PreTag="div"
                  customStyle={{ margin: 0, borderTopLeftRadius: 0, borderTopRightRadius: 0, borderBottomLeftRadius: '0.5rem', borderBottomRightRadius: '0.5rem', fontSize: '0.75rem' }}
                >
                  {codeStr}
                </SyntaxHighlighter>
              </div>
            );
          }
          // 块级但无语言 → 纯 <pre>，避免 Prism token 背景污染 ASCII 框图
          return (
            <pre
              className="my-2 rounded-lg overflow-x-auto"
              style={{
                margin: '0.5rem 0',
                padding: '12px 14px',
                fontSize: '0.75rem',
                lineHeight: 1.6,
                background: 'rgba(0,0,0,0.3)',
                color: 'var(--text-primary)',
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                whiteSpace: 'pre',
              }}
            >
              {codeStr}
            </pre>
          );
        },
        pre({ children }) { return <>{children}</>; },
        p({ children }) { return <p className="mb-2 last:mb-0">{children}</p>; },
        ul({ children }) { return <ul className="list-disc pl-4 mb-2">{children}</ul>; },
        ol({ children }) { return <ol className="list-decimal pl-4 mb-2">{children}</ol>; },
        li({ children }) { return <li className="mb-0.5">{children}</li>; },
        h1({ children }) { return <h1 className="text-base font-bold mb-2">{children}</h1>; },
        h2({ children }) { return <h2 className="text-sm font-bold mb-1.5">{children}</h2>; },
        h3({ children }) { return <h3 className="text-sm font-semibold mb-1">{children}</h3>; },
        blockquote({ children }) {
          return <blockquote className="border-l-2 pl-3 my-2" style={{ borderColor: 'rgba(255,255,255,0.2)', color: 'var(--text-secondary)' }}>{children}</blockquote>;
        },
        table({ children }) {
          return <div className="overflow-x-auto my-2"><table className="text-xs border-collapse w-full" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>{children}</table></div>;
        },
        th({ children }) { return <th className="border px-2 py-1 text-left font-semibold" style={{ borderColor: 'rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)' }}>{children}</th>; },
        td({ children }) { return <td className="border px-2 py-1" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>{children}</td>; },
      }}
    >
      {content}
    </ReactMarkdown>
  );
});

function MessageBubble({ message, accentHue, onCopy, onRegenerate, onRetry, onFeedback, onEditMessage }: {
  message: ChatMessage; accentHue: number;
  onCopy?: () => void; onRegenerate?: () => void; onRetry?: () => void;
  onFeedback?: (type: 'up' | 'down') => void;
  onEditMessage?: (newContent: string) => void;
}) {
  const isUser = message.role === 'user';
  const isError = message.content?.startsWith('[错误]');
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(message.feedback ?? null);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  // Auto-expand thinking while streaming (no content yet), collapse when content arrives
  const hasContent = !!message.content;
  const isThinking = !isUser && !!message.thinkingContent;
  const showThinkingExpanded = isThinking && (thinkingExpanded || (message.isStreaming && !hasContent));

  const handleCopy = () => {
    if (!onCopy) return;
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleFeedback = async (type: 'up' | 'down') => {
    const newFeedback = feedback === type ? null : type;
    setFeedback(newFeedback);
    onFeedback?.(type);
    try {
      await submitMessageFeedback(message.id, newFeedback);
    } catch {
      // Revert on error
      setFeedback(feedback);
    }
  };

  const handleStartEdit = () => {
    setEditText(message.content);
    setIsEditing(true);
  };

  const handleConfirmEdit = () => {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== message.content) {
      onEditMessage?.(trimmed);
    }
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
  };

  return (
    <div className={`group/msg flex items-start gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{
          background: isUser
            ? 'linear-gradient(135deg, rgba(99, 102, 241, 0.2) 0%, rgba(99, 102, 241, 0.1) 100%)'
            : `linear-gradient(135deg, hsla(${accentHue}, 70%, 60%, 0.15) 0%, hsla(${accentHue}, 70%, 40%, 0.08) 100%)`,
          border: isUser
            ? '1px solid rgba(99, 102, 241, 0.3)'
            : `1px solid hsla(${accentHue}, 60%, 60%, 0.2)`,
        }}
      >
        {isUser ? <User size={16} style={{ color: 'rgb(129, 140, 248)' }} /> : <Bot size={16} style={{ color: `hsla(${accentHue}, 70%, 70%, 1)` }} />}
      </div>
      <div className={`flex flex-col gap-1 max-w-[75%] ${isUser ? 'items-end' : 'items-start'}`}>
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-1">
            {message.attachments.map(att => (
              <div key={att.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg" style={{ background: 'rgba(255, 255, 255, 0.05)' }}>
                {att.type === 'image' && att.url
                  ? <img src={att.url} alt="" className="w-16 h-16 rounded object-cover" />
                  : <><File size={14} style={{ color: 'var(--text-muted)' }} /><span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{att.name}</span></>}
              </div>
            ))}
          </div>
        )}
        {/* Thinking process (collapsible) */}
        {isThinking && (
          <div className="w-full mb-1">
            <button
              onClick={() => setThinkingExpanded(!thinkingExpanded)}
              className="flex items-center gap-1 text-[10px] mb-0.5 hover:opacity-80 transition-opacity"
              style={{ color: 'rgba(168, 130, 255, 0.8)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
            >
              <Brain size={10} />
              <span>{message.isStreaming && !hasContent ? '思考中…' : '思考过程'}</span>
              {showThinkingExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            </button>
            {showThinkingExpanded && (
              <SseTypingBlock
                text={message.thinkingContent!}
                label=""
                maxHeight={160}
                showCursor={message.isStreaming && !hasContent}
                tailChars={800}
              />
            )}
          </div>
        )}
        <div
          className={`px-3 py-2 rounded-xl text-sm leading-relaxed ${isUser ? 'rounded-tr-sm' : 'rounded-tl-sm'}`}
          style={{
            background: isError
              ? 'rgba(239, 68, 68, 0.1)'
              : isUser
                ? 'linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(99, 102, 241, 0.08) 100%)'
                : 'rgba(255, 255, 255, 0.03)',
            color: isError ? 'rgb(248, 113, 113)' : 'var(--text-primary)',
            border: isError ? '1px solid rgba(239, 68, 68, 0.2)' : undefined,
            minHeight: '1.5em',
          }}
        >
          {isError && <AlertCircle size={14} className="inline mr-1 mb-0.5" />}
          {isEditing ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                className="w-full bg-transparent border rounded-lg p-2 text-sm outline-none resize-none"
                style={{ borderColor: 'rgba(99, 102, 241, 0.3)', color: 'var(--text-primary)', minHeight: '60px' }}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleConfirmEdit(); }
                  if (e.key === 'Escape') handleCancelEdit();
                }}
              />
              <div className="flex items-center gap-2 justify-end">
                <button onClick={handleCancelEdit} className="text-xs px-2 py-1 rounded hover:bg-white/10 transition-colors" style={{ color: 'var(--text-muted)' }}>取消</button>
                <button onClick={handleConfirmEdit} className="text-xs px-2 py-1 rounded transition-colors" style={{ background: 'rgba(99, 102, 241, 0.2)', color: 'rgb(129, 140, 248)' }}>发送</button>
              </div>
            </div>
          ) : message.content ? (
            isUser ? message.content : <AssistantMarkdown content={message.content} />
          ) : (
            message.isStreaming && <MapSpinner size={16} color="var(--text-muted)" />
          )}
        </div>
        {/* Action buttons row */}
        {!isEditing && (
          <div className="flex items-center gap-1 px-1">
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {message.timestamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              {!isUser && message.totalTokens != null && (
                <span className="ml-1.5">{message.totalTokens} tokens</span>
              )}
            </span>
            {onCopy && (
              <button
                onClick={handleCopy}
                className="opacity-0 group-hover/msg:opacity-100 p-0.5 rounded hover:bg-white/10 transition-all"
                title="复制内容"
              >
                {copied
                  ? <Check size={12} style={{ color: 'rgb(74, 222, 128)' }} />
                  : <Copy size={12} style={{ color: 'var(--text-muted)' }} />}
              </button>
            )}
            {onFeedback && (
              <>
                <button
                  onClick={() => handleFeedback('up')}
                  className="opacity-0 group-hover/msg:opacity-100 p-0.5 rounded hover:bg-white/10 transition-all"
                  title="有帮助"
                >
                  <ThumbsUp size={12} style={{ color: feedback === 'up' ? 'rgb(74, 222, 128)' : 'var(--text-muted)' }} fill={feedback === 'up' ? 'rgb(74, 222, 128)' : 'none'} />
                </button>
                <button
                  onClick={() => handleFeedback('down')}
                  className="opacity-0 group-hover/msg:opacity-100 p-0.5 rounded hover:bg-white/10 transition-all"
                  title="没有帮助"
                >
                  <ThumbsDown size={12} style={{ color: feedback === 'down' ? 'rgb(248, 113, 113)' : 'var(--text-muted)' }} fill={feedback === 'down' ? 'rgb(248, 113, 113)' : 'none'} />
                </button>
              </>
            )}
            {onRegenerate && (
              <button
                onClick={onRegenerate}
                className="opacity-0 group-hover/msg:opacity-100 p-0.5 rounded hover:bg-white/10 transition-all"
                title="重新生成"
              >
                <RefreshCw size={12} style={{ color: 'var(--text-muted)' }} />
              </button>
            )}
            {onEditMessage && (
              <button
                onClick={handleStartEdit}
                className="opacity-0 group-hover/msg:opacity-100 p-0.5 rounded hover:bg-white/10 transition-all"
                title="编辑消息"
              >
                <Pencil size={12} style={{ color: 'var(--text-muted)' }} />
              </button>
            )}
            {onRetry && (
              <button
                onClick={onRetry}
                className="opacity-0 group-hover/msg:opacity-100 flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-white/10 transition-all text-[10px]"
                style={{ color: 'var(--status-error)' }}
                title="重试"
              >
                <RotateCcw size={11} />
                <span>重试</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function getWelcomeText(agentKey?: string): string {
  switch (agentKey) {
    case 'prd-agent': return '你可以上传 PRD 文档或直接粘贴内容，我会帮你解读需求、识别缺口并回答问题。';
    case 'visual-agent': return '描述你想要的图片，支持上传参考图。我会根据你的描述生成高质量图像。';
    case 'literary-agent': return '告诉我你想创作的主题，我可以帮你写文章、故事、诗歌等文学作品。';
    case 'defect-agent': return '描述你发现的问题，包括复现步骤和预期行为，支持上传截图。';
    case 'code-reviewer': return '粘贴代码或上传文件，我会进行代码审查并提供改进建议。';
    case 'translator': return '输入或上传需要翻译的内容，支持多种语言之间的互译。';
    case 'summarizer': return '粘贴长文本或上传文档，我会提取关键信息并生成摘要。';
    case 'data-analyst': return '描述分析需求或上传数据文件，我会帮你进行数据分析和可视化建议。';
    default: return '发送消息开始对话，支持上传文件和图片。';
  }
}
