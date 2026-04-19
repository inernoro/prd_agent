# CDS (Cloud Development Suite) 功能需求说明书 · 规格

> **版本**：v1.0 | **日期**：2026-03-15 | **类型**：spec
>
> 本文档定义 CDS 的**纯功能需求**，不包含 UI 布局、视觉风格、交互动效等 UX 细节。
> 用途：作为 AI 重写前端页面时的唯一功能参照，确保所有能力被保留，但不限制设计自由度。

---

## 1. 产品定位

CDS 是一个**多分支并行开发环境管理器**。核心价值：

- 将 git 分支映射为独立的 Docker 容器化运行环境
- 通过统一入口（反向代理）在不同分支间无缝切换
- 提供 Dashboard 管理所有分支的构建、部署、监控

**用户角色**：开发者 / 验收人员（单角色，无权限分级）

---

## 2. 功能域总览

| 域 | 编号 | 核心能力 |
|----|------|----------|
| 认证 | F1 | 登录/登出 |
| 分支管理 | F2 | 分支全生命周期 |
| 构建与部署 | F3 | 容器化构建部署 |
| 服务状态 | F4 | 实时状态监控 |
| 环境变量 | F5 | 两层变量注入 |
| 构建配置 | F6 | 多 Profile 管理 |
| 基础设施 | F7 | 数据库/缓存管理 |
| 路由规则 | F8 | 请求分发控制 |
| 预览访问 | F9 | 多种预览模式 |
| 配置导入导出 | F10 | 一键配置迁移 |
| 系统维护 | F11 | 清理/重置 |

---

## 3. 功能详述

### F1. 认证

| ID | 需求 | 说明 |
|----|------|------|
| F1.1 | 用户名密码登录 | 通过环境变量 `CDS_USERNAME`/`CDS_PASSWORD` 配置，JWT 令牌认证 |
| F1.2 | 免认证模式 | 未配置用户名密码时跳过登录 |
| F1.3 | 登出 | 清除本地 token，跳转登录页 |
| F1.4 | 会话过期自动跳转 | API 返回 401 时自动跳转登录页 |

### F2. 分支管理

| ID | 需求 | 说明 |
|----|------|------|
| F2.1 | 浏览已添加分支 | 列出所有已添加的分支，显示名称、状态、最后访问时间 |
| F2.2 | 搜索远程分支 | 从 git 远程仓库获取可用分支列表，支持关键词过滤 |
| F2.3 | 添加分支 | 选择远程分支后创建 git worktree，加入管理 |
| F2.4 | 删除分支 | 停止服务 → 删除容器 → 清理 worktree |
| F2.5 | 拉取更新 | 从远程拉取最新代码到 worktree |
| F2.6 | 检查更新 | 批量检查所有分支是否有远程新提交，显示落后提交数 |
| F2.7 | 收藏分支 | 标记/取消收藏，收藏分支置顶显示 |
| F2.8 | 分支备注 | 为分支添加自由文本注释 |
| F2.9 | 标签系统 | 为分支打标签（增/删），按标签过滤分支列表 |
| F2.10 | 设为默认分支 | 设置一个分支为默认，未匹配路由规则时路由到默认分支 |
| F2.11 | 分支状态 | 每个分支有状态：idle / building / starting / running / error |
| F2.12 | 查看提交历史 | 显示分支最新提交信息，可展开查看近期提交列表 |
| F2.13 | 打开代码浏览器 | 跳转到 GitHub.dev 在线浏览对应分支代码 |
| F2.14 | 重置分支状态 | 将错误状态的分支重置为 idle |

### F3. 构建与部署

| ID | 需求 | 说明 |
|----|------|------|
| F3.1 | 全量部署 | 按所有 Build Profile 构建镜像并启动容器 |
| F3.2 | 单服务部署 | 只重新构建和启动指定 Profile 的服务 |
| F3.3 | 停止服务 | 停止分支下所有运行中的容器 |
| F3.4 | 流式构建日志 | 部署过程实时输出日志（SSE 流），包含步骤、进度、错误信息 |
| F3.5 | 历史部署日志 | 查看分支的历史部署操作记录 |
| F3.6 | 容器日志 | 查看指定服务容器的运行日志 |
| F3.7 | 构建并发锁 | 防止同一分支同时触发多次构建 |
| F3.8 | 依赖排序 | 按 `dependsOn` 拓扑排序启动顺序 |
| F3.9 | 就绪探针 | 容器启动后通过 HTTP 探针确认服务就绪 |

### F4. 服务状态监控

| ID | 需求 | 说明 |
|----|------|------|
| F4.1 | 全局状态概览 | 显示所有服务的汇总状态（N 运行中 / N 启动中 / N 错误） |
| F4.2 | 分支级服务详情 | 每个分支显示各服务的端口、状态 |
| F4.3 | 自动刷新 | 定时轮询（10s）刷新分支状态 |
| F4.4 | 端口信息展示 | 显示每个服务映射的宿主端口 |

### F5. 环境变量管理

| ID | 需求 | 说明 |
|----|------|------|
| F5.1 | 查看环境变量 | 列出所有自定义环境变量，敏感值（含 PASSWORD/SECRET/KEY）脱敏显示 |
| F5.2 | 添加变量 | 输入键值对添加新环境变量 |
| F5.3 | 编辑变量 | 内联编辑已有变量的值 |
| F5.4 | 删除变量 | 删除指定环境变量 |
| F5.5 | 批量编辑 | 打开文本编辑器，以 `KEY=VALUE` 格式批量编辑所有变量 |
| F5.6 | 自动变量 | 系统自动生成 `CDS_*` 前缀变量（主机 IP、MongoDB 端口等），无需手动配置 |
| F5.7 | 变量合并 | 部署时合并顺序：自动变量 → 镜像加速变量 → 自定义变量（后者覆盖前者） |
| F5.8 | 查看容器变量 | 查看容器内实际生效的完整环境变量列表 |

### F6. 构建配置 (Build Profile)

| ID | 需求 | 说明 |
|----|------|------|
| F6.1 | 查看配置列表 | 列出所有 Build Profile（名称、Docker 镜像、工作目录、端口、启动命令） |
| F6.2 | 添加配置 | 创建新的 Build Profile |
| F6.3 | 编辑配置 | 修改已有 Profile 的各字段 |
| F6.4 | 删除配置 | 删除 Build Profile |
| F6.5 | 快速开始 | 无配置时自动检测项目结构并生成默认 Profile |
| F6.6 | Profile 字段 | 包含：id, name, dockerImage, workDir, containerWorkDir, command, containerPort, env, cacheMounts, buildTimeout, pathPrefixes, dependsOn, readinessProbe |

### F7. 基础设施服务

| ID | 需求 | 说明 |
|----|------|------|
| F7.1 | 查看基础设施 | 列出所有基础设施服务（MongoDB、Redis 等），显示状态、端口 |
| F7.2 | 添加服务 | 创建新的基础设施服务（指定镜像、端口、卷、环境变量、健康检查） |
| F7.3 | 编辑服务 | 修改基础设施服务配置 |
| F7.4 | 删除服务 | 移除基础设施服务 |
| F7.5 | 重启服务 | 重启指定基础设施容器 |
| F7.6 | 查看日志 | 查看基础设施容器的运行日志 |
| F7.7 | 自动发现 | 启动时自动发现带有 `cds.managed=true` Docker Label 的容器 |
| F7.8 | 持久存储 | 支持 Docker named volume 和 bind mount 两种持久化方式 |
| F7.9 | 健康检查 | 可配置容器内健康检查命令、间隔、重试次数 |

### F8. 路由规则

| ID | 需求 | 说明 |
|----|------|------|
| F8.1 | 查看规则列表 | 列出所有路由规则（名称、类型、匹配模式、目标分支、优先级、启用状态） |
| F8.2 | 编辑规则 | 修改路由规则的各字段 |
| F8.3 | 启用/禁用 | 切换路由规则的启用状态 |
| F8.4 | 三种匹配类型 | header（X-Branch 请求头）、domain（域名匹配）、pattern（URL 路径匹配） |
| F8.5 | 通配符支持 | 匹配模式支持 `{{wildcard}}` 占位符（如 `{{agent_*}}` 匹配 agent-xxx） |
| F8.6 | 优先级排序 | 数字越小优先级越高 |
| F8.7 | 分支解析顺序 | X-Branch header > cookie > 域名路由规则 > 默认分支 |

### F9. 预览访问

| ID | 需求 | 说明 |
|----|------|------|
| F9.1 | 简洁模式 | 设置目标分支为默认 → 通过主域名访问（cookie 切换） |
| F9.2 | 端口直连模式 | 直接通过服务宿主端口访问，绕过代理，避免缓存问题 |
| F9.3 | 子域名模式 | 通过 `<slug>.preview.example.com` 子域名访问对应分支 |
| F9.4 | 模式切换 | 在三种预览模式间循环切换 |
| F9.5 | 分支切换域名 | 通过 `/_switch/<branch>` 路径设置 cookie 切换活跃分支 |

### F10. 配置导入导出

| ID | 需求 | 说明 |
|----|------|------|
| F10.1 | 导出配置 | 将当前所有 Build Profiles + 环境变量 + 基础设施 + 路由规则导出为 CDS Compose YAML |
| F10.2 | 导入配置 | 粘贴或上传 CDS Compose YAML，一键导入所有配置 |
| F10.3 | AI 扫描生成 | 支持通过 `/cds-scan` AI 技能自动扫描项目结构，检测技术栈（.NET/Go/Rust/Python/Java/Node.js），生成 CDS Compose YAML。覆盖：服务定义、基础设施、环境变量分层（系统/项目/服务级） |
| F10.4 | Compose 格式 | 基于 docker-compose 标准格式扩展 `x-cds-project`（项目元数据）和 `x-cds-env`（项目级环境变量） |

### F11. 系统维护

| ID | 需求 | 说明 |
|----|------|------|
| F11.1 | 清理分支 | 批量删除所有非默认分支（停止容器 + 清理 worktree） |
| F11.2 | 恢复出厂设置 | 清除所有分支、构建配置、环境变量、基础设施、路由规则，保留 Docker 数据卷 |
| F11.3 | 镜像加速 | 开关 npm/Docker 注册表镜像加速（适用于中国网络环境） |

---

## 4. 数据模型

### 4.1 分支 (BranchEntry)

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | slug 化的分支名（唯一标识） |
| branch | string | 原始 git 分支名 |
| worktreePath | string | git worktree 磁盘路径 |
| services | Record<string, ServiceState> | 各 Profile 的容器状态 |
| status | enum | idle / building / starting / running / error |
| errorMessage | string? | 错误描述 |
| createdAt | string | 创建时间 |
| lastAccessedAt | string? | 最后访问时间 |
| isFavorite | boolean? | 是否收藏 |
| notes | string? | 用户备注 |
| tags | string[]? | 标签列表 |

### 4.2 服务状态 (ServiceState)

| 字段 | 类型 | 说明 |
|------|------|------|
| profileId | string | 对应的 Build Profile ID |
| containerName | string | Docker 容器名 |
| hostPort | number | 映射到宿主的端口 |
| status | enum | idle / building / starting / running / stopped / error |
| buildLog | string? | 构建日志 |
| errorMessage | string? | 错误信息 |

### 4.3 构建配置 (BuildProfile)

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 唯一标识 |
| name | string | 显示名称 |
| dockerImage | string | Docker 镜像 |
| workDir | string | 相对 worktree 的工作目录 |
| containerWorkDir | string? | 容器内工作目录（默认 /app） |
| command | string? | 启动命令 |
| containerPort | number | 容器内服务端口 |
| env | Record<string, string>? | Profile 专属环境变量 |
| cacheMounts | CacheMount[]? | 缓存卷挂载 |
| buildTimeout | number? | 构建超时（ms，默认 600000） |
| pathPrefixes | string[]? | 代理路径前缀（如 ["/api/"]） |
| dependsOn | string[]? | 启动依赖 |
| readinessProbe | ReadinessProbe? | 就绪探针配置 |

### 4.4 基础设施服务 (InfraService)

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 唯一标识（如 mongodb, redis） |
| name | string | 显示名称 |
| dockerImage | string | Docker 镜像 |
| containerPort | number | 容器内端口 |
| hostPort | number | 宿主端口 |
| containerName | string | 容器名 |
| status | enum | running / stopped / error |
| volumes | InfraVolume[] | 持久卷配置 |
| env | Record<string, string> | 容器环境变量 |
| healthCheck | InfraHealthCheck? | 健康检查配置 |

### 4.5 路由规则 (RoutingRule)

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 唯一标识 |
| name | string | 规则名称 |
| type | enum | header / domain / pattern |
| match | string | 匹配模式（支持通配符） |
| branch | string | 目标分支 slug |
| priority | number | 优先级（越小越高） |
| enabled | boolean | 是否启用 |

### 4.6 持久状态 (CdsState)

| 字段 | 类型 | 说明 |
|------|------|------|
| routingRules | RoutingRule[] | 路由规则列表 |
| buildProfiles | BuildProfile[] | 构建配置列表 |
| branches | Record<string, BranchEntry> | 所有分支 |
| nextPortIndex | number | 端口分配计数器 |
| logs | Record<string, OperationLog[]> | 操作日志 |
| defaultBranch | string \| null | 默认分支 |
| customEnv | Record<string, string> | 自定义环境变量 |
| infraServices | InfraService[] | 基础设施服务 |
| mirrorEnabled | boolean? | 镜像加速开关 |

---

## 5. 核心流程

### 5.1 分支部署流程

```
用户触发部署
  → 加锁（防并发）
  → 按 dependsOn 拓扑排序 Profile
  → 对每个 Profile：
      → 创建/重建 Docker 容器
      → 挂载 worktree 目录到容器
      → 注入合并后的环境变量
      → 执行 command 启动服务
      → 就绪探针轮询确认
  → 更新分支状态为 running
  → 解锁
  → 全程 SSE 流式输出日志
```

### 5.2 请求路由流程

```
外部请求到达 → 代理服务
  → 解析分支：X-Branch header > cookie(cds_branch) > 域名规则 > 默认分支
  → slugify 分支名
  → 查找对应 BranchEntry 的 services
  → 按 pathPrefixes 匹配目标服务
  → 代理到 localhost:{hostPort}
```

### 5.3 配置导入流程

```
用户粘贴 CDS Compose YAML
  → 解析 services（→ BuildProfile）
  → 解析 x-cds-env（→ 环境变量）
  → 检测基础设施服务（MongoDB/Redis 等）
  → 预览变更摘要
  → 用户确认 → 批量写入 state
```

---

## 6. 非功能需求

| 类别 | 要求 |
|------|------|
| 状态持久化 | JSON 文件存储（`.cds/state.json`），无外部数据库依赖 |
| 认证 | JWT 令牌，通过环境变量配置密钥 |
| 网络 | 所有容器在同一 Docker network 内通信 |
| 端口分配 | 从 portStart 自增分配宿主端口，避免冲突 |
| 错误恢复 | 分支状态可重置，避免死锁 |
| 中文界面 | 所有用户可见文本使用中文 |
| 移动端 | 页面需在移动端可用 |

---

## 7. 与主项目的关系

- CDS 是**独立部署**的 Node.js 服务，不依赖 prd-api 或 prd-admin
- 唯一的集成点：`prd-admin/vite.config.ts` 支持通过 `VITE_API_PORT` 环境变量切换 API 代理目标
- CDS 管理 prd-agent 项目的多分支环境，但其架构可适用于任何 Docker 化项目
