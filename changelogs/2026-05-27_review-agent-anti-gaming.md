| feat | prd-api | 产品评审 Agent 加入三层兜底（evidence gate / 数据密度封顶 / summary 一致性闸），杜绝 LLM 把非清单维度全填满凑 99 分的钻空子路径 |
| refactor | prd-api | 评审默认权重调整：清单维度 30→20，10 分按 +2 平均分摊到 consistency/problem_quality/user_value/feasibility/testability 五个高风险维度 |
| fix | prd-api | 评审 prompt：清单维度 Description 把 "得分 = 30 × ..." 改为 "MaxScore × ..."，与新 MaxScore=20 对齐，不再误导 LLM |
| fix | prd-api | evidence 正则收紧 \d → \d{2,}，章节匹配允许中间空格，长度门槛 30→15 + 强标记，既挡单数字钻空子又不误伤简洁高密度评语 |
| fix | prd-api | CountDataPoints 用 \d{2,}(?![%％]) 避免 "80%" 被同时计入两条正则，L2 阈值不再被高估撑过 |
| fix | prd-api | L3 关键词清单移除歧义词「标杆级水平」，避免误伤褒义 summary「达到行业标杆级水平」；新增「未达标杆/未到标杆」等明确负面词 |
| fix | prd-api | ApplyScoringGuardrails 防御 DB 自定义维度配置出现重复 Key，改用 GroupBy 避免抛 ArgumentException |
| feat | prd-api | ReviewDimensionScore 增加 OriginalScore 字段，记录被 guardrail 调整前的 LLM 原始分，便于审计 |
| feat | prd-admin | 评审结果页新增「系统兜底调整记录」展示区，触发 guardrail 时显示原分→新分及调整原因 |
| test | prd-api | ReviewAgentScoringGuardrailsTests 新增 8 条测试覆盖单数字钻空子防御、简洁高密度评语、百分比不重复计数、褒义标杆级表述、重复 Key 容错、OriginalScore 记录、L2→L3 跌破门槛等场景 |
