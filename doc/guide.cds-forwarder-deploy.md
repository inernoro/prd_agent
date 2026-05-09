# CDS Forwarder 部署 / 迁移 / 卸载 Runbook

> 一页操作指南,覆盖 forwarder(数据面)在新服务器装机、迁移、卸载的全部步骤。
> 不需要看代码,照着跑即可。

---

## 一、forwarder 解决什么 + 与 master 的关系

| 进程 | 端口 | 角色 | 重启频率 |
|---|---|---|---|
| `cds-master.service` | 9900(admin)+ 5500(legacy worker proxy) | REST/UI/调度/Worker/SSE | 每次 self-update |
| `cds-forwarder.service` | 9090 | 业务面反代(读 master 写出的 .cds/forwarder-routes.json) | 几乎不动 |

**核心承诺**:nginx 顶层把 `*.miduo.org` 路由到 forwarder:9090,master 重启时 forwarder 不动 → **业务流量永不抖**。
admin face(`cds.miduo.org`)走 master 9900,master 重启时它会短暂中断(几秒),业务流量无感。

---

## 二、新服务器一键装机(全部持久化改动列出来了,可放心)

```bash
# 0. 前置:已经装好 master(./exec_cds.sh install-systemd)。如果 master 没装先装。

cd /path/to/prd_agent/cds

# 1. 装 forwarder(sudo 必须,会动 /etc/systemd/system 与 /etc/cds/env)
sudo ./exec_cds.sh install-forwarder

# 2. 启动 forwarder
sudo systemctl start cds-forwarder

# 3. 重启 master(让它读到 CDS_USE_FORWARDER=1 → 启动 publisher 写 routes JSON)
sudo systemctl restart cds-master

# 4. nginx upstream 切到 forwarder 9090
sudo CDS_USE_FORWARDER=1 ./exec_cds.sh nginx-render
sudo docker cp nginx/cds-site.conf cds_nginx:/etc/nginx/conf.d/cds.conf
sudo docker exec cds_nginx nginx -t && sudo docker exec cds_nginx nginx -s reload

# 5. 验证(应看到 routesCount > 0,业务 200)
curl -s http://127.0.0.1:9090/__forwarder/healthz | python3 -m json.tool
curl -sk -o /dev/null -w "HTTP=%{http_code}\n" https://<your-preview-host>/
```

---

## 三、install-forwarder 究竟动了宿主机什么

| 路径 | 内容 | 目的 | 卸载方式 |
|---|---|---|---|
| `/etc/systemd/system/cds-forwarder.service` | 新增 systemd unit(模板复制 + sed 路径替换 + PATH 注入 nvm) | systemd 管理 forwarder 生命周期 | `uninstall-forwarder` 自动删 |
| `/etc/systemd/system/multi-user.target.wants/cds-forwarder.service` | symlink | 开机自启 | `systemctl disable` 自动删(uninstall 已包含) |
| `/etc/cds/env` 加一行 `CDS_USE_FORWARDER=1` | env file | master EnvironmentFile 读到 → 启动 publisher | `uninstall-forwarder` 自动 sed 删除 |

**容器内的改动**(随 cds_nginx 容器走,删容器就没):
- `cds_nginx:/etc/nginx/conf.d/cds.conf` cds_worker upstream 端口 5500 → 9090

**仓库内的改动**(跟仓库走,git checkout 干净):
- `cds/.cds/forwarder-routes.json`(publisher 周期写盘)
- `cds/nginx/cds-site.conf`(nginx-render 输出)
- `cds/dist/forwarder-main.js` + `cds/dist/forwarder/*`(tsc 产物)

---

## 四、卸载(完全回滚到装 forwarder 之前)

```bash
cd /path/to/prd_agent/cds
sudo ./exec_cds.sh uninstall-forwarder
```

这一条命令做了:
1. stop + disable + 删 unit 文件
2. systemd daemon-reload
3. /etc/cds/env 里删 CDS_USE_FORWARDER 行
4. nginx upstream 改回 5500 + reload nginx
5. 业务流量回到 master 5500(等价 forwarder 安装前的状态)

可选清理(无害,但想干净):
```bash
sudo systemctl restart cds-master      # 让 master 停掉 publisher 调度
rm -f cds/.cds/forwarder-routes.json   # 删掉 publisher 留下的 JSON
```

---

## 五、迁移到新服务器

整套迁移步骤 = 卸载老机器 + 装新机器:

```bash
# 老机器
ssh OLD_HOST
cd /path/to/prd_agent/cds
sudo ./exec_cds.sh uninstall-forwarder

# 新机器
ssh NEW_HOST
git clone <repo> /path/to/prd_agent
cd /path/to/prd_agent/cds
./exec_cds.sh init                        # 配 .cds.env
sudo ./exec_cds.sh install-systemd        # 装 master(若未装)
sudo systemctl start cds-master
sudo ./exec_cds.sh install-forwarder      # 装 forwarder
sudo systemctl start cds-forwarder
sudo systemctl restart cds-master
sudo CDS_USE_FORWARDER=1 ./exec_cds.sh nginx-render
sudo docker cp nginx/cds-site.conf cds_nginx:/etc/nginx/conf.d/cds.conf
sudo docker exec cds_nginx nginx -s reload
```

整套 7-9 条命令,3 分钟内完成。

---

## 六、常见问题排查

| 现象 | 原因 | 解决 |
|---|---|---|
| `journalctl -u cds-forwarder` 报 `Failed to set up mount namespacing: /opt/prd_agent` | unit 模板路径占位没替换干净 | `sudo ./exec_cds.sh install-forwarder` 重装(三层 sed 已修) |
| forwarder healthz `routesCount=0` 且日志 `routes JSON not found` | master 没启动 publisher | `cat /etc/cds/env \| grep CDS_USE_FORWARDER` 确认有 + `systemctl restart cds-master` |
| forwarder 起来但所有访问 404 | publisher 选错 profile(老 bug) | git pull 拉到最新,`pnpm run build && systemctl restart cds-forwarder` |
| 切流后业务变 502 | nginx upstream 切 9090 但 forwarder 没 listen | `ss -tnlp \| grep 9090` 看 listener;失败立即回滚:`sudo CDS_USE_FORWARDER=0 ./exec_cds.sh nginx-render && reload` |
| `Start request repeated too quickly` | 60s 内 5 次启动失败进入 lockout | `sudo systemctl reset-failed cds-forwarder && sudo systemctl start cds-forwarder` |

---

## 七、相关文档

- `doc/design.cds-control-data-split.md` — 整体设计(forwarder + admin daemon 拆分)
- `doc/report.cds-forwarder-success.md` — 2026-05-08 收尾报告
- `cds/CLAUDE.md` — CDS 模块约束
