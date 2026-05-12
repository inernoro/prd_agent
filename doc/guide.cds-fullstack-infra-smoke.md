# CDS 全栈基础设施冒烟样例指南

## 目的

本指南用于验证 CDS 一键部署和沙盒导入对“前端 + 后端 + MySQL + Redis + RabbitMQ”项目的适配度。

样例目录：

`cds/examples/fullstack-infra-smoke`

## 样例结构

| 路径 | 作用 |
|------|------|
| `cds-compose.yml` | 定义前端、后端、MySQL、Redis、RabbitMQ |
| `frontend/` | Vite 页面，请求 `/api/health` |
| `backend/` | Express API，检查三类基础设施连接 |
| `init.sql` | MySQL 初始化表和种子数据 |

## 预期 CDS 解析结果

| 类型 | ID | 预期 |
|------|----|------|
| BuildProfile | `frontend` | 入口 `/`，端口 `4173` |
| BuildProfile | `backend` | 入口 `/api/`，端口 `3000` |
| InfraService | `mysql` | 端口 `3306`，持久化 `/var/lib/mysql` |
| InfraService | `redis` | 端口 `6379`，持久化 `/data` |
| InfraService | `rabbitmq` | 端口 `5672`，持久化 `/var/lib/rabbitmq` |
| Env | `MYSQL_URL` | 后端 MySQL 连接串 |
| Env | `REDIS_URL` | 后端 Redis 连接串 |
| Env | `RABBITMQ_URL` | 后端 RabbitMQ 连接串 |

## 页面验收步骤

1. 打开 CDS 项目列表。
2. 点击“一键部署”。
3. 验证“一键部署项目”里能同时看到“前端服务”和“后端服务”。
4. 验证“选择基础设施”里能看到 MySQL、Redis、RabbitMQ。
5. 关闭弹窗，打开“从 YAML 沙盒新建”。
6. 填写项目名称，例如 `fullstack-infra-smoke`。
7. 粘贴样例 `cds-compose.yml`。
8. 添加额外文件：
   - `init.sql`
   - `frontend/package.json`
   - `frontend/index.html`
   - `frontend/src/main.js`
   - `backend/package.json`
   - `backend/src/server.js`
9. 创建项目。
10. 打开项目分支页。
11. 验证拓扑中出现前端、后端、MySQL、Redis、RabbitMQ。
12. 点击部署。
13. 打开预览页。
14. 页面应显示 MySQL、Redis、RabbitMQ 三项均为“通过”。

## 接口验收步骤

如果需要绕过页面快速验证，可用 `POST /api/projects` 创建沙盒项目：

```http
POST /api/projects
Content-Type: application/json

{
  "name": "fullstack-infra-smoke",
  "composeYaml": "...cds-compose.yml 内容...",
  "projectFiles": [
    { "relativePath": "init.sql", "content": "..." },
    { "relativePath": "frontend/package.json", "content": "..." },
    { "relativePath": "frontend/index.html", "content": "..." },
    { "relativePath": "frontend/src/main.js", "content": "..." },
    { "relativePath": "backend/package.json", "content": "..." },
    { "relativePath": "backend/src/server.js", "content": "..." }
  ]
}
```

成功后应返回 `sandbox: true`，并且项目 `cloneStatus` 为 `ready`。

## 当前适配结论

| 检查项 | 结论 |
|--------|------|
| 前端 + 后端同时建模 | 已支持 |
| MySQL + Redis + RabbitMQ 预设 | 已支持 |
| YAML 沙盒导入 | 已支持样例输入 |
| Compose 解析 | 已有自动测试覆盖 |
| 页面完整部署 | 仍需真人或 Bridge 在目标环境中执行一次真实容器启动 |
