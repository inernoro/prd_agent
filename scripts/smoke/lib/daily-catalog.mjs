/**
 * 每日核心功能验收的「清单数据」——哪些功能线不进每日、哪些是台账外的、
 * 后端自检的每一项归哪条功能线。纯数据 + 纯函数，守卫可以真的 import 执行。
 *
 * 功能线清单本身不在这里：它只认业务功能台账
 * （.claude/skills/stable-smoke/reference/business-function-catalog.json）。
 * 这里只补两类台账表达不了的东西，且每一项都写明理由。
 */

/** 不进每日的功能线：必须说清为什么，以及由谁来验。 */
export const DAILY_EXEMPT = Object.freeze({
  'release-recovery': '只在正式发布时由发布中心门禁验证（固定 commit、入口验收、回滚锚点）；每日例程不触发发布，也不做回滚演练',
});

/**
 * 每日在验、但 48 小时台账还没收录的功能线。单独成行、在报告里标「48 小时台账未收录」，
 * 而不是硬挂到某条台账功能线下面——挂错功能线等于谎报覆盖面。
 */
export const EXTRA_LINES = Object.freeze([
  {
    id: 'platform-runtime',
    label: '后端运行健康',
    criticality: 'P0',
    breadcrumb: ['后端深度自检', '异常 / 数据库 / 索引 / 版本'],
    entryPath: '/api/healthz/deep',
  },
  {
    id: 'defect-management',
    label: '缺陷管理',
    criticality: 'P1',
    breadcrumb: ['首页', '缺陷管理', '提交缺陷'],
    entryPath: '/defect-agent',
  },
]);

/**
 * 后端深度自检（GET /api/healthz/deep，application/health+json，免登录）每一项归哪条功能线。
 * 自检是服务自己申报的判据（degradation-must-alarm 层 2），这里只做「归属 + 人话 + 下一步」。
 *
 * quietWarn：这一项的 warn 只表示「最近没流量、证明不了」，不代表有问题——
 * 每日例程不花钱生图，所以没流量是常态，照实写进「观察到的」，不升级成需关注。
 *
 * 自检里新出现、这里没登记的项不会被丢掉：deepCheckOutcome 把它归到「后端运行健康」，
 * 原样带出服务自己写的结论（服务加了判据，报告自动多一行，不用改这里）。
 */
export const DEEP_CHECK_MAP = Object.freeze({
  'api:unhandled-exceptions': { featureLine: 'platform-runtime', title: '后端最近 6 小时没有未处理异常',
    next: '去 CDS 看 api 容器日志里的 fail: 行，按 requestId 找到是哪个接口在炸' },
  'db:roundtrip': { featureLine: 'platform-runtime', title: '数据库读写往返正常',
    next: '查 Mongo 是否在线、连接串是否被改' },
  'mongo:required-indexes': { featureLine: 'platform-runtime', title: '数据库关键索引齐全',
    next: '按 doc/guide.platform.mongodb-indexes.md 补建缺失的索引' },
  'api:requests': { featureLine: 'platform-runtime', title: '后端在接真实请求', quietWarn: true,
    next: '没有任何真实调用：确认入口域名与反代是否指到了这个容器' },
  'deployment:version-match': { featureLine: 'platform-runtime', title: '运行的版本就是部署的版本',
    next: '运行二进制与部署目标不一致：在 CDS 重新部署 main 分支' },
  'model-leaderboard:staleness': { featureLine: 'llm-gateway', title: '模型排行榜按时同步',
    next: '去容器日志里搜 ModelLeaderboardSync 的告警，看是外站结构变了还是网络不通' },
  'model-catalog:selector-runtime-contract': { featureLine: 'llm-gateway', title: '业务可选模型与网关实际可调用的一致',
    next: '去模型网关修正对应业务的逻辑模型挂载（输出里点名了哪个业务、什么失配）' },
  'visual-image:default-route': { featureLine: 'visual-creation', title: '生图默认路由能解析到可用上游',
    next: '去模型网关检查视觉创作的生图场景路由' },
  'visual-image:recent-outcomes': { featureLine: 'visual-creation', title: '最近真实生图的成功率', quietWarn: true,
    next: '最近生图失败率超标：去请求日志按失败原因分组看' },
  'visual-image:requests': { featureLine: 'visual-creation', title: '最近有真实生图调用', quietWarn: true,
    next: '确认视觉创作入口没坏' },
  'visual-image:latency': { featureLine: 'visual-creation', title: '最近生图耗时正常', quietWarn: true,
    next: '生图耗时超标：去网关看上游延迟与排队' },
});

/** 自检里服务自己写的状态 → 报告状态。服务说 fail 就是 fail，这里不替它降级。 */
export function deepCheckOutcome(key, check) {
  const m = DEEP_CHECK_MAP[key] || {
    featureLine: 'platform-runtime',
    title: `后端自检：${key}`,
    next: '这一项是服务新申报的，按它输出里写的处置；需要归到具体功能线时登记进 DEEP_CHECK_MAP',
  };
  const st = String(check?.status || '').toLowerCase();
  let status = st === 'pass' ? 'pass' : st === 'warn' ? 'warn' : st === 'fail' ? 'fail' : 'not-run';
  if (status === 'warn' && m.quietWarn) status = 'pass';
  const value = check?.observedValue != null ? `${check.observedValue}${check.observedUnit ? ` ${check.observedUnit}` : ''}` : '';
  return {
    id: `DEEP-${key}`,
    featureLine: m.featureLine,
    title: m.title,
    method: '读后端深度自检（服务自己跑一遍真实链路后申报的结论）',
    status,
    observed: check?.output || (status === 'not-run' ? '自检没给出这一项的结论' : ''),
    next: status === 'not-run' ? '自检没给结论：看 /api/healthz/deep 的原始响应' : m.next,
    tech: `${key} status=${check?.status ?? '缺失'}${value ? ` observed=${value}` : ''}`,
  };
}
