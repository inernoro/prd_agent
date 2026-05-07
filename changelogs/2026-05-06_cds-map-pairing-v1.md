| feat | cds | spec.cds-map-pairing-protocol.md v1：剪贴板配对密钥协议（base64url JSON + 一次性 pairingToken + 长效 cdsLongToken），定义 issue / accept / authenticate 三段 handshake + 安全模型 + MAP↔CDS 责任划分 + 未来非标 executor 扩展点
| feat | cds | types.ts 加 CdsConnection（pending-pairing/active/revoked 状态机）；CdsState.cdsConnections 集合
| feat | cds | services/connection/pairing-service.ts：CdsPairingService（issue + accept + authenticateLongToken）+ encodeClipboard/decodeClipboard/sha256Hex 纯函数；token 仅存 SHA256，明文不出库
| feat | cds | routes/cds-system-connections.ts：5 端点（POST /issue + /accept + /:id/revoke、GET 列表/单条、DELETE）；accept 自动创建 shared-service Project；server.ts resolveApiLabel 同步 6 条中文 label
| feat | cds | CDS 系统设置 → 运行时 → 「对接 MAP」tab：列表 + 创建密钥 dialog + 一键复制到剪贴板 + 已连接 status chip + 撤销/删除按钮
| feat | prd-api | InfraConnection model + IInfraConnectionService + InfraConnectionService（IDataProtector 加密 longToken / probe / paste 调 CDS accept），InfraConnectionsController 提供 /api/infra-connections/{paste,list,probe,delete}
| feat | prd-api | AppSettings.MapInstanceId 首次 paste 时 lazy 写入 prd_agent_meta，让对端知道 MAP 实例标识
| feat | prd-admin | InfraServicesPage 从 wip 占位改造为真实功能：「连接 CDS」按钮 + 粘贴 dialog（实时显示解析出的 CDS BaseUrl 防钓鱼）+ 列表 + 探活/删除；navRegistry 移除 wip:true
| test | cds | tests/services/connection/pairing-service.test.ts 13 个：encode/decode round-trip、issue/accept 状态机、token 错误码（not_found/expired/used）、authenticateLongToken
