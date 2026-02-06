# AI 百宝箱 MVP 规划

> **目标**: 用最小代价验证核心价值 - "自然语言驱动多 Agent 协同"
>
> **最后更新**: 2026-02-04
> **状态**: Phase 0 ~ 1.5 已完成 ✅

---

## 0. 快速开始

### 入口地址

| 环境 | 地址 |
|------|------|
| 本地开发 | `http://localhost:5173/ai-toolbox` |
| 后端 API | `http://localhost:5000/api/ai-toolbox/*` |

### 测试命令

```bash
# 后端单元测试
cd prd-api
dotnet test --filter "FullyQualifiedName~Toolbox"

# 后端集成测试
dotnet test --filter "Category=Integration&FullyQualifiedName~AiToolbox"

# 前端启动
cd prd-admin
pnpm dev

# 前端类型检查
pnpm tsc --noEmit
```

### 操作方式

1. **登录后台** → 侧边栏点击 **"AI 百宝箱"**
2. **输入自然语言请求** → 如 "帮我写一篇关于 AI 的文章并配图"
3. **观察执行过程**:
   - 意图识别结果（主意图、置信度、调度的专家）
   - 执行计划（多步骤可视化进度条）
   - 实时流式输出
4. **查看成果物** → 右侧成果区支持预览和下载
5. **历史记录** → 右下角可查看之前的执行记录

---

## 1. 用户故事

### 用户故事 1: 单 Agent - PRD 分析

```
作为产品经理
我想要快速分析一份 PRD 文档的完整性
以便发现潜在的遗漏和问题

验收标准:
- 输入: "帮我分析这个 PRD 有什么问题"
- 系统识别意图为 prd_analysis
- 调用 PRD Agent 进行分析
- 返回结构化的分析报告
```

### 用户故事 2: 单 Agent - 图片生成

```
作为设计师
我想要用自然语言描述生成配图
以便快速获得视觉素材

验收标准:
- 输入: "生成一张科技感的产品封面图，蓝色主题"
- 系统识别意图为 image_generation
- 调用 Visual Agent 生成图片
- 返回生成的图片，支持预览和下载
```

### 用户故事 3: 单 Agent - 内容创作

```
作为内容运营
我想要快速生成一篇文章
以便发布到公众号

验收标准:
- 输入: "帮我写一篇关于人工智能在医疗领域应用的文章"
- 系统识别意图为 content_creation
- 调用 Literary Agent 生成文章
- 返回 Markdown 格式的文章，支持复制
```

### 用户故事 4: 单 Agent - 缺陷管理

```
作为测试工程师
我想要从描述中提取结构化的缺陷信息
以便快速提交 Bug 报告

验收标准:
- 输入: "登录页面点击提交后没有反应，控制台报 500 错误"
- 系统识别意图为 defect_management
- 调用 Defect Agent 提取缺陷信息
- 返回结构化的缺陷报告（标题、描述、复现步骤、严重程度等）
```

### 用户故事 5: 双 Agent 协同 - 写作 + 配图

```
作为自媒体创作者
我想要一次性获得文章和配图
以便提高内容生产效率

验收标准:
- 输入: "帮我写一段关于春天的散文，并配一张插图"
- 系统识别为复合意图 [content_creation, image_generation]
- Step 1: Literary Agent 生成文字
- Step 2: Visual Agent 根据文字生成配图
- 返回文字 + 图片的组合成果
- 用户能看到分步执行进度
```

### 用户故事 6: 双 Agent 协同 - PRD 分析 + 报告生成

```
作为产品总监
我想要分析 PRD 并生成可分享的报告
以便在评审会上使用

验收标准:
- 输入: "分析这份 PRD 的问题，并生成一份汇报用的缺陷清单"
- 系统识别为复合意图 [prd_analysis, defect_management]
- Step 1: PRD Agent 分析文档
- Step 2: Defect Agent 整理成缺陷报告格式
- 返回可下载的报告文档
```

---

## 2. MVP 核心原则

```
砍功能，不砍体验
复用现有，不造轮子
端到端跑通，不求完美
```

---

## 3. MVP 范围定义

### 3.1 包含 (In Scope) ✅ 已完成

| 功能 | 说明 | 复用现有 | 状态 |
|------|------|----------|------|
| 统一对话入口 | 一个输入框，接收自然语言 | 复用 AiChatPage 样式 | ✅ |
| 意图识别 | 识别用户想用哪个 Agent | LLM Gateway | ✅ |
| Agent 路由 | 根据意图调度对应 Agent | 新建路由逻辑 | ✅ |
| 单 Agent 执行 | 调用现有 Agent 能力 | 现有 4 个 Agent | ✅ |
| 双 Agent 串行 | A 的输出作为 B 的输入 | 新建编排逻辑 | ✅ |
| 执行状态展示 | 显示当前执行到哪一步 | Run/Worker + SSE | ✅ |
| Markdown 成果 | 输出 Markdown 格式结果 | 现有消息渲染 | ✅ |

### 3.2 不包含 (Out of Scope for MVP)

| 功能 | 原因 | 后续 Phase |
|------|------|------------|
| 可视化工作流编辑 | 开发量大，非核心验证 | Phase 4 |
| PPT/PDF 生成 | 格式转换复杂 | Phase 3 |
| 插件系统 | 生态建设，优先级低 | Phase 5 |
| 智能体市场 | 需要先有用户创建内容 | Phase 5 |
| 并行 Agent 执行 | 串行已能验证价值 | Phase 2 |
| 自定义 Agent | 先用内置 Agent | Phase 5 |

---

## 4. MVP 架构（极简版）

```
┌─────────────────────────────────────────────────┐
│           AI 百宝箱 MVP                          │
├─────────────────────────────────────────────────┤
│                                                 │
│  ┌───────────────────────────────────────────┐  │
│  │        前端: AiToolboxPage                │  │
│  │  [输入框] → [执行状态] → [结果展示]         │  │
│  └───────────────────────────────────────────┘  │
│                      │                          │
│                      ▼                          │
│  ┌───────────────────────────────────────────┐  │
│  │        AiToolboxController                │  │
│  │  POST /api/ai-toolbox/chat                │  │
│  │  GET  /api/ai-toolbox/runs/{id}/stream    │  │
│  └───────────────────────────────────────────┘  │
│                      │                          │
│                      ▼                          │
│  ┌───────────────────────────────────────────┐  │
│  │        ToolboxRunWorker                   │  │
│  │  1. 意图识别 (IntentClassifier)           │  │
│  │  2. 路由分发 (AgentRouter)                │  │
│  │  3. 执行编排 (SimpleOrchestrator)         │  │
│  └───────────────────────────────────────────┘  │
│                      │                          │
│         ┌───────────┼───────────┐              │
│         ▼           ▼           ▼              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │PRD Agent │ │Visual    │ │Literary  │ ...   │
│  │Adapter   │ │Agent     │ │Agent     │       │
│  └──────────┘ └──────────┘ └──────────┘       │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

## 5. 已完成的实现 ✅

### Phase 0: 统一入口 + 意图路由 ✅

**完成日期**: 2026-02-04

#### 后端实现

- [x] `AiToolboxController.cs` - 主控制器
- [x] `IIntentClassifier.cs` + `IntentClassifier.cs` - 意图识别
- [x] `ToolboxModels.cs` - 数据模型
- [x] `AppCallerRegistry.cs` - 注册 AppCallerCode
- [x] `AdminPermissionCatalog.cs` - 添加权限

#### 验收

```
输入: "帮我分析这个PRD有什么问题"
输出: 识别为 prd_analysis，confidence: 0.95
```

---

### Phase 0.5: 单 Agent 执行 ✅

**完成日期**: 2026-02-04

#### 后端实现

- [x] `IAgentAdapter.cs` - Agent 适配器接口
- [x] `PrdAgentAdapter.cs` - PRD Agent 适配器
- [x] `VisualAgentAdapter.cs` - Visual Agent 适配器
- [x] `LiteraryAgentAdapter.cs` - Literary Agent 适配器
- [x] `DefectAgentAdapter.cs` - Defect Agent 适配器
- [x] `ToolboxRunWorker.cs` - 后台执行 Worker
- [x] `RedisToolboxEventStore.cs` - 事件存储

#### 验收

```
输入: "帮我生成一张夕阳下的猫咪图片"
输出:
  1. 识别意图: image_generation
  2. 调用 Visual Agent
  3. 返回生成的图片
```

---

### Phase 1: 双 Agent 串行协同 ✅

**完成日期**: 2026-02-04

#### 后端实现

- [x] `IToolboxOrchestrator.cs` + `SimpleOrchestrator.cs` - 编排器
- [x] 复合意图识别支持
- [x] 步骤间输出传递

#### 验收

```
输入: "帮我写一段关于春天的文字，并配一张插图"
输出:
  1. 识别为复合意图 [content_creation, image_generation]
  2. Step 1: Literary Agent 生成文字 ✅
  3. Step 2: Visual Agent 基于文字生成配图 ✅
  4. 返回文字 + 图片
```

---

### Phase 1.5: 前端实现 + 成果展示 ✅

**完成日期**: 2026-02-04

#### 前端实现

- [x] `aiToolbox.ts` - API 服务层 + SSE 订阅
- [x] `toolboxStore.ts` - Zustand 状态管理
- [x] `AiToolboxPage.tsx` - 主页面
- [x] `ToolboxInput.tsx` - 输入组件 + 示例提示词
- [x] `ExecutionPlan.tsx` - 执行计划可视化
- [x] `IntentDisplay.tsx` - 意图识别展示
- [x] `ArtifactCard.tsx` - 成果物卡片
- [x] `HistoryList.tsx` - 历史记录
- [x] `dateUtils.ts` - 日期工具
- [x] `App.tsx` - 路由注册
- [x] `AdminMenuCatalog.cs` - 侧边栏菜单

---

## 6. 文件清单

### 后端文件

```
prd-api/src/PrdAgent.Api/
├── Controllers/Api/
│   └── AiToolboxController.cs          # 主 Controller (548行)
└── Services/Toolbox/
    ├── IIntentClassifier.cs            # 意图识别接口
    ├── IntentClassifier.cs             # 意图识别实现 (规则 + LLM)
    ├── IAgentAdapter.cs                # Agent 适配器接口 (194行)
    ├── ToolboxOrchestrator.cs          # 编排器 (303行)
    ├── ToolboxRunWorker.cs             # 后台 Worker (257行)
    └── Adapters/
        ├── PrdAgentAdapter.cs          # PRD Agent 适配器
        ├── VisualAgentAdapter.cs       # Visual Agent 适配器
        ├── LiteraryAgentAdapter.cs     # Literary Agent 适配器
        └── DefectAgentAdapter.cs       # Defect Agent 适配器

prd-api/src/PrdAgent.Core/
├── Models/Toolbox/
│   └── ToolboxModels.cs                # 数据模型
├── Security/
│   ├── AdminPermissionCatalog.cs       # 权限定义
│   └── AdminMenuCatalog.cs             # 菜单定义
└── Models/AppCallerRegistry.cs         # AppCallerCode 注册
```

### 前端文件

```
prd-admin/src/
├── pages/ai-toolbox/
│   ├── index.ts                        # 导出
│   ├── AiToolboxPage.tsx               # 主页面
│   └── components/
│       ├── ToolboxInput.tsx            # 输入框 + 示例
│       ├── IntentDisplay.tsx           # 意图展示
│       ├── ExecutionPlan.tsx           # 执行计划
│       ├── ArtifactCard.tsx            # 成果卡片
│       └── HistoryList.tsx             # 历史记录
├── services/
│   ├── api.ts                          # API 路径
│   ├── index.ts                        # 服务导出
│   └── real/aiToolbox.ts               # API 实现
├── stores/
│   └── toolboxStore.ts                 # 状态管理
├── lib/
│   └── dateUtils.ts                    # 日期工具
└── app/App.tsx                         # 路由注册
```

---

## 7. API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/ai-toolbox/chat` | 发送消息（意图识别 + 自动执行） |
| POST | `/api/ai-toolbox/analyze` | 仅意图识别 |
| GET | `/api/ai-toolbox/runs` | 获取历史列表 |
| GET | `/api/ai-toolbox/runs/{id}` | 获取单个 Run 详情 |
| POST | `/api/ai-toolbox/runs/{id}/execute` | 手动触发执行 |
| GET | `/api/ai-toolbox/runs/{id}/stream` | SSE 事件流 |
| GET | `/api/ai-toolbox/agents` | 获取可用 Agent 列表 |

---

## 8. 待办事项 (TODO)

### Phase 2: 并行 Agent 执行

- [ ] 支持 Agent 并行执行
- [ ] 结果合并策略

### Phase 3: 高级成果物

- [ ] PPT 生成
- [ ] PDF 导出
- [ ] 图表生成

### Phase 4: 可视化工作流

- [ ] 拖拽式工作流编辑器
- [ ] 工作流模板保存/分享

### Phase 5: 插件生态

- [ ] 自定义 Agent 创建
- [ ] Agent 市场
- [ ] 插件系统

---

## 9. 风险与应对

| 风险 | 概率 | 应对 |
|------|------|------|
| 意图识别不准 | 中 | 规则优先 + LLM 兜底，识别失败时让用户手选 |
| Agent 适配复杂 | 低 | 现有 Agent 已有清晰接口，适配工作量可控 |
| 串行编排状态管理 | 中 | 用简单的状态机，不要过度设计 |

---

## 10. MVP 成功标准 ✅

```
✅ 能通过自然语言触发现有 4 个 Agent 中的任意一个
✅ 能执行 "写文章 + 配图" 这样的双 Agent 串行任务
✅ 用户能看到执行进度
✅ 用户能看到最终成果并下载
```
