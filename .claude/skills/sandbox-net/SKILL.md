---
name: sandbox-net
description: 在受限沙箱里让无头浏览器打到真实站点取证。当 Playwright/Chromium 报 ERR_CONNECTION_RESET、ERR_CERT_AUTHORITY_INVALID、或 networkidle 一直超时，而 curl 打同一个地址却是 200 时使用；用本地 TCP 隧道 + Node TLS 反代把浏览器接到目标站点，支持注入鉴权头打开需要登录的页面，全程不关闭任何证书校验。也用于判断「浏览器打不通」到底是网络层、信任层还是等待判据的问题。触发词："沙箱网络"、"浏览器连不上"、"ERR_CONNECTION_RESET"、"证书不受信"、"打真站取证"、"sandbox net"、"/sandbox-net"。
---

# 沙箱内浏览器取证通道

> **版本**：v1.0.0 | **触发**：`/sandbox-net`、"浏览器连不上"、"打真站取证"

沙箱里 `curl` 能打通、浏览器打不通，是个反复出现的坑。本技能给出一条固定通道，
让 Playwright 打到**真实站点**取证，而不是退回本地桩。

## 目录

- [为什么需要它](#为什么需要它)
- [三步诊断](#三步诊断)
- [搭通道](#搭通道)
- [取证](#取证)
- [端到端示例](#端到端示例)
- [硬约束](#硬约束)

## 为什么需要它

沙箱的出站 HTTPS 走 agent proxy，TLS 在出口被重新终结。`curl` / Node 读系统信任库，
一切正常；**Chromium 不一样**——它自己读 env 里的 `https_proxy` 去连代理（被 reset），
就算绕过代理，它的信任库 `~/.pki/nssdb` 里也没有那个 CA（`ERR_CERT_AUTHORITY_INVALID`），
而沙箱通常没装 `certutil` 导不进去。

于是很容易滑向两个错误结局：**关掉证书校验**（绝对不行），或者**退回本地桩**
（截图看着漂亮，真实字段名一变就露馅）。本技能给第三条路。

## 三步诊断

先分清是哪一层的问题，别一上来就搭隧道。

```
诊断进度：
- [ ] 1. curl 打同一地址通吗？
- [ ] 2. 浏览器打 example.com 通吗？
- [ ] 3. 报的是 RESET 还是 CERT？
```

```bash
curl -sS -o /dev/null -w 'curl: %{http_code}\n' --max-time 20 https://<目标域名>/<健康检查路径>
curl -sS "$HTTPS_PROXY/__agentproxy/status"   # 代理状态与最近的失败记录
```

| curl | 浏览器 | 结论 | 去哪 |
|---|---|---|---|
| 200 | 连 example.com 都 RESET | 浏览器走了代理被拒 | 本页「搭通道」 |
| 200 | 只报 CERT_AUTHORITY_INVALID | 只差信任 | 优先方案 B（下面） |
| 403/407 | — | 出口策略拒绝这个域名 | **不要绕，报给用户** |
| 超时 | — | 目标站点自己的问题 | 不是本技能的范围 |

其余症状（`networkidle` 超时、窄屏假象、主题冻结）见
[reference/failure-catalog.md](reference/failure-catalog.md)。

## 搭通道

两跳。第一跳固定，第二跳二选一。

**第一跳（必需）** —— TCP 隧道，把 CONNECT 交给 Node 去做：

```bash
cd .claude/skills/sandbox-net/scripts
(setsid node tunnel.mjs --target <域名>:443 --listen 7799 > /tmp/tunnel.log 2>&1 &)
sleep 1 && curl -s -o /dev/null -w 'tunnel: %{http_code}\n' \
  --resolve <域名>:7799:127.0.0.1 --noproxy '*' https://<域名>:7799/<健康检查路径>
```

**第二跳** —— 按是否需要真实 origin 选：

| | 方案 A：host 映射 | 方案 B：HTTP 反代（默认） |
|---|---|---|
| 浏览器看到的 origin | `https://<真实域名>`（cookie、CORS、secure context 全对） | `http://127.0.0.1:<端口>` |
| 谁做 TLS | 浏览器自己 | Node（读系统信任库） |
| 前提 | CA 必须在 NSS 里，要 `certutil` | 无前提 |
| 怎么起 | 浏览器加 `--host-resolver-rules=MAP <域名> 127.0.0.1:7799` | `node relay.mjs --host <域名>` |

**默认走 B**：没有前提、不碰任何信任配置。只有当页面依赖真实 origin（跨站 cookie、
`window.isSecureContext`、OAuth 回跳）时才值得为 A 去导 CA。

```bash
# 方案 B，需要登录的站点顺手注入凭据（值从环境变量取，不落命令行历史）
(setsid node relay.mjs --host <域名> --listen 7801 \
   --header 'X-AI-Access-Key: $AI_ACCESS_KEY' > /tmp/relay.log 2>&1 &)
sleep 2 && curl -s --noproxy '*' -o /dev/null -w 'relay: %{http_code}\n' http://127.0.0.1:7801/<健康检查路径>
```

两跳都起来后 `pgrep -af 'tunnel.mjs|relay.mjs'` 确认还活着——被 harness 回收是常事，
所以上面用 `setsid`（见 failure-catalog 第二节）。

## 取证

```bash
PLAYWRIGHT_MODULE=<某个>/node_modules/playwright/index.mjs \
node shoot.mjs --url http://127.0.0.1:7801/<页面路径> --out /tmp/shots \
  --themes dark,light --viewports 1440x900,390x844
```

`shoot.mjs` 每屏输出三项机器判据 + 截图：**横向滚动 / 越出父级的元素 / 控制台报错与 4xx 接口**。
三项干净不等于页面对——它只排除了「明显坏了」，内容对不对仍然要人眼看截图。

## 端到端示例

给一个需要登录的站点 `cds.miduo.org` 的 `/release-console` 取双主题证据：

```bash
cd .claude/skills/sandbox-net/scripts

# 1. 诊断：curl 通、浏览器不通
curl -sS -o /dev/null -w 'curl: %{http_code}\n' https://cds.miduo.org/healthz
# curl: 200

# 2. 两跳
(setsid node tunnel.mjs --target cds.miduo.org:443 > /tmp/tunnel.log 2>&1 &)
sleep 1
(setsid node relay.mjs --host cds.miduo.org --header 'X-AI-Access-Key: $AI_ACCESS_KEY' > /tmp/relay.log 2>&1 &)
sleep 2
curl -s --noproxy '*' -o /dev/null -w 'relay: %{http_code}\n' http://127.0.0.1:7801/healthz
# relay: 200

# 3. 取证
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
node shoot.mjs --url 'http://127.0.0.1:7801/release-console?project=prd-agent' \
  --out /tmp/shots --themes dark,light --viewports 1440x900,390x844
```

实际输出（节选）：

```
[有发现] 1440x900-dark  {"overflowX":false,"escaped":[],"errors":[
  "console: Failed to load resource: net::ERR_CERT_AUTHORITY_INVALID",
  "403 /api/cds-system/operator/requests"]}
[有发现] 390x844-light  {"overflowX":false,"scrollW":390,"innerW":390,
  "escaped":["NAV.cds-mobile-drawer-panel"],"errors":[...同上]}
```

三条都是**已知噪音**，但每条都得当场认领，不能默认无害：

| 报的 | 是什么 | 判据 |
|---|---|---|
| `ERR_CERT_AUTHORITY_INVALID` | Cloudflare 注入的 `static.cloudflareinsights.com/beacon.min.js`——绝对外链绕开了隧道 | 第三方域名忽略；**自己应用的绝对 URL 失败就是真 bug**（域名写死了） |
| `403 /api/cds-system/...` | 外壳侧栏在拉审批入口，key 作用域不够 | 路径不属于被测功能 → 噪音 |
| `NAV.cds-mobile-drawer-panel` 越界 | 抽屉用 `translateX(-100%)` 藏在屏外 | 看截图确认它是关着的 |

三类的详细判据见 [reference/failure-catalog.md](reference/failure-catalog.md) 第五节。

这次取证当场抓到三个本地桩看不出来的问题：分支下拉整列空白（真实字段是 `branch` 不是 `name`）、
默认环境落到已停用的目标、两段文案粘连。**这就是不停在桩上的理由。**

## 硬约束

1. **不许关证书校验。** 禁止 `--ignore-certificate-errors`、`ignoreHTTPSErrors: true`、
   `NODE_TLS_REJECT_UNAUTHORIZED=0`。方案 B 让 Node 做 TLS 已经绕开了这个诱惑；
   真要走方案 A 就正经把 CA 导进 NSS。
2. **不许 unset `HTTPS_PROXY`。** 本技能靠 `--no-proxy-server` 只在浏览器进程内绕开代理，
   Node 侧仍然走它。
3. **403 / 407 不要绕。** 那是组织出口策略，照实报被挡的域名。
4. **凭据只走环境变量。** `--header 'K: $VAR'` 由脚本展开；不要把密钥写进命令行、
   脚本字面量或日志。脚本只打印被注入的 header 名，不打印值。
5. **收工清理。** `pkill -f tunnel.mjs; pkill -f relay.mjs`（单独一行跑，没匹配时返回非零）。
   别把一条开着的隧道留给下一个会话。

## 与其他规则的关系

- `CLAUDE.md §8.1`（自测优先）：本技能是「Playwright 直连预览域名」那条路径在沙箱里的可执行版本。
- `real-visual-acceptance.md` / `closed-loop-acceptance.md`：拿到真页面之后，
  截图 caption 必须与图里内容一致，产物没出来就不算验收通过。
- `cds-first-verification.md`：本地缺能力不是不验证的理由——先穷尽通道再说做不到。
