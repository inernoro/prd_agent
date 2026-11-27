/* 演示数据（只用于原型，不进源码差异；同一份导出到 设计文档/演示数据.json，实现取证共用）。
 * 课程、练习都是虚构示例；「真相」（每条意见该采纳还是驳回）只在模拟服务端使用，不下发给页面。 */
import type { Course, CourseSummary, Finding, Practice } from '@/pages/learning-course/types';
import reviewVideo from './assets/lesson-review.webm';
import reviewPoster from './assets/lesson-review-poster.webp';
import loopVideo from './assets/lesson-loop.webm';
import loopPoster from './assets/lesson-loop-poster.webp';
import handbook from './assets/handbook.pdf';
import p1 from './assets/handbook-p1.webp';
import p2 from './assets/handbook-p2.webp';
import p3 from './assets/handbook-p3.webp';
import p4 from './assets/handbook-p4.webp';
import p5 from './assets/handbook-p5.webp';
import p6 from './assets/handbook-p6.webp';
import p7 from './assets/handbook-p7.webp';
import p8 from './assets/handbook-p8.webp';
import visualBaseline from './assets/visual-baseline.webp';
import visualActual from './assets/visual-actual.webp';
import courseCover from './assets/course-cover.webp';

export const COURSE_ID = 'automation-testing';

const pages = [
  [p1, '封面'], [p2, '第 1 课 · 代码评审'], [p3, '第 1 课 · 判断意见'], [p4, '第 2 课 · 视觉验收'],
  [p5, '第 3 课 · 单元测试'], [p6, '第 4 课 · 联合测试'], [p7, '第 5 课 · 闭环'], [p8, '附录 · 检查清单'],
].map(([imageUrl, title]) => ({ imageUrl, title }));
const pdf = (lessonRange: [number, number]) => ({ title: '自动化测试实践 · 教材', url: handbook, sizeLabel: '115 KB', pages, lessonRange });

const at = (i: number) => Math.round(i * 4.4 * 10) / 10;

export function initialCourse(): Course {
  return {
    id: COURSE_ID,
    title: '自动化测试实践',
    subtitle: '用 Agent 做代码评审、视觉验收、单元测试与联合测试，发现问题后修复、复测、交付',
    wip: true,
    outcomes: ['给 Agent 足够的上下文，让意见带证据', '分清真问题与误报', '用同一组输入复测证明修好了', '写出三段式交付说明'],
    practices: [
      { id: 'p-review', title: '评审优惠券叠加计算的改动', skill: 'review', minutes: 10, summary: 'Agent 报了 4 处，其中有误报。', lessonIds: ['l1', 'l5'], status: 'todo' },
      { id: 'p-visual', title: '验收结算卡片的深色改版', skill: 'visual', minutes: 8, summary: '基线与实际两张截图，判断哪些差异是缺陷。', lessonIds: ['l2'], status: 'todo' },
      { id: 'p-unit', title: '审 Agent 生成的单元与联合测试', skill: 'unit', minutes: 10, summary: '留下能证明问题的测试，删掉会时好时坏的。', lessonIds: ['l3', 'l4'], status: 'todo' },
    ],
    lessons: [
      {
        id: 'l1', index: 1, title: '代码评审：让 Agent 先读懂改动，再下结论', minutes: 18, status: 'current', practiceIds: ['p-review'],
        summary: '把 diff、需求和测试一起交给 Agent，要求每条意见带文件、行号和能复现的输入，再由你逐条判断。',
        media: {
          video: {
            url: reviewVideo, posterUrl: reviewPoster, durationSec: 27.1, resumeAtSec: 9,
            chapters: [{ atSec: 0, title: '评审要回答什么' }, { atSec: at(1), title: '给全上下文' }, { atSec: at(2), title: '意见带证据' }, { atSec: at(3), title: '逐条判断' }, { atSec: at(4), title: '修完复测' }, { atSec: at(5), title: '小结' }],
            transcript: [
              { atSec: 0, text: '评审不是挑语法，而是判断这次改动会不会让用户拿到错的结果。' },
              { atSec: at(1), text: '第一步，把改动的 diff、需求原文、相关测试一起交给 Agent。缺一样，它就只能猜。' },
              { atSec: at(2), text: '第二步，要求每条意见带证据：文件、行号，和一个能复现问题的输入。' },
              { atSec: at(3), text: '第三步，逐条判断。Agent 也会误报，比如给纯计算函数建议加锁。看证据，不看语气。' },
              { atSec: at(4), text: '第四步，修完必须复测。同一组输入再跑一遍，红变绿才算修好。' },
              { atSec: at(5), text: '三句话带走：上下文给全，意见要证据，判断归你、复测归测试。' },
            ],
          },
          pdf: pdf([2, 3]),
          article: {
            readMinutes: 6,
            blocks: [
              { type: 'p', text: '代码评审最常见的失败，是 Agent 给了十几条意见，看上去很专业，你却不知道哪条该改。问题不在 Agent，而在交给它的材料和你要求它交回的东西。' },
              { type: 'h2', id: 'context', text: '一、交给 Agent 的三样材料' },
              { type: 'list', items: ['改动 diff：它才知道改了哪些行', '需求原文：它才知道本来要做到什么，不会把需求当缺陷', '相关测试：它才知道现在如何证明，建议才能被验证'] },
              { type: 'h2', id: 'prompt', text: '二、一条可以直接用的提示词' },
              { type: 'code', lang: 'text', code: '请评审这次改动：\n1. 只报会让用户拿到错误结果、或让已有功能坏掉的问题\n2. 每条给出：文件:行号、能复现的输入、期望与实际\n3. 按 P0 / P1 / P2 排序，风格建议放最后\n4. 没有证据的猜测不要报', caption: '把需求原文和 diff 附在这段提示词后面' },
              { type: 'callout', tone: 'tip', title: '为什么要「能复现的输入」', text: '有了输入，你和测试都能独立验证这条意见；没有输入的意见，只能靠信任。' },
              { type: 'h2', id: 'judge', text: '三、逐条判断：采纳、驳回、记录' },
              { type: 'p', text: '采纳：证据可复现，影响用户结果。驳回：前提不成立，比如函数是纯计算，却被建议加锁。记录：有价值但不在本次范围，登记到后续。' },
              { type: 'callout', tone: 'warn', title: '最容易误报的三类', text: '并发、性能、安全类意见最容易「听起来很对」。先问：这段代码真的有共享状态、真的在热路径、真的接收外部输入吗？' },
              { type: 'h2', id: 'next', text: '四、下一步' },
              { type: 'p', text: '读完可以直接做练习「评审优惠券叠加计算的改动」：Agent 报了 4 处，其中有一处误报，找出来。' },
            ],
          },
        },
      },
      {
        id: 'l2', index: 2, title: '视觉验收：截图、对照、标注', minutes: 15, status: 'todo', practiceIds: ['p-visual'],
        summary: '同一份演示数据下截基线与实际两张图，让 Agent 标出差异，你判断哪些是缺陷、哪些在容差内。',
        missingReason: { video: '本课没有视频：操作都在图文里一步步截了图' },
        media: {
          pdf: pdf([4, 4]),
          article: {
            readMinutes: 5,
            blocks: [
              { type: 'p', text: '视觉问题很难用断言写出来：按钮文字被截断、深色主题下明细看不清。最可靠的方法是对照两张截图。' },
              { type: 'h2', id: 'shoot', text: '一、怎么截' },
              { type: 'list', items: ['基线与实际用同一份演示数据', '桌面与 375 宽手机各截一张', '浅色与深色主题都要截'] },
              { type: 'figure', imageUrl: visualActual, caption: '实际截图：按钮文案被截断，明细文字在深色背景上几乎看不清' },
              { type: 'h2', id: 'tolerance', text: '二、容差怎么定' },
              { type: 'p', text: '文字截断、遮挡、对比度低于 4.5 一律是缺陷；阴影 1px 偏差这类肉眼难辨的差异，在容差内。' },
            ],
          },
        },
      },
      {
        id: 'l3', index: 3, title: '单元测试：先写一条会失败的测试', minutes: 16, status: 'todo', practiceIds: ['p-unit'],
        summary: '让 Agent 生成测试，但每条都要先在旧代码上失败、修复后通过；依赖时间或随机数的测试要删掉。',
        missingReason: { video: '本课没有视频：图文与教材已覆盖' },
        media: {
          pdf: pdf([5, 5]),
          article: { readMinutes: 5, blocks: [
            { type: 'p', text: '测试的价值在于：它失败时，你确定是代码坏了。依赖当前时间的测试做不到这一点。' },
            { type: 'h2', id: 'prompt', text: '一、提示词' },
            { type: 'code', lang: 'text', code: '为 applyCoupons 补单元测试：\n1. 覆盖满减后再折扣、金额归零、四舍五入到分\n2. 每条先在旧代码上失败，再在修复后通过\n3. 不要依赖当前时间与随机数' },
            { type: 'h2', id: 'review', text: '二、审测试和审代码一样严' },
            { type: 'p', text: '一条测试如果今天绿明天红，你就不知道它证明了什么。删掉它，比留着更安全。' },
          ] },
        },
      },
      {
        id: 'l4', index: 4, title: '联合测试：把真实链路串起来', minutes: 14, status: 'todo', practiceIds: ['p-unit'],
        summary: '每个函数都对，拼在一起仍可能错。联合测试打真实部署的预览地址，断言页面显示与接口返回一致。',
        missingReason: { video: '本课没有视频：图文与教材已覆盖' },
        media: {
          pdf: pdf([6, 6]),
          article: { readMinutes: 4, blocks: [
            { type: 'p', text: '接口字段名不一致、金额单位一个是元一个是分，单元测试都发现不了。' },
            { type: 'h2', id: 'shape', text: '一、一条联合测试的形状' },
            { type: 'code', lang: 'text', code: '加购 → 选券 → 下单接口 → 订单详情页\n断言：页面显示的应付金额 = 接口返回的 payable' },
            { type: 'callout', tone: 'tip', title: '打真实部署', text: '联合测试打预览地址，不打本地桩；桩只能证明你写的桩是对的。' },
          ] },
        },
      },
      {
        id: 'l5', index: 5, title: '闭环：修复、复测、交付', minutes: 12, status: 'todo', practiceIds: ['p-review'],
        summary: '只改被证实的问题，用同一组输入复测，写出三段式交付说明：能做什么、怎么证明、还没做到什么。',
        media: {
          video: {
            url: loopVideo, posterUrl: loopPoster, durationSec: 22.6,
            chapters: [{ atSec: 0, title: '三件事' }, { atSec: at(1), title: '修复' }, { atSec: at(2), title: '复测' }, { atSec: at(3), title: '交付说明' }, { atSec: at(4), title: '小结' }],
            transcript: [
              { atSec: 0, text: '一次交付要回答三件事：改了什么、怎么证明、还剩什么。' },
              { atSec: at(1), text: '修复只改被证实的问题。驳回的意见写清理由，不顺手多改。' },
              { atSec: at(2), text: '复测用同一份输入证明：单元测试守住边界，联合测试守住整条链路。' },
              { atSec: at(3), text: '交付说明三段式：能做什么，怎么证明，还有什么没做到。' },
              { atSec: at(4), text: '没复测的修复不算修复。交付说明里没有证据的那句话，就是下一次返工。' },
            ],
          },
          pdf: pdf([7, 8]),
          article: { readMinutes: 4, blocks: [
            { type: 'h2', id: 'note', text: '交付说明模板' },
            { type: 'code', lang: 'text', code: '能做什么：满减与折扣叠加后金额正确\n怎么证明：单元测试 12/12，联合测试 3/3\n还没做到：多币种未覆盖，已登记' },
            { type: 'p', text: '每一句都要能指向一条证据。写不出证据的那句，要么删掉，要么移到「还没做到」。' },
          ] },
        },
      },
    ],
  };
}

export function summaryOf(course: Course): CourseSummary {
  const next = course.lessons.find(l => l.status !== 'done');
  return {
    id: course.id, title: course.title, subtitle: course.subtitle, wip: course.wip, level: '入门到实战',
    lessonCount: course.lessons.length, minutes: course.lessons.reduce((s, l) => s + l.minutes, 0), coverUrl: courseCover,
    progress: { lessonsDone: course.lessons.filter(l => l.status === 'done').length, practicesDone: course.practices.filter(p => p.status === 'done').length, nextLessonId: next?.id, nextLessonTitle: next ? `第 ${next.index} 课` : undefined },
  };
}

/* ---------------- 练习 ---------------- */

const couponFile = {
  path: 'src/checkout/applyCoupons.ts', lang: 'ts',
  lines: [
    "import type { Coupon } from './types';",
    '',
    '/** 计算叠加优惠后的应付金额（单位：元） */',
    'export function applyCoupons(price: number, coupons: Coupon[]): number {',
    '  const minus = coupons',
    "    .filter(c => c.type === 'minus' && price >= c.threshold)",
    '    .reduce((sum, c) => sum + c.amount, 0);',
    '  const rate = coupons',
    "    .filter(c => c.type === 'rate')",
    '    .reduce((r, c) => r * c.rate, 1);',
    '',
    '  // 需求：先减满减，再打折',
    '  const total = price - minus * rate;',
    '  return total;',
    '}',
    '',
    'export function formatPayable(total: number): string {',
    "  return '¥ ' + total.toFixed(2);",
    '}',
  ],
};

const testFile = {
  path: 'src/checkout/applyCoupons.test.ts', lang: 'ts',
  lines: [
    "import { applyCoupons } from './applyCoupons';",
    "import { placeOrder, openOrderPage } from '../../e2e/helpers';",
    '',
    "test('满减后再打折：299 元，满 200 减 30，9 折', () => {",
    '  expect(applyCoupons(299, [minus(200, 30), rate(0.9)])).toBe(242.1);',
    '});',
    '',
    "test('满减大于价格时应付为 0', () => {",
    '  expect(applyCoupons(20, [minus(0, 30)])).toBe(0);',
    '});',
    '',
    "test('促销期内会员折扣生效', () => {",
    '  const inPromo = new Date().getDate() <= 15;',
    '  expect(applyCoupons(100, [rate(0.9)])).toBe(inPromo ? 90 : 100);',
    '});',
    '',
    "test('联合：下单接口的 payable 与订单详情页显示一致', async () => {",
    "  const order = await placeOrder({ sku: 'demo-book', coupons: ['M200-30', 'VIP9'] });",
    '  const page = await openOrderPage(order.id);',
    "  expect(await page.text('[data-testid=payable]')).toBe(`¥ ${order.payable.toFixed(2)}`);",
    '});',
  ],
};

export const practices: Record<string, Practice> = {
  'p-review': {
    id: 'p-review', courseId: COURSE_ID, title: '评审优惠券叠加计算的改动', skill: 'review', minutes: 10, agentLabel: '代码评审 Agent ',
    scenario: '同事改了结算页的优惠券叠加逻辑，需求是「先减满减，再打折」。这次改动只有一个文件，请让 Agent 评审，然后决定采纳哪些意见，修复后复测并交付。',
    focus: 'Agent 会报 4 处，其中至少一处是误报。只采纳有证据、会影响用户结果的意见；驳回的写清理由。',
    acceptance: ['299 元、满 200 减 30、9 折时应付 242.10', '任何组合下应付不小于 0，金额精确到分', '没有为不存在的问题增加代码'],
    subject: { kind: 'code', files: [couponFile] },
  },
  'p-visual': {
    id: 'p-visual', courseId: COURSE_ID, title: '验收结算卡片的深色改版', skill: 'visual', minutes: 8, agentLabel: '视觉验收 Agent ',
    scenario: '结算卡片做了深色主题改版。基线是上一版截图，实际是本次改动在同一份演示数据下的截图。让 Agent 对照，你判断哪些差异是缺陷。',
    focus: '文字截断、对比度不足是缺陷；肉眼难辨的 1px 偏差在容差内。不要把容差内的差异当缺陷让同事返工。',
    acceptance: ['按钮文案完整显示', '明细文字对比度不低于 4.5', '375 宽下没有横向溢出'],
    subject: { kind: 'visual', baselineUrl: visualBaseline, actualUrl: visualActual, viewport: '桌面 1280', theme: '深色主题' },
  },
  'p-unit': {
    id: 'p-unit', courseId: COURSE_ID, title: '审 Agent 生成的单元与联合测试', skill: 'unit', minutes: 10, agentLabel: '测试生成 Agent ',
    scenario: '为优惠计算补测试。Agent 生成了 3 条单元测试和 1 条联合测试，请逐条决定保留还是删掉，然后跑一遍并交付。',
    focus: '留下的每条测试，失败时都应该说明代码坏了。依赖当前时间的测试会时好时坏，要删掉。',
    acceptance: ['覆盖满减后再打折与金额归零', '没有依赖当前时间或随机数的测试', '至少一条联合测试打真实预览地址'],
    subject: { kind: 'code', files: [testFile] },
  },
};

type Truth = { decision: 'accept' | 'reject' | 'either'; wrongAccept?: string; wrongReject?: string };

export const practiceFindings: Record<string, (Finding & { truth: Truth; appearAt: number })[]> = {
  'p-review': [
    { id: 'R1', severity: 'P0', title: '满减被乘上了折扣率，和需求顺序相反', appearAt: 3.2, location: { file: couponFile.path, line: 13 },
      evidence: '输入 299 元、满 200 减 30、9 折：期望 (299 − 30) × 0.9 = 242.10，实际 299 − 30 × 0.9 = 272.00，用户多付 29.90 元。',
      suggestion: '先减满减再整体打折。', fix: ['-  const total = price - minus * rate;', '+  const total = (price - minus) * rate;'],
      truth: { decision: 'accept', wrongReject: '复测用例「299 元满 200 减 30 再 9 折」仍得到 272.00，这条是真问题。' } },
    { id: 'R2', severity: 'P1', title: '没有兜底负数，也没有精确到分', appearAt: 4.6, location: { file: couponFile.path, line: 14 },
      evidence: '输入 20 元、满 0 减 30：返回 −10；输入 33.3 元打 9 折：返回 29.970000000000002。',
      suggestion: '返回前取不小于 0 的值，并按分四舍五入。', fix: ['-  return total;', '+  return Math.max(0, Math.round(total * 100) / 100);'],
      truth: { decision: 'accept', wrongReject: '复测用例「满减大于价格」得到 −10，「33.3 元 9 折」得到 29.970000000000002。' } },
    { id: 'R3', severity: 'P1', title: 'applyCoupons 可能被并发调用，建议对 coupons 加锁', appearAt: 6.0, location: { file: couponFile.path, line: 4 },
      evidence: '结算页可能同时发起多次计算。',
      suggestion: '引入互斥锁保护 coupons 数组。', fix: ['-export function applyCoupons(price: number, coupons: Coupon[]): number {', '+export async function applyCoupons(price: number, coupons: Coupon[]): Promise<number> {', '+  await couponLock.acquire();'],
      truth: { decision: 'reject', wrongAccept: '这是误报：applyCoupons 是纯函数，只读入参、没有共享状态。加锁把同步函数改成了异步，结算页 3 处调用会拿到 Promise，联合测试显示「¥ [object Promise]」。' } },
    { id: 'R4', severity: 'P2', title: '金额格式化建议改用 Intl.NumberFormat', appearAt: 7.2, location: { file: couponFile.path, line: 18 },
      evidence: '手写拼接 ¥ 不便于以后支持多币种。',
      suggestion: '用 Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" })。', fix: ["-  return '¥ ' + total.toFixed(2);", "+  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(total);"],
      truth: { decision: 'either' } },
  ],
  'p-visual': [
    { id: 'V1', severity: 'P0', title: '支付按钮文案被截断，看不到金额', appearAt: 2.6, location: { region: { x: 13, y: 71, w: 28, h: 14 } },
      evidence: '按钮宽度固定 170px 且单行省略，「确认支付 ¥ 242.10，预计 30 分钟送达」只显示中间一段。',
      suggestion: '按钮恢复为整行宽度，文案完整显示。', fix: ['-  width: 170px; text-overflow: ellipsis;', '+  width: 100%;'],
      truth: { decision: 'accept', wrongReject: '复测「按钮文案完整显示」失败：用户看不到要付多少钱。' } },
    { id: 'V2', severity: 'P1', title: '明细文字对比度只有 2.1:1', appearAt: 4.0, location: { region: { x: 13, y: 24, w: 74, h: 26 } },
      evidence: '深色背景上明细文字色值过暗，实测对比度 2.1:1，低于 4.5。',
      suggestion: '明细文字改用次级文字色。', fix: ['-  color: 过暗的固定色;', '+  color: var(--text-secondary);'],
      truth: { decision: 'accept', wrongReject: '复测「明细文字对比度 ≥ 4.5」失败：实测仍是 2.1:1。' } },
    { id: 'V3', severity: 'P2', title: '卡片阴影向下偏移了 1px', appearAt: 5.4, location: { region: { x: 9, y: 8, w: 82, h: 84 } },
      evidence: '阴影 y 偏移 6px → 7px。',
      suggestion: '恢复为 6px。', fix: ['-  box-shadow: 0 7px 24px;', '+  box-shadow: 0 6px 24px;'],
      truth: { decision: 'reject', wrongAccept: '1px 阴影偏差在容差内，肉眼几乎无法分辨。判成缺陷会让同事为不影响用户的差异返工。' } },
  ],
  'p-unit': [
    { id: 'U1', severity: 'P1', title: '单元：满减后再打折', appearAt: 2.4, location: { file: testFile.path, line: 4 },
      evidence: '旧代码得到 272，修复后 242.1；能直接证明顺序问题。', suggestion: '保留。',
      truth: { decision: 'accept', wrongReject: '删掉后没有任何测试守住「先减后折」，复测覆盖检查失败。' } },
    { id: 'U2', severity: 'P1', title: '单元：满减大于价格时应付为 0', appearAt: 3.6, location: { file: testFile.path, line: 8 },
      evidence: '旧代码返回 −10，修复后返回 0。', suggestion: '保留。',
      truth: { decision: 'accept', wrongReject: '删掉后「金额归零」边界无人守住，复测覆盖检查失败。' } },
    { id: 'U3', severity: 'P1', title: '单元：促销期内会员折扣生效', appearAt: 4.8, location: { file: testFile.path, line: 12 },
      evidence: '期望值随运行当天日期变化：每月 1–15 日与 16 日之后结果不同。', suggestion: '保留，并在 CI 固定时区。',
      truth: { decision: 'reject', wrongAccept: '这条测试依赖当前日期，连续跑 3 次模拟不同日期，结果是 绿 / 红 / 绿。它失败时不能说明代码坏了。' } },
    { id: 'U4', severity: 'P0', title: '联合：下单接口 payable 与详情页一致', appearAt: 6.4, location: { file: testFile.path, line: 17 },
      evidence: '打预览地址，覆盖加购 → 选券 → 下单 → 详情页整条链路。', suggestion: '保留。',
      truth: { decision: 'accept', wrongReject: '删掉后没有测试覆盖真实链路，交付要求「至少一条联合测试」不满足。' } },
  ],
};

export const retestChecks: Record<string, { name: string; dependsOn: string[]; okMessage?: string }[]> = {
  'p-review': [
    { name: '单元测试 · 299 元满 200 减 30 再 9 折 = 242.10', dependsOn: ['R1'] },
    { name: '单元测试 · 满减大于价格时为 0、金额精确到分', dependsOn: ['R2'] },
    { name: '联合测试 · 结算页显示的应付与接口一致', dependsOn: ['R3'], okMessage: '3/3 通过' },
  ],
  'p-visual': [
    { name: '按钮文案完整显示', dependsOn: ['V1'] },
    { name: '明细文字对比度 ≥ 4.5', dependsOn: ['V2'], okMessage: '实测 7.9:1' },
    { name: '没有为容差内的差异返工', dependsOn: ['V3'] },
  ],
  'p-unit': [
    { name: '覆盖：先减后折、金额归零', dependsOn: ['U1', 'U2'] },
    { name: '稳定性：连续 3 次结果一致', dependsOn: ['U3'] },
    { name: '联合测试打真实预览地址', dependsOn: ['U4'], okMessage: '1/1 通过' },
  ],
};

export const runStages: Record<string, { review: [string, string, number][]; retest: [string, string, number][] }> = {
  'p-review': {
    review: [['read', '读取改动与需求', 1.5], ['analyze', '逐行分析 applyCoupons.ts', 3.5], ['verify', '用输入复现每条问题', 2.5], ['sort', '按严重级整理意见', 1]],
    retest: [['apply', '应用被采纳的修复', 1.2], ['unit', '运行单元测试', 2], ['e2e', '运行联合测试（预览地址）', 2.4], ['reasons', '核对驳回理由', 0.8]],
  },
  'p-visual': {
    review: [['shoot', '在同一份演示数据下截图', 1.5], ['diff', '逐像素对照基线', 3], ['measure', '测量对比度与溢出', 1.5], ['sort', '整理差异', 0.8]],
    retest: [['apply', '应用被判为缺陷的修复', 1], ['shoot', '重新截图（桌面与手机）', 2], ['measure', '复测对比度与溢出', 1.6], ['reasons', '核对容差判断', 0.8]],
  },
  'p-unit': {
    review: [['read', '读取被测函数与需求', 1.2], ['gen', '生成单元测试', 3], ['e2e', '生成联合测试', 2.4], ['dry', '在旧代码上试跑', 1.2]],
    retest: [['apply', '保留选中的测试', 0.8], ['old', '在旧代码上运行（应失败）', 1.6], ['new', '在修复后运行（应通过）', 1.6], ['repeat', '连续运行 3 次看稳定性', 1.6]],
  },
};
