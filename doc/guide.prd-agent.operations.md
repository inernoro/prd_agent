---
type: guide
title: PRD Agent 全平台操作手册
created: 2026-03-20
updated: 2026-03-20
---

# PRD Agent 全平台 · 指南

> 本文档完整描述 PRD Agent 在桌面端（Tauri）和 Web 管理后台（prd-admin）上的所有用户可见功能、操作流程、UI 布局及 API 端点，供产品验收、QA 测试和开发对齐使用。

---

## 目录

- [一、桌面端全局框架](#一桌面端全局框架)
- [二、对话系统](#二对话系统)
- [三、PRD 预览系统](#三prd-预览系统)
- [四、会话管理](#四会话管理)
- [五、文档管理](#五文档管理)
- [六、缺陷管理](#六缺陷管理)
- [七、内容缺失检测](#七内容缺失检测-content-gaps)
- [八、完整 API 端点清单](#八完整-api-端点清单)
- [九、Web 端专属架构](#九web端专属架构)

---

## 一、桌面端全局框架

### 1.1 窗口布局

桌面端采用经典三区布局：顶部 Header、左侧 Sidebar、右侧 Main Area。

#### 1.1.1 Header 区域

- **高度**：`h-14`（56px）
- **macOS 特殊处理**：Header 总高度为 `h-14 + 28px`，其中顶部 28px 为系统交通灯（红绿灯按钮）拖拽区域（`data-tauri-drag-region`），该区域不可放置可交互元素
- **布局**：水平排列，左侧 Logo 与应用名，右侧功能按钮组
- **背景**：跟随当前主题（亮色/暗色/液态玻璃）
- **层级**：固定于窗口顶部，`z-index` 高于 Sidebar 和 Main Area

#### 1.1.2 Sidebar 区域

- **位置**：窗口左侧，Header 下方
- **默认宽度**：224px
- **可拖拽范围**：180px — 420px，通过 Sidebar 右边缘拖拽手柄调整
- **折叠状态宽度**：56px，仅显示图标
- **折叠/展开**：点击 Sidebar 内折叠按钮切换
- **内容结构**：自上而下分为三段——群组区、知识库区、缺陷管理区
- **滚动**：内容超出时各区域独立纵向滚动

#### 1.1.3 Main Area 区域

- **位置**：Sidebar 右侧，Header 下方，占据剩余全部空间
- **模式切换**：根据用户当前操作，Main Area 在以下五种模式间切换：
  1. **Chat 模式**：群组对话主界面，包含消息列表与输入框
  2. **PrdPreview 模式**：PRD 文档预览与批注
  3. **Knowledge 模式**：知识库文档管理
  4. **Defect 模式**：缺陷管理界面
  5. **AssetsDiag 模式**：资源诊断界面（仅管理员可见）
- **切换方式**：通过 Sidebar 中的对应入口点击进入，或通过 Header 下拉菜单进入特定模式

---

### 1.2 Header 操作

Header 从左到右依次排列以下元素：

#### 1.2.1 Logo 与应用名

- **位置**：Header 最左侧
- **Logo**：应用图标，固定尺寸
- **应用名**：紧跟 Logo 右侧，显示"PRD Agent"
- **操作**：点击 Logo 或应用名无特殊导航行为

#### 1.2.2 角色切换器

- **显示条件**：同时满足以下两个条件时才显示：
  1. 当前用户为管理员（`SystemRole` 含管理员权限）
  2. 当前已选中至少一个群组会话
- **外观**：下拉选择器样式，显示当前角色名称
- **可选角色**：
  - **PM 产品经理**：以产品视角参与对话，AI 回复侧重需求分析、功能规划
  - **DEV 开发**：以开发视角参与对话，AI 回复侧重技术实现、接口设计
  - **QA 测试**：以测试视角参与对话，AI 回复侧重测试用例、边界条件
- **操作流程**：
  1. 点击角色切换器，展开下拉菜单
  2. 菜单中列出三个角色选项，当前角色带选中标记（✓）
  3. 点击目标角色，立即切换
  4. 切换后，后续对话中 AI 将以新角色视角回复
  5. 角色信息随消息发送到后端，影响系统提示词

#### 1.2.3 连接状态指示

- **位置**：Header 中部偏右
- **正常状态**：不显示任何标记（连接正常时无视觉干扰）
- **断线状态**：
  - 显示红色圆点（直径约 8px）
  - 红点右侧显示文字提示（如"连接已断开"）
  - 该状态在 SSE 连接中断、WebSocket 断开或网络不可达时触发
- **重连机制**：断线后客户端自动重连，重连期间状态切换为 Chat 标题栏中的对应指示（见 1.4 节）

#### 1.2.4 主题切换按钮

- **位置**：Header 右侧功能按钮组内
- **图标**：
  - 亮色主题时显示**太阳图标**（☀️ 样式）
  - 暗色主题时显示**月亮图标**（🌙 样式）
- **切换动效**：采用 **View Transition API** 实现圆形水波纹扩散效果
  - 以点击位置为圆心
  - 新主题从圆心向四周扩散，覆盖旧主题
  - 动画时长约 300-500ms
  - 不支持 View Transition API 的环境下直接切换，无动画
- **操作流程**：
  1. 点击主题切换按钮
  2. 获取点击坐标作为动画圆心
  3. 启动 `document.startViewTransition()`
  4. 圆形裁剪区域从 0 扩展到覆盖全屏
  5. 主题 CSS 变量切换完成
  6. 动画结束，新主题完全生效
- **持久化**：主题偏好保存到本地存储，下次启动时自动应用

#### 1.2.5 用户名显示

- **位置**：Header 最右侧（主题切换按钮之右）
- **内容**：显示当前登录用户的用户名文本
- **样式**：普通文本显示，不可编辑

#### 1.2.6 用户下拉菜单

- **触发方式**：点击用户名区域或其右侧的下拉箭头
- **菜单项**（从上到下）：

##### 1.2.6.1 资源诊断

- **显示条件**：仅管理员可见
- **操作**：点击后 Main Area 切换到 AssetsDiag 模式，展示系统资源使用状况诊断信息
- **图标**：工具/诊断类图标

##### 1.2.6.2 清理上下文

- **用途**：清除当前会话的 AI 对话上下文缓存，重新开始
- **操作流程**：
  1. 点击"清理上下文"菜单项
  2. 弹出第一次确认对话框："确定要清理当前会话的上下文吗？"
  3. 用户点击"确定"
  4. 弹出第二次确认对话框（双重确认）："清理后无法恢复，是否继续？"
  5. 用户点击"确定"
  6. 发送清理请求到后端
  7. 成功后显示 toast 提示"上下文已清理"
- **双重确认原因**：上下文清理不可逆，防止误操作

##### 1.2.6.3 AI Anyway 开关

- **类型**：Toggle 开关（非点击跳转）
- **功能**：开启后，即使 AI 判断无需回复的消息也强制触发 AI 回复
- **状态显示**：开关在菜单项右侧，显示当前开/关状态
- **操作**：直接点击开关切换，无需额外确认
- **持久化**：状态保存到用户偏好

##### 1.2.6.4 字体大小调节

- **布局**：菜单项内嵌水平控制条
- **组成元素**：
  - **减小按钮**（"-" 或 "A↓"）：每次点击减小一档字体
  - **当前百分比显示**：如 "100%"、"110%"、"90%"
  - **增大按钮**（"+" 或 "A↑"）：每次点击增大一档字体
  - **重置按钮**：点击恢复为 100% 默认大小
- **操作流程**：
  1. 点击减小按钮 → 字体缩小，百分比数字更新
  2. 点击增大按钮 → 字体增大，百分比数字更新
  3. 点击重置按钮 → 字体恢复 100%
- **生效范围**：整个应用窗口的字体大小同步变化
- **持久化**：字体大小偏好保存到本地存储

##### 1.2.6.5 设置

- **操作**：点击后打开设置页面或设置对话框
- **内容**：应用级配置（API 地址、通知偏好等）

##### 1.2.6.6 开发者工具

- **操作**：点击后打开 Tauri 内置的 WebView 开发者工具（DevTools）
- **用途**：调试前端界面、查看网络请求、检查控制台日志
- **实现**：调用 Tauri 的 `window.__TAURI__.invoke('open_devtools')` 或等效 API

##### 1.2.6.7 检查更新

- **操作流程**：
  1. 点击"检查更新"
  2. 立即向更新服务器发送版本检查请求
  3. 若有新版本：弹出更新通知弹窗（见 1.7.2 节）
  4. 若已是最新版：显示 toast 提示"当前已是最新版本"
  5. 若检查失败：显示 toast 错误提示"检查更新失败，请稍后重试"

##### 1.2.6.8 退出登录

- **操作流程**：
  1. 点击"退出登录"
  2. 清除本地存储的 Auth Token（包括 Rust 端持久化的 token）
  3. 清除本地用户会话数据
  4. 跳转到登录页面
  5. 断开所有 SSE/WebSocket 连接

---

### 1.3 Sidebar 三段结构

Sidebar 自上而下分为三个功能区，各区之间有视觉分隔线。

#### 1.3.1 群组区

##### 1.3.1.1 区域标题行

- **标题文本**："群组"
- **样式**：`text-sm font-medium`，左对齐
- **折叠按钮**：
  - 位于标题行右侧
  - 尺寸：`h-7 w-7`（28px × 28px）
  - 图标：折叠/展开箭头
  - 点击行为：折叠整个 Sidebar 到 56px 宽度（仅显示图标模式），再次点击展开回当前宽度
- **新建下拉菜单**：
  - 触发：点击标题行右侧的 "+" 按钮或新建按钮
  - 菜单项：
    1. **创建群组**：打开创建群组对话框（见 1.5.1 节）
    2. **加入群组**：打开加入群组对话框（见 1.5.2 节）
    3. **更换 PRD**：打开文件选择器更换当前群组的 PRD 文件（见 1.5.5 节）

##### 1.3.1.2 群组列表

- **列表排序**：按最近活跃时间降序排列
- **列表项结构**（每个群组一行）：
  - **头像**：渐变色方形图标，`8x8`（基于基础单位，约 32px），圆角 `rounded-lg`，渐变色由群组名称 hash 生成，每个群组颜色唯一
  - **群组名称**：头像右侧，单行文本，超长截断显示省略号
  - **激活指示条**：当前选中群组在列表项最左侧显示一条纵向指示条（约 3px 宽，主题色），作为视觉焦点标记
- **点击操作**：点击群组列表项 → Main Area 切换到 Chat 模式，加载该群组的对话历史
- **滚动**：群组数量超出可视区域时，群组列表区域内部纵向滚动

##### 1.3.1.3 群组右键菜单

- **触发方式**：在群组列表项上右键点击（或长按/触控设备上等效操作）
- **菜单项**：

| 菜单项 | 可见条件 | 操作说明 |
|--------|----------|----------|
| 查看群信息 | 所有成员 | 打开 GroupInfoDrawer 抽屉（见 1.6 节） |
| 生成邀请码 | 群主/管理员 | 生成新邀请码并复制到剪贴板，toast 提示"邀请码已复制" |
| 复制邀请链接 | 群主/管理员 | 将 `prdagent://join/INV-XXXX` 格式链接复制到剪贴板 |
| 更换 PRD | 群主/管理员 | 打开文件选择对话框（见 1.5.5 节） |
| 解散群组 | 仅群主 | 双重确认后解散（见 1.5.4 节） |
| 退出群组 | 非群主成员 | 单次确认后退出（见 1.5.5 节） |

#### 1.3.2 知识库区

##### 1.3.2.1 区域标题行

- **标题文本**："知识库"
- **样式**：`text-xs font-medium`，左对齐
- **齿轮设置按钮**：
  - 位于标题行右侧
  - 尺寸：`h-7 w-7`（28px × 28px）
  - 图标：齿轮 ⚙ 图标
  - 点击行为：打开知识库设置界面（Main Area 切换到 Knowledge 模式）

##### 1.3.2.2 主文档显示

- **显示条件**：当前群组已绑定 PRD 主文档时显示
- **结构**：
  - **文件图标**：`w-4 h-4`（16px × 16px），文档类型图标
  - **文档标题**：图标右侧，单行显示，超长截断
  - **预览按钮**：hover 时在标题行右侧出现，点击后 Main Area 切换到 PrdPreview 模式，加载该文档
  - **更换按钮**：hover 时在预览按钮右侧出现，点击后打开文件选择对话框，选择新 PRD 文件替换当前主文档
- **操作流程（预览）**：
  1. 鼠标悬停在主文档行上
  2. 预览按钮（眼睛图标）出现
  3. 点击预览按钮
  4. Main Area 切换到 PrdPreview 模式
  5. 加载并渲染文档内容
- **操作流程（更换）**：
  1. 鼠标悬停在主文档行上
  2. 更换按钮出现
  3. 点击更换按钮
  4. 弹出 Tauri 文件选择对话框（过滤文档格式：.pdf, .docx, .md 等）
  5. 选择新文件
  6. 上传文件到后端
  7. 后端重新绑定主文档
  8. Sidebar 刷新显示新文档标题

##### 1.3.2.3 补充文档列表

- **显示条件**：当前群组有补充文档时显示
- **列表项结构**：
  - **文件图标**：`w-3.5 h-3.5`（14px × 14px），略小于主文档图标
  - **文档标题**：图标右侧，单行显示
  - **类型标签**：标题右侧，小标签显示文档类型（如"需求"、"设计"、"参考"等）
  - **hover 预览按钮**：鼠标悬停时出现预览按钮，点击后在 PrdPreview 模式中查看该补充文档
- **操作**：点击预览按钮 → Main Area 切换到 PrdPreview 模式加载对应补充文档

##### 1.3.2.4 追加资料按钮

- **文本**："追加资料"
- **位置**：知识库区底部
- **样式**：带 "+" 图标的文本按钮
- **操作流程**：
  1. 点击"追加资料"按钮
  2. 弹出 Tauri 文件选择对话框（支持多选）
  3. 选择一个或多个文件
  4. 文件上传到后端，关联到当前群组作为补充文档
  5. 上传完成后 Sidebar 知识库区刷新，新文档出现在补充文档列表中
  6. 上传过程中显示进度指示

#### 1.3.3 缺陷管理区

##### 1.3.3.1 区域标题行

- **标题文本**："缺陷管理"
- **样式**：`text-xs font-medium`，左对齐
- **Bug 图标按钮**：
  - 位于标题行右侧
  - 尺寸：`h-7 w-7`（28px × 28px）
  - 图标：Bug/虫子图标 🐛 样式
  - 点击行为：Main Area 切换到 Defect 模式，展示缺陷管理主界面

---

### 1.4 Chat 标题栏

Chat 模式下，Main Area 顶部有一个标题栏，包含以下元素：

#### 1.4.1 群组名

- **位置**：标题栏左侧
- **内容**：当前选中群组的名称
- **点击操作**：点击群组名 → 消息列表自动滚动到最底部（回到最新消息）
- **适用场景**：用户在向上翻阅历史消息后，点击群组名快速回到最新位置

#### 1.4.2 连接状态指示

- **位置**：群组名右侧
- **四种状态**：

| 状态 | 视觉表现 | 含义 |
|------|----------|------|
| 已连接 | 绿色实心圆点（稳定） | SSE 连接正常，实时接收消息 |
| 连接中 | 蓝色圆点 + 脉冲动画（放大缩小） | 正在建立 SSE 连接 |
| 重连中 | 黄色圆点 + 旋转动画（loading spinner） | 连接断开，正在自动重连 |
| 未连接 | 红色实心圆点（稳定） | 连接失败，无法接收实时消息 |

- **状态转换**：
  - 页面加载 → **连接中**（蓝色脉冲）
  - 连接成功 → **已连接**（绿色稳定）
  - 连接中断 → **重连中**（黄色旋转）
  - 重连成功 → **已连接**（绿色稳定）
  - 重连多次失败 → **未连接**（红色稳定）

#### 1.4.3 错误信息显示

- **显示条件**：当出现需要用户知晓的错误时显示（如消息发送失败、服务器错误等）
- **位置**：标题栏中部或下方
- **结构**：错误文本 + 关闭按钮（×）
- **操作**：点击关闭按钮（×）→ 隐藏错误信息条
- **自动消失**：部分非严重错误可在 5-10 秒后自动消失

#### 1.4.4 群信息按钮

- **位置**：标题栏最右侧
- **外观**："..." 三点图标按钮
- **尺寸**：`h-9 w-9`（36px × 36px）
- **点击操作**：点击后从右侧滑出 GroupInfoDrawer 抽屉面板（见 1.6 节）

---

### 1.5 群组管理全流程

#### 1.5.1 创建群组

- **入口**：Sidebar 群组区新建下拉菜单 → "创建群组"
- **操作流程**：
  1. 点击"创建群组"，弹出创建对话框
  2. **群名输入**（可选）：文本输入框，placeholder 提示"输入群组名称（可选）"。若留空，系统将根据 PRD 内容自动命名
  3. **PRD 文件上传**（必选）：
     - 点击文件上传区域或拖拽文件到上传区
     - 弹出 Tauri 文件选择对话框
     - 选择 PRD 文件（支持 .pdf、.docx、.md 等格式）
     - 文件选择后显示文件名和大小
  4. 点击"创建"按钮
  5. 发送创建请求到后端 API
  6. 创建成功后：
     - 新群组出现在 Sidebar 群组列表顶部
     - 自动选中该群组，Main Area 进入 Chat 模式
     - **若群名留空**：客户端发起轮询（最多 3 次，间隔约 2-3 秒），等待后端基于 PRD 内容的 AI 自动命名完成。命名完成后 Sidebar 中群组名自动更新
  7. 创建失败：显示错误 toast（如文件格式不支持、上传失败等）

#### 1.5.2 加入群组

- **入口**：Sidebar 群组区新建下拉菜单 → "加入群组"
- **操作流程**：
  1. 点击"加入群组"，弹出加入对话框
  2. **输入邀请码或链接**：
     - 文本输入框，placeholder 提示"输入邀请码或邀请链接"
     - 支持两种格式：
       - 纯邀请码：`INV-XXXX`（如 `INV-A3K9`）
       - 完整链接：`prdagent://join/INV-XXXX`
     - 系统自动识别输入格式，提取邀请码
  3. 点击"加入"按钮
  4. 发送加入请求到后端
  5. 加入成功：
     - 新群组出现在 Sidebar 群组列表中
     - 自动选中该群组
     - 加载群组历史消息
     - toast 提示"已成功加入群组"
  6. 加入失败：显示具体错误（邀请码无效、已过期、群组已满等）

#### 1.5.3 深度链接加入

- **触发方式**：在操作系统中点击 `prdagent://join/{code}` 格式的链接（如浏览器中、聊天工具中、邮件中）
- **操作流程**：
  1. 操作系统识别 `prdagent://` 协议，唤起 PRD Agent 桌面客户端
  2. Tauri 捕获深度链接 URL，解析 `{code}` 部分
  3. **若用户已登录**：自动发送加入请求，流程同 1.5.2 步骤 4-6
  4. **若用户未登录**：先跳转登录页面，登录成功后自动执行加入流程
  5. **若已是群组成员**：toast 提示"你已在该群组中"，直接选中该群组

#### 1.5.4 解散群组

- **入口**：群组右键菜单 → "解散群组"
- **权限要求**：仅群主可执行
- **操作流程**：
  1. 点击"解散群组"
  2. 弹出第一次确认对话框："确定要解散群组 '{群组名}' 吗？所有成员将被移出，群组数据将被删除。"
  3. 用户点击"确定"
  4. 弹出第二次确认对话框（双重确认）："此操作不可撤销，是否继续解散？"
  5. 用户点击"确定"
  6. 发送解散请求到后端
  7. 解散成功：
     - 该群组从 Sidebar 列表中移除
     - 若当前选中的就是该群组，Main Area 显示空状态或切换到其他群组
     - toast 提示"群组已解散"
  8. 解散失败：显示错误 toast

#### 1.5.5 退出群组

- **入口**：群组右键菜单 → "退出群组"，或 GroupInfoDrawer 中的退出按钮
- **权限要求**：非群主成员可执行（群主只能解散，不能退出）
- **操作流程**：
  1. 点击"退出群组"
  2. 弹出确认对话框（单次确认）："确定要退出群组 '{群组名}' 吗？"
  3. 用户点击"确定"
  4. 发送退出请求到后端
  5. 退出成功：
     - 该群组从 Sidebar 列表中移除
     - Main Area 切换到其他群组或空状态
     - toast 提示"已退出群组"
  6. 退出失败：显示错误 toast

#### 1.5.6 更换 PRD

- **入口**：Sidebar 群组区新建下拉菜单 → "更换 PRD"，或群组右键菜单 → "更换 PRD"，或知识库区主文档更换按钮
- **权限要求**：仅群主或管理员可执行
- **操作流程**：
  1. 点击"更换 PRD"
  2. 弹出 Tauri 文件选择对话框（过滤文档格式）
  3. 选择新的 PRD 文件
  4. 上传文件到后端
  5. 后端处理：
     - 替换群组绑定的主文档
     - 重新解析文档内容
     - 更新知识库索引
  6. 更换成功：
     - Sidebar 知识库区主文档标题更新为新文件名
     - toast 提示"PRD 已更换"
     - 后续 AI 对话基于新 PRD 内容
  7. 更换失败：显示错误 toast，原 PRD 保持不变

---

### 1.6 群信息抽屉（GroupInfoDrawer）

#### 1.6.1 打开方式

- 点击 Chat 标题栏右侧 "..." 按钮（`h-9 w-9`）
- 或群组右键菜单 → "查看群信息"

#### 1.6.2 抽屉外观

- **滑出方向**：从右侧滑入
- **宽度**：约 320-360px
- **遮罩层**：打开时 Main Area 左侧显示半透明遮罩，点击遮罩关闭抽屉
- **关闭按钮**：抽屉左上角或右上角 "×" 按钮

#### 1.6.3 抽屉内容

##### 1.6.3.1 群组基本信息

- **群名**：大字显示群组名称
- **邀请码**：显示当前有效邀请码（如 `INV-A3K9`）

##### 1.6.3.2 邀请码操作

- **复制邀请码按钮**：点击后将邀请码复制到剪贴板，toast 提示"已复制"
- **重新生成邀请码按钮**：
  - 权限：群主/管理员
  - 操作：点击后请求后端生成新邀请码
  - 旧邀请码立即失效
  - 新邀请码显示在界面上
  - toast 提示"邀请码已重新生成"

##### 1.6.3.3 成员列表

- **排序规则**：
  1. 群主始终排在第一位
  2. 其余成员按入群时间升序排列（先加入的在上）
- **每个成员的显示信息**：
  - **头像**：用户头像（圆形）
  - **名称**：用户名
  - **角色标签**：显示该成员在群组中的角色（PM/DEV/QA），以小标签形式
  - **群主徽章**：若为群主，名称旁显示"群主"徽章或皇冠图标

##### 1.6.3.4 添加成员

- **显示条件**：仅群主或管理员可见此操作区域
- **操作流程**：
  1. 在添加成员区域输入用户名（文本输入框）
  2. 选择角色（下拉选择：PM 产品经理 / DEV 开发 / QA 测试）
  3. 点击"添加"按钮
  4. 发送请求到后端
  5. 添加成功：成员列表刷新，新成员出现在列表中，toast 提示"已添加成员"
  6. 添加失败：显示错误信息（如用户不存在、已在群组中等）

##### 1.6.3.5 退出群组按钮

- **位置**：抽屉底部
- **样式**：红色或警告色文字按钮，如"退出群组"
- **显示条件**：非群主成员可见
- **操作**：点击后执行退出群组流程（见 1.5.5 节）

---

### 1.7 Desktop 专属功能

#### 1.7.1 自动更新机制

- **首次检查**：应用启动后等待 30 秒，执行第一次更新检查
  - 延迟 30 秒的原因：避免启动阶段网络请求拥堵，确保应用核心功能先完成初始化
- **定期检查**：首次检查后，每隔 2 小时自动检查一次更新
- **检查过程**：
  1. 向更新服务器请求最新版本信息
  2. 比较当前版本号与服务器最新版本号
  3. 若有新版本可用 → 触发更新通知
  4. 若已是最新 → 静默，不打扰用户

#### 1.7.2 更新通知弹窗

- **位置**：窗口右下角浮动弹窗
- **弹窗内容**：
  - 新版本号（如 "v2.1.0 可用"）
  - 更新说明摘要（来自更新服务器的 release notes）
  - **"下载安装"按钮**：点击后开始下载更新包，下载完成后提示重启安装
  - **"忽略"按钮**：关闭弹窗，本次不更新。下一个检查周期（2小时后）会再次提醒
- **下载安装流程**：
  1. 点击"下载安装"
  2. 弹窗切换为下载进度条显示
  3. 下载完成后提示"更新已就绪，是否立即重启安装？"
  4. 点击"立即重启"→ 应用退出并执行更新安装，安装完成后自动启动新版本
  5. 点击"稍后"→ 下次启动应用时自动安装

#### 1.7.3 Tauri 深度链接

- **协议注册**：应用安装时在操作系统中注册 `prdagent://` URL scheme
- **支持的深度链接格式**：
  - `prdagent://join/{invite-code}`：加入群组（见 1.5.3 节）
- **处理流程**：
  1. 用户点击外部链接（浏览器、邮件、聊天工具中）
  2. 操作系统将 `prdagent://` 链接路由到 PRD Agent 应用
  3. **应用已运行**：Tauri 接收到深度链接事件，解析并执行对应操作
  4. **应用未运行**：操作系统启动应用，启动参数中包含深度链接 URL，应用初始化完成后解析执行

#### 1.7.4 系统菜单集成

- **macOS**：应用注册到系统菜单栏，包含标准菜单项（关于、退出、编辑菜单的复制/粘贴/撤销等）
- **Windows**：标准窗口标题栏菜单
- **快捷键映射**：系统级快捷键（如 Cmd+Q/Alt+F4 退出、Cmd+C/Ctrl+C 复制等）通过 Tauri 菜单配置注册

#### 1.7.5 Auth Token 持久化到 Rust 端

- **存储位置**：Auth Token 不仅存储在前端（WebView 的 localStorage），还通过 Tauri Command 传递到 Rust 端进行安全持久化
- **目的**：
  - Rust 端可在无 WebView 参与时发起认证请求（如后台更新检查）
  - 比纯 WebView localStorage 更安全，避免 XSS 攻击窃取 token
- **生命周期**：
  - 登录成功 → 前端获取 token → 调用 Tauri Command 将 token 传递到 Rust 端存储
  - 退出登录 → 前端清除 localStorage → 调用 Tauri Command 清除 Rust 端 token
  - 应用启动 → Rust 端检查已持久化的 token → 若有效则自动登录状态

#### 1.7.6 文件对话框（Tauri Dialog）

- **调用方式**：所有文件选择操作（上传 PRD、追加资料等）均通过 Tauri 的原生文件对话框 API（`@tauri-apps/plugin-dialog`）实现
- **优势**：
  - 原生系统文件选择器界面，用户体验一致
  - 支持文件类型过滤（如仅显示 .pdf、.docx、.md）
  - 支持多文件选择（追加资料场景）
  - 返回文件系统绝对路径，Rust 端可直接读取文件内容
- **与 Web 版区别**：Web 版使用 `<input type="file">`，桌面端使用 Tauri 原生对话框

#### 1.7.7 macOS 交通灯区域

- **高度**：28px，位于窗口最顶部
- **区域属性**：设置 `data-tauri-drag-region`，用户可在此区域拖拽移动窗口
- **交通灯按钮**：macOS 标准红黄绿三个按钮，分别对应关闭/最小化/全屏
- **注意事项**：
  - 该 28px 区域内不可放置任何可交互的 UI 元素（按钮、链接等），否则会被交通灯按钮遮挡
  - Header 的实际可用内容区域从 28px 下方开始
  - Windows/Linux 平台不存在此区域，Header 从窗口顶部 0px 开始

---

## 二、对话系统

### 2.1 消息输入区

**输入区结构（从左到右）：**

- **附件按钮**：打开文件选择器（支持多选图片：PNG/JPG/JPEG/GIF/WEBP/SVG），上传中显示旋转图标 + "上传中..."
- **文本输入框**：
  - 自动调整高度（min 36px，max 200px）
  - 占位文本根据状态动态切换：
    - 正常：`"输入您的问题... (Enter 发送, Shift+Enter 换行)"`
    - 无 PRD：`"该群组未绑定 PRD，无法提问"`
    - 断线：`"服务器已断开连接，正在重连..."`
  - Enter 发送消息，Shift+Enter 换行
  - 流式输出期间或断线时禁用
- **发送/取消按钮**：
  - 发送图标（纸飞机）：有内容时可用
  - 取消图标（方形）：AI 流式输出期间显示，点击取消当前生成

**附件预览栏：**

- 上传附件后显示在输入框上方
- 每个附件显示缩略图 + 删除（×）按钮
- 消息发送后自动清除

---

### 2.2 技能工具栏

**布局**：位于输入框上方，单行水平排列的 chip 按钮。

**溢出处理：**

1. 可见区域展示部分技能按钮
2. 溢出时显示"更多"按钮，点击展开完整列表
3. 展开后显示"收起"按钮
4. 最右侧"+"按钮打开技能管理器

**AI Anyway 开关（右侧）：**

- 标签："AI"
- 蓝色 Toggle 开关
- 开启：发消息时 AI 会回复
- 关闭：发消息时 AI 不回复（仅发送）

**技能执行流程：**

1. 点击技能按钮
2. 若技能需要用户输入，弹出输入对话框
3. 消息格式：`"【技能名称】用户输入内容"`
4. 发送到后端执行，返回 `runId`
5. 前端订阅 Run SSE 获取执行结果

---

### 2.3 消息气泡

#### 2.3.1 用户消息

- **对齐方式**：右对齐
- **发送者信息**：名称 + 角色标签
- **内容**：等宽字体渲染（适配 ASCII 表格）
- **时间戳**：消息发送时间
- **hover 工具栏**：
  - **重发**：软删旧轮次消息，以相同内容重新发起对话
  - **复制**：复制消息内容到剪贴板

#### 2.3.2 助手消息

- **对齐方式**：左对齐
- **发送者名称**：来自消息数据或应用名
- **角色标签**：PM/DEV/QA/Admin（不同颜色主题）
- **机器人标识**：绿色实心标签

**思考过程（Thinking）：**

- 可折叠/展开的独立区域
- 琥珀色 + 左边框样式
- 显示思考耗时（秒数计时器）
- 内容随流式推送实时更新

**内容渲染（Block Rendering）：**

1. 流式阶段：纯文本逐字追加显示
2. 块结束（blockEnd）事件后：使用 ReactMarkdown 渲染完成的内容块
3. 支持代码块语法高亮、表格、列表等 GFM 扩展

**元数据显示（右下角）：**

- 消息序列号（groupSeq）
- 时间戳 + 响应耗时（TTFT 毫秒数）

**引用来源（Citations）：**

- "来源（N）"按钮，N 为引用数量
- 点击展开引用抽屉，显示引用列表
- 每条引用含：标题、摘录、相关度分数
- 点击引用项可跳转到 PRD 预览对应章节

**hover 工具栏（右侧）：**

- **复制回复**：复制 Markdown 格式内容
- **保存为技能**：从当前消息提炼为可复用技能模板

---

### 2.4 消息列表

**虚拟滚动：**

- 仅渲染可视区域内的消息（窗口大小约 50-180 条）
- 减少大量消息场景下的 DOM 开销

**历史加载：**

- 向上滚动到顶部时显示"加载更早"按钮
- 已折叠消息数量指示（"已折叠 N 条"）

**滚动到底部按钮：**

- 用户向上滚动超过 220px 时显示
- 显示未读消息数量徽章
- 点击后平滑滚动至最新消息
- 流式输出期间自动跟随滚动

**空状态：**

- 有会话无消息：显示 "你好！有什么关于这份PRD的问题，尽管问我"
- 无 PRD 绑定：显示 "待上传" + 提示绑定 PRD

---

### 2.5 消息发送流程

**个人会话模式（Web）：**

1. 用户在输入框输入内容，点击发送或按 Enter
2. 发起请求：`POST /api/v1/sessions/{sessionId}/messages`
3. 响应为 SSE 流（`text/event-stream`）
4. 前端创建空的助手消息占位
5. 接收 `delta` 事件，逐字追加到助手消息内容
6. 接收 `done` 事件，标记消息完成

**群组会话模式（Desktop）—— Run/Worker：**

1. 用户发送消息
2. 发起请求：`POST /api/v1/sessions/{sessionId}/messages/run`
3. 返回 `{ runId, userMessageId, assistantMessageId }`
4. 前端订阅 SSE：`GET /api/v1/chat-runs/{runId}/stream?afterSeq=0`
5. 服务端 Worker 后台执行 LLM 调用
6. 通过 SSE 推送事件：`start` → `delta`（多个）→ `citations`（可选）→ `done`
7. 客户端被动断开不中断服务端任务
8. 断线重连时携带 `afterSeq` 从断点恢复

---

### 2.6 SSE 流式事件

| 事件类型 | 数据 | 说明 |
|----------|------|------|
| `start` | `messageId` | 流开始，创建空消息占位 |
| `delta` | `text` | 增量文本片段，追加到消息末尾 |
| `thinking` | `text` | 思考过程增量（Desktop） |
| `blockEnd` | `blockId` | 内容块结束，触发块级渲染 |
| `citations` | `DocCitation[]` | 引用列表更新（替换，非追加） |
| `done` | — | 流结束，启用交互按钮 |
| `error` | `errorCode, errorMessage` | 流异常，展示错误+重试入口 |
| `keepalive` | — | 每 10 秒心跳，维持连接 |
| `messageUpdated` | `message` | 消息更新通知（群组模式） |

---

### 2.7 重发消息

**操作流程：**

1. hover 用户消息气泡，出现"重发"按钮
2. 点击"重发"
3. 发起请求：`POST /api/v1/sessions/{sessionId}/messages/{messageId}/resend`
4. 后端软删旧轮次（用户消息 + 对应助手回复）
5. 以相同内容重新发起 AI 对话
6. 前端标记旧消息为已删除，新消息出现在列表末尾

**约束：**

- 仅允许重发自己的 User 消息
- 仅群会话支持重发

---

### 2.8 实时消息同步（群组模式）

**SSE 订阅：**

1. 进入群组会话后，订阅群消息 SSE：`GET /api/v1/groups/{groupId}/messages/stream?afterSeq=N`
2. 支持 `Last-Event-ID` header 断线续传
3. 每 10 秒 keepalive 心跳

**消息序列号（GroupSeq）：**

- 每条群组消息携带递增序列号
- 保证消息全局有序
- 支持增量同步：仅获取 `afterSeq` 之后的新消息

**消息类型：**

| SSE 事件 | 说明 |
|----------|------|
| `message` | 新消息到达 |
| `messageUpdated` | 消息更新（含软删除场景） |
| `delta` | AI 流式回复增量 |
| `thinking` | AI 思考过程 |
| `blockEnd` | 内容块结束 |
| `citations` | 引用数据 |
| `error` | 错误通知 |

---

### 2.9 清理上下文

**操作流程：**

1. 通过 Header 下拉菜单 → "清理上下文"
2. 弹出第一次确认对话框
3. 用户确认后弹出第二次确认（双重确认，不可逆操作）
4. 发起请求：`POST /api/v1/groups/{groupId}/context/clear`
5. 后端写入 reset marker，后续 AI 对话不再参考 marker 之前的消息
6. 历史消息保留在 MongoDB 中，用户仍可翻阅
7. toast 提示"上下文已清理"

---

## 三、PRD 预览系统

### 3.1 三栏布局

PRD 预览页采用三栏可调布局，由 `PrdPreviewPage` 组件实现。

**布局结构：**

| 栏位 | 位置 | 内容 | 默认宽度 |
|------|------|------|----------|
| 左栏 | 最左侧 | 目录导航（TOC） | 288px |
| 中栏 | 中间 | 文档正文内容（Markdown 渲染） | 自适应填满剩余空间 |
| 右栏 | 最右侧 | 评论面板 | 320px |

**拖拽调宽操作流程：**

1. 将鼠标移动到左栏与中栏之间的分隔拖拽条（4px 宽度），光标变为 `col-resize`
2. 按住鼠标左键（button === 0）开始拖拽
3. 系统通过 `setPointerCapture` 捕获指针事件，设置 `document.body.style.cursor = 'col-resize'` 和 `userSelect = 'none'`
4. 水平拖拽过程中，左栏宽度实时更新，范围限制为 **min 200px, max 520px**
5. 释放鼠标，拖拽结束，恢复光标和选区样式
6. 右栏评论面板同理，拖拽右侧分隔条调整，范围同为 **min 200px, max 520px**

**面板折叠/展开：**

1. 点击目录面板的折叠按钮 → `tocOpen` 状态切换为 `false` → 左栏隐藏，中栏自动扩展
2. 再次点击 → `tocOpen` 切换为 `true` → 左栏恢复显示
3. 评论面板同理，通过 `commentsOpen` 状态控制
4. 当存在 `groupId` 时，评论面板默认打开；无 `groupId` 时默认关闭

**前置条件判断：**

- 必须同时满足 `documentId` 和 (`groupId` 或 `sessionId`) 才能进入预览
- 判断表达式：`canPreview = Boolean(documentId && (groupId || sessionId))`

---

### 3.2 目录导航

**目录提取流程：**

1. 文档内容渲染完成后，在 `requestAnimationFrame` 回调中从 DOM 提取所有 `h1` ~ `h6` 标签
2. 遍历每个标题元素，读取 `tagName` 获取层级（h1=1, h2=2, ..., h6=6）、`id` 属性、`textContent` 文本
3. 过滤掉无 `id` 或无文本的标题
4. 生成 TOC 列表：`Array<{ id: string; text: string; level: number }>`
5. 存入 `tocItems` 状态

**缩进规则：**

| 标题层级 | CSS 类 | 缩进 |
|----------|--------|------|
| H1 (level 1) | `pl-2` | 0.5rem |
| H2 (level 2) | `pl-4` | 1rem |
| H3 (level 3) | `pl-6` | 1.5rem |
| H4 (level 4) | `pl-8` | 2rem |
| H5 (level 5) | `pl-10` | 2.5rem |
| H6+ (level 6) | `pl-12` | 3rem |

**点击导航操作：**

1. 点击目录中任一标题项
2. 调用 `scrollToHeading(id)` 函数
3. 函数通过 `CSS.escape` 转义 ID，在内容容器中查找对应 DOM 元素
4. 如首次查找失败，最多重试 2 次（通过 `requestAnimationFrame` 延迟重试）
5. 计算目标元素相对容器的偏移量，减去 12px 上边距
6. 调用 `container.scrollTo({ top, behavior: 'smooth' })` 执行平滑滚动

**活跃标题高亮（Scrollspy）：**

1. 监听内容容器的 `scroll` 事件
2. 使用 `requestAnimationFrame` 节流（通过 `scrollRafRef` 控制单帧只执行一次）
3. 读取当前 `scrollTop + 24px`（threshold）作为判定线
4. 遍历缓存的标题位置列表 `headingsRef.current`，找到最后一个 `top <= 判定线` 的标题
5. 更新 `activeHeadingId` 和 `activeHeadingTitle` 状态
6. TOC 列表中对应项添加高亮样式

**标题位置缓存重建：**

- 通过 `rebuildHeadingsCache()` 函数重新计算所有标题的绝对位置
- 遍历容器内所有 `h1`~`h6`，计算每个标题的 `scrollTop + (elementTop - containerTop)`
- 缓存为 `Array<{ id, el, title, top }>` 存入 `headingsRef`

---

### 3.3 文档内容渲染

**数据加载：**

1. 检查前置条件：`documentId` 存在且 `groupId` 或 `sessionId` 至少有一个
2. 如果已缓存当前 `documentId` 的内容，跳过请求
3. 构建查询参数：`groupId=xxx` 或 `sessionId=xxx`
4. 发起请求：`GET /api/v1/documents/{documentId}/content?groupId=xxx` 或 `?sessionId=xxx`
5. 返回数据：`{ id, title, content, mermaidRenderCacheVersion, mermaidRenders }`
6. 存入 `prdPreview` 状态

**鉴权路径（后端）：**

| 路径 | 条件 | 校验逻辑 |
|------|------|----------|
| groupId 鉴权 | 传入 `groupId` | 群组存在 → 用户是群成员 → 文档属于群主文档或会话文档 |
| sessionId 鉴权 | 传入 `sessionId` | 会话存在 → 用户是会话 owner → 文档属于该会话 |
| 均为空 | 两者都未传 | 返回 400：`groupId 或 sessionId 不能同时为空` |

**Markdown 渲染配置：**

- 使用 `ReactMarkdown` 组件
- 插件：`remarkGfm`（GFM 扩展：表格、任务列表、删除线等）+ `rehypeRaw`（允许内嵌 HTML）
- 自动解包 ` ```markdown ` 代码围栏：如果文档内容整体被 markdown 围栏包裹，解包后渲染内部内容

**内部链接处理：**

| 链接格式 | 行为 |
|----------|------|
| `prd-citation:0` | 打开引用抽屉，跳转到引用列表中 index=0 的引用项 |
| `prd-nav:4.2` | 在文档内滚动到标题编号以 "4.2" 开头的章节 |
| `prd-nav://4.2?title=...` | 滚动到章节 "4.2"，并使用 URL 参数中的 title 作为匹配覆盖 |

**来源注入规则：**

- 文本模式 `"来源: 4.2 XXX"` → 转换为 `[4.2](prd-nav:4.2) XXX`，使章节编号变为可点击链接
- 章节引用 `(4.2, 4.3)` → 每个编号转换为独立可点击链接

**标题 ID 解析算法（`resolveHeadingIdForNav`）：**

1. **精确 ID 匹配**：按 `headingId` 直接查找 DOM 元素，尝试多种变体（原始、normalize、decodeURIComponent、小写）
2. **标题文本匹配**：按 `headingTitle` 匹配
   - 标准化文本：去除 Markdown 语法（图片/链接/代码/加粗/斜体/HTML标签/转义字符）
   - 精确匹配：标准化后文本完全相等
   - 宽松匹配：去除所有空格和标点后比较
   - 包含匹配：一方包含另一方
3. 返回匹配到的标题 `id`，未匹配返回 `null`

---

### 3.4 引用高亮

**引用导航状态（`prdPreviewNavStore`）：**

```
targetHeadingId: string | null     // 目标标题 ID
targetHeadingTitle: string | null  // 目标标题文本
citations: DocCitation[]           // 引用列表
activeCitationIndex: number        // 当前活跃引用索引
```

**DocCitation 结构：**

| 字段 | 类型 | 说明 |
|------|------|------|
| headingTitle | string | 引用所在标题文本 |
| headingId | string | 引用所在标题 ID |
| excerpt | string | 引用摘录文本 |
| score | number \| null | 相关度分数 |
| rank | number \| null | 排名 |
| documentId | string \| null | 所属文档 ID |
| documentLabel | string \| null | 文档标签 |
| verified | boolean | 是否已验证 |

**从聊天引用进入预览的流程：**

1. 聊天消息中包含引用信息，用户点击引用链接
2. 调用 `openWithCitations({ targetHeadingId, targetHeadingTitle, citations, activeCitationIndex })`
3. 预览页检测到 `navTargetHeadingId` 变化
4. 调用 `resolveHeadingIdForNav` 解析实际 DOM 标题 ID
5. 调用 `applyHighlights(citations)` 在文档中标记所有引用章节
6. 滚动到对应标题位置
7. 高亮样式：被引用章节添加特殊边框和背景色

**引用导航按钮操作：**

1. 点击"上一个引用"按钮 → `setNavActiveIndex(activeCitationIndex - 1)` → 跳转到上一个引用章节
2. 点击"下一个引用"按钮 → `setNavActiveIndex(activeCitationIndex + 1)` → 跳转到下一个引用章节
3. 索引范围自动 clamp 到 `[0, citations.length - 1]`

**摘录视图：**

1. 引用面板显示当前活跃引用的完整摘录文本（`excerpt`）
2. 点击展开/折叠按钮切换 `isCitationExcerptExpanded` 状态
3. 展开时显示完整引用文本，折叠时截断显示

**清除引用：**

- 切换文档（`documentId` 或 `groupId` 变化）时自动调用 `clearNav()` 清空所有引用状态
- 调用 `clearHighlights()` 移除 DOM 中的高亮样式

---

### 3.5 划词提问 [Desktop]

**操作流程：**

1. 用户在文档正文中选中一段文本
2. 浮动工具栏出现在选区附近
3. 工具栏包含"Ask about this"按钮
4. 点击按钮后触发以下流程：
   - 获取选中文本内容
   - 构建提问请求（包含 `headingId`、`headingTitle`、`question`）
   - 发送至 `POST /api/v1/sessions/{sessionId}/preview-ask`（SSE 流式响应）
   - 侧面板打开，显示 AI 逐字流式回答

**Preview Ask API 详情：**

- 路由：`POST /api/v1/sessions/{sessionId}/preview-ask`
- 认证：需要 Bearer Token
- Content-Type 请求：`application/json`
- Content-Type 响应：`text/event-stream`
- 请求体：`{ headingId: string, headingTitle: string, question: string }`
- SSE 事件名：`previewAsk`
- 事件类型：`delta`（流式文本）、`done`（完成）、`error`（错误）
- 权限：群会话需为群成员，个人会话需为会话 owner

---

### 3.6 评论面板

**评论列表加载：**

1. 发起请求：`GET /api/v1/prd-comments?documentId={documentId}&groupId={groupId}&limit=200`
2. 可选参数：`headingId`（按标题筛选）
3. 返回评论列表，每条包含：
   - `id`：评论 ID
   - `documentId`：所属文档
   - `headingId`：关联标题 ID
   - `headingTitleSnapshot`：标题快照
   - `authorUserId`：作者 ID
   - `authorDisplayName`：作者显示名
   - `content`：评论内容
   - `createdAt`：创建时间

**评论分组显示：**

1. 按 `headingId` 对评论列表进行分组
2. 每组显示标题文本和该标题下的所有评论
3. 点击评论组标题 → 调用 `scrollToHeading(headingId)` 跳转到文档对应标题位置

**新建评论操作：**

1. 选择目标标题（从 TOC 下拉列表或当前活跃标题自动填入）
2. 在文本框中输入评论内容
3. 点击"发送"按钮
4. 发起请求：`POST /api/v1/prd-comments`
5. 请求体：
   ```json
   {
     "documentId": "文档ID",
     "groupId": "群组ID",
     "headingId": "标题ID",
     "headingTitleSnapshot": "标题文本快照",
     "content": "评论内容"
   }
   ```
6. 返回创建的评论对象
7. 评论列表实时更新

**删除评论操作：**

1. 仅评论作者本人或 ADMIN 可删除
2. 点击评论条目上的删除按钮
3. 弹出确认提示
4. 发起请求：`DELETE /api/v1/prd-comments/{commentId}?groupId={groupId}`
5. 后端校验：`comment.AuthorUserId == userId` 或 `user.Role == ADMIN`
6. 删除成功后从列表中移除

**评论权限校验（后端）：**

- 必须传入 `groupId`
- 用户必须是群组成员
- 文档必须属于群主文档或群会话关联文档

---

## 四、会话管理

### 4.1 会话创建

**文件上传方式：**

1. 支持文件格式：`.md`、`.mdc`、`.txt`
2. 拖拽上传区域：将文件拖入指定区域自动触发上传
3. 点击上传：点击上传区域打开文件选择器
4. 手动粘贴：直接在文本区域粘贴 PRD 内容

**创建流程：**

1. 读取文件/粘贴内容为纯文本字符串
2. （可选）前端预验证：`POST /api/v1/documents/validate`
   - 返回 `{ isValid, errorCode, errorMessage, estimatedTokens, maxTokens, charCount, maxSizeBytes }`
3. 正式上传：`POST /api/v1/documents`
   - 请求体：`{ content: string, title?: string }`
   - `content`：PRD 文档内容（Markdown 格式）
   - `title`：可选，用户自定义标题
4. 后端处理流程：
   - 验证请求参数（`request.Validate()`）
   - 内容综合验证（`DocumentValidator.Validate`）：格式、大小、Token 数
   - 内容大小限制：超过限制返回 413 `DOCUMENT_TOO_LARGE`
   - 解析文档（`ParseAsync`）：提取标题、章节结构、字符数、Token 估算
   - 保存文档到缓存
   - 创建会话（`CreateAsync`）
   - 绑定 `OwnerUserId` 为当前用户
5. 返回结果：
   ```json
   {
     "sessionId": "会话ID",
     "document": {
       "id": "文档ID",
       "title": "文档标题",
       "charCount": 12345,
       "tokenEstimate": 3000,
       "sections": [{ "title": "章节标题", "level": 1 }]
     }
   }
   ```

**标题解析优先级：**

1. 用户在请求中传入的 `title` 字段（最高优先级）
2. Markdown 内容中第一个 `#` 标题
3. 上传的文件名
4. 自动生成的默认标题

---

### 4.2 会话列表

**获取操作：**

1. 发起请求：`GET /api/v1/sessions?includeArchived=false`
   - `includeArchived`：是否包含已归档会话，默认 `false`
2. 后端过滤条件：
   - `OwnerUserId == 当前用户ID`
   - `DeletedAtUtc == null`（未删除）
   - 如 `includeArchived=false`，追加 `ArchivedAtUtc == null`
3. 排序：`LastActiveAt` 降序
4. 限制：最多返回 200 条
5. 返回列表项包含：`sessionId, groupId, ownerUserId, documentId, documentIds, documentMetas, title, currentRole, mode, createdAt, lastActiveAt, archivedAtUtc, deletedAtUtc`

**本地缓存机制：**

- 缓存 Key：`localStorage` 中 `prdAdmin.aiChat.sessions.{userId}`
- 首次加载：先从本地缓存读取并立即渲染（减少白屏时间）
- 后台同步：异步请求服务端最新列表，更新本地缓存和 UI
- 窗口 focus 时触发同步（`window.addEventListener('focus', ...)`）

---

### 4.3 会话切换

**操作方式：**

- **方式一**：点击侧边栏会话列表中的某一会话项
- **方式二**：通过 `CustomEvent` 触发：`dispatchEvent(new CustomEvent('prdAgent:switchSession', { detail: { sessionId } }))`

**加载流程：**

1. 切换时立即从本地缓存加载会话基本信息（即时响应，无延迟）
2. 后台异步请求服务端最新会话数据进行同步
3. 加载消息历史：`GET /api/v1/sessions/{sessionId}/messages?limit=50`
   - `limit`：最多返回 50 条（默认值）
   - `before`：可选，`DateTime` 类型，用于加载更早的消息
4. 消息列表从 MongoDB 分页查询（持久化），非缓存
5. 每条消息包含：`id, groupSeq, runId, senderId, senderName, senderRole, senderAvatarUrl, senderTags, role, content, thinkingContent, replyToMessageId, resendOfMessageId, viewRole, timestamp, tokenUsage`

---

### 4.4 会话归档/恢复

**归档操作：**

1. 在会话列表中找到目标会话
2. 点击会话操作菜单中的"归档"选项
3. 发起请求：`POST /api/v1/sessions/{sessionId}/archive`
4. 后端校验：
   - 用户有权访问该会话（owner 匹配）
   - 群会话不支持归档，返回 403：`群会话不支持归档`
5. 设置 `ArchivedAtUtc = DateTime.UtcNow` 和 `LastActiveAt = DateTime.UtcNow`
6. 会话从默认列表中消失，仅在 `includeArchived=true` 时可见
7. 会话项显示"已归档"标签

**恢复操作：**

1. 在会话列表中开启"显示已归档"筛选
2. 点击已归档会话的"取消归档"选项
3. 发起请求：`POST /api/v1/sessions/{sessionId}/unarchive`
4. 后端将 `ArchivedAtUtc` 设为 `null`，更新 `LastActiveAt`
5. 会话恢复到默认列表

---

### 4.5 会话删除

**操作流程：**

1. 在会话列表中找到目标会话
2. 点击操作菜单中的"删除"选项
3. 弹出确认对话框，要求用户确认删除
4. 用户点击"确认"
5. 发起请求：`DELETE /api/v1/sessions/{sessionId}`
6. 后端校验：
   - 会话存在（否则返回 404 `SESSION_NOT_FOUND`）
   - 用户有权访问（owner 匹配或群成员校验）
7. 执行软删除（`DeleteAsync`）
8. 返回 204 No Content
9. 前端从列表中移除该会话

---

### 4.6 会话保活

**保活机制：**

1. **定时轮询**：每 5 分钟发起 `GET /api/v1/sessions/{sessionId}`
2. **窗口聚焦触发**：监听 `window.focus` 事件，聚焦时立即发起请求
3. **可见性变化触发**：监听 `document.visibilitychange` 事件，页面变为可见时触发
4. **滑动窗口 TTL**：每次成功请求后，后端调用 `RefreshActivityAsync(sessionId)` 刷新会话活跃时间

**后端处理：**

- `GET /api/v1/sessions/{sessionId}` 读操作也视为"活跃"
- 自动调用 `RefreshActivityAsync` 延长 TTL
- 用于桌面端/管理端的轻量 keep-alive

---

### 4.7 会话过期处理

**检测机制：**

1. 任何会话相关 API 返回 `SESSION_NOT_FOUND` 或 `SESSION_EXPIRED` 错误码时触发
2. 后端返回 404 + `{ error: { code: "SESSION_NOT_FOUND", message: "会话不存在" } }`

**处理流程：**

1. 前端捕获到 `SESSION_NOT_FOUND` / `SESSION_EXPIRED` 错误
2. 显示 toast 提示："会话已过期"
3. **每个会话仅提示一次**（避免重复弹窗）
4. 禁用聊天输入框，用户无法继续发送消息
5. 提示用户创建新会话或上传新文档
6. 直到用户创建新会话后，输入框恢复可用

---

## 五、文档管理

### 5.1 多文档支持

**文档结构：**

- 每个会话包含 **1 个主文档** + **N 个补充文档**
- 主文档：创建会话时上传的 PRD 文档
- 补充文档类型：

| 类型值 | 说明 |
|--------|------|
| `product` | 产品文档 |
| `technical` | 技术文档 |
| `design` | 设计文档 |
| `reference` | 参考资料（默认类型） |

**文档元数据结构（`DocumentMetas`）：**

```json
[
  { "documentId": "doc1", "documentType": "product" },
  { "documentId": "doc2", "documentType": "technical" }
]
```

---

### 5.2 追加文档

**操作入口：**

- **入口一**：侧边栏"追加资料"按钮
- **入口二**：聊天区域"追加"按钮

**操作流程：**

1. 选择文件或粘贴内容
2. 选择文档类型（`product` / `technical` / `design` / `reference`，默认 `reference`）
3. 发起请求：`POST /api/v1/sessions/{sessionId}/documents`
4. 请求体：
   ```json
   {
     "content": "文档内容（Markdown格式）",
     "documentType": "reference"
   }
   ```
5. 后端处理：
   - 验证内容非空
   - 执行 `DocumentValidator.Validate` 验证
   - 解析文档并保存
   - 追加到会话文档列表（`AddDocumentAsync`）
   - 文档类型为空时默认为 `reference`
6. 返回更新后的会话信息（含完整文档列表）

---

### 5.3 移除文档

**操作流程：**

1. 在会话文档列表中找到要移除的补充文档
2. 点击文档条目的"删除"按钮（**仅多文档时显示**，不允许删除唯一文档）
3. 发起请求：`DELETE /api/v1/sessions/{sessionId}/documents/{documentId}`
4. 后端校验：
   - 会话存在
   - 用户有权限
   - 文档确实属于该会话
   - 不允许移除最后一个文档（抛出 `InvalidOperationException`）
5. 返回更新后的会话信息

---

### 5.4 更改文档类型

**操作流程：**

1. 在文档列表中找到目标文档
2. 点击文档类型下拉菜单
3. 选择新类型：`product` / `technical` / `design` / `reference`
4. 发起请求：`PATCH /api/v1/sessions/{sessionId}/documents/{documentId}/type`
5. 请求体：
   ```json
   { "documentType": "technical" }
   ```
6. 后端校验：
   - 类型值必须为 `product/technical/design/reference` 之一
   - 文档必须存在于当前会话中
7. 返回更新后的会话信息

---

### 5.5 文档预览

**操作流程：**

1. 在文档列表中点击某个文档的"预览"按钮
2. 发起请求：`GET /api/v1/documents/{documentId}/content?sessionId={sessionId}` 或 `?groupId={groupId}`
3. 返回数据：
   ```json
   {
     "id": "文档ID",
     "title": "文档标题",
     "content": "原始Markdown内容",
     "mermaidRenderCacheVersion": "缓存版本号",
     "mermaidRenders": { ... }
   }
   ```
4. 打开 PRD 预览页面渲染文档内容

---

### 5.6 文档验证

**操作流程：**

1. 在上传前进行预验证（可选步骤）
2. 发起请求：`POST /api/v1/documents/validate`
3. 请求体：`{ "content": "文档内容" }`
4. 返回结果：
   ```json
   {
     "isValid": true,
     "errorCode": null,
     "errorMessage": null,
     "estimatedTokens": 3000,
     "maxTokens": 16384,
     "charCount": 12345,
     "maxSizeBytes": 16384
   }
   ```
5. 如果 `isValid=false`，显示错误信息，阻止上传

---

## 六、缺陷管理

### 6.1 缺陷列表

**双视图模式：**

- **卡片网格视图**：缺陷以卡片形式网格排列，适合概览
- **列表视图**：缺陷以表格行形式展示，适合详细信息

**筛选条件：**

| 筛选维度 | 可选值 |
|----------|--------|
| 状态 | `open`（待处理）、`verifying`（验证中）、`closed`（已关闭）、`rejected`（已拒绝） |
| 严重度 | `critical`（致命）、`major`（严重）、`minor`（一般）、`trivial`（轻微） |
| 角色 | `reporter`（我报告的）、`assignee`（指派给我的）、`all`（全部） |
| 搜索 | 关键字模糊匹配标题/描述 |

**缺陷列表项显示内容：**

- 严重度徽章（颜色标记：critical=红色、major=橙色、minor=黄色、trivial=灰色）
- 状态徽章（open/verifying/closed/rejected）
- 报告者/负责人头像
- 缺陷标题
- 描述预览（截取前 80 字符）
- 创建/更新时间
- 未读脉冲（未读缺陷显示动画脉冲效果）

---

### 6.2 缺陷详情

**分屏布局：**

- 左侧：缺陷列表
- 右侧：选中缺陷的详情面板

**详情面板内容：**

- 状态和严重度标签
- 创建时间和更新时间
- 报告者和负责人信息（头像+名称）
- 缺陷描述（Markdown 渲染）
- 评论线程（按时间排序的讨论列表）

**可执行操作：**

| 操作 | 说明 |
|------|------|
| 改变状态 | 在 `open/verifying/closed/rejected` 之间切换 |
| 添加评论 | 在评论线程中追加新评论 |
| 指派负责人 | 更改缺陷的负责人 |
| 删除缺陷 | 需确认，不可恢复 |

---

### 6.3 提交缺陷

**表单字段：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| 标题 | 文本 | 是 | 缺陷标题 |
| 描述 | Markdown 文本 | 是 | 详细描述，支持 Markdown |
| 严重度 | 选择框 | 是 | `critical/major/minor/trivial` |
| 负责人 | 用户选择器 | 否 | 从团队成员中选择 |
| 附件 | 文件上传 | 否 | 支持图片和文档附件 |

---

## 七、内容缺失检测 (Content Gaps)

### 7.1 缺失列表

**获取操作：**

1. 发起请求：`GET /api/v1/groups/{groupId}/gaps?status=Pending&page=1&pageSize=20`
2. 参数：
   - `status`：可选，筛选状态 `Pending` / `Resolved` / `Ignored`
   - `page`：页码，默认 1
   - `pageSize`：每页条数，默认 20
3. 返回分页结果：
   ```json
   {
     "items": [
       {
         "gapId": "缺失ID",
         "question": "AI检测到的缺失问题",
         "gapType": "missing/ambiguous/incomplete",
         "askedBy": { "userId": "...", "displayName": "...", "role": "PM" },
         "askedAt": "2026-03-20T10:00:00Z",
         "status": "pending",
         "suggestion": "AI建议补充内容"
       }
     ],
     "total": 45,
     "page": 1,
     "pageSize": 20
   }
   ```

---

### 7.2 缺失统计

**统计总览：**

1. 发起请求：`GET /api/v1/groups/{groupId}/gaps/stats`
2. 返回：
   ```json
   {
     "totalGaps": 45,
     "pendingCount": 20,
     "resolvedCount": 18,
     "ignoredCount": 7,
     "byType": { "Missing": 15, "Ambiguous": 20, "Incomplete": 10 },
     "recentGaps": [
       { "gapId": "...", "question": "前100字...", "gapType": "Missing", "askedAt": "..." }
     ]
   }
   ```

**待处理数量：**

1. 发起请求：`GET /api/v1/groups/{groupId}/gaps/pending-count`
2. 返回：`{ "data": 20 }`

---

### 7.3 AI 摘要报告

**操作流程：**

1. 点击"生成摘要报告"按钮
2. 发起请求：`POST /api/v1/groups/{groupId}/gaps/summary-report`
3. 后端处理：
   - 获取群组关联的 PRD 文档原文
   - 获取所有缺口记录
   - 如无缺口，直接返回 `"暂无内容缺口记录"`
   - 调用 `AIGapDetector.GenerateSummaryReportAsync` 生成报告
4. 返回：
   ```json
   {
     "totalGaps": 45,
     "pendingCount": 20,
     "resolvedCount": 18,
     "ignoredCount": 7,
     "byType": { "Missing": 15, "Ambiguous": 20 },
     "report": "AI生成的完整报告内容（Markdown格式）",
     "generatedAt": "2026-03-20T12:00:00Z"
   }
   ```

---

### 7.4 更新状态

**操作流程：**

1. 在缺失列表中找到目标缺失项
2. 点击状态按钮切换状态
3. 发起请求：`PUT /api/v1/groups/{groupId}/gaps/{gapId}/status`
4. 请求体：`{ "status": "Resolved" }`（可选值：`Pending` / `Resolved` / `Ignored`）
5. 返回更新后的缺失项详情

---

## 八、完整 API 端点清单

### 8.1 会话端点 (Sessions)

| 序号 | 方法 | 路由 | 用途 | 关键参数 |
|------|------|------|------|----------|
| 1 | `GET` | `/api/v1/sessions` | 获取当前用户的会话列表 | `?includeArchived=false`（是否包含归档） |
| 2 | `GET` | `/api/v1/sessions/{sessionId}` | 获取单个会话详情 + 保活 | 自动刷新活跃时间 |
| 3 | `PUT` | `/api/v1/sessions/{sessionId}/role` | 切换回答机器人角色 | Body: `{ "role": "PM/DEV/QA" }`；仅 ADMIN |
| 4 | `DELETE` | `/api/v1/sessions/{sessionId}` | 删除会话（软删除） | 返回 204 |
| 5 | `POST` | `/api/v1/sessions/{sessionId}/archive` | 归档会话 | 群会话不支持归档 |
| 6 | `POST` | `/api/v1/sessions/{sessionId}/unarchive` | 取消归档 | 恢复到默认列表 |
| 7 | `POST` | `/api/v1/sessions/{sessionId}/documents` | 追加补充文档 | Body: `{ "content", "documentType" }` |
| 8 | `DELETE` | `/api/v1/sessions/{sessionId}/documents/{documentId}` | 移除补充文档 | 不允许移除最后一个文档 |
| 9 | `PATCH` | `/api/v1/sessions/{sessionId}/documents/{documentId}/type` | 更改文档类型 | Body: `{ "documentType": "product/technical/design/reference" }` |

---

### 8.2 文档端点 (Documents)

| 序号 | 方法 | 路由 | 用途 | 关键参数 |
|------|------|------|------|----------|
| 1 | `POST` | `/api/v1/documents` | 上传 PRD 文档并创建会话 | Body: `{ "content", "title?" }`；返回 sessionId + documentInfo |
| 2 | `POST` | `/api/v1/documents/validate` | 验证文档（不保存） | Body: `{ "content" }`；返回 isValid/errorCode/estimatedTokens/charCount |
| 3 | `GET` | `/api/v1/documents/{documentId}` | 获取文档元信息 | 返回 id/title/charCount/tokenEstimate/sections |
| 4 | `GET` | `/api/v1/documents/{documentId}/content` | 获取文档原始内容（预览用） | `?groupId=xxx` 或 `?sessionId=xxx`（必须传其一） |

---

### 8.3 消息端点 (Messages)

| 序号 | 方法 | 路由 | 用途 | 关键参数 |
|------|------|------|------|----------|
| 1 | `POST` | `/api/v1/sessions/{sessionId}/messages` | 发送消息（SSE 流式响应） | Body: `{ "content", "promptKey?", "role?", "skipAiReply?", "attachmentIds?[]" }`；响应 `text/event-stream` |
| 2 | `POST` | `/api/v1/sessions/{sessionId}/messages/{messageId}/resend` | 重发消息（软删旧轮次+重新对话） | Body: 同 SendMessage；仅允许重发自己的 User 消息；仅群会话 |
| 3 | `GET` | `/api/v1/sessions/{sessionId}/messages` | 获取消息历史 | `?limit=50&before=DateTime`；从 MongoDB 分页 |

---

### 8.4 群组端点 (Groups)

| 序号 | 方法 | 路由 | 用途 | 关键参数 |
|------|------|------|------|----------|
| 1 | `POST` | `/api/v1/groups` | 创建群组 | Body: `{ "prdDocumentId?", "groupName?" }`；自动初始化 PM/DEV/QA 机器人 |
| 2 | `POST` | `/api/v1/groups/join` | 加入群组 | Body: `{ "inviteCode", "userRole" }` |
| 3 | `POST` | `/api/v1/groups/{groupId}/session` | 打开群组会话 | Body: `{ ... }`；返回 sessionId + currentRole |
| 4 | `GET` | `/api/v1/groups/{groupId}` | 获取群组信息 | 返回 groupId/groupName/prdDocumentId/inviteCode/memberCount |
| 5 | `GET` | `/api/v1/groups` | 获取用户的群组列表 | 返回当前用户所属的所有群组 |
| 6 | `GET` | `/api/v1/groups/{groupId}/members` | 获取群组成员列表 | 含机器人成员，返回 tags/avatarUrl/isBot |
| 7 | `POST` | `/api/v1/groups/{groupId}/members` | 添加群成员 | Body: `{ "username", "memberRole" }`；仅群主/ADMIN |
| 8 | `POST` | `/api/v1/groups/{groupId}/bots/bootstrap` | 初始化群默认机器人 | 幂等操作；仅群主/ADMIN |
| 9 | `PUT` | `/api/v1/groups/{groupId}/prd` | 绑定 PRD 到群组 | Body: `{ "prdDocumentId" }`；仅群主/ADMIN；清除缓存 |
| 10 | `DELETE` | `/api/v1/groups/{groupId}/prd` | 解绑 PRD | 仅群主/ADMIN |
| 11 | `PATCH` | `/api/v1/groups/{groupId}/name` | 更新群组名称 | Body: `{ "groupName" }`；仅群主 |
| 12 | `DELETE` | `/api/v1/groups/{groupId}` | 解散群组 | 仅群主/ADMIN；广播系统消息后删除 |
| 13 | `DELETE` | `/api/v1/groups/{groupId}/leave` | 退出群组 | 群主不允许退出 |
| 14 | `GET` | `/api/v1/groups/{groupId}/messages` | 获取群组消息历史 | `?limit=50&afterSeq=0&beforeSeq=0&before=DateTime`；支持增量同步 |
| 15 | `POST` | `/api/v1/groups/{groupId}/context/clear` | 清理群组 LLM 上下文 | 写入 reset marker；不删除消息历史 |
| 16 | `GET` | `/api/v1/groups/{groupId}/messages/stream` | 订阅群消息 SSE | `?afterSeq=0`；支持 `Last-Event-ID` 断线续传；10 秒 keepalive 心跳 |

---

### 8.5 Run/Worker 端点 (ChatRuns)

| 序号 | 方法 | 路由 | 用途 | 关键参数 |
|------|------|------|------|----------|
| 1 | `POST` | `/api/v1/sessions/{sessionId}/messages/run` | 创建对话 Run | Body: `{ "content", "promptKey?", "role?", "skipAiReply?", "attachmentIds?[]" }`；返回 runId + userMessageId + assistantMessageId |
| 2 | `GET` | `/api/v1/chat-runs/{runId}` | 获取 Run 状态 | 返回 RunMeta（status/groupId/sessionId/createdAt 等） |
| 3 | `POST` | `/api/v1/chat-runs/{runId}/cancel` | 取消 Run | 标记 `cancelRequested=true`；返回确认 |
| 4 | `GET` | `/api/v1/chat-runs/{runId}/stream` | 订阅 Run 事件 SSE | `?afterSeq=0`；支持 `Last-Event-ID`；先发 snapshot 再增量推送；10 秒 keepalive |

---

### 8.6 内容缺失端点 (Content Gaps)

| 序号 | 方法 | 路由 | 用途 | 关键参数 |
|------|------|------|------|----------|
| 1 | `GET` | `/api/v1/groups/{groupId}/gaps` | 获取缺失列表 | `?status=Pending&page=1&pageSize=20` |
| 2 | `GET` | `/api/v1/groups/{groupId}/gaps/stats` | 获取缺口统计 | 返回 total/pending/resolved/ignored/byType/recentGaps |
| 3 | `GET` | `/api/v1/groups/{groupId}/gaps/pending-count` | 获取待处理数量 | 返回整数 |
| 4 | `POST` | `/api/v1/groups/{groupId}/gaps/summary-report` | AI 生成摘要报告 | 调用 LLM 分析所有缺口 |
| 5 | `PUT` | `/api/v1/groups/{groupId}/gaps/{gapId}/status` | 更新缺失状态 | Body: `{ "status": "Pending/Resolved/Ignored" }` |

---

### 8.7 PRD 评论端点 (PrdComments)

| 序号 | 方法 | 路由 | 用途 | 关键参数 |
|------|------|------|------|----------|
| 1 | `GET` | `/api/v1/prd-comments` | 获取评论列表 | `?documentId=xxx&groupId=xxx&headingId?=xxx&limit=50`；需群成员权限 |
| 2 | `POST` | `/api/v1/prd-comments` | 创建评论 | Body: `{ "documentId", "groupId", "headingId", "headingTitleSnapshot?", "content" }` |
| 3 | `DELETE` | `/api/v1/prd-comments/{commentId}` | 删除评论 | `?groupId=xxx`；仅作者或 ADMIN 可删 |

---

### 8.8 附件端点 (Attachments)

| 序号 | 方法 | 路由 | 用途 | 关键参数 |
|------|------|------|------|----------|
| 1 | `POST` | `/api/v1/attachments` | 上传附件 | `multipart/form-data`；单文件最大 20MB；支持图片/文档/Office 格式 |
| 2 | `GET` | `/api/v1/attachments/{attachmentId}` | 获取附件信息 | 返回 url/fileName/mimeType/size/uploadedAt |

**支持的文件类型：**

| 类别 | MIME 类型 |
|------|-----------|
| 图片 | `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/svg+xml` |
| 文本 | `text/plain`, `text/markdown`, `text/csv`, `text/html` |
| 文档 | `application/pdf`, `application/json`, `application/xml`, `text/xml` |
| Word | `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/msword` |
| Excel | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/vnd.ms-excel` |
| PPT | `application/vnd.openxmlformats-officedocument.presentationml.presentation`, `application/vnd.ms-powerpoint` |

---

### 8.9 预览提问端点 (Preview Ask)

| 序号 | 方法 | 路由 | 用途 | 关键参数 |
|------|------|------|------|----------|
| 1 | `POST` | `/api/v1/sessions/{sessionId}/preview-ask` | 预览页划词提问 | Body: `{ "headingId", "headingTitle", "question" }`；SSE 响应，事件名 `previewAsk` |

---

### 8.10 PRD Agent 系统端点

| 序号 | 方法 | 路由 | 用途 | 关键参数 |
|------|------|------|------|----------|
| 1 | `GET` | `/api/prd-agent/health` | 健康检查 | 返回 `{ "status": "ok" }` |
| 2 | `GET` | `/api/prd-agent/prompts/system` | 获取系统提示词 | 返回 isOverridden + settings（含 PM/DEV/QA 三种角色提示词） |

---

### 8.11 PRD Agent 技能端点

| 序号 | 方法 | 路由 | 用途 | 关键参数 |
|------|------|------|------|----------|
| 1 | `GET` | `/api/prd-agent/skills` | 获取技能列表 | `?role=PM/DEV/QA`；返回系统+公共+个人技能（不含执行配置） |
| 2 | `POST` | `/api/prd-agent/skills` | 创建个人技能 | Body: `{ "title", "description?", "icon?", "category?", "tags?[]", "input?", "execution?", "output?" }` |
| 3 | `PUT` | `/api/prd-agent/skills/{skillKey}` | 更新个人技能 | Body: 同创建 |
| 4 | `DELETE` | `/api/prd-agent/skills/{skillKey}` | 删除个人技能 | 仅创建者可删 |
| 5 | `POST` | `/api/prd-agent/skills/{skillKey}/execute` | 执行技能 | Body: `{ "sessionId", "userInput?", "parameters?{}", "attachmentIds?[]", "contextScopeOverride?", "outputModeOverride?" }`；返回 runId |
| 6 | `POST` | `/api/prd-agent/skills/generate-from-message` | 从单条消息提炼技能模板 | Body: `{ "userMessage?", "assistantMessage" }` |
| 7 | `POST` | `/api/prd-agent/skills/generate-from-conversation` | 从多轮对话提炼技能草案 | Body: `{ "conversationMessages[]", "keyAssistantMessage" }` |
| 8 | `GET` | `/api/prd-agent/skills/{skillKey}/export` | 导出技能为 SKILL.md | 返回 skillMd + fileName |
| 9 | `POST` | `/api/prd-agent/skills/import` | 从 SKILL.md 导入创建技能 | Body: `{ "skillMd" }` |

---

### 8.12 管理后台群组端点 (Admin Groups)

| 序号 | 方法 | 路由 | 用途 | 关键参数 |
|------|------|------|------|----------|
| 1 | `GET` | `/api/groups` | 获取群组列表（分页） | `?page=1&pageSize=20&search=关键字&inviteStatus=valid/expired&sort=recent/created/gaps/messages` |
| 2 | `GET` | `/api/groups/{groupId}` | 获取群组详情 | 含 owner/memberCount/messageCount/pendingGapCount/topMembers/roleDistribution |
| 3 | `GET` | `/api/groups/{groupId}/members` | 获取群组成员列表 | 含 username/displayName/role/joinedAt/isOwner |
| 4 | `DELETE` | `/api/groups/{groupId}/members/{userId}` | 移除群组成员 | 不能移除群主；返回 204 |
| 5 | `POST` | `/api/groups/{groupId}/regenerate-invite` | 重新生成邀请码 | 返回新 inviteCode + inviteLink |
| 6 | `PUT` | `/api/groups/{groupId}` | 更新群组配置 | Body: `{ "groupName?", "inviteExpireAt?", "inviteExpireAtIsNull?", "maxMembers?" }` |
| 7 | `DELETE` | `/api/groups/{groupId}` | 删除群组 | 级联删除：成员 + 缺失 + 消息 + 群组 |
| 8 | `GET` | `/api/groups/{groupId}/messages` | 获取群组消息（管理端） | `?page=1&pageSize=20&q=关键字`；支持内容搜索 |
| 9 | `DELETE` | `/api/groups/{groupId}/messages` | 清空群组所有消息 | 清理 LLM 上下文缓存和 reset marker；返回 204 |

---

## 九、Web端专属架构

> 本章描述 PRD Agent 在浏览器管理后台（prd-admin）中的专属架构，包括页面结构、侧边栏设计、状态管理、跨组件通信及与桌面端的功能差异。

---

### 9.1 页面结构

Web 端采用经典的 **AppShell + 嵌套布局** 模式，整体层级如下：

```
AppShell（全局导航栏）
└── PrdAgentTabsPage（/prd-agent 路由）
    ├── PrdAgentSidebar（左侧边栏）
    └── Main 区域
        ├── mode === 'chat'    → 聊天界面
        └── mode === 'preview' → 文档预览界面
```

**关键说明：**

- **AppShell** 是全局顶层壳组件，负责渲染顶部导航栏、用户菜单、主题切换等全局 UI 元素。所有管理后台页面共享同一个 AppShell。
- **PrdAgentTabsPage** 是 `/prd-agent` 路由对应的页面组件，内部管理 PRD Agent 的全部交互状态。
- **路由地址**：`/prd-agent`，无子路由拆分。页面内部通过 Zustand Store 中的 `mode` 字段（`'chat'` | `'preview'`）控制主区域内容切换，而非通过 URL 路由跳转。
- Main 区域根据当前 `mode` 值渲染对应面板。`chat` 模式展示对话消息流与输入框；`preview` 模式展示 PRD 文档预览（支持引用定位与高亮）。

---

### 9.2 PrdAgentSidebar

侧边栏采用 **三段式垂直布局**，从上到下依次为：会话列表、知识库、缺陷管理。

#### 9.2.1 整体结构

```
┌──────────────────────────┐
│  标题 "群组"              │  ← text-sm font-medium text-text-secondary
│  [折叠按钮] [新建按钮]     │
├──────────────────────────┤
│  会话列表                 │  ← 可滚动区域，占据主要空间
│  ┌────────────────────┐  │
│  │ 🟦 会话标题 A (激活) │  │  ← 激活态左边框高亮
│  ├────────────────────┤  │
│  │ 🟩 会话标题 B       │  │
│  ├────────────────────┤  │
│  │ 🟧 会话标题 C       │  │
│  └────────────────────┘  │
├──────────────────────────┤
│  知识库                   │  ← 齿轮按钮 + 文档列表
│  ┌────────────────────┐  │
│  │ 📄 文档名称 1       │  │  ← px-3 py-2 rounded-lg text-sm
│  │ 📄 文档名称 2       │  │
│  └────────────────────┘  │
│  [追加资料按钮]           │
├──────────────────────────┤
│  缺陷管理                 │  ← Bug 图标按钮
└──────────────────────────┘
```

#### 9.2.2 标题区域

- 标题文本 **"群组"**，样式为 `text-sm font-medium text-text-secondary`
- **折叠按钮**：尺寸 `h-7 w-7 rounded-md`，点击后侧边栏收缩至折叠态
- **新建按钮**：与折叠按钮并排，点击触发 `prdAgent:createSession` 自定义事件，打开上传对话框创建新会话

#### 9.2.3 会话列表

- 每个会话项包含：
  - **头像**：`h-8 w-8 rounded-lg`，使用渐变背景色（每个会话根据 ID 或索引分配不同渐变色）
  - **标题**：会话名称，单行截断显示
  - **激活态**：当前选中会话左侧显示高亮边框（左边框样式），背景色加深
- 列表区域可滚动，支持超长列表

#### 9.2.4 知识库区域

- **齿轮按钮**：位于知识库标题右侧，点击进入知识库配置
- **文档列表**：每个文档项样式为 `px-3 py-2 rounded-lg text-sm`，展示文档名称
- **追加资料按钮**：位于文档列表底部，点击触发 `prdAgent:addDocument` 自定义事件，允许向当前会话追加补充文档

#### 9.2.5 缺陷管理区域

- **Bug 图标按钮**：尺寸 `h-7 w-7 rounded-md`，点击进入缺陷管理界面

#### 9.2.6 拖拽调宽与折叠

| 行为 | 参数 |
|------|------|
| 拖拽调宽范围 | 最小 **180px**，最大 **420px** |
| 宽度持久化 | 写入 `localStorage`，key 为 `prdAgent.sidebarWidth` |
| 折叠态宽度 | **48px**（仅显示图标，隐藏文字内容） |
| 折叠状态管理 | 由 `prdAgentStore.sidebarCollapsed` 控制 |

---

### 9.3 Chat 标题栏 [Web]

Chat 模式下主区域顶部的标题栏，从左到右布局如下：

```
┌────────────────────────────────────────────────────────────────┐
│  会话标题（可点击）  │  GlassSwitch(PM/DEV/QA)  │  🟢 已连接  │  功能按钮  │  ⋯  │
└────────────────────────────────────────────────────────────────┘
```

#### 9.3.1 会话标题

- 显示当前会话名称
- **可点击**：hover 时文字变色，提示可交互
- 点击后可执行会话重命名或查看会话详情（视具体实现而定）

#### 9.3.2 GlassSwitch 角色切换器

- 提供三种角色视角切换：**PM**（产品经理）、**DEV**（开发者）、**QA**（测试）
- 采用 GlassSwitch 组件样式（液态玻璃风格切换器）
- 角色值存储在 `prdAgentStore.currentRole` 中
- 切换角色后，AI 回复的语气、关注点、输出格式会相应调整

#### 9.3.3 连接状态指示器

| 状态 | 视觉表现 | 含义 |
|------|----------|------|
| 已连接 | 🟢 绿色实心圆点 | SSE 连接正常，空闲待命 |
| 通信中 | 🔵 蓝色脉冲圆点（动画） | 正在与服务端进行 SSE 数据传输 |

#### 9.3.4 headerRightActions 功能按钮

- 标题栏右侧的功能按钮区域，放置常用操作（如文档预览切换、导出等）
- 具体按钮根据当前会话状态动态渲染

#### 9.3.5 信息按钮

- **"⋯" 按钮**：尺寸 `h-9 w-9`，位于标题栏最右侧
- 点击展开信息面板或下拉菜单，展示会话详细信息（创建时间、文档列表、成员等）

---

### 9.4 状态管理

Web 端使用 **Zustand** 作为状态管理方案，遵循前端架构规则中"前端不维护业务中间状态"的原则。以下为核心 Store 定义。

#### 9.4.1 prdAgentStore (Zustand)

管理 PRD Agent 页面的全局状态。

```typescript
interface PrdAgentStore {
  // 主区域模式切换
  mode: 'chat' | 'preview';

  // 会话列表（从后端获取，前端仅作展示）
  sessions: PrdAgentSessionInfo[];

  // 当前激活的会话 ID
  activeSessionId: string;

  // 当前角色视角
  currentRole: 'PM' | 'DEV' | 'QA';

  // 侧边栏折叠状态
  sidebarCollapsed: boolean;
}
```

**字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `mode` | `'chat' \| 'preview'` | 控制主区域渲染聊天界面还是文档预览界面 |
| `sessions` | `PrdAgentSessionInfo[]` | 当前用户的会话列表，由后端 API 返回 |
| `activeSessionId` | `string` | 当前选中的会话 ID，驱动聊天消息加载与侧边栏高亮 |
| `currentRole` | `'PM' \| 'DEV' \| 'QA'` | 角色切换器的当前值，影响 AI 回复风格 |
| `sidebarCollapsed` | `boolean` | 侧边栏是否处于折叠态 |

> **SSOT 原则**：`sessions` 是会话列表的唯一数据源，侧边栏会话列表直接从此字段渲染。任何会话增删改操作完成后，必须更新此字段。

#### 9.4.2 prdPreviewNavStore (Zustand)

管理文档预览模式下的导航与引用高亮状态。

```typescript
interface PrdPreviewNavStore {
  // 目标跳转的标题 ID
  targetHeadingId: string | null;

  // 目标跳转的标题文本
  targetHeadingTitle: string | null;

  // 引用列表
  citations: DocCitation[];

  // 当前激活的引用索引
  activeCitationIndex: number;
}
```

**Actions（动作方法）：**

| 方法 | 参数 | 说明 |
|------|------|------|
| `openWithCitations` | `citations: DocCitation[]` | 设置引用列表并切换到预览模式，自动定位到第一条引用 |
| `consumeTarget` | 无 | 消费（清除）当前的 `targetHeadingId` 和 `targetHeadingTitle`，防止重复跳转 |
| `setActiveCitationIndex` | `index: number` | 设置当前高亮的引用索引，预览界面滚动到对应位置 |
| `clear` | 无 | 重置所有字段为初始值，退出预览模式时调用 |

**典型使用流程：**

1. 用户在聊天消息中点击引用标记
2. 调用 `openWithCitations(citations)` 写入引用数据
3. `mode` 切换为 `'preview'`，预览组件挂载并读取 `citations`
4. 预览组件根据 `activeCitationIndex` 高亮并滚动到对应段落
5. 用户点击不同引用时调用 `setActiveCitationIndex(newIndex)` 切换
6. 关闭预览时调用 `clear()` 重置状态

#### 9.4.3 localStorage Keys

以下为 Web 端使用的 localStorage 持久化键名：

| Key 模式 | 示例 | 用途 |
|----------|------|------|
| `prdAdmin.aiChat.sessions.{userId}` | `prdAdmin.aiChat.sessions.abc123` | 缓存用户的会话列表概要信息 |
| `prdAdmin.aiChat.messages.{userId}.{sessionId}` | `prdAdmin.aiChat.messages.abc123.sess456` | 缓存指定会话的消息列表（减少重复请求） |
| `prdAgent.sidebarWidth` | `prdAgent.sidebarWidth` | 侧边栏拖拽宽度值（数值类型，单位 px） |

> **注意**：localStorage 中的数据仅作为缓存加速首屏渲染，真实数据源始终以后端 API 返回为准。页面加载时先读取 localStorage 展示，同时发起 API 请求，API 返回后覆盖本地缓存。

---

### 9.5 跨组件通信 (CustomEvent)

Web 端使用浏览器原生 **CustomEvent** 机制实现跨组件通信，避免组件间的直接依赖。所有事件均在 `window` 上派发和监听。

#### 9.5.1 事件一览

| 事件名称 | detail 结构 | 触发场景 | 监听方 |
|----------|-------------|----------|--------|
| `prdAgent:createSession` | 无 | 用户点击侧边栏新建按钮 | 上传对话框组件，弹出文件上传界面 |
| `prdAgent:switchSession` | `{ sessionId: string }` | 用户点击侧边栏会话项 | 主区域聊天组件，加载对应会话消息 |
| `prdAgent:openPreview` | `{ documentId: string, sessionId: string, groupId: string }` | 用户点击消息中的文档链接或引用 | 预览组件，切换 mode 为 preview 并加载文档 |
| `prdAgent:addDocument` | 无 | 用户点击知识库区域的追加资料按钮 | 文档上传组件，弹出追加文档界面 |

#### 9.5.2 使用示例

**派发事件：**

```typescript
// 切换会话
window.dispatchEvent(
  new CustomEvent('prdAgent:switchSession', {
    detail: { sessionId: 'sess_abc123' },
  })
);
```

**监听事件：**

```typescript
useEffect(() => {
  const handler = (e: CustomEvent<{ sessionId: string }>) => {
    loadSession(e.detail.sessionId);
  };
  window.addEventListener('prdAgent:switchSession', handler);
  return () => window.removeEventListener('prdAgent:switchSession', handler);
}, []);
```

#### 9.5.3 设计原则

- **命名空间前缀**：所有 PRD Agent 相关事件以 `prdAgent:` 为前缀，避免与其他模块冲突
- **单向数据流**：事件仅用于触发动作，状态变更仍通过 Zustand Store 完成
- **类型安全**：建议在项目中为每个 CustomEvent 定义 TypeScript 类型，确保 `detail` 结构正确

---

### 9.6 SSE 流式事件类型

Web 端通过 Server-Sent Events (SSE) 接收 AI 回复的流式数据。以下为所有事件类型的完整定义。

#### 9.6.1 核心事件

| 事件类型 | 数据字段 | 说明 |
|----------|----------|------|
| `start` | `messageId: string` | 流开始，前端据此创建一条空的助手消息占位，准备接收后续内容 |
| `delta` | `text: string` | 增量文本片段，前端将其追加到当前助手消息的末尾，实现逐字/逐块打字效果 |
| `citations` | `citations: DocCitation[]` | 更新当前消息关联的引用数组，前端替换（非追加）已有引用列表 |
| `done` | 无 | 流结束，前端将消息标记为完成态，启用交互按钮（复制、引用跳转等） |
| `error` | `errorCode: string, errorMessage: string` | 流异常终止，前端展示错误信息并提供重试入口 |

#### 9.6.2 结构化块事件

用于渲染结构化内容（如代码块、表格、图表等），提供块级别的生命周期。

| 事件类型 | 数据字段 | 说明 |
|----------|----------|------|
| `blockStart` | `blockId: string, blockType: string` | 新结构化块开始，前端根据 `blockType` 创建对应渲染容器 |
| `blockDelta` | `blockId: string, text: string` | 块内容增量，追加到对应 `blockId` 的容器中 |
| `blockEnd` | `blockId: string` | 块结束，前端对该块执行最终渲染（如代码高亮、表格格式化） |

#### 9.6.3 平台专属事件

| 事件类型 | 适用平台 | 说明 |
|----------|----------|------|
| `thinking` | Desktop | 展示 AI 的思考过程（推理链），Web 端目前不处理此事件 |
| `messageUpdated` | Desktop（群组模式） | 消息更新通知（含软删除场景），Web 端非群组模式不涉及 |
| `keepalive` | Run 模式 | 每 **10 秒**发送一次心跳包，维持 SSE 连接不被中间代理/网关超时断开 |

#### 9.6.4 前端处理流程

```
[SSE 连接建立]
    │
    ├── start → 创建空消息 { id: messageId, content: '', status: 'streaming' }
    │
    ├── delta → message.content += text → 触发 UI 重渲染（打字效果）
    │
    ├── citations → message.citations = citations → 渲染引用标记
    │
    ├── blockStart → 创建块容器
    │   ├── blockDelta → 填充块内容
    │   └── blockEnd → 完成块渲染
    │
    ├── done → message.status = 'completed' → 启用交互
    │
    └── error → message.status = 'error' → 展示错误 + 重试按钮
```

---

### 9.7 Run/Worker 异步执行模式

对于长时间运行的 AI 任务，Web 端采用 **Run/Worker** 模式将任务执行与 HTTP 连接解耦，确保客户端断开不影响服务端任务处理。

#### 9.7.1 API 端点

| 操作 | 方法 | 端点 | 说明 |
|------|------|------|------|
| 创建 Run | `POST` | `/api/v1/sessions/{sessionId}/messages/run` | 提交用户消息并创建异步任务，返回 `runId` |
| 订阅 SSE | `GET` | `/api/v1/chat-runs/{runId}/stream?afterSeq=N` | 订阅任务的 SSE 事件流，支持从指定序列号恢复 |
| 取消 Run | `POST` | `/api/v1/chat-runs/{runId}/cancel` | 主动取消正在执行的任务（唯一允许中断任务的方式） |

#### 9.7.2 关键机制

**断线续传（afterSeq）：**

- 每个 SSE 事件携带递增的序列号 `seq`
- 客户端断线后重连时，携带最后收到的 `seq` 值作为 `afterSeq` 参数
- 服务端从 `afterSeq + 1` 开始重放事件，确保不丢失数据
- 前端需维护已接收的最大 `seq` 值，用于重连时传递

**心跳保活（keepalive）：**

- 服务端每 **10 秒**发送一次 `keepalive` 事件
- 防止中间代理（Nginx、CDN 等）因空闲超时关闭 SSE 连接
- 前端收到 `keepalive` 事件后无需处理，仅确认连接存活

**服务器权威性原则：**

- 客户端被动断开（关闭浏览器、网络中断）**不会取消**服务端任务
- 仅用户主动调用 `/cancel` 端点才能中断任务
- 服务端 LLM 调用和数据库写操作使用 `CancellationToken.None`
- SSE 写入捕获 `OperationCanceledException` 与 `ObjectDisposedException`，断开后跳过写入但继续处理

#### 9.7.3 典型交互时序

```
前端                            后端
 │                               │
 │  POST /messages/run           │
 │  { content: "分析这份PRD" }    │
 │ ─────────────────────────────>│
 │                               │  创建 Run 记录
 │  { runId: "run_xyz" }         │  启动 Worker 后台任务
 │ <─────────────────────────────│
 │                               │
 │  GET /chat-runs/run_xyz/stream│
 │  ?afterSeq=0                  │
 │ ─────────────────────────────>│
 │                               │
 │  event: start                 │
 │  data: { messageId, seq: 1 }  │
 │ <─────────────────────────────│
 │                               │
 │  event: delta                 │
 │  data: { text: "根据", seq: 2}│
 │ <─────────────────────────────│
 │                               │
 │  ... (更多 delta 事件) ...     │
 │                               │
 │  event: keepalive             │
 │  data: { seq: 50 }            │
 │ <─────────────────────────────│
 │                               │
 │  ✕ 网络断开                    │
 │                               │  Worker 继续执行（不中断）
 │  ✓ 网络恢复                    │
 │                               │
 │  GET /chat-runs/run_xyz/stream│
 │  ?afterSeq=50                 │  ← 从 seq 50 之后重放
 │ ─────────────────────────────>│
 │                               │
 │  event: delta                 │
 │  data: { text: "...", seq: 51}│
 │ <─────────────────────────────│
 │                               │
 │  event: done                  │
 │  data: { seq: 99 }            │
 │ <─────────────────────────────│
```

---

### 9.8 认证与授权

#### 9.8.1 认证方式

- 采用 **JWT Bearer Token** 认证
- 所有 API 请求在 HTTP Header 中携带：`Authorization: Bearer <token>`
- Token 过期（401 响应）时，前端自动执行 Token 刷新流程，刷新成功后重发原请求，用户无感知

#### 9.8.2 授权层级

| 层级 | 规则 | 说明 |
|------|------|------|
| **个人会话** | 仅拥有者可访问 | 创建者即拥有者，其他用户无法查看或操作 |
| **群组会话** | 仅成员可访问 | 需先加入群组，群组成员共享会话内容与消息 |
| **管理员端点** | AdminController + 权限目录 | 基于 `SystemRole` + `AdminPermissionCatalog`（60+ 权限项）进行细粒度控制 |

#### 9.8.3 Token 刷新流程

```
前端请求 → 401 Unauthorized
    │
    ├── 发送 Refresh Token 请求
    │   ├── 成功 → 更新本地 Token → 重发原请求
    │   └── 失败 → 跳转登录页
    │
    └── 并发请求排队：多个请求同时 401 时，仅触发一次刷新，其余请求排队等待
```

---

### 9.9 Web 与 Desktop 功能差异对照表

| 功能 | Desktop | Web | 备注 |
|------|---------|-----|------|
| **群组管理** | ✅ 完整群组功能 | ❌ 会话模式 | Web 使用个人会话替代群组概念，无多人协作 |
| **实时 SSE（群组）** | ✅ afterSeq 断线重连 | ❌ 非群组模式 | Web 使用请求-响应式 SSE，无需群组级实时同步 |
| **技能系统** | ✅ 完整技能选择与执行 | ❌ 无 | Desktop 支持丰富的技能扩展 |
| **AI Anyway** | ✅ 支持 | ❌ 不支持 | Desktop 专属的 AI 辅助功能 |
| **自动更新** | ✅ Tauri 自动更新 | N/A 不适用 | Web 端无需客户端更新机制 |
| **划词提问** | ✅ 支持 | ❌ 不支持 | Desktop 支持选中文本后直接向 AI 提问 |
| **深度链接** | ✅ `prdagent://` 协议 | ❌ 不支持 | Desktop 注册自定义协议，支持从外部跳转打开指定会话 |
| **字体缩放** | ✅ 支持 | ❌ 不支持 | Desktop 支持用户自定义字体大小 |
| **调试模式** | ❌ 不支持 | ✅ 支持 | Web 管理后台提供调试面板，查看 API 调用日志等 |
| **测试模式** | ❌ 不支持 | ✅ 支持 | Web 管理后台支持测试模式，使用 Mock 数据或测试环境 |
| **主题切换** | ✅ 水波纹过渡动效 | ✅ 全局切换 | 两端均支持明暗主题切换，Desktop 使用 View Transition API 实现圆形水波纹扩散动画，Web 使用全局 CSS 切换 |

#### 9.9.1 架构差异总结

- **Web 端定位**：轻量级管理后台，聚焦个人会话与文档管理，提供调试/测试能力
- **Desktop 端定位**：全功能桌面客户端，支持群组协作、技能系统、划词提问等高级交互
- **共享部分**：核心聊天组件、SSE 事件处理逻辑、文档预览渲染器在两端共用相同的底层实现，差异主要体现在外层容器与功能入口
