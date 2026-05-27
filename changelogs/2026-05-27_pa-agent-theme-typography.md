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
| fix | prd-admin | 对话等待首 token 时由三点跳动改为橙色动态「让我想想...」（琥珀渐变扫光 + 省略号起伏） |
| fix | prd-api | 毒舌秘书任务识别改为遍历全部 JSON 代码块并优先处理 save_task，避免与 update_profile 共存时漏入任务看板；同时强化 suggest/auto 判定提示词 |
| feat | prd-admin | 毒舌秘书视觉 v2：卡片 PaAgentCardArt 科幻深蓝+女秘书 bust；统一 PaSecretaryIcon 替换 NotebookPen（百宝箱/首页/侧栏/Cmd+K） |
| feat | prd-admin | 羊皮卷主题改为米白浅色系+淡淡书卷纹理，强调色改鼠尾草绿，与科幻秘书品牌区隔 |
| fix | prd-admin | 侧栏历史会话加线框卡片（pa-session-item）区隔每条对话 |
| fix | prd-admin | 修复 A-/A/A+ 字号：pa-fs-sm/xs 覆盖对话区 Tailwind 固定字号，档位拉大到 0.82/1.38 |
| fix | prd-admin | 修复羊皮卷下「让我想想」渐变字被褐色色块遮挡（保留 background-clip:text） |
| feat | prd-admin | 空状态换 PaSecretaryHeroArt 全息人像；卡片秘书 bust 重绘为 AI 科技风 |
| feat | prd-admin | 主背景切换为 Gemini 风格浅灰+淡蓝渐变，列表卡片改鼠标跟随 hover 光斑 |
| fix | prd-admin | “我的画像”按钮移到右上角 toolbar；删除左下角两个入口按钮 |
| feat | prd-admin | 背景三态循环：默认 Gemini 浅色 → 山蓝深色 → 羊皮卷；旧 dark 偏好自动映射 mountain |
| fix | prd-admin | 侧栏会话项统一 40px 高度，仅标题+时间，细线分隔；主内容区四角 18px 圆角 |
| feat | prd-admin | PaSecretaryIcon / PaAgentCardArt 改为 Gemini 风四色星芒与浅色卡片插画 |
| fix | prd-admin | 毒舌秘书首页卡片改回深蓝科技风；hover 时星芒增加旋转脉冲与轨迹流动动态效果 |
| fix | prd-admin | 页面四角改为外层容器圆角（左侧栏+右主区拼接）；对话主区左侧恢复直角，避免对话框额外倒圆角 |
| fix | prd-admin | 侧栏会话分隔线改 0.5px 浅色；选中态改 Gemini 圆角灰底；空状态图标换浅色底四色星芒 |
| fix | prd-admin | 去掉毒舌秘书最外层 shell 矩形背景，仅保留侧栏+主区圆角层铺主题底；羊皮卷纹理下移 |
| fix | prd-admin | 空状态 hero 图标重制为深蓝科技风（与首页卡片同款），含 idle/hover 星芒动效 |
| feat | prd-admin | 毒舌秘书圆角内容层背景加呼吸动效：双层径向光晕错相位 11s/13s 缓慢呼吸，三主题适配，尊重 prefers-reduced-motion |
| feat | prd-admin | 空状态标题「毒舌秘书」加流星扫光动效（background-clip:text 渐变高光带 5.4s 循环），三主题各自高光色 |
| fix | prd-admin | 强化圆角层背景呼吸效果：光晕饱和度+亮度提升，scale 拉到 1.18、opacity 0.55↔1，周期缩到 8s/9.5s，并加 blur 微焦交替，呼吸感更明显 |
| fix | prd-admin | 修复 pa-agent main 区子元素被强制 position:relative+z-index 导致 topbar 错位的回归；呼吸动效改为 background-position 长距离游走 + saturate/brightness 脉动，肉眼可见，仅作用 main 区不影响侧栏 |
