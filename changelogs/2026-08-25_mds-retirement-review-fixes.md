| fix | prd-api | 修复 MdsWriteRetiredGuardTests 从未编译过：测试工程按既有写法链入 filter 源码并补 ASP.NET Core FrameworkReference，44 条用例真正跑起来 |
| fix | prd-api | 注册守卫改为剥掉行注释后再断言——原写法把注册行注释掉一样能匹配上，等于拿不生效的声明当证明；补一条负对照钉住剥注释这步 |
| fix | prd-api | `api/mds` 判据改为按段匹配，不再把 `api/mdsomething-else` 一起挡掉；模板归一化后判据与白名单查表用同一口径 |
| fix | llmgw | 死成员判定补上模型存在性：上游还在、模型已删的成员照样解析不到，原来只查平台会把它当活成员，托管池两头堵死 |
| fix | llmgw | 死成员判定放过中继成员：`__exchange__` 与中继 id 本就不是平台 id，拿平台表查必然「查不到」，原来会把活的中继成员判成死成员 |
| refactor | prd-admin | 清掉模型管理退场后无人调用的写包装：models 12 / platforms 3 / llmConfigs 4 / modelGroups 8 / schedulerConfig 1，整份 exchanges.ts 与 mock/impl/models.ts 一并删除，契约同步收成只读 |
| polish | llmgw | 窄屏行操作菜单按实测抬高，避开 CDS 预览徽章（fixed 左下角、z-index 99999）的遮挡，正式环境无该元素时行为不变 |
