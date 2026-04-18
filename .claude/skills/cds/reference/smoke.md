# 分层冒烟测试策略

## 原则

**直连预览域名优先**，仅当 Cloudflare / CDN 干扰时才走 `container-exec`（嵌套 JSON 难维护）。

## 三层模型

| 层 | 何时通过才进下一层 | 目的 |
|----|---------------------|------|
| **L1** 根路径 | HTTP 200 | 前端静态资源可访问，CDS 代理正常 |
| **L2** 无认证 API | HTTP 200 | 后端进程活着，路由注册完成 |
| **L3** 认证 API | HTTP 200 + 数据正确 | `AI_ACCESS_KEY` / impersonate 链路正常 |

CLI 封装：`cdscli smoke <branchId>` 一次性跑完三层。

## 预览域名推断

```
branchId = branch.replace(/\//g, '-').toLowerCase()
preview  = https://<branchId>.miduo.org     // 若 CDS_HOST 含 "miduo"
         | https://<branchId>.<CDS_HOST>    // 其它
```

## L1 — 根路径

```bash
curl -sf "https://$BRANCH_ID.miduo.org/" -o /dev/null -w "code=%{http_code}\n"
# 期望: code=200
```

失败 → 代理层或容器未就绪 → `cdscli branch status <id>`。

## L2 — 无认证 API（按栈挑路径）

| 栈 | 常用路径 |
|----|----------|
| .NET | `/api/shortcuts/version-check`, `/healthz` |
| Node Express | `/api/health`, `/health` |
| 通用 | `/robots.txt`（静态兜底）|

```bash
curl -sf "https://$BRANCH_ID.miduo.org/api/shortcuts/version-check"
# 期望: {"version":N,...}
```

## L3 — 认证 API

```bash
curl -sf "https://$BRANCH_ID.miduo.org/api/users?pageSize=1" \
  -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  -H "X-AI-Impersonate: $MAP_AI_USER"
```

失败 → 按 [auth.md](auth.md) 的 401 决策树排查。

## 代码部署验证（L2.5）

当你需要"确认某个具体文件/类在容器里真的是新代码"时，用 `container-exec` grep：

```bash
cdscli branch exec <id> --profile api 'grep -c MyNewFunction /app/src/foo.cs'
# 期望: 数字 > 0
```

这是 `container-exec` 唯一推荐的用法——不要塞 curl 到 container-exec 里（嵌套转义很脏）。

## CDN 干扰兜底

Cloudflare 偶发把 401 响应重写成空 body HTTP 500。判定方法：
1. 直连预览域名：`curl` 明显返回 500 且 body 为空
2. container-exec 在容器里本地跑：`curl localhost:5000/api/xxx`
3. 两者对比，如果本地正常远程 500 → Cloudflare 干扰

## 反面案例

| ❌ 做法 | 问题 | ✅ 替代 |
|---------|------|---------|
| Layer 1 就用 container-exec | 嵌套转义复杂，CDN 问题暴露不出 | 直连 `curl preview/` |
| 不带 `X-AI-Impersonate` 调认证 API | 空 JWT → 401 | 读 `$MAP_AI_USER` 或先 `/api/users` 发现用户名 |
| 失败后一路 retry | 掩盖真实问题 | 第一次失败就抓 logs 根因分析 |
| 用 `admin` / `root` 作为 impersonate | 数据库无此用户 → 401 | 真实用户名，禁止猜 |
