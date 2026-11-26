// 生成 design.json（画面、验收项、目标）。画面与验收是同一份数据的两面，用脚本写，避免手改 JSON 时编号对不上。
//   node tools/manifest-src.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const Q = '/quick-creation-agent';
const both = ['light', 'dark'];
const D = ['desktop-light', 'desktop-dark'];
const P = ['phone-light', 'phone-dark'];
const ALL = [...D, ...P];
const ready = s => `[data-qc-ready=${s}]`;
const ADD6 = ['[data-qc=sample-doc]', '[data-qc=pick-knowledge]', '[data-qc=pick-knowledge]', '[data-qc=pick-knowledge]', '[data-qc=pick-knowledge]', '[data-qc=pick-knowledge]'];

const screens = [
  { id: 'compose', name: '空态与选中模板（视频）', route: `#${Q}`, viewport: 'desktop', themes: both, entryReadySelector: ready('compose') },
  { id: 'compose-web', name: '产出切到网页', route: `#${Q}`, viewport: 'desktop', themes: both, entryReadySelector: ready('compose'), entryActions: ['[aria-label=选择产出] button:nth-child(2)'] },
  { id: 'attachments', name: '多附件 · 收起（读取中与失败）', route: `#${Q}`, viewport: 'desktop', themes: both, entryReadySelector: '[data-qc=attachment-tray]', entryActions: ADD6 },
  { id: 'attachments-expanded', name: '多附件 · 展开管理', route: `#${Q}`, viewport: 'desktop', themes: both, entryReadySelector: '[data-qc=attachment-list]', entryActions: [...ADD6.slice(0, 5), '[data-qc=tray-toggle]'] },
  { id: 'queued', name: '已提交 · 排队中', route: `#${Q}?run=run-queued`, viewport: 'desktop', themes: both, entryReadySelector: ready('run-queued') },
  { id: 'generating', name: '生成中 · 配音（返回同一任务）', route: `#${Q}?run=run-voicing`, viewport: 'desktop', themes: both, entryReadySelector: ready('run-running') },
  { id: 'failed-scene', name: '单幕失败 · 只重做这一幕', route: `#${Q}?run=run-failed`, viewport: 'desktop', themes: both, entryReadySelector: ready('run-failed') },
  { id: 'timeout', name: '整条超时 · 保留已完成部分', route: `#${Q}?run=run-timeout`, viewport: 'desktop', themes: both, entryReadySelector: ready('run-failed') },
  { id: 'done-video', name: '成片 · 有声播放、字幕与重点', route: `#${Q}?run=run-done`, viewport: 'desktop', themes: both, entryReadySelector: '[data-qc=video-player]' },
  { id: 'publish-failed', name: '发布失败 · 成片仍可播', route: `#${Q}?run=run-publish-failed`, viewport: 'desktop', themes: both, entryReadySelector: '[data-qc=publish-failed]' },
  { id: 'published', name: '发布成功', route: `#${Q}?run=run-published`, viewport: 'desktop', themes: both, entryReadySelector: '[data-qc=published]' },
  { id: 'hosting', name: '网页托管里定位到这条记录', route: '#/web-pages?focusSite=site-run-published', viewport: 'desktop', themes: both, entryReadySelector: ready('hosting') },
  { id: 'attachment-review', name: '发送后的附件回看', route: `#${Q}?run=run-done`, viewport: 'desktop', themes: both, entryReadySelector: '[data-qc=attachment-review]', entryActions: ['[data-qc=open-all-attachments]'] },
  { id: 'web-generating', name: '网页 · 生成中（大纲逐节）', route: `#${Q}?run=run-web-running`, viewport: 'desktop', themes: both, entryReadySelector: ready('run-running') },
  { id: 'web-done', name: '网页 · 已生成（桌面 / 手机预览）', route: `#${Q}?run=run-web-done`, viewport: 'desktop', themes: both, entryReadySelector: '[data-qc=web-preview]' },
  { id: 'works', name: '我的作品（30 条）', route: `#${Q}?view=works`, viewport: 'desktop', themes: both, entryReadySelector: ready('works') },
  { id: 'toolbox', name: '百宝箱入口卡片', route: '#/ai-toolbox', viewport: 'desktop', themes: both, entryReadySelector: ready('toolbox') },
  { id: 'phone-compose', name: '手机 · 创作（多附件）', route: `#${Q}`, viewport: 'phone', themes: both, entryReadySelector: '[data-qc=attachment-tray]', entryActions: ADD6.slice(0, 5) },
  { id: 'phone-queued', name: '手机 · 排队中', route: `#${Q}?run=run-queued`, viewport: 'phone', themes: both, entryReadySelector: ready('run-queued') },
  { id: 'phone-preview', name: '手机 · 预览成片', route: `#${Q}?run=run-published`, viewport: 'phone', themes: both, entryReadySelector: '[data-qc=video-player]', entryActions: ['.overflow-x-auto.border-b > button:nth-child(2)'] },
  { id: 'phone-works', name: '手机 · 我的作品（长标题）', route: `#${Q}?view=works`, viewport: 'phone', themes: both, entryReadySelector: ready('works') },
  { id: 'concept-settings', name: '未来 · 设置概念稿（不在快捷版实现）', route: '#/concept/settings', viewport: 'desktop', themes: both, entryReadySelector: ready('concept-settings') },
  { id: 'concept-studio', name: '未来 · 逐幕调整概念稿（不在快捷版实现）', route: '#/concept/studio', viewport: 'desktop', themes: both, entryReadySelector: ready('concept-studio') },
];

/* [编号, 框架规则, 画面, 方式, 视口, 规则, 预期] */
const rows = [
  ['A-01', 'R-01', 'compose', 'measure', ALL, '页面挂在正式 AppShell 里，左侧导航来自服务端菜单目录', '检查：原型 DOM 里有 AppShell 的侧栏与主区，快速创作页在主区内渲染'],
  ['A-02', 'R-02', 'compose', 'measure', D, '页面组件只用 tokens.css 语义变量；作品配色只在模板画面组件里', '检查：pages/quick-creation-agent 下除 TemplateFrames.tsx 外，十六进制与 rgb 字面量为 0'],
  ['A-03', 'R-03', 'done-video', 'measure', D, '白天与黑天都可读', '检查：两个主题下 --text-primary、--text-secondary 与 --bg-base 的对比度都不低于 4.5'],
  ['A-04', 'R-04', 'compose', 'measure', D, '图标只用 lucide-react，界面与源码不出现 emoji', '检查：新增源码与渲染文本里 emoji 为 0'],
  ['A-05', 'R-05', 'done-video', 'human', D, '每一屏只有一个 primary 主动作', '逐画面数：空态只有「快捷生成」，已生成只有「发布到网页托管」，失败只有恢复主按钮，作品列表只有「新建」'],
  ['A-06', 'R-06', 'phone-compose', 'measure', P, '手机两栏改成「创作 / 预览」切换，375 宽没有整页横向溢出，本页新增的可点元素触控高度不小于 44px', '检查：375 宽下 document.scrollWidth 等于视口宽；快速创作页内未标 data-qc-touch-exempt（公共组件 SegmentedTabs）的可点元素高度 ≥ 44', { probe: { type: 'horizontal-overflow' } }],
  ['A-07', 'R-07', 'toolbox', 'measure', D, '在 navRegistry 注册 /quick-creation-agent（section: toolbox，wip: true），百宝箱有入口卡片', '检查：navRegistry 改动副本里有该路由与 wip: true；toolboxStore 有 builtin-quick-creation'],
  ['A-08', 'R-08', 'generating', 'human', D, '生成显示当前阶段、进度、已用与预计剩余；离开页面不取消，回来是同一个任务', '从提交到完成逐阶段截图；生成中离开，从作品列表点回，地址 ?run= 不变、阶段继续'],
  ['A-09', 'R-09', 'failed-scene', 'human', D, '错误先说结果和恢复动作，不出现内部诊断', '逐个错误态核对：附件读取失败、单幕失败、超时、发布失败，每条都写「已保存什么 + 下一步」'],
  ['A-10', 'R-10', 'compose', 'measure', D, '请求走 services/real 与 apiRequest；附件上传用直接 fetch + FormData', '检查：services/real/quickCreation.ts 只经 apiRequest 发 JSON 请求，只有附件上传用 fetch'],
  ['A-11', null, 'compose', 'screenshot', D, '首屏：产出（视频 / 网页）、模板卡与快捷生成在一屏内；模板缩略图是真实成品帧，选中态唯一', '1440×900 首屏同时看到产出切换、模板卡、输入框与「快捷生成」；只有一张模板卡带选中边框'],
  ['A-12', null, 'compose', 'measure', D, '没有可用稿件时不能生成，原因写在按钮下方', '检查：没有附件时 [data-qc=submit] 为 disabled，且 [data-qc=block-reason] 可见'],
  ['A-13', null, 'attachments', 'human', D, '项目名默认取第一份稿件的标题，没有稿件时为「未命名 · 模板名」', '放入「需求评审的三个习惯.md」后标题变为「需求评审的三个习惯」'],
  ['A-14', null, 'attachments', 'measure', D, '附件再多，收起时托盘也只占一行胶囊：一行摘要（数量、字数、读取中、失败）+ 最多两个胶囊 + 「+N」', '检查：6 个附件时托盘高度 ≤ 88px，摘要行不折行，胶囊不超过 2 个且有「+N」'],
  ['A-15', null, 'attachments-expanded', 'screenshot', D, '读取失败的附件排在最前、用错误色，写明原因与恢复动作，可单项重试或移除', '展开后第一组是「读取失败」，含原因文字、「重试」与移除按钮'],
  ['A-16', null, 'attachments-expanded', 'measure', D, '展开列表限高可滚动，按稿件 / 知识库文档 / 图片分组，底部显示文字预算与附件上限', '检查：[data-qc=attachment-list] 最大高度 232px；分组标题含数量；底部写「文字 x / 20,000 · 附件 n / 10」'],
  ['A-17', null, 'attachments', 'human', D, '有附件在读取时不能生成，读完自动可用；失败项不会用于生成', '按钮下方写「还有附件在读取，读完即可生成」；失败组标注「不会用于生成」'],
  ['A-18', null, 'attachment-review', 'screenshot', D, '发送后附件收成一行（前两个 + 「全部 N 个附件」），点开在右栏按类型回看原文，可回到预览', '右栏出现附件分组列表与原文，顶部有「回到预览」'],
  ['A-19', null, 'queued', 'human', D, '提交后先确认稿件和要求已保存，说明离开也会继续', '左栏消息下方第一张卡写「稿件和要求已保存。生成在后台进行，离开页面也会继续。」'],
  ['A-20', null, 'queued', 'screenshot', D, '排队显示位置、前面几个、预计开始时间，并明确排队不是失败', '排队卡写「排队中 · 第 4 位」「前面 3 个，约 1 分 40 秒后开始」与「排队不是失败」'],
  ['A-21', null, 'generating', 'screenshot', D, '生成中写出当前阶段在做什么、阶段进度、已用与预计剩余，以及预计依据', '配音阶段有说明、进度条、「已用 7 分 20 秒 · 预计还需约 1 分 30 秒」和「预计依据」'],
  ['A-22', null, 'generating', 'screenshot', D, '分镜逐幕亮起，区分正在画、待配音、配音中、已完成、没有完成', '右栏 6 幕各带状态标签，配音中的一幕描边强调'],
  ['A-23', null, 'works', 'human', D, '离开后在作品列表看到任务仍在进行，点它回到同一个任务', '作品列表第一组是进行中的任务，点开回到 ?run=<编号> 的同一任务'],
  ['A-24', null, 'failed-scene', 'screenshot', D, '单幕失败只标出失败的那一幕，写明已保存的内容，主按钮只重做这一幕', '第 4 幕红框；失败卡写「已保存：原稿与要求、6 幕分镜与画面、其余旁白」，主按钮「重试第 4 幕」'],
  ['A-25', null, 'timeout', 'screenshot', D, '整条超时是失败状态，保留稿件与已生成的分镜，给出从断点继续的动作', '失败卡写「生成超时，已停止」和已保存的 3 幕，主按钮「重新排队，从这里继续」'],
  ['A-26', null, 'done-video', 'human', D, '成片播放器播放真实的视频文件和音轨：播放 / 暂停、上一幕 / 下一幕、拖动进度、静音、字幕开关、全屏，进度条上有重点刻度', '点播放后画面与声音都在走；字幕随幕切换；关字幕后字幕按钮为未按下、画面不再显示字幕'],
  ['A-27', null, 'done-video', 'human', D, '片头预告的重点可点击，跳到对应时间并开始播放', '点「再画边界」后时间到 0:40，当前重点卡描边'],
  ['A-28', null, 'done-video', 'screenshot', D, '完成后过程收成一行，注意力给成品与发布', '左栏显示「排队 → 分镜 → 配音 → 合成 全部完成 · 用时」一行，可展开；主按钮是「发布到网页托管」'],
  ['A-29', null, 'publish-failed', 'screenshot', D, '发布失败时成品仍可播放，说明重试只上传、不会重新生成，可重试', '失败卡含原因、「重试只上传，不会重新生成」与「重试发布」，右栏播放器可用'],
  ['A-30', null, 'published', 'human', D, '发布成功给「在网页托管中查看」，进入网页托管后定位并高亮这条记录', '点按钮进入 /web-pages?focusSite=<站点编号>，对应卡片高亮（复用 WebPagesPage 已有的 focusSite）'],
  ['A-31', null, 'done-video', 'screenshot', D, '成品可追溯：原稿、模板、配音写在预览上方，原稿可点开回看', '预览标题右侧有「原稿 · n 个附件」「模板 · 视觉笔记」「配音 · 女声 · 稍快」'],
  ['A-32', null, 'web-done', 'human', D, '网页产出：生成中大纲逐节出现；完成后可切桌面 / 手机预览，重点点击定位到对应一节', '网页生成中右栏列出 4 节；完成后点「再画边界」，对应一节高亮'],
  ['A-33', null, 'done-video', 'human', D, '同一份稿件可一键改做另一种产出，稿件与要求自动带回', '点「用这份稿件做网页」回到创作，附件与要求已填好，产出切到网页'],
  ['A-34', null, 'works', 'screenshot', ALL, '作品列表：按状态筛选；标题桌面一行、手机两行截断；状态与时间在第二行；30 条稳定', '30 条作品逐行高度一致，长标题省略，不撑破行；状态标签不折行'],
  ['A-35', null, 'phone-compose', 'screenshot', P, '手机上「创作 / 预览」切换，输入框与「快捷生成」在底部可达', '390×844 下底部可见输入框、附件托盘与「快捷生成」'],
  ['A-36', null, 'phone-queued', 'screenshot', P, '手机头部的状态不挤压标题', '状态标签在标题上方一行，标题完整一行显示'],
  ['A-37', null, 'phone-preview', 'screenshot', P, '手机播放器进度条单独一行，控件不换到第三行', '进度条在上，按钮一行排完'],
  ['A-38', null, 'toolbox', 'screenshot', D, '百宝箱里是一张独立的「快速创作」入口卡片，带开发中标记', '卡片名、简介与「开发中」标记可见，点击进入快速创作'],
  ['A-39', null, 'compose-web', 'screenshot', D, '切到网页后只显示网页模板，产出标签与主按钮旁的标记同步', '模板变为「导读长页」「卡片速览」，输入框下方标记为「网页 · 导读长页」'],
  ['A-40', null, 'hosting', 'screenshot', D, '网页托管里新发布的记录高亮，并提示默认可见范围', '高亮卡片带「刚刚发布」，右下提示「默认仅团队成员可看」'],
  ['A-41', null, 'compose', 'human', D, '直接粘贴正文：一次粘贴 300 字以上的长文自动作为一份稿件附件，输入框只留给要求', '粘贴后输入框清空，附件托盘多一份「粘贴的正文」，快捷生成可用'],
  ['A-42', null, 'compose', 'human', D, '上传 Markdown / TXT 稿件或图片：读出文字的可直接生成，空文件或不支持的格式显示原因', '上传「评审要点.md」后附件托盘出现该文件且显示已读取，快捷生成可用'],
];

/* 关键操作：CDS 交接检查按 handoff.cases 实际执行 */
const INTERACTIVE = new Set(['A-12', 'A-15', 'A-17', 'A-18', 'A-19', 'A-20', 'A-23', 'A-24', 'A-25', 'A-26', 'A-27', 'A-29', 'A-30', 'A-32', 'A-33', 'A-39', 'A-40', 'A-41', 'A-42']);
const acceptance = rows.map(([id, ruleId, screenId, how, slots, rule, expected, extra]) => ({ id, ...(ruleId ? { ruleId } : {}), screenId, how, slots, rule, expected, ...(extra ?? {}), ...(INTERACTIVE.has(id) ? { interaction: true } : {}) }));

/* 可运行场景：每个从进入画面开始、以结果检查结束；失败恢复先 remember 已完成的状态，再用 sameAs 核对保留。
 * 字段与 CDS 发布接口一致：expect 的字面值用 equals；media-playing / audio-playing 是 expect 的检查方式。 */
const SAMPLE_PASTE = '# 新同事入职第一周\n' + '第一天先领账号与权限，第二天熟悉知识库目录，第三天旁听一次需求评审，第四天提一个小改动，第五天写一份周小结。'.repeat(8);
const cases = [
  { id: 'submit-sample-doc', title: '用示例稿件快捷生成，提交后看到已保存与排队', screenId: 'compose', theme: 'light', ruleIds: ['A-12', 'A-19', 'A-20'], steps: [
    { action: 'expect', selector: '[data-qc=block-reason]', check: 'visible' },
    { action: 'click', selector: '[data-qc=sample-doc]' },
    { action: 'expect', selector: '[data-qc=submit]', check: 'enabled' },
    { action: 'click', selector: '[data-qc=submit]' },
    { action: 'expect', selector: '[data-qc=saved-notice]', check: 'visible' },
    { action: 'expect', selector: '[data-qc=queue-card]', check: 'visible' },
  ] },
  { id: 'submit-pasted-text', title: '粘贴长正文成为稿件附件后生成', screenId: 'compose', theme: 'light', ruleIds: ['A-41'], steps: [
    { action: 'fill', selector: '#qc-ask', value: SAMPLE_PASTE },
    { action: 'expect', selector: '#qc-ask', check: 'value', equals: '' },
    { action: 'expect', selector: '[data-qc=attachment-tray]', check: 'attribute', attribute: 'data-count', equals: '1' },
    { action: 'expect', selector: '[data-qc=submit]', check: 'enabled' },
    { action: 'click', selector: '[data-qc=submit]' },
    { action: 'expect', selector: '[data-qc=queue-card]', check: 'visible' },
  ] },
  { id: 'submit-uploaded-file', title: '上传 Markdown 稿件后生成', screenId: 'compose', theme: 'light', ruleIds: ['A-42'], steps: [
    { action: 'attach', selector: '[data-qc=file-input]', name: '评审要点.md', value: '# 评审要点\n先读目标，再画边界，最后对验收。' },
    { action: 'expect', selector: '[data-qc=attachment-tray]', check: 'attribute', attribute: 'data-count', equals: '1' },
    { action: 'expect', selector: '[data-qc=submit]', check: 'enabled' },
    { action: 'click', selector: '[data-qc=submit]' },
    { action: 'expect', selector: '[data-qc=queue-card]', check: 'visible' },
  ] },
  { id: 'retry-failed-attachment', title: '读取失败的附件单项重试，其它附件保持不变', screenId: 'attachments-expanded', theme: 'light', ruleIds: ['A-15', 'A-17'], steps: [
    { action: 'remember', selector: '[data-att-id=att-doc-habits]', check: 'attribute', attribute: 'data-att-status', as: 'habits' },
    { action: 'expect', selector: '[data-att-id=att-doc-minutes]', check: 'attribute', attribute: 'data-att-status', equals: 'failed' },
    { action: 'click', selector: '[data-att-id=att-doc-minutes] [data-qc=att-retry]' },
    { action: 'expect', selector: '[data-att-id=att-doc-minutes]', check: 'attribute', attribute: 'data-att-status', equals: 'ready' },
    { action: 'expect', selector: '[data-att-id=att-doc-habits]', check: 'attribute', attribute: 'data-att-status', sameAs: 'habits' },
    { action: 'expect', selector: '[data-qc=attachment-tray]', check: 'attribute', attribute: 'data-failed-count', equals: '0' },
  ] },
  { id: 'remove-failed-attachment', title: '移除读取失败的附件', screenId: 'attachments-expanded', theme: 'dark', ruleIds: ['A-15'], steps: [
    { action: 'remember', selector: '[data-att-id=att-doc-habits]', check: 'attribute', attribute: 'data-att-status', as: 'habits' },
    { action: 'click', selector: '[data-att-id=att-doc-minutes] [data-qc=att-remove]' },
    { action: 'expect', selector: '[data-qc=attachment-tray]', check: 'attribute', attribute: 'data-failed-count', equals: '0' },
    { action: 'expect', selector: '[data-att-id=att-doc-habits]', check: 'attribute', attribute: 'data-att-status', sameAs: 'habits' },
  ] },
  { id: 'leave-and-return', title: '排队中离开，从作品列表回到同一任务', screenId: 'queued', theme: 'light', ruleIds: ['A-23'], steps: [
    { action: 'remember', selector: '[data-qc-ready]', check: 'attribute', attribute: 'data-run-id', as: 'task' },
    { action: 'click', selector: '[data-qc=leave]' },
    { action: 'expect', selector: '[data-qc=works]', check: 'visible' },
    { action: 'click', selector: '[data-qc=works] [data-run-id=run-queued]' },
    { action: 'expect', selector: '[data-qc-ready]', check: 'attribute', attribute: 'data-run-id', sameAs: 'task' },
    { action: 'expect', selector: '[data-qc=queue-card]', check: 'visible' },
  ] },
  { id: 'retry-failed-scene', title: '单幕配音失败只重做这一幕，其余幕保留，任务回到配音阶段', screenId: 'failed-scene', theme: 'light', ruleIds: ['A-24'], steps: [
    { action: 'remember', selector: '[data-scene="1"]', check: 'attribute', attribute: 'data-scene-status', as: 'scene1' },
    { action: 'expect', selector: '[data-scene="4"]', check: 'attribute', attribute: 'data-scene-status', equals: 'failed' },
    { action: 'click', selector: '[data-qc=recover-primary]' },
    { action: 'expect', selector: '[data-scene="4"]', check: 'attribute', attribute: 'data-scene-status', equals: 'voicing' },
    { action: 'expect', selector: '[data-scene="1"]', check: 'attribute', attribute: 'data-scene-status', sameAs: 'scene1' },
    /* 结果：任务回到生成中、配音阶段重新进行（真实的重做要几分钟，成片出现由 play-film 场景覆盖） */
    { action: 'expect', selector: '[data-qc-ready]', check: 'attribute', attribute: 'data-qc-ready', equals: 'run-running' },
    { action: 'expect', selector: '[data-stage=voice]', check: 'attribute', attribute: 'data-stage-status', equals: 'running' },
  ] },
  { id: 'requeue-after-timeout', title: '整条超时后重新排队，已画好的幕保留', screenId: 'timeout', theme: 'light', ruleIds: ['A-25'], steps: [
    { action: 'remember', selector: '[data-scene="3"]', check: 'attribute', attribute: 'data-scene-status', as: 'scene3' },
    { action: 'click', selector: '[data-qc=recover-primary]' },
    { action: 'expect', selector: '[data-qc=queue-card]', check: 'visible' },
    { action: 'expect', selector: '[data-scene="3"]', check: 'attribute', attribute: 'data-scene-status', sameAs: 'scene3' },
  ] },
  { id: 'play-film', title: '播放成片：画面与声音在走，重点跳转与字幕开关', screenId: 'done-video', theme: 'light', ruleIds: ['A-26', 'A-27'], steps: [
    { action: 'click', selector: '[data-qc=play-toggle]' },
    { action: 'expect', selector: '[data-qc=film]', check: 'media-playing' },
    { action: 'expect', selector: '[data-qc=film]', check: 'audio-playing' },
    { action: 'click', selector: '[data-qc=key-point-2]' },
    { action: 'expect', selector: '[data-qc=video-player]', check: 'attribute', attribute: 'data-scene-index', equals: '4' },
    { action: 'click', selector: '[data-qc=captions-toggle]' },
    { action: 'expect', selector: '[data-qc=captions-toggle]', check: 'attribute', attribute: 'aria-pressed', equals: 'false' },
  ] },
  { id: 'publish-retry-to-hosting', title: '发布失败后成片仍可播，重试成功并落到网页托管记录', screenId: 'done-video', theme: 'dark', ruleIds: ['A-29', 'A-30', 'A-40'], steps: [
    { action: 'click', selector: '[data-qc=publish]' },
    { action: 'expect', selector: '[data-qc=publish-failed]', check: 'visible' },
    { action: 'expect', selector: '[data-qc=play-toggle]', check: 'enabled' },
    { action: 'click', selector: '[data-qc=publish-retry]' },
    { action: 'expect', selector: '[data-qc=published]', check: 'visible' },
    { action: 'click', selector: '[data-qc=open-hosting]' },
    { action: 'expect', selector: '[data-qc=focused-site]', check: 'visible' },
  ] },
  { id: 'web-key-point', title: '网页成品：重点定位到对应一节', screenId: 'web-done', theme: 'light', ruleIds: ['A-32'], steps: [
    { action: 'click', selector: '[data-qc=web-point-2]' },
    { action: 'expect', selector: '[data-qc=web-preview]', check: 'attribute', attribute: 'data-active-anchor', equals: 'scope' },
  ] },
  { id: 'redo-as-web', title: '用同一份稿件改做网页，稿件与要求带回', screenId: 'done-video', theme: 'light', ruleIds: ['A-33', 'A-39'], steps: [
    { action: 'click', selector: '[data-qc=redo-other]' },
    { action: 'expect', selector: '[data-qc-ready]', check: 'attribute', attribute: 'data-output', equals: 'web' },
    { action: 'expect', selector: '[data-qc=submit]', check: 'enabled' },
  ] },
  { id: 'review-sent-attachments', title: '回看已发送的附件并回到预览', screenId: 'done-video', theme: 'light', ruleIds: ['A-18'], steps: [
    { action: 'click', selector: '[data-qc=open-all-attachments]' },
    { action: 'expect', selector: '[data-qc=attachment-review]', check: 'visible' },
    { action: 'click', selector: '[data-qc=review-back]' },
    { action: 'expect', selector: '[data-qc=video-player]', check: 'visible' },
  ] },
];
const goals = [
  { id: 'G-01', goal: '一份文档 + 一个模板，最快路径得到成品', doneWhen: '首次打开即可选产出与模板，用示例、上传、知识库或粘贴放进稿件并快捷生成；没有稿件时按钮不可用且说明原因', items: ['A-11', 'A-12', 'A-13', 'A-39', 'A-41', 'A-42'] },
  { id: 'G-02', goal: '附件再多也清楚、不堆一大把', doneWhen: '收起时只占一行，展开可分组管理，失败项单独处理；发送后可回看', items: ['A-14', 'A-15', 'A-16', 'A-17', 'A-18'] },
  { id: 'G-03', goal: '团队集中提交时，排队、后台继续和恢复都看得见', doneWhen: '排队写位置与预计开始；生成写阶段、进度与剩余；离开后能回到同一任务', items: ['A-19', 'A-20', 'A-21', 'A-22', 'A-23'] },
  { id: 'G-04', goal: '失败时保住已有工作，并给出明确的恢复入口', doneWhen: '单幕失败只重做那一幕；超时保留已完成部分并从断点继续', items: ['A-24', 'A-25'] },
  { id: 'G-05', goal: '成品能播、能发布、能追溯', doneWhen: '有声播放器带字幕与重点；发布失败可重试且成品仍可播；发布成功定位到网页托管记录', items: ['A-26', 'A-27', 'A-28', 'A-29', 'A-30', 'A-31', 'A-33', 'A-40'] },
  { id: 'G-06', goal: '同一入口同时支持生成视频与生成网页', doneWhen: '产出切到网页后模板、过程与预览都换成网页形态', items: ['A-32'] },
  { id: 'G-07', goal: '手机上创作与预览都可用', doneWhen: '390 宽下切换创作 / 预览，底部动作可达，头部与播放器不挤压，30 条作品稳定', items: ['A-34', 'A-35', 'A-36', 'A-37'] },
  { id: 'G-08', goal: '作为独立智能体进入 MAP', doneWhen: '百宝箱有独立入口卡片，路由按 navRegistry 注册并带 wip', items: ['A-38'] },
  { id: 'G-09', goal: '未来的逐幕深入创作（本稿只给概念稿，不交接实现）', doneWhen: '开放前另起稿件：设置面板、逐幕编辑与版本、模板库分类', items: [], where: '后续稿件 map/quick-creation-studio；本稿画面 concept-settings、concept-studio 仅作方向参考' },
];

const manifest = {
  project: 'prd-agent',
  title: 'MAP 快速创作',
  group: 'MAP · 创作',
  framework: 'FW-MAP-ADMIN',
  frameworkVersion: 1,
  prototypeVersion: 4,
  date: new Date().toISOString().slice(0, 10),
  rationale: '思路.md',
  prototype: 'dist/index.html',
  checks: 'checks/result.json',
  source: 'src',
  docs: ['设计文档/源码差异.diff', '设计文档/目标与验收.md', '设计文档/演示数据.json', 'spec/rules.md'],
  notes: '快捷版：一份文档 + 一个模板 → 视频或网页，发布到网页托管。未来逐幕创作只给概念稿（concept-*），不交接实现。演示数据见 设计文档/演示数据.json（虚构稿件与成员），原型与实现取证共用。',
  /* 演示数据：CDS 发布接口当前不接受 demoData 字段，数据文件放进 docs（原型与实现取证共用这一份） */
  screens: screens.map(s => ({ ...s, impl: null })),
  acceptance,
  goals,
  handoff: { cases },
};
writeFileSync(path.join(dir, 'design.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ screens: screens.length, acceptance: acceptance.length, goals: goals.length }));
