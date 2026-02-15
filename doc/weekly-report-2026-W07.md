# 周报 2026-W07 (02-09 ~ 02-15)

> **总计 239 次提交 | 33 个 PR 合并 (#94 ~ #126)**
>
> **贡献者**：Claude (235 commits), Cursor Agent (4 commits)

---

## 一、已合并 Pull Requests (#94 ~ #126)

| PR | 标题 | 分类 |
|----|------|------|
| #126 | tapd-data-automation — 工作流引擎全栈实现 | ⚙️ 工作流引擎 |
| #125 | show-thinking-section — AI 思维链展示 | 🧠 AI 能力 |
| #124 | streamline-branch-testing — 分支测试器全面升级 | 🔧 DevOps |
| #123 | add-chinese-writing-prompts — 文学创作中文插图描述 | ✍️ 文学 Agent |
| #122 | update-quick-ps1-watch — 后端热重载开发脚本 | 🔧 DevOps |
| #121 | expand-dialog-box — 视觉 Agent 对话面板扩大 | 🎨 视觉 Agent |
| #120 | fix-panel-color — 面板颜色统一修复 | 🎨 UI/UX |
| #119 | remove-duplicate-lists — 模型池编辑去重 | 🔧 模型管理 |
| #118 | refactor-domain-references — 消除硬编码 CDN 域名 | 🏗️ 架构 |
| #117 | separate-nav-skin-tabs — 皮肤与导航独立 Tab | 🎨 UI/UX |
| #116 | fix-image-copy-clipboard — Ctrl+C 画布图片复制修复 | 🐛 Bug 修复 |
| #115 | debug-validation-error — 部署脚本 SHA256 校验改进 | 🔧 DevOps |
| #114 | fix-ui-consistency — 对话框/按钮/登录页一致性修复 | 🎨 UI/UX |
| #113 | unify-panel-colors — 全局面板颜色统一为 CSS 变量 | 🎨 UI/UX |
| #112 | mobile-adaptation-planning — 移动端适配 (全量) | 📱 移动端 |
| #111 | screenshot-tutorial-email — 截图教程邮件功能 | ✨ 新功能 |
| #110 | fix-collapsed-elements — 系统提示词编辑器折叠修复 | 🐛 Bug 修复 |
| #109 | desktop-attachments-skills — 桌面端附件上传 + 技能系统 | 🖥️ 桌面端 |
| #108 | add-card-effect-toolbox — AI 百宝箱卡片效果 + 导航重构 | 🎨 UI/UX |
| #107 | fix-admin-performance — 性能模式 + 散装玻璃迁移 | ⚡ 性能 |
| #106 | fix-image-generation-style — 生图风格推断修复 | 🐛 Bug 修复 |
| #105 | restore-literary-system — 恢复 PR#102 丢失的文学 Agent 功能 | 🐛 Bug 修复 |
| #104 | add-gemini-3-pro-config — Gemini 3 Pro 图片生成模型 | 🧠 AI 能力 |
| #103 | fix-image-url-redraw — 画布交互修复 (dialog/尺寸/Delete键) | 🐛 Bug 修复 |
| #102 | fix-model-list-retrieval — 模型池查询服务提炼 | 🏗️ 架构 |
| #101 | literary-prompt-insertion-system — 提示词技能化全栈架构 | ✨ 新功能 |
| #100 | enable-developer-options — Agent 体验者权限 + 隐藏仪表盘 | 🔐 权限 |
| #99 | webhook-notification-system — 自动化规则 + Webhook + 模板 | ✨ 新功能 |
| #98 | weekly-summary-report — 周报生成 | 📝 文档 |
| #97 | fix-prdagent-update — 桌面端自动更新修复 | 🐛 Bug 修复 |
| #96 | fix-404-empty-response — 桌面端缺陷 Agent 404 修复 | 🐛 Bug 修复 |
| #95 | enable-group-creation — 允许所有用户创建群组 | ✨ 新功能 |
| #94 | postman-curl-env-vars — 冒烟测试环境变量 | 🔧 DevOps |

---

## 二、本周完成

### 1. 工作流引擎 (Workflow Engine) — 从零到一全栈落地

> **价值**：将原本需要开发人员手写脚本的跨系统数据采集、分析、报告流程，变成任何人都能拖拽搭建的自动化流水线，一条工作流可替代数小时重复劳动。

本周最大的功能块（33 次提交），完整实现了可视化 DAG 工作流编排系统。

#### 后端架构

- **WorkflowAgentController**：工作流 CRUD + 执行管理 + SSE 实时推送端点
- **WorkflowRunWorker**：后台执行引擎，按 DAG 拓扑序依次执行节点，管理插槽数据流转
- **CapsuleExecutor**：单舱执行器，路由到具体舱实现并处理输入/输出转换
- **CapsuleTypeRegistry**：中央注册表，定义 18 种舱类型的配置 Schema、插槽、图标

#### 18 种舱类型 (Capsule Types)

| 分类 | 舱类型 | 说明 |
|------|--------|------|
| **触发器 (4)** | Timer | Cron 定时触发 (🚧 需 Cron 调度器) |
| | Webhook Receiver | 外部 POST 请求触发 (🚧 需后端端点) |
| | Manual Trigger | 手动点击执行 |
| | File Upload | 上传 CSV/JSON/TXT 数据源 (🚧 需文件选择器) |
| **处理器 (8)** | TAPD Collector | 拉取 TAPD 缺陷/需求数据 |
| | HTTP Request | 通用 REST API 调用 + JSONPath 提取 |
| | Smart HTTP | 粘贴 cURL 命令，AI 自动检测分页全量拉取 |
| | LLM Analyzer | 智能分析/摘要 (Claude/GPT) |
| | Script Executor | 自定义 JavaScript/Python 脚本 |
| | Data Extractor | JSONPath 数据提取 |
| | Data Merger | 合并多上游输出 (对象/数组/拼接) |
| | Format Converter | JSON/XML/CSV/YAML/TSV/Markdown 互转 |
| **流程控制 (2)** | Delay | 延时等待后透传数据 |
| | Condition | if/else 分支 (==, !=, >, <, contains, empty) |
| **输出 (4)** | Report Generator | LLM 将结构化数据渲染为 Markdown 报告 |
| | File Exporter | 导出 JSON/CSV/Markdown/TXT |
| | Webhook Sender | HTTP POST 推送外部系统 |
| | Notification Sender | 应用内通知 + 告警级别 |

#### 前端三级路由

- **列表页 (WorkflowListPage)**：卡片网格 + Mini DAG 预览 + 节点芯片中文名
- **编辑页 (WorkflowEditorPage)**：双击编辑标题 + Postman 风格 HTTP 配置 + 三段分区布局
- **画布页 (WorkflowCanvas)**：React Flow 可视化编排 + CapsuleNode + FlowEdge

#### 画布视觉效果

- **呼吸光晕**：节点运行时呈现脉动光效
- **流动连线**：数据传输时连线呈流动动画
- **粒子传输**：数据流经边时的粒子效果
- **拖拽优化**：dragHandle 限定拖拽区域 + hover 效果 + 端口球定位修复

#### HTTP 舱 (Smart HTTP Capsule)

- **cURL 全量导入导出**：粘贴 cURL 命令自动解析，支持 46 项测试用例覆盖
- **智能识别**：URL 输入框自动识别 cURL 命令并解析
- **cURL 解析器重写**：修复 URL 丢失、stale state 等关键 bug

#### 流程控制舱

- **延时舱 (Delay)**：配置等待秒数，数据透传
- **条件判断舱 (Condition)**：支持 7 种运算符的 if/else 分支，非匹配分支自动跳过
- **SSE 实时状态推送**：节点执行状态 (pending → running → completed/failed) 实时推送前端

#### 质量保障

- **冒烟测试脚本**：`workflow-agent` 完整冒烟测试
- **一键测试工作流**：一键创建全链路测试工作流 + 标记不可用触发器
- **单舱测试**：改为真实执行，移除表单红色必填标记
- **P0-P2 审计修复**：权限校验 + test-run 类型验证 + 消除双注册表

#### 设计文档

- `doc/design.workflow-control-flow-and-sse.md`：流程控制舱 + SSE 实时推送设计文档

### 2. 移动端适配 (Mobile Adaptation) — 全量落地

> **价值**：团队成员无需坐在电脑前，手机上即可随时查看 PRD 解读、审批通知、AI 对话，真正实现移动办公零门槛。

从零搭建移动端基础设施并适配全部核心页面。

- **5-Tab 架构**：Home / Browse / + / Assets / Profile，底部导航栏带发光中心按钮
- **移动端首页**：P0 Mobile Dashboard，后端 API 提供真实 feed/stats/assets 数据
- **Agent 快捷入口**：放射状扇形菜单 (Radial Fan Menu) 替代 BottomSheet
- **VisualAgent 画布**：重新设计移动端画布交互，增加画笔和上传工具
- **全量页面适配**：批量适配剩余 admin 页面 + 审计工具
- **导航重构**：合并 PRD 协作 → AI 百宝箱，精简 Executive Tab 标签
- **触控优化**：改善移动端触摸目标尺寸

### 3. AI 思维链 (Thinking Content) — 全链路可见

> **价值**：用户不再面对"AI 黑箱"，可以实时看到 AI 的推理过程，既增强结果可信度，也方便产品经理和开发者排查 AI 回答质量问题。

打通 LLM 思维过程从生成到展示的完整链路。

- **流式推送**：思维内容实时流式推送到前端左侧面板
- **持久化存储**：thinking content 写入 messages 和 llm_request_logs
- **多格式支持**：同时捕获 `reasoning_content` 字段和 `<think>` 标签内容
- **桌面端展示**：AI 思考过程在内容前显示，输出时自动折叠
- **Gateway 隔离**：Gateway 层面实现 thinking 隔离 + Intent 模型强制不返回思维链
- **竞态修复**：解决 thinking 早期占位符 + startStreaming 合并竞态条件
- **Markdown 渲染**：思维面板内容支持 Markdown 渲染

### 4. 分支测试器 (Branch Tester) — 架构升级

> **价值**：产品经理和测试人员可以一键切换不同功能分支进行验收，无需等待开发合并代码，功能评审周期从"等部署"缩短到"点一下"。

从简单部署工具升级为完整的多分支开发环境管理器。

- **双容器运行模式**：dotnet API + Vite dev server 独立容器
- **细粒度控制**：Pull / Restart-API / Restart-Web 独立操作按钮
- **Nginx 架构重构**：symlink 切换 + 每分支预生成配置文件 + Docker DNS 解析
- **Gateway 切换**：自由切换所有分支 + 断开连接 + 数据库管理 (clone/switch)
- **诊断系统**：run-diagnostics 端点 + UI 按钮 + 崩溃日志收集
- **基础设施自动化**：启动时自动确保 Docker 网络/MongoDB/Redis (InfraService)
- **分支标识**：构建时注入 BranchBadge 浮动组件，交叉验证 build 分支 vs gateway 分支
- **并发安全**：per-branch busy tracking 替代全局锁
- **UX 改进**：垂直时间线 + 动画部署条纹 + 日志去重

### 5. 文学创作 Agent 增强

> **价值**：创作过程从"等半天出结果"变为"边写边看"的实时体验，中文插图描述让国内用户生成的配图更贴合文章语境。

- **流式输出**：标记生成期间展示完整 AI 输出，完成后切换为文章视图
- **Anchor 模式优化**：流式传输原始 delta 消除 thinking→marker 停顿
- **中文描述**：插图描述改为中文输出，图片中文字保持中文
- **新标记卡片动画**：发光边框入场动画
- **Bug 修复**：4 个关键修复 (滚动跳动、定位、动画、幻影参考图)
- **功能恢复**：修复 PR#102 合并导致的功能丢失

### 6. UI/UX 全局统一

> **价值**：消除各页面视觉风格"各自为政"的割裂感，用户在不同功能间切换时获得一致的品牌体验，同时 Windows 端性能提升明显减少卡顿。

- **面板颜色统一**：所有页面/子组件的面板背景色统一为 CSS 变量 (`--panel-bg`)
- **性能模式重设计**：从模糊玻璃改为 Obsidian 纯色暗黑风格，解决 Windows backdrop-filter 卡顿
- **导航结构重构**：删除仪表盘入口，合并群组/资源/权限/数据到页签，新增 Cmd+K 启动页
- **散装玻璃迁移**：完成剩余 74 处散装液态玻璃样式迁移到统一组件
- **AI 百宝箱卡片**：aurora 渐变头部替换为基础 GlassCard 效果
- **对话框/按钮一致性**：对话框收敛、按钮样式统一、登录页玻璃效果、路由解耦
- **GlassCard 优化**：移除 hover:scale 避免内容位移 + 替换 transition-all 消除卡顿

### 7. 教程邮件系统 (Tutorial Email)

> **价值**：运营人员无需懂 HTML，用自然语言描述就能让 AI 生成专业邮件模板并一键群发，大幅降低用户触达成本。

- **AI 生成**：一键 AI 生成邮件模板 + 快速发送工作流
- **分屏布局**：左预览右对话的分屏布局
- **AppCaller 注册**：`tutorial-email.generate::chat` 接入 LLM Gateway
- **安全加固**：修复模板预览 XSS 风险

### 8. 提示词技能化 (Skill System)

> **价值**：将散落在各处的高质量提示词封装为"一键可用"的技能卡片，新用户无需学习 Prompt 工程即可获得专家级 AI 输出。

- **全栈架构**：统一 Skill 模型 + 服务端 CRUD + 单击执行
- **Admin 管理页面**：完整 CRUD + 权限控制 + 导航集成
- **SkillService 改造**：直接从 prompt_stages 读取系统技能，免迁移
- **桌面端集成**：服务端公共技能 + 客户端本地自定义技能

### 9. 自动化规则 (Automation Rules) 重写

> **价值**：支持通过 Webhook 和消息模板自动触发通知与流程，减少人工盯盘和手动转发，让团队协作事件驱动化。

- **布局重写**：从列表改为 master-detail 分栏布局
- **Webhook 触发器**：新增 incoming webhook 触发类型 + Tab 切换 + 流程预览
- **消息模板**：支持 `{{placeholder}}` 变量插值 + 用户下拉选择通知目标
- **WorkflowProgressBar**：替代 FlowPreview，改进 UserMultiSelect 组件

### 10. 总裁面板 (Executive Dashboard) 迭代

> **价值**：管理层一屏掌握全员 AI 使用情况和团队战力分布，用数据驱动 AI 工具在组织内的推广与资源分配决策。

- **全景战力面板**：重新设计 Team Insights 为 Panoramic Power Panel
- **排行榜**：水平柱状图排名卡片 + 按维度排行榜
- **雷达图迭代**：从 4 图到双图 (Agent vs Activity)，主题化配色
- **去 Mock 化**：移除 mock 数据开关，仅使用真实数据
- **布局优化**：Groups 维度补全、排名表上移、雷达图放大

### 11. LLM 日志图片架构简化

> **价值**：运维和开发人员排查图片生成问题时，可直接在日志中看到输入/输出图片对比，定位问题从"猜"变为"看"。

- **直写架构**：InputImages / OutputImages 直接写入日志，移除回退逻辑
- **双栏预览**：LLM 日志图片预览改为左右布局 + 详情面板加宽
- **测试覆盖**：新增 PatchLogImages 测试 + 修复中文 Unicode 转义

### 12. 桌面端 (Tauri) 增强

> **价值**：桌面端用户可一键切换服务器环境、上传附件、管理缺陷，与 Web 端体验趋于一致，减少"桌面端功能不全"的用户流失。

- **预设服务器选择器**：pa.759800.com / miduo.org / sassagent.com 三服务器切换
- **附件上传**：图片选择/预览/上传完整流程
- **缺陷管理对齐**：Desktop 缺陷面板与 Admin 面板功能对齐
- **自动更新修复**：dialog ACL 权限不足、reqwest multipart feature
- **剪贴板修复**：Ctrl+C 选中画布图片复制到剪贴板

### 13. 架构与基础设施

> **价值**：通过超长文本外存、CDN 集中化、API 权限隔离等底层治理，降低系统运维风险，为后续功能扩展打下更稳固的地基。

- **超长文本 COS 存储**：JSON 字符串值 >1024 字符自动上传 COS，MongoDB 仅存引用
- **CDN 域名集中化**：消除硬编码 CDN 域名引用，统一通过环境变量配置
- **API 权限隔离**：消除 Agent 页面对管理端点 (`/api/mds/`) 的非法调用，各 Agent 使用私有化端点
- **ModelPoolQueryService**：提炼模型池查询为独立服务，各应用 Controller 自带模型列表端点
- **Gemini 3 Pro**：新增 gemini-3-pro-image-preview 图片生成模型配置
- **Gateway 日志增强**：ModelType 重分类修正 + 日志字段澄清 + skill contextScope 串联

### 14. 其他改进

> **价值**：一系列体验细节优化，降低使用门槛（所有人可建群）、提升开发效率（热重载）、增强系统稳定性。

- **群组创建开放**：允许所有用户创建群组，移除 PM/ADMIN 角色限制
- **Agent 体验者权限**：隐藏仪表盘 + 默认拥有 AI 百宝箱权限
- **SSE 解析重构**：SseEventReader + Utf8JsonReader 简化 thinking 解析
- **Tauri 构建优化**：源图标未变时跳过图标生成
- **后端热重载**：quick.ps1 改用 dotnet watch run

---

## 三、本周数据

### 每日提交分布

| 日期 | 提交数 | 重点方向 |
|------|--------|----------|
| 02-09 (周日) | 6 | 教程邮件功能 |
| 02-10 (周一) | 67 | 工作流引擎 MVP、自动化规则、总裁面板、文学 Agent、桌面端 |
| 02-11 (周二) | 49 | 工作流画布编排、移动端适配、技能系统、性能模式 |
| 02-12 (周三) | 6 | CDN 集中化、皮肤/导航分离、剪贴板修复 |
| 02-13 (周四) | 45 | 工作流 HTTP 舱/cURL 解析、分支测试器、思维链持久化 |
| 02-14 (周五) | 50 | 工作流流程控制舱/SSE 推送、分支测试器架构升级、思维链隔离 |
| 02-15 (周六) | 16 | 工作流延时/条件舱、设计文档、Gateway 日志 |

### 提交类型分布

| 类型 | 数量 | 占比 |
|------|------|------|
| feat (新功能) | 58 | 24% |
| fix (Bug 修复) | 92 | 39% |
| refactor (重构) | 30 | 13% |
| docs/chore/perf/ui/style | 15 | 6% |
| 中文 commit / 无前缀 | 44 | 18% |

---

## 四、与上周 (W06) 对比

| 指标 | W06 | W07 | 变化 |
|------|-----|-----|------|
| 提交数 | 241 | 239 | -1% |
| 合并 PR 数 | — | 33 | 新指标 |

### 上周方向落地情况

| W06 建议方向 | W07 实际进展 |
|-------------|-------------|
| P0 PRD Agent 体验重构 | ✅ 技能系统全栈落地，Agent 体验者权限体系 |
| P0 总裁面板 | ✅ Team Insights 全景战力面板 + 去 Mock 化 |
| P1 新手教程 | ✅ 教程邮件系统 (AI 生成 + 分屏布局) |
| P2 移动端 | ✅ **超额完成** — 5-Tab 架构 + 全量页面适配 |
| P2 工作流引擎 | ✅ **超额完成** — 完整 DAG 引擎 + 18 种舱 + 可视化画布 + SSE 实时推送 |

---

## 五、下周优先级建议

| 优先级 | 方向 | 建议动作 |
|--------|------|----------|
| P0 | 工作流引擎稳定化 | 启用 Timer/Webhook/FileUpload 三个 🚧 触发器，端到端集成测试 |
| P0 | 思维链体验打磨 | Gateway thinking 隔离验证 + 前端折叠/展开交互优化 |
| P1 | 移动端 QA | 多设备/多浏览器兼容性测试，触控交互细节打磨 |
| P1 | 知识库 MVP | 文档上传 + 向量索引 + 对话引用 |
| P2 | 分支测试器稳定化 | 集成测试覆盖核心流程，文档补全 |
| P2 | 桌面端功能对齐 | 与 Admin 端剩余功能差异收敛 |
