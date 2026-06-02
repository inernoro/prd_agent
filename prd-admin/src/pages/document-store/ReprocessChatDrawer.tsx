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
import {
  listReprocessAgents,
  createReprocessAgent,
  deleteReprocessAgent,
  applyReprocessContent,
  getDocumentContent,
  getActiveReprocessRun,
} from '@/services';
import { streamDirectChat, listToolboxItems } from '@/services/real/aiToolbox';
import type { ToolboxItem } from '@/services/real/aiToolbox';
import { invokeAgent, listAgentCapabilities, getAgentParameters, createDefectFromContent } from '@/services/real/agentUniverse';
import type { AgentCapability, AgentArtifact, AgentParameter, AgentOutboundAction } from '@/services/real/agentUniverse';
import { BUILTIN_TOOLS } from '@/stores/toolboxStore';
import type { ReprocessAgent } from '@/services/contracts/documentStore';
import { toast } from '@/lib/toast';

export type ReprocessChatDrawerProps = {
  entryId: string;
  entryTitle: string;
  storeId: string;
  onClose: () => void;
  onApplied?: (mode: 'replace' | 'append' | 'new', entryId: string) => void;
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
  Bug, Send, FilePlus2, FileText, Sparkles, Video, FileBarChart,
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

// 客户端 chat 历史持久化：direct-chat 不在后端落 Run，
// 关掉抽屉 / 切换标签后再开必须保留对话（Bugbot 九轮 Medium）。
// 项目禁用 localStorage，统一走 sessionStorage（no-localstorage.md 规则）。
const CHAT_HISTORY_STORAGE_KEY = 'reprocess-chat-drawer:history';
const MAX_PERSISTED_ENTRIES = 30;
type PersistedChatState = {
  messages: ChatMessage[];
  activeRef?: { kind: 'toolbox'; itemId: string } | { kind: 'kbAgent'; key: string };
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
};

type ActiveAgent =
  | { kind: 'toolbox'; item: ToolboxItem }
  | { kind: 'kbAgent'; agent: ReprocessAgent }
  | null;

const FOCUSED_TOOLBOX_IDS = [
  // 偏文本对话型 builtin agent 排前；视觉/视频/缺陷管理放后面
  'builtin-literary-agent',
  'builtin-report-agent',
  'builtin-pa-agent',
  'builtin-pm-agent',
  'builtin-task-tree',
];

// 哪些 builtin 智能体可在此处选用，现在由「智能体宇宙」能力契约决定（后端 SSOT）：
// 只有在 AgentCapabilityRegistry 注册了能力的 agentKey 才会出现，且各自按 invokeMode
// 走对应交互（视觉创作=文生图、文学/周报=聊天流、缺陷=结构化），不再喂通用 chat。

export function ReprocessChatDrawer({
  entryId,
  entryTitle,
  storeId: _storeId,
  onClose,
  onApplied,
}: ReprocessChatDrawerProps) {
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
  const entryIdRef = useRef(entryId);
  // 同步 apply 锁：和 sendLockRef 同思路，state 异步 setApplying 之前快速双击会让
  // 两次 handleApply 都跑过 if(applying) 检查，跑两次写回（Codex P2 十轮）
  const applyLockRef = useRef(false);
  // 标记本 entryId 的 load effect 已完整跑完（含 setMessages 等所有同步赋值）。
  // 持久化 effect 只在 load 完成后才写 sessionStorage，避免在 entryId 切换瞬间把
  // 上一篇 messages 错写到新 entryId 的 key 下（Bugbot #2 十轮 High）
  const lastLoadedEntryRef = useRef<string | null>(null);
  // 历史注：曾经维护过 sentForLlmRef 想把每轮发给 LLM 的完整 wrapper（含 doc）
  // 塞进 history，让"模型 N 轮后看到的还是 N 轮前那份 doc"。但 doc 可能 40k 字，
  // 多轮放大成 N × 40k token，得不偿失。改为标准 chat-with-doc 模式：history 走
  // 短 bubble text，doc 只放本轮 message。该 ref 已彻底移除（Bugbot 八轮 Medium）。

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  }, []);

  // 中止当前 stream 的统一入口：除了 abort fetch，还要清 streamingId 和 sendLockRef，
  // 否则 chip / 输入框会一直 disabled（Bugbot #2）
  const abortCurrentStream = useCallback(() => {
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
    entryIdRef.current = entryId;
    sendLockRef.current = false;
    applyLockRef.current = false;
    lastLoadedEntryRef.current = null; // 新 entryId 还没初始化完，持久化先停
    abortCurrentStream();
    setMessages([]);
    setActive(null);
    setError(null);
    setApplying(null);
    setInput('');
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

    (async () => {
      try {
        const docRes = await getDocumentContent(entryId);
        if (cancelled || entryIdRef.current !== entryId) return;
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
        if (cancelled || entryIdRef.current !== entryId) return;
        setDocLoadError(e instanceof Error ? e.message : '读取文档异常');
      } finally {
        if (!cancelled && entryIdRef.current === entryId) setLoadingDoc(false);
      }
    })();

    (async () => {
      const [agentRes, toolboxRes, activeRunRes, capRes] = await Promise.all([
        listReprocessAgents(),
        listToolboxItems(),
        getActiveReprocessRun(entryId),
        listAgentCapabilities(),
      ]);
      if (cancelled || entryIdRef.current !== entryId) return;

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
      setToolboxItems([...ordered, ...userOwnedToolbox]);

      const loadedKbAgents = agentRes.success ? agentRes.data.items : [];
      if (agentRes.success) setKbAgents(loadedKbAgents);
      setLoadingAgents(false);

      // 优先以 sessionStorage 持久化为准：新架构走 direct-chat 不写后端 Run，
      // 后端 active-run 是历史遗物，如果用户上次跑过旧 worker，那条会一直是
      // "最新 run"反复污染新会话（Bugbot 十四轮 Medium）。所以只在没有客户端缓存
      // 时才合并后端历史，作为"刚 clean session 后给个起点"的兜底。
      const persistedSnapshot = loadPersistedChat(entryId);
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
          } else {
            const kb = loadedKbAgents.find((a) => a.key === ref.key);
            if (kb) setActive({ kind: 'kbAgent', agent: kb });
          }
        }
      }

      // 至此本 entryId 的初始化（doc 之外的部分）已全部 setState 完毕，标记 ready。
      // 持久化 effect 看到这个 ref 才会开始写 sessionStorage（Bugbot #2 十轮 High）
      if (entryIdRef.current === entryId) lastLoadedEntryRef.current = entryId;
    })();

    return () => {
      cancelled = true;
      abortCurrentStream();
    };
    // abortCurrentStream 是 stable useCallback，不会触发 effect 抖动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId]);

  // 关闭浮层时也走统一 abort，确保 streamingId 被清掉
  useEffect(() => () => abortCurrentStream(), [abortCurrentStream]);

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
    if (lastLoadedEntryRef.current !== entryId) return;    // 初始化没完成不快照
    if (messages.length === 0 && !active) return;
    // 双保险：万一仍有 streaming/thinking 的气泡，过滤掉，避免落"未完成"成"完成"
    const sanitized = messages.filter((m) => !m.streaming && m.phase !== 'streaming' && m.phase !== 'thinking');
    if (sanitized.length === 0 && !active) return;
    const activeRef: PersistedChatState['activeRef'] = active?.kind === 'toolbox'
      ? { kind: 'toolbox', itemId: active.item.id }
      : active?.kind === 'kbAgent'
        ? { kind: 'kbAgent', key: active.agent.key }
        : undefined;
    savePersistedChat(entryId, { messages: sanitized, activeRef });
  }, [entryId, messages, active, loadingDoc, loadingAgents, streamingId]);

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
      onText,
      onError,
      onDone,
    });
    cancelStreamRef.current = stop;
  }, [loadingDoc, docLoadError, messages, docContent, docTruncated, scrollToBottom, capabilityForAgent, entryId, selectedParams]);

  const handleSendInput = useCallback(() => {
    if (!input.trim()) return;
    if (!active) {
      toast.warning('请先选择智能体', '点上方选择器挑一个');
      setPickerOpen(true);
      return;
    }
    const invoker: ChatMessage['invoker'] =
      active.kind === 'toolbox'
        ? { kind: 'toolbox', label: active.item.name, ref: active.item.id, icon: active.item.icon }
        : { kind: 'kbAgent', label: active.agent.label, ref: active.agent.key };
    void sendMessage(input, invoker, active);
  }, [input, active, sendMessage]);

  // 开启全新对话：清空当前对话 + 清掉本文档的持久化（保留已选智能体，方便直接再问）
  const handleNewConversation = useCallback(() => {
    abortCurrentStream();
    setMessages([]);
    setError(null);
    setInput('');
    try { sessionStorage.removeItem(`${CHAT_HISTORY_STORAGE_KEY}:${entryId}`); } catch { /* 配额/隐私模式忽略 */ }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [abortCurrentStream, entryId]);

  // 选中智能体 = 只把它设为"当前智能体"并聚焦输入框，绝不自动发送。
  // 历史 bug：选完立即用默认指令跑一轮，导致"我选了智能体还没说话就发出去了"。
  // 现在用户必须先输入指令（生成型则输入画面描述）再点发送/回车才触发。
  const pickToolbox = useCallback((item: ToolboxItem) => {
    setActive({ kind: 'toolbox', item });
    setPickerOpen(false);
    setError(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const pickKbAgent = useCallback((agent: ReprocessAgent) => {
    setActive({ kind: 'kbAgent', agent });
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

  const handleApply = useCallback(async (
    msgId: string, mode: 'replace' | 'append' | 'new',
  ) => {
    const msg = messages.find((m) => m.id === msgId);
    if (!msg || msg.role !== 'assistant' || !msg.content) return;
    // 已写回的 message 拒绝重入（防止"已写回"按钮被重复点击造成 append 第二次或
    // 又 new 一个）（Codex P2 十轮）
    if (msg.applied) return;
    const key = `${msgId}:${mode}`;
    // 同步 ref 锁：state-based applying 在 React 还没 commit 之前会让双击两次都漏过
    if (applyLockRef.current) return;
    if (applying) return;
    applyLockRef.current = true;
    // 锁定调用瞬间的 entryId；若 await 期间用户切到了别的文档，绝对不能把 success/error
    // 状态再写到当前抽屉里，也不能给 onApplied 回调（会让外层选中错的 entry）。
    // Bugbot #3（二轮 Medium）。
    const requestedEntryId = entryId;
    setApplying(key);
    let res;
    try {
      res = await applyReprocessContent(requestedEntryId, { mode, content: msg.content });
    } catch (e) {
      // 即使 entry 切走也得清 applying，不然新 doc 的写回按钮永远 disabled（Bugbot #3 三轮 Low）
      setApplying(null);
      applyLockRef.current = false;
      if (entryIdRef.current !== requestedEntryId) return; // 切走了，静默丢弃错误 toast
      toast.error('写回失败', e instanceof Error ? e.message : '网络异常');
      return;
    }
    setApplying(null);
    applyLockRef.current = false;
    if (entryIdRef.current !== requestedEntryId) {
      // entry 在 await 期间被切换：丢弃这次结果，避免错认归属
      return;
    }
    if (!res.success) {
      toast.error('写回失败', res.error?.message);
      return;
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
  }, [messages, applying, entryId, onApplied]);

  // 智能体专属出站动作：把产出送回它自己的原生系统（巧思）
  const handleOutbound = useCallback(async (actionKey: string, content: string) => {
    if (!content || !content.trim()) return;
    if (actionKey === 'create-defect') {
      const res = await createDefectFromContent(content);
      if (!res.success) {
        const m = res.error?.message || '创建失败';
        const perm = /\b403\b|权限|forbidden/i.test(m);
        toast.error('创建缺陷失败', perm ? '需要缺陷管理权限（defect-agent.use），请联系管理员开通' : m);
        return;
      }
      toast.success('缺陷已创建', `「${res.data?.title || '新缺陷'}」已建入缺陷库，可去缺陷管理指派/处理`);
    }
  }, []);

  const isBusy = streamingId !== null;
  const isGenerationActive = activeCapability?.invokeMode === 'generation';

  // 把图片成果物以 Markdown 形式写回文档（替换/追加/另存为新文档）
  const handleApplyArtifact = useCallback(async (
    art: AgentArtifact, mode: 'replace' | 'append' | 'new',
  ) => {
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
              <p className="truncate text-[13px] font-semibold text-token-primary">AI 文档对话</p>
              <p className="truncate text-[10px] text-token-muted mt-0.5">
                {entryTitle}
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
            disabled={loadingAgents || !!docLoadError}
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
                        active={active?.kind === 'toolbox' && active.item.id === item.id}
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

        {/* 消息流 */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-5 py-4 space-y-3.5"
          style={{ minHeight: 0, overscrollBehavior: 'contain' }}
        >
          {messages.length === 0 ? (
            <EmptyState
              loadingDoc={loadingDoc}
              entryTitle={entryTitle}
              hasAgent={!!active}
              docLoadError={docLoadError}
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

        {/* 输入区 */}
        <div className="surface-panel-footer px-5 py-3 shrink-0 border-t border-token-subtle">
          {/* 引用文档指示：让用户在输入时明确"这次会带上哪篇文章" */}
          {!docLoadError && !isGenerationActive && (
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
                docLoadError
                  ? '文档未加载，无法对话'
                  : isBusy
                    ? (isGenerationActive ? '正在生成…' : 'AI 正在回复，请稍候…')
                    : activeCapability
                      ? activeCapability.inputHint
                      : active
                        ? `输入指令配合「${active.kind === 'toolbox' ? active.item.name : active.agent.label}」，Enter 发送`
                        : '先选个智能体，然后输入指令'
              }
              disabled={isBusy || !!docLoadError}
              rows={2}
              className="prd-field flex-1 resize-none rounded-[10px] px-3 py-2 text-[12px] outline-none disabled:opacity-60"
            />
            <Button
              variant="primary"
              size="sm"
              className="!h-auto self-stretch px-4 shrink-0"
              disabled={isBusy || !input.trim() || !!docLoadError}
              onClick={handleSendInput}
            >
              {isBusy
                ? <MapSpinner size={12} />
                : isGenerationActive ? <ImagePlus size={12} /> : <Send size={12} />}
              {activeCapability?.actionLabel ?? '发送'}
            </Button>
          </div>
          <p className="mt-1.5 text-[10px] text-token-muted">
            {isBusy
              ? (isGenerationActive ? '正在生成图片，请稍候…' : '正在调用智能体；文档已作为输入发送')
              : isGenerationActive
                ? '视觉创作：输入画面描述生成图片，生成后可一键插入文档'
                : active
                  ? '输入指令后回车 / 点按钮触发当前智能体（选中不会自动发送）'
                  : '先在上方选择一个智能体，再输入指令'}
          </p>
        </div>
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
function EmptyState({ loadingDoc, entryTitle, hasAgent, docLoadError }: {
  loadingDoc: boolean;
  entryTitle: string;
  hasAgent: boolean;
  docLoadError?: string | null;
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

// ── 消息气泡 ──
function MessageBubble({
  msg, applying, onApply, onApplyArtifact, onOutbound,
}: {
  msg: ChatMessage;
  applying: string | null;
  onApply: (msgId: string, mode: 'replace' | 'append' | 'new') => void;
  onApplyArtifact: (art: AgentArtifact, mode: 'replace' | 'append' | 'new') => void;
  onOutbound: (actionKey: string, content: string) => void;
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
  const canApply = !msg.streaming && !!msg.content && msg.phase !== 'error';
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
        {msg.streaming && msg.content ? (
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
  icon, label, busy, applied, disabled, onClick, accent,
}: {
  icon: React.ReactNode;
  label: string;
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
      className="inline-flex items-center gap-1 rounded-[7px] px-2.5 py-1.5 text-[10px] font-medium hover:bg-white/8 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
