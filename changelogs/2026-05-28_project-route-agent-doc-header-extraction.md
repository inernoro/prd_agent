| fix | prd-api | MarkdownSectionExtractor 增加「文档头模式」：识别 `# 一、文档头` 节点下 `- 应用/业务模块：智能营销/营销后台` 这种合并 label 的行级 KV 写法，兼容半/全角斜杠、加粗、顿号回退、独立行 KV |
| test | prd-api | 新增 MarkdownSectionExtractorTests（7 个用例）覆盖用户真实方案截图场景 |
