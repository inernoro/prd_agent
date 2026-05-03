# cds-mysql-demo

> 验证 CDS "mysql 项目 4 步内跑通"用户契约的最小演示仓库。

## 用户契约(本仓库要回答的核心问题)

> 第三步 弹模态窗开始初始化加载运行, 开始自动创建基础依赖
> (如果是 mysql 等数据库, 要求用户放置初始化数据库的代码,
> 用户这里会多一步, 数据库记得帮用户选好,
> 可以在 scan 技能里面了解清楚用户的数据库名字, 你需要检查到位,
> 不要给用户创建莫名其妙的数据库名字)

## 4 步预期流程

| 步 | 用户动作 | CDS 行为 |
|---|---|---|
| 1 | `POST /api/projects { gitRepoUrl }` 指向本仓库 | 建项目记录 |
| 2 | `POST /api/projects/:id/clone` SSE 流 | clone + 解析 cds-compose.yml + envMeta |
| 3 | envMeta 三色弹窗 → 用户填 `MYSQL_ROOT_PASSWORD` / `MYSQL_PASSWORD` | required 块阻止 deploy 直到填齐 |
| 4 | 建 main 分支 + deploy | mysql 启 → init.sql 执行 → app 启 → 预览 200 |

## 关键设计点

- **数据库名 = `app_db`**(真实业务名,不是 CDS 默认占位 `cds_db`/`app`)
- **init.sql** 与 cds-compose 一起由 git 提供,挂到 mysql 官方 `/docker-entrypoint-initdb.d/`
- **envMeta** 显式声明 root 密码 + app 密码为 `kind: required`,deploy 前 block
- **app 服务** 用 `build: ./app` 走 CDS app service 路径(readiness 探活 + 预览路由)
- **mysql 服务** 用挂 `init.sql` + `mysql:8` image,CDS compose-parser 应识别为 schemaful infra

## 仓库结构

```
cds-mysql-demo/
├── cds-compose.yml      # CDS 入口
├── init.sql             # 数据库 schema + 种子数据
├── app/
│   ├── package.json     # express + mysql2
│   ├── server.js        # GET / 返回 users 表
│   └── Dockerfile       # node:20-slim
└── README.md            # 本文件
```

## 验收手段

CDS 部署成功后访问预览域名 `/`:

```json
{
  "ok": true,
  "database": "app_db",
  "count": 3,
  "users": [
    {"id":1,"username":"alice","email":"alice@cds.demo","created_at":"..."},
    {"id":2,"username":"bob","email":"bob@cds.demo","created_at":"..."},
    {"id":3,"username":"charlie","email":"charlie@cds.demo","created_at":"..."}
  ]
}
```

3 行种子数据出来即证明 init.sql 被 mysql 容器执行 + app 容器连上 mysql 成功。
