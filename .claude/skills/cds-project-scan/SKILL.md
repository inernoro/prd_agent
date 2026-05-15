---
name: cds-project-scan
description: Scans local project structure and generates or uploads CDS compose YAML for project onboarding (the cold path of CDS lifecycle). Activates when the user wants to register a new project to CDS, regenerate the compose contract after structural changes, or push cds-compose.yml to CDS for approval. Detects tech stacks (.NET, Node, Rust, Python, Go), infrastructure services (MongoDB/Redis/Postgres), environment variables and routing prefixes; can submit via --apply-to-cds. Does NOT handle deployed-branch debugging, container logs, deploy failures, smoke tests, or CDS service self-update — those belong to cds-deploy-pipeline (hot path) and cds (core). Trigger phrases include "扫描项目", "接入 CDS", "生成 compose", "上传 cds 配置", "apply to cds", "注册项目到 cds", "register project", "/cds-scan", "--apply-to-cds".
---

# CDS Project Scan — 冷路径：项目接入 / 配置生成

> **冷路径定位**：一次性 / 低频。把"本地仓库"变成"CDS 可识别的项目"。
> 已部署后的调试、日志、冒烟 → 走 `cds-deploy-pipeline`（热路径）。
> 认证、env、key 管理、CDS 服务自更新 → 走 `cds`（核心）。

## 本技能处理 / 不处理

| 处理 | 不处理（去对应技能） |
|---|---|
| 扫描本地代码树，识别技术栈和基础设施 | 看灰度环境运行状态（`cds-deploy-pipeline`） |
| 生成 `cds-compose.yml` / docker-compose YAML | 看容器日志 / 诊断 deploy 失败（`cds-deploy-pipeline`） |
| 提交 YAML 到 CDS 等待审批（`--apply-to-cds`） | 配置 `AI_ACCESS_KEY` / 项目 Key（`cds`） |
| 重新扫描、刷新 compose 契约 | 更新 CDS 服务本体代码（`cds` 的 self-update） |

## 触发判定

满足任一即进入本技能（不与 cds-deploy-pipeline 共享触发词）：

- 用户明确说："**扫描**项目"、"**接入** CDS"、"**生成** compose"、"**上传** cds 配置"
- 用户传命令：`/cds-scan`、`cdscli scan`、`--apply-to-cds <projectId>`
- 用户表达"项目还没在 CDS 上 / 想让 Claude 帮忙装到 CDS"

歧义场景（用户只说"cds"或"部署"，未提扫描/接入）→ 让 `cds` 分诊器先反问方向。

## 快速开始

所有操作走共享的 cdscli（位于 `cds` 技能下，避免多份维护）：

```bash
CLI="python3 $(git rev-parse --show-toplevel)/.claude/skills/cds/cli/cdscli.py"

# 1. 首次接入
$CLI init                                  # 配 CDS_HOST + AI_ACCESS_KEY
$CLI scan                                  # 仅扫描，stdout 输出 YAML
$CLI scan --output compose.yaml            # 写文件
$CLI scan --apply-to-cds <projectId>       # 扫 + 提交 CDS 审批
$CLI verify <repo-root>                    # 校验 cds-compose.yml 合规
```

CLI 输出格式 `{ok, data|error, trace}`；加 `--human` 切人读表格。

## AI 决策规则（不要反复询问用户）

用户说"扫一下我的项目" / "接入 CDS" / "生成 compose" 时，AI 直接：

1. 跑 `cdscli scan <repo-root>`，看 `data.signals.source`：
   - `cds-compose.yml` = 项目根已有 SSOT，直接用，不要再生成
   - `docker-compose (xxx)` = 已识别基础设施 + 应用服务，可用
   - `monorepo-scan` = 已扫到子目录服务，可用
   - `skeleton` = 完全空白，告诉用户"未识别已知栈，请补充 docker-compose 或子目录 manifest"
2. **直接展示**前 30 行 YAML + signals 给用户审视，**不追问**"要不要改"。OK 后才 `--apply-to-cds`。
3. 不要询问"用什么端口 / 用什么镜像 / 怎么命名"——这些都从扫描信号里推断；用户主动提才调整。

## 执行流程（复杂项目时复制 checklist）

```
CDS 扫描进度：
- [ ] Phase 1: 识别项目根（git rev-parse --show-toplevel）
- [ ] Phase 2: 扫描技术栈（后端 / 前端 / Monorepo）
- [ ] Phase 3: 扫描基础设施（docker-compose / 代码连接串）
- [ ] Phase 4: 扫描环境变量（.env.example → appsettings.json → 代码引用）
- [ ] Phase 5: 展示摘要 → 用户确认
- [ ] Phase 6: 生成 cds-compose YAML
- [ ] Phase 7 (可选): --apply-to-cds 提交审批
```

详细检测规则 → [reference/tech-detection.md](reference/tech-detection.md)

## 输出契约（cds-compose YAML）

标准 docker-compose + CDS 扩展：

| 字段 | 含义 |
|---|---|
| `x-cds-project` | 项目元数据：`name` / `description` / `repo`（git remote URL） |
| `x-cds-env` | 全局共享环境变量，CDS 注入所有容器 |
| `services.*.environment` | 服务特有变量；**禁止**与 `x-cds-env` 重复声明，用 `${VAR}` 引用 |
| 有相对路径 volume mount（`./xxx:/app`） | App 服务 |
| 无相对路径 mount + 有 ports | 基础设施 |
| `labels.cds.path-prefix` | 代理路由前缀 |
| `${CDS_HOST}` / `${CDS_<SERVICE>_PORT}` | 运行时替换 |

提交前自检：`cdscli verify <repo-root>` exit code 必须 == 0（允许 WARNING/INFO，不允许 ERROR）。

## 7 类常见漏洞（提交前对照）

详见 [doc/spec.cds-compose-contract.md](../../../doc/spec.cds-compose-contract.md) § 3-4。Top hits：

| 现象 | 根因 | 自检 |
|---|---|---|
| 容器 env 收到 `${VAR}` 字面量 | cdsVars 嵌套引用未递归展开 | `cdscli verify` 报未解析 `${UNDEFINED}` |
| backend `Name or service not known` | dependsOn 漏写 | `cdscli verify` 给 INFO 提示 |
| 容器挂空目录 | scan 的 workDir 拼错 | `cdscli verify` 报 ERROR `app-workdir-missing` |
| proxy connection refused | 应用监听端口 ≠ ports 段 | 手 grep `port` 应用配置 |
| 改完 compose 但 CDS 不识别 | first clone 后 detect 不再跑 | 重新 `cdscli scan --apply-to-cds <projectId>` 提交 |

## Phase 7：提交到 CDS（仅显式触发时）

默认关闭。仅当用户说"提交到 CDS" / "apply to cds"，或传 `--apply-to-cds <projectId>` 才执行。

进度可见性硬要求（违反 CLAUDE.md 规则 #6 即缺陷）：每步必须渲染清单：

```
CDS 提交进度：
- [x] 步骤 1/5：检查环境变量
- [x] 步骤 2/5：确认目标 projectId
- [>] 步骤 3/5：POST /api/projects/:id/pending-import
- [ ] 步骤 4/5：解析 importId
- [ ] 步骤 5/5：打印审批链接
```

完整 API + 错误处理 → [reference/cds-pending-import.md](reference/cds-pending-import.md)

## 关联技能

| 后续动作 | 走哪个技能 |
|---|---|
| 审批通过后部署到分支 | `cds-deploy-pipeline`（热路径） |
| 部署后看日志 / 诊断报错 | `cds-deploy-pipeline` |
| 改 `AI_ACCESS_KEY` / 旋转项目 Key | `cds`（核心） |
| 改完 cds 服务本体重启 CDS | `cds` 的 self-update |

## 参考索引（按需加载）

| 文件 | 何时读 |
|---|---|
| [reference/tech-detection.md](reference/tech-detection.md) | 扫描规则细节、栈识别优先级 |
| [reference/cds-pending-import.md](reference/cds-pending-import.md) | `--apply-to-cds` 端点契约 + 错误处理 |
| [reference/infra-init.md](reference/infra-init.md) | 用户拒绝 CDS 管理时的手动初始化兜底 |
