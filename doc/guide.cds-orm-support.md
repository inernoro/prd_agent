# CDS ORM 支持指南(Phase 4 起)

> **类型**:guide(操作指南) | **版本**:1.0 | **最后更新**:2026-05-01
> **覆盖**:cdscli scan 自动 ORM 探测 + migration 命令注入 + dev/prod 模式
> **目标读者**:用户(接入新项目时) + AI Agent(写 cdscli 模板表时)

---

## 0. 30 秒读懂

CDS 接入任何用 ORM 的项目时,cdscli scan 会自动:

1. **探测**应用源码目录的 ORM 框架(prisma / ef-core / typeorm / sequelize / rails / flyway)
2. **注入** migration 命令到应用 command 启动前缀
3. **生成** `x-cds-deploy-modes` 暴露 dev / prod 切换(dev 加 seed,prod 不加)
4. **不破坏** 用户已写的 wait-for / migrate 命令(幂等检测)

最终 command 形态(prod 默认):
```
<wait-for-db> && <migration> && <用户原 command>
```

dev mode 形态:
```
<wait-for-db> && <migration> && <seed> && <用户原 command>
```

---

## 1. 支持矩阵

| ORM | 探测规则 | migration 命令 | seed 命令 | 边界与已知问题 |
|-----|---------|---------------|----------|---------------|
| **Prisma** | `prisma/schema.prisma` 存在 | `npx prisma migrate deploy` | `npx prisma db seed`(需要 package.json 配 `prisma.seed`) | 仅支持 deploy 模式;`migrate dev` 是开发态、不应在容器内跑 |
| **EF Core** | 任意 `*.csproj` 文件含 `Microsoft.EntityFrameworkCore` | `dotnet tool restore && dotnet ef database update` | (无,EF 不内置) | 项目必须有 `.config/dotnet-tools.json`(`dotnet new tool-manifest && dotnet tool install dotnet-ef`),否则 restore 失败 |
| **TypeORM** | `package.json` 含 `typeorm` 依赖 | `npm run migration:run` | (无) | 应用必须在 package.json scripts 里定义 `migration:run`(对应 `typeorm migration:run`)。如果用 `pnpm` / `yarn` 自行替换 |
| **Sequelize** | `package.json` 含 `sequelize-cli` 依赖 | `npx sequelize-cli db:migrate` | `npx sequelize-cli db:seed:all` | 需要 `.sequelizerc` 或 `config/config.json` 在容器内可读 |
| **Rails** | `Gemfile` 含 `rails` | `bundle exec rails db:migrate` | `bundle exec rails db:seed` | 需要 `bundle install` 已跑(应用 command 应自带);RAILS_ENV 默认 production,改 development 需自行 export |
| **Flyway** | `flyway.conf` 存在 | (不注入) | (无) | flyway 通常作 sidecar 容器单跑,不该塞进应用 command。cdscli 仅识别给提示,不动 command |

---

## 2. 怎么用(用户视角)

### 2.1 新项目接入,自动跑

```bash
cdscli scan /path/to/your/project --apply-to-cds <projectId>
```

cdscli 自动:
- 解析 docker-compose.yml(优先级见 `doc/spec.cds-compose-contract.md`)
- 探测应用 ORM
- 把 migration 注入 backend service 的 command 前缀
- 生成 `x-cds-deploy-modes` 给用户切换

scan 输出的 `signals.orms` 字段会显示:
```json
{
  "orms": {"backend": "prisma"}
}
```

### 2.2 在 CDS UI 切 dev/prod 模式

部署后,在 CDS Dashboard:

```
项目设置 → 构建配置 → 部署模式
  ○ dev  (含 seed 数据库种子)
  ◉ prod (只 migrate,不 seed,不污染数据库) ← 默认
```

切到 dev → 下次 deploy 应用启动时会跑 `seed`。生产部署或验收前切回 prod。

### 2.3 已有 cds-compose.yml 想加 ORM 注入

如果你已经手写了 cds-compose.yml,scan 会直接读它(SSOT),**不会**自动注入 ORM。需要手动在 application service.command 加前缀:

```yaml
services:
  backend:
    command: bash -c "until nc -z mysql 3306; do sleep 1; done && npx prisma migrate deploy && npm run dev"
```

或者删掉 cds-compose.yml,让 cdscli 重新从 docker-compose.yml 生成。

---

## 3. 怎么扩展(给 cdscli 维护者)

新加一种 ORM 支持只需在 `.claude/skills/cds/cli/cdscli.py` 的 `_ORM_TEMPLATES` 数组追加一条:

```python
{
    "kind": "drizzle",                              # 唯一 id
    "label": "Drizzle ORM",                         # 给用户看的名字
    "detect_files": ["drizzle.config.ts"],          # 这些文件全部存在 → 命中
    "detect_extra": [("package.json", "drizzle-orm")],  # package.json 必须含此字符串
    "migrate_cmd": "npx drizzle-kit migrate",       # 注入到 command 前缀
    "seed_cmd": None,                               # 没 seed 就 None
    "doc_url": "https://orm.drizzle.team/",
},
```

测试加在 `.claude/skills/cds/tests/test_orm_phase4.py`(参考已有 5 case)。

`_detect_orm` 按数组顺序匹配,第一个命中即返回。在数组里靠前的优先级高(如 prisma 优先于 typeorm,因为 prisma 项目可能也有 `package.json`)。

---

## 4. 不要做的事(给 AI 接力者)

| ❌ 不要 | 原因 |
|---|---|
| 在生产部署用 `prisma migrate dev` | dev 命令会等待用户输入(交互式),容器里跑会卡死 |
| 假定 EF Core 项目有 `dotnet-ef` global tool | global tool 不跨容器存在,必须 `dotnet tool restore` 先恢复 manifest |
| 把 flyway 命令塞进应用 command | flyway 是独立进程,该单跑 sidecar 容器 |
| 给 Rails 项目硬编码 `RAILS_ENV=production` | 容器内 deploy 阶段也可能要 development env;让用户自行决定 |
| 注入 `npm install` 到 command 前缀 | 应用 command 已经带这个(node 项目惯例),不该重复 |
| 禁用 `_wrap_with_migration` 的幂等检查 | 用户原 command 可能已含自定义 wait/migrate 逻辑,二次包会破坏 |

---

## 5. 与其他 Phase 的关系

```
Phase 1 ✅ env ${VAR} 嵌套展开 — 让 DATABASE_URL 能用模板引用密码
        ↓
Phase 2 ✅ deploy 自动起 infra — 不用手 POST 起 mysql
        ↓
Phase 3 ✅ scan 全字段 carry-over + wait-for — 应用启动前等 mysql 就绪
        ↓
Phase 4 ✅ ORM migration 注入 — 应用启动时 schema 自动建,Table 不再 doesn't exist
        ↓
Phase 5 ⏳ 多分支 DB 策略 — 多个分支用同一个 mysql 时 schema 冲突警告
        ↓
Phase 6 ⏳ 真实开源项目实战
```

Phase 4 是"丝滑接入 schemaful DB"的临门一脚。没有它,Phase 1-3 都白做(应用一启动就 crash on missing tables)。

---

## 6. 历史 / 关联文档

- `doc/spec.cds-compose-contract.md` — cds-compose 完整契约 SSOT
- `doc/plan.cds-mysql-readiness.md` — 6 阶段计划
- `.claude/skills/cds/cli/cdscli.py` — `_ORM_TEMPLATES` / `_detect_orm` / `_wrap_with_migration` 实现位置
- `.claude/skills/cds/tests/test_orm_phase4.py` — ORM 识别测试
