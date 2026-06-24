# 从零开始的 CDS 教程 · 指南

> **版本**：v1.0 | **日期**：2026-05-30 | **状态**：已落地

本文带你从零用 CDS 把项目跑起来，覆盖一个二维矩阵：**4 个横向场景**（复杂度递增）×**2 条纵向路径**（直配 / compose 导入），外加 compose **评分**与**自愈**。所有命令通过 cds 技能的 `cdscli` 执行。

每个场景都有一个可直接部署的示例工程（`cds/examples/tutorial-0X-*/`），并各自发布进一个**独立隔离的知识库**（见 § 隔离）。

约定：下文 `cdscli` = `python3 .claude/skills/cds/cli/cdscli.py`。

---

## 前置：认证与预检

CDS 有两层认证（详见 `.claude/skills/cds/reference/auth.md`）：

- **管理 API**（建项目 / 部署）：`X-AI-Access-Key: $AI_ACCESS_KEY`
- **应用后端**（知识库等）：`X-AI-Access-Key` + `X-AI-Impersonate: <真实用户名>`

开跑前先预检：

```bash
cdscli preflight        # CDS_HOST 可达？AI_ACCESS_KEY 有效？reposBase 配了？
cdscli auth check
```

---

## 横向 × 纵向矩阵

| 场景 | 示例目录 | 组成 |
|---|---|---|
| ① 静态网页托管 | `cds/examples/tutorial-01-static-web/` | 单 app（serve 静态） |
| ② 网页 + 后台 | `cds/examples/tutorial-02-web-and-backend/` | 前端 + Express 后端 |
| ③ + MongoDB | `cds/examples/tutorial-03-web-backend-mongo/` | ② + mongodb infra |
| ④ 多体 + redis+mysql+rabbitmq | `cds/examples/tutorial-04-fullstack-infra/` | 前后端 + 3 infra |

### 纵向②：用 cds-compose.yml 一键导入（推荐）

每个示例目录已带 `cds-compose.yml`。统一四步：

```bash
cd cds/examples/tutorial-0X-...
cdscli verify . --min-score 90                 # 1. 评分门禁：必须 A 级再往下
IMPORT_ID=$(cdscli scan . --apply-to-cds <projectId> | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['importId'])")
cdscli import-wait "$IMPORT_ID"               # 3. 阻塞到导入终态（需传 importId）
cdscli deploy                                  # 4. push + 部署 + 冒烟
cdscli --human preview-url                     # 5. 拿预览地址验收
```

### 纵向①：直接配置 CDS（无 cds-compose.yml，Railway 模式）

适合手上只有 Git 地址、不想写 compose 的情况。CDS 用 onboarding runtime + 栈检测自动建 BuildProfile。

```bash
# 1. 建项目（指定 git 地址；CDS clone 后读真实默认分支）
cdscli project create --name "教程0X" --git-url <repoUrl>
# 2. clone + 自动 detect 栈 + 自动建 profile（SSE）
cdscli project clone <projectId>
# 3. 部署
cdscli branch deploy <branchId>
```

各场景 onboarding runtime 选择：

- 场景①：前端服务 = `静态站点(static)`
- 场景②：前端 = `static` + 后端 = `Node.js`
- 场景③：在②基础上，infra 区域加一个 `MongoDB` preset（CDS 自动注入 `MONGODB_URL`）
- 场景④：前端 `static` + 后端 `Node.js` + infra 加 `MySQL` / `Redis` / `RabbitMQ` 三个 preset

> 直配三种方式的完整对照见 `doc/guide.cds.deploy-three-paths.md`。

---

## compose 评分（挡掉垃圾 compose）

`cdscli verify` 现在除了 ERROR/WARNING/INFO 分级，还给一个 **0-100 评分 + 字母等级**：

```bash
cdscli verify cds/examples/tutorial-04-fullstack-infra
# [OK] verify 通过 评分=98(A) WARNING=0 INFO=1
```

评分规则（SSOT：`doc/spec.cds.compose-contract.md` § 4.4）：满分 100，每个 ERROR −25、WARNING −8、INFO −2，下限 0。等级 A(≥90)/B(≥75)/C(≥60)/D(≥40)/F(<40)。

**质量门禁**：加 `--min-score N`，评分低于 N 直接 exit 1。教程示例与 CI 都用 `--min-score 90` 把垃圾 compose 拦在部署前：

```bash
cdscli verify . --min-score 90    # 不达 A 级就 fail，不让你 apply
```

---

## compose 自愈（自动修 + 给建议）

`cdscli verify --fix` 对**能机器确定地修对**的问题自动修补，对其余给可执行建议：

```bash
cdscli verify <path> --fix            # 打印 unified diff + 建议，默认不落盘
cdscli verify <path> --fix --write    # 把可自动修的改动写回文件（先备份 .bak）
```

- **自动修**（规则 SSOT：`doc/spec.cds.compose-contract.md` § 4.5）：
  - `env-var-unresolved` → 在 `x-cds-env` 补占位变量（值 `CHANGE_ME`，**仍需人工填真值**，输出会标 needsReview）
  - `depends-on-hint` → 给应用 service 的 `depends_on` 补上引用到的 infra
- **只给建议**（机器无法确定）：`app-ports-missing`（要真实端口）、`infra-image-missing`（要人选镜像）等，原样输出 issue 的 `fix` 文案

输出会区分「已自动修 N 项 / 需人工 M 项」。`--write` 会用 PyYAML 重序列化整个文件（注释会丢、缩进风格会变），**务必先看 diff 再 `--write`**。

---

## 隔离：每场景独立知识库 + 独立运行环境

「单独隔离」在本教程是双重的：

1. **内容隔离（知识库）**：每个场景发布进一个**独立 DocumentStore**（`appKey=cds-tutorial`），store 级隔离 + 级联清理，删其一不影响其余。

   ```bash
   AI_ACCESS_KEY=... CDS_TUTORIAL_IMPERSONATE=<用户名> \
     python3 scripts/publish-cds-tutorial-kb.py        # 幂等，重复跑只更新内容
   ```

   发布后在 prd-admin 的 `/document-store` 能看到 4 个独立知识库。

2. **运行隔离（CDS Project）**：每个场景注册为一个**独立 CDS Project**，自带独立 docker network + DB filter，运行时互不污染（`doc/design.cds.multi-project.md`）。

---

## 验收清单

- [ ] `cdscli verify <示例> --min-score 90` 四个场景全 A 级
- [ ] 至少场景①③走完 `scan → apply → deploy`，预览域名返回 200
- [ ] `publish-cds-tutorial-kb.py` 后 `/document-store` 出现 4 个独立知识库
- [ ] 删其中一个知识库，其余三个仍在
- [ ] `cdscli --human preview-url` 输出原文贴进验收记录

## 关联文档

- `doc/spec.cds.compose-contract.md` — compose 契约 + 评分/自愈规则 SSOT
- `doc/guide.cds.deploy-three-paths.md` — 三种部署方式对照
- `doc/design.cds.multi-project.md` — 多项目隔离
- `doc/debt.cds.tutorial.md` — 已知边界
