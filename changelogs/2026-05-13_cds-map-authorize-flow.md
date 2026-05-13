| feat | prd-api | MAP 基础设施连接新增 CDS 地址授权流：start 生成跳转 URL，complete 用授权 code 换 longToken 并复用实例发现 |
| feat | cds | CDS 连接协议新增授权页与 token 端点，支持 MAP 跳转授权后回调建立 shared-service 连接 |
| fix | cds | CDS 授权码入口加入鉴权放行名单，避免生产 GitHub/basic 鉴权模式下授权页被 401 拦截 |
| feat | prd-admin | 基础设施服务页新增“输入 CDS 地址授权连接”，保留配对密钥粘贴作为兜底路径 |
| fix | prd-admin | 基础设施服务页说明文案改为 CDS 地址授权优先，避免视觉验收时仍显示旧配对密钥主流程 |
| fix | prd-admin | CDS 授权发起时以前端当前 origin 作为 MAP 地址，避免 CDS 授权页显示反代内网地址 |
| fix | prd-api | CDS 授权 start 接口接收并签名浏览器侧 MAP 地址，回跳地址不再从 API 内网 Host 推导 |
| fix | prd-admin | 设置页顶部 Tab 增加“基础设施服务”入口，避免只能通过直达路由访问 CDS 连接面板 |
| fix | cds | 实例发现接口识别 CDS 连接 long token，并校验 projectId 与 instance:read scope，修复 MAP 探测 401 |
| fix | prd-api | 持久化 DataProtection key ring，避免 CDS 授权凭据在 API 重启后无法解密 |
| fix | cds | 同一 MAP 重新授权时撤销旧 CDS 连接并旋转 long token，避免旧凭据失效后无法重连 |
| fix | prd-api | CDS 连接探活成功时恢复为已连接状态，避免“对端可达但已撤销”的矛盾显示 |
| fix | prd-admin | CDS 连接列表拆分可用连接与失效连接，避免已撤销连接继续出现在已建立列表并允许探活 |
