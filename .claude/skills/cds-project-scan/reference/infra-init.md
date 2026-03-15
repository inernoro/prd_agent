# 基础设施初始化指南

> 被 SKILL.md Phase 7 引用。CDS 自动管理基础设施容器，此处仅处理非 CDS 场景的回退。

## CDS 环境（默认路径）

CDS Dashboard 导入 compose YAML 后**自动创建和管理基础设施容器**，无需手动初始化。

配置输出后提示用户：

```
使用说明：
1. cd cds && ./exec_cds.sh --background
2. 打开 CDS Dashboard → http://<服务器IP>:9900
3. 设置 → 一键导入 → 粘贴上方 YAML → 确认应用
4. CDS 会自动拉起 MongoDB、Redis 等基础设施
```

**不需要** Phase 7 的 AskUserQuestion，除非用户明确表示不使用 CDS。

## 非 CDS 场景（回退）

仅当用户明确表示**不通过 CDS 管理**时，才提供手动初始化选项。

用 AskUserQuestion 询问：

**选项**：
1. **只生成初始化命令，我自己执行**（安全默认选项）
2. **帮我初始化全部基础设施** — 检查 Docker 环境后自动执行
3. **不需要，我已有现成的数据库** — 跳过

### 手动初始化命令模板

```bash
# MongoDB — CDS 跑在宿主机，容器通过 -p 暴露端口即可
docker run -d \
  --name cds-mongodb \
  --restart unless-stopped \
  -p 27017:27017 \
  -v cds-mongodb-data:/data/db \
  mongo:7

# Redis
docker run -d \
  --name cds-redis \
  --restart unless-stopped \
  -p 6379:6379 \
  -v cds-redis-data:/data \
  redis:7-alpine redis-server --appendonly yes
```

> **注意**：不使用 `--network`。CDS 运行在宿主机上，通过 `localhost:<port>` 连接容器。
> 容器间互通（如未来容器化 CDS）可后续按需加 network，当前不需要。

### 执行前环境检查

```bash
docker info > /dev/null 2>&1
```

Docker 不可用时：输出错误信息，回退到"只生成命令"模式。

### 健康检查

```bash
# MongoDB
docker exec cds-mongodb mongosh --eval "db.adminCommand('ping')" 2>/dev/null \
  && echo "✅ MongoDB OK" || echo "❌ MongoDB 未就绪"

# Redis
docker exec cds-redis redis-cli ping 2>/dev/null \
  && echo "✅ Redis OK" || echo "❌ Redis 未就绪"
```

### 失败处理

1. 输出错误信息，诊断原因（端口占用、权限不足等）
2. 提供修复建议
3. 提示可重试：已成功的服务不受影响
