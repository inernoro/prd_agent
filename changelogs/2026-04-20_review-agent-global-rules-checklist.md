| feat | prd-api | review-agent 新增「全局规则检查清单」默认评审维度（权重 30%，18 项检查点覆盖安全/权限/组件/业务/边界/数据），配合等比下调 7 项原维度使总分维持 100 |
| feat | prd-admin | review-agent 评审结果页按分类渲染清单表格（不涉及/已包含/涉及·缺失三态），维度配置弹窗新增「插入全局规则清单模板」快捷入口与清单检查项只读预览 |
| refactor | prd-api | 全局规则检查清单语义修正：LLM 不再自己判断涉及/包含，而是读取用户在方案表格里的实际勾选（involvedChecked/coverageChecked），「涉及=是 且 包含=是」时再做反作弊正文核查（solutionFound），最终 passed 由系统按 truth table 派生 |
| refactor | prd-admin | 评审结果清单表格改为四列「检查项 / 是否涉及 / 方案是否包含 / 评审判定」，分别展示用户勾选与系统判定，失败原因细分（未勾选/涉及未声明/自认未包含/勾了但找不到） |
