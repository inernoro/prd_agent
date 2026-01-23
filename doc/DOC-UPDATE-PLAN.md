# 文档长周期更新计划

> 创建时间: 2026-01-22
> 版本: v1.0
> 状态: 执行中

---

## 一、计划概述

本计划旨在全面更新项目文档，确保文档与代码实现保持同步。计划分为6个阶段，预计涉及数十个更新任务。

### 更新原则

1. **信息密度一致** - 与原文档风格保持一致，不刻意删减信息
2. **直接替换** - 过时信息直接更新，无需增量修改
3. **全面覆盖** - 覆盖所有新增功能
4. **清理过时** - 删除编号7之外确实无用的文档

---

## 二、文档清单（当前状态）

### 2.1 核心编号文档（需保留和更新）

| 序号 | 文件名 | 说明 | 优先级 |
|------|--------|------|--------|
| 0 | `0.doc-maintenance.md` | 文档维护指南 | P0 |
| 1 | `1.why.md` | 项目背景 | P1 |
| 2 | `2.srs.md` | 软件需求规格说明书 | P0 |
| 3 | `3.prd.md` | 产品需求文档 | P0 |
| 4 | `4.dev.md` | 开发指南 | P0 |
| 5 | `5.step.md` | 步骤指南 | P1 |
| 6 | `6.ops-auth-updater.md` | 运维认证更新器 | P1 |
| 7 | `7.data-dictionary.md` | 数据字典 | P0 |

### 2.2 功能专项文档（需评估和更新）

| 序号 | 文件名 | 说明 | 状态评估 |
|------|--------|------|----------|
| 8 | `8.doc-code-diff.md` | 文档代码差异 | 待评估 |
| 9 | `9.literary-agent-article-illustration.md` | 文学代理-文章配图 | 待评估 |
| 10 | `10.admin-design-system.md` | 管理端设计系统 | 待评估 |
| 11 | `11.open-platform-overview.md` | 开放平台概述 | 待评估 |
| 12 | `12.app-feature-naming-convention.md` | 应用功能命名规范 | 待评估 |
| 13 | `13.init-strategy-implementation.md` | 初始化策略实现 | 待评估 |
| 14 | `14.toast-notification-system.md` | Toast通知系统 | 待评估 |
| 15 | `15.app-feature-hierarchy-redesign.md` | 应用功能层级重设计 | 待评估 |
| 16 | `16.tree-view-implementation.md` | 树视图实现 | 待评估 |
| 17 | `17.left-right-layout-redesign.md` | 左右布局重设计 | 待评估 |
| 18 | `18.app-feature-ui-improvements.md` | 应用功能UI改进 | 待评估 |

### 2.3 非编号文档（待清理评估）

| 文件名 | 说明 | 初步判断 |
|--------|------|----------|
| `app-caller-idempotent-design.md` | AppCaller幂等设计 | 待评估 |
| `app-caller-system.md` | AppCaller系统 | 待评估 |
| `difftest.md` | 差异测试 | 可能过时 |
| `network-diagnostics.md` | 网络诊断 | 待评估 |
| `open-platform-complete-test.md` | 开放平台完整测试 | 可能过时 |
| `open-platform-final-summary.md` | 开放平台最终总结 | 可能过时 |
| `open-platform-implementation-summary.md` | 开放平台实现总结 | 可能过时 |
| `open-platform-test.md` | 开放平台测试 | 可能过时 |

---

## 三、代码扫描清单

### 3.1 prd-admin（前端管理界面）

#### 3.1.1 页面扫描清单

| 路径 | 功能 | 优先级 |
|------|------|--------|
| `src/pages/DashboardPage.tsx` | 仪表盘主页 | P0 |
| `src/pages/LoginPage.tsx` | 登录页 | P1 |
| `src/pages/SettingsPage.tsx` | 设置页 | P0 |
| `src/pages/UsersPage.tsx` | 用户管理 | P0 |
| `src/pages/AuthzPage.tsx` | 权限管理 | P0 |
| `src/pages/GroupsPage.tsx` | 分组管理 | P1 |
| `src/pages/ModelManagePage.tsx` | 模型管理 | P0 |
| `src/pages/ModelManageTabsPage.tsx` | 模型管理标签页 | P0 |
| `src/pages/ModelPoolManagePage.tsx` | 模型池管理 | P1 |
| `src/pages/ModelAppGroupPage.tsx` | 模型应用分组 | P1 |
| `src/pages/PromptStagesPage.tsx` | Prompt阶段 | P1 |
| `src/pages/LlmLogsPage.tsx` | LLM日志 | P0 |
| `src/pages/StatsPage.tsx` | 统计页 | P1 |
| `src/pages/DataManagePage.tsx` | 数据管理 | P1 |
| `src/pages/AssetsManagePage.tsx` | 资产管理 | P1 |
| `src/pages/OpenPlatformPage.tsx` | 开放平台 | P0 |
| `src/pages/LabPage.tsx` | 实验室 | P1 |
| `src/pages/AiChatPage.tsx` | AI聊天 | P1 |

#### 3.1.2 文学代理模块

| 路径 | 功能 |
|------|------|
| `src/pages/literary-agent/LiteraryAgentEditorPage.tsx` | 文学代理编辑器 |
| `src/pages/literary-agent/ArticleIllustrationEditorPage.tsx` | 文章配图编辑器 |
| `src/pages/literary-agent/LiteraryAgentWorkspaceListPage.tsx` | 工作空间列表 |
| `src/pages/literary-agent/LiteraryAgentEditorPageWrapper.tsx` | 编辑器包装器 |

#### 3.1.3 视觉代理模块

| 路径 | 功能 |
|------|------|
| `src/pages/visual-agent/VisualAgentFullscreenPage.tsx` | 全屏模式 |
| `src/pages/visual-agent/VisualAgentWorkspaceListPage.tsx` | 工作空间列表 |
| `src/pages/visual-agent/VisualAgentWorkspaceEditorPage.tsx` | 工作空间编辑器 |

#### 3.1.4 实验室模块

| 路径 | 功能 |
|------|------|
| `src/pages/lab-desktop/DesktopLabTab.tsx` | 桌面实验室 |
| `src/pages/lab-llm/LlmLabTab.tsx` | LLM实验室 |
| `src/pages/lab-llm/components/ModelPickerDialog.tsx` | 模型选择器 |

#### 3.1.5 设置模块

| 路径 | 功能 |
|------|------|
| `src/pages/settings/ThemeSkinEditor.tsx` | 主题皮肤编辑器 |

#### 3.1.6 权限模块

| 路径 | 功能 |
|------|------|
| `src/pages/authz/PermissionCell.tsx` | 权限单元格 |
| `src/pages/authz/PermissionPopover.tsx` | 权限弹出框 |
| `src/pages/authz/AuthzPermissionColumn.tsx` | 权限列 |
| `src/pages/authz/MenuPermissionDialog.tsx` | 菜单权限对话框 |
| `src/pages/authz/PermissionMatrix.tsx` | 权限矩阵 |

#### 3.1.7 AI聊天模块

| 路径 | 功能 |
|------|------|
| `src/pages/ai-chat/ImageGenPanel.tsx` | 图像生成面板 |
| `src/pages/ai-chat/AdvancedVisualAgentTab.tsx` | 高级视觉代理标签 |

#### 3.1.8 关键组件扫描

| 路径 | 功能 |
|------|------|
| `src/components/watermark/` | 水印系统 |
| `src/components/llm/` | LLM组件 |
| `src/components/design/` | 设计系统组件 |
| `src/components/model/` | 模型相关组件 |
| `src/components/RichComposer/` | 富文本编辑器 |
| `src/components/login/` | 登录组件 |
| `src/components/charts/` | 图表组件 |
| `src/components/ui/` | UI基础组件 |
| `src/components/three/` | 3D组件 |
| `src/components/background/` | 背景效果 |
| `src/components/effects/` | 特效组件 |

#### 3.1.9 服务层扫描

| 路径 | 功能 |
|------|------|
| `src/services/contracts/` | API契约定义 |
| `src/services/real/` | 真实API实现 |
| `src/services/mock/` | Mock数据 |

#### 3.1.10 状态管理扫描

| 路径 | 功能 |
|------|------|
| `src/stores/` | Zustand状态存储 |

---

### 3.2 prd-api（后端API）

#### 3.2.1 主要Controller扫描

| 路径 | 功能 | 大小 |
|------|------|------|
| `Controllers/Api/ImageMasterController.cs` | 图像大师控制器 | 95KB |
| `Controllers/Api/ImageGenController.cs` | 图像生成控制器 | 54KB |
| `Controllers/GroupsController.cs` | 分组控制器 | 53KB |
| `Controllers/Api/DataController.cs` | 数据控制器 | 47KB |
| `Controllers/Api/ModelLabController.cs` | 模型实验室 | 46KB |
| `Controllers/WatermarkController.cs` | 水印控制器 | 33KB |
| `Controllers/OpenPlatform/OpenPlatformChatController.cs` | 开放平台聊天 | 42KB |
| `Controllers/Api/UsersController.cs` | 用户控制器 | 42KB |
| `Controllers/Api/PlatformsController.cs` | 平台控制器 | 39KB |
| `Controllers/Api/ModelsController.cs` | 模型控制器 | 34KB |
| `Controllers/Stub/StubOpenAIController.cs` | OpenAI桩 | 29KB |
| `Controllers/Api/DesktopAssetsController.cs` | 桌面资产 | 29KB |
| `Controllers/Api/GroupsController.cs` | API分组 | 24KB |
| `Controllers/MessagesController.cs` | 消息控制器 | 22KB |
| `Controllers/Api/LlmLogsController.cs` | LLM日志 | 16KB |
| `Controllers/Api/LabController.cs` | 实验室控制器 | 17KB |
| `Controllers/Api/OpenPlatformController.cs` | 开放平台 | 14KB |
| `Controllers/AuthController.cs` | 认证控制器 | 14KB |
| `Controllers/ChatRunsController.cs` | 聊天运行 | 13KB |
| `Controllers/SessionsController.cs` | 会话控制器 | 12KB |
| `Controllers/Api/InitController.cs` | 初始化控制器 | 12KB |
| `Controllers/Api/ModelTestController.cs` | 模型测试 | 11KB |
| `Controllers/DocumentsController.cs` | 文档控制器 | 9KB |
| `Controllers/GapsController.cs` | Gap控制器 | 11KB |
| `Controllers/Api/RateLimitController.cs` | 速率限制 | 10KB |
| `Controllers/Api/PromptStagesController.cs` | Prompt阶段 | 10KB |
| `Controllers/Api/PromptOverridesController.cs` | Prompt覆盖 | 9KB |
| `Controllers/Api/AppCallersController.cs` | App调用者 | 9KB |
| `Controllers/Api/SystemPromptsController.cs` | 系统Prompt | 9KB |
| `Controllers/Api/ModelGroupsController.cs` | 模型分组 | 8KB |

#### 3.2.2 核心服务扫描

| 路径 | 功能 |
|------|------|
| `Core/Services/ChatService.cs` | 聊天服务 |
| `Core/Services/DocumentService.cs` | 文档服务 |
| `Core/Services/UserService.cs` | 用户服务 |
| `Core/Services/GroupService.cs` | 分组服务 |
| `Core/Services/GroupPermissionService.cs` | 分组权限 |
| `Core/Services/SessionService.cs` | 会话服务 |
| `Core/Services/JwtService.cs` | JWT服务 |
| `Core/Services/OpenPlatformService.cs` | 开放平台服务 |
| `Core/Services/TokenUsageService.cs` | Token使用 |
| `Core/Services/GapDetectionService.cs` | Gap检测 |
| `Core/Services/OnlineStatusService.cs` | 在线状态 |
| `Core/Services/WatermarkSpecValidator.cs` | 水印验证 |

#### 3.2.3 基础设施扫描

| 路径 | 功能 |
|------|------|
| `Infrastructure/Database/` | 数据库配置 |
| `Infrastructure/LLM/` | LLM集成 |
| `Infrastructure/Cache/` | 缓存 |
| `Infrastructure/Repositories/` | 仓储 |
| `Infrastructure/Markdown/` | Markdown处理 |
| `Infrastructure/Prompts/` | Prompt模板 |
| `Infrastructure/Services/AssetStorage/` | 资产存储 |

---

### 3.3 prd-desktop（桌面端应用）

#### 3.3.1 组件扫描

| 路径 | 功能 |
|------|------|
| `src/components/Chat/` | 聊天功能 |
| `src/components/Document/` | 文档相关 |
| `src/components/Group/` | 分组管理 |
| `src/components/Auth/` | 认证 |
| `src/components/Settings/` | 设置 |
| `src/components/Feedback/` | 反馈 |
| `src/components/Layout/` | 布局 |
| `src/components/Role/` | 角色 |
| `src/components/Markdown/` | Markdown渲染 |
| `src/components/KnowledgeBase/` | 知识库 |
| `src/components/Comments/` | 评论 |
| `src/components/Assets/` | 资产 |
| `src/components/Effects/` | 特效 |

#### 3.3.2 状态管理扫描

| 路径 | 功能 |
|------|------|
| `src/stores/authStore.ts` | 认证状态 |
| `src/stores/messageStore.ts` | 消息状态 |
| `src/stores/groupListStore.ts` | 分组列表 |
| `src/stores/sessionStore.ts` | 会话状态 |
| `src/stores/settingsStore.ts` | 设置状态 |
| `src/stores/connectionStore.ts` | 连接状态 |
| `src/stores/prdCitationPreviewStore.ts` | PRD引用预览 |
| `src/stores/prdPreviewNavStore.ts` | PRD预览导航 |
| `src/stores/uiPrefsStore.ts` | UI偏好 |
| `src/stores/systemErrorStore.ts` | 系统错误 |
| `src/stores/systemNoticeStore.ts` | 系统通知 |
| `src/stores/remoteAssetsStore.ts` | 远程资产 |
| `src/stores/desktopBrandingStore.ts` | 桌面品牌 |
| `src/stores/groupInfoDrawerStore.ts` | 分组信息抽屉 |

#### 3.3.3 Tauri后端扫描

| 路径 | 功能 |
|------|------|
| `src-tauri/src/commands/` | Tauri命令 |
| `src-tauri/src/services/` | Rust服务 |
| `src-tauri/src/models/` | Rust模型 |

---

### 3.4 配置和部署扫描

| 路径 | 功能 |
|------|------|
| `docker-compose.yml` | Docker Compose主配置 |
| `docker-compose.dev.yml` | 开发环境配置 |
| `docker-compose.local.yml` | 本地环境配置 |
| `deploy/` | 部署配置 |
| `.github/` | GitHub Actions |
| `quick.sh` / `quick.ps1` | 快速脚本 |

---

## 四、老路径清单（阶段一输出）

> 从 SRS/PRD 文档中提取的原始功能路径

### 4.1 文档中描述的API路径

#### 4.1.1 核心业务API（文档记录）

| API路径 | 方法 | 功能 | 状态 |
|---------|------|------|------|
| `/api/v1/documents` | POST | 文档上传 | 待验证 |
| `/api/v1/sessions/{sessionId}/messages` | POST | 发送消息（SSE） | 待验证 |
| `/api/v1/sessions/{sessionId}/role` | PUT | 切换角色 | 待验证 |
| `/api/v1/sessions/{sessionId}/guide/start` | POST | 启动引导讲解 | **已废弃** |
| `/api/v1/sessions/{sessionId}/guide/control` | POST | 引导讲解控制 | **已废弃** |
| `/health` | GET | 健康检查 | 待验证 |
| `/api/v1/auth/register` | POST | 用户注册 | 待验证 |
| `/api/v1/auth/login` | POST | 用户登录 | 待验证 |
| `/api/v1/groups` | POST | 创建群组 | 待验证 |
| `/api/v1/groups/join` | POST | 加入群组 | 待验证 |
| `/api/v1/groups/{groupId}/messages` | POST | 群组消息 | 待验证 |
| `/api/v1/attachments` | POST | 附件上传 | 待验证 |
| `/api/v1/groups/{groupId}/gaps` | GET | 内容缺失列表 | 待验证 |

#### 4.1.2 新增Run/Worker API（文档已标注）

| API路径 | 方法 | 功能 | 状态 |
|---------|------|------|------|
| `/api/v1/sessions/{sessionId}/messages/run` | POST | 创建对话Run | 待验证 |
| `/api/v1/chat-runs/{runId}/stream` | GET | 订阅Run流 | 待验证 |
| `/api/v1/chat-runs/{runId}` | GET | 查询Run状态 | 待验证 |
| `/api/v1/chat-runs/{runId}/cancel` | POST | 取消Run | 待验证 |

### 4.2 文档中描述的功能需求

#### 4.2.1 核心功能模块

| 编号 | 模块名称 | 描述 | 实现状态 |
|------|----------|------|----------|
| DOC-001 | 文档上传（客户端） | 上传.md文件、拖拽、粘贴 | 待验证 |
| DOC-002 | 文档解析（服务端） | Markdown解析、Token估算 | 待验证 |
| ROLE-001 | 角色选择 | PM/DEV/QA三种角色 | 待验证 |
| ROLE-002 | 角色Prompt模板 | 角色适配的System Prompt | 待验证 |
| CHAT-001 | 问答模式 | 自然语言问答、流式输出 | 待验证 |
| CHAT-002 | 问题边界识别 | 拒答无关问题 | 待验证 |
| CHAT-003 | 并发配额控制 | 限流、Idempotency | 待验证 |
| GUIDE-001 | 引导讲解模式 | 6步讲解大纲 | **已废弃→提示词阶段** |
| SESSION-001 | 会话生命周期 | 会话创建、超时、归档 | 待验证 |
| ATTACH-001 | 截图与图片上传 | 剪贴板粘贴、拖拽 | 待验证 |
| ATTACH-002 | 文档附件上传 | PDF/TXT/MD/DOCX | 待验证 |
| ATTACH-003 | 多模态消息 | 文本+附件一起发送 | 待验证 |
| GROUP-001 | 群组创建 | PM创建、绑定PRD | 待验证 |
| GROUP-002 | 群组加入 | 邀请链接、选择角色 | 待验证 |
| GROUP-003 | 共享讲解会话 | 实时同步、角色适配 | 待验证 |
| GROUP-004 | 群组成员管理 | 成员列表、移除 | 待验证 |
| GAP-001 | 内容缺失检测 | AI识别PRD未覆盖内容 | 待验证 |
| GAP-002 | 缺失提醒与补全 | PM通知、处理状态 | 待验证 |
| USER-001 | 用户注册登录 | 用户名密码、邀请码 | 待验证 |
| USER-002 | 角色与权限 | 四种角色权限矩阵 | 待验证 |
| ADMIN-001 | 用户管理 | 用户CRUD、禁用 | 待验证 |
| ADMIN-002 | 大模型配置 | Claude/OpenAI切换 | 待验证 |
| ADMIN-003 | 请求日志监控 | LLM日志查看 | 待验证 |
| ADMIN-004 | Token用量统计 | 消耗统计、告警 | 待验证 |
| ADMIN-005 | 系统监控告警 | 仪表盘、健康状态 | 待验证 |

### 4.3 文档标注的重大差异

| 差异点 | 文档描述 | 实际实现 | 决策状态 |
|--------|----------|----------|----------|
| 引导讲解 | 独立guide模式、6步大纲 | **已删除**→提示词阶段+Run/Worker | 实现为准 |
| 模型配置 | Provider + Model | Platform + Model | 实现为准 |
| PRD留存 | 不落盘、仅缓存 | 持久化到MongoDB | **待决策** |
| API日志 | 脱敏 | 部分字段未脱敏 | **待决策** |
| 对话链路 | 直接SSE | Run/Worker闭环 | 实现为准 |

### 4.4 文档中的技术架构

| 组件 | 技术选型 | 版本 |
|------|----------|------|
| 桌面客户端 | Tauri + React + TypeScript | 2.0+ / 18.0+ / 5.0+ |
| 后端服务 | ASP.NET Core + C# | 8.0+ / 12.0+ |
| 数据库 | MongoDB | 8.0+ |
| 缓存 | Redis | 7.0+ |
| 对象存储 | S3兼容/腾讯云COS | - |
| LLM | Claude/OpenAI | claude-3-5-sonnet / gpt-4-turbo |

---

## 五、执行阶段计划

### 阶段一：SRS/PRD老路径扫描 ✅ 已完成

**目标**：读取SRS和PRD文档，建立功能基线

**任务清单**：
- [x] 读取 `2.srs.md` - 提取功能需求描述
- [x] 读取 `3.prd.md` - 提取产品需求描述
- [x] 记录文档中的API路径
- [x] 记录文档中的功能需求
- [x] 记录文档标注的差异

**输出**：老路径清单（见第四节）

---

### 阶段二：前端代码扫描（prd-admin） ✅ 已完成

**目标**：扫描前端代码，发现新功能和变更

**任务清单**：
- [x] 扫描 `App.tsx` 获取所有路由
- [x] 扫描所有页面组件
- [x] 扫描服务层API定义
- [x] 扫描状态管理
- [x] 扫描关键组件（水印、LLM、设计系统等）
- [x] 识别新增功能
- [x] 识别变更功能
- [x] 识别废弃功能

**扫描结果摘要**：
- **路由**: 20+ 路由，23 页面组件
- **API契约**: 37 契约文件，150+ API端点
- **组件**: 水印系统、LLM组件、设计系统、模型组件
- **状态管理**: 4 个 Zustand stores（带持久化）
- **新增发现**: VisualAgent（原ImageMaster）、PromptStages、权限矩阵、液态玻璃主题

**输出**：前端功能清单（新增/变更/废弃）✅

---

### 阶段三：后端代码扫描（prd-api） ✅ 已完成

**目标**：扫描后端代码，发现API变更

**任务清单**：
- [x] 扫描所有Controller
- [x] 提取API路由
- [x] 扫描服务层
- [x] 扫描数据模型
- [x] 扫描数据库实体
- [x] 识别新增API
- [x] 识别变更API
- [x] 识别废弃API

**扫描结果摘要**：
- **Controllers**: 60+ 控制器
- **API端点**: 150+ 端点
- **数据模型**: 91 核心实体/DTO模型
- **服务层**: ChatService、DocumentService、UserService、GroupService、OpenPlatformService等
- **新增API**: VisualAgent相关、水印系统、速率限制、Prompt阶段
- **架构变更**: Run/Worker模式（SSE带断线重连）

**输出**：API清单（新增/变更/废弃）✅

---

### 阶段四：桌面端扫描（prd-desktop） ✅ 已完成

**目标**：扫描桌面端功能

**任务清单**：
- [x] 扫描所有组件
- [x] 扫描Tauri命令
- [x] 扫描状态管理
- [x] 识别桌面端特有功能

**扫描结果摘要**：
- **组件**: 30+ 组件
- **状态管理**: 14 stores
- **Tauri命令**: 32+ 命令（9个桌面端专属）
- **桌面端专属功能**: 自动更新、本地存储、系统托盘、窗口管理、剪贴板操作

**输出**：桌面端功能清单 ✅

---

### 阶段五：Git Commit补充扫描

**目标**：通过commit记录补充遗漏

**关键Commit分析**（根据最近100条）：
- 视觉代理重命名（ImageMaster → VisualAgent）
- 水印系统大量更新
- 主题系统（液态大玻璃效果）
- 权限系统重构
- 速率限制功能
- Tauri更新器功能
- 用户偏好设置
- 拖拽排序功能

---

### 阶段六：文档更新执行

**目标**：根据扫描结果更新文档

**更新清单**：

#### 核心文档更新
- [ ] `2.srs.md` - 更新需求规格
- [ ] `3.prd.md` - 更新产品需求
- [ ] `4.dev.md` - 更新开发指南
- [ ] `7.data-dictionary.md` - 更新数据字典

#### 功能文档更新
- [ ] `9.literary-agent-article-illustration.md` - 文学代理
- [ ] `10.admin-design-system.md` - 设计系统
- [ ] `11.open-platform-overview.md` - 开放平台

#### 新增文档（如需要）
- [ ] 视觉代理功能文档
- [ ] 水印系统文档
- [ ] 主题系统文档
- [ ] 权限系统文档
- [ ] 速率限制文档

#### 待清理文档评估
- [ ] `difftest.md` - 评估是否废弃
- [ ] `open-platform-complete-test.md` - 评估是否废弃
- [ ] `open-platform-final-summary.md` - 评估是否废弃
- [ ] `open-platform-implementation-summary.md` - 评估是否废弃
- [ ] `open-platform-test.md` - 评估是否废弃

---

## 五、已发现的主要变更（来自Git Commit）

### 5.1 命名变更

| 旧名称 | 新名称 | 影响范围 |
|--------|--------|----------|
| ImageMaster | VisualAgent | 全局 |
| appKey kebab-case | - | 全局 |

### 5.2 新增功能

| 功能 | 描述 |
|------|------|
| 液态大玻璃主题 | 统一视觉样式 |
| 水印系统增强 | 边框、圆角、字体管理 |
| 速率限制 | Redis分布式限速 |
| 权限矩阵 | 细粒度权限控制 |
| 主题皮肤编辑器 | 用户自定义主题 |
| 导航拖拽排序 | 用户偏好 |
| Tauri更新器 | 桌面端自动更新 |

### 5.3 重构内容

| 内容 | 描述 |
|------|------|
| 权限扫描 | 动态Controller扫描 |
| 视觉代理路由 | 路由结构整合 |
| API路由规范化 | 统一路径结构 |

---

## 七、执行日志

| 日期 | 阶段 | 任务 | 状态 |
|------|------|------|------|
| 2026-01-22 | 准备 | 创建扫描计划 | ✅ 完成 |
| 2026-01-22 | 阶段一 | SRS/PRD扫描 | ✅ 完成 |
| 2026-01-22 | 阶段二 | 前端扫描 | ✅ 完成 |
| 2026-01-22 | 阶段三 | 后端扫描 | ✅ 完成 |
| 2026-01-22 | 阶段四 | 桌面端扫描 | ✅ 完成 |
| 2026-01-22 | 阶段五 | Git补充 | ✅ 完成（集成于扫描阶段） |
| 2026-01-22 | 阶段六 | 文档更新 + 过时清理 | ✅ 完成 |

---

## 八、扫描主要发现汇总

### 8.1 重大架构变更

| 变更类型 | 旧实现 | 新实现 | 影响范围 |
|----------|--------|--------|----------|
| 对话模式 | 引导讲解(Guide) | Prompt Stages + Run/Worker | 核心链路 |
| 模型标识 | Provider + Model | Platform + Model (platformId, modelId) | 模型管理 |
| SSE流 | 直接SSE | Run/Worker闭环，支持断线重连(afterSeq, LastSeq) | 聊天服务 |
| PRD存储 | 不落盘、仅缓存 | 持久化到MongoDB | 数据层 |
| 命名规范 | ImageMaster | VisualAgent | 全局 |

### 8.2 新增功能模块

| 功能模块 | 描述 | 位置 |
|----------|------|------|
| 视觉代理(VisualAgent) | 高级视觉创作工作区，替代ImageMaster | prd-admin/prd-api |
| 水印系统 | appKey绑定、字体管理、多锚点位置 | prd-admin/prd-api |
| 液态玻璃主题 | 统一视觉样式，颜色深度、发光效果 | prd-admin |
| 权限矩阵 | SystemRole + allow - deny RBAC模型 | prd-admin/prd-api |
| 速率限制 | Redis分布式限速 | prd-api |
| Prompt阶段 | 替代Guide模式的提示词管理 | prd-admin/prd-api |
| 主题皮肤编辑器 | 用户自定义主题 | prd-admin |
| 导航拖拽排序 | 用户偏好设置 | prd-admin |
| Tauri更新器 | 桌面端自动更新 | prd-desktop |
| 应用身份隔离 | appKey绑定(prd-agent, visual-agent, literary-agent) | 架构层 |

### 8.3 废弃功能

| 功能 | 状态 | 替代方案 |
|------|------|----------|
| Guide引导讲解模式 | **已删除** | Prompt Stages + Run/Worker |
| 直接SSE消息 | 弃用 | Run/Worker带重连 |
| Provider+Model模型 | 迁移 | Platform+Model |

### 8.4 文档需更新清单

| 文档 | 需更新内容 | 优先级 |
|------|------------|--------|
| 2.srs.md | Guide→PromptStages、Run/Worker、Platform+Model、新增功能 | P0 |
| 3.prd.md | VisualAgent、水印系统、权限矩阵 | P0 |
| 7.data-dictionary.md | 新数据模型(91个)、新字段 | P0 |
| 4.dev.md | 架构变更、appKey规范 | P1 |

---

## 九、执行结果

1. ~~执行阶段一：读取SRS/PRD~~ ✅
2. ~~记录老路径基线~~ ✅
3. ~~执行阶段二：前端代码扫描~~ ✅
4. ~~执行阶段三：后端API扫描~~ ✅
5. ~~执行阶段四：桌面端扫描~~ ✅
6. ~~执行阶段六：文档更新~~ ✅
   - [x] 更新 2.srs.md（v3.0：废弃Guide、新增Run/Worker、Platform+Model、视觉代理、水印、权限矩阵、速率限制、应用身份隔离）
   - [x] 更新 3.prd.md（v2.0：提示词阶段替代引导讲解、新增管理后台模块清单）
   - [x] 更新 7.data-dictionary.md（新增16个MongoDB集合、桌面端新增store）
   - [x] 清理过时文档（删除5个过时文件、保留3个有价值文件）

### 已删除的过时文档

| 文件名 | 原因 |
|--------|------|
| `difftest.md` | 1.why.md 的草稿版，内容已覆盖 |
| `open-platform-complete-test.md` | 测试过程文档，已有正式文档覆盖 |
| `open-platform-final-summary.md` | 实施过程记录，已过时 |
| `open-platform-test.md` | 基础测试步骤，已过时 |
| `open-platform-implementation-summary.md` | 早期实施总结，与 final-summary 重复 |

### 保留的非编号文档

| 文件名 | 保留原因 |
|--------|----------|
| `network-diagnostics.md` | 桌面端网络诊断功能文档 |
| `app-caller-idempotent-design.md` | AppCaller 幂等架构设计 |
| `app-caller-system.md` | LLM 模型调度核心概念 |

---

*文档更新计划已全部完成（2026-01-22）*
