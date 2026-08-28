| fix | prd-api | 读配置与重新生成端点回给面板的来源标签不再兜底成 auto，存量站点手写的题不再被标成「系统读正文生成」 |
| fix | prd-admin | 「重新生成」后的来源标签改用后端回的值，被别人顶掉时不再谎称是系统生成的 |
| refactor | prd-api | 「这批题是谁写的」收敛成 AskOpeningQuestions.ResolveSource 一处，读写两侧共用 |
