# 部署边界

Gateway 的集成部署 SSOT 仍位于仓库根目录：

- `docker-compose.yml`：生产容器拓扑。
- `docker-compose.dev.yml`：本地开发拓扑。
- `cds-compose.yml`：CDS 源码与预构建模式。
- `.github/workflows/branch-image.yml`：三个 Gateway 镜像的构建入口。

源码上下文分别为 `llmgw/console-api`、`llmgw/web` 和仓库根目录下的 `llmgw/serving/Dockerfile`。镜像名、服务名、端口和公开 URL 保持不变。
