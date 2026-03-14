# 基础设施初始化指南

> 被 SKILL.md Phase 7-8 引用。Docker 容器初始化命令模板和健康检查。

## 询问用户（Phase 7）

配置输出后，**必须**用 AskUserQuestion 询问：

**选项**：
1. **只生成初始化命令，我自己执行**（安全默认选项）
2. **帮我初始化全部基础设施** — 检查 Docker 环境后自动执行
3. **不需要，我已有现成的数据库** — 跳过

## 初始化命令模板

```bash
# 前置：创建 Docker 网络
docker network create cds-network 2>/dev/null || true

# MongoDB
docker run -d \
  --name cds-mongodb \
  --restart unless-stopped \
  --network cds-network \
  -p 27017:27017 \
  -v cds-mongodb-data:/data/db \
  -e MONGO_INITDB_ROOT_USERNAME=root \
  -e MONGO_INITDB_ROOT_PASSWORD=TODO_请替换密码 \
  mongo:7

# Redis
docker run -d \
  --name cds-redis \
  --restart unless-stopped \
  --network cds-network \
  -p 6379:6379 \
  -v cds-redis-data:/data \
  redis:7 redis-server --appendonly yes
```

## 执行前环境检查

```bash
docker info > /dev/null 2>&1
```

Docker 不可用时：输出错误信息，回退到"只生成命令"模式。

## 健康检查

```bash
# MongoDB
docker exec cds-mongodb mongosh --eval "db.adminCommand('ping')" 2>/dev/null \
  && echo "✅ MongoDB OK" || echo "❌ MongoDB 未就绪"

# Redis
docker exec cds-redis redis-cli ping 2>/dev/null \
  && echo "✅ Redis OK" || echo "❌ Redis 未就绪"
```

## 失败处理

1. 输出错误信息，诊断原因（端口占用、权限不足等）
2. 提供修复建议
3. 提示可重试：已成功的服务不受影响
