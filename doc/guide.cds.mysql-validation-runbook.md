# CDS MySQL 接入实战 Runbook(Phase 6)

> **类型**:guide(操作指南) | **版本**:1.0 | **最后更新**:2026-05-01
> **目标**:验证 Phase 1-5 端到端跑通 — 用户 1 个动作("接入这个 repo"),AI 自动跑通 schemaful DB 项目部署
> **目标读者**:用户(挑选并验收)+ 接力 Agent(执行 + 记录)

---

## 0. 用户唯一动作 + AI 全自动接管

**用户做**:从下方 § 1 候选清单挑一个项目,告诉 AI 项目 GitHub URL。
**AI 做**:剩下全部(fork → cdscli scan → 提交 CDS → 等待部署 → 跑冒烟 → 写报告)。

如果 Phase 1-5 工作正确,这一步应当**零手工干预**。任何手工干预都是 Phase 7+ 待修缺陷。

---

## 1. 候选开源项目(按推荐度排)

> 选择标准:① 有 mysql/postgres ② 用主流 ORM ③ 仓库 < 200MB(避免 clone 超时)
> ④ docker-compose 完整 ⑤ 跑起来后有可访问 HTTP 业务页面(不只是 API)

### 推荐 A — Strapi v4 自托管(MySQL + Knex 迁移)

- **GitHub**:`strapi/strapi-docker` 或 `strapi/strapi` 主仓库
- **技术栈**:Node.js + Knex(类似 Sequelize 模式)+ MySQL
- **大小**:中等(Strapi 主仓约 100MB,docker 仓 < 10MB)
- **业务页面**:Admin Panel `/admin`(可视化看到 schema 表)
- **难度**:中等。Strapi 启动时自动建库 + 跑 migration,Phase 4 sequelize 探测器可能不命中(Strapi 有自己的 migration runner),需要在 cdscli 加 strapi-specific 探测
- **推荐评分**:7/10 — 业务页面直观但探测器可能失效

### 推荐 B — Prisma Examples / express-prisma-rest-api(★ 首选)

- **GitHub**:`prisma/prisma-examples`(`databases/mysql` 子目录) 或社区版 `express-prisma-rest-api`
- **技术栈**:Node.js + Express + Prisma + MySQL
- **大小**:小(单个 example < 10MB)
- **业务页面**:RESTful API(`/api/users` 等),用 curl 验证或加个简单 HTML 前端
- **难度**:低。Prisma 是 Phase 4 默认探测器,migration deploy 现成
- **推荐评分**:9/10 ★ — Phase 1-5 设计目标项目,几乎 100% 跑通

### 推荐 C — NestJS + TypeORM 模板

- **GitHub**:`nestjs/typescript-starter` + 加 mysql + typeorm 配置
- **技术栈**:NestJS + TypeORM + MySQL
- **大小**:中(50MB)
- **业务页面**:Swagger `/api`
- **难度**:中。要用户改 ormconfig 添加 mysql + 写一个简单 entity
- **推荐评分**:7/10 — TypeORM 探测命中,但 starter 默认无 mysql 配置需自加

### 推荐 D — eShop / EF Core MySQL

- **GitHub**:`dotnet/eShop` 或简化版
- **技术栈**:.NET 8 + EF Core + MySQL(eShop 默认 SQLServer,需改 provider)
- **大小**:大(eShop 200MB+)
- **业务页面**:Web Admin
- **难度**:高。eShop 默认 SqlServer,改 mysql 需换 provider 包 + 重写 migration
- **推荐评分**:5/10 — 真实生产复杂度高,但首次实战压力测试有意义

### 推荐 E — Rails Active Record 极简 demo

- **GitHub**:`rails/rails` 主仓的 `guides/bug_report_templates/active_record.rb` 改造,或社区 `rails-mysql-docker-template`
- **技术栈**:Rails 7 + ActiveRecord + MySQL
- **大小**:小(脚手架 30MB)
- **业务页面**:Rails 默认页面 + scaffold 出来的 CRUD
- **难度**:中。Rails 探测器 Phase 4 已加,但 Ruby 镜像启动慢
- **推荐评分**:6/10 — 体现 cdscli 多语言通用性

---

## 2. 推荐首发:Prisma Examples / databases/mysql

**理由**:
- 设计目标对齐(Phase 4 默认走 prisma)
- 仓库小快
- ORM 行为成熟(`prisma migrate deploy` 是工业标准)
- 失败可快速定位(Phase 1-5 中任一环节 bug 都会暴露)

**操作步骤**(用户 + AI 协作):

### 用户做(只这一步)

```
告诉 AI:"把 https://github.com/prisma/prisma-examples 的 databases/mysql 子目录接入 CDS"
(或直接 fork 后给 AI 你 fork 后的 URL)
```

### AI 做(全自动)

#### Step 1:Clone 并 scan

```bash
git clone https://github.com/<user>/prisma-examples /tmp/phase6-test
python3 .claude/skills/cds/cli/cdscli.py scan /tmp/phase6-test/databases/mysql 2>&1 | python3 -m json.tool
```

**期望**(基于 Phase 1-5 输出):
```json
{
  "ok": true,
  "data": {
    "signals": {
      "orms": {"<app-svc>": "prisma"},
      "schemafulInfra": ["mysql"],
      "deployModes": ["<app-svc>"]
    },
    "yaml": "...含 wait-for + migrate + dev/prod modes..."
  }
}
```

#### Step 2:cdscli verify(Phase 2.5 静态校验)

```bash
python3 .claude/skills/cds/cli/cdscli.py verify /tmp/phase6-test/databases/mysql
```

**期望**:exit 0,允许 WARNING/INFO,不允许 ERROR。

#### Step 3:在 CDS 创建项目并 apply

```bash
# 用 GitHub URL 创建项目(用户已经授权 CDS App 的话,自动 link)
python3 .claude/skills/cds/cli/cdscli.py scan --apply-to-cds <projectId> /tmp/phase6-test/databases/mysql
```

返回 `importId` + 批准 URL。**用户在 CDS Dashboard 点「批准」**(这是 Phase 6 唯一不可避免的人工动作)。

#### Step 4:等部署完成

```bash
# Phase 2 后 push 即部署。CDS webhook 拉代码 → build → deploy
# AI 主动轮询 status:
python3 .claude/skills/cds/cli/cdscli.py branch status <branchId>
```

**期望流程**(SSE 事件):
```
git-pull → infra-mysql running → infra-mysql done :PORT → build-backend → deploy-backend
  → readiness probe ok → all done
```

任何 step 卡住超过 5 分钟 = bug,记录到下面 § 4。

#### Step 5:冒烟 — schema + 业务 API

```bash
# L1:预览域名根路径(404 也算 alive)
curl -i https://<branch-slug>.miduo.org/

# L2:进容器查 schema 是否真的建了
python3 .claude/skills/cds/cli/cdscli.py branch exec <branchId> --profile mysql 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" -e "SHOW TABLES IN app_main;"'
# 期望:看到 prisma 模型定义的表(如 User, Post 等)

# L3:业务 API
curl -s https://<branch-slug>.miduo.org/api/users
# 期望:200 OK,返回 [] 或 seed 数据
```

#### Step 6:多分支验收(Phase 5 per-branch)

```bash
# 切到 per-branch 模式
curl -X PUT "$CDS/api/projects/<id>/build-profiles/backend" \
  -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  -d '{"dbScope": "per-branch"}'

# 在 GitHub 上新建一个 feat/test 分支,push
# CDS 自动部署 feat/test 分支
# 期望:容器内 MYSQL_DATABASE=app_feat_test(不是 app_main)
python3 .claude/skills/cds/cli/cdscli.py branch exec <feat-branch-id> --profile backend 'env | grep MYSQL_DATABASE'

# 验证两分支表互不干扰:
# main 分支 INSERT users 一行,feat/test 分支 SELECT users 应该是空
```

#### Step 7:写实战报告

```bash
# 模板:doc/report.cds-phase6-validation.md
# - 跑通的步骤打勾
# - 卡住的步骤记录(Phase 7+ 待修)
# - 时长统计(用户体验:从「告诉 AI」到「能访问」总分钟数)
```

---

## 3. 完成判定(plan § 三 § Phase 6 原文)

- [ ] 端到端用户体验 ≤ 2 步:① 给 Git URL ② 等部署完
- [ ] 部署成功率 100%(failure 全部需在前 5 个阶段修掉)
- [ ] 业务 API 真实跑通(curl 200 + DB 写入成功)

加 Phase 5 验证项:
- [ ] dbScope=per-branch 切换后,新分支拿到独立 database name
- [ ] 两分支同时跑 prisma migrate deploy 不冲突

---

## 4. 已知风险 / 潜在卡点

预测 Phase 6 实战可能暴露:

| 风险 | 概率 | 缓解 |
|------|------|------|
| Prisma `migrate deploy` 在容器内 npm 没装 → 依赖问题 | 中 | scan 自动注入 `npm install &&` 前缀(目前没做,Phase 7 加) |
| GitHub 大仓 clone 超时 | 低 | CDS 默认 git clone 超时 5min,大部分 example 都小 |
| MySQL 8 镜像启动慢(>30s),wait-for 起步太早超时 | 中 | wait-for 是无限循环 `until ... do sleep 1`,无超时,会等到天荒地老 |
| Prisma seed.js 未提供 → `npx prisma db seed` 失败 | 中 | 默认 prod mode 不跑 seed,用户需要时切 dev mode 自担风险 |
| 应用 image `node:20` 内没 `nc` (netcat) | 高 | node:20 alpine 有 busybox nc;node:20 debian-slim 默认无 nc → 需要先 `apt-get install -y netcat-openbsd`。Phase 7 cdscli 加自动 install 前缀 |
| EF Core 项目无 dotnet-tools.json manifest → `dotnet tool restore` 失败 | 高(对 .NET 项目) | Phase 7 cdscli verify 提示用户加 manifest |

---

## 5. 失败时的回填流程

如果 Step 1-7 任一步暴露 cdscli bug:

1. 把现象 + 期望 vs 实际 加到 `doc/plan.cds-backlog-matrix.md` 的 UF 系列(用户可见故障)
2. 在 `doc/plan.cds-status.md` §三 加一行 friction 状态(F-N)
3. 拆分:每个 bug 对应一个独立 commit / 分支
4. 不阻塞:即使首次实战 fail,机制不会被推翻,只是补丁

---

## 6. 接力 AI 启动模板

下一个 Agent 接 Phase 6 时,从这里复制粘贴对话:

```
用户:把 https://github.com/<选定的 repo> 接入 CDS

Agent 自动跑:
  1. clone 到 /tmp/phase6-test
  2. cdscli scan + verify
  3. cdscli scan --apply-to-cds <projectId>(等用户在 Dashboard 批准)
  4. 部署完后跑分层冒烟 L1+L2+L3
  5. 切 per-branch 验证多分支隔离
  6. 写 doc/report.cds-phase6-validation.md

如果任何步失败,先记录,再回头修(不阻塞继续往后跑能跑的步骤)。
```

---

## 7. 关联文档

- `doc/plan.cds-status.md` — CDS 当前状态看板(mysql 接入完整里程碑 + friction 状态)
- `doc/spec.cds-compose-contract.md` — yaml 字段契约 SSOT
- `doc/guide.cds-orm-support.md` — Phase 4 ORM 支持矩阵
- `doc/guide.cds-multi-branch-db.md` — Phase 5 多分支 DB 策略
- `cds/tests/integration/phase6-yaml-contract.smoke.test.ts` — 契约测试(Phase 1-5 输出 ↔ CDS parser 兼容)
