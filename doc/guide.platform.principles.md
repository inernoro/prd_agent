# PRD Agent 系统原则速查（命名原则索引）

> **版本**：v1.0 | **日期**：2026-06-27 | **状态**：已落地
>
> 把系统里所有「有名号、能一句话记住」的原则（如 2 秒原则、无根之木禁令、好用四原则）汇成一处速查表。
> 每条原则给一句话主张 + 出处文件，详细约束去对应 `.claude/rules/*.md` 或 `CLAUDE.md`。
> 本文是**索引**，不是 SSOT —— 原则正文以各规则文件为准；新增/改名原则时同步本表。

---

## 一、等待 / 反馈 / 体验

| 原则 | 一句话主张 | 出处 |
|------|-----------|------|
| **2 秒原则**（禁止空白等待） | 用户等待时屏幕必须有持续变化，静止「加载中」超 2 秒即体验缺陷 | `CLAUDE.md §6` |
| **产物即体验** | 等待期主视觉必须是「产物本身在生长」，状态面板/spinner 只配做配角 | `artifact-is-experience.md` |
| **预期管理总纲** | 用户任何时刻都知道「在做什么 / 还要多久 / 接下来怎样 / 刚才变了什么 / 我该做什么」 | `expectation-management.md` |
| **米多审查镜头**（六镜头） | 交付前用用户的眼睛六连问：产物感 / 比例美感 / 交互成本 / 变化可感知 / AI 最小惊讶 / 证据闭环 | `miduo-review-lens.md` |
| **验收必须闭环**（禁止断头验收） | 验收终点是「产物可见且正确」，不是流程走一半截图收工；timeout ≠ 通过 | `closed-loop-acceptance.md` |
| **端到端验收** | API 200 ≠ 功能正常，必须打开真实页面对照设计稿逐项核查（新旧数据都验） | `e2e-verification.md` |

## 二、输入 / 启动 / 引导

| 原则 | 一句话主张 | 出处 |
|------|-----------|------|
| **输入零摩擦** | 能上传绝不手输，不确定就两个都给，禁止面对空白发呆 | `zero-friction-input.md` |
| **少绕路**（Anti-Detour） | 别让用户为喂数据离开当前流程去准备文件，优先就地可编辑 + 智能预填 | `anti-detour.md` |
| **快启动零摩擦** | 启动脚本大包大揽，假设用户是小白，自动检测 + 安装依赖，唯一入口 | `quickstart-zero-friction.md` |
| **陌生页面引导性** | 进新页面 3 秒内知道「这是什么 + 下一步做什么」，空状态不能空 | `guided-exploration.md` |

## 三、界面 / 布局 / 设计

| 原则 | 一句话主张 | 出处 |
|------|-----------|------|
| **好用四原则**（首席设计师视角） | 快启动无等待 / 奥卡姆剃刀剃掉不需人类处 / 不遮挡够明显 / 短途减步不杜撰长链 | `chief-designer-usability.md` |
| **内容填满画布** | 主产物必须 flex-1 填满并占视觉主导，禁小盒子 + 大片留白 | `content-fills-canvas.md` |
| **页面必须撑开高度** | 宽屏页面撑满视口，根 `h-full min-h-0 flex flex-col`，禁 `calc(100vh-Npx)` 魔数 | `full-height-layout.md` |
| **手机端密度优先** | 手机寸土寸金，把空间用满、内容优先，进内容前 ≤1 条控制条 | `mobile-first-density.md` |
| **画布手势统一** | 两指拖动=平移、捏合/⌘滚轮=缩放、禁双击缩放，全站一套手势 | `gesture-unification.md` |
| **前端模态框 3 硬约束** | inline style 高度 + createPortal 到 body + flex 滚动区 `min-h-0` | `frontend-modal.md` |
| **CDS 主题 Token** | 白天主题禁止任何暗色背景，颜色全走 token 自动翻转，不写死字面量 | `cds-theme-tokens.md` |

## 四、工程 / 架构 / 数据

| 原则 | 一句话主张 | 出处 |
|------|-----------|------|
| **无根之木禁令 + 借用法则** | 做不到的不装能做，明确暴露缺失 + 借用外力，不假定不存在的能力 | `no-rootless-tree.md` |
| **服务器权威性** | 客户端被动断开不取消服务器任务，只有主动调取消 API 才中断 | `server-authority.md` |
| **算/发两阶段**（Compute-then-Send） | 外部调用分计算和发送，发送阶段接收已解析结果，不得再 resolve | `compute-then-send.md` |
| **跨项目隔离** | 改全局值前先列消费方清单，改完每个消费方都还成立才行 | `cross-project-isolation.md` |
| **卡死熔断** | 撞上自己造不出的外部输入，≥8 提交或 ≥2h 无功能净进展即停止升级，禁止兜圈 grinding | `blocked-state-circuit-breaker.md` |
| **快照兜底** | 引入快照/反规范化字段必须同步维护等价覆盖的 fallback 查询路径 | `snapshot-fallback.md` |
| **枚举涟漪审计** | 枚举/常量成员数变化时全栈 6 层审计所有消费点，禁止部分更新 | `enum-ripple-audit.md` |
| **数据关系审计** | 实体 A 新增对 B 的引用时，审计 B 的所有消费端点权限是否覆盖新路径 | `data-audit.md` |
| **应用身份隔离** | 每个应用独立 Controller，硬编码 appKey，不由前端传递 | `app-identity.md` |
| **LLM Gateway 统一调用** | 所有大模型调用走 ILlmGateway，且必须设 LlmRequestContext（UserId 不为空） | `llm-gateway.md` |
| **AppCallerCode 注册** | AppCallerCode 不许裸字符串，先在 Registry 注册常量再引用，kebab-case | `app-caller-registry.md` |
| **AI 模型可见性** | 中大型用大模型的功能，UI 顶部展示当前模型名 + 平台，后端来源不硬编码 | `ai-model-visibility.md` |
| **客户端存储选型** | 默认 sessionStorage，localStorage 仅限「非敏感 + 设备本地 + 发版后旧值无害」 | `no-localstorage.md` |
| **禁止自动建索引** | 应用启动禁止自动创建 MongoDB 索引，由 DBA 手动建 | `no-auto-index.md` |
| **CDS 优先验证** | 本地无 SDK ≠ 无法验证，必须走 `/cds-deploy` 远端编译，不转嫁验证负担给用户 | `cds-first-verification.md` |
| **CDS 自动部署** | 已 link 项目 push 即部署，不再提示手动跑 pipeline；UI 开着要有构建动画 | `cds-auto-deploy.md` |
| **Agent Runtime SDK 边界** | 不让历史运行时名暗示更强的厂商集成，「官方 SDK」措辞必须核对实际依赖 | `agent-runtime-sdk-boundary.md` |

## 五、CLAUDE.md 顶层强制规则（编号制，非命名原则）

`§0 禁止 Emoji`（最高优先）+ #1 pnpm Only · #2 C# 静态分析 · #3 任务交接 · #4 更新记录碎片 · #5 提交与 PR 工作流 · #6 LLM 可视化（2 秒原则） · #7 新增 Model 对照写法 · #8 完成标准（#8.1 自测优先） · #9 导航去百宝箱 · #10 doc 命名 · #11 push 后给预览地址。详见 `CLAUDE.md`。

---

## 原则之间的关系

- **预期管理总纲**（`expectation-management.md`）是顶层解释层：2 秒原则 / 产物即体验 / 验收闭环 / 米多镜头 / 最小惊讶都是它在不同切面的落地。
- **好用四原则**是 UI 总纲：输入零摩擦 / 引导性 / 内容填满画布 / 撑开高度 / 手机密度都是它的子集落地。
- **无根之木禁令**贯穿全局：智能默认要有根、能力声明要有根、文档配图与索引要有根。
- 各原则正文以 `.claude/rules/*.md` 为准；本表只做命名 + 一句话 + 出处的速查。
