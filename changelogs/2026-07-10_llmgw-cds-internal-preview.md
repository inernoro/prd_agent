| ops | cds | 移除 llmgw 与 llmgw-serve 的 CDS 独立公网预览，仅保留 llmgw-web 控制台入口 |
| feat | prd-api | 为网关新增 scoped key、Decimal128 原子预算、显式取消、raw 幂等和数据生命周期治理 |
| security | prd-api | 将显式取消注册表按 appCallerCode 与 requestId 联合隔离，阻止跨调用方取消运行中请求 |
| security | prd-api | scoped key 的空来源、空协议、空调用方或空 scope 改为拒绝，仅显式星号允许通配 |
| fix | prd-api | unknown 上游结果的预算预占到期后改为保守结算，避免成功受理但响应丢失时低估月消费 |
| feat | prd-api | 增加 platform/model 跨 serving 分布式并发租约并接入文本、流式和 raw 上游调用 |
| feat | prd-llmgw | 新增接入密钥管理 API，并支持 appCaller 单次预算预占额配置 |
| feat | prd-llmgw-web | 新增接入密钥页面和 appCaller 预算预占配置控件 |
| fix | prd-llmgw-web | 修复接入密钥页与控制台导航在手机宽度下的整页横向溢出 |
| fix | prd-api | 将无凭据容器探针切换到公开 healthz，保留带 key 的 deep readyz 发布门 |
| fix | scripts | 在发布阶段缺少 serving 证据时自动采集零上游费用探针，并同步原子预算审计规则 |
| test | prd-api | 增加预算、幂等、scope 和跨实例并发 Mongo 竞争测试 |
