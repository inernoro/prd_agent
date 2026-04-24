# CDS 多项目隔离审计规则

> 状态: active | 作者: Claude Code | 创建: 2026-04-22
> 根因: 三次跨项目数据污染事件暴露了 MECE 矩阵的系统性盲区

---

## 事故回顾（2026-04-22）

### 发生了什么

myTapd 项目的 `cds-compose.yaml` 被导入到 default/prd-agent 项目，导致：

| 受污染的对象 | 污染内容 | 影响 |
|-------------|---------|------|
| buildProfiles.api | 被 Spring Boot/Maven 配置覆盖 | prd-agent API 无法构建 |
| buildProfiles.web | 新增 miduo-frontend 配置 | prd-agent 多出一个不属于它的前端 |
| infraServices | 新增 MySQL、MinIO | default 项目基础设施列表出现异类 |
| globalEnv | 注入 SPRING_* 变量 | 所有容器的环境变量被 Spring Boot 配置污染 |
| buildProfiles.api.env | 紧急修复时 env 段被清空 | Redis/MongoDB 连接串丢失，API 崩溃 |

### 根本原因

`POST /quickstart` 的 `composeCandidates` 数组包含 `config.repoRoot`（CDS 宿主目录），而 CDS 宿主目录是**所有项目共享**的，在其中发现的第一个 `cds-compose.yaml` 会被无差别地应用到当前项目。

---

## MECE 矩阵为何漏掉这个问题

### 原矩阵的盲区分析

旧矩阵检查了「数据写入隔离」（buildProfiles/infraServices/envVars 是否按 projectId 存储），但漏掉了以下三类：

| 审计维度 | 旧矩阵 | 应有 |
|---------|--------|------|
| **文件读取向量** | ❌ 未覆盖 | 每个读文件操作的根目录是否隔离到项目 repo root |
| **入口点完整性** | ❌ 未覆盖 | 所有写数据的入口点（不只是 /import-config）是否都被审计 |
| **共享资源污染** | ❌ 未覆盖 | globalEnv、infra、proxy.ts 等跨项目共享的对象是否有越界写 |
| **紧急修复后的数据完整性** | ❌ 未覆盖 | 手工修复 API 后是否验证了 env/dependsOn 的完整性 |

### 具体遗漏的入口点

| 端点 | 污染类型 | 修复 |
|------|---------|------|
| `POST /quickstart` | composeCandidates 扫描共享目录 | 改用 projectRepoRoot |
| `GET /infra/discover` | discoverComposeFiles(config.repoRoot) | 改用 projectRepoRoot |
| `POST /infra/quickstart` | discoverComposeFiles(config.repoRoot) | 改用 projectRepoRoot |
| `PUT /api/build-profiles/:id` | 手工修复时丢失 env 段 | 需要修复后完整验证 |

---

## 新版审计清单（MECE 扩展版）

每次修改 CDS 多项目相关代码时，逐条过以下矩阵：

### 维度 1：数据写入隔离（原有）

- [ ] buildProfiles 的 CRUD 操作都带 `projectId`
- [ ] infraServices 的 CRUD 操作都带 `projectId`
- [ ] envVars 的写入带正确的 `scope`（项目 ID 或 `_global`）
- [ ] routingRules 的写入带 `projectId`

### 维度 2：文件读取隔离（新增 ⭐）

- [ ] **所有 `discoverComposeFiles()` 调用** — 根目录是 `stateService.getProjectRepoRoot(projectId, config.repoRoot)` 还是共享的 `config.repoRoot`？
- [ ] **所有 `parseCdsCompose()` / `parseComposeFile()` 调用** — 文件路径是从哪个目录发现的？
- [ ] **所有 `readFileSync/existsSync` + repoRoot 的组合** — 是否可能读到其他项目的文件？

判定规则：凡是根目录是 `config.repoRoot` 且没有项目过滤的，都是隔离漏洞。

### 维度 3：入口点完整性（新增 ⭐）

修改了一个入口点的隔离后，必须搜索**所有其他入口点**：

```bash
# 找出所有可能触发 compose 发现/解析的入口
grep -n "discoverComposeFiles\|parseCdsCompose\|parseComposeFile\|composeCandidates" \
  cds/src/routes/branches.ts
```

- [ ] `/quickstart` — compose 文件候选路径
- [ ] `/infra/discover` — compose 文件发现根目录
- [ ] `/infra/quickstart` — compose 文件发现根目录
- [ ] `/import-config` — 用户主动导入（已有项目参数，相对安全）
- [ ] 未来新增的任何扫描类端点

### 维度 4：共享资源污染（新增 ⭐）

- [ ] `globalEnv` — 新增的全局 env 键是否适合所有项目？`SPRING_*` 这类框架特定键不应进全局
- [ ] `infraServices` — 从 compose 导入的 infra 是否正确绑定了 `projectId`？
- [ ] `proxy.ts getBuildProfiles()` — 路由分发时是否只用当前分支的项目下的 profiles？

### 维度 5：修复后数据完整性（新增 ⭐）

任何通过 API 手工修复 buildProfile 后，必须验证：

```bash
# 检查 env 段不为空
curl "$CDS/api/build-profiles?project=<id>" | jq '.profiles[] | {id, env, dependsOn}'

# 关键字段：
# - env 不能是 {}（空对象）
# - dependsOn 只含本项目的 infra service id
# - containerPort 和 command 中的端口一致
```

- [ ] `env` 段包含所有连接串（MongoDB、Redis 等）
- [ ] `dependsOn` 只引用属于本项目的 infra service
- [ ] `containerPort` 与 `command` 中的 `--urls` 端口一致

---

## 永久性防御规则

### 规则 1：discoverComposeFiles 只允许项目 repo root

```typescript
// ✅ 正确
const scanRoot = stateService.getProjectRepoRoot(projectId, config.repoRoot);
const files = discoverComposeFiles(scanRoot);

// ❌ 禁止 — 会扫描到所有项目的 compose 文件
const files = discoverComposeFiles(config.repoRoot);
```

### 规则 2：全局 env 禁止框架专用键

进全局 env 的键必须满足：
- 对所有项目（.NET / Spring Boot / Node.js）都无害
- 不含框架特定前缀（`SPRING_*` / `DJANGO_*` / `RAILS_*`）
- 只放真正的跨项目共享密钥（如 `AI_ACCESS_KEY`、`PREVIEW_DOMAIN`）

### 规则 3：紧急修复后的完整性校验

手工 `PUT /api/build-profiles/:id` 修复后，立即运行验证脚本：

```bash
curl -sf -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  "$CDS/api/build-profiles?project=<id>" | \
  python3 -c "
import json, sys
for p in json.load(sys.stdin).get('profiles', []):
    env_ok = bool(p.get('env'))
    deps_ok = bool(p.get('dependsOn'))
    print(f'{p[\"id\"]}: env={\"OK\" if env_ok else \"EMPTY!\"}  deps={p.get(\"dependsOn\")}')"
```

### 规则 4：infra 删除后检查 dependsOn 引用

删除 infra service 后，扫描所有 buildProfiles 的 `dependsOn`，移除悬空引用：

```bash
# 例：删除 mysql 后
curl "$CDS/api/build-profiles?project=default" | \
  jq '.profiles[] | select(.dependsOn[] == "mysql") | .id'
```

---

## 已修复的漏洞记录

| 提交 | 修复内容 |
|------|---------|
| 5d30b54 | `composeCandidates` 移除所有 config.repoRoot 路径 |
| 5d30b54 | quickstartBannerHint 动态显示项目名 |
| 5d30b54 | runQuickstart 导入后自动打开 TODO env 编辑器 |
| 3ad379f | `GET /infra/discover` 改用 projectRepoRoot |
| 3ad379f | `POST /infra/quickstart` 改用 projectRepoRoot |
| 手工修复 | 删除 default 项目的 mysql、minio infra（污染残留） |
| 手工修复 | 恢复 api buildProfile 的 env、dependsOn、containerPort |
| 手工修复 | 删除 globalEnv 中的 SPRING_* 污染变量 |
