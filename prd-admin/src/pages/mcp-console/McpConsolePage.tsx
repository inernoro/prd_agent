import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Check,
  ChevronDown,
  CircleSlash,
  Link2,
  Plug,
  Plus,
  Power,
  RefreshCw,
  ShieldCheck,
  Sliders,
} from 'lucide-react';
import { PrdLoader } from '@/components/ui/PrdLoader';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { getMcpConsoleOverview } from '@/services';
import type {
  McpCapabilityDto,
  McpClientDto,
  McpConsoleOverviewDto,
} from '@/services/contracts/mcpConsole';
import { toast } from '@/lib/toast';
import { ConnectAgentDialog } from './ConnectAgentDialog';
import { McpCallsPanel } from './McpCallsPanel';
import { QuotaEditorDialog } from './QuotaEditorDialog';
import { RevokeClientDialog } from './RevokeClientDialog';
import { copyToClipboard } from './clipboard';
import { capabilityVisual } from './capabilityRegistry';
import { buildHeadline } from './headline';
import { grantableTool, grantableToolCount } from './scopePlan';
import { clientSignal, tierLabel } from './signalEncoding';
import { CapabilityDot, SignalLegend } from './SignalDots';
import { quotaFillPercent } from './quotaMeter';

/**
 * 智能体接入台。
 *
 * 一页回答三件事：我授权了什么、连着哪几台客户端、它们刚才做了什么。
 * 授权与配额都是服务端权威，这里只做展示与入口，不在前端复算。
 *
 * 第一屏是**一句挂着数字的判断**，不是一排让人自己算的指标（conclusion-before-numbers）：
 * 「2 台客户端今天调了 47 次，其中 1 次没成」比四个孤零零的大数有用得多。
 */
export default function McpConsolePage() {
  const [overview, setOverview] = useState<McpConsoleOverviewDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectOpen, setConnectOpen] = useState(false);
  const [tab, setTab] = useState<'overview' | 'calls'>('overview');
  const [quotaTarget, setQuotaTarget] = useState<McpClientDto | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<McpClientDto | null>(null);
  // 「刷新」按钮只能刷自己拉的数据。调用记录面板自己管自己的分页与筛选，
  // 靠这个计数把刷新意图传下去 —— 否则用户停在记录页点刷新，列表纹丝不动。
  const [refreshToken, setRefreshToken] = useState(0);

  // 加载失败要留一个**持续存在**的错误态，不能只弹一下 toast 就放用户进正常页面 ——
  // overview 为 null 时正常页面会渲染成「0 个客户端、0 次调用、连接地址空白」，
  // 那和「账号是新的、什么都还没接」长得一模一样。toast 一消失，用户就以为接入台是空的，
  // 而实际上是它没读到数据（网络断了 / 没权限 / 服务端 500）。
  const [loadError, setLoadError] = useState<string | null>(null);
  // 手动刷新的 pending 只挂在按钮上。它**不能**是那个 loading ——
  // loading 会把整页换成 loader，而「连接新客户端」的弹窗就活在这一页里：
  // 发钥匙成功后弹窗回调父级刷新，整页一换，弹窗连带卸载，那把只出现一次的明文
  // 就跟着 state 一起没了，而钥匙已经在服务端生效了。
  const [refreshing, setRefreshing] = useState(false);

  // 代次令牌：顶部刷新还在飞的时候发一把新钥匙，onCreated 会再触发一次 load ——
  // 两次请求可以乱序回来，而先发的那次看到的还是「还没有这把钥匙」的世界。
  // 它后落地就会把新客户端与它的配额从界面上抹掉，用户刚发的钥匙一关弹窗就不见了。
  // 调用记录那一列上一轮已经用了同样的做法，这一处是同族里漏掉的兄弟。
  const loadGenRef = useRef(0);

  const load = useCallback(async () => {
    const gen = ++loadGenRef.current;
    const res = await getMcpConsoleOverview();
    if (gen !== loadGenRef.current) return;   // 号过期：期间又发起了一次，丢弃这份旧结果
    if (!res.success || !res.data) {
      setLoadError(res.error?.message || '接入台数据没读到，可能是网络断开或服务端异常。');
      setLoading(false);
      return;
    }
    setLoadError(null);
    setOverview(res.data);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  const clients = useMemo(() => overview?.clients ?? [], [overview]);
  const capabilities = useMemo(() => overview?.capabilities ?? [], [overview]);
  const headline = useMemo(
    () =>
      buildHeadline({
        clients,
        today: overview?.today ?? null,
        recentCalls: overview?.recentCalls ?? [],
        // 灰度期间新旧后端会同时在跑（分支预览共用一个前端构建），旧的那版不回这个字段。
        // 缺省取 false 会让「有过历史」的账号被说成「还没有客户端接进来」——
        // 而这一支正是本条要修的那句谎。缺省当「有过」：宁可少说一句引导，
        // 不要把一段真实历史说成从来没有。
        hasHistory: overview?.hasHistory ?? true,
      }),
    [clients, overview],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <PrdLoader size={44} />
      </div>
    );
  }

  // 整页错误态只给首屏用：手里已经有数据时刷新失败，不该把用户正在看的东西抹掉。
  if (!overview) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          接入台数据没读到
        </div>
        <div className="max-w-[420px] text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
          {loadError || '服务端没有返回数据。'}
          <br />
          这一屏显示的不是「你还没接入」，而是这次没读到 —— 已授权的客户端与调用记录都还在。
        </div>
        <button
          type="button"
          disabled={refreshing}
          onClick={() => void refresh()}
          className="rounded-[8px] px-3.5 py-1.5 text-[12.5px] font-medium disabled:opacity-60"
          style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-solid)' }}
        >
          {refreshing ? '正在重试…' : '重试'}
        </button>
      </div>
    );
  }

  return (
    // 手机端不再自己加左右 padding：外层 gutter 由 AppShell 统一给（--mobile-padding，
    // ≤479px 8px / 其余 10px）。再叠一层 16px 的话，375 宽下外边距变成 24px，
    // 卡片自己的 padding 还要再吃一层——正是密度规则点名禁止的三层叠加。
    // 内部滚动只在宽屏成立：宽屏是左右两列各自滚（内容多时不互相顶），
    // 窄屏单列时若沿用 h-full + flex-1 + overflow-y-auto，整页高度被锁死在一屏内 ——
    // 外层 <main> 没得可滚，每列在一个很矮的盒子里自己滚，客户端卡片被拦腰截断，
    // 第二台客户端与「断开」按钮根本不渲染（390 宽实测 docScrollHeight === innerHeight）。
    // 窄屏改成自然高度、由 <main> 滚。
    <div className="flex min-h-full flex-col gap-3.5 py-3 md:p-6 lg:h-full lg:min-h-0">
      {/* 页头：窄屏是**一条**横滚控制条，宽屏还原成一行排完。
          `mobile-first-density` 原则 3 + 决策表：进内容前最多一条控制条，
          多个工具条要合并成一条 / 横滚，**不要竖向堆**；次要动作图标化并入条尾；
          卡内头部合并为单行 `overflow-x-auto`，标题 `shrink-0 whitespace-nowrap`。
          形态照 `pages/team-activity/InsightsPanel.tsx` 的 renderMobileSingle。

          演化记录（两次都错在同一件事上：只看这一屏，没看全站纪律）：
          ① 最早是单个 `flex flex-wrap` + 动作组 `ml-auto` —— 折行之后 `ml-auto` 依然
             把动作组顶到**它那一行**的最右端，排出一个左边空一片的 Z 字；
          ② 然后改成窄屏竖排三行「每行都填满」—— Z 字是没了，但那正是本规则明令禁止的
             「竖向堆控制条」，130px 高的 chrome 把内容推出首屏。 */}
      <div
        className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 lg:mx-0 lg:flex-wrap lg:gap-3 lg:overflow-visible lg:px-0"
        style={{ overscrollBehavior: 'contain' }}
      >
        <div className="flex shrink-0 items-center gap-2">
          <Plug size={19} style={{ color: 'var(--accent-primary)' }} aria-hidden />
          {/* 窄屏让位：390px 装不下标题 135 + 切页 243 + 主操作 108，
              而横滚条里最先该保住的是「能点的东西」—— 用户刚从抽屉点着
              「智能体接入台」进来，标题是标识不是操作。
              用 sr-only 而不是 hidden：读屏仍念得出这一页叫什么，h1 也还在文档大纲里。 */}
          <h1
            className="sr-only shrink-0 whitespace-nowrap text-[18px] font-bold lg:not-sr-only"
            style={{ color: 'var(--text-primary)' }}
          >
            智能体接入台
          </h1>
        </div>
        <div
          className="flex shrink-0 gap-1 rounded-[10px] p-1"
          style={{ background: 'var(--tab-container-bg)' }}
        >
          {([
            { key: 'overview' as const, label: '能力与客户端', icon: ShieldCheck },
            { key: 'calls' as const, label: '它干了什么', icon: Activity },
          ]).map((item) => {
            const Icon = item.icon;
            const active = tab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setTab(item.key)}
                className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[8px] px-3 py-1.5 text-[12.5px] font-medium transition-colors"
                style={
                  active
                    ? { background: 'var(--bg-card)', color: 'var(--text-primary)' }
                    : { background: 'transparent', color: 'var(--text-muted)' }
                }
              >
                <Icon size={14} aria-hidden />
                {item.label}
              </button>
            );
          })}
        </div>
        {/* 窄屏顺序是「主操作在前、次要动作在尾」（决策表：次要动作并入条尾），
            宽屏用 lg:order-first 把刷新调回它原来在左的位置。 */}
        <div className="flex shrink-0 items-center gap-2 lg:ml-auto">
          <button
            type="button"
            onClick={() => setConnectOpen(true)}
            className="flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-[10px] px-4 text-[13px] font-semibold transition-opacity hover:opacity-90"
            style={{ background: 'var(--accent-primary-solid)', color: 'var(--accent-on-primary)' }}
          >
            <Plus size={15} aria-hidden />
            接入新的
          </button>
          {/* 窄屏只剩图标：文字 span 被 `hidden` 摘出无障碍树，而图标本身 aria-hidden，
              不给 aria-label 的话这个按钮对读屏用户没有名字。文案跟着状态走。 */}
          <button
            type="button"
            disabled={refreshing}
            aria-label={refreshing ? '正在刷新' : '刷新'}
            onClick={() => {
              setRefreshToken((n) => n + 1);
              void refresh();
            }}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-[13px] font-medium transition-colors lg:order-first lg:w-auto lg:gap-2 lg:px-3"
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
            }}
          >
            <RefreshCw size={15} aria-hidden className={refreshing ? 'animate-spin' : undefined} />
            <span className="hidden lg:inline">{refreshing ? '刷新中' : '刷新'}</span>
          </button>
        </div>
      </div>

      {loadError ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] px-3 py-2 text-[12.5px]"
          style={{
            background: 'var(--semantic-warning-soft)',
            border: '1px solid var(--semantic-warning-border)',
            color: 'var(--semantic-warning-text)',
          }}
        >
          <span>这次没刷上：{loadError} 下面显示的是上一次读到的数据。</span>
          <button
            type="button"
            disabled={refreshing}
            onClick={() => void refresh()}
            className="rounded-[7px] px-2.5 py-1 text-[12px] font-medium disabled:opacity-60"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
          >
            {refreshing ? '正在重试…' : '重试'}
          </button>
        </div>
      ) : null}

      {/* 结论条：先给判断，再给数字 */}
      <div
        className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-[14px] px-4 py-3.5"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
      >
        <div className="flex min-w-[260px] flex-1 flex-col gap-1">
          <div className="text-[14px] font-semibold leading-snug" style={{ color: 'var(--text-primary)' }}>
            {headline.verdict}
          </div>
          {headline.detail && (
            <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {headline.detail}
            </div>
          )}
        </div>
        {/* 这里**不再**放「今天出图 X / Y」这种合计条。
            用量的分子（服务端权威合计，含当天被撤销的密钥）与额度的分母（只有还在的密钥才有额度）
            天然来自两拨不同的密钥，凑成一个比值怎么摆都会在某个边界上说谎：
            连续三轮 Review 各挑出一种（0/0、50/50 满格、撤销后自相矛盾），每次都只是换个说法。
            真正要的两件事本来就各有归处 —— 总量在左边那句判断里（与 today 同源），
            每把钥匙自己的用量与上限在下面各自那一行（分子分母同一把钥匙，没有混人口的问题）。
            合计余量本身也不可行动：额度是按密钥算的，加起来那个数谁也用不上。 */}
      </div>

      {tab === 'calls' ? (
        <McpCallsPanel clients={clients} refreshToken={refreshToken} />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_320px]">
          {/* 左：客户端 + 平台开放了什么 */}
          <div className="flex flex-col gap-3 lg:min-h-0 lg:overflow-y-auto lg:pr-0.5">
            {/* 标题与说明，窄屏必须分两行。
                三段挤在一个不折行的 flex 里，390 宽放不下时**标题自己**被压到最窄 ——
                「连着的客户端」折成「连着的客户 / 端」。压的是标题，因为 flex 项默认可收缩，
                而那两句说明比它长得多、抢得也多。
                （这是上一轮加第三段说明时引入的：当时判断「放标题旁比逐行写省地方」，
                 省下的地方正是从标题这一行扣掉的。）
                做法：标题 shrink-0 不许被压，两句说明合成一句、窄屏独占第二行。 */}
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <h2 className="shrink-0 text-[13.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                连着的客户端
              </h2>
              {/* 「今天」按 UTC 自然日切（McpUsageService.TodayStartUtc = UtcNow.Date），
                  不是用户本地的午夜 —— UTC+8 的人在早上 8 点看到它归零。这句话改版前
                  一直在页面上，改版时被收进了额度编辑弹窗里；而下面每一行、每一条额度条
                  都写着「今天」，不说清是哪个「今天」，用户会以为数字错了。 */}
              <span
                className="w-full text-[11px] lg:w-auto"
                style={{ color: 'var(--text-muted)' }}
                title="额度与「今天」的计数都按 UTC 自然日重置；UTC+8 是每天早上 8 点归零"
              >
                「今天」按 UTC 自然日算
              </span>
            </div>

            {clients.length === 0 ? (
              <EmptyHint text="还没有客户端接进来。点这一页顶上那行里的「接入新的」，起个名字复制一段配置就完事，两分钟就能连上。" />
            ) : (
              <>
                {/* 图例整屏只出现这一次 —— 它是这套色点的说明书，替代的是原来每张卡上
                    重复一遍的那两三句话。手机端它自己收起（`mobile-first-density` 的收纳表），
                    说明书改走每张卡的展开区：色点行就是展开钮，点开是逐块的文字。 */}
                <SignalLegend />
                {clients.map((client) => (
                <ClientRow
                  key={client.keyId}
                  client={client}
                  capabilities={capabilities}
                  onRevoke={() => setRevokeTarget(client)}
                  onEditQuota={() => setQuotaTarget(client)}
                />
                ))}
              </>
            )}

            <PlatformCapabilityBar capabilities={capabilities} />
          </div>

          {/* 右：连接地址 + 去哪看 */}
          <div className="flex flex-col gap-3 lg:min-h-0 lg:overflow-y-auto lg:pr-0.5">
            <SectionCard title="连接地址" icon={Link2}>
              <code
                className="block break-all rounded-[9px] px-2.5 py-2 text-[11px]"
                style={{
                  background: 'var(--bg-sunken)',
                  border: '1px solid var(--border-faint)',
                  color: 'var(--text-secondary)',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                }}
              >
                {overview.endpointUrl}
              </code>
              <button
                type="button"
                onClick={async () => {
                  if (!overview.endpointUrl) return;
                  // 必须等它真的写进去：剪贴板不可用时报「已复制」，用户会拿一份旧内容
                  // 去粘贴进客户端配置，然后对着连不上的连接器排查半天。
                  if (await copyToClipboard(overview.endpointUrl)) toast.success('地址已复制');
                  else toast.error('复制失败，请手动选中上面的地址复制');
                }}
                className="flex h-8 items-center justify-center gap-1.5 rounded-[9px] text-[12px] font-medium"
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-secondary)',
                }}
              >
                <Check size={13} aria-hidden />
                复制地址
              </button>
              <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                已经接过的客户端不用改；新接一台走上面的「接入新的」，配置连钥匙一起给你。
              </p>
            </SectionCard>

            <SectionCard title="出了问题去哪看">
              <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                切到上面的
                <b style={{ color: 'var(--text-secondary)' }}>「它干了什么」</b>
                看每一次调用：谁、做了什么、成没成、产出在哪。
              </p>
              <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                钥匙泄露了就在左边那一行点
                <b style={{ color: 'var(--semantic-danger-text)' }}>「断开」</b>
                ，立刻失效，它做过的事和记录仍然留着。
              </p>
            </SectionCard>
          </div>
        </div>
      )}

      <RevokeClientDialog
        client={revokeTarget}
        open={revokeTarget !== null}
        onOpenChange={(next) => {
          if (!next) setRevokeTarget(null);
        }}
        onRevoked={() => void load()}
      />

      <QuotaEditorDialog
        client={quotaTarget}
        open={quotaTarget !== null}
        onOpenChange={(next) => {
          if (!next) setQuotaTarget(null);
        }}
        onSaved={() => void load()}
      />

      <ConnectAgentDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        capabilities={capabilities}
        endpointUrl={overview.endpointUrl}
        onCreated={() => void load()}
      />
    </div>
  );
}

/**
 * 客户端一行。
 *
 * 这一行上有两类东西，视觉上必须分得开（上一版把它们画成一排大小不一的按钮，
 * 读者分不清哪个能点）：
 *   - **说明**：它能做什么 —— 无边框、图标 + 文字、统一 24px，不可点；
 *   - **动作**：断开 / 调整上限 —— 32px、有边框，中间隔一道竖线。
 */
function ClientRow({
  client,
  capabilities,
  onRevoke,
  onEditQuota,
}: {
  client: McpClientDto;
  capabilities: McpCapabilityDto[];
  onRevoke: () => void;
  onEditQuota: () => void;
}) {
  const [open, setOpen] = useState(false);
  const signal = useMemo(() => clientSignal(client, capabilities), [client, capabilities]);
  // 灰度期间新旧后端会同时在跑（分支预览共用一个前端构建），旧的那版不回这个字段。
  // 直接 .length 会白屏 —— 一整页因为一个还没上线的字段消失，比少显示一行提示糟得多。
  const missing = client.missingCapabilities ?? [];

  // 卡片上留哪些字：**只留要用户去做点什么的那几句**。
  // 「自动档跟着你的权限走」「手动档按清单钉死」这两句是常识，讲一次就够，已经交给图例与左侧色带；
  // 而下面这两种不是常识，是这把钥匙此刻的例外，认颜色学不会。
  const alert = !client.isActive
    ? client.unusableReason === 'expired'
      ? '钥匙已过期，到「海鲜市场 → 开放接口 → 密钥」续期后还能接着用'
      : '钥匙已停用。界面上还开不回来（只能走接口），要立刻接着用就点这一页顶上那行里的「接入新的」重接一台；它做过的事和调用记录都留着'
    : signal.pinned && missing.length > 0
      // 一块都没给时不再把五块名字列一遍：色点与摘要已经说了「5 块都没开」，
      // 再列一遍就是同一件事说两次，而它是这张卡上最长的一段字。
      ? missing.length === capabilities.length
        ? '界面上改不了已发出去的清单，要给它就重新接一台'
        : `你自己还有${missing.map((c) => c.title).join('、')}没开给它 —— 界面上改不了已发出去的清单，要给它就重新接一台`
      : null;

  return (
    <div
      className="flex overflow-hidden rounded-[13px]"
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-subtle)',
        opacity: client.isActive ? 1 : 0.7,
      }}
    >
      {/* 左侧色带 = 自动 / 手动。图例上解释一次，这里就不必每张卡再写一遍那两句话。 */}
      <span
        aria-hidden
        className="w-[3px] shrink-0"
        style={{ background: signal.pinned ? 'var(--accent-primary)' : 'var(--border-default)' }}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-2.5 px-3.5 py-3">
        <div className="flex items-center gap-2">
          <span
            className="block h-2 w-2 shrink-0 rounded-full"
            style={{
              background: client.isActive ? 'var(--semantic-success-text)' : 'transparent',
              // 停用的钥匙用空心圈：整屏调成灰度也分得出来，不只靠颜色深浅
              border: client.isActive ? undefined : '1.5px solid var(--text-disabled)',
            }}
          />
          <span
            className="min-w-0 flex-1 truncate text-[13.5px] font-semibold"
            style={{ color: 'var(--text-primary)' }}
            title={client.name}
          >
            {client.name}
          </span>
          <span
            className="shrink-0 text-[16px] font-bold tabular-nums"
            style={{ color: 'var(--text-secondary)' }}
          >
            {client.todayCalls}
          </span>
          <span className="shrink-0 text-[10.5px]" style={{ color: 'var(--text-disabled)' }}>
            次
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* 色点行本身就是展开钮：手机上没有 hover，长按提示也不是人人都会用，
              所以留一条「点一下看文字」的路。展开区里是逐块能力的名字与档位 —— 
              颜色认不出来的人靠它照样读得全。 */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-[8px] py-1 text-left"
          >
            <span className="flex shrink-0 items-center gap-1.5">
              {signal.dots.map((d) => (
                <CapabilityDot key={d.key} capKey={d.key} title={d.title} tier={d.tier} />
              ))}
            </span>
            <span className="min-w-0 truncate text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
              {signal.summary}
              {signal.extraScopes.length > 0 && ` · 另有 ${signal.extraScopes.length} 项接口`}
            </span>
            <ChevronDown
              size={13}
              aria-hidden
              className="shrink-0 transition-transform"
              style={{ color: 'var(--text-disabled)', transform: open ? 'rotate(180deg)' : undefined }}
            />
          </button>

          <button
            type="button"
            onClick={onEditQuota}
            aria-label="调整这台客户端的每日上限"
            title="调整这台客户端的每日上限"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] sm:w-auto sm:gap-1.5 sm:px-2.5"
            style={{
              background: 'var(--bg-sunken)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
            }}
          >
            <Sliders size={13} aria-hidden />
            <span className="hidden text-[12px] font-medium sm:inline">调整上限</span>
          </button>

          {/* 钥匙泄露、或者这台客户端不用了，得能在**这里**当场断掉。
              从接入台进来的用户根本不知道另有一个密钥管理页。 */}
          {client.isActive && (
            <button
              type="button"
              onClick={onRevoke}
              aria-label="断开这台客户端（立刻作废这把钥匙）"
              title="立刻作废这把钥匙，这台客户端马上就调不动了"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] sm:w-auto sm:gap-1.5 sm:px-2.5"
              style={{
                background: 'var(--button-danger-bg)',
                border: '1px solid var(--button-danger-border)',
                color: 'var(--button-danger-fg)',
              }}
            >
              <Power size={13} aria-hidden />
              <span className="hidden text-[12px] font-medium sm:inline">断开</span>
            </button>
          )}
        </div>

        {open && (
          <div
            className="flex flex-col gap-1.5 rounded-[10px] px-3 py-2.5"
            style={{ background: 'var(--nested-block-bg)' }}
          >
            {signal.dots.map((d) => (
              <span key={d.key} className="flex items-center gap-2 text-[11.5px]">
                <CapabilityDot capKey={d.key} title={d.title} tier={d.tier} decorative />
                <span style={{ color: d.tier === 'none' ? 'var(--text-disabled)' : 'var(--text-secondary)' }}>
                  {d.title}
                </span>
                <span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                  {tierLabel(d.tier)}
                </span>
              </span>
            ))}
            {signal.extraScopes.length > 0 && (
              <span
                className="flex items-center gap-2 text-[11.5px]"
                style={{ color: 'var(--text-muted)' }}
                title={signal.extraScopes.join('\n')}
              >
                <Plug size={13} aria-hidden />
                另有 {signal.extraScopes.length} 项开放接口授权
              </span>
            )}
            <span className="pt-1 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {signal.pinned
                ? '按当初那份清单钉死：以后平台新上的能力不会自动进来。'
                : '跟着你的权限走：以后平台新上一块能力，它自动就有；你被收回的权限它也立刻跟着没。'}
            </span>
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <code
                style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}
              >
                {client.keyPrefix}…
              </code>
              {' · '}
              {client.lastUsedAt ? (
                <>
                  最后活跃 <RelativeTime value={client.lastUsedAt} />
                </>
              ) : (
                '还没用过'
              )}
            </span>
          </div>
        )}

        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <QuotaBar label="生图" used={client.todayImages} quota={client.dailyImageQuota} unit="张" />
          <QuotaBar label="写入类动作" used={client.todayWrites} quota={client.dailyWriteQuota} unit="次" />
        </div>

        {alert && (
          <span className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {alert}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * 平台一共开放了什么 —— 一条紧凑的能力条，不再是五张要人逐张读的大卡。
 *
 * 用户已经不用在这里做选择了（选择收进了接入弹窗的高级设置），所以它退回成一句说明：
 * 平台有这么几块、各挂着几个工具、哪块你还没权限。想看具体工具名的人点「看清单」。
 */
function PlatformCapabilityBar({ capabilities }: { capabilities: McpCapabilityDto[] }) {
  const [open, setOpen] = useState(false);
  // 只数他真能给出去的工具（判据见 scopePlan.grantableTool）
  const totalTools = capabilities
    .filter((c) => c.availableToMe)
    .reduce((n, c) => n + grantableToolCount(c), 0);

  return (
    <div
      className="flex flex-col gap-2.5 rounded-[13px] px-3.5 py-3"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
    >
      {/* 与客户端卡片头同一个形状、同一个修法：容器折行、按钮带 ml-auto，
          窄屏放不下时按钮会孤零零右对齐占掉一整行。让说明句 `w-full` 独占第二行，
          按钮就留在第一行末；宽屏用 `lg:order-last` 还原成原来那一排。 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          平台开放了什么
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-auto h-7 rounded-[8px] px-2.5 text-[11.5px] font-medium lg:order-last"
          style={{
            background: 'var(--bg-sunken)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--text-secondary)',
          }}
        >
          {open ? '收起清单' : '看清单'}
        </button>
        <span className="w-full text-[11.5px] lg:w-auto" style={{ color: 'var(--text-muted)' }}>
          你能给出去的共 <b style={{ color: 'var(--text-secondary)' }}>{totalTools}</b> 个工具
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {capabilities.map((cap) => {
          const v = capabilityVisual(cap.key);
          const Icon = v.icon;
          const usable = cap.availableToMe;
          return (
            <span
              key={cap.key}
              className="flex h-[24px] items-center gap-1.5 rounded-full px-2.5 text-[11px]"
              style={
                usable
                  ? { background: v.soft, border: `1px solid ${v.border}`, color: v.text }
                  : {
                      background: 'var(--semantic-neutral-soft)',
                      border: '1px solid var(--semantic-neutral-border)',
                      color: 'var(--text-muted)',
                    }
              }
            >
              {usable ? <Icon size={11} aria-hidden /> : <CircleSlash size={11} aria-hidden />}
              {cap.title} {usable ? grantableToolCount(cap) : cap.tools.length}
              {!usable && ' · 你还没这块权限'}
            </span>
          );
        })}
      </div>

      {open && (
        <div className="flex flex-col gap-2">
          {capabilities.map((cap) => (
            <div key={cap.key} className="flex flex-col gap-1.5">
              <span className="text-[11.5px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                {cap.title} · {cap.summary}
              </span>
              {cap.tools.map((tool) => (
                <div
                  key={tool.name}
                  className="flex flex-wrap items-baseline gap-2 rounded-[8px] px-2.5 py-1.5"
                  style={{ background: 'var(--bg-sunken)' }}
                >
                  <code
                    className="text-[11px]"
                    style={{
                      color: tool.granted ? 'var(--text-primary)' : 'var(--text-disabled)',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    }}
                  >
                    {tool.name}
                  </code>
                  {!grantableTool(cap, tool) && (
                    <span
                      className="rounded-[5px] px-1.5 py-[1px] text-[10px]"
                      style={{
                        background: 'var(--semantic-neutral-soft)',
                        border: '1px solid var(--semantic-neutral-border)',
                        color: 'var(--text-muted)',
                      }}
                    >
                      你还给不出去
                    </span>
                  )}
                  {tool.isWrite && (
                    <span
                      className="rounded-[5px] px-1.5 py-[1px] text-[10px]"
                      style={{
                        background: 'var(--semantic-orange-soft)',
                        border: '1px solid var(--semantic-orange-border)',
                        color: 'var(--semantic-warning-text)',
                      }}
                    >
                      写入
                    </span>
                  )}
                  <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                    {tool.description}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionCard({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon?: typeof Link2;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex flex-col gap-2.5 rounded-[13px] px-3.5 py-3"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
    >
      <span className="flex items-center gap-1.5 text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>
        {Icon && <Icon size={13} style={{ color: 'var(--accent-primary)' }} aria-hidden />}
        {title}
      </span>
      {children}
    </div>
  );
}

function QuotaBar({
  label,
  used,
  quota,
  unit,
}: {
  label: string;
  used: number;
  quota: number;
  unit: string;
}) {
  const shown = quotaFillPercent(used, quota);
  return (
    <div className="flex min-w-[150px] flex-1 flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {label}
        </span>
        <span
          className="text-[11px] tabular-nums"
          style={{ color: used > 0 ? 'var(--text-secondary)' : 'var(--text-muted)' }}
        >
          {used} / {quota} {unit}
        </span>
      </div>
      {/* 轨道本身要看得出是「容量」而不是一条分隔线：原来 4px 高 + 最淡的底色，
          在深色卡片上几乎不可见，于是 0 用量时这一行读起来只是两个数字下面有条划痕。 */}
      <span className="h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--border-default)' }}>
        <span
          className="block h-full rounded-full transition-[width] duration-500"
          style={{ width: `${shown}%`, background: 'var(--accent-primary)' }}
        />
      </span>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <p
      className="rounded-[12px] px-3.5 py-3 text-[12px] leading-relaxed"
      style={{ background: 'var(--bg-card)', border: '1px dashed var(--border-default)', color: 'var(--text-muted)' }}
    >
      {text}
    </p>
  );
}
