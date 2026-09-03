| fix | prd-api | 权限判定认 super 通配：持超级权限的管理员此前签不出接入台密钥、面板还把能力显示成灰的 |
| fix | prd-api | root 破窗账户签出的密钥不再被鉴权剥光 scope（root 不在库里，按 owner id 判身份） |
| fix | prd-api | 日配额改为原子占坑 + 失败退还，并发请求不再一起冲破上限；新增 mcp_usage_counters 集合 |
| fix | prd-api | 接入台自检与「已授权」按主人当前权限重新核对，不再报出智能体其实看不见的工具 |
| fix | prd-api | 文学创作建工作区兑现 clientRequestId 幂等（确定性 id），重试不再攒出重复工作区 |
| feat | prd-api | 密钥配额上限可改（每日生图/写入、每分钟调用），配额触顶提示里的入口现在真的存在 |
| feat | prd-admin | 接入台今日额度卡新增「调整上限」编辑弹窗，已用数与闸门读同一份计数器 |
