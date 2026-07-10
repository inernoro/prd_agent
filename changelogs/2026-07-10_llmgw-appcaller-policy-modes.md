| fix | prd-llmgw | 修正 active appCaller 治理校验，允许 auto/pool/pinned 三种目标路由策略 |
| fix | prd-llmgw | 修正 config-authority 自动绑池逻辑，保留 active appCaller 已配置的 auto/pool/pinned 策略 |
| fix | prd-api | 修正 active appCaller 在 auto 策略下的运行态解析，使用绑定的 GW 模型池而不是 fail-close |
| fix | prd-api | 修正 active appCaller 的 pinned 解析顺序，full-http 退场后只允许命中 GW-owned 平台和模型 |
