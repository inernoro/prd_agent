/**
 * 访客打不开链接时的几种形态（设计稿屏 11 的失败态）。
 *
 * 旧版把它们都渲染成同一张红圈卡，只有中间那行字不同——访客看到的是「打不开」，
 * 但「过期了找主人续期」和「你没这个权限，登录试试」的下一步完全不同。
 *
 * 只列后端真的分得出来的那几种。已撤销的链接在
 * `WebPagesController.ViewShare` 里和不存在的链接一样返回 NOT_FOUND，
 * 前端无从区分，所以合成一档，文案里两种都说到，而不是猜一个「已撤销」出来。
 */
export type ShareFailureKey =
  | 'not-found'
  | 'expired'
  | 'visibility-denied'
  | 'rate-limited'
  | 'unknown';

export interface ShareFailureConfig {
  title: string;
  /** 讲清楚发生了什么 + 下一步找谁；不许只写「加载失败」 */
  body: string;
  /** 语气：dead=这条链接没救了；wait=等一会儿还能用；auth=登录也许就能进 */
  tone: 'dead' | 'wait' | 'auth';
  /** 用户能点的动作；只有 auth 一档给「去登录」 */
  action?: 'login';
}

export const SHARE_FAILURE_REGISTRY: Record<ShareFailureKey, ShareFailureConfig> = {
  'not-found': {
    title: '这个链接已经失效了',
    body: '它可能被分享者撤销了，也可能地址抄错了一位。内容本身还在，找分享者要一条新链接就行。',
    tone: 'dead',
  },
  expired: {
    title: '这个链接已过期',
    // 访客侧只拿得到 EXPIRED 这一个错误码，宽限期信息后端没给，所以不能按可续性分支——
    // 但也**不能无条件承诺续期**：过期超过宽限窗、或链接已被撤销时，续期端点会拒绝，
    // 作者根本点不动。这句话必须两种情况都成立，把「续期」和「重新分享」并列给出。
    body: '分享时设了有效期，现在过了。内容没有被删除——找分享者要一条能打开的链接：还在宽限期内他点一下续期就行，过期太久的就得重新分享一条。',
    tone: 'dead',
  },
  'visibility-denied': {
    title: '这个链接不对外',
    body: '分享者把它限制为本人或团队成员可见。如果你是团队里的人，登录之后再打开这一页就能进。',
    tone: 'auth',
    action: 'login',
  },
  'rate-limited': {
    title: '密码试得太频繁了',
    body: '为了防止有人逐个猜密码，同一条链接每分钟最多试 10 次。等提示的时间过去再试一次即可，次数会自己恢复。',
    tone: 'wait',
  },
  unknown: {
    title: '打不开这个页面',
    body: '不是链接的问题，是这次请求没成功。刷新一下通常就好了；一直不行就把这一页的地址发给分享者。',
    tone: 'dead',
  },
};

/**
 * 后端错误码 → 该显示哪一张失败卡。
 *
 * 抽成纯函数的原因：这里要吃后端**两种大小写**的可见性拒绝码
 * （控制器用 `result.ErrorCode ?? "VISIBILITY_DENIED"`，而服务层给的是小写
 * `visibility_denied`），写在 JSX 三元里第二种一定会被漏掉——
 * 那正是 predicate-and-wiring-discipline 形状 1「语义相同、写法不同的输入让判据翻转」。
 */
export function resolveShareFailure(code: string | null | undefined): ShareFailureKey {
  switch ((code ?? '').toUpperCase()) {
    case 'NOT_FOUND': return 'not-found';
    case 'EXPIRED': return 'expired';
    case 'VISIBILITY_DENIED': return 'visibility-denied';
    case 'RATE_LIMITED': return 'rate-limited';
    default: return 'unknown';
  }
}
