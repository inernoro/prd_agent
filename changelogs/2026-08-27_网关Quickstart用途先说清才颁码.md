| feat | llmgw | Quickstart 先写清「我想要做什么」才颁发 appCallerCode，两段（谁在调用 / 要做什么）都落实才放行，不再兜底成 xxx.quickstart 占位码 |
| feat | llmgw | 新增 lib/appCallerIntent.ts：有限关键词表按最长命中判定，回显命中的词、可手动覆盖，调用类型跟着场景自动切到 chat / vision |
| refactor | llmgw | Quickstart 创建屏改为三步向导（说清用途 / 怎么接进去 / 算谁的），主行动改为常驻可见的粘性右下角按钮 |
| test | llmgw | e2e/llmgw-quickstart-states.mjs 补 16 条断言盯住颁码闸门与三步版面，共 73 条全绿 |
| test | prd-api | GatewayDataDomainGuardTests 钉住「Quickstart 不得出现 .quickstart:: 占位码」与意图模块接线 |
| docs | llmgw | 文字预算棘轮 386→356 汉字 / 2→1 段；债务台账登记关键词表是有限枚举 |
