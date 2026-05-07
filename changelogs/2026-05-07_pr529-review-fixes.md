| fix | cds | PR #529 Bugbot HIGH + Codex P2：sidecar-deployer 修复 SSH 命令注入 — image 用 isSafeDockerImage 正则白名单（[a-zA-Z0-9._-/:@] + 长度 ≤256）+ shellQuote 包裹；containerName / port 同步加守卫；routes/remote-hosts.ts 入口提前校验 image 合法性
| feat | cds | PR #529 Codex P1：新增 GET /api/projects/:id/instances 路由（spec.cds-map-pairing-protocol §3.2 instanceDiscoveryUrl 之前指向但未实现）；按 (hostId, latest startedAt) 聚合 ServiceDeployment.status='running' 实例返回 host:port + healthy + version；对应 server.ts 加中文 label「列出项目实例」
| fix | cds | PR #529 Bugbot MEDIUM：/api/cds-system/connections/issue 响应体不再单独返回 pairingToken 明文，仅返 connectionId / clipboardText / expiresAt（pairingToken 已嵌在 clipboardText 内），减少 access logs / proxy logs / devtools 中的足迹
| fix | cds | PR #529 Bugbot LOW：@types/ssh2 从 dependencies 移到 devDependencies，避免生产 install 拉入 @types/node + undici-types
| test | cds | sidecar-deployer-utils 单测增加 isSafeDockerImage / isSafeContainerSlug 两组（共 5 个新 case），覆盖 shell 元字符全集、空/超长/非字符串边界
