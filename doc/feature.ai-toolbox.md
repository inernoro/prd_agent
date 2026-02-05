# AI 百宝箱 (AI Toolbox)

> **最后更新**：2026-02-05
> **状态**：开发中
> **负责人**：-

---

## 概述

AI 百宝箱是一个统一的智能工具入口，将多个 AI Agent 聚合在一起，用户可以快速访问和使用各种 AI 能力。

## 入口地址

| 环境 | 地址 |
|------|------|
| 本地开发 | http://localhost:8000/ai-toolbox |
| 测试环境 | http://test.example.com/ai-toolbox |
| 生产环境 | http://prod.example.com/ai-toolbox |

---

## 工具类型

### 定制版 Agent（高级）

有专门的路由页面，点击后跳转到对应的独立功能模块。

| 工具名称 | agentKey | 跳转路由 | 说明 |
|----------|----------|----------|------|
| PRD 分析师 | `prd-agent` | `/prd-agent` | PRD 智能解读与问答 |
| 视觉设计师 | `visual-agent` | `/visual-agent` | 高级视觉创作工作区 |
| 文学创作者 | `literary-agent` | `/literary-agent` | 文学创作与配图 |
| 缺陷管理员 | `defect-agent` | `/defect-agent` | 缺陷提交与跟踪 |

### 普通版 Agent（基础）

使用统一的对话界面，支持文件上传和附件。

| 工具名称 | agentKey | 说明 |
|----------|----------|------|
| 代码审查员 | `code-reviewer` | 代码质量审查 |
| 多语言翻译 | `translator` | 专业级多语言翻译 |
| 内容摘要师 | `summarizer` | 长文本智能摘要 |
| 数据分析师 | `data-analyst` | 数据分析与可视化 |

### 自定义 Agent

用户通过"创建智能体"功能自行定义的 Agent。

---

## 测试用例

### 启动命令

```bash
# 前端开发服务器
cd prd-admin && npm run dev

# 后端 API 服务
cd prd-api && dotnet run --project src/PrdAgent.Api

# 运行前端测试（如有）
cd prd-admin && npm run test

# 运行后端测试
cd prd-api && dotnet test
```

### 手动测试检查点

#### 1. 工具列表页
- [ ] 访问 `/ai-toolbox`，能看到工具卡片网格
- [ ] 定制版工具显示紫色"定制版"标签 + 彩色"内置"标签（两行）
- [ ] 普通内置工具只显示彩色"内置"标签
- [ ] 自定义工具显示绿色"自定义"标签
- [ ] 搜索框能过滤工具
- [ ] 分类筛选（全部/内置工具/我创建的）正常工作

#### 2. 定制版工具
- [ ] 点击 PRD 分析师，跳转到 `/prd-agent`
- [ ] 点击 视觉设计师，跳转到 `/visual-agent`
- [ ] 点击 文学创作者，跳转到 `/literary-agent`
- [ ] 点击 缺陷管理员，跳转到 `/defect-agent`

#### 3. 普通版工具
- [ ] 点击 代码审查员，显示对话界面
- [ ] 对话界面显示工具信息（左侧面板）
- [ ] 能输入文字并发送
- [ ] 能上传文件（📎 按钮）
- [ ] 能上传图片（🖼️ 按钮）
- [ ] 附件预览正常，可删除
- [ ] 消息气泡显示正确（用户右侧，AI 左侧）

#### 4. 创建智能体
- [ ] 点击"创建智能体"按钮，进入编辑页面
- [ ] 能填写名称、描述、提示词
- [ ] 能选择图标
- [ ] 能添加标签
- [ ] 保存后在列表中显示

---

## 操作方式

### 浏览工具
1. 进入 AI 百宝箱页面
2. 浏览工具卡片，通过标签区分类型：
   - 紫色"定制版" = 有专门页面
   - 彩色"内置" = 系统内置
   - 绿色"自定义" = 用户创建
3. 使用搜索框或筛选器快速定位

### 使用定制版工具
1. 点击带有"定制版"标签的工具卡片
2. 自动跳转到对应的专门页面
3. 在专门页面中使用完整功能

### 使用普通版工具
1. 点击普通工具卡片
2. 进入对话界面
3. 在底部输入框输入内容
4. 可选：点击 📎 上传文件，点击 🖼️ 上传图片
5. 按 Enter 或点击发送按钮
6. 查看 AI 响应

### 创建自定义 Agent
1. 点击右上角"创建智能体"
2. 填写基本信息（名称、描述）
3. 配置 Agent 设定（提示词、能力）
4. 选择图标和添加标签
5. 保存

---

## 用户故事

### US-001: 快速访问 AI 工具
**作为** 产品经理
**我希望** 在一个统一入口看到所有可用的 AI 工具
**以便于** 快速找到并使用我需要的功能

**验收标准：**
- 工具以卡片形式展示
- 能通过搜索和筛选快速定位
- 卡片显示工具名称、描述、类型标签

### US-002: 区分工具类型
**作为** 用户
**我希望** 能一眼区分定制版和普通版工具
**以便于** 知道点击后会发生什么

**验收标准：**
- 定制版工具有明显的"定制版"标签
- 定制版工具点击后跳转到专门页面
- 普通工具点击后显示对话界面

### US-003: 使用普通版对话
**作为** 用户
**我希望** 能通过对话方式使用普通版 Agent
**以便于** 快速完成简单任务

**验收标准：**
- 对话界面支持文字输入
- 支持上传文件和图片
- 显示对话历史
- AI 响应以消息气泡形式展示

### US-004: 创建自定义 Agent
**作为** 高级用户
**我希望** 能创建自己的 AI Agent
**以便于** 满足个性化需求

**验收标准：**
- 能配置 Agent 名称、描述、提示词
- 能选择图标和添加标签
- 创建后出现在工具列表中
- 可以编辑和删除自己创建的 Agent

---

## 待办事项 (TODO)

### P0 - 必须完成
- [x] 工具卡片网格布局
- [x] 定制版/普通版类型区分
- [x] 定制版跳转到专门路由
- [x] 普通版对话界面 UI
- [x] 文件/图片上传 UI
- [ ] 普通版对话 API 调通

### P1 - 应该完成
- [ ] 创建智能体表单完善
- [ ] Agent 配置保存到后端
- [ ] 对话历史持久化
- [ ] 多轮对话支持

### P2 - 可以延后
- [ ] Agent 使用统计
- [ ] Agent 分享功能
- [ ] Agent 市场（海鲜市场对接）
- [ ] Agent 版本管理

---

## 技术架构

### 前端文件结构

```
prd-admin/src/
├── pages/ai-toolbox/
│   ├── AiToolboxPage.tsx       # 主页面
│   └── components/
│       ├── ToolCard.tsx        # 工具卡片
│       ├── ToolDetail.tsx      # 工具详情/对话界面
│       ├── ToolEditor.tsx      # 创建/编辑表单
│       ├── ToolRunner.tsx      # 运行状态展示
│       └── BasicCapabilities.tsx # 基础能力 Tab
├── stores/
│   └── toolboxStore.ts         # Zustand 状态管理
└── services/real/
    └── aiToolbox.ts            # API 服务
```

### 数据模型

```typescript
interface ToolboxItem {
  id: string;
  name: string;
  description: string;
  icon: string;               // Lucide 图标名称
  category: 'builtin' | 'custom';
  type: 'builtin' | 'custom';
  agentKey?: string;          // 关联的 Agent 标识
  routePath?: string;         // 定制版跳转路由（有则为定制版）
  prompt?: string;            // 系统提示词
  modelId?: string;           // 使用的模型
  tags: string[];
  usageCount: number;
  createdAt: string;
  createdBy?: string;
}
```

### API 端点（规划中）

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/ai-toolbox/items` | 获取工具列表 |
| POST | `/api/ai-toolbox/items` | 创建自定义工具 |
| PUT | `/api/ai-toolbox/items/{id}` | 更新工具 |
| DELETE | `/api/ai-toolbox/items/{id}` | 删除工具 |
| POST | `/api/ai-toolbox/chat` | 普通版对话（规划中） |

---

## 变更历史

| 日期 | 版本 | 变更内容 |
|------|------|----------|
| 2026-02-05 | v0.1 | 初始版本，完成工具列表和类型区分 |
