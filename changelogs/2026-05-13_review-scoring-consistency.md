| fix | prd-api | 产品评审员 Agent 打分稳定性加固：`temperature` 降至 0、由 `submissionId` 派生稳定 `seed`，同一份方案重复评审结果一致；输出格式解析失败时自动重试 1 次（重试时换 seed 并追加严格 JSON 输出要求），仍失败则标记 `Status=Error` 提示用户「重新评审」，不再误判为 0 分未通过 |
