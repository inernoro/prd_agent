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
  { id: 'style-picker', name: '输入框里就地换风格（15 类 99 种）', route: `#${Q}`, viewport: 'desktop', themes: both, entryReadySelector: '[data-qc=style-popover]', entryActions: ['[data-qc=style-chip]'] },
  { id: 'assets', name: '右栏产物：回看我生成过的视频与网页', route: `#${Q}`, viewport: 'desktop', themes: both, entryReadySelector: '[data-qc=asset-detail]', entryActions: ['[aria-label=选择与资产] button:nth-child(2)'] },
  { id: 'assets-team', name: '右栏产物 · 团队：同事用其他风格做的成品', route: `#${Q}`, viewport: 'desktop', themes: both, entryReadySelector: '[data-qc=asset-library][data-scope=team] [data-qc=asset-detail]', entryActions: ['[aria-label=选择与资产] button:nth-child(2)', '[aria-label=产物范围] button:nth-child(2)'] },
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
  { id: 'phone-preview', name: '手机 · 预览成片', route: `#${Q}?run=run-published`, viewport: 'phone', themes: both, entryReadySelector: '[data-qc=video-player]', entryActions: ['[aria-label=对话与预览] button:nth-child(2)'] },
  { id: 'phone-assets', name: '手机 · 预览页签里的产物', route: `#${Q}`, viewport: 'phone', themes: both, entryReadySelector: '[data-qc=asset-detail]', entryActions: ['[aria-label=对话与预览] button:nth-child(2)', '[aria-label=选择与资产] button:nth-child(2)'] },
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
  ['A-11', null, 'compose', 'screenshot', D, '首屏：左栏是助手开场与输入框（含产出切换与风格按钮），右栏是风格库：选中风格的大图与说明在上，按类别浏览全部风格在下；选中态唯一', '1440×900 首屏同时看到左栏的开场、输入框里的「视频 / 网页」与风格按钮、「快捷生成」，右栏的风格大图、样片说明、类别行与风格卡'],
  ['A-12', null, 'compose', 'measure', D, '没有可用稿件时不能生成，原因写在按钮下方', '检查：没有附件时 [data-qc=submit] 为 disabled，且 [data-qc=block-reason] 可见'],
  ['A-13', null, 'attachments', 'human', D, '项目名默认取第一份稿件的标题，没有稿件时为「未命名 · 风格名」', '放入「需求评审的三个习惯.md」后标题从「未命名 · 视觉笔记」变为「需求评审的三个习惯」'],
  ['A-14', null, 'attachments', 'measure', D, '附件再多，输入框顶部也只占一块：一行摘要（份数、字数、读取中、失败）+ 最多两张资料卡 + 「+N」，管理在右栏', '检查：6 个附件时托盘高度 ≤ 88px，摘要行不折行，资料卡不超过 2 张且有「+N」'],
  ['A-15', null, 'attachments-expanded', 'screenshot', D, '读取失败的附件排在最前、用错误色，写明原因与恢复动作，可单项重试或移除', '展开后第一组是「读取失败」，含原因文字、「重试」与移除按钮'],
  ['A-16', null, 'attachments-expanded', 'measure', D, '资料管理在右栏面板：按读取失败 / 稿件 / 知识库文档 / 图片分组，列表区内部滚动，右侧看正文，底部显示文字预算与附件上限', '检查：[data-qc=attachment-list] 在预览栏内且 overflow-y 为 auto；分组标题含数量；底部写「文字 x / 20,000 · 附件 n / 10」'],
  ['A-17', null, 'attachments', 'human', D, '有附件在读取时不能生成，读完自动可用；失败项不会用于生成', '按钮下方写「还有附件在读取，读完即可生成」；失败组标注「不会用于生成」'],
  ['A-18', null, 'attachment-review', 'screenshot', D, '发送后资料收在你的消息气泡里（两张资料卡 + 「全部 N 份」），点开在右栏按类型回看原文，可回到预览', '右栏出现资料分组列表与原文，顶部有「回到预览」'],
  ['A-19', null, 'queued', 'human', D, '提交后先确认稿件和要求已保存，说明离开也会继续', '左栏消息下方第一张卡写「稿件和要求已保存。生成在后台进行，离开页面也会继续。」'],
  ['A-20', null, 'queued', 'screenshot', D, '排队显示位置、前面几个、预计开始时间，并明确排队不是失败', '排队卡写「排队中 · 第 4 位」「前面 3 个，约 1 分 40 秒后开始」与「排队不是失败」'],
  ['A-21', null, 'generating', 'screenshot', D, '生成中写出当前阶段在做什么、阶段进度、已用与预计剩余，以及预计依据', '配音阶段有说明、进度条、「已用 7 分 20 秒 · 预计还需约 1 分 30 秒」和「预计依据」'],
  ['A-22', null, 'generating', 'screenshot', D, '生成中右栏是作品本身在生长：当前这一幕放大显示（配音中带声波与正在配的字幕），下方分镜胶片逐幕亮起，区分正在画、待配音、配音中、已完成、没有完成', '右栏大画面为第 3 幕并标「配音中」，下方 6 幕各带状态，当前幕描边'],
  ['A-23', null, 'works', 'human', D, '离开后在作品列表看到任务仍在进行，点它回到同一个任务', '作品列表第一组是进行中的任务，点开回到 ?run=<编号> 的同一任务'],
  ['A-24', null, 'failed-scene', 'screenshot', D, '单幕失败只标出失败的那一幕，写明已保存的内容，主按钮只重做这一幕', '第 4 幕红框；失败卡写「已保存：原稿与要求、6 幕分镜与画面、其余旁白」，主按钮「重试第 4 幕」'],
  ['A-25', null, 'timeout', 'screenshot', D, '整条超时是失败状态，保留稿件与已生成的分镜，给出从断点继续的动作', '失败卡写「生成超时，已停止」和已保存的 3 幕，主按钮「重新排队，从这里继续」'],
  ['A-26', null, 'done-video', 'human', D, '成片播放器播放真实的视频文件和音轨：播放 / 暂停、上一幕 / 下一幕、拖动进度、静音、字幕开关、全屏，进度条上有重点刻度', '点播放后画面与声音都在走；字幕随幕切换；关字幕后字幕按钮为未按下、画面不再显示字幕'],
  ['A-27', null, 'done-video', 'human', D, '片头预告的重点可点击，跳到对应时间并开始播放', '点「再画边界」后时间到 0:40，当前重点卡描边'],
  ['A-28', null, 'done-video', 'screenshot', D, '完成后过程收成一行，注意力给成品与发布', '左栏助手一轮里显示「排队 · 分镜 · 配音 · 合成 全部完成，用时」一行，可展开；主按钮是「发布到网页托管」'],
  ['A-29', null, 'publish-failed', 'screenshot', D, '发布失败时成品仍可播放，说明重试只上传、不会重新生成，可重试', '失败卡含原因、「重试只上传，不会重新生成」与「重试发布」，右栏播放器可用'],
  ['A-30', null, 'published', 'human', D, '发布成功给「在网页托管中查看」，进入网页托管后定位并高亮这条记录', '点按钮进入 /web-pages?focusSite=<站点编号>，对应卡片高亮（复用 WebPagesPage 已有的 focusSite）'],
  ['A-31', null, 'done-video', 'screenshot', D, '成品可追溯：模板、配音写在预览上方，原稿收在你的消息里可点开回看', '预览标题下写时长、幕数与配音，右侧「模板 · 视觉笔记」；你的消息里有资料卡与「全部 n 份」'],
  ['A-32', null, 'web-done', 'human', D, '网页产出：生成中大纲逐节出现；完成后可切桌面 / 手机预览，重点点击定位到对应一节', '网页生成中右栏列出 4 节；完成后点「再画边界」，对应一节高亮'],
  ['A-33', null, 'done-video', 'human', D, '同一份稿件可一键改做另一种产出，稿件与要求自动带回', '点「用这份稿件做网页」回到创作，附件与要求已填好，产出切到网页'],
  ['A-34', null, 'works', 'screenshot', ALL, '作品列表：按状态筛选；标题桌面一行、手机两行截断；状态与时间在第二行；30 条稳定', '30 条作品逐行高度一致，长标题省略，不撑破行；状态标签不折行'],
  ['A-35', null, 'phone-compose', 'screenshot', P, '手机上「对话 / 预览」切换，输入框与「快捷生成」在底部可达；产出切换与风格按钮在输入框里单独一行', '390×844 下底部可见输入框、资料托盘、「视频 / 网页」、风格按钮与「快捷生成」'],
  ['A-36', null, 'phone-queued', 'screenshot', P, '手机头部的状态不挤压标题', '状态标签在标题上方一行，标题完整一行显示'],
  ['A-37', null, 'phone-preview', 'screenshot', P, '手机播放器进度条单独一行，控件不换到第三行', '进度条在上，按钮一行排完'],
  ['A-38', null, 'toolbox', 'screenshot', D, '百宝箱里是一张独立的「快速创作」入口卡片，带开发中标记', '卡片名、简介与「开发中」标记可见，点击进入快速创作'],
  ['A-39', null, 'compose-web', 'screenshot', D, '切到网页后风格保持不变，右栏说明换成「按这个风格的配色、字体与版式出页面」，标题与风格按钮同步', '「网页」高亮；风格仍是「视觉笔记」；右栏说明写网页的生成方式'],
  ['A-40', null, 'hosting', 'screenshot', D, '网页托管里新发布的记录高亮，并提示默认可见范围', '高亮卡片带「刚刚发布」，右下提示「默认仅团队成员可看」'],
  ['A-41', null, 'compose', 'human', D, '直接粘贴正文：一次粘贴 300 字以上的长文自动作为一份稿件附件，输入框只留给要求', '粘贴后输入框清空，附件托盘多一份「粘贴的正文」，快捷生成可用'],
  ['A-42', null, 'compose', 'human', D, '上传 Markdown / TXT 稿件或图片：读出文字的可直接生成，空文件或不支持的格式显示原因', '上传「评审要点.md」后附件托盘出现该文件且显示已读取，快捷生成可用'],
  ['A-43', null, 'compose', 'human', D, '风格库按 Lemo-Opuscar 的分类：15 类 99 种，可按类别筛选、按名字或类别搜索；选中风格显示样片海报、样片名与时长、一句话说明和来源署名', '类别行「全部 99」与 15 类各带数量；搜「水墨」只剩「中国水墨」；选中后大图、样片《》与署名同步'],
  ['A-44', null, 'style-picker', 'human', D, '输入框里的风格按钮就地弹出选择面板（搜索 + 类别 + 列表），选中后面板关闭，按钮与右栏风格库同步；面板底部可去右栏看大图', '点风格按钮 → 面板含搜索、类别行与风格列表；点「中国水墨」后按钮写「中国水墨」，右栏同一张卡被选中'],
  ['A-45', null, 'compose', 'human', D, '「视频 / 网页」在输入框里切换，风格与产出相互独立：切换产出不改风格，切换风格不改产出', '切到网页后风格按钮仍是原风格；再选别的风格，产出仍是网页'],
  ['A-46', null, 'compose', 'human', D, '风格来源与授权写清：风格说明（STYLE.md，CC BY-NC 4.0）只按编号引用、界面与源码差异不含原文；样片海报署名「Lemo-Opuscar by Lemomo (LemoLab)」并注明 CC BY 4.0', '风格详情底部有署名与「样片海报 CC BY 4.0」；源码差异与界面里搜不到 STYLE.md 正文；类型字段 promptRef 只存位置'],
  ['A-47', null, 'assets', 'screenshot', D, '右栏是「选择与资产」：新建时页签为「风格 / 产物」，任务中为「本次 / 产物」；产物页签只列已生成的视频与网页，上方是选中产物的大图、风格、作者、时间与发布状态，下方按「我的 / 团队」和视频、网页浏览', '产物页签首屏：选中产物大图带「视频 · 时长」，信息区写作者、时间、风格与「已发布」；筛选行有「我的 / 团队」与「全部 / 视频 / 网页」及数量；卡片写标题、风格、作者与时间'],
  ['A-48', null, 'assets-team', 'human', D, '从产物复用：「用这个风格」把风格带回输入框（任务中则新建并带上风格），「打开」回到原任务，已发布的可去网页托管；当前正在用的风格不重复带回', '选同事的「新版 OKR 填写指南」点「用这个风格」→ 风格按钮变为「中国水墨」并提示；任务中点「打开」→ 进入该产物的任务'],
  ['A-49', null, 'assets-team', 'human', D, '团队产物只列当前成员有权查看的成品：已发布的按网页托管的可见范围，未发布的只对作者和团队管理员可见（可见范围待确认，见待定问题）', '服务端按权限过滤后返回；原型的团队数据全部为同团队可见的虚构样例'],
];

/* 关键操作：CDS 交接检查按 handoff.cases 实际执行 */
const INTERACTIVE = new Set(['A-12', 'A-15', 'A-17', 'A-18', 'A-19', 'A-20', 'A-23', 'A-24', 'A-25', 'A-26', 'A-27', 'A-29', 'A-30', 'A-32', 'A-33', 'A-39', 'A-40', 'A-41', 'A-42', 'A-43', 'A-44', 'A-45', 'A-47', 'A-48']);
/* 覆盖维度（CDS 六维）：每条验收项归一个维度，缺规则的维度在 risks 里写风险与理由 */
const DIM = {
  compatibility: ['A-01', 'A-02', 'A-03', 'A-06', 'A-35', 'A-36', 'A-37'],
  security: ['A-10', 'A-46', 'A-49'],
  operations: ['A-07', 'A-08', 'A-23'],
  performance: ['A-16', 'A-20', 'A-34'],
  correctness: ['A-12', 'A-13', 'A-15', 'A-17', 'A-24', 'A-25', 'A-26', 'A-27', 'A-29', 'A-30', 'A-32', 'A-33', 'A-39', 'A-41', 'A-42', 'A-44', 'A-45', 'A-48'],
};
const dimensionOf = id => Object.entries(DIM).find(([, ids]) => ids.includes(id))?.[0] ?? 'experience';
const acceptance = rows.map(([id, ruleId, screenId, how, slots, rule, expected, extra]) => ({ id, ...(ruleId ? { ruleId } : {}), screenId, how, slots, rule, expected, dimension: dimensionOf(id), ...(extra ?? {}), ...(INTERACTIVE.has(id) ? { interaction: true } : {}) }));

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
  { id: 'pick-style-in-composer', title: '在输入框的风格按钮里就地换风格，右栏风格库同步', screenId: 'compose', theme: 'light', ruleIds: ['A-44'], steps: [
    { action: 'expect', selector: '[data-qc=style-chip]', check: 'attribute', attribute: 'data-template', equals: 'sketchnote' },
    { action: 'click', selector: '[data-qc=style-chip]' },
    { action: 'expect', selector: '[data-qc=style-popover]', check: 'visible' },
    { action: 'click', selector: '[data-qc=style-popover] [data-style=ink-wash]' },
    { action: 'expect', selector: '[data-qc=style-chip]', check: 'attribute', attribute: 'data-template', equals: 'ink-wash' },
    { action: 'expect', selector: '[aria-label=选择模板] [data-template=ink-wash]', check: 'attribute', attribute: 'aria-checked', equals: 'true' },
  ] },
  { id: 'search-style-library', title: '在右栏风格库按名字搜到风格并选中，输入框里的风格按钮同步', screenId: 'compose', theme: 'dark', ruleIds: ['A-43'], steps: [
    { action: 'fill', selector: '#qc-style-search', value: '水墨' },
    { action: 'expect', selector: '[aria-label=选择模板] [data-template=ink-wash]', check: 'visible' },
    { action: 'click', selector: '[aria-label=选择模板] [data-template=ink-wash]' },
    { action: 'expect', selector: '[data-qc=style-chip]', check: 'attribute', attribute: 'data-template', equals: 'ink-wash' },
  ] },
  { id: 'switch-output-keeps-style', title: '在输入框里切到网页，风格保持不变', screenId: 'compose', theme: 'light', ruleIds: ['A-45', 'A-39'], steps: [
    { action: 'remember', selector: '[data-qc=style-chip]', check: 'attribute', attribute: 'data-template', as: 'style' },
    { action: 'click', selector: '[aria-label=选择产出] button:nth-child(2)' },
    { action: 'expect', selector: '[data-qc-ready]', check: 'attribute', attribute: 'data-output', equals: 'web' },
    { action: 'expect', selector: '[data-qc=style-chip]', check: 'attribute', attribute: 'data-template', sameAs: 'style' },
  ] },
  { id: 'reuse-style-from-team-asset', title: '在产物页签看同事的成品，把它的风格带回输入框', screenId: 'compose', theme: 'light', ruleIds: ['A-47', 'A-48'], steps: [
    { action: 'click', selector: '[aria-label=选择与资产] button:nth-child(2)' },
    { action: 'expect', selector: '[data-qc=asset-library]', check: 'attribute', attribute: 'data-scope', equals: 'mine' },
    { action: 'click', selector: '[aria-label=产物范围] button:nth-child(2)' },
    { action: 'expect', selector: '[data-qc=asset-library]', check: 'attribute', attribute: 'data-scope', equals: 'team' },
    { action: 'click', selector: '[data-asset=a-t1]' },
    { action: 'expect', selector: '[data-qc=asset-detail]', check: 'attribute', attribute: 'data-asset-id', equals: 'a-t1' },
    { action: 'click', selector: '[data-qc=asset-use-style]' },
    { action: 'expect', selector: '[data-qc=style-chip]', check: 'attribute', attribute: 'data-template', equals: 'ink-wash' },
  ] },
  { id: 'open-asset-during-run', title: '任务进行中切到产物页签，打开以前的成品', screenId: 'generating', theme: 'dark', ruleIds: ['A-48'], steps: [
    { action: 'click', selector: '[aria-label=选择与资产] button:nth-child(2)' },
    { action: 'click', selector: '[data-asset=a-m1]' },
    { action: 'click', selector: '[data-qc=asset-open]' },
    { action: 'expect', selector: '[data-qc-ready]', check: 'attribute', attribute: 'data-run-id', equals: 'asset-a-m1' },
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
  { id: 'G-11', goal: '右栏同时承担选择与资产：创作时能回看自己和团队生成过的产物', doneWhen: '右栏有「产物」页签，可按我的 / 团队与产出类型浏览已生成的成品，能打开原任务、把风格带回输入框、去网页托管；团队产物按权限过滤', items: ['A-47', 'A-48', 'A-49'] },
  { id: 'G-10', goal: '模板按 Lemo-Opuscar 风格库选择，并在输入框里决定产出与风格', doneWhen: '15 类 99 种风格可筛选、搜索、看样片说明；输入框里就地切换视频 / 网页与风格，两者相互独立；风格说明只按编号引用并署名来源', items: ['A-43', 'A-44', 'A-45', 'A-46'] },
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
  prototypeVersion: 6,
  date: new Date().toISOString().slice(0, 10),
  rationale: '思路.md',
  prototype: 'dist/index.html',
  checks: 'checks/result.json',
  source: 'src',
  docs: ['设计文档/源码差异.diff', '设计文档/目标与验收.md', '设计文档/验收计划.md', '设计文档/演示数据.json', 'spec/rules.md'],
  notes: '快捷版：一份文档 + 一个模板 → 视频或网页，发布到网页托管。未来逐幕创作只给概念稿（concept-*），不交接实现。演示数据见 设计文档/演示数据.json（虚构稿件与成员），原型与实现取证共用。',
  /* 演示数据：CDS 发布接口当前不接受 demoData 字段，数据文件放进 docs（原型与实现取证共用这一份） */
  /* 画面的实现地址：正式页面同一路由（演示任务编号来自演示数据）；概念稿与原型示意页不交接实现 */
  screens: screens.map(s => ({ ...s, impl: /^#\/(concept|ai-toolbox|web-pages)/.test(s.route) ? null : s.route.slice(1) })),
  acceptancePlan: {
    mece: { applicable: true },
    compare: { applicable: true },
    visual: { applicable: true },
    regress: { applicable: true },
    flow: { applicable: true },
    human: { applicable: true },
    smoke: { applicable: true },
    debt: { applicable: true },
  },
  risks: [
    { dimension: 'performance', risk: '团队集中提交时排队变长、作品列表变长', ruleIds: ['A-20', 'A-34'] },
    { dimension: 'performance', risk: '按风格库出片的真实耗时（风格库说明单支成片约 30–60 分钟），原型里的 3 分钟只是占位', reason: '原型无法测真实耗时；排队容量、超时与预计耗时须在实现前按服务端能力确认，已列入待定问题并在反馈线程提问' },
    { dimension: 'security', risk: '风格说明 STYLE.md 为 CC BY-NC 4.0，内置进产品属于商用', ruleIds: ['A-46'] },
    { dimension: 'security', risk: '前端请求绕过统一鉴权', ruleIds: ['A-10'] },
    { dimension: 'security', risk: '团队产物把同事未发布的成品暴露给无权查看的人', ruleIds: ['A-49'] },
    { dimension: 'operations', risk: '用户离开或刷新后任务丢失、重复提交', ruleIds: ['A-08', 'A-23'] },
    { dimension: 'compatibility', risk: '手机与深浅主题下布局挤压、对比度不足', ruleIds: ['A-03', 'A-06', 'A-35'] },
  ],
  acceptance,
  goals,
  handoff: { cases },
};
writeFileSync(path.join(dir, 'design.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ screens: screens.length, acceptance: acceptance.length, goals: goals.length }));
