/* 原型演示数据（虚构稿件与成员）。只用于原型，不进源码差异。实现方取证时用同一份数据（design.json demoData）。 */
import type { FrameKey, QcAsset, QcAttachment, QcQueueInfo, QcRun, QcScene, QcStage, QcTemplate, QcTemplateCategory, QcTemplateSource, QcWork, QcWebSection } from '@/pages/quick-creation-agent/types';
import catalog from './opuscar/catalog.json';

/* 风格库：分类与风格取自 Lemo-Opuscar（tools/import-opuscar.py 生成 opuscar/catalog.json 与缩小后的样片海报）。
 * 风格说明 STYLE.md 只按编号引用，不复制原文。原型里有 5 个风格配了模板代码渲染器，用来演示分镜与成片，其余显示海报。 */
const posters = import.meta.glob<string>('./opuscar/posters/*.webp', { eager: true, import: 'default' });
const FRAMES: Record<string, FrameKey> = { sketchnote: 'visual-note', whiteboard: 'whiteboard', 'dark-keynote': 'dark-notes', 'swiss-motion': 'guide-page', 'iso-infographic': 'card-digest' };
export const templateCategories: QcTemplateCategory[] = catalog.categories.map(c => ({ id: c.id, name: c.cn, nameEn: c.en }));
export const templateSource: QcTemplateSource = { name: catalog.source.name, url: catalog.source.url, posterLicense: '样片海报 CC BY 4.0' };
export const templates: QcTemplate[] = catalog.styles.map(st => ({
  id: st.slug, name: st.cn, nameEn: st.en, categoryId: st.category, posterUrl: posters[`./opuscar/posters/${st.slug}.webp`],
  film: st.film, line: st.line, durationSec: st.dur, promptRef: `styles/${st.slug}/STYLE.md`,
  ...('needsImageTool' in st && st.needsImageTool ? { needsImageTool: true } : {}),
  ...(FRAMES[st.slug] ? { frame: FRAMES[st.slug] } : {}),
}));

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
  queued: ['等待开始', '等了 12 分钟，曾排第 4 位'],
  storyboard: ['已拆成 6 幕，正在画第 4 幕的画面', '6 幕分镜已保存'],
  voice: ['正在为第 3 / 6 幕配旁白，字幕与旁白同步生成', '6 幕旁白与字幕已完成'],
  compose: ['正在混音并合成 1080p 成片', '1 分 36 秒 · 1080p'],
  done: ['', ''],
};
const webDetail: Record<string, [string, string]> = {
  queued: ['等待开始', '等了 6 分钟'],
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

/* 排队看板（虚构同事）：团队同时最多生成 4 个。正在生成的按「还需」先后空出位置，前面的人依次补上，
 * 所以第 n 位的预计开始时间 = 第 n 个空出来的位置：9、12、26、38 分钟 */
const MIN = 60;
const runningBoard = [
  { ownerName: '林夏', title: '新版 OKR 填写指南', kind: 'video' as const, elapsedSec: 31 * MIN, remainSec: 9 * MIN },
  { ownerName: '周远', title: '季度客户满意度复盘', kind: 'web' as const, elapsedSec: 22 * MIN, remainSec: 12 * MIN },
  { ownerName: '陈一帆', title: '新人入职七天路线', kind: 'video' as const, elapsedSec: 18 * MIN, remainSec: 26 * MIN },
  { ownerName: '宋知', title: '安全培训：钓鱼邮件识别', kind: 'video' as const, elapsedSec: 7 * MIN, remainSec: 38 * MIN },
];
const aheadBoard = [
  { ownerName: '何岚', title: '支付链路如何工作', kind: 'video' as const, startInSec: 9 * MIN },
  { ownerName: '林夏', title: '春节值班安排', kind: 'video' as const, startInSec: 12 * MIN },
  { ownerName: '周远', title: '产品发布会彩排要点', kind: 'video' as const, startInSec: 26 * MIN },
];
const ETA = [9, 12, 26, 38].map(m => m * MIN);
/** 排在第 position 位时的排队信息；shift 用来演示时间推进（秒） */
export function queueAt(position: number, shift = 0): QcQueueInfo {
  const p = Math.max(1, Math.min(4, position));
  return {
    position: p, ahead: p - 1, running: 4, capacity: 4, startInSec: Math.max(30, ETA[p - 1] - shift),
    runningItems: runningBoard.map(r => ({ ...r, elapsedSec: r.elapsedSec + shift, remainSec: Math.max(60, r.remainSec - shift) })),
    aheadItems: aheadBoard.slice(0, p - 1).map(a => ({ ...a, startInSec: Math.max(30, a.startInSec - shift) })),
  };
}

const now = '今天 14:02';
const baseRun = (over: Partial<QcRun>): QcRun => ({
  id: 'run', title: '需求评审的三个习惯', kind: 'video', templateId: 'sketchnote', ask: '稍微快一点，先提醒我三个重点，给新同事看',
  attachments: runAttachments, status: 'running', stages: [], elapsedSec: 0, publish: { status: 'none' }, createdAt: now, updatedAt: now, voice: '女声 · 稍快',
  keyPoints: [{ text: '先读目标：这次要解决谁的问题', atSec: 26 }, { text: '再画边界：哪些这次不做', atSec: 40 }, { text: '最后对验收：怎样算真的做完', atSec: 68 }],
  ...over,
});

export const webKeyPoints = [{ text: '先读目标', anchor: 'goal' }, { text: '再画边界', anchor: 'scope' }, { text: '最后对验收', anchor: 'accept' }];

export const fixedRuns: Record<string, QcRun> = {
  'run-queued': baseRun({ id: 'run-queued', status: 'queued', queue: queueAt(4), stages: stagesAt('video', 0), elapsedSec: 6 * MIN, remainSec: 38 * MIN + 42 * MIN, estimateBasis: '排队按前面任务的预计还需推算；出片按最近 20 次同风格任务的中位数（约 42 分钟）', scenes: scenes(() => 'waiting') }),
  'run-voicing': baseRun({ id: 'run-voicing', status: 'running', stages: stagesAt('video', 2, { progress: 42 }), elapsedSec: 22 * MIN, remainSec: 18 * MIN, estimateBasis: '最近 20 次同风格任务的中位数（约 42 分钟）', scenes: scenes(i => (i < 2 ? 'ready' : i === 2 ? 'voicing' : 'drawn')) }),
  'run-failed': baseRun({
    id: 'run-failed', status: 'failed', stages: stagesAt('video', 2, { failed: true, failDetail: '配音服务 10 分钟没有返回第 4 幕，这一幕先停下' }), elapsedSec: 38 * MIN,
    scenes: scenes(i => (i === 3 ? 'failed' : 'ready')),
    failure: { stageKey: 'voice', unitIndex: 4, message: '配音服务没有返回第 4 幕', saved: ['原稿与要求', '6 幕分镜与画面', '第 1–3、5–6 幕旁白与字幕'], actions: ['retry-unit', 'skip-unit'] },
  }),
  'run-timeout': baseRun({
    id: 'run-timeout', status: 'failed', stages: stagesAt('video', 1, { failed: true, failDetail: '这次生成用满 2 小时上限仍未完成，系统按上限停下；已画好的 3 幕已保存' }), elapsedSec: 120 * MIN,
    scenes: scenes(i => (i < 3 ? 'drawn' : 'waiting')),
    failure: { stageKey: 'storyboard', message: '用满 2 小时上限，系统已停下', saved: ['原稿与要求', '已画好的第 1–3 幕分镜'], actions: ['requeue', 'retry-step'] },
  }),
  'run-done': baseRun({ id: 'run-done', status: 'done', stages: stagesAt('video', 4), elapsedSec: 41 * MIN, durationSec: 96, scenes: scenes(() => 'ready') }),
  'run-publish-failed': baseRun({ id: 'run-publish-failed', status: 'done', stages: stagesAt('video', 4), elapsedSec: 41 * MIN, durationSec: 96, scenes: scenes(() => 'ready'), publish: { status: 'failed', error: '网页托管这次没有响应（14:21）' } }),
  'run-published': baseRun({ id: 'run-published', status: 'done', stages: stagesAt('video', 4), elapsedSec: 41 * MIN, durationSec: 96, scenes: scenes(() => 'ready'), publish: { status: 'done', siteId: 'site-habits', siteTitle: '需求评审的三个习惯', at: '14:23' } }),
  'run-web-running': baseRun({ id: 'run-web-running', kind: 'web', templateId: 'swiss-motion', status: 'running', stages: stagesAt('web', 3, { progress: 64 }), elapsedSec: 17 * MIN, remainSec: 14 * MIN, estimateBasis: '最近 20 次同风格网页任务的中位数（约 31 分钟）', sections: webSections, keyPoints: webKeyPoints, voice: undefined }),
  'run-web-done': baseRun({ id: 'run-web-done', kind: 'web', templateId: 'swiss-motion', status: 'done', stages: stagesAt('web', 4), elapsedSec: 33 * MIN, sections: webSections, keyPoints: webKeyPoints, voice: undefined }),
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
  { runId: 'run-voicing', title: '需求评审的三个习惯', kind: 'video', templateId: 'sketchnote', status: 'running', publishStatus: 'none', summary: '配音第 3 / 6 幕', updatedAt: '刚刚' },
  { runId: 'run-web-running', title: '需求评审的三个习惯（网页版）', kind: 'web', templateId: 'swiss-motion', status: 'running', publishStatus: 'none', summary: '生成页面第 3 / 4 节', updatedAt: '1 分钟前' },
  { runId: 'run-queued', title: '接口命名约定（给后端新人）', kind: 'video', templateId: 'dark-keynote', status: 'queued', publishStatus: 'none', summary: '排在第 4 位', updatedAt: '3 分钟前' },
  { runId: 'run-failed', title: '新版报销流程，一分钟看懂', kind: 'video', templateId: 'sketchnote', status: 'failed', publishStatus: 'none', summary: '配音服务没有返回第 4 幕，已保存稿件与其余 5 幕', updatedAt: '今天 11:40' },
  { runId: 'run-timeout', title: '线上故障复盘模板怎么填', kind: 'video', templateId: 'dark-keynote', status: 'failed', publishStatus: 'none', summary: '用满 2 小时上限停下，已保存稿件与 3 幕分镜', updatedAt: '今天 09:52' },
  { runId: 'run-publish-failed', title: '周会怎么开得更短', kind: 'video', templateId: 'whiteboard', status: 'done', publishStatus: 'failed', summary: '成片可播，发布可重试', updatedAt: '今天 10:15' },
  { runId: 'run-published', title: '设计走查的五个检查点', kind: 'video', templateId: 'sketchnote', status: 'done', publishStatus: 'done', summary: '1 分 22 秒 · 访问 46 次', updatedAt: '昨天 18:40' },
  { runId: 'run-web-done', title: '客户来访接待流程', kind: 'web', templateId: 'iso-infographic', status: 'done', publishStatus: 'none', summary: '4 节 · 适配手机', updatedAt: '昨天 16:02' },
  ...Array.from({ length: 22 }, (_, i): QcWork => {
    const kind = i % 3 === 2 ? 'web' : 'video';
    const tpl = kind === 'web' ? (i % 2 ? 'iso-infographic' : 'swiss-motion') : (['sketchnote', 'whiteboard', 'dark-keynote'][i % 3]);
    const published = i % 2 === 0;
    return { runId: i % 2 ? 'run-done' : 'run-published', title: titles[i % titles.length], kind, templateId: tpl, status: 'done', publishStatus: published ? 'done' : 'none',
      summary: kind === 'web' ? '4 节 · 适配手机' : `${1 + (i % 2)} 分 ${10 + i} 秒`, updatedAt: `11-${String(24 - Math.floor(i / 2)).padStart(2, '0')}` };
  }),
];

/* 产物（已生成的成品）：「我的」来自上面已完成的作品；「团队」再加几位同事用其他风格做的（人名与标题均为虚构） */
const team: Array<[string, string, QcAsset['kind'], string, string]> = [
  ['林夏', '新版 OKR 填写指南', 'video', 'ink-wash', '今天 15:02'],
  ['周远', '季度客户满意度复盘', 'web', 'dataviz', '今天 13:40'],
  ['陈一帆', '新人入职七天路线', 'video', 'transit-map', '今天 11:18'],
  ['何岚', '支付链路如何工作', 'video', 'blueprint', '昨天 20:05'],
  ['林夏', '春节值班安排', 'video', 'papercut-red', '昨天 17:31'],
  ['周远', '产品发布会彩排要点', 'video', 'dark-keynote', '昨天 16:12'],
  ['何岚', '数据库迁移步骤', 'web', 'iso-infographic', '11-24'],
  ['陈一帆', '游戏化积分规则说明', 'video', 'pixel-rpg', '11-24'],
  ['宋知', '安全培训：钓鱼邮件识别', 'video', 'chalkboard', '11-23'],
  ['宋知', '一线门店陈列规范', 'web', 'watercolor', '11-22'],
];
export const assets: QcAsset[] = [
  ...works.filter(w => w.status === 'done').map((w, i): QcAsset => ({
    id: `a-m${i + 1}`, runId: `asset-a-m${i + 1}`, title: w.title, kind: w.kind, templateId: w.templateId,
    ...(w.kind === 'video' ? { durationSec: 62 + ((i * 17) % 58) } : { sections: 4 }),
    ownerName: '我', mine: true, publishStatus: w.publishStatus, ...(w.publishStatus === 'done' ? { siteId: `site-a-m${i + 1}` } : {}), updatedAt: w.updatedAt,
  })),
  ...team.map(([owner, title, kind, tpl, at], i): QcAsset => ({
    id: `a-t${i + 1}`, runId: `asset-a-t${i + 1}`, title, kind, templateId: tpl, ...(kind === 'video' ? { durationSec: 48 + i * 7 } : { sections: 5 }),
    ownerName: owner, mine: false, publishStatus: i % 3 === 2 ? 'none' : 'done', ...(i % 3 === 2 ? {} : { siteId: `site-a-t${i + 1}` }), updatedAt: at,
  })),
];
