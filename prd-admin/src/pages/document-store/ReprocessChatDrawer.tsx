import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Wand2, X, Send, Replace, FileDown, FilePlus2, RotateCw, AlertCircle,
  Bot, Plus, Trash2, Sparkles, ChevronDown, Check, FileText, Palette,
  PenTool, Bug, Video, FileBarChart, Brain, Lightbulb, Search, Layers,
  ImagePlus,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/design/Button';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming';
import { ChatMarkdown } from '@/pages/pa-agent/ChatMarkdown';
import { VisualCreationMiniPanel } from '@/components/visual-creation/VisualCreationMiniPanel';
import { PosterFeedCardView } from '@/components/weekly-poster/WeeklyPosterModal';
import type { WeeklyPosterPage } from '@/services/real/weeklyPoster';
import type { ShortVideoCard } from '@/services/real/shortVideoMaterials';
import {
  listReprocessAgents,
  createReprocessAgent,
  deleteReprocessAgent,
  applyReprocessContent,
  getDocumentContent,
  getDocumentStoreFolders,
  getActiveReprocessRun,
  getReprocessConversation,
  saveReprocessConversation,
  clearReprocessConversation,
  createShortVideoMaterialRun,
  getShortVideoMaterialRun,
} from '@/services';
import { streamDirectChat, listToolboxItems } from '@/services/real/aiToolbox';
import type { ToolboxItem } from '@/services/real/aiToolbox';
import { invokeAgent, listAgentCapabilities, getAgentParameters, createDefectFromContent } from '@/services/real/agentUniverse';
import type { AgentCapability, AgentArtifact, AgentParameter, AgentOutboundAction } from '@/services/real/agentUniverse';
import { BUILTIN_TOOLS } from '@/stores/toolboxStore';
import type { ReprocessAgent, DocumentStoreConversation } from '@/services/contracts/documentStore';
import { DocApplyDiffModal } from './DocApplyDiffModal';
import type { ApplyMode, FolderNode } from './docApplyPreview';
import { toast } from '@/lib/toast';

export type ReprocessChatDrawerProps = {
  entryId?: string;
  entryTitle?: string;
  storeId: string;
  initialMode?: 'document' | 'short-video';
  initialInput?: string;
  onClose: () => void;
  onApplied?: (mode: 'replace' | 'append' | 'new', entryId: string) => void;
  onStoreChanged?: () => void;
  onOpenEntry?: (target: { id: string; title: string; initialInput?: string }) => void;
};

// 简易图标 map（lucide name → component）覆盖 BUILTIN_TOOLS 用到的图标
const TOOLBOX_ICON_MAP: Record<string, LucideIcon> = {
  Palette, PenTool, Bug, Video, FileBarChart, Bot, FileText, Sparkles,
  Brain, Lightbulb, Search, Layers,
};

const TOOLBOX_ICON_HUE: Record<string, number> = {
  Palette: 330, PenTool: 45, Bug: 0, Video: 270, FileBarChart: 200,
  Bot: 210, FileText: 220, Sparkles: 280,
};

// 出站动作图标（lucide name → component）。后端 AgentOutboundAction.icon 取这里的 key。
const OUTBOUND_ICON_MAP: Record<string, LucideIcon> = {
  Bug, Send, FilePlus2, FileText, Sparkles, Video, FileBarChart, ImagePlus,
};

function ToolboxIcon({ name, size = 14 }: { name?: string; size?: number }) {
  const Comp = (name && TOOLBOX_ICON_MAP[name]) || Bot;
  const hue = (name && TOOLBOX_ICON_HUE[name]) ?? 210;
  return (
    <span
      className="inline-flex items-center justify-center rounded-[6px]"
      style={{
        width: size + 12,
        height: size + 12,
        background: `hsl(${hue} 70% 55% / 0.18)`,
        color: `hsl(${hue} 80% 75%)`,
        border: `1px solid hsl(${hue} 70% 50% / 0.30)`,
      }}
    >
      <Comp size={size} />
    </span>
  );
}

// 输入截断：避免 LLM context 爆
const MAX_DOC_CHARS = 40000;

function isLiteraryIllustrationRequest(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // 用户明确要"提示词/描述/方案"时保留文学文本链路；否则"配图看看"这类意图直达真实生图面板。
  if (/(提示词|prompt|描述|文案|构思|方案)/i.test(t) && !/(生成|出图|看看|直接)/.test(t)) return false;
  return /(配个?图|配一?张图|插图|生成.*图|出图|画[一张个幅]?.*图|做[一张个幅]?.*图|封面|头图|海报)/.test(t);
}

function buildLiteraryIllustrationPrompt(userText: string, entryTitle: string, docContent: string): string {
  const excerpt = docContent.trim().slice(0, 1800);
  return [
    `基于文档《${entryTitle}》生成一张配图。`,
    `用户要求：${userText.trim()}`,
    excerpt ? `参考正文：\n${excerpt}` : '',
    '画面要求：提炼正文的核心意象与情绪，做成可直接插入文档的横版配图；避免复刻具体 UI 截图，文字元素只保留必要标题或短句。',
  ].filter(Boolean).join('\n\n');
}

// 客户端 chat 历史持久化：direct-chat 不在后端落 Run，
// 关掉抽屉 / 切换标签后再开必须保留对话（Bugbot 九轮 Medium）。
// 项目禁用 localStorage，统一走 sessionStorage（no-localstorage.md 规则）。
const CHAT_HISTORY_STORAGE_KEY = 'reprocess-chat-drawer:history';
const MAX_PERSISTED_ENTRIES = 30;
type PersistedChatState = {
  messages: ChatMessage[];
  activeRef?: { kind: 'toolbox'; itemId: string } | { kind: 'kbAgent'; key: string } | { kind: 'shortVideoTool' };
};
function loadPersistedChat(entryId: string): PersistedChatState | null {
  try {
    const raw = sessionStorage.getItem(`${CHAT_HISTORY_STORAGE_KEY}:${entryId}`);
    return raw ? JSON.parse(raw) as PersistedChatState : null;
  } catch { return null; }
}
function savePersistedChat(entryId: string, state: PersistedChatState) {
  try {
    sessionStorage.setItem(`${CHAT_HISTORY_STORAGE_KEY}:${entryId}`, JSON.stringify(state));
    // 简单 LRU 上限：超出 30 条 entry key 时清最早的那一批，避免 sessionStorage 无限增长
    const indexKey = `${CHAT_HISTORY_STORAGE_KEY}:idx`;
    const idx: string[] = JSON.parse(sessionStorage.getItem(indexKey) || '[]');
    const next = idx.filter((id) => id !== entryId);
    next.push(entryId);
    while (next.length > MAX_PERSISTED_ENTRIES) {
      const evicted = next.shift()!;
      sessionStorage.removeItem(`${CHAT_HISTORY_STORAGE_KEY}:${evicted}`);
    }
    sessionStorage.setItem(indexKey, JSON.stringify(next));
  } catch { /* 配额满了就放弃，下次再试 */ }
}

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  invoker?: { kind: 'toolbox' | 'kbAgent'; label: string; ref: string; icon?: string };
  content: string;
  /** 生成型智能体产出的成果物（目前主要是图片），随流式逐个追加 */
  artifacts?: AgentArtifact[];
  /** 产出该消息的智能体的专属出站动作（如缺陷→创建缺陷），随消息记忆，写回按钮旁额外渲染 */
  outboundActions?: AgentOutboundAction[];
  streaming?: boolean;
  /** 流式阶段：thinking / streaming / done */
  phase?: 'thinking' | 'streaming' | 'done' | 'error';
  applied?: 'replace' | 'append' | 'new';
  quickActions?: ChatQuickAction[];
  /** 短视频解析运行：用于把粘贴链接的回复渲染成仿真短视频卡片（而非文字块） */
  shortVideoRun?: import('@/services').ShortVideoMaterialRun;
};

type ChatQuickAction = {
  key: string;
  label: string;
  entryId: string;
  title: string;
  initialInput?: string;
  icon?: 'video' | 'text' | 'timeline' | 'agent';
  group?: 'assets' | 'processing';
  description?: string;
};

/**
 * 把后端持久化的对话(DocumentStoreConversation)解析回前端快照 + mini 面板暂存图。
 * 后端只存 JSON blob，前端在此解析。导出供单测断言「后端优先 + 暂存图解析」。
 */
export function parseBackendConversation(
  convo: DocumentStoreConversation | null | undefined,
): { snapshot: PersistedChatState | null; pendingVisualUrl: string | null } {
  if (!convo) return { snapshot: null, pendingVisualUrl: null };
  let messages: ChatMessage[] = [];
  let activeRef: PersistedChatState['activeRef'];
  try {
    const parsed = JSON.parse(convo.messagesJson || '[]');
    if (Array.isArray(parsed)) messages = parsed as ChatMessage[];
  } catch { messages = []; }
  try {
    activeRef = convo.activeRefJson ? JSON.parse(convo.activeRefJson) : undefined;
  } catch { activeRef = undefined; }
  let pendingVisualUrl: string | null = null;
  try {
    const imgs = JSON.parse(convo.pendingImagesJson || '[]');
    if (Array.isArray(imgs) && imgs.length > 0 && imgs[0] && typeof imgs[0].url === 'string') {
      pendingVisualUrl = imgs[0].url;
    }
  } catch { pendingVisualUrl = null; }
  const snapshot = (messages.length > 0 || activeRef) ? { messages, activeRef } : null;
  return { snapshot, pendingVisualUrl };
}

/**
 * 合并两份对话快照（后端持久化 + sessionStorage）：按 id + 内容去重 union messages。
 * 切档时后端去抖保存会被取消，但 sessionStorage 已同步写入——只取后端会丢掉本地更新的消息
 * （Cursor Medium：stale backend overwrites newer session）。取并集避免任一方更新被丢；
 * 顺序以后端为基、本地新增追加在后（两源都是 append 日志，时序天然对齐）；activeRef 后端优先。
 * 导出供单测。
 */
export function mergeChatSnapshots(
  backend: PersistedChatState | null,
  session: PersistedChatState | null,
): PersistedChatState | null {
  if (!backend) return session;
  if (!session) return backend;
  const seenId = new Set<string>();
  const seenKey = new Set<string>();
  const merged: ChatMessage[] = [];
  for (const m of [...backend.messages, ...session.messages]) {
    const key = `${m.role}::${(m.content || '').slice(0, 200)}`;
    if (m.id && seenId.has(m.id)) continue;
    if (seenKey.has(key)) continue;
    if (m.id) seenId.add(m.id);
    seenKey.add(key);
    merged.push(m);
  }
  return { messages: merged, activeRef: backend.activeRef ?? session.activeRef };
}

type ActiveAgent =
  | { kind: 'toolbox'; item: ToolboxItem }
  | { kind: 'kbAgent'; agent: ReprocessAgent }
  | { kind: 'shortVideoTool' }
  | null;

const FOCUSED_TOOLBOX_IDS = [
  // 偏文本对话型 builtin agent 排前；视觉/视频/缺陷管理放后面
  'builtin-literary-agent',
  'builtin-report-agent',
  'builtin-pa-agent',
  'builtin-pm-agent',
  'builtin-task-tree',
];

const SHORT_VIDEO_TOOLBOX_ITEM: ToolboxItem = {
  id: 'builtin-short-video-parser',
  name: '短视频解析',
  description: '粘贴短视频链接后，先保存原始视频到知识库，再基于视频转写继续加工',
  icon: 'Video',
  category: 'builtin',
  type: 'builtin',
  kind: 'tool',
  agentKey: 'short-video-parser',
  routePath: '/document-store',
  permission: 'document-store.write',
  tags: ['短视频', '抖音', 'TikTok', '解析', '视频', '转写', '知识库'],
  usageCount: 0,
  createdAt: new Date().toISOString(),
  createdByName: '官方',
};

const SHORT_VIDEO_SESSION_PREFIX = 'short-video-tool:';
const SHORT_VIDEO_ACTIVE_RUN_KEY = 'short-video-material:active-run';

type ShortVideoResultLike = {
  run: import('@/services').ShortVideoMaterialRun;
  storeId: string;
  sourceEntryId: string;
  transcriptEntryId?: string;
  timelineEntryId?: string;
};

function shortVideoRunStorageKey(storeId: string) {
  return `${SHORT_VIDEO_ACTIVE_RUN_KEY}:${storeId}`;
}

function saveActiveShortVideoRun(storeId: string, runId: string) {
  try { sessionStorage.setItem(shortVideoRunStorageKey(storeId), runId); } catch { /* ignore */ }
}

function loadActiveShortVideoRun(storeId: string): string | null {
  try { return sessionStorage.getItem(shortVideoRunStorageKey(storeId)); } catch { return null; }
}

function extractUrl(text: string): string | null {
  const hit = text.match(/https?:\/\/[^\s"'<>]+/i);
  return hit?.[0] ?? null;
}

function shortVideoResultFromRun(run: import('@/services').ShortVideoMaterialRun): ShortVideoResultLike | null {
  if (!run.storeId || !run.sourceEntryId) return null;
  return {
    run,
    storeId: run.storeId,
    sourceEntryId: run.sourceEntryId,
    transcriptEntryId: run.transcriptEntryId || undefined,
    timelineEntryId: run.timelineEntryId || undefined,
  };
}

/** 把后端抽取的短视频卡片映射成海报 feed-card 组件所需的 WeeklyPosterPage（直接复用，不改组件）。 */
function shortVideoCardToPosterPage(card: ShortVideoCard): WeeklyPosterPage {
  const playable = card.videoUrl || undefined;        // 优先 COS 永久地址；入库前为空，仅显示封面
  const cover = card.coverUrl || undefined;
  return {
    order: 0,
    title: card.title || '短视频',
    body: '',
    imagePrompt: '',
    imageUrl: playable ?? cover ?? null,               // 有视频则播放视频，否则展示封面
    secondaryImageUrl: cover ?? null,                  // <video poster> 封面
    accentColor: null,
    authorName: card.authorName ?? null,
    authorAvatarUrl: card.authorAvatarUrl ?? null,
    platform: card.platform ?? null,
    durationSec: card.durationSec ?? null,
    hashtags: card.hashtags ?? null,
    stats: {
      likes: card.likeCount ?? null,
      comments: card.commentCount ?? null,
      shares: card.shareCount ?? null,
      collects: card.collectCount ?? null,
      plays: card.playCount ?? null,
    },
    transcriptCues: null,
  };
}

const SHORT_VIDEO_STAGE_LABELS: Record<string, string> = {
  parse: '解析链接',
  source: '保存原始视频',
  transcript: '视频转文字',
  timeline: '整理时间线',
  ready: '准备继续加工',
};

/** 卡片下方的一行状态（取代大段进度文字块；解析细节等卡片之后才轮到）。 */
function shortVideoCompactStatus(run: import('@/services').ShortVideoMaterialRun): { text: string; tone: 'busy' | 'done' | 'error' } {
  if (run.status === 'failed') return { text: '解析失败，可重试', tone: 'error' };
  const stages = run.stages ?? [];
  const running = stages.find((s) => s.status === 'running');
  if (running) return { text: `${SHORT_VIDEO_STAGE_LABELS[running.key] || running.label}…`, tone: 'busy' };
  if (run.status === 'done') {
    const transcript = stages.find((s) => s.key === 'transcript');
    if (transcript?.status === 'failed') return { text: '视频已入库（转写稍后可单独执行）', tone: 'done' };
    return { text: '已入库，可继续加工', tone: 'done' };
  }
  return { text: '正在处理…', tone: 'busy' };
}

function getShortVideoStageLabel(stage: import('@/services').ShortVideoMaterialStage): string {
  return SHORT_VIDEO_STAGE_LABELS[stage.key] || stage.label;
}

function formatShortVideoStageLine(stage: import('@/services').ShortVideoMaterialStage): string {
  const label = getShortVideoStageLabel(stage);
  const message = stage.message?.trim();
  if (stage.status === 'done') return `- ${label}：已完成${message ? `。${message}` : ''}`;
  if (stage.status === 'running') return `- ${label}：正在处理${message ? `。${message}` : ''}`;
  if (stage.status === 'failed') return `- ${label}：处理失败${message ? `。${message}` : ''}`;
  return `- ${label}：等待中${message && message !== '等待提交' ? `。${message}` : ''}`;
}

function formatShortVideoRunStatus(status: import('@/services').ShortVideoMaterialRun['status']): string {
  if (status === 'queued') return '等待后台开始';
  if (status === 'running') return '后台正在处理';
  if (status === 'done') return '已完成';
  if (status === 'failed') return '处理失败';
  return '已取消';
}

function formatShortVideoProgress(run: import('@/services').ShortVideoMaterialRun): string {
  const lines = [
    `后台任务：${formatShortVideoRunStatus(run.status)}`,
    '',
    '处理进度（来自服务器，刷新后仍会保留）：',
    ...((run.stages ?? []).map(formatShortVideoStageLine)),
  ];
  return lines.join('\n');
}

function buildShortVideoResultMessage(result: ShortVideoResultLike): string {
  const title = result.run.title || '短视频素材';
  const parserMessage = result.run.parserMessage?.trim();
  const hasTranscript = Boolean(result.transcriptEntryId);
  return [
    `已保存视频到知识库：「${title}」。`,
    parserMessage ? `解析说明：${parserMessage}` : null,
    hasTranscript
      ? '已从视频生成原始文字并保存到知识库；文案、润色和时间线属于后续加工，不会默认生成。'
      : '当前只保存了原始视频；没有生成文字条目，也不会把平台标题或描述当成字幕。',
    '',
    '处理进度（来自服务器，刷新后仍会保留）：',
    ...((result.run.stages ?? []).map(formatShortVideoStageLine)),
    '',
    '已入库产物：',
    `- 原始视频：${title}.mp4`,
    hasTranscript ? `- 原始文字：${title} · 原始转写文字` : null,
    '',
    '你可以先停在这里，也可以选择下方动作继续加工。',
  ].filter((line): line is string => line !== null).join('\n');
}

function buildShortVideoQuickActions(result: ShortVideoResultLike): ChatQuickAction[] {
  const title = result.run.title || '短视频素材';
  const actions: ChatQuickAction[] = [
    {
      key: 'open-source',
      label: '原始视频',
      entryId: result.sourceEntryId,
      title: `${title}.mp4`,
      icon: 'video',
      group: 'assets',
      description: '打开已保存到知识库的原始视频',
    },
  ];

  if (!result.transcriptEntryId) return actions;

  actions.push(
    {
      key: 'open-transcript',
      label: '原始文字',
      entryId: result.transcriptEntryId,
      title: `${title} · 原始转写文字.md`,
      icon: 'text',
      group: 'assets',
      description: '打开从视频转写出的原始文字',
    },
    {
      key: 'literal-copy',
      label: '一字不变',
      entryId: result.transcriptEntryId,
      title: `${title} · 原始转写文字.md`,
      initialInput: '请基于这份原始转写文字整理成可阅读文案，尽量一字不变保留原话，只处理段落、标点和标题层级。',
      icon: 'agent',
      group: 'processing',
      description: '基于原始文字整理成尽量保留原话的文案',
    },
    {
      key: 'enhance-copy',
      label: '补充润色',
      entryId: result.transcriptEntryId,
      title: `${title} · 原始转写文字.md`,
      initialInput: '请基于这份原始转写文字整理成教程文案，可以补充必要背景、步骤解释和小标题，但不要改变原视频的核心意思。',
      icon: 'agent',
      group: 'processing',
      description: '基于原始文字补充背景并整理成教程文案',
    },
    {
      key: 'timeline-copy',
      label: '转时间线',
      entryId: result.transcriptEntryId,
      title: `${title} · 原始转写文字.md`,
      initialInput: '请把这份原始转写文字整理成清晰的时间线，每一步包含时间段、动作、材料和检查点。',
      icon: 'timeline',
      group: 'processing',
      description: '把原始文字整理为时间线或步骤化教程',
    },
  );
  return actions;
}

// 哪些 builtin 智能体可在此处选用，现在由「智能体宇宙」能力契约决定（后端 SSOT）：
// 只有在 AgentCapabilityRegistry 注册了能力的 agentKey 才会出现，且各自按 invokeMode
// 走对应交互（视觉创作=文生图、文学/周报=聊天流、缺陷=结构化），不再喂通用 chat。

export function ReprocessChatDrawer({
  entryId,
  entryTitle = '短视频素材解析',
  storeId,
  initialMode = 'document',
  initialInput,
  onClose,
  onApplied,
  onStoreChanged,
  onOpenEntry,
}: ReprocessChatDrawerProps) {
  const isShortVideoMode = initialMode === 'short-video';
  const conversationKey = entryId ?? `${SHORT_VIDEO_SESSION_PREFIX}${storeId}`;
  const [toolboxItems, setToolboxItems] = useState<ToolboxItem[]>([]);
  const [kbAgents, setKbAgents] = useState<ReprocessAgent[]>([]);
  const [docContent, setDocContent] = useState<string>('');
  const [docTruncated, setDocTruncated] = useState(false);
  const [loadingDoc, setLoadingDoc] = useState(true);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [docLoadError, setDocLoadError] = useState<string | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [active, setActive] = useState<ActiveAgent>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // 智能体能力契约（后端 SSOT 下发）：决定哪些 builtin 智能体可选 + 各自交互形态
  const [capabilities, setCapabilities] = useState<AgentCapability[]>([]);
  // 当前生成型智能体的可选参数（尺寸/模型，后端按真实池下发）+ 用户的选择
  const [agentParams, setAgentParams] = useState<AgentParameter[]>([]);
  const [selectedParams, setSelectedParams] = useState<Record<string, string>>({});
  // 视觉创作 mini 面板的预填提示词（文学「为这段配图」时带入）
  const [visualInitialPrompt, setVisualInitialPrompt] = useState('');
  // 文学智能体自己的配图模式：UI 仍归属 literary-agent，底层走 literary-agent/image-gen。
  const [literaryImageMode, setLiteraryImageMode] = useState(false);
  // mini 面板「已生成未插入」的图（后端持久化，关浏览器标签页也不丢）
  const [pendingVisualUrl, setPendingVisualUrl] = useState<string | null>(null);
  // 写回前确认闸：handleApply 不再直接写库，先把意图存这里弹 diff 预览窗，确认才落库
  // （CLAUDE.md「让用户感知改动」—— 破坏性 replace / 改原文件的 append 都过闸）
  const [pendingApply, setPendingApply] = useState<{ msgId: string; mode: ApplyMode } | null>(null);
  // 可观测性：当前流式调用解析到的模型 / 平台（onStart 透出），面板顶部低饱和展示
  // （.claude/rules/ai-model-visibility.md：中大型 AI 功能必须让用户看见在调哪个模型）
  const [streamModel, setStreamModel] = useState<{ model?: string; platform?: string } | null>(null);
  // Phase 2：本知识库的目录（文件夹）列表，供「另存为新文档」选择落点目录
  const [folders, setFolders] = useState<FolderNode[]>([]);

  const cancelStreamRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pickerBtnRef = useRef<HTMLButtonElement>(null);
  // 同步发送锁：state 是异步的，React 还没提交 setStreamingId 之前
  // 第二次点击/双击可能溜过 isBusy 检查同时跑两条流（Bugbot #2 二轮 Medium）。
  // 用 ref 立刻翻转，发送入口先抢这把 ref 锁，再触发任何 state 变更。
  const sendLockRef = useRef(false);
  // 当前 entry id 锁：异步任务（fetch / apply）返回时校验 entry 没变才能写 state
  // 否则 apply 在 doc A 上跑，返回时 doc 已切到 B，错把"成功"绑到 B（Bugbot #3 二轮 Medium）。
  const entryIdRef = useRef(conversationKey);
  const initialInputAppliedRef = useRef(false);
  const restoredShortVideoRunRef = useRef<string | null>(null);
  const shortVideoPollTokenRef = useRef(0);
  // 同步 apply 锁：和 sendLockRef 同思路，state 异步 setApplying 之前快速双击会让
  // 两次 handleApply 都跑过 if(applying) 检查，跑两次写回（Codex P2 十轮）
  const applyLockRef = useRef(false);
  // 标记本 entryId 的 load effect 已完整跑完（含 setMessages 等所有同步赋值）。
  // 持久化 effect 只在 load 完成后才写 sessionStorage，避免在 entryId 切换瞬间把
  // 上一篇 messages 错写到新 entryId 的 key 下（Bugbot #2 十轮 High）
  const lastLoadedEntryRef = useRef<string | null>(null);
  // 后端对话持久化去抖定时器（避免每条消息都打一次 PUT）
  const backendSaveTimerRef = useRef<number | null>(null);
  // 历史注：曾经维护过 sentForLlmRef 想把每轮发给 LLM 的完整 wrapper（含 doc）
  // 塞进 history，让"模型 N 轮后看到的还是 N 轮前那份 doc"。但 doc 可能 40k 字，
  // 多轮放大成 N × 40k token，得不偿失。改为标准 chat-with-doc 模式：history 走
  // 短 bubble text，doc 只放本轮 message。该 ref 已彻底移除（Bugbot 八轮 Medium）。

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  }, []);

  const nextShortVideoPollToken = useCallback(() => {
    shortVideoPollTokenRef.current += 1;
    return shortVideoPollTokenRef.current;
  }, []);

  const isShortVideoPollActive = useCallback((ownerKey: string, pollToken: number) => (
    entryIdRef.current === ownerKey && shortVideoPollTokenRef.current === pollToken
  ), []);

  // 中止当前 stream 的统一入口：除了 abort fetch，还要清 streamingId 和 sendLockRef，
  // 否则 chip / 输入框会一直 disabled（Bugbot #2）
  const abortCurrentStream = useCallback(() => {
    shortVideoPollTokenRef.current += 1;
    cancelStreamRef.current?.();
    cancelStreamRef.current = null;
    sendLockRef.current = false;
    setStreamingId(null);
  }, []);

  // 加载：文档全文 + 百宝箱 + KB 智能体（并行）
  //
  // entryId 切换时必须把上一篇文档的对话 / 选中 / 错误 / 缓存正文全部清掉
  // 否则会出现"显示新文档但写回上一篇"的串数据（Bugbot #1，High）
  useEffect(() => {
    let cancelled = false;
    entryIdRef.current = conversationKey;
    initialInputAppliedRef.current = false;
    sendLockRef.current = false;
    applyLockRef.current = false;
    lastLoadedEntryRef.current = null; // 新 entryId 还没初始化完，持久化先停
    abortCurrentStream();
    // 切换文档时取消上一篇挂起的去抖后端保存：否则它带着旧闭包在切换后才落库
    // （Bugbot Medium：debounced save survives entry switch）。只在 effect 体里清，
    // 不放进 cleanup —— 关抽屉(卸载)时仍让最后一次 save 落库，不丢"关页前的最新态"。
    if (backendSaveTimerRef.current) {
      window.clearTimeout(backendSaveTimerRef.current);
      backendSaveTimerRef.current = null;
    }
    setMessages([]);
    setActive(isShortVideoMode ? { kind: 'shortVideoTool' } : null);
    setError(null);
    setApplying(null);
    setInput('');
    // 切文档必须把上一篇「已生成未插入」的暂存图也清掉：否则新文档若无暂存图，
    // 旧 URL 会残留并被持久化进新文档的 pendingImagesJson（Codex P2：pending image 串档）
    setPendingVisualUrl(null);
    // 切文档必须关掉上一篇挂起的写回确认窗 + 清掉模型徽标，否则会把旧 diff/旧模型名带到新文档
    setPendingApply(null);
    setStreamModel(null);
    setDocContent('');
    setDocTruncated(false);
    setDocLoadError(null);
    // 同样清掉智能体列表 + 关闭下拉，避免新文档 fetch 期间下拉短暂展示上一篇的
    // toolbox/kbAgent 数据（Bugbot #2 八轮 Low）
    setToolboxItems([]);
    setKbAgents([]);
    setPickerOpen(false);
    setLoadingDoc(true);
    setLoadingAgents(true);

    if (isShortVideoMode) {
      setDocContent('');
      setDocTruncated(false);
      setDocLoadError(null);
      setLoadingDoc(false);
    } else if (!entryId) {
      setDocLoadError('未选择文档，无法作为输入喂给智能体');
      setLoadingDoc(false);
    } else {
      (async () => {
        try {
          const docRes = await getDocumentContent(entryId);
          if (cancelled || entryIdRef.current !== conversationKey) return;
          if (docRes.success) {
            const raw = docRes.data.content ?? '';
            if (!raw || raw.trim().length === 0) {
              // 文档本来就空（无 DocumentId 且无 ContentIndex）—— 这是合法状态
              // 但禁止把"空文档"喂给 LLM，否则智能体回的内容跟当前文档无关，写回还会污染数据
              setDocLoadError('文档没有可读正文，无法作为输入喂给智能体');
            }
            setDocContent(raw);
            setDocTruncated(raw.length > MAX_DOC_CHARS);
            if (raw.length > MAX_DOC_CHARS) setDocContent(raw.slice(0, MAX_DOC_CHARS));
          } else {
            setDocLoadError(docRes.error?.message || '读取文档失败');
          }
        } catch (e) {
          if (cancelled || entryIdRef.current !== conversationKey) return;
          setDocLoadError(e instanceof Error ? e.message : '读取文档异常');
        } finally {
          if (!cancelled && entryIdRef.current === conversationKey) setLoadingDoc(false);
        }
      })();
    }

    (async () => {
      const [agentRes, toolboxRes, activeRunRes, capRes, convoRes] = await Promise.all([
        listReprocessAgents(),
        listToolboxItems(),
        entryId && !isShortVideoMode ? getActiveReprocessRun(entryId) : Promise.resolve({ success: true, data: null }),
        listAgentCapabilities(),
        entryId && !isShortVideoMode ? getReprocessConversation(entryId) : Promise.resolve({ success: true, data: null }),
      ]);
      if (cancelled || entryIdRef.current !== conversationKey) return;

      const caps = capRes.success ? capRes.data.capabilities : [];
      setCapabilities(caps);
      const capKeys = new Set(caps.map((c) => c.agentKey));

      // 只展示在「智能体宇宙」注册了能力契约的 builtin 智能体；各自按 invokeMode 走对应交互
      const builtinAgents = BUILTIN_TOOLS.filter((t) =>
        !t.wip && !!t.agentKey && capKeys.has(t.agentKey));
      const userOwnedToolbox = toolboxRes.success
        ? (toolboxRes.data.items as ToolboxItem[]).filter((t) => !!t.systemPrompt)
        : [];
      const ordered = builtinAgents.sort((a, b) => {
        const ia = FOCUSED_TOOLBOX_IDS.indexOf(a.id);
        const ib = FOCUSED_TOOLBOX_IDS.indexOf(b.id);
        if (ia < 0 && ib < 0) return 0;
        if (ia < 0) return 1;
        if (ib < 0) return -1;
        return ia - ib;
      });
      setToolboxItems(isShortVideoMode
        ? [SHORT_VIDEO_TOOLBOX_ITEM, ...ordered, ...userOwnedToolbox]
        : [...ordered, ...userOwnedToolbox]);

      const loadedKbAgents = agentRes.success ? agentRes.data.items : [];
      if (agentRes.success) setKbAgents(loadedKbAgents);
      setLoadingAgents(false);

      // 优先以 sessionStorage 持久化为准：新架构走 direct-chat 不写后端 Run，
      // 后端 active-run 是历史遗物，如果用户上次跑过旧 worker，那条会一直是
      // "最新 run"反复污染新会话（Bugbot 十四轮 Medium）。所以只在没有客户端缓存
      // 时才合并后端历史，作为"刚 clean session 后给个起点"的兜底。
      // 后端持久化优先（关浏览器标签页/换设备都不丢）；无后端记录时回退 sessionStorage。
      // 后端快照走与 sessionStorage 相同的 PersistedChatState 形状，下游 merge 逻辑零改动。
      const backendConvo = parseBackendConversation(convoRes.success ? convoRes.data : null);
      if (backendConvo.pendingVisualUrl) setPendingVisualUrl(backendConvo.pendingVisualUrl);
      // 合并后端 + sessionStorage 两源，避免切档取消后端去抖保存后、重开只取到较旧后端快照
      // 而丢掉本地更新的消息（Cursor Medium F4）。
      const persistedSnapshot = mergeChatSnapshots(backendConvo.snapshot, loadPersistedChat(conversationKey));
      const hasFreshPersisted = !!persistedSnapshot
        && (persistedSnapshot.messages.length > 0 || !!persistedSnapshot.activeRef);

      // 恢复后端持久化的对话：旧 /reprocess/chat 路径会把 messages 存到 run 里。
      // 重开抽屉时把它还原成 ChatMessage，让用户能看见上一次没读完的对话（Bugbot #4 五轮 Medium）
      const activeRun = (!hasFreshPersisted && activeRunRes.success) ? activeRunRes.data : null;
      if (activeRun && activeRun.messages && activeRun.messages.length > 0) {
        // 旧 worker 路径 done 后会把 finalContent 自动落盘成新 DocumentEntry 并写
        // outputEntryId 回 run。这意味着对应的 assistant 内容已经"另存为新文档"过
        // 一次了，重开抽屉时如果让那一条的写回按钮再可点，用户会再创建一份重复
        // 文档（Codex P2 十四轮）。把最后一条 assistant 标 applied:'new'。
        const autoSavedAsstSeq = activeRun.outputEntryId
          ? activeRun.messages.map((m, i) => ({ m, i }))
              .filter((x) => x.m.role === 'assistant')
              .pop()?.i ?? -1
          : -1;
        const restored: ChatMessage[] = activeRun.messages.map((m, idx) => {
          // 反查 user 消息的 templateKey 对应的 agent 名字，让气泡能显示徽章
          let invoker: ChatMessage['invoker'] | undefined;
          if (m.role === 'user' && m.templateKey) {
            const tb = ordered.find((t) => t.agentKey === m.templateKey)
              ?? userOwnedToolbox.find((t) => t.id === m.templateKey);
            const kb = loadedKbAgents.find((a) => a.key === m.templateKey);
            if (tb) {
              invoker = { kind: 'toolbox', label: tb.name, ref: tb.id, icon: tb.icon };
            } else if (kb) {
              invoker = { kind: 'kbAgent', label: kb.label, ref: kb.key };
            }
          }
          return {
            id: `restored-${activeRun.id}-${idx}`,
            role: m.role,
            content: m.content,
            invoker,
            phase: 'done',
            ...(idx === autoSavedAsstSeq ? { applied: 'new' as const } : {}),
          };
        });
        setMessages(restored);
        // 选中最近一次 user 消息对应的 agent，方便用户直接追问
        const lastUserMsg = [...activeRun.messages].reverse().find((m) => m.role === 'user');
        if (lastUserMsg?.templateKey) {
          const tb = ordered.find((t) => t.agentKey === lastUserMsg.templateKey)
            ?? userOwnedToolbox.find((t) => t.id === lastUserMsg.templateKey);
          const kb = loadedKbAgents.find((a) => a.key === lastUserMsg.templateKey);
          if (tb) setActive({ kind: 'toolbox', item: tb });
          else if (kb) setActive({ kind: 'kbAgent', agent: kb });
        }
      }

      // 客户端 sessionStorage 里 direct-chat 留下的对话——新架构的主要持久化路径
      // （Bugbot 九轮 Medium）。复用上面已读出的 persistedSnapshot，不再二次 load。
      if (persistedSnapshot) {
        if (persistedSnapshot.messages.length > 0) {
          setMessages((prev) => {
            // id 去重（同会话同次创建）+ 内容去重（同条消息可能既在 worker run 里也在
            // sessionStorage 里，client id 不同但 role+content 相同）（Bugbot #3 十轮 Medium）
            const seenById = new Set(prev.map((m) => m.id));
            const seenByContent = new Set(prev.map((m) => `${m.role}::${(m.content || '').slice(0, 200)}`));
            const fresh = persistedSnapshot.messages.filter((m) =>
              !seenById.has(m.id)
              && !seenByContent.has(`${m.role}::${(m.content || '').slice(0, 200)}`));
            return [...prev, ...fresh];
          });
        }
        // 旧 worker 路径若已经设过 setActive 就跳过 persisted 的 activeRef，避免冲突
        const workerSetActive = !!(activeRun
          && (activeRun.messages || []).slice().reverse().find((m) => m.role === 'user')?.templateKey);
        if (persistedSnapshot.activeRef && !workerSetActive) {
          const ref = persistedSnapshot.activeRef;
          if (ref.kind === 'toolbox') {
            const tb = ordered.find((t) => t.id === ref.itemId)
              ?? userOwnedToolbox.find((t) => t.id === ref.itemId);
            if (tb) setActive({ kind: 'toolbox', item: tb });
          } else if (ref.kind === 'kbAgent') {
            const kb = loadedKbAgents.find((a) => a.key === ref.key);
            if (kb) setActive({ kind: 'kbAgent', agent: kb });
          } else if (ref.kind === 'shortVideoTool') {
            setActive({ kind: 'shortVideoTool' });
          }
        }
      }

      if (isShortVideoMode) {
        setActive((prev) => prev ?? { kind: 'shortVideoTool' });
      }

      // 至此本 entryId 的初始化（doc 之外的部分）已全部 setState 完毕，标记 ready。
      // 持久化 effect 看到这个 ref 才会开始写 sessionStorage（Bugbot #2 十轮 High）
      if (entryIdRef.current === conversationKey) lastLoadedEntryRef.current = conversationKey;
    })();

    return () => {
      cancelled = true;
      abortCurrentStream();
    };
    // abortCurrentStream 是 stable useCallback，不会触发 effect 抖动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationKey, entryId, isShortVideoMode]);

  // 关闭浮层时也走统一 abort，确保 streamingId 被清掉
  useEffect(() => () => abortCurrentStream(), [abortCurrentStream]);

  // Phase 2：拉本知识库目录，供「另存为新文档」选择落点（storeId 变更时刷新）
  useEffect(() => {
    if (!storeId) { setFolders([]); return; }
    let cancelled = false;
    (async () => {
      const res = await getDocumentStoreFolders(storeId);
      if (!cancelled && res.success) setFolders(res.data.folders ?? []);
    })();
    return () => { cancelled = true; };
  }, [storeId]);

  // 把对话持久化到 sessionStorage：direct-chat 不存后端，关掉抽屉后再开必须能恢复
  // （Bugbot 九轮 Medium）。
  //
  // 三重防护：
  // 1) 流式中不写：onText 每收到一段 chunk 都会 setMessages，effect 会被触发；
  //    如果照写就会把"未完成的 AI 回复"持久化为 phase=done，下次重开后用户能
  //    把残缺文本写回文档（Bugbot #1 十轮 High）
  // 2) entry 切换瞬间不写：useEffect 在 reset commit 之前可能跑一次，此时 entryId
  //    已经是新的但 messages 还是旧的，会把上一篇内容写到新 entry key 下
  //    （Bugbot #2 十轮 High）。靠 lastLoadedEntryRef 标记 load 完成才放行
  // 3) 干净空状态不写
  useEffect(() => {
    if (loadingDoc || loadingAgents) return;
    if (streamingId !== null) return;                      // 流式中不快照
    if (lastLoadedEntryRef.current !== conversationKey) return;    // 初始化没完成不快照
    if (messages.length === 0 && !active) return;
    // 双保险：万一仍有 streaming/thinking 的气泡，过滤掉，避免落"未完成"成"完成"
    const sanitized = messages.filter((m) => !m.streaming && m.phase !== 'streaming' && m.phase !== 'thinking');
    if (sanitized.length === 0 && !active) return;
    const activeRef: PersistedChatState['activeRef'] = active?.kind === 'toolbox'
      ? { kind: 'toolbox', itemId: active.item.id }
      : active?.kind === 'kbAgent'
        ? { kind: 'kbAgent', key: active.agent.key }
        : active?.kind === 'shortVideoTool'
          ? { kind: 'shortVideoTool' }
          : undefined;
    savePersistedChat(conversationKey, { messages: sanitized, activeRef });
    if (!entryId || isShortVideoMode) return;
    // 同步落后端（去抖 800ms）：这才是关浏览器标签页也不丢的持久化（sessionStorage 关页即焚）。
    // pendingVisualUrl 一并带上，让 mini 面板「已生成未插入」的图也恢复。
    if (backendSaveTimerRef.current) window.clearTimeout(backendSaveTimerRef.current);
    const messagesJson = JSON.stringify(sanitized);
    const pendingImagesJson = JSON.stringify(pendingVisualUrl ? [{ url: pendingVisualUrl }] : []);
    const activeRefJson = activeRef ? JSON.stringify(activeRef) : null;
    backendSaveTimerRef.current = window.setTimeout(() => {
      void saveReprocessConversation(entryId, { messagesJson, pendingImagesJson, activeRefJson });
    }, 800);
  }, [conversationKey, entryId, isShortVideoMode, messages, active, loadingDoc, loadingAgents, streamingId, pendingVisualUrl]);

  // 点击外面关闭 picker
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (!pickerBtnRef.current?.contains(e.target as Node)) {
        const dropdown = document.getElementById('reprocess-agent-picker-dropdown');
        if (dropdown && !dropdown.contains(e.target as Node)) setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerOpen]);

  useEffect(() => {
    if (!initialInput || initialInputAppliedRef.current) return;
    if (loadingDoc || loadingAgents) return;
    initialInputAppliedRef.current = true;
    setInput(initialInput);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [initialInput, loadingDoc, loadingAgents]);

  // agentKey → 能力契约。只有 builtin 智能体（带 agentKey）才有契约；
  // 自定义工具 / 我的快捷智能体没有契约，走传统 direct-chat 文本链路。
  const capabilityMap = useMemo(() => {
    const m = new Map<string, AgentCapability>();
    for (const c of capabilities) m.set(c.agentKey, c);
    return m;
  }, [capabilities]);

  const capabilityForAgent = useCallback((agent: ActiveAgent): AgentCapability | undefined => {
    if (agent?.kind === 'toolbox' && agent.item.type === 'builtin' && agent.item.agentKey) {
      return capabilityMap.get(agent.item.agentKey);
    }
    return undefined;
  }, [capabilityMap]);

  const activeCapability = useMemo(
    () => capabilityForAgent(active),
    [active, capabilityForAgent],
  );

  // 选中生成型智能体时，拉它的「可选参数」（尺寸/模型，后端按真实池下发）。
  // 非生成型 / 无可选项 → 清空，不渲染选择器（"如果可选才选"）。
  useEffect(() => {
    const cap = activeCapability;
    if (!cap || cap.invokeMode !== 'generation') {
      setAgentParams([]);
      setSelectedParams({});
      return;
    }
    let cancelled = false;
    (async () => {
      const res = await getAgentParameters(cap.agentKey);
      if (cancelled) return;
      if (res.success) {
        const ps = res.data.parameters ?? [];
        setAgentParams(ps);
        const defaults: Record<string, string> = {};
        for (const p of ps) if (p.default) defaults[p.key] = p.default;
        setSelectedParams(defaults);
      } else {
        setAgentParams([]);
        setSelectedParams({});
      }
    })();
    return () => { cancelled = true; };
  }, [activeCapability]);

  // ── 发送消息 ──
  const sendMessage = useCallback(async (
    userText: string,
    invoker: ChatMessage['invoker'],
    agent: ActiveAgent,
  ) => {
    // ⚠ 用 ref 同步锁，杜绝 React state 还没提交时双击/快速回车跑两条流（Bugbot #2 二轮）
    if (sendLockRef.current) return;
    if (!userText.trim()) return;
    if (!entryId) {
      toast.warning('未选择文档', '普通智能体需要先打开一篇文档');
      return;
    }
    if (loadingDoc) {
      toast.warning('请稍候', '文档还在加载');
      return;
    }
    if (docLoadError) {
      toast.warning('无法调用', docLoadError);
      return;
    }
    const cap = capabilityForAgent(agent);
    const isGeneration = cap?.invokeMode === 'generation';
    // 百宝箱自定义智能体（用户自建，type!=='builtin'）也走统一 invoke 信封（custom:{id}）。
    // 它的 systemPrompt 由后端实时读库，新建任意自定义智能体即可立刻接入，无需改代码。
    const isCustomToolbox = agent?.kind === 'toolbox' && agent.item.type !== 'builtin';

    // chat / 结构化类把文档作为输入，必须有正文；生成类只需文本 prompt，可不依赖文档
    if (!isGeneration && (!docContent || docContent.trim().length === 0)) {
      // 防御：文档为空时不让 chat 类发送（Bugbot #1 二轮 Medium）
      toast.warning('文档无正文', '没有可读正文喂给智能体');
      return;
    }
    sendLockRef.current = true;
    setError(null);

    const userMsgId = 'u-' + Date.now();
    const asstMsgId = 'a-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const userMsg: ChatMessage = {
      id: userMsgId, role: 'user', content: userText.trim(), invoker,
    };
    const asstMsg: ChatMessage = {
      id: asstMsgId, role: 'assistant', content: '', streaming: true, phase: 'thinking', invoker,
      // 记住产出该消息的智能体的专属出站动作（如缺陷→创建缺陷），写回按钮旁额外渲染
      outboundActions: cap?.outboundActions,
    };

    // 多轮 history 只塞 bubble text（用户原话 / AI 原回复），不重复嵌文档。
    // doc 只作为本轮输入，模型靠当前消息看最新文档、靠 history 看对话脉络
    // （避免每轮把 40k 字文档塞进 history × N 条吃光 token；Bugbot 八轮 Medium）。
    const history = messages
      .map((m) => ({ role: m.role, content: m.content }))
      .filter((m) => m.content);

    setMessages((prev) => [...prev, userMsg, asstMsg]);
    setStreamingId(asstMsgId);
    setInput('');
    scrollToBottom();

    // 锁定本次 stream 关联的 entry id：异步回调到来时如果用户已经切到别的文档，
    // 不能再写当前 drawer 的 state（错把上一篇的错误/完成态绑到新文档上），也不能
    // 释放 sendLockRef（新文档可能已经在 streaming）（Bugbot #3 五轮 Medium）
    const streamOwnerEntryId = entryId;
    const isOwnedByCurrentEntry = () => entryIdRef.current === streamOwnerEntryId;

    // 统一流式回调（「智能体宇宙」信封与传统 direct-chat 共用同一套）
    const onText = (chunk: string) => {
      if (!isOwnedByCurrentEntry()) return;
      setMessages((prev) => prev.map((m) =>
        m.id === asstMsgId
          ? { ...m, content: m.content + chunk, phase: 'streaming' }
          : m));
      scrollToBottom();
    };
    const onError = (msg: string) => {
      if (!isOwnedByCurrentEntry()) return; // 来自上一篇文档的 stream，丢弃
      // 把权限相关错误（403）特别标注，提示用户去申请 ai-toolbox.use（Codex P2 十轮）
      const rawMsg = msg || '调用失败';
      const isPermError = /\b403\b|权限|forbidden/i.test(rawMsg);
      const friendlyMsg = isPermError
        ? 'AI 写作链路需要「百宝箱使用」权限（ai-toolbox.use）。当前账号没有这个权限，请联系管理员开通后再试。'
        : rawMsg;
      setError(friendlyMsg);
      setMessages((prev) => prev.map((m) =>
        m.id === asstMsgId
          ? { ...m, streaming: false, phase: 'error',
              content: m.content || `（调用失败：${friendlyMsg}）` }
          : m));
      setStreamingId(null);
      sendLockRef.current = false;
    };
    const onDone = (tokenInfo?: { totalTokens?: number }) => {
      if (!isOwnedByCurrentEntry()) return;
      // content 非空或有图片产出 → done；完全空且无 token → 截断 error（Bugbot/Codex 十二轮）
      let emptyAndNoToken = false;
      setMessages((prev) => prev.map((m) => {
        if (m.id !== asstMsgId) return m;
        const empty = (!m.content || m.content.trim().length === 0)
          && (!m.artifacts || m.artifacts.length === 0);
        if (empty && !tokenInfo) {
          emptyAndNoToken = true;
          return { ...m, streaming: false, phase: 'error',
            content: '（连接中断或上游未返回任何内容）' };
        }
        return { ...m, streaming: false, phase: 'done' };
      }));
      if (emptyAndNoToken) setError('上游未返回任何内容，请重新发起。');
      setStreamingId(null);
      sendLockRef.current = false;
    };
    // 可观测性：流开始时上游解析到的模型 / 平台，落到顶部徽标（禁止前端硬编码模型名）
    const onStart = (info: { model?: string; platform?: string }) => {
      if (!isOwnedByCurrentEntry()) return;
      if (info.model || info.platform) setStreamModel({ model: info.model, platform: info.platform });
    };

    // ── 路由：统一「智能体宇宙」信封 ──
    // builtin（有契约）→ 后端路由到真实适配器（生成型出图 / chat 文本）
    // 自定义百宝箱智能体 → 后端 custom:{id} 实时读库 systemPrompt 跑真实网关
    // 两者共用同一个 invoke，新建自定义智能体即可立刻接入。
    if (cap || isCustomToolbox) {
      const invokeKey = cap
        ? cap.agentKey
        : `custom:${agent?.kind === 'toolbox' ? agent.item.id : ''}`;
      const stop = invokeAgent({
        agentKey: invokeKey,
        text: userText.trim(),
        documentContent: isGeneration ? undefined : docContent,
        // 面板选择的尺寸/模型透传给真实适配器（仅生成型、且确有选择时）
        parameters: isGeneration && Object.keys(selectedParams).length > 0 ? selectedParams : undefined,
        history: isGeneration ? undefined : (history.length > 0 ? history : undefined),
        onStart,
        onText,
        onArtifact: (art) => {
          if (!isOwnedByCurrentEntry()) return;
          setMessages((prev) => prev.map((m) =>
            m.id === asstMsgId
              ? { ...m, artifacts: [...(m.artifacts ?? []), art], phase: 'streaming' }
              : m));
          scrollToBottom();
        },
        onError,
        onDone,
      });
      cancelStreamRef.current = stop;
      return;
    }

    // ── 兜底：自定义工具（itemId）/ 我的快捷智能体（inline systemPrompt）走传统 direct-chat ──
    let agentKey: string | undefined;
    let itemId: string | undefined;
    let kbSystemPrompt: string | undefined;
    if (agent?.kind === 'toolbox') {
      if (agent.item.type === 'builtin' && agent.item.agentKey) agentKey = agent.item.agentKey;
      else itemId = agent.item.id;
    } else if (agent?.kind === 'kbAgent') {
      kbSystemPrompt = agent.agent.systemPrompt;
    }

    let composed = '';
    if (kbSystemPrompt) composed += `[智能体角色设定]\n${kbSystemPrompt}\n\n`;
    composed += `[参考文档${docTruncated ? '（已截取前 4 万字）' : ''}]\n${docContent}\n\n[用户指令]\n${userText.trim()}`;

    const stop = streamDirectChat({
      message: composed,
      agentKey,
      itemId,
      history: history.length > 0 ? history : undefined,
      onStart,
      onText,
      onError,
      onDone,
    });
    cancelStreamRef.current = stop;
  }, [entryId, loadingDoc, docLoadError, messages, docContent, docTruncated, scrollToBottom, capabilityForAgent, selectedParams]);

  const pollShortVideoRun = useCallback(async (runId: string, messageId: string, ownerKey: string, pollToken: number) => {
    for (let i = 0; i < 240; i += 1) {
      if (!isShortVideoPollActive(ownerKey, pollToken)) return;
      const res = await getShortVideoMaterialRun(runId);
      if (!isShortVideoPollActive(ownerKey, pollToken)) return;
      if (!res.success || !res.data) {
        const message = res.error?.message || '无法读取短视频后台任务';
        setMessages((prev) => prev.map((m) => m.id === messageId
          ? { ...m, streaming: false, phase: 'error', content: `（读取后台任务失败：${message}）` }
          : m));
        setStreamingId(null);
        return;
      }

      const run = res.data;
      if (run.status === 'done') {
        const result = shortVideoResultFromRun(run);
        if (!result) {
          setMessages((prev) => prev.map((m) => m.id === messageId
            ? { ...m, streaming: false, phase: 'error', content: '（后台任务已完成，但服务端未返回完整入库产物）' }
            : m));
          setStreamingId(null);
          return;
        }
        setMessages((prev) => prev.map((m) => m.id === messageId
          ? {
              ...m,
              streaming: false,
              phase: 'done',
              shortVideoRun: run,
              content: buildShortVideoResultMessage(result),
              quickActions: buildShortVideoQuickActions(result),
            }
          : m));
        setStreamingId(null);
        sendLockRef.current = false;
        onStoreChanged?.();
        window.setTimeout(() => {
          if (isShortVideoPollActive(ownerKey, pollToken)) onStoreChanged?.();
        }, 1200);
        return;
      }

      if (run.status === 'failed') {
        const message = run.errorMessage || '短视频解析失败';
        setMessages((prev) => prev.map((m) => m.id === messageId
          ? { ...m, streaming: false, phase: 'error', shortVideoRun: run, content: `${formatShortVideoProgress(run)}\n\n（解析失败：${message}）` }
          : m));
        setStreamingId(null);
        sendLockRef.current = false;
        return;
      }

      setMessages((prev) => prev.map((m) => m.id === messageId
        ? {
            ...m,
            streaming: true,
            phase: 'streaming',
            shortVideoRun: run,
            content: formatShortVideoProgress(run),
          }
        : m));
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
    }

    if (isShortVideoPollActive(ownerKey, pollToken)) {
      setMessages((prev) => prev.map((m) => m.id === messageId
        ? { ...m, streaming: false, phase: 'error', content: `${m.content}\n\n（后台任务等待超时，请稍后重新打开查看服务端状态）` }
        : m));
      setStreamingId(null);
      sendLockRef.current = false;
    }
  }, [isShortVideoPollActive, onStoreChanged]);

  useEffect(() => {
    if (!isShortVideoMode) return;
    if (sendLockRef.current) return;
    const runId = loadActiveShortVideoRun(storeId);
    if (!runId || restoredShortVideoRunRef.current === runId) return;
    restoredShortVideoRunRef.current = runId;
    const ownerKey = conversationKey;
    const messageId = `short-video-run-${runId}`;
    setMessages((prev) => {
      if (sendLockRef.current) return prev;
      if (prev.some((m) => m.id === messageId)) return prev;
      return [
        ...prev,
        {
          id: messageId,
          role: 'assistant',
          invoker: {
            kind: 'toolbox',
            label: SHORT_VIDEO_TOOLBOX_ITEM.name,
            ref: SHORT_VIDEO_TOOLBOX_ITEM.id,
            icon: SHORT_VIDEO_TOOLBOX_ITEM.icon,
          },
          content: `正在恢复短视频后台任务：${runId}`,
          streaming: true,
          phase: 'streaming',
        },
      ];
    });
    setStreamingId(messageId);
    const pollToken = nextShortVideoPollToken();
    void pollShortVideoRun(runId, messageId, ownerKey, pollToken);
    return () => {
      if (shortVideoPollTokenRef.current === pollToken) shortVideoPollTokenRef.current += 1;
    };
  }, [conversationKey, isShortVideoMode, nextShortVideoPollToken, pollShortVideoRun, storeId]);

  const runShortVideoTool = useCallback(async (userText: string) => {
    if (sendLockRef.current) return;
    const url = extractUrl(userText);
    if (!url) {
      toast.warning('没有识别到短视频链接', '请粘贴抖音、TikTok、快手或 B 站等短视频链接');
      return;
    }
    sendLockRef.current = true;
    const pollToken = nextShortVideoPollToken();
    setError(null);

    const userMsgId = 'u-' + Date.now();
    const asstMsgId = 'a-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const invoker: ChatMessage['invoker'] = {
      kind: 'toolbox',
      label: SHORT_VIDEO_TOOLBOX_ITEM.name,
      ref: SHORT_VIDEO_TOOLBOX_ITEM.id,
      icon: SHORT_VIDEO_TOOLBOX_ITEM.icon,
    };
    setMessages([
      { id: userMsgId, role: 'user', content: userText.trim(), invoker },
      {
        id: asstMsgId,
        role: 'assistant',
        content: '正在解析短视频链接，并把原始视频保存到知识库。文字只会从视频真实转写生成，文案和时间线需要后续再加工。',
        streaming: true,
        phase: 'streaming',
        invoker,
      },
    ]);
    setStreamingId(asstMsgId);
    setInput('');
    scrollToBottom();

    const ownerKey = conversationKey;
    try {
      const res = await createShortVideoMaterialRun({ videoUrl: url, storeId });
      if (entryIdRef.current !== ownerKey) return;
      if (!res.success || !res.data) {
        const message = res.error?.message || '短视频解析失败';
        setError(message);
        setMessages((prev) => prev.map((m) => m.id === asstMsgId
          ? { ...m, streaming: false, phase: 'error', content: `（解析失败：${message}）` }
          : m));
        return;
      }
      const result = res.data;
      saveActiveShortVideoRun(storeId, result.run.id);
      restoredShortVideoRunRef.current = result.run.id;
      setMessages((prev) => prev.map((m) => m.id === asstMsgId
        ? {
            ...m,
            streaming: true,
            phase: 'streaming',
            content: formatShortVideoProgress(result.run),
          }
        : m));
      toast.success('短视频后台任务已创建', '可以刷新页面，进度会从服务端恢复');
      await pollShortVideoRun(result.run.id, asstMsgId, ownerKey, pollToken);
    } catch (e) {
      if (entryIdRef.current !== ownerKey) return;
      const message = e instanceof Error ? e.message : '网络异常';
      setError(message);
      setMessages((prev) => prev.map((m) => m.id === asstMsgId
        ? { ...m, streaming: false, phase: 'error', content: `（解析失败：${message}）` }
        : m));
    } finally {
      if (entryIdRef.current === ownerKey) {
        setStreamingId(null);
        sendLockRef.current = false;
      }
    }
  }, [conversationKey, nextShortVideoPollToken, pollShortVideoRun, scrollToBottom, storeId]);

  const handleSendInput = useCallback(() => {
    if (!input.trim()) return;
    if (!active) {
      toast.warning('请先选择智能体', '点上方选择器挑一个');
      setPickerOpen(true);
      return;
    }
    if (active.kind === 'shortVideoTool') {
      void runShortVideoTool(input);
      return;
    }
    const isLiteraryToolbox =
      active.kind === 'toolbox' &&
      active.item.type === 'builtin' &&
      active.item.agentKey === 'literary-agent';
    if (isLiteraryToolbox && isLiteraryIllustrationRequest(input)) {
      if (loadingDoc) {
        toast.warning('请稍候', '文档还在加载');
        return;
      }
      if (docLoadError) {
        toast.warning('无法配图', docLoadError);
        return;
      }
      setVisualInitialPrompt(buildLiteraryIllustrationPrompt(input, entryTitle, docContent));
      setLiteraryImageMode(true);
      setPickerOpen(false);
      setError(null);
      setInput('');
      return;
    }
    const invoker: ChatMessage['invoker'] =
      active.kind === 'toolbox'
        ? { kind: 'toolbox', label: active.item.name, ref: active.item.id, icon: active.item.icon }
        : { kind: 'kbAgent', label: active.agent.label, ref: active.agent.key };
    setLiteraryImageMode(false);
    void sendMessage(input, invoker, active);
  }, [input, active, loadingDoc, docLoadError, entryTitle, docContent, sendMessage, runShortVideoTool]);

  // 开启全新对话：清空当前对话 + 清掉本文档的持久化（保留已选智能体，方便直接再问）
  const handleNewConversation = useCallback(() => {
    abortCurrentStream();
    // 先取消挂起的去抖后端保存：否则它会在下面 DELETE 之后才落库，把刚清掉的对话"复活"
    // （Codex P2：新对话被 pending save 复活）
    if (backendSaveTimerRef.current) {
      window.clearTimeout(backendSaveTimerRef.current);
      backendSaveTimerRef.current = null;
    }
    setMessages([]);
    setError(null);
    setInput('');
    setLiteraryImageMode(false);
    setPendingVisualUrl(null);
    setPendingApply(null);
    setStreamModel(null);
    try { sessionStorage.removeItem(`${CHAT_HISTORY_STORAGE_KEY}:${conversationKey}`); } catch { /* 配额/隐私模式忽略 */ }
    if (entryId && !isShortVideoMode) {
      void clearReprocessConversation(entryId);  // 同步清后端，否则重开又把旧对话拉回来
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [abortCurrentStream, conversationKey, entryId, isShortVideoMode]);

  // 选中智能体 = 只把它设为"当前智能体"并聚焦输入框，绝不自动发送。
  // 历史 bug：选完立即用默认指令跑一轮，导致"我选了智能体还没说话就发出去了"。
  // 现在用户必须先输入指令（生成型则输入画面描述）再点发送/回车才触发。
  const pickToolbox = useCallback((item: ToolboxItem) => {
    if (item.id === SHORT_VIDEO_TOOLBOX_ITEM.id) {
      setActive({ kind: 'shortVideoTool' });
      setLiteraryImageMode(false);
      setPickerOpen(false);
      setError(null);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    setActive({ kind: 'toolbox', item });
    setLiteraryImageMode(false);
    setPickerOpen(false);
    setError(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const pickKbAgent = useCallback((agent: ReprocessAgent) => {
    setActive({ kind: 'kbAgent', agent });
    setLiteraryImageMode(false);
    setPickerOpen(false);
    setError(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const handleCreateAgent = useCallback(async (in_: {
    label: string; description: string; systemPrompt: string;
  }) => {
    const res = await createReprocessAgent(in_);
    if (!res.success) {
      toast.error('创建失败', res.error?.message);
      return false;
    }
    setKbAgents((prev) => [...prev, res.data]);
    toast.success('智能体创建成功', '已选中，可立即使用');
    setActive({ kind: 'kbAgent', agent: res.data });
    setLiteraryImageMode(false);
    return true;
  }, []);

  const handleDeleteAgent = useCallback(async (agent: ReprocessAgent) => {
    if (!agent.isOwn) return;
    if (!window.confirm(`删除「${agent.label}」？此操作不可撤销。`)) return;
    const res = await deleteReprocessAgent(agent.id);
    if (!res.success) {
      toast.error('删除失败', res.error?.message);
      return;
    }
    setKbAgents((prev) => prev.filter((a) => a.id !== agent.id));
    if (active?.kind === 'kbAgent' && active.agent.id === agent.id) setActive(null);
  }, [active]);

  // 第一步：点写回按钮 = 打开 diff 预览确认窗，绝不直接写库。
  // 让用户在 AI 覆盖/追加/另存之前看清改动（CLAUDE.md「让用户感知改动」）。
  const handleApply = useCallback((
    msgId: string, mode: 'replace' | 'append' | 'new',
  ) => {
    const msg = messages.find((m) => m.id === msgId);
    if (!msg || msg.role !== 'assistant' || !msg.content) return;
    if (msg.applied) return;          // 已写回的不再开窗
    if (applying) return;             // 有写回在飞行中先等它
    setPendingApply({ msgId, mode });
  }, [messages, applying]);

  // 第二步：用户在确认窗点「确认」后才真正落库（保留原有全部并发/切档防护）。
  // 返回是否真正写回成功（供确认窗决定要不要关窗：失败时保留 diff 预览，不白关）。
  const performApply = useCallback(async (
    msgId: string, mode: 'replace' | 'append' | 'new', title?: string, parentId?: string,
  ): Promise<boolean> => {
    if (!entryId) {
      toast.warning('未选择文档', '请先打开一篇文档再写回');
      return false;
    }
    const msg = messages.find((m) => m.id === msgId);
    if (!msg || msg.role !== 'assistant' || !msg.content) return false;
    // 已写回的 message 拒绝重入（防止"已写回"按钮被重复点击造成 append 第二次或
    // 又 new 一个）（Codex P2 十轮）
    if (msg.applied) return false;
    const key = `${msgId}:${mode}`;
    // 同步 ref 锁：state-based applying 在 React 还没 commit 之前会让双击两次都漏过
    if (applyLockRef.current) return false;
    if (applying) return false;
    applyLockRef.current = true;
    // 锁定调用瞬间的 entryId；若 await 期间用户切到了别的文档，绝对不能把 success/error
    // 状态再写到当前抽屉里，也不能给 onApplied 回调（会让外层选中错的 entry）。
    // Bugbot #3（二轮 Medium）。
    const requestedEntryId = entryId;
    setApplying(key);
    let res;
    try {
      res = await applyReprocessContent(requestedEntryId, {
        mode,
        content: msg.content,
        ...(mode === 'new' && title ? { title } : {}),
        ...(mode === 'new' && parentId ? { parentId } : {}),
      });
    } catch (e) {
      // 即使 entry 切走也得清 applying，不然新 doc 的写回按钮永远 disabled（Bugbot #3 三轮 Low）
      setApplying(null);
      applyLockRef.current = false;
      if (entryIdRef.current !== requestedEntryId) return false; // 切走了，静默丢弃错误 toast
      toast.error('写回失败', e instanceof Error ? e.message : '网络异常');
      return false;
    }
    setApplying(null);
    applyLockRef.current = false;
    if (entryIdRef.current !== requestedEntryId) {
      // entry 在 await 期间被切换：丢弃这次结果，避免错认归属
      return false;
    }
    if (!res.success) {
      toast.error('写回失败', res.error?.message);
      return false;
    }
    const target = res.data.outputEntryId || res.data.updatedEntryId;
    setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, applied: mode } : m));
    const label = mode === 'replace' ? '替换原文' : mode === 'append' ? '追加末尾' : '另存为新文档';
    toast.success(`${label}成功`, mode === 'new' ? '新文档已生成' : '文档已更新');

    // replace/append 改了源文档正文；后续轮 message 还引用旧 docContent 会让模型
    // 读到过期版本。重新拉一次 entry content 拿到服务器最新（Bugbot #2 五轮 High）。
    if (mode === 'replace' || mode === 'append') {
      try {
        const refreshed = await getDocumentContent(requestedEntryId);
        if (entryIdRef.current === requestedEntryId && refreshed.success) {
          const raw = refreshed.data.content ?? '';
          if (raw.length > MAX_DOC_CHARS) {
            setDocContent(raw.slice(0, MAX_DOC_CHARS));
            setDocTruncated(true);
          } else {
            setDocContent(raw);
            setDocTruncated(false);
          }
        }
      } catch { /* 拉取失败保留旧 docContent，下一轮 toast 提示已能让用户感知 */ }
    }

    if (target && onApplied) onApplied(mode, target);
    return true;
  }, [messages, applying, entryId, onApplied]);

  // 确认窗点「确认」：执行真正写回。仅在写回成功后才关窗；失败时保留 diff 预览,
  // 让用户能直接重试,不必从消息里重新打开（失败/切档的 toast 由 performApply 自理）。
  const confirmPendingApply = useCallback(async (opts: { title?: string; parentId?: string }) => {
    if (!pendingApply) return;
    const { msgId, mode } = pendingApply;
    const ok = await performApply(msgId, mode, opts.title, opts.parentId);
    if (ok) setPendingApply(null);
  }, [pendingApply, performApply]);

  // 智能体专属出站动作：把产出送回它自己的原生系统（巧思）
  const handleOutbound = useCallback(async (actionKey: string, content: string) => {
    if (!content || !content.trim()) return;
    if (actionKey === 'illustrate') {
      // 文学「为这段配图」→ 打开 literary-agent 自己的配图 mini 面板，预填该段作为配图起点。
      // 业务归属保持文学创作；底层走 /api/literary-agent/image-gen，不切换到 visual-agent。
      setVisualInitialPrompt(content.slice(0, 2000));
      setLiteraryImageMode(true);
      setPickerOpen(false);
      return;
    }
    if (actionKey === 'create-defect') {
      const res = await createDefectFromContent(content);
      if (!res.success) {
        const m = res.error?.message || '创建失败';
        const perm = /\b403\b|权限|forbidden/i.test(m);
        toast.error('创建缺陷失败', perm ? '需要缺陷管理权限（defect-agent.use），请联系管理员开通' : m);
        return;
      }
      toast.success('缺陷已创建', `「${res.data?.defect?.title || '新缺陷'}」已建入缺陷库，可去缺陷管理指派/处理`);
    }
  }, []);

  // 视觉创作 mini 面板：把生成的配图写回文档（追加到文末）
  const insertVisualToDoc = useCallback(async (markdown: string) => {
    if (!entryId) {
      toast.warning('未选择文档', '请先打开一篇文档再插入配图');
      return;
    }
    const requestedEntryId = entryId;
    let res;
    try {
      res = await applyReprocessContent(requestedEntryId, { mode: 'append', content: markdown });
    } catch (e) {
      if (entryIdRef.current !== requestedEntryId) return;
      toast.error('插入失败', e instanceof Error ? e.message : '网络异常');
      return;
    }
    if (entryIdRef.current !== requestedEntryId) return;
    if (!res.success) { toast.error('插入失败', res.error?.message); return; }
    toast.success('已插入文档', '配图已追加到文末');
    // 已插入 = 不再是「已生成未插入」，清掉暂存图：否则去抖保存继续把它当未插入图落库，
    // 重开抽屉又回填并再次提示插入，产生重复 markdown（Codex P2：clear pending image after insert）
    setPendingVisualUrl(null);
    try {
      const refreshed = await getDocumentContent(requestedEntryId);
      if (entryIdRef.current === requestedEntryId && refreshed.success) {
        const raw = refreshed.data.content ?? '';
        setDocContent(raw.length > MAX_DOC_CHARS ? raw.slice(0, MAX_DOC_CHARS) : raw);
        setDocTruncated(raw.length > MAX_DOC_CHARS);
      }
    } catch { /* 保留旧 docContent */ }
    const target = res.data.outputEntryId || res.data.updatedEntryId;
    if (target && onApplied) onApplied('append', target);
  }, [entryId, onApplied]);

  const handleInsertVisualImage = useCallback((url: string, name?: string) => {
    void insertVisualToDoc(`![${name || '配图'}](${url})`);
  }, [insertVisualToDoc]);

  const handleInsertVisualImageWithText = useCallback((url: string, text: string) => {
    const snippet = (text || '').trim().slice(0, 300);
    void insertVisualToDoc(`${snippet}\n\n![配图](${url})`);
  }, [insertVisualToDoc]);

  const isBusy = streamingId !== null;
  const isGenerationActive = activeCapability?.invokeMode === 'generation';
  const isLiteraryImageActive = literaryImageMode && active?.kind === 'toolbox' && active.item.agentKey === 'literary-agent';
  const isImagePanelActive = isGenerationActive || isLiteraryImageActive;

  // 把图片成果物以 Markdown 形式写回文档（替换/追加/另存为新文档）
  const handleApplyArtifact = useCallback(async (
    art: AgentArtifact, mode: 'replace' | 'append' | 'new',
  ) => {
    if (!entryId) {
      toast.warning('未选择文档', '请先打开一篇文档再写回图片');
      return;
    }
    if (!art.url) return;
    if (applyLockRef.current || applying) return;
    applyLockRef.current = true;
    const requestedEntryId = entryId;
    const key = `art:${art.url}:${mode}`;
    setApplying(key);
    const markdown = `![${art.name || '生成的图片'}](${art.url})`;
    let res;
    try {
      res = await applyReprocessContent(requestedEntryId, { mode, content: markdown });
    } catch (e) {
      setApplying(null);
      applyLockRef.current = false;
      if (entryIdRef.current !== requestedEntryId) return;
      toast.error('插入失败', e instanceof Error ? e.message : '网络异常');
      return;
    }
    setApplying(null);
    applyLockRef.current = false;
    if (entryIdRef.current !== requestedEntryId) return;
    if (!res.success) {
      toast.error('插入失败', res.error?.message);
      return;
    }
    const target = res.data.outputEntryId || res.data.updatedEntryId;
    const label = mode === 'replace' ? '替换原文' : mode === 'append' ? '插入图片' : '另存为新文档';
    toast.success(`${label}成功`, mode === 'new' ? '新文档已生成' : '图片已写入文档');
    if (mode === 'replace' || mode === 'append') {
      try {
        const refreshed = await getDocumentContent(requestedEntryId);
        if (entryIdRef.current === requestedEntryId && refreshed.success) {
          const raw = refreshed.data.content ?? '';
          setDocContent(raw.length > MAX_DOC_CHARS ? raw.slice(0, MAX_DOC_CHARS) : raw);
          setDocTruncated(raw.length > MAX_DOC_CHARS);
        }
      } catch { /* 保留旧 docContent */ }
    }
    if (target && onApplied) onApplied(mode, target);
  }, [applying, entryId, onApplied]);

  const activeLabel = useMemo(() => {
    if (!active) return null;
    if (active.kind === 'toolbox') {
      return { icon: active.item.icon, name: active.item.name, kind: 'toolbox' as const, sub: active.item.description };
    }
    if (active.kind === 'shortVideoTool') {
      return {
        icon: SHORT_VIDEO_TOOLBOX_ITEM.icon,
        name: SHORT_VIDEO_TOOLBOX_ITEM.name,
        kind: 'toolbox' as const,
        sub: SHORT_VIDEO_TOOLBOX_ITEM.description,
      };
    }
    return { icon: undefined, name: active.agent.label, kind: 'kbAgent' as const, sub: active.agent.description };
  }, [active]);

  const modal = (
    <motion.div
      className="surface-backdrop fixed inset-0 z-[1200] flex justify-end"
      initial={{ backgroundColor: 'rgba(0,0,0,0)' }}
      animate={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
      exit={{ backgroundColor: 'rgba(0,0,0,0)' }}
      transition={{ duration: 0.2 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        className="surface-popover flex flex-col border-l border-token-subtle"
        style={{ width: 'min(640px, 96vw)', height: '100vh', minHeight: 0 }}
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', stiffness: 320, damping: 32 }}
      >
        {/* Header */}
        <div className="surface-panel-header flex items-center justify-between px-5 py-4 shrink-0 border-b border-token-subtle">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="surface-action-accent flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px]">
              <Wand2 size={16} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-token-primary">
                {isShortVideoMode ? '知识库智能体' : 'AI 文档对话'}
              </p>
              <p className="truncate text-[10px] text-token-muted mt-0.5">
                {isShortVideoMode ? '粘贴短视频链接，默认保存素材到知识库' : entryTitle}
                {docTruncated && (
                  <span className="ml-2 text-[9.5px]" style={{ color: 'rgba(251,191,36,0.95)' }}>
                    · 已截取前 4 万字喂给 AI
                  </span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {messages.length > 0 && (
              <button
                onClick={handleNewConversation}
                disabled={isBusy}
                title="清空当前对话，开启全新 AI 对话"
                className="flex h-7 items-center gap-1 rounded-[8px] px-2 text-[11px] text-token-muted hover:bg-white/8 transition-colors disabled:opacity-50"
              >
                <Plus size={13} /> 新对话
              </button>
            )}
            <button
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-[8px] text-token-muted hover:bg-white/8 transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* 智能体选择器（精简版 - 顶部下拉） */}
        <div className="px-5 pt-3 pb-3 shrink-0 relative">
          <button
            ref={pickerBtnRef}
            onClick={() => setPickerOpen((v) => !v)}
            disabled={loadingAgents || (!!docLoadError && !isShortVideoMode)}
            className="w-full flex items-center gap-2.5 rounded-[10px] px-3 py-2.5 transition-all disabled:opacity-60"
            style={{
              background: active
                ? 'rgba(168,85,247,0.12)'
                : 'rgba(255,255,255,0.04)',
              border: active
                ? '1px solid rgba(168,85,247,0.4)'
                : '1px dashed rgba(255,255,255,0.18)',
            }}
          >
            {activeLabel ? (
              activeLabel.kind === 'toolbox' ? (
                <ToolboxIcon name={activeLabel.icon} size={13} />
              ) : (
                <span
                  className="inline-flex items-center justify-center rounded-[6px]"
                  style={{
                    width: 25, height: 25,
                    background: 'rgba(34,197,94,0.18)',
                    color: 'rgba(110,231,158,0.95)',
                    border: '1px solid rgba(34,197,94,0.30)',
                  }}
                >
                  <Bot size={13} />
                </span>
              )
            ) : (
              <span className="inline-flex items-center justify-center rounded-[6px]"
                style={{
                  width: 25, height: 25,
                  background: 'rgba(255,255,255,0.06)',
                  color: 'rgba(255,255,255,0.4)',
                  border: '1px dashed rgba(255,255,255,0.18)',
                }}
              >
                <Bot size={13} />
              </span>
            )}
            <div className="flex-1 min-w-0 text-left">
              {activeLabel ? (
                <>
                  <p className="text-[12px] font-semibold text-token-primary truncate">{activeLabel.name}</p>
                  {activeLabel.sub && (
                    <p className="text-[10px] text-token-muted truncate mt-0.5">{activeLabel.sub}</p>
                  )}
                </>
              ) : (
                <>
                  <p className="text-[12px] font-semibold text-token-primary">选择智能体</p>
                  <p className="text-[10px] text-token-muted mt-0.5">百宝箱 / 我的快捷智能体 / 新建</p>
                </>
              )}
            </div>
            <ChevronDown
              size={14}
              className="text-token-muted shrink-0 transition-transform"
              style={{ transform: pickerOpen ? 'rotate(180deg)' : undefined }}
            />
          </button>

          <AnimatePresence>
            {pickerOpen && (
              <motion.div
                id="reprocess-agent-picker-dropdown"
                className="absolute left-5 right-5 mt-1.5 rounded-[12px] shadow-2xl overflow-hidden"
                style={{
                  background: 'rgba(20, 18, 26, 0.98)',
                  border: '1px solid rgba(255,255,255,0.10)',
                  backdropFilter: 'blur(20px)',
                  zIndex: 50,
                  maxHeight: '60vh',
                }}
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15 }}
              >
                <div className="overflow-y-auto" style={{ maxHeight: '60vh' }}>
                  {/* 百宝箱 section */}
                  <DropdownSection
                    title="百宝箱智能体"
                    subtitle="系统已注册的通用智能体，文档作为输入直接调用"
                  >
                    {toolboxItems.length === 0 && loadingAgents ? (
                      <div className="px-3 py-3 text-[10px] text-token-muted">
                        <MapSpinner size={10} /> 加载中…
                      </div>
                    ) : toolboxItems.map((item) => (
                      <DropdownRow
                        key={item.id}
                        icon={<ToolboxIcon name={item.icon} size={14} />}
                        title={item.name}
                        subtitle={item.description}
                        badge={item.type !== 'builtin' ? '我的工具' : undefined}
                        active={(active?.kind === 'toolbox' && active.item.id === item.id)
                          || (active?.kind === 'shortVideoTool' && item.id === SHORT_VIDEO_TOOLBOX_ITEM.id)}
                        disabled={isBusy}
                        onClick={() => pickToolbox(item)}
                      />
                    ))}
                  </DropdownSection>

                  {/* 我的快捷智能体 section */}
                  <DropdownSection
                    title="我的快捷智能体"
                    subtitle="一键 system prompt，叠加到百宝箱通用 chat 链路"
                  >
                    {kbAgents.map((agent) => (
                      <DropdownRow
                        key={agent.id}
                        icon={
                          <span
                            className="inline-flex items-center justify-center rounded-[6px]"
                            style={{
                              width: 26, height: 26,
                              background: 'rgba(34,197,94,0.18)',
                              color: 'rgba(110,231,158,0.95)',
                              border: '1px solid rgba(34,197,94,0.30)',
                            }}
                          >
                            <Bot size={14} />
                          </span>
                        }
                        title={agent.label}
                        subtitle={agent.description}
                        badge={agent.visibility === 'system' ? '系统' : '我的'}
                        badgeColor={agent.visibility === 'system' ? 'rgba(168,85,247,0.20)' : 'rgba(34,197,94,0.20)'}
                        active={active?.kind === 'kbAgent' && active.agent.id === agent.id}
                        disabled={isBusy}
                        onClick={() => pickKbAgent(agent)}
                        onDelete={agent.isOwn ? () => handleDeleteAgent(agent) : undefined}
                      />
                    ))}

                    <button
                      onClick={() => { setShowCreateAgent(true); setPickerOpen(false); }}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-white/4 transition-colors text-left"
                      style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
                    >
                      <span
                        className="inline-flex items-center justify-center rounded-[6px]"
                        style={{
                          width: 26, height: 26,
                          background: 'rgba(96,165,250,0.18)',
                          color: 'rgba(147,197,253,0.95)',
                          border: '1px dashed rgba(96,165,250,0.40)',
                        }}
                      >
                        <Plus size={14} />
                      </span>
                      <span className="text-[12px] font-medium" style={{ color: 'rgba(147,197,253,0.95)' }}>
                        新建快捷智能体
                      </span>
                    </button>
                  </DropdownSection>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* 可观测性：当前调用的模型 · 平台（onStart 透出，禁止前端硬编码） */}
        {streamModel?.model && !docLoadError && (
          <div className="px-5 pb-2 shrink-0">
            <div className="inline-flex items-center gap-1.5 text-[10px] font-mono text-token-muted">
              <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: 'rgba(110,231,158,0.85)' }} />
              <span className="truncate">
                {streamModel.model}{streamModel.platform ? ` · ${streamModel.platform}` : ''}
              </span>
            </div>
          </div>
        )}

        {/* 智能涌现提示：选中智能体后，告诉用户这个智能体能做什么特别的（专属出站动作） */}
        {activeCapability && !docLoadError && (
          <div className="px-5 pb-2 shrink-0">
            <div
              className="rounded-[8px] px-2.5 py-1.5 text-[10px] flex items-start gap-1.5"
              style={{
                background: 'rgba(168,85,247,0.10)',
                border: '1px solid rgba(168,85,247,0.22)',
                color: 'rgba(216,180,254,0.95)',
              }}
            >
              <Sparkles size={11} className="shrink-0 mt-0.5" />
              <span>
                <b>智能涌现</b>：
                {activeCapability.outboundActions && activeCapability.outboundActions.length > 0
                  ? activeCapability.outboundActions.map((a) => a.hint || a.label).join('；')
                  : activeCapability.invokeMode === 'generation'
                    ? '生成结果可一键插入文档 / 另存为新文档'
                    : '产出可替换 / 追加 / 另存到当前文档'}
              </span>
            </div>
          </div>
        )}

        {/* 创建浮层 */}
        <AnimatePresence>
          {showCreateAgent && (
            <CreateAgentModal
              onClose={() => setShowCreateAgent(false)}
              onSubmit={async (in_) => {
                const ok = await handleCreateAgent(in_);
                if (ok) setShowCreateAgent(false);
              }}
            />
          )}
        </AnimatePresence>

        {/* 写回前确认窗（diff 预览闸）：确认才落库，写入前原文不动 */}
        <AnimatePresence>
          {pendingApply && (() => {
            const targetMsg = messages.find((m) => m.id === pendingApply.msgId);
            if (!targetMsg) return null;
            const applyKey = `${pendingApply.msgId}:${pendingApply.mode}`;
            const inFlight = applying === applyKey;
            return (
              <DocApplyDiffModal
                mode={pendingApply.mode}
                entryTitle={entryTitle}
                docContent={docContent}
                aiContent={targetMsg.content}
                docTruncated={docTruncated}
                applying={inFlight}
                folders={folders}
                onConfirm={(opts) => void confirmPendingApply(opts)}
                onCancel={() => { if (!inFlight) setPendingApply(null); }}
              />
            );
          })()}
        </AnimatePresence>

        {/* 消息流 */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-5 py-4 space-y-3.5"
          style={{ minHeight: 0, overscrollBehavior: 'contain' }}
        >
          {isImagePanelActive ? (
            <VisualCreationMiniPanel
              appKey={isLiteraryImageActive ? 'literary-agent' : 'visual-agent'}
              docTitle={entryTitle}
              docContent={docContent}
              initialPrompt={visualInitialPrompt}
              initialResult={pendingVisualUrl}
              onResultChange={setPendingVisualUrl}
              onInsertImage={handleInsertVisualImage}
              onInsertImageWithText={handleInsertVisualImageWithText}
            />
          ) : messages.length === 0 ? (
            <EmptyState
              loadingDoc={loadingDoc}
              entryTitle={entryTitle}
              hasAgent={!!active}
              docLoadError={docLoadError}
              mode={isShortVideoMode ? 'short-video' : 'document'}
            />
          ) : (
            messages.map((m) => (
              <MessageBubble
                key={m.id}
                msg={m}
                applying={applying}
                onApply={handleApply}
                onApplyArtifact={handleApplyArtifact}
                onOutbound={handleOutbound}
                onQuickAction={(action) => onOpenEntry?.({
                  id: action.entryId,
                  title: action.title,
                  initialInput: action.initialInput,
                })}
                allowApply={!!entryId && !isShortVideoMode}
              />
            ))
          )}
          {error && (
            <div className="rounded-[10px] p-3 text-[11px] flex items-start gap-2"
              style={{
                background: 'rgba(239,68,68,0.10)',
                border: '1px solid rgba(239,68,68,0.25)',
                color: 'rgba(252,165,165,0.95)',
              }}
            >
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          )}
        </div>

        {/* 输入区（图片生成面板打开时隐藏聊天输入） */}
        {!isImagePanelActive && (
        <div className="surface-panel-footer px-5 py-3 shrink-0 border-t border-token-subtle">
          {/* 引用文档指示：让用户在输入时明确"这次会带上哪篇文章" */}
          {!docLoadError && !isImagePanelActive && !isShortVideoMode && (
            <div className="flex items-center gap-1.5 mb-2 text-[10px] text-token-muted">
              <FileText size={11} className="shrink-0" style={{ color: 'rgba(96,165,250,0.85)' }} />
              <span className="truncate">引用：《{entryTitle}》{docTruncated ? ' · 已截取前 4 万字' : ''}</span>
            </div>
          )}
          {/* 可选参数（尺寸/模型）—— 仅生成型且后端有真实可选项时出现 */}
          {isGenerationActive && agentParams.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-2">
              {agentParams.map((p) => (
                <label key={p.key} className="flex items-center gap-1.5 text-[10px] text-token-muted">
                  <span className="shrink-0">{p.label}</span>
                  <select
                    value={selectedParams[p.key] ?? p.default ?? ''}
                    onChange={(e) => setSelectedParams((prev) => ({ ...prev, [p.key]: e.target.value }))}
                    disabled={isBusy}
                    className="prd-field rounded-[8px] px-2 py-1 text-[11px] text-token-primary outline-none disabled:opacity-60"
                  >
                    {p.options.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}
          <div className="flex gap-2 items-stretch">
            <textarea
              id="reprocess-chat-input"
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendInput();
                }
              }}
              placeholder={
                isShortVideoMode
                  ? '粘贴抖音、TikTok、快手或 B 站短视频链接'
                  : docLoadError
                  ? '文档未加载，无法对话'
                  : isBusy
                    ? (isGenerationActive ? '正在生成…' : 'AI 正在回复，请稍候…')
                    : activeCapability
                      ? activeCapability.inputHint
                      : active
                        ? `输入指令配合「${
                            active.kind === 'toolbox'
                              ? active.item.name
                              : active.kind === 'shortVideoTool'
                                ? SHORT_VIDEO_TOOLBOX_ITEM.name
                                : active.agent.label
                          }」，Enter 发送`
                        : '先选个智能体，然后输入指令'
              }
              disabled={isBusy || (!!docLoadError && !isShortVideoMode)}
              rows={2}
              className="prd-field flex-1 resize-none rounded-[10px] px-3 py-2 text-[12px] outline-none disabled:opacity-60"
            />
            <Button
              variant="primary"
              size="sm"
              className="!h-auto self-stretch px-4 shrink-0"
              disabled={isBusy || !input.trim() || (!!docLoadError && !isShortVideoMode)}
              onClick={handleSendInput}
            >
              {isBusy
                ? <MapSpinner size={12} />
                : isGenerationActive ? <ImagePlus size={12} /> : <Send size={12} />}
              {isShortVideoMode ? '解析' : activeCapability?.actionLabel ?? '发送'}
            </Button>
          </div>
          <p className="mt-1.5 text-[10px] text-token-muted">
            {isBusy
              ? (isShortVideoMode
                  ? '正在调用服务器解析短视频，素材会以服务端结果为准'
                  : isGenerationActive ? '正在生成图片，请稍候…' : '正在调用智能体；文档已作为输入发送')
              : isShortVideoMode
                ? '只粘贴链接时会默认解析并保存到知识库；完成后可继续选择文案、时间轴或视频转写加工'
                : isGenerationActive
                ? '视觉创作：输入画面描述生成图片，生成后可一键插入文档'
                : active
                  ? '输入指令后回车 / 点按钮触发当前智能体（选中不会自动发送）'
                  : '先在上方选择一个智能体，再输入指令'}
          </p>
        </div>
        )}
      </motion.div>
    </motion.div>
  );

  return createPortal(modal, document.body);
}

// ── 子组件：dropdown section ──
function DropdownSection({
  title, subtitle, children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="py-1.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div className="px-3 pt-2 pb-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.55)' }}>
          {title}
        </p>
        {subtitle && (
          <p className="text-[9.5px] text-token-muted mt-0.5">{subtitle}</p>
        )}
      </div>
      {children}
    </div>
  );
}

function DropdownRow({
  icon, title, subtitle, badge, badgeColor, active, disabled, onClick, onDelete,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  badge?: string;
  badgeColor?: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className="group flex items-center gap-2.5 px-3 py-2 transition-colors"
      style={{
        background: active ? 'rgba(168,85,247,0.10)' : undefined,
        borderLeft: active ? '2px solid rgba(168,85,247,0.6)' : '2px solid transparent',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
      }}
      onClick={() => { if (!disabled) onClick(); }}
      onMouseEnter={(e) => {
        if (!disabled) (e.currentTarget as HTMLDivElement).style.background = active
          ? 'rgba(168,85,247,0.15)' : 'rgba(255,255,255,0.05)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = active
          ? 'rgba(168,85,247,0.10)' : 'transparent';
      }}
    >
      {icon}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-[12px] font-semibold text-token-primary truncate">{title}</p>
          {badge && (
            <span className="text-[9px] font-semibold px-1.5 rounded shrink-0"
              style={{ background: badgeColor ?? 'rgba(255,255,255,0.10)', color: 'rgba(255,255,255,0.85)' }}
            >{badge}</span>
          )}
        </div>
        {subtitle && (
          <p className="text-[10px] text-token-muted truncate mt-0.5">{subtitle}</p>
        )}
      </div>
      {active && <Check size={12} className="text-token-primary shrink-0" />}
      {onDelete && (
        <button
          className="opacity-0 group-hover:opacity-100 transition-opacity text-token-muted hover:text-red-300 shrink-0"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="删除"
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

// ── 空状态（含加载分阶段反馈，满足 2 秒原则） ──
function EmptyState({ loadingDoc, entryTitle, hasAgent, docLoadError, mode }: {
  loadingDoc: boolean;
  entryTitle: string;
  hasAgent: boolean;
  docLoadError?: string | null;
  mode?: 'document' | 'short-video';
}) {
  if (loadingDoc) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-12">
        <div className="surface-action-accent flex h-12 w-12 items-center justify-center rounded-[14px] animate-pulse">
          <FileText size={20} />
        </div>
        <div>
          <p className="text-[13px] font-semibold text-token-primary mb-1">
            <MapSpinner size={10} /> 正在读取文档…
          </p>
          <p className="text-[11px] text-token-muted">
            「{entryTitle}」
          </p>
        </div>
      </div>
    );
  }
  if (docLoadError) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-12">
        <div className="flex h-12 w-12 items-center justify-center rounded-[14px]"
          style={{
            background: 'rgba(239,68,68,0.12)',
            border: '1px solid rgba(239,68,68,0.25)',
            color: 'rgba(252,165,165,0.95)',
          }}>
          <AlertCircle size={20} />
        </div>
        <div>
          <p className="text-[13px] font-semibold text-token-primary mb-1">无法加载文档</p>
          <p className="text-[11px] max-w-[340px] leading-relaxed" style={{ color: 'rgba(252,165,165,0.85)' }}>
            {docLoadError}
          </p>
          <p className="text-[10px] text-token-muted mt-2 max-w-[340px] leading-relaxed">
            智能体调用 / 写回均已禁用，避免误把空内容当成文档喂给 LLM。
          </p>
        </div>
      </div>
    );
  }
  if (mode === 'short-video') {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-12">
        <div className="surface-action-accent flex h-12 w-12 items-center justify-center rounded-[14px]">
          <Video size={20} />
        </div>
        <div>
          <p className="text-[13px] font-semibold text-token-primary mb-1">短视频解析</p>
          <p className="text-[11px] text-token-muted max-w-[380px] leading-relaxed">
            粘贴短视频链接后会先保存原始视频到当前知识库，再从视频转写原始文字并返回继续加工入口。
          </p>
        </div>
        <ul className="mt-1 text-[10px] text-token-muted max-w-[380px] leading-relaxed text-left mx-auto space-y-1" style={{ listStyle: 'none', paddingLeft: 0 }}>
          <li>· 默认操作：视频先入库，文字必须来自视频转写</li>
          <li>· 后续动作：打开视频、打开原始文字、转文案、补充润色、整理时间线</li>
          <li>· 解析能力由服务端执行，前端只展示过程和结果入口</li>
        </ul>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-12">
      <div className="surface-action-accent flex h-12 w-12 items-center justify-center rounded-[14px]">
        <Wand2 size={20} />
      </div>
      <div>
        <p className="text-[13px] font-semibold text-token-primary mb-1">和《{entryTitle}》对话</p>
        <p className="text-[11px] text-token-muted max-w-[360px] leading-relaxed">
          {hasAgent
            ? '已选择智能体。在下方输入指令（视觉创作则输入画面描述）后点发送开始；选中不会自动发送。'
            : '点击上方下拉选择一个智能体（百宝箱内置 / 我的快捷智能体 / 新建）后即可开始。'}
        </p>
        {/* 预期说明：第一次用就知道会发生什么 */}
        <ul className="mt-3 text-[10px] text-token-muted max-w-[360px] leading-relaxed text-left mx-auto space-y-1" style={{ listStyle: 'none', paddingLeft: 0 }}>
          <li>· 每次发送都会自动带上本文档作为上下文，无需手动粘贴</li>
          <li>· 对话会保留：关闭抽屉后再打开仍在；点右上「新对话」可清空重来</li>
          <li>· 多轮追问会延续上下文；满意的回复可一键写回 / 另存为新文档</li>
        </ul>
      </div>
    </div>
  );
}

// ── 短视频卡片块：粘贴链接后用仿真短视频卡片展示封面+视频，取代文字块 ──
function ShortVideoCardBlock({ run, phase, content }: {
  run: import('@/services').ShortVideoMaterialRun;
  phase?: 'thinking' | 'streaming' | 'done' | 'error';
  content?: string;
}) {
  const card = run.card;
  const page = useMemo(() => (card ? shortVideoCardToPosterPage(card) : undefined), [card]);
  if (!page) return null;
  // 前端轮询超时/失败时 phase==='error'（run.status 可能仍是 running），此时必须显示错误，
  // 不能因为有 stage 在 running 就还显示"忙碌中"的状态行（Bugbot Medium）。
  const isError = phase === 'error';
  const base = shortVideoCompactStatus(run);
  const tone = isError ? 'error' : base.tone;
  const text = isError ? (base.tone === 'error' ? base.text : '处理中断或超时') : base.text;
  // 部分失败：视频已入库（run.status==='done'）但转写 stage 失败 → phase 不是 'error'，
  // 仅靠上面那行 compact 状态看不出"为什么没有文字"。把转写失败原因显式补一行（Codex P2）。
  const transcriptStage = (run.stages ?? []).find((s) => s.key === 'transcript');
  const transcriptFailed = run.status === 'done' && transcriptStage?.status === 'failed';
  const toneColor = tone === 'error'
    ? 'rgba(248,113,113,0.95)'
    : tone === 'done'
      ? 'rgba(110,231,158,0.9)'
      : 'rgba(96,165,250,0.9)';
  return (
    <div>
      <div style={{ width: '100%', maxWidth: 300, aspectRatio: '9 / 16', margin: '0 auto' }}>
        <PosterFeedCardView page={page} compactFooter />
      </div>
      <div className="mt-2 flex items-center justify-center gap-1.5 text-[11px]" style={{ color: toneColor }}>
        {tone === 'busy' && <MapSpinner size={9} />}
        {text}
      </div>
      {/* 出错/超时时把详细文字（含失败原因、超时提示）显示出来，卡片不能把错误吞掉（Bugbot Medium） */}
      {isError && content ? (
        <div className="mt-1.5 text-[11px] text-token-muted whitespace-pre-wrap" style={{ opacity: 0.85 }}>
          {content}
        </div>
      ) : transcriptFailed ? (
        // 视频入库成功但转写失败：补一行说明，告诉用户"为什么没有文字、怎么补救"（Codex P2）。
        <div className="mt-1.5 text-[11px] whitespace-pre-wrap" style={{ color: 'rgba(248,113,113,0.9)' }}>
          视频转文字失败{transcriptStage?.message?.trim() ? `：${transcriptStage.message.trim()}` : ''}。视频已入库，可稍后单独重试转写。
        </div>
      ) : null}
    </div>
  );
}

// ── 消息气泡 ──
function MessageBubble({
  msg, applying, onApply, onApplyArtifact, onOutbound, onQuickAction, allowApply,
}: {
  msg: ChatMessage;
  applying: string | null;
  onApply: (msgId: string, mode: 'replace' | 'append' | 'new') => void;
  onApplyArtifact: (art: AgentArtifact, mode: 'replace' | 'append' | 'new') => void;
  onOutbound: (actionKey: string, content: string) => void;
  onQuickAction: (action: ChatQuickAction) => void;
  allowApply: boolean;
}) {
  // 流式耗时计时：让用户分清"正在生成"还是"卡死"（hook 必须在任何 return 之前）
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!msg.streaming) { setElapsed(0); return; }
    const t0 = Date.now();
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [msg.streaming]);

  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div
          className="rounded-[14px] px-3.5 py-2 text-[12px] max-w-[80%] break-words whitespace-pre-wrap"
          style={{
            background: 'linear-gradient(135deg, rgba(96,165,250,0.18), rgba(168,85,247,0.14))',
            border: '1px solid rgba(96,165,250,0.25)',
            color: 'rgba(241,245,255,0.96)',
          }}
        >
          {msg.invoker && (
            <span className="inline-flex items-center gap-1 mr-2 mb-1 px-1.5 py-0.5 rounded-[5px] text-[9.5px] font-semibold"
              style={{ background: 'rgba(255,255,255,0.10)' }}
            >
              {msg.invoker.kind === 'toolbox' ? <Sparkles size={9} /> : <Bot size={9} />}
              {msg.invoker.label}
            </span>
          )}
          <div>{msg.content}</div>
        </div>
      </div>
    );
  }

  // 不允许把失败占位字符串（"（调用失败：...）"）写回文档（Bugbot #1 七轮 High）
  const canApply = allowApply && !msg.streaming && !!msg.content && msg.phase !== 'error';
  const busyMode = applying && applying.startsWith(`${msg.id}:`)
    ? applying.split(':')[1]
    : null;
  const imageArtifacts = (msg.artifacts ?? []).filter((a) => a.kind === 'image' && a.url);

  return (
    <div className="flex">
      <div
        className="rounded-[14px] p-3 text-[12px] max-w-[88%] w-full"
        style={{
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <div className="text-[10px] text-token-muted mb-1.5 flex items-center gap-1.5">
          {msg.invoker?.kind === 'toolbox'
            ? <Sparkles size={10} className="text-purple-300" />
            : <Bot size={10} className="text-green-300" />}
          {msg.invoker?.label ?? 'AI'} 回复
          {msg.phase === 'thinking' && (
            <span className="inline-flex items-center gap-1 ml-1">
              <ThinkingDots />
              <span style={{ color: 'rgba(96,165,250,0.85)' }}>
                {elapsed >= 15
                  ? `模型较慢，仍在生成… ${elapsed}s（可点右上「新对话」中止重来）`
                  : `正在思考… ${elapsed}s`}
              </span>
            </span>
          )}
          {msg.phase === 'streaming' && (
            <span className="inline-flex items-center gap-1 ml-1" style={{ color: 'rgba(110,231,158,0.85)' }}>
              <MapSpinner size={8} /> 流式回复中 {elapsed}s
            </span>
          )}
        </div>
        {msg.shortVideoRun?.card ? (
          <ShortVideoCardBlock run={msg.shortVideoRun} phase={msg.phase} content={msg.content} />
        ) : msg.streaming && msg.content ? (
          <StreamingText text={msg.content} streaming mode="blur" />
        ) : msg.content ? (
          <ChatMarkdown content={msg.content} />
        ) : imageArtifacts.length === 0 ? (
          <ThinkingDots />
        ) : null}

        {imageArtifacts.length > 0 && (
          <div className="mt-2.5 space-y-2.5">
            {imageArtifacts.map((art, i) => {
              const artBusy = (mode: string) => applying === `art:${art.url}:${mode}`;
              return (
                <div
                  key={`${art.url}-${i}`}
                  className="rounded-[10px] overflow-hidden"
                  style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.20)' }}
                >
                  <img
                    src={art.url ?? ''}
                    alt={art.name ?? '生成的图片'}
                    className="w-full block"
                    style={{ maxHeight: 420, objectFit: 'contain' }}
                    loading="lazy"
                  />
                  <div
                    className="flex flex-wrap gap-1.5 p-2"
                    style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
                  >
                    <ApplyBtn icon={<ImagePlus size={10} />} label="插入文档"
                      busy={artBusy('append')} applied={false}
                      disabled={!!applying} onClick={() => onApplyArtifact(art, 'append')} />
                    <ApplyBtn icon={<FilePlus2 size={10} />} label="另存为新文档"
                      busy={artBusy('new')} applied={false}
                      disabled={!!applying} onClick={() => onApplyArtifact(art, 'new')} />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!msg.streaming && msg.phase !== 'error' && msg.quickActions && msg.quickActions.length > 0 && (
          <QuickActionGroups
            actions={msg.quickActions}
            applying={applying}
            onQuickAction={onQuickAction}
          />
        )}

        {canApply && (
          <div className="flex flex-wrap gap-1.5 mt-3 pt-2.5 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
            <ApplyBtn icon={<Replace size={10} />} label="替换原文"
              busy={busyMode === 'replace'} applied={msg.applied === 'replace'}
              disabled={!!applying} onClick={() => onApply(msg.id, 'replace')} />
            <ApplyBtn icon={<FileDown size={10} />} label="追加末尾"
              busy={busyMode === 'append'} applied={msg.applied === 'append'}
              disabled={!!applying} onClick={() => onApply(msg.id, 'append')} />
            <ApplyBtn icon={<FilePlus2 size={10} />} label="另存为新文档"
              busy={busyMode === 'new'} applied={msg.applied === 'new'}
              disabled={!!applying} onClick={() => onApply(msg.id, 'new')} />
            {/* 智能体专属出站动作（巧思）：如缺陷智能体的「创建缺陷」 */}
            {(msg.outboundActions ?? []).map((oa) => {
              const OIcon = OUTBOUND_ICON_MAP[oa.icon] || Send;
              return (
                <ApplyBtn
                  key={oa.key}
                  icon={<OIcon size={10} />}
                  label={oa.label}
                  busy={false}
                  applied={false}
                  disabled={!!applying}
                  accent
                  onClick={() => onOutbound(oa.key, msg.content)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function QuickActionGroups({
  actions, applying, onQuickAction,
}: {
  actions: ChatQuickAction[];
  applying: string | null;
  onQuickAction: (action: ChatQuickAction) => void;
}) {
  const assetActions = actions.filter((a) => (a.group ?? 'assets') === 'assets');
  const processingActions = actions.filter((a) => a.group === 'processing');
  const renderGroup = (label: string, items: ChatQuickAction[]) => {
    if (items.length === 0) return null;
    return (
      <div className="space-y-1.5">
        <div className="text-[10px] font-semibold text-token-muted">{label}</div>
        <div className="flex flex-wrap gap-1.5">
          {items.map((action) => (
            <ApplyBtn
              key={action.key}
              icon={<QuickActionIcon action={action} />}
              label={action.label}
              title={action.description}
              busy={false}
              applied={false}
              disabled={!!applying}
              accent={!!action.initialInput}
              onClick={() => onQuickAction(action)}
            />
          ))}
        </div>
      </div>
    );
  };
  return (
    <div className="mt-3 pt-2.5 border-t space-y-2.5" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
      {renderGroup('已入库产物', assetActions)}
      {renderGroup('继续加工', processingActions)}
    </div>
  );
}

function QuickActionIcon({ action }: { action: ChatQuickAction }) {
  if (action.icon === 'video') return <Video size={10} />;
  if (action.icon === 'timeline') return <Layers size={10} />;
  if (action.icon === 'agent') return <Sparkles size={10} />;
  return <FileText size={10} />;
}

function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block w-1 h-1 rounded-full"
          style={{
            background: 'rgba(147,197,253,0.85)',
            animation: `pulse-dot 1.2s ease-in-out infinite`,
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
      <style>{`
        @keyframes pulse-dot {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1.2); }
        }
      `}</style>
    </span>
  );
}

function ApplyBtn({
  icon, label, title, busy, applied, disabled, onClick, accent,
}: {
  icon: React.ReactNode;
  label: string;
  title?: string;
  busy: boolean;
  applied: boolean;
  disabled: boolean;
  onClick: () => void;
  /** 智能体专属出站动作（巧思）：紫色高亮，区别于通用写回 */
  accent?: boolean;
}) {
  const bg = applied
    ? 'rgba(74,222,128,0.14)'
    : accent ? 'rgba(168,85,247,0.14)' : 'rgba(255,255,255,0.04)';
  const color = applied
    ? 'rgba(110,231,158,0.95)'
    : accent ? 'rgba(216,180,254,0.98)' : 'rgba(255,255,255,0.80)';
  const border = applied
    ? '1px solid rgba(74,222,128,0.30)'
    : accent ? '1px solid rgba(168,85,247,0.35)' : '1px solid rgba(255,255,255,0.08)';
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      title={title ?? label}
      className="inline-flex items-center gap-1 rounded-[7px] px-2.5 py-1.5 text-[10px] font-medium hover:bg-white/8 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
      style={{ background: bg, color, border }}
    >
      {busy ? <RotateCw size={10} className="animate-spin" /> : icon}
      {applied ? `${label}（已写回）` : label}
    </button>
  );
}

// ── 创建快捷智能体浮层（保留旧版） ──
function CreateAgentModal({
  onClose, onSubmit,
}: {
  onClose: () => void;
  onSubmit: (input: { label: string; description: string; systemPrompt: string }) => Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (submitting || !label.trim() || !systemPrompt.trim()) return;
    setSubmitting(true);
    await onSubmit({
      label: label.trim(),
      description: description.trim(),
      systemPrompt: systemPrompt.trim(),
    });
    setSubmitting(false);
  };

  return createPortal(
    <motion.div
      className="surface-backdrop fixed inset-0 z-[1210] flex items-center justify-center px-4"
      initial={{ backgroundColor: 'rgba(0,0,0,0)' }}
      animate={{ backgroundColor: 'rgba(0,0,0,0.55)' }}
      exit={{ backgroundColor: 'rgba(0,0,0,0)' }}
      transition={{ duration: 0.18 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        className="surface-popover flex flex-col rounded-[14px] border border-token-subtle"
        style={{ width: 'min(560px, 96vw)', maxHeight: '85vh', minHeight: 0 }}
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.96, opacity: 0 }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-token-subtle shrink-0">
          <div className="flex items-center gap-2">
            <div className="surface-action-accent flex h-7 w-7 items-center justify-center rounded-[8px]">
              <Bot size={14} />
            </div>
            <div>
              <p className="text-[13px] font-semibold text-token-primary">新建快捷智能体</p>
              <p className="text-[10px] text-token-muted">
                轻量定义；调用时其 system prompt 会叠加到百宝箱通用 chat 链路
              </p>
            </div>
          </div>
          <button onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] text-token-muted hover:bg-white/8"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3" style={{ minHeight: 0 }}>
          <div>
            <label className="block mb-1 text-[11px] font-semibold text-token-muted">
              名称 <span className="text-[10px] font-normal" style={{ color: 'rgba(248,113,113,0.85)' }}>必填</span>
            </label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={30}
              placeholder="例如：高级摘要 / 故事改写 / 风险扫描"
              className="prd-field w-full rounded-[8px] px-3 py-2 text-[12px] outline-none"
            />
          </div>
          <div>
            <label className="block mb-1 text-[11px] font-semibold text-token-muted">描述（可选）</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={200}
              placeholder="一句话说明这个智能体擅长什么"
              className="prd-field w-full rounded-[8px] px-3 py-2 text-[12px] outline-none"
            />
          </div>
          <div>
            <label className="block mb-1 text-[11px] font-semibold text-token-muted">
              System Prompt <span className="text-[10px] font-normal" style={{ color: 'rgba(248,113,113,0.85)' }}>必填</span>
            </label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              maxLength={8000}
              rows={10}
              placeholder={'例：你是文档质量审计员。任务：把用户给的文档输出 Markdown 报告 ...'}
              className="prd-field w-full resize-y rounded-[8px] px-3 py-2 text-[12px] outline-none font-mono leading-relaxed"
              style={{ minHeight: 200 }}
            />
            <p className="mt-1 text-[10px] text-token-muted">
              {systemPrompt.length}/8000 字 · 调用时文档全文 + 用户指令会一起进入百宝箱通用 chat 链路
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-token-subtle shrink-0">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>取消</Button>
          <Button
            variant="primary"
            size="sm"
            disabled={submitting || !label.trim() || !systemPrompt.trim()}
            onClick={handleSubmit}
          >
            {submitting ? <MapSpinner size={12} /> : <Plus size={12} />}
            创建并立即选用
          </Button>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

void AnimatePresence;
void MapSectionLoader;
