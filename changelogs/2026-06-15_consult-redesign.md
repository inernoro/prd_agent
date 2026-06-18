| feat | prd-api | 营销问策支持自由文本问策（不绑定客户）：生成端点改为 POST /api/product/consult/generate，body {customerId?,input?,note?,template?}；MarketingConsultReport.CustomerId 可空；新增 GET /api/product/consult 全部问策列表（含客户名/自由问策）；BuildConsultData 兼容无客户 |
| feat | prd-admin | 营销问策子模块重设计：顶部显眼介绍（基于米多四力模型4FM与全域粉销理念）+ 左问策列表 + 右 AI 输入/回答；默认自由文本输入客户情况，可选「选已有客户一键问策」；报告右侧内联预览（可全屏）+ 分享/切模版/存托管 |
