import type { McpCallLogDto, McpClientDto } from '@/services/contracts/mcpConsole';

export interface HeadlineInput {
  clients: McpClientDto[];
  today: {
    calls: number;
    images: number;
    writes: number;
    denied: number;
    failed: number;
  } | null;
  recentCalls: McpCallLogDto[];
  /** 有没有过任何一次调用（全部历史，不是今天）—— 见 McpConsoleOverviewDto.hasHistory */
  hasHistory: boolean;
}

export interface Headline {
  /** 判断句：一句话说清「现在什么情况」，每句都挂着真实数字 */
  verdict: string;
  /** 支撑句：为什么是这个判断、下一步该看哪 */
  detail: string;
}

/**
 * 接入台第一屏那句判断 —— 规则生成，不走大模型。
 *
 * 为什么是规则不是模型：这一屏要秒开、要可复现、要能定位到具体分支。
 * 模型更适合长文汇报（周报），不适合仪表盘头条（conclusion-before-numbers）。
 *
 * 三条自律钉在这里：
 *   1. 每句挂着真实数字。「整体表现良好」放到任何账号都成立，等于没说，一律不许出现。
 *   2. 算不出来就不出那句。没有失败明细时说「在「它干了什么」里逐条能看」，不编一个原因。
 *   3. 「被挡下」与「执行失败」是两件事，下一步完全不同（去开权限 / 去重试），不能合成一句。
 */
export function buildHeadline({ clients, today, recentCalls, hasHistory }: HeadlineInput): Headline {
  const active = clients.filter((c) => c.isActive);

  const calls = today?.calls ?? 0;

  // 撤销或删掉最后一把钥匙之后 clients 就空了，而它今天的调用还留在 today 里。
  // 先看 today 再看名单 —— 反过来会把「今天用过、刚断开」说成「还没有客户端接进来」，
  // 一句话抹掉当天全部活动。「没有过」和「现在没有了」是两件事。
  if (clients.length === 0) {
    if (calls === 0) {
      // 「今天没调用」不等于「从来没接过」：昨天用过、今天之前被撤销的钥匙
      // 会让 clients 空、today.calls 为 0，而它的记录还在「它干了什么」里躺着。
      //
      // 判据必须是 hasHistory（服务端不带时间下界查一次）。上一版拿 recentCalls
      // 顶替，理由写的是「它按条数取最近 N 次、天然跨天」—— **那是错的**：
      // overview 的 recentCalls 走 TodayFilter，今天没调用时必然为空，
      // 这个分支等于没改。跨天的那份是「它干了什么」那个端点（listMcpCalls），
      // 与这里同名不同义。
      if (!hasHistory) {
        return {
          verdict: '还没有客户端接进来。',
          detail: '点这一页顶上那行的「接入新的」：起个名字、复制一段配置粘进 Claude Code 或 Codex，两分钟就能连上。',
        };
      }
      return {
        verdict: '现在一台客户端也没连着了。',
        detail: '今天还没有调用。之前那些做过什么，切到「它干了什么」仍然逐条看得到；要再用就点这一页顶上那行的「接入新的」。',
      };
    }
    return {
      verdict: `今天有过 ${calls} 次调用，但现在一台客户端也没连着了。`,
      detail: '钥匙都撤掉或删掉了。它们做过什么，切到「它干了什么」仍然逐条看得到；要再用就点这一页顶上那行的「接入新的」。',
    };
  }

  // 名单不空、但一台能用的都没有（全停用 / 全过了宽限期）。overview 只把**已作废**的排除掉，
  // 所以这条分支下 clients 非空而 active 为空，today 里却可能还留着今天早些时候的调用。
  // 与上一条同一个不变量：今天有过调用，就必须把它说出来 —— 不许有任何一条分支把它吞掉。
  if (active.length === 0) {
    return {
      verdict:
        calls > 0
          ? `今天有过 ${calls} 次调用，但 ${clients.length} 台客户端现在都用不了了。`
          : `${clients.length} 台客户端都已经断开了，现在没有智能体能调用你的能力。`,
      detail: '钥匙停用或过期不影响历史 —— 它们做过什么，切到「它干了什么」仍然逐条看得到。',
    };
  }

  const denied = today?.denied ?? 0;
  const failed = today?.failed ?? 0;
  const bad = denied + failed;

  if (calls === 0) {
    const used = active.filter((c) => c.lastUsedAt).length;
    return {
      verdict: `${active.length} 台客户端接着，今天一次都还没调过。`,
      detail:
        used === 0
          ? '这几台从来没用过 —— 粘完配置记得重启客户端，再跟它说一句「把这周周报做成一页网页发出来」。'
          : '不是坏了，就是今天还没使唤它。要试一下的话，跟客户端说一句需要生图或写文档的话就行。',
    };
  }

  // 「出图 N 张」是句不准的话：这个数出自 McpUsageCounter，是**入队时占下的额度**，
  // 不是真做出来的图。一次刚排进去的四张、或者 worker 里全烧了的四张，都会让它显示 4，
  // 而同一屏的事件行会说那件事还没出结果 / 失败了。改成说它真正代表的东西：发起了几张。
  // 真正出没出来，以「它干了什么」那一行为准（下面的 asyncNote 就是指那儿）。
  const volume = `发起生图 ${today?.images ?? 0} 张、写入 ${today?.writes ?? 0} 次`;
  const lastAt = formatClock(recentCalls[0]?.createdAt);
  const tail = lastAt ? `最近一次在 ${lastAt}。` : '';

  // 判断句里**不许**把「还连着几台」和「今天调了多少次」说成一件事。
  // 两个数来自不同的人口：`active` 只算还在的，`today` 含当天被撤销/删掉的那些。
  // 「1 台客户端今天替你调了 47 次」在那 47 次里有一半是刚被撤掉的另一把钥匙干的时候，
  // 就是把别人的账算到它头上。这一类已经在这块面板上出过四次（合计条两次、判断句两次），
  // 每次单修一个分支都会在下一个边界复发 —— 所以这里整类拿掉：数字各自出自权威来源，
  // 客户端台数只作为并列的一句事实，不做主语。
  // 「全都成了」这句话超出了这些数字能支持的范围。today 的三个计数出自 log.Status，
  // 那是纯传输层判据：一个还在排队、甚至已经失败的生图 run，它的轮询回的正是 HTTP 200，
  // 于是在这里算成功。而同一屏的事件行会把它标成「还没出结果」——同一个 run，两句话。
  // 所以判断句只说这些数字真能证明的那件事：没有被挡下、也没有报错。
  // 异步任务到底跑成没有，以「它干了什么」那一行为准，这里给出指路而不是替它下结论。
  if (bad === 0) {
    const asyncNote = (today?.images ?? 0) > 0
      ? '生图这类异步任务跑完没有，以「它干了什么」里那一行为准。'
      : '';
    return {
      verdict: `今天调了 ${calls} 次，没有被挡下、也没有报错的。`,
      detail: `${volume}。现在连着 ${active.length} 台客户端。${tail}${asyncNote}`.trim(),
    };
  }

  // 被挡下 vs 执行失败：一个去开权限/等额度，一个去重试，合成一句会把下一步说糊
  const parts: string[] = [];
  if (denied > 0) parts.push(`${denied} 次被挡下（权限或额度不够）`);
  if (failed > 0) parts.push(`${failed} 次执行失败`);

  const firstBad = recentCalls.find((c) => c.status !== 'success' && !!c.errorMessage);

  return {
    verdict: `今天调了 ${calls} 次，其中 ${parts.join('、')}。`,
    detail: firstBad
      ? `最近那次是「${firstBad.toolName}」：${firstBad.errorMessage}`
      : `失败的原因在「它干了什么」里逐条看得到。${volume}。现在连着 ${active.length} 台客户端。${tail}`.trim(),
  };
}

/** 只给「最近一次在几点」用。相对时间由 RelativeTime 组件负责，这里不另写一份口径。 */
function formatClock(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}
