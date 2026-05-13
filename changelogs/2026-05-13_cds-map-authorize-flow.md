| feat | prd-api | MAP 基础设施连接新增 CDS 地址授权流：start 生成跳转 URL，complete 用授权 code 换 longToken 并复用实例发现 |
| feat | cds | CDS 连接协议新增授权页与 token 端点，支持 MAP 跳转授权后回调建立 shared-service 连接 |
| fix | cds | CDS 授权码入口加入鉴权放行名单，避免生产 GitHub/basic 鉴权模式下授权页被 401 拦截 |
| feat | prd-admin | 基础设施服务页新增“输入 CDS 地址授权连接”，保留配对密钥粘贴作为兜底路径 |
| fix | prd-admin | 基础设施服务页说明文案改为 CDS 地址授权优先，避免视觉验收时仍显示旧配对密钥主流程 |
