| refactor | prd-api | 删掉解析器里的模型池分支：ResolveCoreAsync 767 行降到 88 行，整个文件 3702 行降到 2297 行 |
| refactor | prd-api | 池查询换成状态查询（114 行降到 55 行）；可选模型清单只剩端出对外模型目录（89 行降到 14 行） |
| refactor | prd-api | 删掉 13 个已成死码的池方法共 649 行，以及 3 条测已删功能的用例 |
| test | prd-api | 清理钉住已删池行为的守卫；「GW-only 不得查 MAP 调用方」的不变量升级为「压根不查」 |
| docs | llmgw | InMemoryModelResolver 化石记进债务台账 |
