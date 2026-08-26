| fix | prd-api | 修复 MdsWriteRetiredGuardTests 从未编译过：测试工程按既有写法链入 filter 源码并补 ASP.NET Core FrameworkReference，44 条用例真正跑起来 |
| fix | prd-api | 注册守卫改为剥掉行注释后再断言——原写法把注册行注释掉一样能匹配上，等于拿不生效的声明当证明；补一条负对照钉住剥注释这步 |
| fix | prd-api | `api/mds` 判据改为按段匹配，不再把 `api/mdsomething-else` 一起挡掉；模板归一化后判据与白名单查表用同一口径 |
| fix | llmgw | 死成员判定补上模型存在性：上游还在、模型已删的成员照样解析不到，原来只查平台会把它当活成员，托管池两头堵死 |
| fix | llmgw | 死成员判定放过中继成员：`__exchange__` 与中继 id 本就不是平台 id，拿平台表查必然「查不到」，原来会把活的中继成员判成死成员 |
| refactor | prd-admin | 清掉模型管理退场后无人调用的写包装：models 12 / platforms 3 / llmConfigs 4 / modelGroups 8 / schedulerConfig 1，整份 exchanges.ts 与 mock/impl/models.ts 一并删除，契约同步收成只读 |
| polish | llmgw | 窄屏行操作菜单按实测抬高，避开 CDS 预览徽章（fixed 左下角、z-index 99999）的遮挡，正式环境无该元素时行为不变 |
| fix | llmgw | 池健康统计不再把「指不到任何上游或模型」的成员算成 healthy——一次请求都发不出去的池此前在控制台显示「健康」 |
| fix | llmgw | 成员顺位的圆点与池级徽章口径统一：指不到上游的成员在列表响应里归一成「不可用」，不再出现「池标已中断、第 1 顺位却是绿点」 |
| refactor | llmgw | 可解析成员判定收敛成一个入口（IsResolvablePoolMemberKey），删掉运行 gate 里抄的第二份，补守卫钉住只许有一份口径 |
| docs | doc | debt.platform.llm-gateway 记两条待清理数据：三个全失效专用池、与托管默认池重复的对话主池 |
| ops | llmgw | 清掉四个空壳模型池（ASR 豆包 BigModel / Stream、视频 Seedance 2.0 Fast、与托管默认池重复的对话主池），剩余 13 个池一类一个、全部网关权威 |
| fix | llmgw | 成员可解析性归一收进唯一出口，变更端点不再吐库里的原始健康值——原先改完成员卡片会当场翻绿、刷新又变回去 |
| fix | llmgw | 不可用成员说得出为什么：新增 unavailableReason（上游没了 / 模型没了），界面不再写「不可用（连续失败 0 次）」这种自相矛盾的归因 |
| ops | llmgw | 摘掉图片生成默认池里两个悬空成员（挂已删上游、且排在所有真实模型之前），末态 13 池 311 成员全部可用 |
| test | prd-api | 补三条守卫：归一必须覆盖每一个吐出池的出口、不可用成员必须说得出为什么、窄屏行操作菜单必须量出遮挡再让位（前端契约守卫自动镜像，368→374 条断言） |
| fix | prd-admin | 主题硬编码基线清掉三条指向已删页面的幽灵条目，并给棘轮加上「基线里的文件必须存在」断言 |
| refactor | prd-admin | 再清一轮零消费方死代码：三个 adapter-info 读包装、整份 llmConfigs 服务与契约、services/mock 三个孤儿文件、api.ts 里 11 个无人引用的 mds 地址构造器 |
| docs | prd-api | 点名两处虚的承诺：白名单守卫改名为名副其实的 AllowlistIsPinnedToExactlyTheKnownExemptions；LlmSchedulingIntegrationTests 标注为退场后永远跑不通 |
| fix | llmgw | MAP 遗留默认池不再被当成非默认删掉：判据原先在读到 IsDefaultForType 之前就因缺 TenantId 早退，任何 MAP 默认池只要没 appCaller 绑定就能被直接删，而 ModelResolver 还在拿它当兜底 |
| fix | llmgw | 摘除托管池成员改为定点 $pull + 版本递增：原先整数组覆写会吞掉并发改动，且不递增版本让陈旧句柄能把摘掉的成员写回来 |
| fix | llmgw | 控制台给得出摘除死成员的入口：托管池整体只读，但指向已删上游的成员放开「移除」，否则文案在叫人做一件控制台里做不到的事 |
| test | prd-api | 补三条守卫钉住上述三点，均已跑负对照 |
| fix | llmgw | 不可用归因拆成四值（上游/模型 × 不存在/停用）：可解析索引按启用算、悬空判定按存在算，两者口径不同，原先会给仅仅被停用的成员长出一个点了必然 409 的摘除按钮，还把「停用」说成「已不存在」 |
| test | prd-api | 补守卫钉住四值分类与「只对真死成员给摘除入口」，已跑三条负对照 |
