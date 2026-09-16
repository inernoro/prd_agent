| fix | llmgw | 批量导入盖上能力 schema 版本，不再让导入后的第一次 capability-audit 变红 |
| fix | llmgw | 批量导入遇到同名但别的用途的对外模型时拒绝挂线路，不再让生图线路被当成 chat |
| fix | llmgw | 生图同步状态按租户分行，共用网关库时不再互相覆盖 |
| test | prd-api | 名录门兑换所用例改走对外模型线路，暴露出一条真缺陷（详见提交说明） |
