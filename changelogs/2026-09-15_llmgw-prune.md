| refactor | prd-api | 挑选判据从 5 份收到 2 份：删无人调用的 SelectBestModel，池成员排序与测试拷贝改为调权威判据 |
| fix | prd-api | 删掉永远为假的 ResolutionType == "DefaultPool" 及它喂的恒为 false 的 DTO 字段 |
| refactor | prd-api | 删掉无人调用的 NeedsModelConfigFallback |
| test | prd-api | 新增两条减枝守卫：解析标签字面量必须真的会被产出；挑选判据只许权威与镜像两份 |
| docs | llmgw | 架构文档补「减枝」一节，写清三条现在不砍的枝与理由 |
