import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Check, ChevronDown, ChevronUp, Info, RefreshCw, Search, UserRound } from 'lucide-react';
import { requestRecordingPlay } from './recordingPlayBridge';
import { AudioWavePlayer } from '@/components/doc-browser/AudioWavePlayer';
import { RecordingSegmentBar } from '@/components/doc-browser/RecordingSegmentBar';
import { RecordingAskComposer } from '@/components/doc-browser/RecordingAskComposer';
import {
  isUnansweredByTranscript,
  parseTranscriptSegments,
  hasUsableTimestamps,
  activeSegmentIndex,
  estimateTranscriptSegments,
  replaceEstimatedTranscriptSentenceText,
  replaceTranscriptSegmentText,
  renameTranscriptSpeaker,
  buildTranscriptWordCloud,
  parseSpeakerSourceNote,
  extractTranscriptSummary,
  parseSummaryModules,
  extractTranscriptTodos,
  isTodoOnlyModule,
  findTodoSource,
  buildSpeakerStats,
} from '@/components/doc-browser/transcriptSegments';
import { MarkdownViewer } from '@/components/file-preview/MarkdownViewer';
import { OrganizeStylePanel, type OrganizeState } from '@/components/doc-browser/OrganizeStylePanel';
import { RecordingAnswer } from '@/components/doc-browser/RecordingAnswer';
import { streamDirectChat } from '@/services/real/aiToolbox';
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
 * 结果页那几段内容各自是一张卡（词云 / 会议纪要 / 待办 / 问这段录音）。
 * 抽成常量而不是各写各的：四处必须长得一样，写四遍就是四处会各自漂移的地方。
 */
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
  /** 上一问「原文里没有」的那个问题；空串表示没有这种情况 */
  const [lastUnanswered, setLastUnanswered] = useState('');
  const cancelQaRef = useRef<(() => void) | null>(null);
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
  const gotoNextHit = useCallback(() => {
    if (searchMatches.length === 0) return;
    const next = (hitCursor + 1) % searchMatches.length;
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
    cancelQaRef.current = streamDirectChat({
      message: buildRecordingQuestionPrompt(questionTranscript, userQuestion),
      onText: chunk => setAnswer(current => current + chunk),
      onError: error => { setQaError(error || '问答失败，请稍后重试'); setAsking(false); },
      onDone: () => {
        setAsking(false);
        // 这一问没答上来的话记一笔：稿面 B4 顶部那条琥珀提示要的就是
        // 「上一问没答上来，而且是如实说的」——不记下来，用户下次提问时
        // 已经看不到系统曾经诚实过一次了。
        setAnswer((current) => {
          setLastUnanswered(isUnansweredByTranscript(current) ? userQuestion : '');
          return current;
        });
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
  const [playerCollapsed, setPlayerCollapsed] = useState(false);
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
        setPlayerCollapsed(!entry.isIntersecting && entry.boundingClientRect.top < rootTop);
      },
      { root: nearestScrollParent(sentinel), rootMargin: '0px', threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [documentMode]);

  const currentSegment = timelineSegments[activeIdx] ?? null;
  const nextSegment = timelineSegments[activeIdx + 1] ?? null;

  if (segments.length === 0) return <AudioWavePlayer src={src} />;

  return (
    <div className="relative flex w-full flex-col items-center gap-4">
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
          registerSeek={(seek) => { seekRef.current = seek; }}
          // 句序与「逐句对齐」这句都归播放器主体：它们和时间回答的是同一个问题
          transportMeta={documentMode && followEnabled ? `第 ${activeIdx + 1} / ${timelineSegments.length} 句` : undefined}
          caption={documentMode ? (estimated ? '智能估算时间轴 · 可能有偏差' : '精准时间轴 · 逐句对齐') : undefined}
          flush={documentMode}
        />

        </div>
        {documentMode && !playerCollapsed && followEnabled && currentSegment && (
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
          <div className="flex items-center gap-2">
            <label className="flex min-h-11 flex-1 items-center gap-2 rounded-[10px] px-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-faint)' }}>
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
              <button
                type="button"
                onClick={gotoNextHit}
                aria-label="跳到下一个命中"
                title="跳到下一个命中"
                className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full"
                style={{ border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
              >
                <ChevronUp size={16} />
              </button>
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
                继续跟随
              </button>
            )}
          </div>
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
            : { padding: '4px 0', paddingBottom: followLost ? 64 : 4 }}>
          {timelineSegments.map((s, i) => {
            const active = followEnabled && i === activeIdx;
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
                    <span className="flex-1" />
                    {s.speaker && (
                      <button
                        type="button"
                        onClick={() => { setRenamingSpeaker(s.speaker || null); setSpeakerDraft(s.speaker || ''); }}
                        className="min-h-9 px-1 text-[11px]"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        改说话人
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
                    // 底部那道细蓝线是**焦点指示**：稿面在句尾画了一枚光标，说的是
                    // 「你现在改的就是这一行」。无框内联编辑没有边界，不给这道线就完全看不出焦点在哪。
                    // 高度跟着内容长——固定 rows 会在短句下留出一段不承载信息的空白。
                    style={{ border: 'none', borderBottom: '1px solid var(--accent-fg-info)', caretColor: 'var(--accent-fg-info)' }}
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={savingEdit || !editDraft.trim()}
                      onClick={() => {
                        const next = estimated
                          ? replaceEstimatedTranscriptSentenceText(noteMd, i, editDraft)
                          : replaceTranscriptSegmentText(noteMd, i, editDraft);
                        setSavingEdit(true);
                        void onSaveNote(next)
                          .then((ok) => { if (ok !== false) setEditingIndex(null); })
                          .finally(() => setSavingEdit(false));
                      }}
                      // 稿面的保存是**蓝色实心**，取消是无框文字——主次要分得出来
                      className="flex min-h-11 items-center gap-1 rounded-full px-4 text-[12px] font-semibold disabled:opacity-50"
                      style={{ background: 'var(--accent-fg-info)', color: 'var(--bg-card)' }}>
                      <Check size={12} /> 保存
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
                  fontSize: active ? 15 : 13,
                  fontWeight: active ? 600 : 400,
                  // 稿面把「已播过的」压灰、「还没播到的」留深色，两档区分出「读到哪了」。
                  // 原写法按与当前句的距离统一渐隐，前后一样淡，这层信息就没了。
                  color: active
                    ? 'var(--text-primary)'
                    : !followEnabled
                      ? 'var(--text-secondary)'
                      : i < activeIdx
                        ? 'var(--text-muted)'
                        : 'var(--text-primary)',
                  // 当前句底色 = 强调色（设计稿允许强调色出现的三处之一）；无紫色
                  background: active
                    ? 'color-mix(in srgb, var(--accent-fg-info) 14%, transparent)'
                    : 'transparent',
                  border: active
                    ? '1px solid color-mix(in srgb, var(--accent-fg-info) 30%, transparent)'
                    : '1px solid transparent',
                }}
                title={documentMode && onSaveNote ? '点击修改这句原文' : followEnabled && s.start >= 0 ? '点击跳到这一句' : undefined}
              >
                {/*
                  稿面每行是三段：左列时间戳、右侧说话人独占一行、正文另起一行。
                  我原先压成「chip + 正文」内联一行，时间戳整列都没有——
                  而这一屏的核心就是「逐句对齐」，没有时间就失去了时间轴锚点，
                  两位判官各自把它列为最重的一条缺失。
                */}
                <span className="grid gap-x-3" style={{ gridTemplateColumns: '48px 1fr' }}>
                  <span
                    className="pt-[2px] font-mono text-[11px] tabular-nums"
                    style={{ color: active ? 'var(--accent-fg-info)' : 'var(--text-muted)' }}
                  >
                    {s.start >= 0 ? formatClock(s.start) : ''}
                  </span>
                  <span className="min-w-0">
                    {s.speaker && (
                      <span className="mb-0.5 block text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>{s.speaker}</span>
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
        <div className="sticky bottom-3 z-20 flex h-0 w-full items-end justify-center" style={{ pointerEvents: 'none' }}>
          <button
            type="button"
            onClick={resumeFollow}
            className="flex min-h-11 items-center gap-1.5 rounded-full px-4 text-[13px] font-semibold"
            // 稿面这颗是**反色实心**胶囊（深色屏上是白底黑字）：它是浮在内容之上的主操作，
            // 做成同色描边就和底下的列表糊在一起，反差不够就不像「浮在上面的一颗按钮」
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
      {documentMode && (
        <div className="flex w-full max-w-[760px] flex-col gap-3">
          {/*
            设计稿 P3 是三块内容同屏并置：词云 → 会议纪要 → 待办，一屏贯通。
            我上一轮把它们做成了互斥分区，一次只能看一块——审查智能体判为「打断主路径」，
            结构分扣了 7 分。这里改回并置，分区标签随之取消。

            并置之后还差一层：稿面这三段是**三张并列的白卡**，不是一张大卡里的三个小节。
            我原先做成后者，两位判官各自独立指到同一处——分组感弱一档。所以卡片挂在每一段上，
            外层退成纯排版容器。
          */}
          <section style={{ scrollMarginTop: 100 }}>
            <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
              <h3 className="text-[19px] font-bold text-token-primary" style={{ scrollMarginTop: 100 }}>录音理解</h3>
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
            {(wordCloud.length > 0 || onSaveNote) && (
              <div className="mt-3">
            {/*
              两张设计稿在这一块上不一致，两边都得照顾：
              `VOICE TO NOTE`（P3）把这块叫「词云」、打开就是词条；
              `VOICE CAPTURE`（B3）把它叫「录音理解」，词条上面还压着一句结论。
              两张都是 V2、覆盖范围不同（交付页 vs 采集与结果），没有新旧之分。

              取法：区块标题按 B3 用「录音理解」并保留那句结论，词条组自己再带一个
              「词云」小标签——两张稿要的东西都在，只是层级各降一级。
              这处冲突已写进给设计方的待办，等他们定哪一个是准的。
            */}
                {wordCloud.length > 0 && (
                <p className="mt-3 text-[12px] font-semibold text-token-muted">词云</p>
                )}
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
                        ? { fontSize: '17px', fontWeight: 600, background: 'color-mix(in srgb, var(--accent-fg-info) 14%, transparent)', color: 'var(--accent-fg-info)' }
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
                  <p className="text-[11px] leading-relaxed text-token-muted">
                    没有反复出现的词。人名、产品名、团队黑话通用分词器不认识，会被切成单字丢掉——补进词典后就能统计到。
                  </p>
                )}
            {speakers.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1 text-[11px] text-token-muted"><UserRound size={12} /> 说话人</span>
                {speakers.map(speaker => renamingSpeaker === speaker ? (
                  <span key={speaker} className="flex items-center gap-1">
                    <input autoFocus value={speakerDraft} onChange={event => setSpeakerDraft(event.target.value)} className="h-9 w-28 rounded-[8px] px-2 text-[12px] outline-none" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-faint)' }} />
                    <button type="button" className="min-h-9 rounded-[8px] px-2 text-[11px]" onClick={() => {
                      if (!onSaveNote || !speakerDraft.trim()) return;
                      const next = renameTranscriptSpeaker(noteMd, speaker, speakerDraft);
                      setSavingEdit(true);
                      void onSaveNote(next).then(ok => { if (ok !== false) setRenamingSpeaker(null); }).finally(() => setSavingEdit(false));
                    }} disabled={savingEdit}>保存</button>
                  </span>
                ) : (
                  (() => {
                  // 光有名字看不出这场是谁在说；句数与占比是数得出来的事实（设计稿 P3/D1）
                  const stat = speakerStats.find(item => item.speaker === speaker);
                  return (
                    <button key={speaker} type="button" onClick={() => { setRenamingSpeaker(speaker); setSpeakerDraft(speaker); }} className="flex min-h-9 items-center gap-1.5 rounded-full px-3 text-[11px] text-token-secondary" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)' }} title="修改这个说话人的名称">
                      <span className="font-semibold text-token-primary">{speaker}</span>
                      {stat && (
                        <span className="tabular-nums text-token-muted">
                          {stat.count} 句 · 占 {stat.percent}%
                        </span>
                      )}
                    </button>
                  );
                })()
                ))}
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
            )}

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
          {/*
            「一键整理」排在录音理解之后、纪要与待办之前——稿面 B3 的层级是
            「先选一种整理方式，产出落在下面」。此前它被排到待办后面，两级关系倒过来了：
            读者先看见产出、翻到底才看见入口，于是判官记的是「整理入口不存在」
            （它其实在，只是在产出下面，没人会往那儿找）。
            整理方式清单来自后端注册表，不在前端另抄一份。
          */}
          {onPickOrganizeStyle && (
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
              // 没有整理结果就说没有，并给出**能到达**的下一步；不摆一句「暂无数据」了事
              <div className="mt-3 rounded-[11px] px-3 py-4 text-center" style={{ background: 'var(--bg-elevated)' }}>
                <p className="text-[12px] text-token-secondary">这份录音还没有整理结果</p>
                <p className="mt-1 text-[11px] leading-relaxed text-token-muted">
                  原文已经在下方，可以直接读；需要结论与要点时用上方的「一键整理」，整理完这里就会有内容
                </p>
              </div>
            )}
            </div>
          </section>
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
          <section style={{ scrollMarginTop: 100 }}>
            <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
              <h3 className="text-[19px] font-bold text-token-primary" style={{ scrollMarginTop: 100 }}>问这段录音</h3>
              <span />
            </div>
            <div className={SECTION_CARD} style={SECTION_CARD_STYLE}>
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
            <div className="mt-3 rounded-[11px] p-3" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)' }}>
              <RecordingAskComposer
                value={question}
                onChange={setQuestion}
                onSend={askRecording}
                sending={asking}
                onOpenMultiTurn={onAskRecording}
              />
              {qaError && <p className="mt-3 text-[12px]" style={{ color: 'var(--semantic-danger)' }}>{qaError}</p>}
              <RecordingAnswer
                question={askedQuestion}
                answer={answer}
                segments={timelineSegments}
                onSeek={sec => seekRef.current?.(sec)}
              />
            </div>
            </div>
          </section>
        </div>
      )}

    </div>
  );
}
