# 沙箱取证失败症状对照表

**一句话**：每条症状给出「怎么确认」和「怎么修」，避免把网络问题误诊成页面问题。
**什么时候撞上**：在受限沙箱里用无头浏览器打真实站点取证时。

---

## 一、网络层：浏览器打不通

### 症状 `ERR_CONNECTION_RESET`，连 example.com 都不通

**确认**：`curl -s -o /dev/null -w '%{http_code}' https://example.com` 返回 200，而浏览器 reset。

**根因**：Chromium 在 Linux 会读环境变量 `http_proxy` / `https_proxy`，于是它自己去连 agent proxy，
而 agent proxy 拒绝浏览器的连接（proxy 状态里能看到 `not_connect` 之类的记录）。

**修**：SKILL.md 的两跳方案。注意**必须**带 `--no-proxy-server`——只加 `--host-resolver-rules`
是没用的，Chromium 仍然优先走 env 里的代理。

### 症状 `ERR_CERT_AUTHORITY_INVALID`

**确认**：说明连接已经通了，只剩信任问题。这是好消息，比 reset 前进了一步。

**根因**：TLS 在 egress 侧被重新终结，证书由 agent proxy 的 CA 签发；Chromium 读
`~/.pki/nssdb`，而这个 CA 通常不在里面。

**修**：优先用方案 B（Node 做 TLS，浏览器只说明文 HTTP）——不需要动任何信任配置。

**不许做**：`--ignore-certificate-errors`、`ignoreHTTPSErrors: true`。真要走方案 A，
就把 CA 正经导进 NSS：

```bash
certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n ccr-agent-proxy -i /root/.ccr/agent-proxy-ca.crt
```

沙箱里常常没装 `certutil`（`libnss3-tools`）。装不上就回方案 B，不要退而求其次去关校验。

### 症状 403 / 407

出口策略不允许这个域名。**不要重试、不要绕路**，直接把被挡的域名报给用户。

---

## 二、进程层：后台服务起不来

### 症状 隧道/relay 启动后立刻消失，`curl` 得 `exit 7`

**根因**：harness 的 bash 会在命令返回后回收进程组，普通 `&` 或 `nohup` 都可能被带走。

**修**：用 `setsid` 脱离进程组：

```bash
cd <脚本目录> && (setsid node tunnel.mjs --target host:443 > tunnel.log 2>&1 &)
sleep 1 && (setsid node relay.mjs --host host > relay.log 2>&1 &)
sleep 2 && pgrep -af 'tunnel.mjs|relay.mjs'
```

`pkill -f xxx` 在没有匹配进程时返回非零，会让整条 `&&` 链失败——单独一行跑，或跟 `|| true`。

---

## 三、等待层：页面加载判据

### 症状 `waitUntil: 'networkidle'` 一直超时

**根因**：页面开着 SSE / WebSocket / 轮询，网络永远不空闲。

**修**：`waitUntil: 'domcontentloaded'` + 显式等待。真要等数据，等一个**具体的**元素或文本，
不要靠固定 sleep 猜。

---

## 四、渲染层：无头浏览器的几个假象

这几条会让你把浏览器的怪癖当成页面 bug，白白返工。

| 假象 | 真相 | 怎么办 |
|---|---|---|
| `--window-size=390` 下窄屏「不溢出」 | headless 把窗口宽度夹到 500px 下限，`innerWidth` 实测是 500 | viewport 走 `newContext({ viewport })`，或把页面塞进 390px 的 iframe 里看 |
| 切主题后颜色不对（暗色下按钮是浅灰） | headless 的虚拟时间**不推进 CSS transition**，主题切换的过渡冻在起始值 | 渲染前就把 `data-theme` 设好，或加 `--force-prefers-reduced-motion` |
| 越界检测报一堆 `fixed` 元素 | `position: fixed` 相对视口定位，跟 DOM 父级比必然假阳性 | 检测里跳过 `getComputedStyle(el).position === 'fixed'` |
| 移动端抽屉「越界」 | 抽屉常用 `transform: translateX(-100%)` 藏在屏外，几何上确实在父级外 | 已知噪音，看截图确认它是关着的即可 |

---

## 五、噪音层：走 relay 时必然出现的两类误报

`shoot.mjs` 会把它们报成「有发现」——**这是有意的**：宁可给一条你顺手排除的假阳性，
也不要静默漏掉真问题。但你得认得它们，否则每次都要重查一遍。

### 绝对外链拿不到（`ERR_CERT_AUTHORITY_INVALID` / `ERR_CONNECTION_RESET`）

走方案 B 时页面 origin 是 `http://127.0.0.1:<端口>`，只有**相对路径**的请求会经过 relay。
任何写死 `https://...` 的资源都会绕开隧道直接出网，于是撞上原来那堵墙。

实测例子：Cloudflare 给站点注入的 `https://static.cloudflareinsights.com/beacon.min.js`
必然失败。**先看清失败的是哪个 URL**：

```js
page.on('requestfailed', r => console.log(r.url(), r.failure()?.errorText));
```

第三方域名（分析、CDN、字体）→ 忽略。**自己应用的绝对 URL 也失败 → 那是真问题**，
说明代码里把域名写死了，换环境就会坏。

### 权限不足的 4xx

你的 key 的作用域可能小于登录用户。本仓库实测 `/api/cds-system/operator/requests`、
`/api/access-requests` 会 403——那是外壳（侧栏、审批入口）在拉，不是被测页面。

判据：**看路径属不属于被测功能**。属于就是真问题，不属于就是凭据作用域噪音。

## 六、判据层：截图能证明什么

- 截图能证明**这一屏长什么样**。它证明不了数据对不对、点下去会发生什么。
- 用桩数据拍的截图，只能证明「这个数据形状下渲染没崩」。真实字段名、真实空值、
  真实极端长度全都验不到——本轮就是因为桩里写了 `name` 而真实字段是 `branch`，
  下拉整列空白一直到打真站才暴露。**能打真站就别停在桩上。**
- caption 必须与截图内容一致。图里在转圈就不能写「已完成」（见 `closed-loop-acceptance.md`）。
