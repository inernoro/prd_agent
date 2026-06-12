# 2026-06-10 系统互联 http→https 规范化

## 背景

对端连接串可能携带 `http://` baseUrl，但实际站点由 nginx 301 到 `https://`。系统互联的 `PeerSync` HttpClient 出于 SSRF 防护禁用了自动重定向，因此握手会把 301 当作失败。

## 变更

- 新增 `PeerSyncRedirectHelper`，只允许同 host、同 peer-sync 端点的 `http -> https` 重定向规范化。
- 新增配对握手遇到上述 301/302/307/308 时，显式重试 HTTPS，并在成功后存储规范化后的 HTTPS baseUrl。
- 配对后的连通测试、资源 push/pull 调用也支持同样的一次性规范化，并在成功后回写 HTTPS baseUrl。
- 仍不启用全局自动重定向；跨 host、跳到非 peer-sync 路径、携带 query/fragment 的重定向继续按失败处理。

## 验证

- `curl -X POST http://map.ebcone.net/api/peer-sync/handshake` 返回 301 到 `https://map.ebcone.net/api/peer-sync/handshake`。
- `curl -X POST https://map.ebcone.net/api/peer-sync/handshake` 可到达 peer-sync 端点，返回业务层 400。
- `dotnet build prd-api/PrdAgent.sln --no-restore`
