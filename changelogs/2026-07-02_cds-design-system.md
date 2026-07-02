| refactor | cds | 控制台外壳架构归一：新增 ConsoleLayout 持久化布局路由，切页只换内容区，侧栏/命令面板/全局浮层跨路由不再卸载重建，auth 状态每会话只取一次 |
| perf | cds | 治理切页卡顿：启用 React Router v7_startTransition + 内容区级 Suspense 骨架，懒加载页面切换保留上一屏，不再出现全屏 loader 闪烁 |
| refactor | cds | Workspace 宽度体系归一为三档 token（standard 1240 / wide 1440 / fluid），收敛 1280/1360/1650/3000 等页面私有宽度上限 |
| feat | cds | 登录页重做：token 驱动的极简卡片式设计，双主题自动翻转 + 移动端自适应；首页认证入口统一跳 /login，移除内嵌 CdsAccessMorphBoard 登录板 |
| refactor | cds | AgentRequestsPage 接入 AppShell + TopBar + Workspace 标准外壳，消除游离布局（原自定义 max-w-6xl 无侧栏形态） |
| polish | cds | 内容区新增 200ms 进场微动效（chrome 稳定、内容过渡），路由切换有可感知的秩序感 |
