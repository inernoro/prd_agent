import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowDown, ChevronDown, ChevronUp, CloudDownload, ExternalLink, Minus, RefreshCw } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { glassBar } from '@/lib/glassStyles';
import { hasEffectivePermission } from '@/lib/permissionAccess';
import { toast } from '@/lib/toast';
import { useAuthStore } from '@/stores/authStore';
import { TipsEntryButton } from '@/components/daily-tips/TipsEntryButton';
import { useIsMobile } from '@/hooks/useBreakpoint';
import {
  getLeaderboardBoards,
  getModelLeaderboard,
  syncModelLeaderboard,
  type LeaderboardBoardInfo,
  type ModelLeaderboardEntry,
  type ModelLeaderboardSnapshot,
  type ModelMetric,
} from '@/services/real/modelLeaderboard';
import {
  ErrorBar,
  HeatCell,
  PlainCell,
  ScoreBar,
  formatCount,
  formatScoreMargin,
  formatSigned,
  isOpenSource,
  orgMark,
} from './MetricCells';

/**
 * 模型排行榜（/model-leaderboard）。
 *
 * 数据是 arena.ai 的 Agent 榜，由后端每天同步一次落库，这里只读库——外站抖动不会传导给用户。
 *
 * ## 为什么是这个密度
 *
 * 第一版只显示「名次 / 模型 / 一个百分比 / 授权」，宽屏下三格是空的，进度条缩成一根细线。
 * 根因不是排版，是数据只抓了一个指标。榜单原页面每行有六个指标、会话数、单任务成本和单价，
 * 全都拿得到——补齐之后宽度自然被填满，也才够做选型判断（好用且不贵）。
 *
 * ## 为什么有两套表
 *
 * arena.ai 的十一个分榜是两种形状：Agent 榜是六个百分比指标，其余十个（文本 / 图像 /
 * 视频 / 代码…）是「对战分 ± 区间 + 票数」。用一套列去套两种数据只会让一半格子是空的，
 * 所以按快照里的 <c>kind</c> 分流渲染。kind 是后端按页面**实际解析出来的结构**写的，
 * 不是前端按榜名硬猜——对方改了某个榜的结构，这里会跟着变。
 */

/**
 * 列宽模板。行与表头共用同一个，改一处就得改两处的问题在这里被消掉。
 *
 * ## 模型列限了上限，富余全给指标条
 *
 * 第一版模型列写的是 `minmax(240px, 1fr)`，宽屏下所有富余宽度都塞给了它——而模型名
 * 只有二十来个字符，于是表格中间空出六百多像素（用户 2026-09-15 反馈「中间空这么一大块」）。
 * 富余该给的是那根带误差须的条：条越长，区间分得越开、分差越读得出来
 * （content-fills-canvas.md：空间要变成信息，不是留白）。
 */
const GRID = '92px minmax(230px, 520px) minmax(196px, 320px) 136px 136px 136px 128px 124px 104px 88px 104px';

/**
 * 分数榜只有六列，富余比 Agent 榜多得多，全部给对战分那一列。
 *
 * 这个决定改过三次，把三次的理由都记下来，免得后人再绕一遍：
 *
 * 1. 富余给模型列（`minmax(240px, 1fr)`）→ 模型名只有二十来个字符，表格中间空出六百多像素。
 * 2. 富余给条、但条只有一根线 → 右端跟着数值跑，78 行铺开右边缘是一条锯齿线。
 * 3. 于是给两列都设上限、表格居中 → 锯齿没了，但左边空出一大片，表格不填满画布了。
 *
 * 真正的解法是第 2 步缺的那一半：**给条加满宽轨道**（见 MetricCells 的 Track）。
 * 右边缘由轨道钉死，条再长也是一排整齐的槽，于是富余可以放心全给它——
 * 既填满画布，又不参差。模型列仍留 560px 上限，是因为最长的
 * `gemini-3.1-flash-image (nano-banana-2) [web…` 到这个宽度就够了，再宽只是空白。
 */
const GRID_SCORE = '92px minmax(260px, 560px) minmax(268px, 1fr) 120px 116px 104px';

/**
 * 首屏渲染多少行、每次追加多少行。
 *
 * 文本榜 402 行、每行十来个节点，一次性铺出来会卡住整页（用户同一轮反馈「这么卡」）。
 * 滚到底再追加即可——榜单是从上往下看的，没人会一屏跳到第 400 名。
 */
const INITIAL_ROWS = 40;
const ROWS_STEP = 40;

type RangeKey = 'all' | 'open';

export default function ModelLeaderboardPage() {
  const isMobile = useIsMobile();
  const [boards, setBoards] = useState<LeaderboardBoardInfo[]>([]);

  /**
   * 当前维度放在 URL 上（`?board=text-to-image`），不是组件 state。
   *
   * 三件事都靠它：刷新后还在这一屏、能把某个维度的链接直接发给别人、交付时给得出
   * 落到那一屏的深链（AGENTS.md 规则 11：不给根地址）。默认 agent 时不写 query，
   * 免得首页进来的干净链接立刻被塞上一截参数。
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const board = searchParams.get('board') ?? 'agent';
  const setBoard = useCallback(
    (key: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (key === 'agent') next.delete('board');
          else next.set('board', key);
          return next;
        },
        // 切维度是浏览而不是导航到新页面，用 replace 免得把浏览器的后退键塞满
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const [range, setRange] = useState<RangeKey>('all');
  const [snapshot, setSnapshot] = useState<ModelLeaderboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  // 与后端 ModelLeaderboardAdminController 的 WritePermission 对齐，按权限判而不是按角色名
  const permissions = useAuthStore((s) => s.permissions);
  const isRoot = useAuthStore((s) => s.isRoot);
  const canSync = hasEffectivePermission(permissions, 'mds.write', isRoot);

  /**
   * 已经读过的榜留在内存里。
   *
   * 榜单是后端每天同步一次的快照，同一次浏览里不会变；来回切维度还每次重拉，就是
   * 让用户为一份不会变的数据反复等（用户 2026-09-15 反馈「没有缓存吗，这么卡」）。
   * 页头那个刷新按钮传 force，绕过缓存——要「现在就去看有没有更新」时还有得点。
   */
  const cacheRef = useRef(new Map<string, ModelLeaderboardSnapshot>());

  /**
   * 最后一次发起的请求的序号。每发一次自增，回来时对不上就整份丢掉。
   *
   * 起初只记「目标榜」，那只挡得住切维度的竞态（旧榜数据渲染在新榜标题下）。同一个榜的
   * 两个请求——比如首屏那次还在飞、用户又点了刷新，或者同步完成后的强制重拉——board
   * 字符串一模一样，都能通过守卫，于是先发后到的那个会把新数据覆盖回旧的
   * （Codex 在 PR #1538 第三轮指出）。用单调递增的序号，两种竞态一起挡掉。
   */
  const requestSeqRef = useRef(0);

  /** 当前选中的榜。异步回调里不能直接看 board——那是闭包捕获的旧值。 */
  const boardRef = useRef(board);
  useEffect(() => {
    boardRef.current = board;
  }, [board]);

  const load = useCallback(
    async (force = false) => {
      const seq = ++requestSeqRef.current;

      const cached = cacheRef.current.get(board);
      if (cached && !force) {
        setSnapshot(cached);
        setError(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      // 文本榜实测 402 个模型，一次取全；渲染分批，不会因为行多就卡（见 INITIAL_ROWS）
      const res = await getModelLeaderboard(board, 500);

      // 这期间用户可能已经切走、或又发了一次请求：缓存照存（下次切回来即时可用），
      // 但只有最后一次发出的请求才有资格动这一屏
      if (res.success && res.data) cacheRef.current.set(board, res.data);
      if (seq !== requestSeqRef.current) return;

      if (res.success && res.data) {
        setSnapshot(res.data);
      } else {
        setSnapshot(null);
        setError(res.error?.message ?? '榜单没读出来，稍后再试');
      }
      setLoading(false);
    },
    [board],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /** 目录只拉一次，与首屏那个榜的数据并行——切换器不必等榜单数据回来才出现。 */
  const loadCatalog = useCallback(async () => {
    const res = await getLeaderboardBoards();
    if (res.success && res.data?.boards?.length) setBoards(res.data.boards);
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const currentBoard = useMemo(
    () => boards.find((b) => b.key === board) ?? null,
    [boards, board],
  );

  /**
   * URL 里写了个不存在的榜（手敲错、或者对方删了某个榜）就退回默认榜。
   *
   * 不这么做的话页面会一直停在「榜单没读出来：未知的榜单 xxx」——那是把一个我们自己
   * 能处理的输入错误，摆成了一条死路（guided-exploration.md：异常态要给得出下一步）。
   * 目录还没回来时不判，否则首帧就会把用户手上的合法链接改掉。
   */
  useEffect(() => {
    if (boards.length === 0 || currentBoard) return;
    setBoard('agent');
  }, [boards.length, currentBoard, setBoard]);

  /**
   * 表格形状以**快照里的 kind** 为准，目录里的 kind 只在快照还没到时垫一下。
   * 两者不一致时快照赢：它描述的是手上这份数据实际长什么样。
   */
  const kind = snapshot?.kind ?? currentBoard?.kind ?? 'agent';

  /**
   * 手动拉一次**当前这个榜**。
   *
   * 周期同步只在权威部署跑，分支预览上的库是空的，要看真实榜单就得点这里。
   * 只同步当前榜而不是十一个全抓：用户点这个按钮时想看的就是眼前这一屏，
   * 让他为另外十个榜等一分钟没有道理（切换器上没数据的榜自己带小灰点，点进去再同步即可）。
   */
  const runSync = useCallback(async () => {
    setSyncing(true);
    const res = await syncModelLeaderboard(board);
    setSyncing(false);
    if (res.success && res.data) {
      const failed = res.data.boards.filter((b) => !b.ok);
      if (failed.length > 0) {
        // 后端给的是「稳定码 + 一句人话」，这里原样转述即可；多个榜同因失败时只说一次，
        // 免得十一个榜各弹一遍同样的话
        const reasons = Array.from(new Set(failed.map((b) => b.error ?? '原因见服务端日志')));
        toast.error(
          `${failed.length} 个榜未更新（${failed.map((b) => b.board).join('、')}）：${reasons.join('；')}`,
        );
      } else {
        toast.success('榜单已更新');
      }
      // 同步刚把库里的快照换掉了，缓存必须作废，否则点完同步还看着旧数据
      cacheRef.current.delete(board);
      // 目录里的 ready / total 也变了，一起重拉——否则切换器上仍标着「暂无数据」。
      //
      // 只在用户还停在这个榜时才重拉：这个闭包捕获的是**发起同步时**的 board，同步要跑
      // 几秒到一分钟，期间切走的话 load(true) 会把旧榜的数据装回新榜的标题下面
      // （Codex 在 PR #1538 指出，是前一轮那个请求竞态修复没覆盖到的第二条路径）。
      await Promise.all([
        boardRef.current === board ? load(true) : Promise.resolve(),
        loadCatalog(),
      ]);
    } else {
      toast.error(res.error?.message ?? '同步没跑起来');
    }
  }, [board, load, loadCatalog]);

  const entries = useMemo(
    () => (snapshot?.entries ?? []).filter((e) => (range === 'open' ? isOpenSource(e.license) : true)),
    [snapshot, range],
  );

  /**
   * 每一列自己的最大绝对值。热力与误差须都按列归一，不跨列比——
   * 「好评比」的 36% 和「工具幻觉」的 0.37% 本来就不是一个量纲，共用一把尺会让后者永远是空白。
   */
  const columnMax = useMemo(() => {
    const pick = (get: (e: ModelLeaderboardEntry) => ModelMetric | null) =>
      Math.max(...entries.map((e) => Math.abs(get(e)?.value ?? 0)), 0.0001);

    // 净改进那一列画的是**带误差须的条**，尺子要量的是整个区间而不只是值本身。
    // 只按值取最大的话，最大那行的须会被画布边界截掉——而截掉的恰恰是「这个数有多不确定」，
    // 于是榜首看上去比谁都确定（Codex 在 PR #1538 指出）。
    // 实测就命中了：13.85 ± 1.92，误差占值 13.9%，而值撑到 96% 时只剩 4% 的余地。
    // 其余三列是热力格、不画须，仍按值归一。
    const span = Math.max(
      ...entries.map((e) =>
        e.netImprovement ? Math.abs(e.netImprovement.value) + (e.netImprovement.margin ?? 0) : 0,
      ),
      0.0001,
    );
    return {
      net: pick((e) => e.netImprovement),
      netSpan: span,
      confirmed: pick((e) => e.confirmedSuccess),
      praise: pick((e) => e.praiseVsComplaint),
      steer: pick((e) => e.steerability),
    };
  }, [entries]);

  /**
   * 首屏只铺 INITIAL_ROWS 行，滚到底再追加。
   *
   * 换榜或换筛选都从头开始——不然从 402 行的文本榜切到 10 行的视频编辑榜，
   * 会带着一个「已展开 400 行」的状态过去。
   */
  const [visibleRows, setVisibleRows] = useState(INITIAL_ROWS);
  useEffect(() => {
    setVisibleRows(INITIAL_ROWS);
  }, [board, range]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    // 提前 400px 就开始追加，让用户滚到底时下一批已经在了——而不是先看见一截空白
    const io = new IntersectionObserver(
      (es) => {
        if (es[0]?.isIntersecting) setVisibleRows((n) => n + ROWS_STEP);
      },
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [entries.length]);

  const shownEntries = useMemo(() => entries.slice(0, visibleRows), [entries, visibleRows]);

  /**
   * 分数榜那根条的量程：全列的最低下界到最高上界。
   *
   * 含误差在内，是因为须要画得进画布——只按分数取范围的话，垫底那行的下须会被截掉，
   * 而那恰恰是「这个分其实没那么确定」最该被看见的地方。
   */
  const scoreRange = useMemo(() => {
    const scored = entries.filter((e) => e.score != null);
    if (scored.length === 0) return { min: 0, max: 1 };
    const lows = scored.map((e) => e.score! - (e.scoreMarginDown ?? 0));
    const highs = scored.map((e) => e.score! + (e.scoreMarginUp ?? 0));
    return { min: Math.min(...lows), max: Math.max(...highs) };
  }, [entries]);

  return (
    <div className="h-full min-h-0 flex flex-col">
      {/* ── 页头：沿用 PageHeader 的玻璃横条，但这页要把标题与副标题排成两行，故自绘 ── */}
      {/*
        手机宽度（375px）上原来是一条不换行的定宽行：标题 + 范围切换 + 刷新 + 同步 + 教程，
        gap-4 加左右各 24px 内边距，几个定宽控件就吃掉大半屏，标题被挤没
        （Codex 在 PR #1538 指出）。改成允许换行 + 窄屏收内边距与间距：
        窄屏时控件整体掉到第二行，标题占满第一行。
      */}
      <div
        className="flex flex-wrap items-center gap-x-2.5 gap-y-2 px-3 py-3 sm:gap-x-4 sm:px-6 sm:py-3.5 shrink-0"
        style={{ ...glassBar, borderRadius: 0, borderLeft: 0, borderRight: 0, borderTop: 0 }}
      >
        <div className="flex flex-col gap-[3px] min-w-0">
          <div className="flex items-baseline gap-2.5">
            <span
              data-tour-id="model-leaderboard-page-title"
              className="text-[19px] font-semibold tracking-[-0.02em]"
              style={{ color: 'var(--text-primary)' }}
            >
              模型排行榜
            </span>
            <span
              className="font-mono text-[10px] uppercase"
              style={{ letterSpacing: '0.1em', color: 'var(--text-muted)' }}
            >
              {board} Arena
            </span>
          </div>
          <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            {currentBoard?.hint ?? '人类盲测对战榜，数据来自 arena.ai'}
          </span>
        </div>

        {/* 宽屏把控件推到右边；窄屏 flex-wrap 生效后它自己占一行，控件整体落到第二行 */}
        <div className="flex-1 min-w-[12px]" />

        <div
          data-tour-id="model-leaderboard-range"
          className="flex items-center gap-0.5 p-0.5 rounded-[10px]"
          style={{ background: 'var(--nested-block-bg)' }}
          role="group"
          aria-label="模型范围"
        >
          {([{ key: 'all', label: '全部' }, { key: 'open', label: '仅开源' }] as Array<{ key: RangeKey; label: string }>).map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              aria-pressed={range === r.key}
              className="h-[26px] px-[11px] rounded-[8px] text-[12px] font-medium transition-colors"
              style={{
                background: range === r.key ? 'var(--accent-gold)' : 'transparent',
                color: range === r.key ? 'var(--accent-on-gold)' : 'var(--text-secondary)',
              }}
            >
              {r.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => {
            cacheRef.current.delete(board);
            void load(true);
          }}
          data-tour-id="model-leaderboard-refresh"
          title="绕过缓存，重新读一次这个榜"
          aria-label="重新读取榜单"
          className="h-[28px] w-[28px] inline-flex items-center justify-center rounded-[8px] transition-colors"
          style={{ background: 'var(--nested-block-bg)', color: 'var(--text-muted)' }}
        >
          {loading ? <MapSpinner size={13} /> : <RefreshCw size={13} />}
        </button>

        {canSync && (
          <button
            type="button"
            onClick={() => void runSync()}
            disabled={syncing}
            title="从 arena.ai 重新抓一次当前这个榜"
            className="h-[28px] px-2.5 inline-flex items-center gap-1.5 rounded-[8px] text-[12px] font-medium transition-colors disabled:opacity-60"
            style={{ background: 'var(--nested-block-bg)', color: 'var(--text-secondary)' }}
          >
            {syncing ? <MapSpinner size={13} /> : <CloudDownload size={13} />}
            {syncing ? '抓取中' : '立即同步'}
          </button>
        )}

        {/*
          手机宽度不显示教程 pill：onboarding-tips 规则规定手机端把顶部空间让给页面操作，
          教程入口改由「我的 → 学习中心」承载，没走完的本页教程仍由 SpotlightOverlay
          自动开讲、不依赖这个按钮（Codex 在 PR #1538 指出）。
          这页的页头是自绘的（要把标题与副标题排两行），所以拿不到 PageHeader / TabBar
          那边的处理，得自己判——写法照 TabBar 的 `!isMobile &&`。
        */}
        {!isMobile && <TipsEntryButton className="shrink-0" />}
      </div>

      <BoardSwitcher boards={boards} current={board} onPick={setBoard} />

      <div data-tour-id="model-leaderboard-table" className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          // 不给静止的「加载中」：等待必须有持续变化的内容（AGENTS.md 规则 6）
          <MapSectionLoader text="正在读取榜单" />
        ) : error ? (
          <EmptyNote title="榜单没读出来" body={error} />
        ) : !snapshot?.ready ? (
          <EmptyNote
            title="这个环境还没有榜单数据"
            body={
              canSync
                ? '每天一轮的自动同步只在正式部署上跑（同项目多个预览共用一个库，都去写会互相覆盖）。要在这里看真实榜单，点下面按钮手动抓一次。'
                : '每天一轮的自动同步还没跑到这个环境。可以找有「模型管理」权限的同事手动同步一次。'
            }
            action={
              canSync ? (
                <button
                  type="button"
                  onClick={() => void runSync()}
                  disabled={syncing}
                  className="mt-1 self-start h-[32px] px-3.5 inline-flex items-center gap-2 rounded-[9px] text-[13px] font-medium transition-colors disabled:opacity-60"
                  style={{ background: 'var(--accent-gold)', color: 'var(--accent-on-gold)' }}
                >
                  {syncing ? <MapSpinner size={14} /> : <CloudDownload size={14} />}
                  {syncing ? '正在从 arena.ai 抓取…' : '立即同步一次'}
                </button>
              ) : undefined
            }
          />
        ) : entries.length === 0 ? (
          <EmptyNote
            title="这个范围里没有模型"
            body={range === 'open' ? '当前榜单里没有开源模型，切回「全部」看看。' : '榜单是空的。'}
          />
        ) : (
          <>
            <MetaStrip snapshot={snapshot} shown={entries.length} rendered={shownEntries.length} />

            <div className="overflow-x-auto">
              <div style={{ minWidth: kind === 'score' ? 920 : 1360 }}>
                {/* 表头 */}
                <div
                  className="grid items-end px-6 pt-2.5 pb-2 font-mono text-[9.5px] uppercase shrink-0"
                  style={{
                    gridTemplateColumns: kind === 'score' ? GRID_SCORE : GRID,
                    letterSpacing: '0.09em',
                    color: 'var(--text-muted)',
                    borderBottom: '1px solid var(--border-subtle)',
                  }}
                >
                  <div>名次</div>
                  <div>模型</div>
                  {kind === 'score' ? (
                    <>
                      <div className="text-right inline-flex items-center justify-end gap-1" style={{ color: 'var(--accent-gold)' }}>
                        对战分
                        <ArrowDown size={10} aria-label="按此列降序" />
                      </div>
                      <div className="text-right">投票数</div>
                      <div className="text-right">单价 $/M</div>
                      <div className="text-right">上下文</div>
                    </>
                  ) : (
                    <>
                      <div className="text-right inline-flex items-center justify-end gap-1" style={{ color: 'var(--accent-gold)' }}>
                        净改进
                        <ArrowDown size={10} aria-label="按此列降序" />
                      </div>
                      <div className="text-right">任务完成</div>
                      <div className="text-right">好评比</div>
                      <div className="text-right">可操控性</div>
                      <div className="text-right">命令恢复</div>
                      <div className="text-right">工具幻觉</div>
                      <div className="text-right">会话数</div>
                      <div className="text-right">单任务成本</div>
                      <div className="text-right">单价 $/M</div>
                    </>
                  )}
                </div>

                {shownEntries.map((e, i) =>
                  kind === 'score' ? (
                    <ScoreRow key={`${e.rank}-${e.name}`} entry={e} lead={i === 0} range={scoreRange} />
                  ) : (
                    <Row key={`${e.rank}-${e.name}`} entry={e} lead={i === 0} columnMax={columnMax} />
                  ),
                )}

                {/* 滚到这儿就追加下一批。还有剩的时候才挂，铺完了就摘掉 */}
                {shownEntries.length < entries.length && (
                  <div
                    ref={sentinelRef}
                    className="px-6 py-3 text-[11.5px] font-mono"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    正在展开第 {shownEntries.length + 1}–
                    {Math.min(shownEntries.length + ROWS_STEP, entries.length)} 名…
                  </div>
                )}
              </div>
            </div>

            <Legend kind={kind} />
          </>
        )}
      </div>
    </div>
  );
}

/** 元信息条：数据从哪来、多新、多少样本。 */
function MetaStrip({
  snapshot,
  shown,
  rendered,
}: {
  snapshot: ModelLeaderboardSnapshot;
  /** 当前筛选后的条数 */
  shown: number;
  /** 已经铺到页面上的条数（渐进渲染，滚动时会涨） */
  rendered: number;
}) {
  const date = snapshot.fetchedAt
    ? new Date(snapshot.fetchedAt).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '未知';

  /**
   * 样本量。Agent 榜统计的是会话，分数榜统计的是人类投票——单位不同，各说各的，
   * 不合成一个「样本数」让读者自己猜是什么。两个都没有就整格不显示。
   */
  const sample =
    snapshot.totalSessions != null
      ? `${snapshot.totalSessions.toLocaleString('en-US')} 次会话`
      : snapshot.totalVotes != null
        ? `${snapshot.totalVotes.toLocaleString('en-US')} 次投票`
        : null;

  return (
    <div
      className="flex items-center px-6 py-[11px] text-[12px] shrink-0"
      style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-subtle)' }}
    >
      <span className="inline-flex items-center gap-[7px]">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.8" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" strokeLinecap="round" />
        </svg>
        <span className="font-mono" style={{ color: snapshot.stale ? 'var(--accent-gold)' : undefined }}>
          数据截至 {date}
          {snapshot.stale ? '（已超过两天没同步成功）' : ''}
        </span>
      </span>

      {sample && (
        <>
          <Divider />
          <span className="inline-flex items-center gap-[7px]">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.8" aria-hidden="true">
              <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" strokeLinecap="round" />
            </svg>
            <span className="font-mono tabular-nums">{sample}</span>
          </span>
        </>
      )}

      <Divider />
      <span className="inline-flex items-center gap-[7px]">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.8" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18M9 21V9" />
        </svg>
        <span className="font-mono tabular-nums">
          {snapshot.total ?? shown} 个模型
          {shown !== (snapshot.total ?? shown) ? ` · 当前筛出 ${shown} 个` : ''}
          {rendered < shown ? ` · 已显示前 ${rendered} 名` : ''}
        </span>
      </span>

      <div className="flex-1" />

      {snapshot.sourceUrl && (
        <a
          href={snapshot.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1.5 text-[11.5px] hover:underline"
          style={{ color: 'var(--text-muted)' }}
        >
          <span>数据来源</span>
          <span style={{ color: 'var(--accent-gold)' }}>arena.ai</span>
          <ExternalLink size={11} style={{ color: 'var(--accent-gold)' }} />
        </a>
      )}
    </div>
  );
}

function Divider() {
  return <span className="w-px h-3 mx-4" style={{ background: 'var(--border-subtle)' }} aria-hidden="true" />;
}

function Row({
  entry,
  lead,
  columnMax,
}: {
  entry: ModelLeaderboardEntry;
  lead: boolean;
  columnMax: { net: number; netSpan: number; confirmed: number; praise: number; steer: number };
}) {
  const open = isOpenSource(entry.license);
  // 当列最大值占从中轴到边缘的 46%（留两格边距，免得最长那根顶到框线上）
  // 46（而非 50）给画布留边；分母用「值 + 误差」的跨度，保证最长的那根须也落在画布内
  const netScale = 46 / columnMax.netSpan;

  return (
    <div
      className="grid items-center px-6 transition-colors hover-bg-soft"
      style={{
        gridTemplateColumns: GRID,
        padding: lead ? '13px 24px' : '11px 24px',
        borderBottom: '1px solid var(--border-subtle)',
        background: lead ? 'color-mix(in srgb, var(--accent-gold) 5.5%, transparent)' : undefined,
      }}
    >
      <RankCell entry={entry} lead={lead} />

      <ModelCell entry={entry} lead={lead} />

      {/* 净改进：误差须 + 数值 */}
      <div className="flex items-center gap-2.5 justify-end">
        {entry.netImprovement ? (
          <>
            <ErrorBar metric={entry.netImprovement} scale={netScale} lead={lead} />
            <span className="flex flex-col items-end gap-px" style={{ minWidth: 62 }}>
              <span
                className="font-mono tabular-nums"
                style={{
                  fontSize: lead ? 14.5 : 13.5,
                  fontWeight: lead ? 700 : 650,
                  color: entry.netImprovement.value < 0 ? 'var(--semantic-danger-text)' : 'var(--text-primary)',
                }}
              >
                {formatSigned(entry.netImprovement.value)}
              </span>
              <span className="font-mono text-[9.5px]" style={{ color: 'var(--text-muted)' }}>
                {entry.netImprovement.margin != null ? `±${entry.netImprovement.margin.toFixed(2)}` : ''}
              </span>
            </span>
          </>
        ) : (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>—</span>
        )}
      </div>

      <HeatCell metric={entry.confirmedSuccess} max={columnMax.confirmed} />
      <HeatCell metric={entry.praiseVsComplaint} max={columnMax.praise} />
      <HeatCell metric={entry.steerability} max={columnMax.steer} />
      <PlainCell metric={entry.bashRecovery} />
      <PlainCell metric={entry.toolHallucination} />

      <div className="text-right font-mono text-[12px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>
        {entry.sessions != null ? entry.sessions.toLocaleString('en-US') : '—'}
      </div>
      <div
        className="text-right font-mono text-[12px] tabular-nums"
        style={{ color: open ? 'var(--semantic-success-text)' : 'var(--text-secondary)' }}
      >
        {entry.costPerTask != null ? `$${entry.costPerTask.toFixed(2)}` : '—'}
      </div>
      <div className="text-right font-mono text-[12px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>
        {entry.priceInput != null && entry.priceOutput != null
          ? `$${trimZero(entry.priceInput)} / $${trimZero(entry.priceOutput)}`
          : '—'}
      </div>
    </div>
  );
}

/**
 * 名次升降。
 *
 * delta 为 null 表示**不知道**（还没有上一份快照可比），这时什么都不画——
 * 不是画一个「持平」的横杠冒充「没变化」。0 才是真的持平。
 */
function RankDelta({ delta }: { delta: number | null }) {
  if (delta == null) return null;
  if (delta === 0) {
    return <Minus size={10} style={{ color: 'var(--text-muted)' }} aria-label="名次未变" />;
  }
  const up = delta > 0;
  // 升降是状态指示，走图标而不是字面三角字符（AGENTS.md 规则 0）
  const Icon = up ? ChevronUp : ChevronDown;
  return (
    <span
      className="font-mono text-[10px] tabular-nums inline-flex items-center gap-px"
      style={{ color: up ? 'var(--semantic-success-text)' : 'var(--semantic-danger-text)' }}
      title={up ? `上升 ${delta} 名` : `下降 ${Math.abs(delta)} 名`}
    >
      <Icon size={11} aria-hidden="true" />
      {Math.abs(delta)}
    </span>
  );
}

/** 表尾图例：把误差须和名次区间的读法说清楚，而不是留一片空白。 */
function Legend({ kind }: { kind: 'agent' | 'score' }) {
  return (
    <div
      className="flex items-center gap-5 flex-wrap px-6 py-3.5 text-[11.5px]"
      style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)' }}
    >
      <span className="inline-flex items-center gap-2">
        {/* 图例要和行里长得一样：满宽轨道 + 填充段 + 两端的须 */}
        <svg width="42" height="12" viewBox="0 0 42 12" aria-hidden="true">
          <rect x="0" y="3" width="42" height="6" rx="3" fill="var(--nested-block-bg)" />
          <rect x="0" y="3" width="24" height="6" rx="3" fill="color-mix(in srgb, var(--accent-gold) 70%, transparent)" />
          <line x1="19" y1="1" x2="19" y2="11" stroke="var(--text-muted)" strokeWidth="1.2" />
          <line x1="29" y1="1" x2="29" y2="11" stroke="var(--text-muted)" strokeWidth="1.2" />
          <line x1="19" y1="6" x2="29" y2="6" stroke="var(--text-muted)" strokeWidth="1" />
        </svg>
        <span>轨道里填多少代表分数高低，两端的须是 95% 置信区间——区间重叠的两个模型，名次差别不作数</span>
      </span>
      <span className="w-px h-3" style={{ background: 'var(--border-subtle)' }} aria-hidden="true" />
      <span>名次下方的「区间」同理：榜首的真实名次可能落在 1–4 之间</span>
      {kind === 'score' && (
        <>
          <span className="w-px h-3" style={{ background: 'var(--border-subtle)' }} aria-hidden="true" />
          <span>
            条长按本榜的最低到最高分归一（不是从 0 起）；标「初步」的行样本还不够，分数还会变
          </span>
        </>
      )}
      <div className="flex-1" />
      <span>每天同步一次</span>
    </div>
  );
}

function trimZero(v: number): string {
  return Number.isInteger(v) ? String(v) : String(v);
}

function EmptyNote({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div
      className="mt-6 mx-6 rounded-[12px] px-5 py-6 flex flex-col gap-2"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
    >
      <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</span>
      <span className="text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{body}</span>
      {action}
    </div>
  );
}

/**
 * 名次格 + 名次置信区间。两种表共用——同一段视觉写两遍，迟早各自漂移
 * （.claude/rules/predicate-and-wiring-discipline.md 形状 3）。
 */
function RankCell({ entry, lead }: { entry: ModelLeaderboardEntry; lead: boolean }) {
  return (
    <div className="flex flex-col gap-px">
      <span className="inline-flex items-baseline gap-1.5">
        <span
          className="font-mono font-bold leading-none tabular-nums"
          style={{ fontSize: lead ? 21 : 15, color: lead ? 'var(--accent-gold)' : 'var(--text-secondary)' }}
        >
          {String(entry.rank).padStart(2, '0')}
        </span>
        <RankDelta delta={entry.rankDelta} />
      </span>
      {entry.rankLow != null && entry.rankHigh != null && (
        <span className="font-mono text-[9.5px]" style={{ color: 'var(--text-muted)' }}>
          区间 {entry.rankLow}–{entry.rankHigh}
        </span>
      )}
    </div>
  );
}

/** 厂商标 + 模型名 + 开源徽章 + 厂商授权小字。两种表共用。 */
function ModelCell({ entry, lead }: { entry: ModelLeaderboardEntry; lead: boolean }) {
  const open = isOpenSource(entry.license);
  return (
    <div className="flex items-center gap-[11px] min-w-0">
      <span
        className="inline-flex items-center justify-center shrink-0 font-mono font-bold"
        style={{
          width: lead ? 26 : 24,
          height: lead ? 26 : 24,
          fontSize: lead ? 9 : 8.5,
          borderRadius: 7,
          background: lead ? 'color-mix(in srgb, var(--accent-gold) 16%, transparent)' : 'var(--nested-block-bg)',
          border: `1px solid ${lead ? 'color-mix(in srgb, var(--accent-gold) 40%, transparent)' : 'var(--border-subtle)'}`,
          color: lead ? 'var(--accent-gold)' : 'var(--text-muted)',
        }}
      >
        {orgMark(entry.organization)}
      </span>
      <span className="flex flex-col gap-px min-w-0">
        <span className="flex items-center gap-[7px] min-w-0">
          <span
            className="font-mono truncate"
            style={{
              fontSize: lead ? 14 : 13,
              fontWeight: lead ? 600 : 550,
              color: 'var(--text-primary)',
              letterSpacing: '-0.01em',
            }}
          >
            {entry.name}
          </span>
          {open && (
            <span
              className="font-mono text-[8.5px] rounded-[4px] px-[5px] py-px shrink-0"
              style={{
                letterSpacing: '0.08em',
                color: 'var(--semantic-success-text)',
                border: '1px solid color-mix(in srgb, var(--semantic-success-text) 40%, transparent)',
              }}
            >
              开源
            </span>
          )}
        </span>
        <span className="text-[10.5px] truncate" style={{ color: 'var(--text-muted)' }}>
          {entry.organization ?? '未知厂商'} · {open ? entry.license ?? '开源' : '闭源'}
        </span>
      </span>
    </div>
  );
}

/**
 * 分数榜的一行：名次 / 模型 / 对战分（条 + 数值 + 区间）/ 投票数 / 单价 / 上下文。
 *
 * 单价与上下文只有文本类的几个榜有，图像视频榜那两格是「—」。不为此再拆一套列模板：
 * 同一个切换器下的表格换来换去还改变列数，读者每切一次都要重新找一遍眼睛落点。
 */
function ScoreRow({
  entry,
  lead,
  range,
}: {
  entry: ModelLeaderboardEntry;
  lead: boolean;
  /** 整列的分数跨度，条长按它归一 */
  range: { min: number; max: number };
}) {
  const open = isOpenSource(entry.license);

  return (
    <div
      className="grid items-center px-6 transition-colors hover-bg-soft"
      style={{
        gridTemplateColumns: GRID_SCORE,
        padding: lead ? '13px 24px' : '11px 24px',
        borderBottom: '1px solid var(--border-subtle)',
        background: lead ? 'color-mix(in srgb, var(--accent-gold) 5.5%, transparent)' : undefined,
      }}
    >
      <RankCell entry={entry} lead={lead} />

      <ModelCell entry={entry} lead={lead} />

      {/* 对战分：条 + 数值 + 置信区间 */}
      <div className="flex items-center gap-2.5 justify-end">
        {entry.score != null ? (
          <>
            <ScoreBar
              value={entry.score}
              marginUp={entry.scoreMarginUp}
              marginDown={entry.scoreMarginDown}
              min={range.min}
              max={range.max}
              lead={lead}
            />
            <span className="flex flex-col items-end gap-px" style={{ minWidth: 78 }}>
              <span className="flex items-baseline gap-[5px]">
                <span
                  className="font-mono tabular-nums"
                  style={{
                    fontSize: lead ? 15 : 13.5,
                    fontWeight: lead ? 700 : 650,
                    color: 'var(--text-primary)',
                  }}
                >
                  {Math.round(entry.score)}
                </span>
                {entry.preliminary && (
                  <span
                    className="font-mono text-[8.5px] rounded-[4px] px-[5px] py-px shrink-0"
                    style={{
                      letterSpacing: '0.06em',
                      color: 'var(--accent-gold)',
                      border: '1px solid color-mix(in srgb, var(--accent-gold) 40%, transparent)',
                    }}
                    title="榜单标注：样本还不够，这个分数会继续变"
                  >
                    初步
                  </span>
                )}
              </span>
              <span className="font-mono text-[9.5px]" style={{ color: 'var(--text-muted)' }}>
                {formatScoreMargin(entry.scoreMarginUp, entry.scoreMarginDown)}
              </span>
            </span>
          </>
        ) : (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>—</span>
        )}
      </div>

      <div className="text-right font-mono text-[12px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>
        {formatCount(entry.votes)}
      </div>
      <div
        className="text-right font-mono text-[12px] tabular-nums"
        style={{ color: open ? 'var(--semantic-success-text)' : 'var(--text-secondary)' }}
      >
        {entry.priceInput != null && entry.priceOutput != null
          ? `$${trimZero(entry.priceInput)} / $${trimZero(entry.priceOutput)}`
          : '—'}
      </div>
      <div className="text-right font-mono text-[12px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>
        {entry.contextWindow ?? '—'}
      </div>
    </div>
  );
}

/**
 * 榜单切换器：按分组排的一条横滚胶囊栏。
 *
 * ## 为什么不是下拉框
 *
 * 十一个榜分四组，下拉框会把「有哪些维度可看」藏起来——用户得先点开才知道有文生图这一项。
 * 摊开成一条，进页面就看得见全部维度，这正是用户要的「能筛选其他维度」。
 * 横向滚动而不是换行：窄屏下换成两三行会把表格挤出首屏
 * （.claude/rules/mobile-first-density.md：进内容前控制条 ≤1 条）。
 *
 * ## 只有一个榜时整条不显示
 *
 * 没得选就别摆一个假的选择器（chief-designer-usability.md 第二原则）。
 * 目录还没拉回来时同理——宁可晚半秒出现，也不要先闪一个只有一项的空壳。
 */
function BoardSwitcher({
  boards,
  current,
  onPick,
}: {
  boards: LeaderboardBoardInfo[];
  current: string;
  onPick: (key: string) => void;
}) {
  const groups = useMemo(() => {
    const out: Array<{ name: string; items: LeaderboardBoardInfo[] }> = [];
    for (const b of boards) {
      const last = out[out.length - 1];
      if (last && last.name === b.group) last.items.push(b);
      else out.push({ name: b.group, items: [b] });
    }
    return out;
  }, [boards]);

  if (boards.length < 2) return null;

  return (
    <div
      data-tour-id="model-leaderboard-boards"
      className="flex items-center gap-4 px-6 py-2 overflow-x-auto shrink-0"
      style={{ borderBottom: '1px solid var(--border-subtle)' }}
      role="group"
      aria-label="榜单维度"
    >
      {groups.map((g, gi) => (
        <div key={g.name} className="flex items-center gap-2.5 shrink-0">
          {gi > 0 && <span className="w-px h-3.5 mr-1.5" style={{ background: 'var(--border-subtle)' }} aria-hidden="true" />}
          <span
            className="font-mono text-[9.5px] uppercase shrink-0 whitespace-nowrap"
            style={{ letterSpacing: '0.09em', color: 'var(--text-muted)' }}
          >
            {g.name}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            {g.items.map((b) => {
              const active = b.key === current;
              return (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => onPick(b.key)}
                  aria-pressed={active}
                  // 没数据的榜照样可以点：点进去会看到「这个环境还没有榜单数据」和同步按钮，
                  // 比一个禁用到点不动、也不说为什么的按钮有用
                  title={b.ready ? `${b.hint}（${b.total} 个模型）` : `${b.hint}（这个环境还没同步过）`}
                  className="h-[26px] px-[11px] rounded-[8px] text-[12px] font-medium transition-colors whitespace-nowrap inline-flex items-center gap-1.5"
                  style={{
                    background: active ? 'var(--accent-gold)' : 'var(--nested-block-bg)',
                    color: active ? 'var(--accent-on-gold)' : 'var(--text-secondary)',
                  }}
                >
                  {b.label}
                  {!b.ready && (
                    <span
                      className="w-[5px] h-[5px] rounded-full shrink-0"
                      style={{ background: 'var(--text-muted)' }}
                      aria-label="暂无数据"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
