| fix | prd-admin | 修复「播放按钮跑不了」bug:AppShell 里 `<SpotlightOverlay key={location.pathname} />` 让每次路由切换 unmount 组件,Play 流程中 navigate 前 Overlay 已消费清理 sessionStorage,navigate 后新 Overlay 再读就是空的。改为单例,`readAndStart()` 在事件/mount 时重置 state |
| feat | prd-admin | Ctrl+K 2 步 Tour 加入 seed(home-search 唤起 → command-palette-input 输入);CommandPalette 的 input 补 `data-tour-id="command-palette-input"` 锚点 |
| feat | prd-api | AdminDailyTips `/push` 端点支持 `scope` 参数:`all` 或 `role:PM/DEV/QA/ADMIN`,后端按 UserStatus=Active 展开 userIds,与手动选的取并集。解决「没法一键群发」缺口 |
| feat | prd-admin | PushDialog 新增「批量推送(按范围)」分区:一排按钮一键推给全体 / PM / DEV / QA / ADMIN,带 `window.confirm` 二次确认避免误触 |
| feat | .claude/skills | `create-tour-demo` 技能 description 加「增加教程 / 增加引导」触发词;执行流程第 3 步强制产出「打断风险分析」(步骤清单 + 可能被打断的节点 + 缓解方案),让 AI 主动告诉用户哪些步可能卡住 |
| docs | doc | 新增 `doc/design.daily-tips.md` 原理文档(11 节,含产品定位 / 用户场景 / 数据模型 / 组件拓扑 / 引导动作流水线 / 架构决策 / 接口设计 / 扩展指南 / 已知约束);同步更新 `doc/index.yml` + `doc/guide.list.directory.md` |
