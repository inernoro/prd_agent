# CDS Forwarder 替代蓝绿部署 — 收尾报告

> **状态**:成功收尾 | **日期**:2026-05-08 | **关联**:`doc/guide.cds-blue-green-handoff.md`(失败收尾)、`doc/design.cds-control-data-split.md`(整体设计)
>
> 接手昨日交接的蓝绿改造(27 个 hotfix 仍未跑通 verify-target),用户决策"放弃蓝绿,推 forwarder 替代"。本日工作 7 个 commit,业务面 0 抖动验收通过。

---

## 一、最终验收结果(铁证)

### 切流后 10 次访问 `https://main-prd-agent.miduo.org/`
```
切流后 1-10:全部 HTTP=200
PASS=10  FAIL=0
```

### 终极 — master restart 期间 30 次并发
```
并发 1-30:全部 HTTP=200
总 30  成功 30  错误 0
```

含义:**cds-master 进程死亡 + 重启全过程**(systemd 拉起新进程到就绪 ~10s),业务流量持续 200,**验证业务永不抖这条硬规则正式成立**。

---

## 二、本日 commit 链路(按时序)

| # | commit | 作用 | 验证状态 |
|---|---|---|---|
| 1 | `087303a` | forwarder MVP 初版(独立进程 + publisher + systemd unit + 启动脚本) | tsc 0 错 + 1496 测试全绿 |
| 2 | `3d9baf0` | unit ReadWritePaths /opt/prd_agent → /opt/prd_agent/cds(单 sed 模式生效) | journalctl 错误消失 |
| 3 | `b6b7686` | install-forwarder 注入 Environment=PATH 含 nvm node bin | unit 文件 PATH 包含 nvm |
| 4 | `d8b8c3f` | sudo 下 command -v node 找不到 → 三层探测兜底 | "探测到 node bin: ..." 输出确认 |
| 5 | `1f9ef35` | ProxyHandler Host 改写为 upstream hostname:port(对齐 master) | 1496 测试全绿 |
| 6 | `1a75297` | publisher 复刻 master detectProfileFromRequest path-based profile 路由 | 切流业务 200 全绿 |

去掉过程性的 changelog/不计,**核心代码改动 6 处**。

---

## 三、Bootstrap 4 类教训(给下次 systemd unit 装机参考)

### 教训 1:systemd unit 模板的 sed 必须**双 sed**(具体 + 父路径)

```bash
sed \
  -e "s|/opt/prd_agent/cds|$cds_dir|g" \    # 必须写在前(更具体)
  -e "s|/opt/prd_agent|$repo_root|g" \      # 后(父路径)
  ...
```

漏掉父路径 sed → ReadWritePaths=`/opt/prd_agent` 没替换 → systemd `Failed to set up mount namespacing: /opt/prd_agent: No such file or directory` → status=226/NAMESPACE 拒启,5 次失败进 lockout。

### 教训 2:nvm node 在 sudo 环境下 `command -v` 失败 → 三层探测兜底

```bash
NODE_BIN="$(command -v node 2>/dev/null || true)"
# 兜底 1:已在跑的 master.service 的 PATH(肯定能找到)
[ -z "$NODE_BIN" ] && NODE_BIN="$(env PATH="$(grep ^Environment=PATH= /etc/systemd/.../cds-master.service | sed s/...)" command -v node)"
# 兜底 2:nvm 标准位置
for nvm_root in /root/.nvm/versions/node /home/*/.nvm/versions/node; do ...
```

### 教训 3:抽简化版反代时,master 1171 行里的"看似杂乱细节"全是真生产打磨

漏抄两笔:
- **Host header 改写**(`proxy.ts:912`):透传外部域名 → 容器 vhost 全 404
- **detectProfileFromRequest**(`proxy.ts:861`):前端 / 路径 → admin profile;`/api/*` → api profile

简化版的"first running service"在 spec 测试里看不出问题,真生产暴露失败。

### 教训 4:抽精简版前必须**列差异表逐项标记**

下次抽 master 反代精简版前,必须先 grep 出 master 在 「请求 → upstream」之间做的全部动作:
1. 解析 host → branch slug
2. branch + path → profile (detectProfileFromRequest)
3. profile → upstream port
4. 改写 Host header
5. 累积 X-Forwarded-* 头
6. forward + 透传 response
7. WebSocket Upgrade
8. SSE 不缓冲
9. 客户端断开 → 释放 upstream

逐项标"必抄/可选/废弃"。**默认全抄**,标"可选/废弃"才省。否则一定漏。

---

## 四、架构现状(2026-05-08 收工)

### 进程拓扑
```
nginx:80/443
  ├─ cds.miduo.org → cds_master:9900 (admin REST/UI/SSE)
  ├─ *.miduo.org    → cds_worker:9090 (forwarder 进程,业务面)
  │
cds-master.service (systemd, Restart=always)
  ├─ 9900 (admin face)
  ├─ 5500 (legacy worker proxy,defense in depth fallback)
  └─ ForwarderRoutePublisher 周期 2s 写 .cds/forwarder-routes.json
       └─ 复刻 detectProfileFromRequest:多 profile 分支生成 /api/* + 默认双路由

cds-forwarder.service (systemd, Restart=always)
  ├─ 9090 (业务面反代)
  ├─ fs.watch .cds/forwarder-routes.json,debounce 200ms 增量加载
  └─ 复用 cds/src/forwarder/{proxy-handler,route-resolver,types}
```

### 蓝绿代码状态
- **保留但默认禁用**:`createBlueGreenBootstrap` 默认 `enabled: false`
- **opt-in 开启**:`CDS_USE_BLUE_GREEN=1` 环境变量
- **路径**:self-update 走老的 process.exit + systemd 重启;forwarder 让业务流量在重启期间 0 抖动

---

## 五、已知局限 & 后续 TODO

| 项 | 状态 | 说明 |
|---|---|---|
| publisher 周期 2s | 现状 | 分支变化最多延迟 2s。改用 mongo change stream 可降到 ms 级(B'.7) |
| forwarder 重启期间业务 ~3s 中断 | 现状 | systemd Restart=always 拉起约 2-3s。forwarder 自身蓝绿(B'.0)是后续可选优化 |
| nginx upstream 单 server | 现状 | cds_worker 只指 9090,forwarder 死了走 nginx 502 fallback page。可加 `server 127.0.0.1:5500 backup;` 让 master 5500 兜底 |
| 网络拓扑 React 页 | 未做 | API 已有(`/api/cds-system/network-topology`),前端待迁移 |
| 灰度权重路由 | 未做 | RouteRecord.weight 字段已支持,publisher 暂未消费 |
| publisher ↔ master detectProfileFromRequest 一致性 | **必须保证** | master proxy.ts 改 detectProfileFromRequest 时,publisher pickDefaultProfile 必须同步;否则切流期间路由不一致 |

---

## 六、给下一位 agent 的建议

1. **不要重启蓝绿** — 27 个 hotfix 的失败教训在 `doc/guide.cds-blue-green-handoff.md`。forwarder 替代方案稳定,业务 0 抖动是它的核心承诺,蓝绿在解决一个错误的问题
2. **改 master proxy.ts 时检查 publisher** — `detectProfileFromRequest` 与 `pickDefaultProfile` 必须保持等价。本仓库已加注释做提醒
3. **加新分支预览测试时观察 forwarder stats** — `GET /__forwarder/stats` 看 host → 命中率,error503Count 异常增长说明路由表与实际容器不一致
4. **nginx 切流前必须验 forwarder healthz routesCount > 0** — 否则用户访问会全部 503。否则就先回滚 cds_worker upstream 到 5500
5. **systemd unit 模板的 sed 替换永远双 sed**:`/opt/prd_agent/cds` 后 `/opt/prd_agent`,顺序绝不能反

---

## 七、相关文档与代码

| 文件 | 作用 |
|---|---|
| `cds/src/forwarder-main.ts` | forwarder 进程入口 |
| `cds/src/services/forwarder-route-publisher.ts` | daemon 写路由表 |
| `cds/src/forwarder/proxy-handler.ts` | 反代核心(Host 改写 + X-Forwarded-* + WebSocket) |
| `cds/src/forwarder/route-resolver.ts` | host + path 长前缀优先匹配 |
| `cds/src/forwarder/route-watcher.ts` | mongo change stream + JSON fallback(本批未启用 mongo) |
| `cds/systemd/cds-forwarder.service` | systemd unit 模板 |
| `cds/exec_cds.sh` 的 `forwarder-run` / `install-forwarder` | 入口脚本 |
| `cds/src/services/blue-green-bootstrap.ts` | 蓝绿(默认禁用,opt-in) |
| `doc/design.cds-control-data-split.md` | 设计文档 |
| `doc/guide.cds-blue-green-handoff.md` | 上一位 agent 的失败收尾交接 |

---

**签收**:今日工作完成,业务面 0 抖动这条硬规则在 forwarder 部署后正式成立。蓝绿改造彻底搁置(代码保留 opt-in),走 forwarder 路线收尾。
