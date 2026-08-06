| feat | cds | 新增 AI 控制态动效三方案 demo 页（数据流轨道 / 思考脉冲 / 工位接管），含基线对照与双主题切换 |
| fix | cds | 修复方案 C 徽章环形巡光甩出徽章：扁矩形不能转元素，改转 conic 渐变角度 |
| feat | cds | 方案 C 阶段信息移入页脚闲置空间，左轨与页脚轨改由同一份状态驱动 |
| refactor | cds | 进度轨段数改为完全由数据决定，新增 staged/counted/indeterminate/heartbeat 四档退化与超时/失败两种异常态 |
| feat | cds | 分支卡落地方案 C：环境光扫掠 + AI 进度轨（staged/indeterminate/heartbeat 三档）+ 徽章环形巡光，页脚展示 AI 当前动作 |
| fix | cds | 修复 AI 进度轨方向修饰类被 Tailwind 摇掉：@layer components 里的规则不能用模板拼类名 |
| fix | cds | 修复分支详情抽屉滚动后被截断：page-enter 动画的 forwards 填充让滚动容器成了 fixed 的包含块 |
| polish | cds | 分支名改用等宽字体，对齐 llmgw 日志的英文字形 |
| polish | cds | heartbeat 档改用脉冲点替代无意义横线，补最近活动时间；浅色模式收敛环境光与边框 |
| test | cds | 改写反向锁死的 ShinyText 用例为契约断言，新增段数守卫、Tailwind 摇树守卫与 page-enter 包含块守卫 |
| chore | cds | 删除已无引用的 cds-ai-active-rail 与 cds-ai-rail-breathe |
| feat | cds | 主题切换提到左侧栏一级入口，不再只藏在头像浮层里 |
| fix | cds | 补回主题切换水波纹：迁到 React 新栈时只搬了「关掉默认过渡」那一半，扩散动画没搬 |
| test | cds | 新增水波纹两半守卫（CSS 扩散动画 + JS startViewTransition 接线）与降级用例 |
| fix | cds | 信息中心浮层支持点外部与 Esc 关闭，不再必须点 X |
| polish | cds | PR 徽章从分支卡标题行收进 ... 菜单，把标题宽度还给分支名 |
| feat | cds | 新增分支卡六状态可分辨性 demo（构建中/回收中/运行中/失败/AI操作中/调试中，双主题） |
| refactor | cds | GitHub PR URL 收敛到 lib/github-urls，此前散在三处 |
| test | cds | 新增点外部关闭判据守卫（含 portal 弹窗豁免、触发器排除两类窄判据） |
| fix | cds | 修复同页多个 useTheme 实例不同步：rail 与浮层各持一份 state，改主题另一处不跟随 |
| fix | cds | 主入口 URL 改按 profile 真实路由拼：非根挂载带上前缀、非根命名子域走命名 host，此前一律主域名根会指向别的应用 |
| refactor | cds | 前端 PR 链接收敛到 lib/github-urls，删掉抽屉里遗留的同名副本 |
| fix | cds | Esc 关闭信息中心补上与点外部同一套弹窗豁免，不再一次关掉两层 |
| polish | cds | 移动端切主题不再顺手关掉导航抽屉 |
| test | cds | 补非根 primary 入口的真实 API 行为用例、主入口路由守卫与 Esc 豁免用例 |
