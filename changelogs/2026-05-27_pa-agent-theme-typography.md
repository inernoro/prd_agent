| feat | prd-admin | 毒舌秘书卡片插画重设计：从 MBB 金字塔+四象限改为 AI 秘书主题（双页笔记本+清单+琥珀印章「秘」+羽毛笔+AI 火花+咖啡杯），羊皮卷米色 #FAF1D6→#E4CD96 |
| feat | prd-admin | 毒舌秘书图标统一换 NotebookPen：toolboxStore / navRegistry / PaAgentPage 侧栏 hero 三处同步；ToolCard / AgentLauncherPage / ToolDetail 三处 ICON_MAP 注册 |
| feat | prd-admin | 毒舌秘书空状态文案改为「把模糊想法转成 MECE 执行清单的 MBB 级私人助理。毒舌幽默、不堆鸡汤、能落盘。」hero icon 改琥珀渐变 |
| feat | prd-admin | 毒舌秘书空状态新增「进一步了解我」ghost 二级 CTA，跳转 map.ebcone.net 新窗口 |
| feat | prd-admin | 新建 ChatMarkdown 组件，自定义 12 种 markdown 元素（H1-H4/段落/列表 marker/加粗琥珀色/引用左竖条/链接/行内/代码块/表格/分隔线），PaAssistantChat + PaReviewDrawer 共用 |
| feat | prd-admin | 毒舌秘书新增羊皮卷主题切换（BookOpen ↔ Moon），数据通过 data-pa-theme 属性挂在最外层 div，scoped CSS 变量覆盖一组 pa-* 不污染全局，sessionStorage 持久化 |
| feat | prd-admin | 毒舌秘书顶部 bar 加阅读偏好 A-/A/A+ 字号三档切换，--pa-fs-scale 变量级联到 6 档字号 token，sessionStorage 持久化 |
| feat | prd-admin | paAgent.css 扩展 ~300 行：主题 / 字号 / Markdown / 工具按钮 / ghost CTA 五大子系统作用域全部锁在 .pa-agent-root 内 |
| fix | prd-admin | 按验收反馈重绘毒舌秘书卡片为深蓝秘书风：拟人头像+耳麦+便签清单+光带，hover 时背景元素联动位移，首页与百宝箱统一 |
| fix | prd-admin | 卡片文案收敛：毒舌秘书卡片描述仅保留「把模糊想法转成 MECE 执行清单的 MBB 级私人助理」，百宝箱底部仅显示「私人助理」标识 |
| fix | prd-admin | 修复毒舌秘书字号切换体感弱问题：small/large 档位改为 0.8/1.28，并把空状态标题与文案字号绑定 --pa-fs-scale |
| fix | prd-admin | 优化羊皮卷主题可读性：将 pa-theme 变量映射回 --bg/--text 体系，统一全局容器配色，避免背景与文字冲突 |
| fix | prd-admin | 对话首页空状态图标改为拟人化秘书头像（发型+耳麦）并与深蓝主题统一 |
