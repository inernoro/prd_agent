| refactor | cds | 控制台外壳架构归一：新增 ConsoleLayout 持久化布局路由，切页只换内容区，侧栏/命令面板/全局浮层跨路由不再卸载重建，auth 状态每会话只取一次 |
| perf | cds | 治理切页卡顿：启用 React Router v7_startTransition + 内容区级 Suspense 骨架，懒加载页面切换保留上一屏，不再出现全屏 loader 闪烁 |
| refactor | cds | Workspace 宽度体系归一为三档 token（standard 1240 / wide 1440 / fluid），收敛 1280/1360/1650/3000 等页面私有宽度上限 |
| feat | cds | 登录页重做：token 驱动的极简卡片式设计，双主题自动翻转 + 移动端自适应；首页认证入口统一跳 /login，移除内嵌 CdsAccessMorphBoard 登录板 |
| refactor | cds | AgentRequestsPage 接入 AppShell + TopBar + Workspace 标准外壳，消除游离布局（原自定义 max-w-6xl 无侧栏形态） |
| polish | cds | 内容区新增 200ms 进场微动效（chrome 稳定、内容过渡），路由切换有可感知的秩序感 |
| polish | cds | 登录页升级为左右分屏科技叙事：左侧品牌视觉板（六边形动网格 + 品牌大字流光 + 实时部署 feed 流），右侧认证卡加品牌光线与 same-origin secure 徽记，双主题 + 移动端保持 |
| feat | cds | 首页升级为多分区滚动叙事落地页（对标 Railway）：sticky 玻璃导航 + Workflow 三步（贯穿连接线橙色流光）+ 产品事实带 + Features bento 网格（鼠标跟随光斑 + 实况构建日志打字）+ Observability sticky 叙事实况终端 + Final CTA + 官网级页脚，全部素材来自真实能力 |
| polish | cds | 登录页中庭植入 token 化「运行时星座」（branch→services→preview 接线图，随 feed 逐站点亮 + 微透视浮游 + hover 归平），认证卡升级多层阴影/立体 CTA/输入焦点编排/密码显隐/失败 shake/级联入场 |
| polish | cds | 全局质感配方：--shadow-card 五层影 token、grain 噪点工具类、CJK 字体栈 + Inter 字形特性、品牌橙 accent 注入（状态点/数据流/光束）、修剪永动循环动效（logo 常转改 hover、sheen 加驻留） |
| polish | cds | 登录页 v4「一条线」设计哲学重构：废除分屏拼贴与星座装饰，整页一块画布一个光源，一条部署光路横贯页面（push 0:00 / build 0:40 / live 2:00 时间站点 + 6.5s 电流巡游）终点没入登录卡；文案改用户故事口吻（Push a branch. Watch it come alive. 登录，领取它），底部 mono ticker 作线上电报 |
