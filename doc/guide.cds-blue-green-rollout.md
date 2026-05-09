# CDS 蓝绿部署上线运维手册

> **版本**:v1.0 | **日期**:2026-05-08 | **状态**:代码就绪,等运维启用
>
> 把已落地的蓝绿改造从 dormant(默认未启用)切换到 active(真正切流量)。需要 SSH 到 CDS 主机,操作约 5 分钟。失败可一行回退。
>
> 关联:`doc/design.cds-control-data-split.md`、`doc/spec.cds-blue-green-mece-acceptance.md`

---

## 当前状态

代码已部署到 `cds.miduo.org`(HEAD `0299eddc` 之后),包含全部组件:
- standby controller / cds-internal 路由
- nginx-upstream-writer
- graceful-shutdown(已接入 SIGTERM,**SSE drain 已自动生效**)
- forwarder 4 模块(service 层就绪,未 listen 端口)
- blue-green-supervisor
- self-update / force-sync 路由蓝绿分支(`CDS_ENABLE_BLUE_GREEN=1` 时激活)
- 网络拓扑 API + Build SHA chip

**默认行为与改造前完全一致**,1484 测试全绿。

---

## 启用步骤(按顺序执行)

### Step 1:确认环境前提

```bash
# 在 CDS 主机
sudo systemctl status cds-master         # 必须 active
ss -tnlp | grep 9900                      # 必须只有 1 个 daemon 在 9900
ss -tnlp | grep 9901                      # 必须空闲(蓝绿用绿端口)
docker ps | grep cds_nginx                # nginx 容器必须 running
```

任一不满足 → 先排障,不要进 Step 2。

### Step 2:准备 nginx active upstream 文件

```bash
# 拆出独立的 active upstream conf,主 nginx.conf 用 include 引用
cd /opt/prd_agent/cds

# 写初始 active upstream(指向当前蓝端口)
cat > nginx/cds-active-upstream.conf <<'EOF'
upstream cds_admin { server 127.0.0.1:9900; keepalive 8; }
EOF

# 重新渲染主 nginx.conf,改用 include
./exec_cds.sh nginx-render

# 校验 + 让 nginx 加载新 conf
docker exec cds_nginx nginx -t && \
docker exec cds_nginx nginx -s reload
```

如果第一次没有 cds-active-upstream.conf,主 nginx.conf 模板里仍写死 `127.0.0.1:9900`,蓝绿切换时 supervisor 调用 nginx-upstream-writer 会**写文件 + reload**,但前提是文件路径在白名单内。

### Step 3:重启 cds-master(让 daemon 创建 .cds/internal-token + 加载新代码)

```bash
sudo systemctl restart cds-master
```

等 ~10 秒 daemon 起来。**注意**:2026-05-08 起蓝绿默认开启,**无需** `CDS_ENABLE_BLUE_GREEN=1` 环境变量。如需紧急回退老路径,设 `CDS_DISABLE_BLUE_GREEN=1`。

daemon 启动时会自动:
- 生成 `.cds/internal-token`(0600 权限,256-bit 随机 secret)
- 实例化 supervisor + gracefulShutdown
- 跑 reconcileResidualDaemon 清理可能的残留 daemon

### Step 5:验证启用成功

```bash
# 查看 supervisor 是否实例化(应有相关日志)
journalctl -u cds-master -n 50 | grep -iE "blue-green|supervisor|standby"
# 期望看到 "blue-green bootstrap" 之类的启动日志

# 查看初始 active-color 文件
cat /opt/prd_agent/cds/.cds/active-color
# 期望:blue
```

### Step 6:首次蓝绿切换(端到端验证)

```bash
# 触发 self-update,期望走蓝绿路径
curl -sSk -X POST https://cds.miduo.org/api/self-force-sync \
  -H "X-AI-Access-Key: <YOUR_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"force":true}' \
  | grep -E "event: done|step.*blue-green|stage"
```

期望 SSE 流包含:
- `step: spawn-green`
- `step: wait-healthz`
- `step: nginx-write` / `nginx-reload`
- `step: promote-green`
- `step: shutdown-blue`
- `event: done` 含 `mode: blue-green`

切完 `cat /opt/prd_agent/cds/.cds/active-color` 应该显示 `green`。

---

## 失败回退

### 1 行紧急回退

```bash
echo "CDS_DISABLE_BLUE_GREEN=1" | sudo tee -a /etc/cds/env
sudo systemctl restart cds-master
```

`CDS_DISABLE_BLUE_GREEN` 优先级高于 `ENABLE`,bootstrap 不创建 supervisor,self-update 走老 process.exit 路径。

### 自动熔断

蓝绿连续 3 次切换失败 → supervisor 自动写 `.cds/blue-green-disabled`,后续 self-update 自动走老路径。运维确认问题后删除该文件即可恢复:

```bash
rm /opt/prd_agent/cds/.cds/blue-green-disabled
```

---

## 验收清单(用户跑这个就算上线成功)

| ID | 用例 | 跑法 |
|---|---|---|
| C-1.6 | 蓝绿切换成功:active-color 从 blue→green | Step 6 后查文件 |
| C-3.1 | 用户感知"切换"≤ 1 秒 | 在 cds-settings 维护页点强制更新,看 banner |
| C-3.2 | 切换瞬间 *.miduo.org 流量阻塞 ≤ 200ms | 切换时持续 curl 一个分支预览 URL,看是否有 5xx |
| C-6.1 | 不再触发"CDS 重启中"全屏 overlay | 切换时观察右下角 GlobalUpdateBadge |
| C-6.2 | Build SHA chip 显示 active 颜色 + commit 8 位 hash | 任意页面右上角 |
| C-6.6 | self-update 弹窗看到 stage 进度文案 | 维护页运维抽屉里 |
| C-8.1 | DISABLE=1 一行回退 | 紧急回退 1 行 |
| C-8.5 | 连续 3 次失败自动禁用 | 故意 break(改 nginx-active-upstream.conf 写错语法)触发 3 次 |

每条勾上即视为该维度通过。

---

## 已知边界 / 后续工作

1. **forwarder 进程独立 listen 9090** — 当前 service 层就绪但未起独立进程。需要新增 `cds-forwarder.service` systemd unit + `exec_cds.sh forwarder-run` 子命令。这是 B'.7 的内容,独立交付。
2. **mongo change stream 路由表** — forwarder 当前用静态 JSON fallback。change stream 需 mongo replica set,本地 standalone mongo 用不上。
3. **网络拓扑 UI 页面** — API 已就绪(`GET /api/cds-system/network-topology`),前端 React 页面待加(可按 design 文档 4.3 节再做一个 sub-agent)。

---

## 历史背景

2026-05-08 用户反馈"daemon 重启转发也跟着断 17s",触发本轮控制面/数据面分离 + 蓝绿改造。代码 7 阶段完成,1484 测试全绿,基线零退化。
