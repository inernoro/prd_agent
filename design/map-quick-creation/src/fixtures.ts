/* 原型演示数据（虚构稿件与成员）。只用于原型，不进源码差异。实现方取证时用同一份数据（design.json demoData）。 */
import type { QcAttachment, QcRun, QcScene, QcStage, QcTemplate, QcWork, QcWebSection } from '@/pages/quick-creation-agent/types';

export const templates: QcTemplate[] = [
  { id: 'tpl-visual-note', kind: 'video', name: '视觉笔记', tagline: '点阵纸、手绘线条、暖黄强调', goodFor: '适合讲概念、流程和注意事项', frame: 'visual-note' },
  { id: 'tpl-whiteboard', kind: 'video', name: '白板速讲', tagline: '白底蓝色马克笔，一屏一个结论', goodFor: '适合复盘与汇报', frame: 'whiteboard' },
  { id: 'tpl-dark-notes', kind: 'video', name: '深色讲义', tagline: '深底等宽字', goodFor: '适合技术约定与代码说明', frame: 'dark-notes' },
  { id: 'tpl-guide-page', kind: 'web', name: '导读长页', tagline: '左侧目录、页首三个重点、正文分节', goodFor: '适合规范、手册和长文档', frame: 'guide-page' },
  { id: 'tpl-card-digest', kind: 'web', name: '卡片速览', tagline: '一屏卡片，点开看细节', goodFor: '适合清单、要点和公告', frame: 'card-digest' },
];

const docExcerpt = `刚加入团队的同学，第一次参加需求评审时常常不知道该看什么。这份说明只讲三个习惯，养成之后，评审会快很多。

习惯一：先读目标
打开需求，先找「这次要解决谁的什么问题」。如果一句话说不清，先别讨论方案，请提出人补一句目标。

习惯二：再画边界
写清楚这次不做什么。边界没写的需求，评审时最容易越聊越大。

习惯三：最后对验收
问一句：怎样算真的做完？能被别人照着检查的标准，才算验收标准。`;

export const sampleDoc: QcAttachment = { id: 'att-doc-habits', kind: 'doc', name: '需求评审的三个习惯.md', meta: 'Markdown · 6.2 KB', status: 'ready', chars: 1840, excerpt: docExcerpt };

/** 「从知识库选择」在原型里依次给出这些附件，用来演示多附件、读取中与读取失败 */
export const attachmentQueue: QcAttachment[] = [
  { id: 'att-kb-checklist', kind: 'kb', name: '评审检查清单', meta: '知识库 · 产品知识库 / 流程规范', status: 'ready', chars: 920, excerpt: '1. 目标是否一句话说清\n2. 是否列出不做的事\n3. 验收标准能否被别人照着检查' },
  { id: 'att-img-board', kind: 'image', name: '评审白板照片.png', meta: '图片 · 1.4 MB', status: 'ready', note: '作为第 3 幕画面参考' },
  { id: 'att-doc-faq', kind: 'doc', name: '附录：新同事常见问题.md', meta: 'Markdown · 2.1 KB', status: 'ready', chars: 610, excerpt: '问：评审要准备什么？答：读一遍目标和边界即可。' },
  { id: 'att-doc-minutes', kind: 'doc', name: '评审会议纪要.txt', meta: 'TXT · 3.4 KB', status: 'failed', error: '没读出文字：文件编码无法识别。可另存为 UTF-8 后重新上传，或点重试。' },
  { id: 'att-kb-glossary', kind: 'kb', name: '术语表（产品部）', meta: '知识库 · 产品知识库 / 术语', status: 'reading', progress: 62 },
  { id: 'att-img-sketch', kind: 'image', name: '流程草图.jpg', meta: '图片 · 860 KB', status: 'ready', note: '作为第 4 幕画面参考' },
];

export const runAttachments: QcAttachment[] = [sampleDoc, attachmentQueue[0], attachmentQueue[1], attachmentQueue[2], attachmentQueue[5]];

const sceneDefs: Array<[string, number, number, string]> = [
  ['片头', 1, 0, '需求评审，其实只要养成三个习惯。'],
  ['三个重点', 2, 12, '先记住三件事：目标、边界、验收。'],
  ['先读目标', 3, 26, '第一分钟只问一句：做完之后，谁的什么会变好？'],
  ['再画边界', 2, 40, '第二个习惯：写清楚这次不做什么。'],
  ['最后对验收', 3, 68, '最后问一句：怎样算真的做完？'],
  ['收尾', 1, 86, '目标、边界、验收，下次评审试试看。'],
];
export function scenes(statusOf: (i: number) => QcScene['status']): QcScene[] {
  return sceneDefs.map(([title, frameScene, startSec, caption], i) => ({ index: i + 1, title, frameScene, startSec, caption, status: statusOf(i) }));
}

export const webSections: QcWebSection[] = [
  { anchor: 'points', title: '先记住三件事', body: '目标、边界、验收。评审时按这个顺序问，十分钟就能对齐。' },
  { anchor: 'goal', title: '习惯一：先读目标', body: '打开需求，先找这次要解决谁的什么问题；一句话说不清，先请提出人补一句目标。' },
  { anchor: 'scope', title: '习惯二：再画边界', body: '写清楚这次不做什么，把「以后再说」的想法记进待办，不塞进本次。' },
  { anchor: 'accept', title: '习惯三：最后对验收', body: '问一句：怎样算真的做完？能被别人照着检查的标准，才算验收标准。' },
];

const videoStageDefs = [
  ['queued', '排队'], ['storyboard', '分镜'], ['voice', '配音'], ['compose', '合成'], ['done', '已生成'],
] as const;
const webStageDefs = [
  ['queued', '排队'], ['outline', '大纲'], ['layout', '版式'], ['render', '生成页面'], ['done', '已生成'],
] as const;

const videoDetail: Record<string, [string, string]> = {
  queued: ['等待开始', '等了 4 分 06 秒，曾排第 4 位'],
  storyboard: ['已拆成 6 幕，正在画第 4 幕的画面', '6 幕分镜已保存'],
  voice: ['正在为第 3 / 6 幕配旁白，字幕与旁白同步生成', '6 幕旁白与字幕已完成'],
  compose: ['正在合成 1080p 成片', '1 分 36 秒 · 1080p'],
  done: ['', ''],
};
const webDetail: Record<string, [string, string]> = {
  queued: ['等待开始', '等了 1 分 12 秒'],
  outline: ['正在从稿件提取重点与分节', '4 节，页首 3 个重点'],
  layout: ['正在按「导读长页」排版，适配桌面与手机', '版式已确定'],
  render: ['正在生成第 3 / 4 节', '页面已生成'],
  done: ['', ''],
};

export function stagesAt(kind: 'video' | 'web', current: number, opts: { failed?: boolean; progress?: number; failDetail?: string } = {}): QcStage[] {
  const defs = kind === 'video' ? videoStageDefs : webStageDefs;
  const details = kind === 'video' ? videoDetail : webDetail;
  return defs.map(([key, label], i) => {
    const status = i < current || (current === defs.length - 1 && i === current) ? 'done' : i === current ? (opts.failed ? 'failed' : 'running') : 'pending';
    const detail = status === 'done' ? details[key][1] : status === 'failed' ? opts.failDetail : details[key][0];
    return { key, label, status, detail: detail || undefined, progress: status === 'running' && key !== 'queued' ? opts.progress : undefined };
  });
}

const now = '今天 14:02';
const baseRun = (over: Partial<QcRun>): QcRun => ({
  id: 'run', title: '需求评审的三个习惯', kind: 'video', templateId: 'tpl-visual-note', ask: '稍微快一点，先提醒我三个重点，给新同事看',
  attachments: runAttachments, status: 'running', stages: [], elapsedSec: 0, publish: { status: 'none' }, createdAt: now, updatedAt: now, voice: '女声 · 稍快',
  keyPoints: [{ text: '先读目标：这次要解决谁的问题', atSec: 26 }, { text: '再画边界：哪些这次不做', atSec: 40 }, { text: '最后对验收：怎样算真的做完', atSec: 68 }],
  ...over,
});

export const webKeyPoints = [{ text: '先读目标', anchor: 'goal' }, { text: '再画边界', anchor: 'scope' }, { text: '最后对验收', anchor: 'accept' }];

export const fixedRuns: Record<string, QcRun> = {
  'run-queued': baseRun({ id: 'run-queued', status: 'queued', queue: { position: 4, ahead: 3, running: 4, capacity: 4, startInSec: 100 }, stages: stagesAt('video', 0), elapsedSec: 22, remainSec: 290, estimateBasis: '最近 20 次同模板任务的中位数', scenes: scenes(() => 'waiting') }),
  'run-voicing': baseRun({ id: 'run-voicing', status: 'running', stages: stagesAt('video', 2, { progress: 42 }), elapsedSec: 440, remainSec: 90, estimateBasis: '最近 20 次同模板任务的中位数', scenes: scenes(i => (i < 2 ? 'ready' : i === 2 ? 'voicing' : 'drawn')) }),
  'run-failed': baseRun({
    id: 'run-failed', status: 'failed', stages: stagesAt('video', 2, { failed: true, failDetail: '第 4 幕配音等了 3 分钟没有返回，这一幕先停下' }), elapsedSec: 856,
    scenes: scenes(i => (i === 3 ? 'failed' : 'ready')),
    failure: { stageKey: 'voice', unitIndex: 4, message: '第 4 幕配音没有完成', saved: ['原稿与要求', '6 幕分镜与画面', '第 1–3、5–6 幕旁白与字幕'], actions: ['retry-unit', 'skip-unit'] },
  }),
  'run-timeout': baseRun({
    id: 'run-timeout', status: 'failed', stages: stagesAt('video', 1, { failed: true, failDetail: '生成超过 15 分钟没有完成，已停止；已画好的 3 幕已保存' }), elapsedSec: 900,
    scenes: scenes(i => (i < 3 ? 'drawn' : 'waiting')),
    failure: { stageKey: 'storyboard', message: '生成超时，已停止', saved: ['原稿与要求', '已画好的第 1–3 幕分镜'], actions: ['requeue', 'retry-step'] },
  }),
  'run-done': baseRun({ id: 'run-done', status: 'done', stages: stagesAt('video', 4), elapsedSec: 190, durationSec: 96, scenes: scenes(() => 'ready') }),
  'run-publish-failed': baseRun({ id: 'run-publish-failed', status: 'done', stages: stagesAt('video', 4), elapsedSec: 190, durationSec: 96, scenes: scenes(() => 'ready'), publish: { status: 'failed', error: '网页托管这次没有响应（14:21）' } }),
  'run-published': baseRun({ id: 'run-published', status: 'done', stages: stagesAt('video', 4), elapsedSec: 190, durationSec: 96, scenes: scenes(() => 'ready'), publish: { status: 'done', siteId: 'site-habits', siteTitle: '需求评审的三个习惯', at: '14:23' } }),
  'run-web-running': baseRun({ id: 'run-web-running', kind: 'web', templateId: 'tpl-guide-page', status: 'running', stages: stagesAt('web', 3, { progress: 64 }), elapsedSec: 96, remainSec: 25, estimateBasis: '最近 20 次同模板任务的中位数', sections: webSections, keyPoints: webKeyPoints, voice: undefined }),
  'run-web-done': baseRun({ id: 'run-web-done', kind: 'web', templateId: 'tpl-guide-page', status: 'done', stages: stagesAt('web', 4), elapsedSec: 128, sections: webSections, keyPoints: webKeyPoints, voice: undefined }),
};

/** 「我的作品」30 条：前几条对应上面的任务，其余用于检查长标题与数量 */
const titles = [
  '第三季度客服复盘：三条可以立刻做的改进，以及我们为什么决定暂停两项旧流程', '新版报销流程，一分钟看懂', '周会怎么开得更短', '线上故障复盘模板怎么填',
  '客户来访接待流程', '设计走查的五个检查点', '新同事第一周：账号、权限与常用工具全清单（含常见问题与找谁帮忙）', '版本发布前的检查清单',
  '如何写一份让人读得下去的周报', '数据看板指标口径说明', '会议纪要模板与示例', '跨部门协作的沟通约定', '产品术语表速览', '用户访谈怎么做记录',
  '缺陷提交的正确姿势', '年度目标拆解方法', '移动端适配常见问题', '知识库目录整理规范', '新功能上线公告写法',
  '安全意识十分钟：密码、钓鱼邮件与外部分享链接的那些坑', '代码评审礼仪', '如何申请测试环境',
];
export const works: QcWork[] = [
  { runId: 'run-voicing', title: '需求评审的三个习惯', kind: 'video', templateId: 'tpl-visual-note', status: 'running', publishStatus: 'none', summary: '配音第 3 / 6 幕', updatedAt: '刚刚' },
  { runId: 'run-web-running', title: '需求评审的三个习惯（网页版）', kind: 'web', templateId: 'tpl-guide-page', status: 'running', publishStatus: 'none', summary: '生成页面第 3 / 4 节', updatedAt: '1 分钟前' },
  { runId: 'run-queued', title: '接口命名约定（给后端新人）', kind: 'video', templateId: 'tpl-dark-notes', status: 'queued', publishStatus: 'none', summary: '排在第 4 位', updatedAt: '3 分钟前' },
  { runId: 'run-failed', title: '新版报销流程，一分钟看懂', kind: 'video', templateId: 'tpl-visual-note', status: 'failed', publishStatus: 'none', summary: '第 4 幕配音超时，已保存稿件与其余 5 幕', updatedAt: '今天 11:40' },
  { runId: 'run-timeout', title: '线上故障复盘模板怎么填', kind: 'video', templateId: 'tpl-dark-notes', status: 'failed', publishStatus: 'none', summary: '生成超时，已保存稿件与 3 幕分镜', updatedAt: '今天 09:52' },
  { runId: 'run-publish-failed', title: '周会怎么开得更短', kind: 'video', templateId: 'tpl-whiteboard', status: 'done', publishStatus: 'failed', summary: '成片可播，发布可重试', updatedAt: '今天 10:15' },
  { runId: 'run-published', title: '设计走查的五个检查点', kind: 'video', templateId: 'tpl-visual-note', status: 'done', publishStatus: 'done', summary: '1 分 22 秒 · 访问 46 次', updatedAt: '昨天 18:40' },
  { runId: 'run-web-done', title: '客户来访接待流程', kind: 'web', templateId: 'tpl-card-digest', status: 'done', publishStatus: 'none', summary: '4 节 · 适配手机', updatedAt: '昨天 16:02' },
  ...Array.from({ length: 22 }, (_, i): QcWork => {
    const kind = i % 3 === 2 ? 'web' : 'video';
    const tpl = kind === 'web' ? (i % 2 ? 'tpl-card-digest' : 'tpl-guide-page') : (['tpl-visual-note', 'tpl-whiteboard', 'tpl-dark-notes'][i % 3]);
    const published = i % 2 === 0;
    return { runId: i % 2 ? 'run-done' : 'run-published', title: titles[i % titles.length], kind, templateId: tpl, status: 'done', publishStatus: published ? 'done' : 'none',
      summary: kind === 'web' ? '4 节 · 适配手机' : `${1 + (i % 2)} 分 ${10 + i} 秒`, updatedAt: `11-${String(24 - Math.floor(i / 2)).padStart(2, '0')}` };
  }),
];
