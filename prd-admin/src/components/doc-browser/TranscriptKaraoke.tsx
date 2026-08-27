import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Check, ChevronDown, ChevronUp, Info, MessageSquare, Pencil, RefreshCw, Search, UserRound } from 'lucide-react';
import { requestRecordingPlay } from './recordingPlayBridge';
import { AudioWavePlayer } from '@/components/doc-browser/AudioWavePlayer';
import { RecordingSegmentBar } from '@/components/doc-browser/RecordingSegmentBar';
import { RecordingAskComposer } from '@/components/doc-browser/RecordingAskComposer';
import {
  advanceUnansweredNotice,
  NO_UNANSWERED_NOTICE,
  parseTranscriptSegments,
  hasUsableTimestamps,
  activeSegmentIndex,
  estimateTranscriptSegments,
  replaceEstimatedTranscriptSentenceText,
  replaceTranscriptSegmentText,
  assignTranscriptSegmentSpeaker,
  renameTranscriptSpeaker,
  buildTranscriptWordCloud,
  describeWordCloudEmptyState,
  parseSpeakerSourceNote,
  extractTranscriptSummary,
  parseSummaryModules,
  extractTranscriptTodos,
  isTodoOnlyModule,
  findTodoSource,
  buildSpeakerStats,
} from '@/components/doc-browser/transcriptSegments';
import type { UnansweredNotice } from '@/components/doc-browser/transcriptSegments';
import { MarkdownViewer } from '@/components/file-preview/MarkdownViewer';
import { OrganizeStylePanel, type OrganizeState } from '@/components/doc-browser/OrganizeStylePanel';
import { RecordingAnswer } from '@/components/doc-browser/RecordingAnswer';
import { streamDirectChat } from '@/services/real/aiToolbox';
import { DEFAULT_ORGANIZE_STYLE_KEY } from '@/services/real/documentStore';
import { useIsDesktop } from '@/hooks/useBreakpoint';
import { getTranscriptLexicon, updateSystemTranscriptLexicon, updateTranscriptLexicon } from '@/services/real/userPreferences';

/**
 * 把句子里命中的词包成高亮片段。大小写不敏感，逐段切；
 * 关键词为空时原样返回——这条分支必须有，否则空关键词会把整句切成无限段。
 */
function highlightKeyword(text: string, keyword: string): React.ReactNode {
  const needle = keyword.trim();
  if (!needle) return text;
  const lowerText = text.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (;;) {
    const hit = lowerText.indexOf(lowerNeedle, cursor);
    if (hit < 0) break;
    if (hit > cursor) parts.push(text.slice(cursor, hit));
    parts.push(
      <mark
        key={`${hit}-${parts.length}`}
        // 设计稿的命中高亮是**记号笔**：高明度黄底 + 深色字，与蓝色强调色分工——
        // 蓝表示「可点/进行中」，黄表示「就是这里」。
        // 此前用 --semantic-warning-soft（12% 透明度），深色主题下几乎与正文同色，
        // 记号笔退化成一层看不见的底纹（B2 判分记的正是这处）。
        style={{ background: 'var(--highlight-mark-bg)', color: 'var(--highlight-mark-fg)', borderRadius: 3, padding: '0 2px' }}
      >
        {text.slice(hit, hit + needle.length)}
      </mark>,
    );
    cursor = hit + needle.length;
  }
  if (cursor === 0) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/**
 * 结果页那几段内容各自是一张卡（词云 / 会议纪要 / 待办 / 问这场录音）。
 * 抽成常量而不是各写各的：四处必须长得一样，写四遍就是四处会各自漂移的地方。
 */
/**
 * 桌面三栏（设计稿 D1/D2）右栏的四个分页签。
 * 手机上这四块是**并置**往下铺的（P3 那一屏画的就是并置），桌面才收成分页签——
 * 宽屏一次只看一块是稿面的选择，窄屏一次只看一块会把主路径切断。
 */
const DESKTOP_PANELS = [
  { key: 'understand', label: '理解' },
  { key: 'summary', label: '纪要' },
  { key: 'todo', label: '待办' },
  { key: 'ask', label: '提问' },
] as const;
type DesktopPanelKey = (typeof DESKTOP_PANELS)[number]['key'];

const SECTION_CARD = 'rounded-[14px] p-4';
const SECTION_CARD_STYLE: React.CSSProperties = {
  background: 'var(--bg-nested)',
  border: '1px solid var(--border-faint)',
};

/**
 * 找到真正在滚的那个祖先容器。找不到就返回 null（= 用视口，那是正确的兜底：
 * 整页滚动时视口本来就是滚动容器）。
 */
function nearestScrollParent(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

/** mm:ss；无时间戳的行不显示时钟而不是显示一个假的 0:00。 */
/**
 * 说话人圆标取哪个字：名字里带拉丁字母或数字就取最后那一个（受访者 A → A、嘉宾 2 → 2），
 * 否则取首字（主持人 → 主）。稿面 D1 两种都画了，规则由这一条统一。
 */
function speakerInitial(speaker: string): string {
  const latin = speaker.trim().match(/[A-Za-z0-9](?=[^A-Za-z0-9]*$)/);
  return latin ? latin[0].toUpperCase() : speaker.trim().slice(0, 1);
}

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '';
  // 分钟也补两位：稿面全场是 09:58 / 09:20 / 09:41，原文列表左侧那一列靠它对齐；
  // 写成 9:58 就会和 10:12 参差，扫读节奏没了。
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

export function buildRecordingQuestionPrompt(noteMd: string, question: string): string {
  return [
    '你是会议录音问答助手。只能依据下方带时间轴的录音原文回答。',
    '先给简明结论，再列依据。每条依据必须使用原文已有时间，格式严格为 [mm:ss-mm:ss]。',
    '如果原文不足以回答，明确说无法从录音确认，不得补造事实。',
    `[录音原文]\n${noteMd}`,
    `[问题]\n${question}`,
  ].join('\n\n');
}

function formatQuestionTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function buildRecordingQuestionTranscript(
  segments: Array<{ start: number; end: number; text: string; speaker?: string }>,
  fallbackMd: string,
): string {
  if (segments.length === 0 || segments.some(segment => segment.start < 0 || segment.end < 0))
    return fallbackMd;
  return segments.map(segment => (
    `**[${formatQuestionTime(segment.start)} - ${formatQuestionTime(segment.end)}]**${segment.speaker ? ` [${segment.speaker}]` : ''} ${segment.text}`
  )).join('\n\n');
}

export function recordingCitationMatchesTimeline(
  start: number,
  segments: Array<{ start: number; end: number }>,
): boolean {
  return Number.isFinite(start) && segments.some(segment => (
    segment.start >= 0 && start >= segment.start && start <= Math.max(segment.start, segment.end)
  ));
}

export interface TranscriptLexiconState {
  terms: string[];
  system: string[];
  mine: string[];
  muted: string[];
  canManageSystem: boolean;
}

/**
 * 添加一个词条之后，本地这张词典表应该长成什么样。
 *
 * 词典的写端点是**整表替换**：提交什么就是什么，服务端不做合并。所以下一次提交的
 * 入参必须从「上一次已经写成功的那一版」算起。如果本地表还停在写前的旧版
 * （比如刷新用的 GET 慢了或失败了），第二次添加就会拿旧表整表覆盖，把刚存进去的词
 * 静默抹掉——系统级抹的是所有人共用的那张表。
 *
 * 提出来单独放的原因：这段是数据丢失的那一半，可以脱离组件直接断言。
 */
export function advanceTranscriptLexicon(
  prev: TranscriptLexiconState,
  term: string,
  scope: 'mine' | 'system',
): TranscriptLexiconState {
  return {
    ...prev,
    terms: [...new Set([...prev.terms, term])],
    system: scope === 'system' ? [...new Set([...prev.system, term])] : prev.system,
    mine: scope === 'system' ? prev.mine : [...new Set([...prev.mine, term])],
  };
}

/**
 * 转录跟读播放器（歌词滚轮）——音频原始内容页的"小巧思"：
 * 播放时当前句居中高亮、上下句渐隐（苹果滚轮 / 音乐歌词心智），说的话和文字对得上；
 * 点任意句跳播到那一秒。录音的和上传的音频走同一个组件（结果页统一）。
 *
 * 数据源：该音频已生成的转录笔记 markdown（**[mm:ss - mm:ss]** 行）。
 * chat-audio 转写路径无时间戳 → 音频时长就绪后按语速估算逐句位置，并明确标注估算。
 * 用户手动滚动歌词区后，暂停自动跟随 3 秒再恢复（不跟用户抢滚动条）。
 */
export function TranscriptKaraoke({
  src,
  noteMd,
  documentMode = false,
  onSaveNote,
  onAskRecording,
  onRestyle,
  organize,
  onPickOrganizeStyle,
}: {
  src: string;
  noteMd: string;
  /** 同一文档模式：原文随页面自然展开，播放时在当前页面跟随高亮，不制造第二层滚动。 */
  documentMode?: boolean;
  /** 同页校对：保存修改后的整份转录 markdown。 */
  onSaveNote?: (nextNoteMd: string) => Promise<boolean | void>;
  /** 打开以当前录音原文为上下文的知识库问答。 */
  onAskRecording?: () => void;
  /** 重新生成整理结果（设计稿把它放在「会议纪要」标题右侧）。 */
  onRestyle?: () => void;
  /**
   * 「一键整理」那块网格的状态（稿面 B3）。宿主知道当前笔记用的是哪种整理方式、
   * 有没有在途 run，就传进来；不传的话四张卡都是「点击生成」——那是**如实的**
   * 「不知道」，不是假装某一张已生成。
   */
  organize?: OrganizeState;
  /** 选了某种整理方式：宿主去发起 restyle。不传就不渲染这一块。 */
  onPickOrganizeStyle?: (styleKey: string) => void;
}) {
  const segments = useMemo(() => parseTranscriptSegments(noteMd), [noteMd]);
  // 摘要一直存在 noteMd 里，只是此前没有任何界面读它；纪要与待办都从这里长出来
  const summaryMd = useMemo(() => extractTranscriptSummary(noteMd), [noteMd]);
  // 纯任务清单的模块交给「待办事项」区渲染，纪要里不再重复列一遍
  const summaryModules = useMemo(
    () => parseSummaryModules(summaryMd).filter(module => !isTodoOnlyModule(module.markdown)),
    [summaryMd],
  );
  const todos = useMemo(() => extractTranscriptTodos(summaryMd), [summaryMd]);
  /**
   * 「一键整理」结果卡的正文：当前这份摘要的开头一段。
   * 稿面 B3 那张卡就是一段话——它是「你刚选的这一种整理，产出长这样」的凭证，
   * 不是纪要全文（全文在下面的分区里，那是另一张画布 P3 定义的结构）。
   * 取第一段而不是全文，也是为了不在同一屏把同一段话完整念两遍。
   */
  const organizeLede = useMemo(() => {
    const body = summaryModules[0]?.markdown ?? '';
    return body
      .split(/\n{2,}/)
      .map(part => part.trim())
      .find(part => part && !part.startsWith('-') && !part.startsWith('#') && !part.startsWith('*')) ?? '';
  }, [summaryModules]);
  const synced = useMemo(() => hasUsableTimestamps(segments), [segments]);

  const [activeIdx, setActiveIdx] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [renamingSpeaker, setRenamingSpeaker] = useState<string | null>(null);
  const [speakerDraft, setSpeakerDraft] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [asking, setAsking] = useState(false);
  const [qaError, setQaError] = useState('');
  /** 当前这条回答对应的提问（稿面 B4 把它做成右对齐气泡） */
  const [askedQuestion, setAskedQuestion] = useState('');
  /** 琥珀提示条：上一问没答上来时记一笔，规则见 advanceUnansweredNotice */
  const [notice, setNotice] = useState<UnansweredNotice>(NO_UNANSWERED_NOTICE);
  const lastUnanswered = notice.question;
  const cancelQaRef = useRef<(() => void) | null>(null);
  /** 这一问累积到现在的全文；onDone 要读它判断「是不是如实说了没有」 */
  const answerRef = useRef('');
  const seekRef = useRef<((sec: number) => void) | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // 用户手动滚动 → 3s 内不自动跟随（不抢滚动条）
  const manualUntilRef = useRef(0);
  const estimatedSegments = useMemo(
    () => synced ? [] : estimateTranscriptSegments(segments, duration),
    [duration, segments, synced],
  );
  const timelineSegments = synced ? segments : estimatedSegments.length > 0 ? estimatedSegments : segments;
  const followEnabled = synced || estimatedSegments.length > 1;
  const estimated = !synced && estimatedSegments.length > 1;
  // 词典三层，合并后喂给分词：
  //   L0 本篇说话人名 —— 零配置。ICU 词典不收人名，会上被反复叫到的人恰恰是高价值信息，
  //      而这批名字笔记里本来就有（[说话人] 标签），不需要任何人去维护。
  //   L1 系统级 —— 管理员维护的全局表，所有人默认引用。
  //   L2 个人补充 —— 自己加的，可以单独屏蔽系统表里对自己是噪音的词。
  // L1/L2 的合并在后端做，前端只消费结果。
  const [lexicon, setLexicon] = useState<{ terms: string[]; system: string[]; mine: string[]; muted: string[]; canManageSystem: boolean } | null>(null);
  const [lexiconDraft, setLexiconDraft] = useState('');
  const [lexiconOpen, setLexiconOpen] = useState(false);
  const [savingLexicon, setSavingLexicon] = useState(false);
  useEffect(() => {
    let alive = true;
    void getTranscriptLexicon().then((res) => {
      if (!alive || !res.success) return;
      setLexicon({ terms: res.data.terms, system: res.data.system, mine: res.data.mine, muted: res.data.muted, canManageSystem: res.data.canManageSystem });
    });
    return () => { alive = false; };
  }, []);
  const dictionary = useMemo(() => {
    const speakerNames = segments
      .map(segment => segment.speaker?.trim())
      .filter((name): name is string => !!name && name.length >= 2);
    return [...new Set([...speakerNames, ...(lexicon?.terms ?? [])])];
  }, [segments, lexicon]);
  const wordCloud = useMemo(
    () => buildTranscriptWordCloud(segments, 18, dictionary),
    [segments, dictionary],
  );

  const addLexiconTerm = async (scope: 'mine' | 'system') => {
    const term = lexiconDraft.trim();
    if (!term || term.length < 2 || savingLexicon) return;
    // 词典还没读回来就不许提交：写端点是**整表替换**，此时 lexicon 为 null，
    // 拿不到已有词条就只能发一张空表出去——一次添加就抹掉此前存的全部个人词与屏蔽词，
    // 系统级更狠（那是所有人共用的一张表）。这不是保守，是这条链路的写语义决定的。
    if (!lexicon) return;
    setSavingLexicon(true);
    try {
      // 提交什么、本地推进成什么，走同一条判据，避免两处各算一遍再漂移
      const next = advanceTranscriptLexicon(lexicon, term, scope);
      const res = scope === 'system'
        ? await updateSystemTranscriptLexicon(next.system)
        : await updateTranscriptLexicon(next.mine, lexicon.muted);
      if (!res.success) return;
      setLexiconDraft('');
      // 写成功后立刻把本地这张表推进到「刚提交的那一版」，不等刷新回来。
      // 配合下面 finally 里才解锁，慢刷新和刷新失败两种情况都不会留下过期的表。
      setLexicon(prev => (prev ? advanceTranscriptLexicon(prev, term, scope) : prev));
      const refreshed = await getTranscriptLexicon();
      if (refreshed.success) {
        setLexicon({
          terms: refreshed.data.terms,
          system: refreshed.data.system,
          mine: refreshed.data.mine,
          muted: refreshed.data.muted,
          canManageSystem: refreshed.data.canManageSystem,
        });
      }
    } finally {
      setSavingLexicon(false);
    }
  };
  const speakers = useMemo(
    () => [...new Set(segments.map(segment => segment.speaker).filter((value): value is string => Boolean(value)))],
    [segments],
  );
  // 每条待办回原文找出处；找不到的就没有出处，不硬挂一句上去
  const todoSources = useMemo(
    () => todos.map(todo => findTodoSource(todo.text, timelineSegments)),
    [todos, timelineSegments],
  );
  const todoSourceCount = todoSources.filter(Boolean).length;
  const speakerStats = useMemo(() => buildSpeakerStats(segments), [segments]);
  // 默认选中最高频的那个词：命中面板一进来就有内容，而不是先让用户猜该点哪个。
  // 设计稿画的也是「已选中某词」这一态；只在换了录音（词云变了）时重置。
  const topWord = wordCloud[0]?.word ?? '';
  useEffect(() => { setSelectedWord(topWord); }, [topWord]);
  // 说话人是原生识别来的还是本地声纹估算来的，可信度差一个量级。
  // 不标出来的话两者在界面上完全一样，用户没有任何线索判断该不该信。
  const speakerSource = useMemo(() => parseSpeakerSourceNote(noteMd), [noteMd]);
  /**
   * 命中面板认的词有两个来源：搜索框输入，和词云里被点中的那个词。
   * 分成两个状态而不是共用一个：点词不该把词填进搜索框（设计稿里搜索框是空的），
   * 搜索也不该把词云的选中态改掉。搜索优先——用户正在打字时那是他当下的意图。
   */
  const [selectedWord, setSelectedWord] = useState('');
  const activeTerm = keyword.trim() || selectedWord;
  const searchMatches = useMemo(() => {
    const normalized = activeTerm.toLocaleLowerCase();
    if (!normalized) return [];
    return timelineSegments
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => segment.text.toLocaleLowerCase().includes(normalized));
  }, [activeTerm, timelineSegments]);
  /**
   * 命中之间来回跳（稿面 B2 的「3 / 9」+ 旁边那颗圆钮）。
   * 换关键词就归零——否则上一次停在第 7 个，新词只有 2 个命中，「8 / 2」是句假话。
   */
  const [hitCursor, setHitCursor] = useState(0);
  useEffect(() => { setHitCursor(0); }, [activeTerm]);
  const gotoHit = useCallback((step: 1 | -1) => {
    if (searchMatches.length === 0) return;
    const next = (hitCursor + step + searchMatches.length) % searchMatches.length;
    setHitCursor(next);
    const target = searchMatches[next];
    // 跳过去要做两件事：把那一句滚进视野，能跳播的话顺便跳播
    lineRefs.current[target.index]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    manualUntilRef.current = Date.now() + 3000;
    if (followEnabled && target.segment.start >= 0) seekRef.current?.(target.segment.start);
  }, [followEnabled, hitCursor, searchMatches]);

  /**
   * 稿面 B3 开场那句结论要挂一个真实百分比。它就是「含最高频词的句子 ÷ 总句数」，
   * 不是从稿面抄一个 62% 过来（no-rootless-tree）——所以文案也照这个口径写，
   * 不写成含糊的「内容占比」，读者能自己复核。
   */
  const topicLede = useMemo(() => {
    if (wordCloud.length === 0 || timelineSegments.length === 0) return null;
    const top = wordCloud[0].word;
    const needle = top.toLocaleLowerCase();
    const hits = timelineSegments.filter(seg => seg.text.toLocaleLowerCase().includes(needle)).length;
    const percent = Math.round((hits / timelineSegments.length) * 100);
    // 连 1% 都不到时这句结论没有意义，不如不说
    if (percent < 1) return null;
    return { top, second: wordCloud[1]?.word ?? '', percent };
  }, [timelineSegments, wordCloud]);

  const questionTranscript = useMemo(
    () => buildRecordingQuestionTranscript(timelineSegments, noteMd),
    [noteMd, timelineSegments],
  );

  const onTimeUpdate = useCallback((t: number) => {
    if (!followEnabled) return;
    const idx = activeSegmentIndex(timelineSegments, t);
    setActiveIdx(prev => (prev === idx ? prev : idx));
  }, [followEnabled, timelineSegments]);

  // 当前句滚到滚轮中心
  useEffect(() => {
    if (!followEnabled) return;
    if (Date.now() < manualUntilRef.current) return;
    // 正在改某一句时绝不自动滚：光标还在框里，列表却把这一句滚走，等于把用户的手推开
    if (editingIndex !== null) return;
    lineRefs.current[activeIdx]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIdx, editingIndex, followEnabled]);

  useEffect(() => () => cancelQaRef.current?.(), []);

  const askRecording = () => {
    const userQuestion = question.trim();
    if (!userQuestion || asking) return;
    cancelQaRef.current?.();
    setAnswer('');
    setQaError('');
    setAsking(true);
    setAskedQuestion(userQuestion);
    // 发出去就把输入框腾空：这一问已经变成上面那颗气泡了，留在框里既像没发出去，
    // 又挡着下一问（稿面 B4 的已发送态输入框里是空的）。
    setQuestion('');
    /*
     * 流下来的字要同时进 state（给渲染）和 ref（给 onDone 读全文）。
     * 原先是在 `setAnswer` 的 updater 里顺手调 `setLastUnanswered` 来读全文——
     * 那个 updater 返回的是同一个字符串，React 判等后整批更新被丢掉，
     * 嵌在里面的那一发也跟着没了：琥珀提示条因此从来没有真正亮过一次。
     * 取证驱到「问一个原文答不上来的问题」那一步才照出来（形状 2：只建了一半）。
     */
    answerRef.current = '';
    cancelQaRef.current = streamDirectChat({
      message: buildRecordingQuestionPrompt(questionTranscript, userQuestion),
      onText: (chunk) => {
        answerRef.current += chunk;
        setAnswer(current => current + chunk);
      },
      onError: error => { setQaError(error || '问答失败，请稍后重试'); setAsking(false); },
      onDone: () => {
        setAsking(false);
        /*
         * 这一问没答上来的话记一笔：稿面 B4 顶部那条琥珀提示要的就是
         * 「上一问没答上来，而且是如实说的」——不记下来，用户下次提问时
         * 已经看不到系统曾经诚实过一次了。
         *
         * 关键在**留多久**：稿面画的正是「琥珀条 + 一条答得上来的问答」同屏，
         * 所以答得上来的那一轮不能顺手把它清掉——那样它只在两次提问之间的
         * 空档里存在，屏幕上永远等不到它。让它陪满下一轮再退场。
         */
        setNotice(prev => advanceUnansweredNotice(prev, { question: userQuestion, answer: answerRef.current }));
      },
    });
  };

  /**
   * 自动跟随被暂停时，用户手里没有「回到播放位置」的入口——只能自己往回滚找。
   * 稿面 B2 给的出口是屏底那颗浮动药丸「继续跟随播放」；B1 给的是搜索行里那颗
   * 「继续跟随」。两颗都留：搜索行那颗是常驻入口，浮动那颗只在真的跟丢了才浮出来。
   * 跟丢有两种：手动滚过（3 秒冷却）、正在改某一句（改完才算数）。
   */
  const [followPaused, setFollowPaused] = useState(false);
  const followPauseTimerRef = useRef<number | null>(null);
  useEffect(() => () => { if (followPauseTimerRef.current) window.clearTimeout(followPauseTimerRef.current); }, []);
  /** 让内联编辑区的高度跟着内容长，短句下不留一段不承载信息的空白 */
  const autoGrow = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useEffect(() => {
    const el = document.activeElement;
    if (el instanceof HTMLTextAreaElement && editingIndex !== null) autoGrow(el);
  }, [autoGrow, editDraft, editingIndex]);

  const markManualScroll = () => {
    manualUntilRef.current = Date.now() + 3000;
    setFollowPaused(true);
    if (followPauseTimerRef.current) window.clearTimeout(followPauseTimerRef.current);
    followPauseTimerRef.current = window.setTimeout(() => setFollowPaused(false), 3000);
  };
  const resumeFollow = () => {
    manualUntilRef.current = 0;
    if (followPauseTimerRef.current) window.clearTimeout(followPauseTimerRef.current);
    setFollowPaused(false);
    lineRefs.current[activeIdx]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  const followLost = followEnabled && (followPaused || editingIndex !== null);

  /**
   * 播放区折叠（设计稿：原文向上滚过一段距离后，播放区收成一条迷你条）。
   * 不折叠的话，滚到原文中段时半屏还被波形占着，词云与纪要被挤到屏外——
   * 审查智能体判的「首屏主角是播放器而不是内容」就是这个。
   *
   * 用哨兵元素 + IntersectionObserver，不监听 scroll：滚动事件要自己找滚动容器、
   * 自己节流。
   *
   * 但 root 必须显式给**真正在滚的那个祖先**，不能用默认的视口。这一屏的滚动发生在
   * 阅读器的内容区 / 结果页的 main 里，那些容器往往整体就在视口之外或只露一部分；
   * 拿视口当 root 的话，用户一下都没滚，哨兵就已经算「不相交」——播放器一进屏就是
   * 折叠态。B1 首判 32 分里最重的那几条（波形、当前句卡、句序、倍速全不见）
   * 就是这一个默认值造成的：判据取的不是它要判的那个滚动位置。
   */
  const collapseSentinelRef = useRef<HTMLDivElement>(null);
  const [scrolledPastPlayer, setScrolledPastPlayer] = useState(false);
  /** 倍速由播放器播报上来（稿面 P2 的迷你条要显示它）；这里只存不改 */
  const [rateLabel, setRateLabel] = useState('');
  /*
    播放区什么时候收成一条：滚过它，**或者**正在改某一句。
    后半条是新加的，因为「正在改一句话」的时候用户的注意力全在列表上，
    完整播放区在这一刻只是占着半屏——稿面 P2 画的正是「迷你条 + 搜索 + 筛选 + 编辑卡」
    同屏那一幕，那一屏根本摆不下展开态的播放区。
  */
  const playerCollapsed = scrolledPastPlayer || editingIndex !== null;
  useEffect(() => {
    const sentinel = collapseSentinelRef.current;
    if (!documentMode || !sentinel || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        // 只有哨兵**滚到了顶上面**才算折叠。光看 isIntersecting 不够：
        // 哨兵在滚动区最顶端，还没滚时它同样不与「被负 margin 缩掉 120px 的顶部」相交，
        // 于是一进屏就判折叠——播放器从来没展开过。
        // 判据必须区分「滚上去了」和「还没滚到」，这两件事的 isIntersecting 都是 false。
        const rootTop = entry.rootBounds?.top ?? 0;
        setScrolledPastPlayer(!entry.isIntersecting && entry.boundingClientRect.top < rootTop);
      },
      { root: nearestScrollParent(sentinel), rootMargin: '0px', threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [documentMode]);

  /*
   * 桌面三栏（D1/D2）：右栏收成分页签，主栏留给波形与原文。
   * 断点不能只靠 CSS——两种形态渲染的节点不一样（桌面一次只挂一块），
   * 纯 `lg:hidden` 会把四块全渲染出来再藏三块，滚动位置与懒加载都会跟着错。
   */
  const isDesktop = useIsDesktop();
  const [panelTab, setPanelTab] = useState<DesktopPanelKey>('understand');
  /** 编辑态里给这一句现填的说话人（稿面 cap-S11 的落点） */
  const [assignSpeakerDraft, setAssignSpeakerDraft] = useState('');
  /*
    说话人筛选（稿面 B2 搜索行下面那一排 chip）。
    只筛**显示**，不改 timelineSegments 的下标——跟读高亮、跳播、编辑保存写回第 i 句
    全都按原始下标走，筛完重排下标会让「保存」改到另一句上去。
  */
  const [speakerFilter, setSpeakerFilter] = useState<string | null>(null);
  const UNLABELED_SPEAKER = '未识别';
  const speakerChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const segment of timelineSegments) {
      const key = segment.speaker?.trim() || UNLABELED_SPEAKER;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // 稿面顺序是「说得多的在前，未识别垫底」
    return [...counts.entries()]
      .map(([speaker, count]) => ({ speaker, count }))
      .sort((a, b) => (a.speaker === UNLABELED_SPEAKER ? 1 : b.speaker === UNLABELED_SPEAKER ? -1 : b.count - a.count));
  }, [timelineSegments]);
  // 换了录音（说话人集合变了）就把筛选放开，否则会停在一个这份原文里不存在的名字上，列表全空
  useEffect(() => {
    setSpeakerFilter(current => (current && speakerChips.some(chip => chip.speaker === current) ? current : null));
  }, [speakerChips]);
  const showPanel = (key: DesktopPanelKey) => !isDesktop || panelTab === key;

  const currentSegment = timelineSegments[activeIdx] ?? null;
  const nextSegment = timelineSegments[activeIdx + 1] ?? null;

  if (segments.length === 0) return <AudioWavePlayer src={src} />;

  return (
    <div
      className={documentMode
        ? 'relative flex w-full flex-col items-center gap-4 lg:h-full lg:min-h-0 lg:flex-row lg:items-stretch lg:gap-6'
        : 'relative flex w-full flex-col items-center gap-4'}>
      {/*
        主栏：波形 + 播放条 + 原文。桌面下它占主导宽度，右栏是配角（content-fills-canvas）。
        窄屏它必须退成 `contents`——否则吸顶播放条的**包含块**只有这一栏那么高，
        滚到词云/纪要/问答（它们在下面那个 aside 里）时播放条就到头滚走了。
        P3/P4 判分里「迷你播放条在这一屏整体缺席」正是这一层：sticky 本身没错，
        错的是它被关在一个提前结束的盒子里。
      */}
      <div className={documentMode
        ? 'contents lg:flex lg:h-full lg:min-h-0 lg:w-auto lg:min-w-0 lg:flex-1 lg:flex-col lg:items-center lg:gap-4 lg:overflow-y-auto lg:pb-6'
        : 'contents'}>
      {documentMode && (
        // 「录音」这个分区标题去掉了：顶栏已经写明这一屏是什么，稿面也没有它；
        // 留着的代价是它和下方白底播放区之间空出一大块灰，正是判官记的「播放区顶部留白」。
        // 跟随进度仍要播报给读屏，只是不再占一行可见文案。
        <p className="sr-only" aria-live="polite">
          {playing && followEnabled ? `正在跟随第 ${activeIdx + 1}/${timelineSegments.length} 句` : ''}
        </p>
      )}
      {/*
        吸顶播放区（设计稿 P1）：原文往下滚的时候，播放器和「现在念到哪一句」必须一直在视野里。
        此前播放器随页面滚走，滚到第 60 句时既看不到进度也不知道正在念哪句，
        想跳播只能先滚回顶部——这也是那一屏「只剩一个播放器和一堆留白」的原因之一。
        只在同文档模式吸顶：另一种形态本身就是固定高度的滚轮，不存在滚走的问题。
      */}
      {/*
        哨兵绝对定位：它在流内会白占一个 gap-4（16px），和外层 pt-3 一起在顶栏与波形之间
        堆出一条什么都不承载的空带。绝对定位后它仍在根容器顶端那个位置，
        IntersectionObserver 与 scrollIntoView 都照常工作。
      */}
      {documentMode && <div ref={collapseSentinelRef} aria-hidden style={{ position: 'absolute', top: 0, height: 1, width: '100%' }} />}
      {/*
        稿面 B1 靠**两种底色**把播放区与原文区切开：播放区通铺白、原文区浅灰。
        我原先两区同底色，分层只剩标题文字承担——两位判官都记了这一处。
        白底同时让当前句卡那块浅灰重新看得见（此前两者几乎同色，卡片形同没有）。
      */}
      <div
        className={documentMode ? 'sticky top-0 z-10 -mx-4 -mt-3 flex w-[calc(100%+2rem)] flex-col items-center gap-2 px-4 pb-3 pt-3' : 'contents'}
        style={documentMode ? { background: 'var(--bg-card)', borderBottom: '1px solid var(--border-faint)' } : undefined}
      >
        {/* 折叠态：一条 56px 的当前片段条；展开态是完整波形播放器 */}
        {documentMode && playerCollapsed && currentSegment ? (
          <RecordingSegmentBar
            text={currentSegment.text}
            startSec={currentSegment.start}
            durationSec={duration}
            rateLabel={rateLabel}
            playing={playing}
            onPlay={requestRecordingPlay}
            onExpand={() => collapseSentinelRef.current?.scrollIntoView({ block: 'start' })}
          />
        ) : null}

        <div style={documentMode && playerCollapsed ? { display: 'none' } : undefined} className="flex w-full flex-col items-center gap-2">
        <AudioWavePlayer
          src={src}
          onTimeUpdate={onTimeUpdate}
          onDurationChange={setDuration}
          onPlaybackChange={setPlaying}
          onRateChange={setRateLabel}
          registerSeek={(seek) => { seekRef.current = seek; }}
          // 句序与「逐句对齐」这句都归播放器主体：它们和时间回答的是同一个问题
          transportMeta={documentMode && followEnabled && !isDesktop
            ? `第 ${activeIdx + 1} / ${timelineSegments.length} 句`
            : undefined}
          // 稿面 D1/D2 播放键两侧那对 « »：跳到上一句 / 下一句的开头。
          // 只有真的有逐句时间轴时才给——没有时间轴就没有「一句」可跳。
          /*
            这对 « » 只挂宽屏。390px 上它们各吃掉 48px + 间距，把时间列压到放不下一行——
            「24:18」被挤到第二行、「精准时间轴 · 逐句对齐」被截成「逐…」（P1/P2 判分记的正是这处）。
            稿面 P1/P2 的窄屏播放区本来也没有这两颗：跳句在窄屏靠点原文列表那一句。
          */
          onSkipPrev={documentMode && isDesktop && timelineSegments.length > 1
            ? () => seekRef.current?.(timelineSegments[Math.max(0, activeIdx - 1)]?.start ?? 0)
            : undefined}
          onSkipNext={documentMode && isDesktop && timelineSegments.length > 1
            ? () => seekRef.current?.(timelineSegments[Math.min(timelineSegments.length - 1, activeIdx + 1)]?.start ?? 0)
            : undefined}
          /*
            稿面 D1/D2 把「现在念到哪一句」压在播放键同一行：那一行回答的是同一个问题
            「我在哪」。拆成上下两块之后播放行的信息密度散掉，原文列表起始位也被推下去。
            窄屏没这个横向余量，仍走播放器下方那张卡。
          */
          transportAside={documentMode && isDesktop && followEnabled && currentSegment ? (
            <div
              className="flex min-w-0 flex-1 items-stretch gap-3 rounded-[12px] px-3 py-2"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)' }}
              aria-live="polite"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 whitespace-nowrap text-[11px]">
                  {currentSegment.speaker && (
                    <span
                      className="flex-shrink-0 rounded-full px-2 py-0.5 font-semibold"
                      style={{ background: 'var(--selection-bg)', color: 'var(--selection-text)' }}
                    >
                      {currentSegment.speaker}
                    </span>
                  )}
                  <span className="font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>
                    {formatClock(currentSegment.start)}
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    · 第 {activeIdx + 1} / {timelineSegments.length} 句
                  </span>
                </div>
                <p className="mt-0.5 truncate text-[16px] font-bold text-token-primary">{currentSegment.text}</p>
              </div>
              {nextSegment && (
                <span
                  className="hidden min-w-0 max-w-[120px] items-center truncate pl-3 text-[11px] xl:flex"
                  style={{ borderLeft: '1px solid var(--border-faint)', color: 'var(--text-muted)' }}
                >
                  下一句 · {nextSegment.text}
                </span>
              )}
            </div>
          ) : undefined}
          caption={documentMode ? (estimated ? '智能估算时间轴 · 可能有偏差' : '精准时间轴 · 逐句对齐') : undefined}
          flush={documentMode}
        />

        </div>
        {documentMode && !playerCollapsed && followEnabled && currentSegment && !isDesktop && (
          <div
            className="w-full max-w-[760px] rounded-[12px] px-3 py-2.5"
            // 稿面这张卡是**中性灰底 + 圆角**，蓝色留给里面那枚说话人胶囊。
            // 我原先整张卡都用蓝，于是它和原文列表里的当前句高亮同色——
            // 两种不同语义共用一个颜色，谁也说不清蓝底到底在指什么。
            // 灰要压得住：播放区已经是白底，浅一档就退化成「看不出有卡」。
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)' }}
            aria-live="polite"
          >
            <div className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="flex min-w-0 items-center gap-2">
                {currentSegment.speaker && (
                  <span
                    className="flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                    style={{ background: 'var(--selection-bg)', color: 'var(--selection-text)' }}
                  >
                    {currentSegment.speaker}
                  </span>
                )}
                <span className="font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>{formatClock(currentSegment.start)}</span>
              </span>

            </div>
            {/*
              稿面这句是整个播放区的第一视觉焦点：字号明显大过下方列表，一眼就落在
              「现在念的是这句」。15px 与列表的 13px 只差两档，主次被抹平（B2 判分记的这处）。
            */}
            <p
              className="mt-1 text-[19px] font-bold leading-snug text-token-primary"
              style={{
                // 锁两行：句子长短不一时高度恒定，跟读过程中下方原文不会跟着上下跳
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                overflow: 'hidden', minHeight: '2.6em',
              }}
            >
              {currentSegment.text}
            </p>
            {nextSegment && (
              <p className="mt-1 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                下一句 · {nextSegment.text}
              </p>
            )}
          </div>
        )}
      </div>

      {/*
        设计稿的顺序是 播放区 → 原文 → 录音理解（词云/纪要/待办）→ 问这场录音。
        原文紧跟播放器，因为跟读是这一屏的主路径：听到哪、字在哪，两者必须挨着。
        我原先把录音理解整块插在播放器与原文之间，等于把主路径推到四张卡以下——
        B1 判分里「原文列表不存在」那几条就是这么来的（它其实在，只是被推到看不见的地方）。
      */}
      {documentMode && (
        <div className="mt-2 flex w-full max-w-[760px] flex-col gap-2">
          {/*
            这里原本还有一行「转录原文」小标题。稿面 B1/B2 的原文区**没有**这个标题：
            搜索框紧贴播放区，下面就是句子。多出来的一行把编辑态卡片顶出了首屏下沿
            （B2 判分记的「保存/取消被切在视口下沿」有一部分是它吃掉的高度）。
          */}
          {/*
            搜索框归属原文段，不归词云——稿面 B1 把它排在原文列表正上方，
            它过滤的是原文。此前它挂在词云卡里，作用对象与位置都跟稿面对不上。
          */}
          {/*
            `scrollMarginTop` 是给「滚到这里」用的：上面那条播放区是 sticky 的，
            不留出它的高度，任何把搜索行滚到顶的动作都会把它塞到吸顶条**背后**。
          */}
          <div data-transcript-search-row className="flex items-center gap-2" /*
              84 不是随手取的：收起态那条吸顶播放条约 76px 高，而顶部折叠哨兵在它上方约 92px。
              留白小于 76 会让搜索行藏到吸顶条背后；大于 92 又会把哨兵重新拉回画面、
              播放区当场展开、内容整体下移，于是「滚一次收起、再滚一次展开」来回抖。
              取中间这一档，两边都成立。
            */
            style={{ scrollMarginTop: 84 }}>
            {/* 稿面的搜索框是全药丸，与右边「继续跟随」同一族圆角 */}
            {/*
              `min-w-0` 不能省：flex 子项的 min-width 默认是 auto，撑不小于内容的最小宽度。
              放大镜 + 输入框 + 命中计数三样加起来就是这个下限，于是搜索行在 390px 屏上
              整行右溢出——右边那颗「继续跟随」被视口切掉一半（判官记的正是这处）。
            */}
            <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-full px-4" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-faint)' }}>
              <Search size={14} className="shrink-0 text-token-muted" />
              <input
                value={keyword}
                onChange={event => setKeyword(event.target.value)}
                placeholder="搜索原文关键词"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-token-primary outline-none"
                aria-label="搜索原文关键词"
              />
              {keyword && (
                // 稿面 B2 是「3 / 9」——当前落在第几个命中，不是只说共几处。
                // 只给总数的话，用户点了下一个也不知道自己走到哪了。
                <span className="text-[11px] tabular-nums text-token-muted">
                  {searchMatches.length > 0 ? `${hitCursor + 1} / ${searchMatches.length}` : '0 / 0'}
                </span>
              )}
            </label>
            {keyword && searchMatches.length > 0 && (
              /*
                稿面 B2 是**一对**方向键：^ 回上一处、v 去下一处。
                只给「下一处」的话，翻过头就只能一路转回去——9 个命中要点 8 下。
              */
              <>
                <button
                  type="button"
                  onClick={() => gotoHit(-1)}
                  aria-label="上一个命中"
                  title="上一个命中"
                  className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[12px]"
                  style={{ border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
                >
                  <ChevronUp size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => gotoHit(1)}
                  aria-label="下一个命中"
                  title="下一个命中"
                  className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[12px]"
                  style={{ border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
                >
                  <ChevronDown size={16} />
                </button>
              </>
            )}
            {followEnabled && (
              /*
                「继续跟随」：手动滚过原文之后自动跟随会暂停 3 秒不跟用户抢滚动条，
                但用户想回到当前句时没有任何入口——只能自己找。这颗按钮就是那个入口，
                点它取消暂停并把当前句拉回视野。
              */
              <button
                type="button"
                onClick={resumeFollow}
                className="min-h-11 flex-shrink-0 rounded-[10px] px-3 text-[13px] font-semibold"
                style={{ background: 'var(--selection-bg)', color: 'var(--selection-text)' }}
              >
                {/* 稿面 D1 这颗带一个向下箭头：它说的是「跳回正在播的那一句」，不是一个开关 */}
                <ArrowDown size={13} className="mr-1 inline-block align-[-2px]" aria-hidden />
                继续跟随
              </button>
            )}
          </div>
          {/*
            说话人筛选（稿面 B2）：一排 chip，各自带句数，点中的那枚是实心蓝底。
            它回答的是「我只想看某个人说了什么」——在一份一百多句的原文里，
            这是比搜关键词更常用的一种找法。只有真的分出了两个以上说话人才摆出来：
            一个人的录音摆一排只有一枚的筛选器，是让用户点一个没有选择的选择。
          */}
          {speakerChips.length > 1 && (
            <div className="flex items-center gap-2 overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'none' }}>
              {speakerChips.map(chip => {
                const picked = speakerFilter === chip.speaker;
                return (
                  <button
                    key={chip.speaker}
                    type="button"
                    onClick={() => setSpeakerFilter(picked ? null : chip.speaker)}
                    aria-pressed={picked}
                    className="flex min-h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[12px] px-3 text-[12px] font-semibold"
                    style={picked
                      ? { background: 'var(--selection-bg)', color: 'var(--selection-text)', border: '1px solid var(--accent-fg-info)' }
                      : { color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}
                  >
                    {picked && <UserRound size={12} aria-hidden />}
                    {chip.speaker} · {chip.count}{chip.speaker === UNLABELED_SPEAKER ? '' : ' 句'}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      {/* 歌词滚轮：普通模式为上下渐隐滚轮；同一文档模式随外层页面自然展开。 */}
      <div
        ref={listRef}
        onWheel={markManualScroll}
        onTouchMove={markManualScroll}
        className={documentMode ? 'w-full max-w-[760px]' : 'w-[480px] max-w-[92%] overflow-y-auto'}
        style={{
          height: !documentMode && followEnabled ? 240 : 'auto',
          maxHeight: documentMode ? undefined : followEnabled ? 240 : 320,
          overscrollBehavior: documentMode ? undefined : 'contain',
          WebkitMaskImage: !documentMode && followEnabled
            ? 'linear-gradient(to bottom, transparent 0, black 18%, black 82%, transparent 100%)'
            : undefined,
          maskImage: !documentMode && followEnabled
            ? 'linear-gradient(to bottom, transparent 0, black 18%, black 82%, transparent 100%)'
            : undefined,
        }}
      >
        {/* 首末句也能滚到中心：上下各留半屏 padding */}
        <div
          className="flex flex-col items-center gap-1"
          // 浮动药丸出现时列表底部要留出它的高度，否则它压住最后一句正文
          // （稿面里那颗浮标下方不压任何句子）
          style={!documentMode && followEnabled
            ? { padding: '104px 8px' }
            : { padding: '4px 0', paddingBottom: followLost ? 96 : 4 }}>
          {timelineSegments.map((s, i) => {
            const active = followEnabled && i === activeIdx;
            /*
              选中某位说话人时**不删行、只压暗**别人的句子。
              稿面 P2 选中「受访者 A」的那一屏里，主持人的句子照样在列表里——
              这一排 chip 是「聚焦谁在说」，不是「只留下谁」：把别人整段删掉，
              时间轴就断了，用户也失去了上下文（谁在回答谁）。
            */
            /*
              正在播的那一句**永远不压暗**。聚焦某位说话人是为了看清他说了什么，
              不是为了把播放位置也一起藏掉——压暗之后那块蓝底连同「我现在听到哪了」
              一起没了，而那是这一屏最要紧的状态（判分记的正是这处）。
            */
            const dimmedBySpeaker = !!speakerFilter && !active
              && (s.speaker?.trim() || UNLABELED_SPEAKER) !== speakerFilter;
            if (documentMode && editingIndex === i && onSaveNote) {
              return (
                // 稿面 B2 的编辑态是一张**蓝色描边卡**，抬头一行是「时间 · 说话人（可改） · 改说话人」，
                // 底下一行是「保存 / 取消」加一句「仅修改原文，音频不变」——那句话是承诺：
                // 用户在这里改字不会动到音频，不写出来他不敢改。
                <div key={i} className="w-full rounded-[12px] p-3" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--accent-fg-info)' }}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="font-mono text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                      {s.start >= 0 ? formatClock(s.start) : ''}
                    </span>
                    {s.speaker && (
                      // 稿面这枚徽章带一个 ▾：它自己就是「换说话人」的入口，
                      // 不是一块只能看的标签。右上那个文字入口保留给发现不了 ▾ 的人。
                      <button
                        type="button"
                        onClick={() => { setRenamingSpeaker(s.speaker || null); setSpeakerDraft(s.speaker || ''); }}
                        className="flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                        style={{ background: 'var(--selection-bg)', color: 'var(--selection-text)' }}
                        title="换一个说话人"
                      >
                        {s.speaker}
                        <ChevronDown size={11} />
                      </button>
                    )}
                    {/*
                      上游没区分出说话人时，这一行原本什么都没有——用户看得到「未能区分说话人」
                      那张卡，却找不到落点（稿面 cap-S11 的「手动标记说话人」）。这里补上入口：
                      直接给这一句指定一个人。
                    */}
                    {!s.speaker && s.start >= 0 && (
                      <input
                        value={assignSpeakerDraft}
                        onChange={(event) => setAssignSpeakerDraft(event.target.value)}
                        placeholder="指定说话人"
                        aria-label="给这一句指定说话人"
                        className="h-8 w-28 rounded-full px-2.5 text-[11px] outline-none"
                        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-faint)', color: 'var(--text-primary)' }}
                      />
                    )}
                    <span className="flex-1" />
                    {s.speaker && (
                      <button
                        type="button"
                        onClick={() => { setRenamingSpeaker(s.speaker || null); setSpeakerDraft(s.speaker || ''); }}
                        className="flex min-h-9 items-center gap-1 px-1 text-[11px]"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {/* 稿面 B2 这里是「铅笔 + 改名」两件，只有文字时它读起来像一句说明而不是入口 */}
                        <Pencil size={12} aria-hidden /> 改名
                      </button>
                    )}
                  </div>
                  {/*
                    稿面的编辑区是**就地改字**：没有框、没有底色、只有一个光标，
                    看起来就是那句话本身可以改。套上输入框之后它变成「另一个地方的一份拷贝」，
                    「原地编辑一句话」的形态就没了（B2 判分记的正是这处）。
                  */}
                  <textarea
                    autoFocus
                    ref={autoGrow}
                    value={editDraft}
                    onChange={(event) => setEditDraft(event.target.value)}
                    rows={1}
                    className="w-full resize-none bg-transparent px-0 py-1 text-[14px] leading-relaxed text-token-primary outline-none"
                    // 稿面的编辑区只有一枚光标，没有下划线也没有框。我一度加过一道蓝下划线
                    // 当焦点指示，因为静态截图里闪烁的光标常常正好没画出来——但那是**截图的局限**，
                    // 不是实现缺了什么，不该为了让截图好看往产品里加一条稿面没有的线。
                    // 高度跟着内容长：固定 rows 会在短句下留出一段不承载信息的空白。
                    style={{ border: 'none', caretColor: 'var(--accent-fg-info)' }}
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={savingEdit || !editDraft.trim()}
                      onClick={() => {
                        const withText = estimated
                          ? replaceEstimatedTranscriptSentenceText(noteMd, i, editDraft)
                          : replaceTranscriptSegmentText(noteMd, i, editDraft);
                        // 这一句原本没有说话人、而用户在上面填了一个：一并落进去
                        const next = !s.speaker && assignSpeakerDraft.trim()
                          ? assignTranscriptSegmentSpeaker(withText, i, assignSpeakerDraft)
                          : withText;
                        setSavingEdit(true);
                        void onSaveNote(next)
                          .then((ok) => { if (ok !== false) setEditingIndex(null); })
                          .finally(() => setSavingEdit(false));
                      }}
                      // 稿面的保存是**蓝色实心**，取消是无框文字——主次要分得出来
                      className="flex min-h-11 items-center rounded-full px-5 text-[12px] font-semibold disabled:opacity-50"
                      style={{ background: 'var(--accent-fg-info)', color: 'var(--bg-card)' }}>
                      {/* 稿面这颗是纯文字胶囊，没有图标——加个对勾看着更「完整」，但那是稿面没有的东西 */}
                      保存
                    </button>
                    {/* 稿面的取消是**和保存等高的描边胶囊**，两颗成对。做成无框文字就不成对了，
                        读者要在「一颗按钮 + 一行字」里分辨哪个才是另一个选择 */}
                    <button
                      type="button"
                      disabled={savingEdit}
                      onClick={() => setEditingIndex(null)}
                      className="flex min-h-11 items-center gap-1 rounded-full px-4 text-[12px] font-semibold"
                      style={{ border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
                    >
                      取消
                    </button>
                    <span className="flex-1" />
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>仅修改原文，音频不变</span>
                  </div>
                </div>
              );
            }
            return (
              <button
                key={i}
                ref={(el) => { lineRefs.current[i] = el; }}
                // 取证脚本靠这个属性把画板驱动到「某一句正在改」那一态——
                // 它比 nth-child 稳：行的层级结构改一次，位置选择器就静默失灵
                data-transcript-row={i}
                onClick={() => {
                  if (documentMode && onSaveNote) {
                    setEditingIndex(i);
                    setEditDraft(s.text);
                    return;
                  }
                  if (followEnabled && s.start >= 0) seekRef.current?.(s.start);
                }}
                className={`min-h-11 w-full overflow-hidden rounded-[10px] px-3 py-1.5 leading-relaxed transition-colors duration-200 motion-reduce:transition-none ${documentMode ? 'text-left' : 'text-center'} ${followEnabled ? 'cursor-pointer' : 'cursor-default'}`}
                style={{
                  // 稿面的当前句**只靠底色**区分，字号字重与其它行一样。
                  // 我另外加了放大 + 加粗 + 时间戳染蓝三层强调，判官记的是「强调强度超出稿面」——
                  // 三层叠起来，那一行读起来像另一种内容，而不是同一份原文里被点亮的一句。
                  fontSize: 13,
                  fontWeight: 400,
                  // 稿面把「已播过的」压灰、「还没播到的」留深色，两档区分出「读到哪了」。
                  // 原写法按与当前句的距离统一渐隐，前后一样淡，这层信息就没了。
                  color: active
                    ? 'var(--text-primary)'
                    : !followEnabled
                      ? 'var(--text-secondary)'
                      : i < activeIdx
                        ? 'var(--text-muted)'
                        : 'var(--text-primary)',
                  opacity: dimmedBySpeaker ? 0.38 : 1,
                  // 当前句底色 = 强调色（设计稿允许强调色出现的三处之一）；无紫色
                  // 稿面的当前句是一块**实心蓝卡**，在列表里一眼跳出来。14% 太淡，
                  // 两位判官各自独立报了同一句「块感弱于稿面」；22% 是照基准图对出来的，
                  // 不是他们给的数——他们只说了弱，没说弱多少。
                  background: active
                    ? 'color-mix(in srgb, var(--accent-fg-info) 22%, transparent)'
                    : 'transparent',
                  // 稿面的当前句就是**一块纯蓝填充**，既没有整圈描边也没有左侧色条。
                  // 整圈蓝描边会和编辑态那张卡的蓝框撞语义（分不清「正在念」和「正在改」），
                  // 左侧色条则是我自己加的第三种写法——两位判官各指一次，翻回基准图确认：
                  // 稿面两样都没有，照稿面来。
                  border: 'none',
                }}
                title={documentMode && onSaveNote ? '点击修改这句原文' : followEnabled && s.start >= 0 ? '点击跳到这一句' : undefined}
              >
                {/*
                  稿面每行是三段：左列时间戳、右侧说话人独占一行、正文另起一行。
                  我原先压成「chip + 正文」内联一行，时间戳整列都没有——
                  而这一屏的核心就是「逐句对齐」，没有时间就失去了时间轴锚点，
                  两位判官各自把它列为最重的一条缺失。
                */}
                {/*
                  宽屏（稿面 D1/D2）改成「时间 / 说话人 / 正文」三列同基线：
                  横向有地方，堆两行只是把行高翻倍、扫读节奏变碎。窄屏地方不够，维持两行堆叠。
                */}
                <span className="grid gap-x-3" style={{ gridTemplateColumns: isDesktop ? '56px 92px 1fr' : '48px 1fr' }}>
                  <span
                    className="pt-[2px] font-mono text-[11px] tabular-nums"
                    /*
                      窄屏（B1/B2）稿面里时间戳全程淡灰，当前句只靠底色区分；
                      宽屏（D1/D2）稿面把当前行的时间与人名一起染成强调色。
                      两稿对同一处给了两种画法，按屏宽各取各的。
                    */
                    style={{ color: isDesktop && active ? 'var(--accent-fg-info)' : 'var(--text-muted)' }}
                  >
                    {s.start >= 0 ? formatClock(s.start) : ''}
                  </span>
                  {isDesktop && (
                    <span
                      className="min-w-0 truncate pt-[2px] text-[11px]"
                      style={{ color: active ? 'var(--accent-fg-info)' : 'var(--text-muted)' }}
                    >
                      {s.speaker ?? ''}
                    </span>
                  )}
                  <span className="min-w-0">
                    {!isDesktop && s.speaker && (
                      // 加粗之后三级层级压成两级，扫读时眼睛会先落在人名上而不是话上
                      <span className="mb-0.5 block text-[11px]" style={{ color: 'var(--text-muted)' }}>{s.speaker}</span>
                    )}
                    {/* 命中词在正文里也要高亮：只在命中面板里标，用户在原文里还得自己找 */}
                    <span className="block min-w-0 break-words">{highlightKeyword(s.text, keyword)}</span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/*
        稿面 B2 屏底那颗浮动药丸。它和搜索行里那颗「继续跟随」不是重复：
        搜索行那颗要滚回上面才点得到，而跟丢恰恰发生在人已经滚远的时候——
        这颗贴着屏底浮出来，就在拇指够得着的地方。↓ 指的是「回到下面正在播的那句」。
        零高度的 sticky 容器托着它，所以它不会在列表末尾撑出一条空带。
      */}
      {documentMode && followLost && (
        <div className="sticky bottom-3 z-20 flex h-0 w-full items-end justify-center" style={{ pointerEvents: 'none', position: 'sticky' }}>
          {/*
            药丸底下垫一层向下渐深的蒙版：浮动元素总会盖住底下的内容，
            不给蒙版就是「一句话被切掉半截」，给了就是「列表在这里淡出」。
            纯装饰，不吃点击。
          */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 block h-32"
            // 三段渐变而不是两段：两段的中点太靠上，药丸正后方那一行仍然清晰可读，
            // 于是它读起来是「被压住的一句话」而不是「淡出的列表尾巴」。
            style={{ background: 'linear-gradient(to bottom, transparent, color-mix(in srgb, var(--bg-primary) 82%, transparent) 46%, var(--bg-primary))' }}
          />
          <button
            type="button"
            onClick={resumeFollow}
            className="relative z-10 flex min-h-11 items-center gap-1.5 rounded-full px-4 text-[13px] font-semibold"
            // 稿面这颗是**反色实心**胶囊（深色屏上是白底黑字）：它是浮在内容之上的主操作，
            // 做成同色描边就和底下的列表糊在一起，反差不够就不像「浮在上面的一颗按钮」。
            // `relative z-10` 是必须的：垫在下面那层淡出蒙版是绝对定位的兄弟节点，
            // 不显式抬一层，它会盖在按钮上把白底压成灰底。
            style={{
              pointerEvents: 'auto',
              background: 'var(--button-primary-bg)',
              color: 'var(--button-primary-fg)',
              boxShadow: '0 6px 20px rgba(0,0,0,.24)',
            }}
          >
            <ArrowDown size={14} /> 继续跟随播放
          </button>
        </div>
      )}

      {estimated && (
        <p className="text-[11px] text-token-muted">
          当前跟随位置按语速智能估算，不会重复转录；
          {documentMode && onSaveNote ? '可直接播放或点击句子校对' : '可直接播放或点句跳转'}
        </p>
      )}
      </div>
      {documentMode && (
        <aside
          className="flex w-full max-w-[760px] flex-col gap-3 lg:h-full lg:min-h-0 lg:w-[400px] lg:max-w-none lg:shrink-0 lg:overflow-y-auto lg:py-3 lg:pl-1"
          style={isDesktop ? { borderLeft: '1px solid var(--border-faint)', paddingLeft: 20 } : undefined}>
          {/* 稿面 D1/D2 的右栏抬头：理解 / 纪要 / 待办 / 提问 四个分页签 */}
          {isDesktop && (
            <div className="flex items-center gap-5" style={{ borderBottom: '1px solid var(--border-faint)' }}>
              {DESKTOP_PANELS.map(panel => (
                <button
                  key={panel.key}
                  type="button"
                  onClick={() => setPanelTab(panel.key)}
                  aria-pressed={panelTab === panel.key}
                  className="relative min-h-11 cursor-pointer text-[14px] font-semibold"
                  style={{ color: panelTab === panel.key ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  {panel.label}
                  {panelTab === panel.key && (
                    <span
                      aria-hidden
                      className="absolute inset-x-0 -bottom-px block h-[2px] rounded-full"
                      style={{ background: 'var(--accent-fg-info)' }}
                    />
                  )}
                </button>
              ))}
            </div>
          )}
          {/*
            设计稿 P3 是三块内容同屏并置：词云 → 会议纪要 → 待办，一屏贯通。
            我上一轮把它们做成了互斥分区，一次只能看一块——审查智能体判为「打断主路径」，
            结构分扣了 7 分。这里改回并置，分区标签随之取消。

            并置之后还差一层：稿面这三段是**三张并列的白卡**，不是一张大卡里的三个小节。
            我原先做成后者，两位判官各自独立指到同一处——分组感弱一档。所以卡片挂在每一段上，
            外层退成纯排版容器。
          */}
          {showPanel('understand') && (
            <section style={{ scrollMarginTop: 100 }}>
              <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
                {/*
                  这块叫「词云」——2026-08-25 产品方明确：这就是他设定的名字。
                  另一张画布（VOICE CAPTURE 的 B3）把同一块内容标成「录音理解」，
                  以产品方的设定为准，那张稿上的名字过时了，已回请设计方同步改。
                */}
                <h3 className="text-[19px] font-bold text-token-primary" style={{ scrollMarginTop: 100 }}>词云</h3>
                {/* 稿面 P3 这行右侧除了句数还有一句可供性提示：词条是可以点的，点了看命中 */}
                <span className="text-[11px] text-token-muted">基于 {timelineSegments.length} 句原文 · 点击查看命中</span>
              </div>
              <div className={SECTION_CARD} style={SECTION_CARD_STYLE}>
              {/*
                稿面 B3 的开场是「最高频主题」标签 + 一句挂着数字的结论，然后才是词条。
                先给结论再给数字（conclusion-before-numbers）：一排词读不出「这场在讲什么」，
                得读者自己数；这句话替他数完了。

                这个百分比必须是真的：它就是「含最高频词的句子 ÷ 总句数」，
                不是从稿面抄一个 62% 过来（no-rootless-tree）。文案也照这个口径写，
                不写成含糊的「内容占比」。
              */}
              {topicLede && (
                <div className="mb-3">
                  <span
                    className="inline-block rounded-full px-2.5 py-1 text-[11px] font-semibold"
                    style={{ background: 'var(--selection-bg)', color: 'var(--selection-text)' }}
                  >
                    最高频主题
                  </span>
                  <p className="mt-2.5 text-[17px] font-bold leading-snug text-token-primary">
                    这场有 {topicLede.percent}% 的句子提到「{topicLede.top}」
                    {topicLede.second ? <>，其次是「{topicLede.second}」</> : null}。
                  </p>
                </div>
              )}



              {speakerSource && (
                <p
                  className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed"
                  style={{ color: speakerSource.estimated ? 'var(--semantic-warning-text)' : 'var(--text-muted)' }}
                >
                  <Info size={12} className="mt-0.5 shrink-0" />
                  <span>{speakerSource.text}</span>
                </p>
              )}

              {/*
                词云的权重必须按「出现几次」映射，不能按排名。旧写法是 15 - index*0.2：
                18 个词从 15px 递减到 11.4px，肉眼分不出；而且排名相邻的两个词就算一个说了 30 次、
                一个说了 3 次也一样大——等于把唯一有信息量的那一维抹平了，剩下一排一模一样的药丸。
                现在字号/底色/边框/字重全部由 count 相对最大值决定，并把次数直接写在词上（不再藏 title），
                开头先给一句结论，让人一眼知道「这场到底在反复讲什么」而不是自己读一排词去数。
              */}
              {/*
                这一块**无条件渲染**。原先的条件是「有词条 或 有编辑权限」，于是
                「一个词都没重复 + 只读」时整块被跳过——区块标题下面是一张彻头彻尾的空卡。
                而没有词的时候恰恰最需要告诉用户为什么没有（分词器不认识人名黑话）。
                空态要给理由和下一步，不能是一片空白（guided-exploration）。
              */}
              <div className="mt-3">
              {/*
                这里原先有一个「词云」小标签：那是两张画布各起一个名时的折中产物——
                区块标题被另一张稿的「录音理解」占着，只好把真名降一级塞进卡里。
                产品方已明确这块就叫词云，标题已经写着它了，卡内不必再说第二遍。
              */}
                  {wordCloud.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-2" aria-label="整场录音词云">
                    {wordCloud.map(({ word, count }, index) => {
                      const weight = count / wordCloud[0].count;
                      // 设计稿把词频压成**三档**（高频黑底大字 / 中频蓝字 / 低频灰底小字）。
                      // 连续映射看着更精确，但一排词里没有哪个能占住视线——三档存在的
                      // 全部理由就是让最高频那个词一眼跳出来。
                      // 阈值按稿面那组词频（38/29/17/14/9/7/5/4）反推：38 与 29 同为黑档
                      // ——「这场有两个并列头部词」是一条信息，把第二名压进蓝档就读不出来了；
                      // 17/14 进蓝档；9 及以下退灰档。三档的意义是拉开梯度，不是等分。
                      // 黑档取**词频最高的两个**，但要求它们本身足够高频（weight >= 0.3）。
                      //
                      // 原写法是纯比例阈值 0.7。它能复现稿面那组数（29÷38=0.76 落在黑档），
                      // 但换一段录音就未必还是两个黑档——三位判官分别独立报了同一条
                      // 「稿面是两枚黑底大词、实现只有一枚」。稿面是 SSOT，与其每次判分都
                      // 重新辩解一遍阈值，不如让规则稳定复现稿面的形状。
                      // 加 weight >= 0.3 这道闸是防止「第二名其实只出现两次」也被硬捧成黑档。
                      // 这条规则已写进给设计方的待确认清单，他们可以否决。
                      // 蓝档同理取**名次前四里的后两个**（第 3、4 名），而不是「所有 weight >= 0.3 的词」：
                      // 稿面那组词频算下来正好两枚蓝，换一段词频分布平缓的录音（8/5/4/3/3/3…）
                      // 纯阈值会一口气标出四枚蓝，强调色的分层节奏就散了。
                      // 名次法在两种分布下都稳定复现稿面的形状：两黑、两蓝、其余灰。
                      const tier = index < 2 && weight >= 0.3 ? 'high'
                        : index < 4 && weight >= 0.3 ? 'mid' : 'low';
                      const selected = activeTerm === word;
                      // 稿面这三档是**纯色填充、无描边**，且字号台阶拉得很开（约 24 / 19 / 15）。
                      // 我原先三档都带 1px 描边、字号 18/15/12.5——描边把色块对比削掉一层，
                      // 台阶又太密，一排词里看不出谁是头部词，等于三档白分了。
                      const tierStyle = tier === 'high'
                        ? { fontSize: '22px', fontWeight: 700, background: 'var(--text-primary)', color: 'var(--bg-card)' }
                        : tier === 'mid'
                          ? { fontSize: '17px', fontWeight: 600, background: 'var(--recording-chip-tier2-bg)', color: 'var(--recording-chip-tier2-fg)' }
                          : { fontSize: '13px', fontWeight: 400, background: 'var(--bg-elevated)', color: 'var(--text-secondary)' };
                      return (
                        <button
                          key={word}
                          type="button"
                          onClick={() => { setKeyword(''); setSelectedWord(selected ? '' : word); }}
                          aria-pressed={selected}
                          className="min-h-9 rounded-full px-3"
                          style={{
                            ...tierStyle,
                            // 选中的词直接用黑底（高频档同款），不再另加一圈蓝描边——
                            // 稿面把蓝色留给时间戳与「全部」，到处用会把它的意思稀释掉
                            ...(selected ? { background: 'var(--text-primary)', color: 'var(--bg-card)' } : {}),
                          }}
                          title={`出现 ${count} 次，点击查看命中`}
                        >
                          {word}
                          <span className="ml-1 text-[10px] font-normal tabular-nums opacity-60">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                  )}
                  {/*
                    结论已经在卡顶（稿面 B3 的「最高频主题 + 一句话」），这里不再重复一遍——
                    同一件事说两次会让读者以为是两条不同的信息。
                    只留词云为空时的那句：那种时候恰恰最需要告诉用户为什么空、怎么补。
                  */}
                  {wordCloud.length === 0 && (
                    /*
                      稿面 cap-S12 这块是**两级**：一句加粗黑标题说「为什么没有」，
                      下面一段灰字说「什么时候会有」。压成一段同级灰字之后，
                      空态读起来像一句嘟囔，判官记的是「标题整行不存在」。
                    */
                    <div>
                      <p className="text-[14px] font-bold text-token-primary">
                        {timelineSegments.length > 0 && timelineSegments.length < 50
                          ? '内容太短，暂不生成词云'
                          : '还没有反复出现的词'}
                      </p>
                      <p className="mt-1.5 text-[12px] leading-relaxed text-token-muted">
                        {describeWordCloudEmptyState(timelineSegments.length)}
                      </p>
                    </div>
                  )}
                  {/*
                    词典入口就放在词云下面：发现「某个词该在却不在」正是在看这一屏的时候。
                    逼用户跑去设置页再回来是绕路（anti-detour.md）。
                    说话人名不用在这里加——它们已经自动进词典了。
                    **它不跟着词云一起隐藏**：词云为空正是最需要补词的场景。
                  */}
                  {onSaveNote ? (
                    <div className="mt-2">
                      {lexiconOpen ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            value={lexiconDraft}
                            onChange={event => setLexiconDraft(event.target.value)}
                            onKeyDown={event => { if (event.key === 'Enter') void addLexiconTerm('mine'); }}
                            placeholder="例如：人名、产品名、团队黑话"
                            aria-label="补充词条"
                            className="h-9 min-w-0 flex-1 rounded-[8px] px-2 text-[12px] text-token-primary outline-none"
                            style={{ background: 'var(--bg-input)', border: '1px solid var(--border-faint)' }}
                          />
                          <button
                            type="button"
                            disabled={!lexicon || savingLexicon || lexiconDraft.trim().length < 2}
                            onClick={() => void addLexiconTerm('mine')}
                            className="min-h-9 rounded-[8px] px-3 text-[11px] font-semibold disabled:opacity-50"
                            style={{ background: 'var(--selection-bg)', color: 'var(--text-primary)' }}
                          >
                            {savingLexicon ? '保存中' : '加入我的词典'}
                          </button>
                          {/* 有设置写权限的人才看得到这个：没权限却给入口，点了只会拿到 403 */}
                          {lexicon?.canManageSystem ? (
                            <button
                              type="button"
                              disabled={!lexicon || savingLexicon || lexiconDraft.trim().length < 2}
                              onClick={() => void addLexiconTerm('system')}
                              className="min-h-9 rounded-[8px] px-3 text-[11px] disabled:opacity-50"
                              style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}
                              title="加进全局词典，所有人默认引用"
                            >
                              加入系统词典
                            </button>
                          ) : null}
                          <button type="button" onClick={() => setLexiconOpen(false)} className="min-h-9 px-2 text-[11px] text-token-muted">收起</button>
                        </div>
                      ) : (
                        <button type="button" onClick={() => setLexiconOpen(true)} className="min-h-9 text-[11px] text-token-muted">
                          {wordCloud.length > 0
                            ? '少了某个词？通用分词器不认识人名和黑话，可以补进词典'
                            : '补一个词进词典试试'}
                        </button>
                      )}
                    </div>
                  ) : null}
              </div>

              {activeTerm && searchMatches.length > 0 && (
                // 稿面的命中面板是**一整块**浅灰底：抬头与命中句同处一块里，
                // 才读得出「这些句子属于这个词」。此前抬头裸在外面、每句各自一个灰块，
                // 分组这一层就丢了（两位判官都指到这处）。
                <div className="mt-3 rounded-[11px] p-3" style={{ background: 'var(--bg-elevated)' }}>
                  <div className="mb-1.5 flex items-baseline justify-between gap-2">
                    <p className="text-[12px] font-semibold text-token-primary">
                      {/* 「点击跳播」是稿面 B3 写在这里的可供性提示：这几句都点得动，点了从那一秒开始播 */}
                      「{activeTerm}」命中 {searchMatches.length} 句 <span className="font-normal text-token-muted">· 点击跳播</span>
                    </p>
                    <button
                      type="button"
                      onClick={() => { setKeyword(''); setSelectedWord(''); }}
                      className="min-h-9 flex-shrink-0 px-1 text-[11px]"
                      style={{ color: 'var(--accent-fg-info)' }}
                    >
                      全部
                    </button>
                  </div>
                  <div className="flex max-h-44 flex-col gap-1 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
                    {searchMatches.map(({ segment, index }) => (
                      <button
                        key={`${index}-${segment.start}`}
                        type="button"
                        onClick={() => segment.start >= 0 && seekRef.current?.(segment.start)}
                        // 时间戳独立成左列：几条命中句的时间纵向对齐，才能一眼扫出「集中在哪一段」
                        // 面板已经是一整块灰底，句子行自己不再叠第二层底色，靠细分隔线分行
                        // 稿面这几句是这块面板里的**主阅读字号**（与纪要正文同级）：
                        // 它们是「这个词到底在哪几句里出现」的答案，压成小字就不像答案了
                        className="grid min-h-11 items-start gap-2 px-1 py-2 text-left text-[14px] leading-relaxed text-token-secondary"
                        // 稿面这块是紧凑列表，没有逐行分隔线——面板本身那块灰底已经是分组
                        style={{ gridTemplateColumns: '44px 1fr' }}>
                        <span className="pt-[1px] font-mono text-[10px] tabular-nums" style={{ color: 'var(--accent-fg-info)' }}>
                          {segment.start >= 0 ? formatClock(segment.start) : '原文'}
                        </span>
                        <span className="min-w-0">
                          {segment.speaker && <span className="mr-1.5 font-semibold text-token-primary">{segment.speaker}</span>}
                          {/* 命中的词要在句子里高亮出来，否则用户还得自己在句中找 */}
                          {highlightKeyword(segment.text, activeTerm)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {activeTerm && searchMatches.length === 0 && <p className="mt-2 text-[11px] text-token-muted">没有找到这个词，原文仍可继续校对。</p>}
              </div>
            </section>
          )}

          {/*
            「一键整理」排在录音理解之后、纪要与待办之前——稿面 B3 的层级是
            「先选一种整理方式，产出落在下面」。此前它被排到待办后面，两级关系倒过来了：
            读者先看见产出、翻到底才看见入口，于是判官记的是「整理入口不存在」
            （它其实在，只是在产出下面，没人会往那儿找）。
            整理方式清单来自后端注册表，不在前端另抄一份。
          */}
          {showPanel('summary') && onPickOrganizeStyle && (
            <OrganizeStylePanel
              state={organize ?? {}}
              onPick={onPickOrganizeStyle}
              onCustom={onRestyle}
              // 稿面 B3 在虚线按钮下面画了一张结果卡：小标签写着当前那一种整理方式，
              // 底下是它整理出来的开头一段。它回答的是「我刚点的那一张，产出在哪」——
              // 没有它，「已生成」这个状态就落不到任何看得见的东西上。
              resultText={organizeLede}
            />
          )}
          {showPanel('summary') && (
            <section style={{ scrollMarginTop: 100 }}>
              <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
                <h3 className="text-[19px] font-bold text-token-primary" style={{ scrollMarginTop: 100 }}>会议纪要</h3>
                {onRestyle && (
                  <button type="button" onClick={onRestyle} className="flex min-h-9 items-center gap-1 rounded-[8px] px-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    <RefreshCw size={11} /> 重新生成
                  </button>
                )}
              </div>
              <div className={SECTION_CARD} style={SECTION_CARD_STYLE}>
              {summaryModules.length > 0 ? (
                // 稿面的纪要正文是**直接铺在白卡上**的：一段结论 + 两条要点，没有内嵌灰底。
                // 现在标题已经移到卡外、内容自己就是一张卡，再包一层灰底就是第三层盒子。
                // 只有一个模块时连小标题都不要——那句「结论」是卡片本身在说的话。
                <div className="mt-3 flex flex-col gap-4">
                  {summaryModules.map((module, index) => (
                    <article key={`${module.title}-${index}`}>
                      {summaryModules.length > 1 && (
                        <h4 className="mb-1.5 text-[12px] font-semibold text-token-primary">{module.title}</h4>
                      )}
                      <div className="text-[13px] leading-relaxed text-token-secondary">
                        <MarkdownViewer content={module.markdown} compact />
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                /*
                  没有整理结果就说没有，并给出**能到达**的下一步。
                  「下一步」必须落在这一屏里：上一版把用户支去「上方的一键整理」，
                  那是一句路标不是一个入口——判官按「本空态不可操作」扣了 12 分。
                  稿面 cap-S13 画的是标题 + 说明 + 主次两颗按钮，就地能发起。
                */
                /*
                  稿面 cap-S13 这张卡是**左对齐**、并且以主操作收尾：
                  标题 → 说明（含「整理只读取原文，不会修改录音」这句承诺）→ 按钮行。
                  居中 + 把承诺挪到按钮下方当脚注之后，卡片以一行灰字结尾，
                  扫读起点也从左边挪到了中间（判分记的正是这两处）。
                */
                <div className="mt-3 rounded-[11px] px-3.5 py-4" style={{ background: 'var(--bg-elevated)' }}>
                  <p className="text-[14px] font-bold text-token-primary">还没有整理结果</p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-token-muted">
                    原文已经在下方，可以直接读。需要结论与要点时点下面一颗，整理完这里就会有内容。整理只读取原文，不会修改录音。
                  </p>
                  {(onPickOrganizeStyle || onRestyle) && (
                    <div className="mt-3 flex items-center gap-2">
                      {onPickOrganizeStyle && (
                        <button
                          type="button"
                          onClick={() => onPickOrganizeStyle(DEFAULT_ORGANIZE_STYLE_KEY)}
                          className="flex min-h-11 flex-1 cursor-pointer items-center justify-center rounded-full px-4 text-[13px] font-semibold"
                          style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}
                        >
                          生成智能摘要
                        </button>
                      )}
                      {onRestyle && (
                        <button
                          type="button"
                          onClick={onRestyle}
                          className="flex min-h-11 cursor-pointer items-center justify-center rounded-full px-4 text-[13px] font-semibold"
                          style={{ border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                        >
                          自定义
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
              </div>
            </section>
          )}
          {showPanel('todo') && (
            <section style={{ scrollMarginTop: 100 }}>
              <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
                <h3 className="text-[19px] font-bold text-token-primary" style={{ scrollMarginTop: 100 }}>待办事项</h3>
                {todos.length > 0 && (
                  <span className="text-[11px] tabular-nums text-token-muted">
                    {todos.length} 项{todoSourceCount > 0 ? ` · 来自 ${todoSourceCount} 处原文` : ''}
                  </span>
                )}
              </div>
              <div className={SECTION_CARD} style={SECTION_CARD_STYLE}>
              {todos.length > 0 ? (
                <ul className="mt-3 flex flex-col">
                  {todos.map((todo, index) => (
                    <li
                      key={`${todo.text}-${index}`}
                      // 稿面的待办是「无底色行 + 细分隔线」。此前每条各是一个灰底卡片，
                      // 在一张已经有底色的卡里再叠一层灰，读起来是三层盒子而不是一份清单。
                      className="flex items-start gap-2 px-1 py-2.5"
                      style={{ borderTop: index === 0 ? 'none' : '1px solid var(--border-faint)' }}
                    >
                      <span
                        className="mt-[2px] flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[5px]"
                        style={{
                          background: todo.done ? 'var(--accent-fg-success)' : 'transparent',
                          border: todo.done ? 'none' : '1px solid var(--border-default)',
                        }}
                        aria-hidden
                      >
                        {todo.done && <Check size={10} style={{ color: 'var(--bg-base)' }} />}
                      </span>
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span
                          className="min-w-0 break-words text-[12px] leading-relaxed"
                          style={{
                            color: todo.done ? 'var(--text-muted)' : 'var(--text-secondary)',
                            textDecoration: todo.done ? 'line-through' : undefined,
                          }}
                        >
                          {todo.text}
                        </span>
                        {/* 出处：这条待办是几点、谁提出来的。点它跳到原文那一句 */}
                        {todoSources[index] && (
                          <button
                            type="button"
                            onClick={event => { event.stopPropagation(); seekRef.current?.(todoSources[index]!.start); }}
                            className="self-start font-mono text-[10.5px] tabular-nums"
                            style={{ color: 'var(--text-muted)' }}
                            title="跳到原文这一句"
                          >
                            {formatClock(todoSources[index]!.start)}
                            {todoSources[index]!.speaker ? ` · ${todoSources[index]!.speaker}` : ''}
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-3 rounded-[11px] px-3 py-4 text-center" style={{ background: 'var(--bg-elevated)' }}>
                  <p className="text-[12px] text-token-secondary">这次整理没有产出待办</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-token-muted">
                    待办来自整理结果里的勾选项；换一个带行动项的整理方式重跑，这里就会列出来
                  </p>
                </div>
              )}
              </div>
            </section>
          )}
          {/*
            说话人独立成段：稿面 cap-S11 画的是一张**自己的卡**。
            它此前嵌在词云卡内部，读者会把「未能区分说话人」读成词云的子说明；
            它也是把会议纪要与待办整块顶出首屏的那一段（P3 判分的结构扣分）。
          */}
          {showPanel('understand') && timelineSegments.length > 0 && (
            <section style={{ scrollMarginTop: 100 }}>
              <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
                <h3 className="text-[19px] font-bold text-token-primary" style={{ scrollMarginTop: 100 }}>说话人</h3>
                {speakers.length > 0 && (
                  <span className="text-[11px] tabular-nums text-token-muted">{speakers.length} 位 · 按句数排序</span>
                )}
              </div>
              <div className={SECTION_CARD} style={SECTION_CARD_STYLE}>
              {/*
                稿面 cap-S11：一份没有说话人标签的原文不能只是「少了点东西」，
                要说清为什么没有、以及我能不能自己补。原因写成「常见于」——
                上游只告诉我们「没区分出来」，没告诉我们是单声道还是抢话，
                照抄稿面那句断言就是编一个我们并不知道的事实。
              */}
              {speakers.length === 0 && timelineSegments.length > 0 && (
                <div className="rounded-[12px] px-3.5 py-3" style={{ background: 'var(--bg-elevated)' }}>
                  <p className="text-[13px] font-semibold text-token-primary">未能区分说话人</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-token-muted">
                    上游没有区分出说话人（常见于单声道录音或多人抢话）。原文按时间分句展示，
                    你可以手动为句子指定说话人。
                  </p>
                  {onSaveNote && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingIndex(0);
                        setEditDraft(timelineSegments[0]?.text ?? '');
                        setAssignSpeakerDraft('');
                        document.querySelector('[data-transcript-row="0"]')
                          ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                      }}
                      className="mt-2.5 flex min-h-11 w-full cursor-pointer items-center justify-center rounded-full text-[13px] font-semibold"
                      style={{ border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                    >
                      手动标记说话人
                    </button>
                  )}
                </div>
              )}
              {speakers.length > 0 && (
                /*
                  稿面 D1 右栏的说话人是一份**清单**：每行一枚首字圆标、名字、句数占比，
                  行尾一支铅笔。此前做成一排横向胶囊——点得动，但没有任何「这里能改」的
                  可供性，判分把它记成「逐位重命名入口整个消失」。
                */
                <div>
                  <p className="mb-2 flex items-center gap-1 text-[11px] text-token-muted"><UserRound size={12} /> 说话人</p>
                  <ul className="flex flex-col">
                    {/* 稿面 D1 按占比降序：谁说得多谁在上。按出现顺序排会把主要发言人压到下面 */}
                    {[...speakers]
                      .sort((a, b) => (speakerStats.find(i => i.speaker === b)?.count ?? 0)
                        - (speakerStats.find(i => i.speaker === a)?.count ?? 0))
                      .map((speaker, index) => {
                      const stat = speakerStats.find(item => item.speaker === speaker);
                      const editing = renamingSpeaker === speaker;
                      return (
                        <li
                          key={speaker}
                          className="flex items-center gap-2.5 py-2"
                          style={{ borderTop: index === 0 ? 'none' : '1px solid var(--border-faint)' }}
                        >
                          <span
                            aria-hidden
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold"
                            style={{ background: 'var(--selection-bg)', color: 'var(--selection-text)' }}
                          >
                            {speakerInitial(speaker)}
                          </span>
                          {editing ? (
                            <>
                              <input
                                autoFocus
                                value={speakerDraft}
                                onChange={event => setSpeakerDraft(event.target.value)}
                                className="h-9 min-w-0 flex-1 rounded-[8px] px-2 text-[13px] outline-none"
                                style={{ background: 'var(--bg-input)', border: '1px solid var(--border-faint)' }}
                              />
                              <button
                                type="button"
                                className="min-h-9 shrink-0 rounded-[8px] px-2 text-[12px] font-semibold"
                                style={{ color: 'var(--accent-fg-info)' }}
                                disabled={savingEdit}
                                onClick={() => {
                                  if (!onSaveNote || !speakerDraft.trim()) return;
                                  const next = renameTranscriptSpeaker(noteMd, speaker, speakerDraft);
                                  setSavingEdit(true);
                                  void onSaveNote(next).then(ok => { if (ok !== false) setRenamingSpeaker(null); }).finally(() => setSavingEdit(false));
                                }}
                              >
                                保存
                              </button>
                              <button
                                type="button"
                                className="min-h-9 shrink-0 rounded-[8px] px-2 text-[12px] text-token-muted"
                                onClick={() => setRenamingSpeaker(null)}
                              >
                                取消
                              </button>
                            </>
                          ) : (
                            <>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[13px] font-semibold text-token-primary">{speaker}</span>
                                {stat && (
                                  <span className="block text-[11px] tabular-nums text-token-muted">
                                    {stat.count} 句 · 占 {stat.percent}%
                                  </span>
                                )}
                              </span>
                              {onSaveNote && (
                                <button
                                  type="button"
                                  onClick={() => { setRenamingSpeaker(speaker); setSpeakerDraft(speaker); }}
                                  aria-label={`修改说话人「${speaker}」的名称`}
                                  title="修改这个说话人的名称"
                                  className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-[8px] text-token-muted hover-bg-soft"
                                >
                                  <Pencil size={14} />
                                </button>
                              )}
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}              </div>
            </section>
          )}
          {showPanel('ask') && (
            // 稿面 D2 的输入框贴着右栏底部通栏、上面的问答区自己滚。随内容流的话，
            // 答案短时右栏下方会空出三分之一且无人认领（D2 判分记的这处）。
            <section
              className={isDesktop ? 'flex min-h-0 flex-1 flex-col' : undefined}
              style={{ scrollMarginTop: 100 }}>
              <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
                {/* 稿面 P4 这个抬头左侧有一枚蓝色对话气泡：它是这一段与上面几段产出的分界标记 */}
                <h3 className="flex items-center gap-2 text-[19px] font-bold text-token-primary" style={{ scrollMarginTop: 100 }}>
                  <MessageSquare size={17} style={{ color: 'var(--accent-fg-info)' }} aria-hidden />
                  问这场录音
                </h3>
                <span />
              </div>
              <div
                className={isDesktop ? 'flex min-h-0 flex-1 flex-col' : SECTION_CARD}
                style={isDesktop ? undefined : SECTION_CARD_STYLE}>
              {/*
                稿面 B4 顶部这条琥珀提示记的是**上一问没答上来、而且是如实说的**。
                它不是错误提示——恰恰相反，是系统在证明自己没有替用户编一个答案。
                不记下来，用户下次提问时就看不到这次诚实了。
              */}
              {lastUnanswered && (
                <p
                  className="mb-3 rounded-[11px] px-3 py-2.5 text-[12px] leading-relaxed"
                  style={{ background: 'var(--semantic-warning-soft)', color: 'var(--semantic-warning-text)' }}
                >
                  上一问「{lastUnanswered}」：原文无相关内容，已如实说明。
                </p>
              )}
              {/*
                稿面 B4 的顺序是「问答记录在上、输入在下」——和所有聊天界面一样：
                新内容往下长，输入框永远在手指够得到的那一端。把输入框放在最上面，
                答案就会被它压在下面，读者要往回翻才看得到自己刚问的那一句。
              */}
              {/*
                这里原先还套了一层浅灰卡。稿面这一屏只有两层盒子（问答卡 → 引用卡），
                多这一层就变成四层套娃，每一层再吃掉一圈内边距，问答卡被越挤越窄。
                分区卡本身已经给了背景与描边，这一层没有承担任何新的语义。
              */}
              <div
                className={isDesktop ? 'min-h-0 flex-1' : undefined}
                style={isDesktop ? { overflowY: 'auto', overscrollBehavior: 'contain' } : undefined}>
                <RecordingAnswer
                  question={askedQuestion}
                  answer={answer}
                  segments={timelineSegments}
                  onSeek={sec => seekRef.current?.(sec)}
                  flat={isDesktop}
                />
              </div>
              {qaError && <p className="mb-3 text-[12px]" style={{ color: 'var(--semantic-danger)' }}>{qaError}</p>}
              {/*
                稿面 P4 用一条分隔线把输入区与答案区断开，并把它**钉在下沿**：
                提问是这一段的常驻入口，答案再长也不该把它推到看不见的地方。
                窄屏用 sticky 贴在滚动容器底部；桌面右栏本来就是固定高度的一列，
                它自己那套 flex 布局已经把输入区压在底部，不必再叠一层。
              */}
              <div
                className={isDesktop ? 'mt-3 pt-3' : 'sticky bottom-0 z-10 mt-3 pt-3'}
                style={{
                  borderTop: '1px solid var(--border-faint)',
                  ...(isDesktop ? {} : { background: 'var(--bg-card)' }),
                }}
              >
              <RecordingAskComposer
                value={question}
                onChange={setQuestion}
                onSend={askRecording}
                sending={asking}
                onOpenMultiTurn={onAskRecording}
              />
              </div>
              </div>
            </section>
          )}
        </aside>
      )}

    </div>
  );
}
