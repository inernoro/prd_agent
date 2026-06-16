| feat | prd-api | 产品蓝图新增「产品规则」「产品字典」两实体（product_rules/product_terms 集合 + 各 GET/POST(upsert)/DELETE 端点，写=产品管理员）；ProductRule 含分类/标题/Markdown正文/状态，ProductTerm 含术语/别名/Markdown定义/分类 |
| feat | prd-admin | 产品蓝图新增「产品规则」「产品字典」子 tab：规则按分类分组+状态(生效/草稿/废弃)+Markdown正文折叠查看；字典术语+别名+分类+Markdown定义+搜索；均支持增删改，正文可用 [[术语]] 轻量交叉引用 |
