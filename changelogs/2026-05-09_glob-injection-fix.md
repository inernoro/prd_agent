| fix | prd-api | LocalAssetStorage TryRead/Delete 加 IsHex 校验防止 glob 注入：sha 含 * / ? 时 Directory.GetFiles 会解释为通配符，可能匹配/删除非预期文件 |
| docs | doc | debt.asset-storage 补 X-4：DocumentStoreAgentWorker 错误消息 1500 截断切断 JSON 中段（历史代码，本 PR 范围外） |
