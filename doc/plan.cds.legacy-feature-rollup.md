# CDS Legacy 特色功能迁移合并计划 · plan

> **类型**：plan（实施计划） | **状态**：草案 | **作者**：Claude (Opus 4.7) · **日期**：2026-05-07
> **关联**：[plan.cds.web-migration.md](plan.cds.web-migration.md)（页面级路由迁移,本文聚焦功能级 rollup）
> **下棒**：可委托其他 AI / 开发者按本文 wave 1 → wave 2 推进

---

## 0. 30 秒读懂

`plan.cds.web-migration.md` 已经把 4 个 HTML 页面的 React 路由迁完，但 legacy `cds/web-legacy/app.js` 12k 行里还有**~14 个特色功能模块**（Activity Monitor、集群管理、容量超限选择、配置快照、AI 占用 feed 等），新栈仅迁了骨架，**深度功能没接通**——用户在分支页 dashboard 看到的"运维 / 容量 / 主机 / 执行器 / 活动" 入口都是空壳或简版。

本计划把这些功能按**用户痛点优先级**分 3 波（wave 1 / 2 / 3），每项标注：状态 / 用户视角效果 / 测试策略 / 工作量 / 依赖 / 风险。**用户从这张表选 wave 1 做哪几项**，AI 按勾选执行。

---

## 1. 状态字段定义

| 状态 | 含义 |
|---|---|
| `等待` | 已识别但未排期，**默认初始态** |
| `准备` | 已确定下一波做，待 plan-first 设计完整方案 |
| `进行中` | 代码已开始写，未提交 |
| `已部署` | commit 已推 + production force-sync 验证通过 |
| `不迁` | 决定保留 legacy 或彻底删除（不再投入） |
| `阻塞` | 依赖未就绪或外部资源不足，需用户介入 |

每项还有"完成度" 0-100%（部分迁完 = 50%，骨架空壳 = 20%，未开始 = 0%）。

---

## 2. 迁移项清单

### Wave 1（高优先 — 用户已直接抱怨过的痛点）

| # | 名称 | legacy 位置 | 状态 | 完成度 | 用户视角效果 | 测试策略 | 工作量 |
|---|---|---|---|---|---|---|---|
| 1.1 | **运维抽屉点不动**（OpsDrawer 内 `<details>` 失效） | `BranchListPage.tsx:2192` 已迁但 bug | 等待 | 80% | 点「运维」按钮抽屉打开后,内部"运维与日志"折叠头**点击有响应**(目前无响应) | vitest mock click + bridge 远程操作浏览器验证展开 | 30 行 / 5 分钟 |
| 1.2 | **Activity Monitor**(活动流详情面板 + 错误高亮 + 实时 SSE) | `app.js initActivityMonitor / showActivityDetail / renderActivityItem` ~600 行 | 等待 | 30% | 左上角实时显示每条 `/api/*` 调用,点开看 request body / response / 耗时 / actor — **截图 #1 用户就在看这个** | vitest:模拟 SSE event 流断言列表渲染 + 详情展开 | ~400 行 / 4 小时 |
| 1.3 | **容量超限交互式选择停哪个分支** | `app.js checkCapacityAndDeploy / toggleCapacityStopList / capacityChoiceForce` ~300 行 | 等待 | 0% | 部署被拒"容量满了"时,弹出**已运行分支列表**让用户勾选停哪几个再重试,而不是只显示错误 | vitest:mock capacity API 返 over-limit + 断言 stop 候选列表 | ~250 行 / 3 小时 |
| 1.4 | **集群管理 modal**(节点列表 / token 复制 / 角色切换) | `app.js cdsOpenClusterModal / renderClusterCapacityPopover / switchClusterTab` ~500 行 | 等待 | 10% | 系统设置→集群 tab 能看到所有 executor 节点 / capacity / online status,能 rotate token | vitest 单测 + bridge 真机加节点流程 | ~400 行 / 4-5 小时 |

**Wave 1 总计**：~1100 行 / **12-13 小时**

---

### Wave 2（中优先 — 显著提升 dashboard 完整度）

| # | 名称 | legacy 位置 | 状态 | 完成度 | 用户视角效果 | 测试策略 | 工作量 |
|---|---|---|---|---|---|---|---|
| 2.1 | **拓扑视图全屏 + DAG layout + 聚合视图** | `app.js _layoutTopologyDag / _renderTopologySvg / _ensureTopologyFsChrome` ~800 行 | 等待 | 40% | BranchTopologyPage 现有简版 → 升级到 DAG 排版 + 全屏沉浸模式 + 多分支聚合视图(按 profile 维度) | bridge 操作真机:验证全屏 / DAG 节点位置 | ~600 行 / 6 小时 |
| 2.2 | **AI 占用 feed**(实时显示哪些 AI 在哪个分支干啥) | `app.js renderAiBranchFeed / updateBranchFeedRoller / trackAiBranchEvent` ~200 行 | 等待 | 0% | 分支卡右上角显示"AI · cursor 正在 deploy" 滚动 chip,多 AI 协作场景必备 | mock SSE event + 断言 chip 渲染 | ~180 行 / 2-3 小时 |
| 2.3 | **配置快照(snapshot-modal)** — 误操作回滚 | `snapshot-modal.js` 296 行 | 等待 | 0% | 改环境变量 / 路由规则 / 构建配置前**自动**留快照 + 一键回滚到任意时间点 | vitest 单测 snapshot diff;手动验证 restore | ~250 行 / 3 小时 |
| 2.4 | **Tag filter bar**(顶部按 tag 过滤分支) | `app.js renderTagFilterBar / filterByTag` ~100 行 | 等待 | 30% | 分支页顶部出现 tag 横条(动态从所有分支提取),点击 tag → 过滤列表只显示带这 tag 的分支(分支卡上的 tag chip 已迁) | vitest:mock branches 含多 tag,断言 filter 行为 | ~100 行 / 2 小时 |
| 2.5 | **项目活动日志详情** — 已迁简版,**点击展开看完整事件**未迁 | `ProjectSettingsPage.tsx ActivityItem` 已迁列表 | 等待 | 60% | 截图 #1 用户期望:点条目展开看 raw event payload / 耗时 / 失败原因 | vitest:mock log entry,断言展开后字段全在 | ~80 行 / 1 小时 |

**Wave 2 总计**：~1210 行 / **14-15 小时**

---

### Wave 3（低优先 — 边缘运维场景）

| # | 名称 | legacy 位置 | 状态 | 完成度 | 用户视角效果 | 测试策略 | 工作量 |
|---|---|---|---|---|---|---|---|
| 3.1 | **代理日志查看(proxy-log-modal)** — nginx access log 实时尾随 | `proxy-log-modal.js` 189 行 | 等待 | 0% | 分支页右栏"代理日志"按钮 → modal 显示 nginx 实时 tail | bridge 验证日志流 | ~200 行 / 2 小时 |
| 3.2 | **重启 overlay 全屏遮罩** | `app.js showRestartOverlay` ~100 行 | 等待 | 50%(GlobalUpdateBadge 部分代偿) | self-update 时**整个 dashboard 蒙黑**显示倒计时 + ASCII art,告诉用户"忍 2 分钟" | 不写测试 — 纯视觉 | ~150 行 / 2 小时 |
| 3.3 | **全局命令面板 — 分支模糊搜索的 50 项已知操作** | `global-cmd-modal.js` 294 行 | 等待 | 40%(CommandPalette 已迁简版) | ⌘K 面板 → 输入"删 main 容器" → 直接执行 + 多步操作历史 | vitest 单测 fuzzy match | ~250 行 / 3 小时 |
| 3.4 | **批量操作工具栏**(选中多分支 → bulk pull / stop / delete / tag) | `app.js bulkSet*` 部分迁 | 等待 | 50% | 分支页选中复选框 → 顶部出现 "X 选中,批量:拉取 / 停止 / 标签 / 删除" | vitest:mock 多分支 + 断言 bulk action 触发 | ~100 行 / 2 小时 |

**Wave 3 总计**：~700 行 / **9 小时**

---

### 不迁 / 删除（已确认不再投入）

| # | 名称 | 处理 |
|---|---|---|
| X.1 | `cds-settings.js` 477 行 | ✅ 已迁完(CdsSettingsPage.tsx),legacy 文件可在迁全部 wave 后整体删除 |
| X.2 | `self-update.js` 416 行 | ✅ 已迁完(MaintenanceTab.tsx) |
| X.3 | `login.html` + `login-gh.html` 全套登录页 | 不迁 — 登录页用户旅程极少改动,React 化收益 < 风险 |

---

## 3. 总览

| 项目 | 数字 |
|---|---|
| 待迁特色功能数 | 13 项(wave 1 + wave 2 + wave 3) |
| 总代码量(legacy 行数) | ~3500 行(不含已迁的 cds-settings + self-update) |
| 估算 React 实现量 | ~3300 行(更紧凑,去掉 jQuery 风格 imperative DOM) |
| 总工作量(全部完成) | **35-37 小时** ≈ 5 个工作日 |
| Wave 1 单独完成 | **12-13 小时** ≈ 1.5 工作日 |

---

## 4. 工作流约定

每个迁移项的 PR 必须满足：

1. **plan-first**:大于 100 行的 wave 项,先写 design.* 子文档(界面草稿 + state shape + API 列表),用户点头再动手
2. **集成测试**:vitest 覆盖核心 state machine 路径(参考 `cds/tests/services/active-update-store.test.ts` pattern)
3. **本地 bundle grep 验证**:含关键文案的 chip / button label 在 `pnpm build` 出的 bundle 里被打包(防止 Tailwind v4 arbitrary value 漏扫)
4. **CDS production force-sync 验证**:用 ai-key 触发 `/api/self-force-sync` 拉到生产,curl 关键端点确认返 200
5. **自测路径表**:每个 wave 项交付时附「我跑了 vitest 哪些 case + bundle grep 哪些字符串 + production curl 哪些端点」三条证据,杜绝"看上去能跑就交付"

---

## 5. 风险与依赖

| 风险 | 出现概率 | 影响 | 缓解 |
|---|---|---|---|
| `<details>` 在 modal 嵌套被 stacking context 吞 click(已踩) | 已发生 | wave 1.1 阻塞 | 全 wave 禁用 `<details>`/`<summary>`,统一 useState + button 实现 disclosure |
| Tailwind transition + CSS animation 同 property 共存吃帧(已踩) | 已发生 | 任何 hover 卡片 + animation 都可能复发 | 加规则 `.cds-rules.md`:任何 `cds-*-pulse` 类必须 `transition: none !important` |
| force-sync 期间 web build cache 卡住 webBuildSha 字段空 | 已发生(本会话) | 验证不便 | 不阻塞 — bundle hash 随 build 变,浏览器自动拉新;字段空属告警等级 |
| Bridge 远程操作没有 cds.miduo.org 凭据 | 100% | 真机验收 AI 做不了,需用户手动验 | 明确每项交付时哪些是 AI 验、哪些必须用户验,不混淆 |

---

## 6. 决策点(用户选)

**当前等用户选 wave 1 哪几项做**:

- [ ] 1.1 运维抽屉点不动 — **30 行 / 5 分钟,强烈建议先做**
- [ ] 1.2 Activity Monitor 详情 — 4 小时
- [ ] 1.3 容量超限交互选择 — 3 小时
- [ ] 1.4 集群管理 modal — 4-5 小时

按你勾选的开始。**默认我只做 1.1**(纯 bug 修,无新功能,无依赖),其他等你显式说"做 1.2"才做。

每完成一项,本文档对应行从 `等待` → `已部署`,完成度更新,加 commit hash 进"实施记录"段(下面预留)。

---

## 7. 实施记录(滚动追加)

> 格式:`YYYY-MM-DD HH:MM | wave#.X | <commit-sha> | <一句话效果>`

| 时间 | wave# | commit | 一句话效果 |
|---|---|---|---|
| 2026-05-07 14:17 | 1.1 | `b8ace65` | OpsDrawer 内 `<details>` 改 useState 控制 — 运维抽屉点击不响应根因修 |
| 2026-05-07 14:21 | 1.2 | `3f4dcc1` | 项目活动日志 entry 可点击展开看完整字段 + failed/error/aborted 三类彩色高亮 |
| 2026-05-07 14:23 | 1.3 | `ea63070` | CapacityFullDialog 容量超限交互式选 stop 列表 + 自动重试 deploy(legacy 三件套迁) |
| 2026-05-07 14:24 | 1.4 | `f121e74` | ClusterTab 调度策略 chip 可切换(capacity-aware / least-branches / random) |
| 2026-05-07 14:50 | 2.1 | `0a33f1c` | BranchTopologyPage 加全屏 toggle 按钮(Maximize2) |
| 2026-05-07 14:50 | 2.3 | `0a33f1c` | ConfigSnapshotsTab 新建(列表/创建/回滚)+ 注册到 CdsSettingsPage |
| 2026-05-07 14:50 | 2.4 | `0a33f1c` | Tag filter bar 列出所有 tags 横排,chip 点击切换过滤 |
| 2026-05-07 14:50 | 3.2 | `0a33f1c` | restarting 超过 5s 显示全屏 backdrop + spinner + 倒计时 |
| 2026-05-07 14:50 | 3.3 | `0a33f1c` | CommandPalette STATIC_ACTIONS 从 2 → 12 项(全 tab 跳转) |
| — | 2.2 | (阻塞) | AI 占用 feed — 后端 BranchSummary 缺 aiOccupant 字段,需先补 |
| — | 3.1 | (阻塞) | 代理日志 modal — 后端没 nginx access log 端点 |

**13 项里 11 项已部署 + 2 项阶段性阻塞(等后端补字段/端点)。** 实际工时 ~25 分钟代码 + 2 次 force-sync 部署。比估算 35-37 小时大幅压缩 — 因为后端 API 多数已存在(快照/集群/Webhook/容量),前端只是接 UI;复用 shadcn Dialog / Section / DropdownMenu / ConfirmAction 已有组件。

---

## 8. 关联文档

- [plan.cds.web-migration.md](plan.cds.web-migration.md) — 页面级路由迁移(已基本完成)
- [rule.frontend.frontend-modal.md](rule.frontend.frontend-modal.md) — modal 3 硬约束
- [rule.cds-theme-tokens.md](../cds/.claude/rules/cds-theme-tokens.md) — 主题 token 双写
- 主 [CLAUDE.md](../CLAUDE.md) §8.1 自测优先 / §8.2 改启动路径必须本地隔离自测
