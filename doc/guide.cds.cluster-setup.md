# CDS 集群扩容 · 指南

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：已落地

本指南用于把一台已初始化的 CDS 节点加入现有 scheduler，成为 executor。Bootstrap token 有时效且只能用于建立受控连接。

## 1. 前置检查

- 主节点和新节点的 CDS 版本兼容。
- 新节点已完成 `init`，Docker、磁盘和端口正常。
- 新节点能通过 HTTPS 访问主节点健康接口。
- 主节点的公网域名和证书有效。
- 操作者有两台机器的管理权限。

## 2. 加入集群

在主节点生成一次性 token，再在新节点执行输出的连接命令：

```bash
# 主节点
./exec_cds.sh issue-token

# 新节点，使用主节点输出的实际地址和 token
./exec_cds.sh connect https://cds.example.com <bootstrap-token>
```

不要在文档、工单或聊天中长期保存 token。过期或已消费 token 应重新生成。

## 3. 验证

在任一有权限节点执行：

```bash
./exec_cds.sh cluster
./exec_cds.sh status
```

通过标准：

- 主节点显示新 executor 在线。
- 心跳持续更新，容量与资源数据合理。
- 调度到新节点的测试分支能够构建并进入就绪。
- 预览流量能到达被调度的服务。
- 新节点离线时主节点能识别而非继续分配任务。

## 4. 断开

在 executor 上执行 `./exec_cds.sh disconnect`。断开前先迁移或停止该节点承载的工作负载，并确认没有仍需保留的本地缓存和数据。

## 5. 常见故障

| 现象 | 检查顺序 |
|---|---|
| 主节点不可达 | DNS、证书、健康接口、防火墙 |
| token 无效 | 时效、是否已消费、主节点时间 |
| 节点已连接但离线 | executor 日志、心跳地址、永久 token |
| 容量不更新 | 节点资源采集、主节点接收日志 |
| 分支无法调度 | 标签、容量、Docker 和项目约束 |

诊断只使用 `status`、`logs`、`cluster` 和健康接口；具体参数以脚本帮助为准。

## 6. 安全与回滚

- Bootstrap token 与永久 executor token 分离。
- 怀疑泄漏时轮换集群 token，并让 executor 重新连接。
- 不通过关闭 TLS 校验绕过证书问题。
- 扩容失败可在新节点执行 `disconnect`，恢复 standalone 配置后重新启动。
- 删除节点前保留调度、迁移和断开记录。
