| feat | cds | 部署时向所有容器注入已发布入口表 CDS_PREVIEW_URL / CDS_SERVICE_URLS（平台事实层，强制覆盖，项目 env 不得伪造），应用侧不再需要自己按 hostname 推算兄弟服务域名 |
| refactor | cds | 新增 preview-entrypoints.ts 作为「本分支发布了哪几个入口」的计算 SSOT；DNS 63 octet 判据此前分裂在 forwarder-route-publisher、computeBranchGatewayUrls 两处字面量，收敛为共享谓词 isPublishableNamedLabel |
| feat | prd-api | SSO 票据接口新增 console 字段，由服务端按平台注入的入口表回答「这张票据该送去哪个控制台」：有基址 / 明确未发布 / 同源三态 |
| fix | prd-admin | 删除前端按 location.hostname 拼网关子域的第二份域名实现（违反规则 #11）：预览分支名过长导致平台未发布该子域时，此前会拼出一个不存在的域名并把失败报成「登录凭据未通过安全校验」，现改为如实报出未发布原因 |
| test | cds | 新增 preview-entrypoints 守卫（含 2026-07-29 现场 67 字符分支用例、63/64 边界、项目 env 不得伪造平台注入） |
| test | prd-admin | SSO 落点测试改为契约驱动，新增源码守卫禁止 llmGatewaySso.ts 再出现域名推算痕迹 |
| docs | doc | 新增 debt.platform.preview-entrypoints.md 台账：记录截断未覆盖复合标签、入口表容器创建时定格、其他消费方未清查三项欠账 |
| fix | prd-api | 区分「入口确实未发布」与「旧版平台没下发入口表」：过渡期预览环境不再误判为正式环境而回退到并不存在的同源控制台 |
| refactor | prd-api | DeploymentAuthority 里读了两遍的 CDS_PROJECT_ID 判据抽成 IsCdsBranchPreview，供第三个消费方复用 |
| test | prd-api | 新增 PlatformEntrypointsTests：表里取值 / 尾斜杠归一 / 缺项返回 null 不猜 / 畸形 JSON 降级 / 「没有表」与「表里没这项」可区分 |
| feat | cds | 命名子域超 DNS 63 字符上限时改为截断 slug + 接 8 位 sha1 摘要（此前整条路由跳过不发布，长分支拿不到网关等命名入口）；摘要保证前缀相同的长分支不会塌成同一 host |
| fix | cds | 发布器写 host、两处 SSRF 白名单此前各自拼 `<slug>-<sub>`，改为统一走 namedServiceLabel，否则截断后发布的 host 与白名单算出的不是同一个 |
