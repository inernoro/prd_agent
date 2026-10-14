| feat | prd-admin | 网页生成与修改入口移除执行器选择，统一展示 OpenDesign 流程 |
| feat | prd-api | 新网页生成与修改任务由服务端强制使用 OpenDesign 并收口旧客户端直连参数 |
| test | prd-admin | 补充网页运行时单一路径与入口回归测试 |
| test | prd-api | 补充旧客户端兼容改写和 OpenDesign 不可用负面路径测试 |
| fix | cds | 让 MAP API 与设计服务从同一份 LLMGW 基址派生模型出口，避免部署配置漂移 |
| test | cds | 补充 API 与设计服务 LLMGW 地址同源的部署契约测试 |
| test | prd-api | 对齐 LLMGW 基址同源派生的跨服务部署合同守卫 |
| fix | prd-admin | 补齐移动端网页托管的生成网页主入口，同时保留可发现的上传操作 |
| feat | prd-api | 为 OpenDesign 网页任务增加稳定阶段码、过程时间点、服务端活动任务发现与冻结输入重开 |
| feat | prd-admin | 网页生成与修改展示脱敏成果阶段，并支持跨标签页恢复和服务中断后重开 |
| feat | design-runtime | 文件变化触发实时预览推送，同时保留轮询兜底与任务结束清理 |
| test | prd-api | 覆盖活动任务用户隔离、重开幂等、原任务保留和阶段事件白名单 |
| test | prd-admin | 覆盖正常、慢速、失败、恢复与重开状态映射 |
| fix | prd-api | 保留 OpenDesign 最终受信 HTML 用于持久化，同时继续阻止模型原文与隐式推理进入用户事件流 |
| fix | prd-admin | 修复服务重启后冻结输入恢复门不轮询，运行环境健康时恢复原要求重启动作 |
| feat | prd-api | 为网页生成与修改冻结版本化设计简报和品牌上下文，并让重开任务沿用同一输入指纹 |
| feat | design-runtime | 将冻结简报与品牌 token 映射到 OpenDesign 任务，按规划、成型、检查修正三步执行 |
| test | prd-api | 覆盖生成、修改、个人风格品牌映射、旧任务兼容与冻结输入重开 |
| test | design-runtime | 覆盖简报品牌协议边界、必需事实完整保留和无依据量化事实拒绝 |
| fix | prd-api | 修改网页时沿用目标已发布版本的冻结设计简报与品牌包，旧站点才明确走兼容回退 |
| test | prd-api | 覆盖生成版本到修改及重开的上下文继承、旧站点回退和跨用户隔离 |
| fix | prd-api | 修改网页时从生成站点的权威来源任务继承冻结品牌，不再依赖是否已发布版本 |
| test | prd-api | 覆盖未发布 baseline、已分享站点、后续修改、重开及跨部署隔离 |
| feat | design-runtime | 在隔离 Chromium 子进程对桌面与移动视口执行浏览器质量门禁，并在同一 OpenDesign 项目与工作区内限次修复 |
| feat | prd-api | 持久化有界浏览器质量摘要，并在现有耗时统计中暴露首次预览、静止间隔、恢复、发布与修复效果 |
| test | design-runtime | 覆盖八类浏览器硬问题、视口差异、限次修复、浏览器不可用与证据脱敏 |
| test | prd-api | 覆盖浏览器质量证据校验、Run 投影与效果指标聚合 |
| fix | design-runtime | 将终审与质量修复迁入独立 OpenDesign 会话，避免主生成工具历史耗尽任务预算 |
| test | design-runtime | 覆盖主生成与质量会话隔离、严格终审及浏览器修复会话复用 |
| fix | design-runtime | 为模型终审设置独立截止预算并恢复超时前受信产物，保留浏览器硬门禁与提交时间 |
| fix | prd-api | 模型终审按预算收口后展示明确进度，不再让用户误以为终审静止卡住 |
| test | design-runtime | 覆盖慢终审取消、完整产物恢复、浏览器硬门禁继续执行与原运行追溯 |
| test | prd-api | 覆盖终审预算收口阶段的稳定进度与用户文案映射 |
| fix | design-runtime | 补齐隔离 Chromium 的可写 HOME，并让启动能力探针拒绝浏览器运行目录缺失的假健康镜像 |
| test | design-runtime | 覆盖浏览器 HOME 镜像合同、能力探针与 Chromium 关键退出原因摘要 |
| fix | design-runtime | 将确定性与浏览器质量修复纳入绝对收尾截止线，超时恢复受信快照并重新执行双视口门禁 |
| test | design-runtime | 覆盖质量修复取消、完整快照恢复、复检通过提交与硬问题可追溯拒绝 |
| fix | prd-api | 质量修复按截止时间收口时保持稳定成果阶段与持续进度文案 |
| fix | design-runtime | 静态质量修复失败的终态错误保留稳定问题码、修复次数与预算耗尽标记，避免诊断字段只存在于中间事件 |
| fix | design-runtime | 修复点号月日与相邻中文名词被拼成虚假数量，同时保留真实无来源数字门禁 |
| fix | prd-api | 对齐托管发布闸的中文月日与量词词界，避免执行器通过后再次误拒绝 |
| fix | prd-api | 保留 OpenDesign 质量拒绝的稳定错误码、问题码、修复次数与预算耗尽详情，并安全暴露到运行合同 |
| test | prd-api | 覆盖远端失败详情白名单收敛、worker 持久化、Run 投影与公共事件合同 |
| fix | design-runtime | 将 CSS 生成可读文字的硬规则前置到主生成与严格终审提示合同，要求文字回到可见 HTML 节点 |
| test | design-runtime | 锁定生成、终审的伪元素文字禁令与审美复查不改事实的合同 |
| fix | design-runtime | 前置移动导航与关键文字对比度硬规则，并为浏览器质量拒绝保留有界逐次测量证据 |
| fix | prd-api | 白名单持久化浏览器质量问题的视口、测量目标与元素摘要，并在生成和修改运行合同中安全透出 |
| fix | prd-admin | 浏览器质量失败展示稳定问题类别、线上安全结论与重试动作，不暴露技术测量和供应商信息 |
| test | design-runtime | 覆盖移动导航、对比度提示合同及失败证据不包含 HTML 或截图路径 |
| test | prd-api | 覆盖浏览器测量详情白名单、恶意字段拒绝、生命周期持久化与公开合同 |
| test | prd-admin | 覆盖浏览器质量失败的用户恢复文案与技术诊断脱敏 |
| fix | design-runtime | 将关键文字对比度创作目标提高到普通文本 5.0 与大字 3.3，并把浏览器实测字号、字重和元素摘要交给定向修复 |
| fix | prd-api | 按设计任务持久化最后一版受信预览，并允许用户隔离地找回最近的结构化质量失败结果 |
| fix | prd-admin | 关闭重开生成或修改工作台后恢复同一失败提示和最后预览，且不把终态任务伪装为可续跑 |
| test | prd-api | 覆盖预览 revision 单调持久化、失败任务发现条件、用户隔离和运行投影 |
| test | prd-admin | 覆盖终态失败的服务端发现、预览恢复和不可续跑提示合同 |
| fix | design-runtime | 浏览器移动导航首轮修复无实测改善时升级为唯一受控导航策略，并在截止预算内为两轮有限修复预留独立时段 |
| test | design-runtime | 覆盖移动导航零改善后的第二轮升级指令与浏览器失败证据完整保留 |
| fix | prd-api | 补齐 Responses 推理与缓存写入用量持久化，避免嵌套缓存写入重复计费并标记金额证据性质 |
| feat | llmgw | 请求记录、预算与模型统计明确区分供应商实际、Gateway 估算、未计价和无用量 |
| feat | llmgw | 增加受鉴权的 Offering 安全删除与禁用创建能力，保留历史日志并阻止破坏最后可用线路或在途任务 |
| test | llmgw | 覆盖 Responses 用量公式、金额口径标签、Offering 删除保护和禁用创建兼容合同 |
| fix | llmgw | Provider 删除同步退场明确关联的旧 MAP 来源，避免权威副本删除后旧配置重新出现 |
| test | llmgw | 覆盖 Provider 双域删除、租户隔离、同 ID 歧义保护与历史请求日志保留 |
| fix | design-runtime | 修改网页时将上一版本的浏览器质量证据保留为冻结输入，不再误当作可编辑资源拒绝工作区 |
| test | design-runtime | 覆盖含双视口质量报告和截图的已生成站点可继续修改且派生证据不会混入新产物 |
