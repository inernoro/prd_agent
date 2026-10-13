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
