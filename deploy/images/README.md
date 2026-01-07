# 本地 Docker 镜像缓存（可选）

本目录用于**弱网/离线**场景：你可以提前把常用基础镜像导出成 `*.tar` 放到这里，`local_exec_dep.sh --load-tars` 会在 `docker compose` 前自动执行 `docker load`，减少现场拉取镜像的等待时间。

## 示例

导出（一次性）：

```bash
docker pull mongo:8.0 redis:7-alpine nginx:1.27-alpine
docker save -o deploy/images/mongo-8.0.tar mongo:8.0
docker save -o deploy/images/redis-7-alpine.tar redis:7-alpine
docker save -o deploy/images/nginx-1.27-alpine.tar nginx:1.27-alpine
```

使用（之后每次）：

```bash
./local_exec_dep.sh --load-tars up
```

## 注意

- 请不要把任何密钥写进镜像或仓库文件；密钥应通过环境变量/Secrets 注入。
- `*.tar` 体积可能很大，通常不建议提交到 git（可放到本机或内网共享盘）。

