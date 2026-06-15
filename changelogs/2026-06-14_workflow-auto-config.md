| feat | prd-api | 工作流对话助手新增「校验+自动接线+自愈+缺项扫描」闭环：AI 生成的工作流自动规范化插槽、按 dataType 自动接线、结构错误回喂 LLM 自愈最多 2 轮，把产物从草稿变可跑件 |
| feat | prd-admin | 工作流助手对话气泡新增自动校验卡：展示校验状态、自动接线说明、待补齐配置/密钥项 |
| fix | prd-api | 修复工作流 from-chat SSE 事件用 `event: message` 包裹导致前端按 data.type 分发失效（workflow_created/generated/delta 事件无法触达） |
| feat | prd-api | 对话助手系统提示注入「暂未开放能力」清单（定时/Webhook 触发），引导 AI 改用手动触发而非静默省略 |
| feat | prd-admin | 工作流自动校验卡的「待补项」改为就地可填表单：填完一键「补齐并应用到编辑器」把值烘焙进节点配置/变量，省去逐节点找配置 |
| feat | prd-admin | 工作流列表页新增「一句话生成工作流」入口：描述需求 → 自动建流进画布并由 AI 生成，不必先建空白再手配 |
| fix | prd-api | 工作流校验对重复 nodeId 容错（不再 ToDictionary 抛异常崩 SSE），重复 ID 报为结构问题交自愈 |
| fix | prd-api | AI 生成工作流仅在结构校验通过时才落库自动创建，自愈仍失败的退回草稿不持久化残缺工作流 |
| fix | prd-admin | 有缺项时隐藏「应用到编辑器」绿钮（避免用未填值覆盖）；缺项未填全时禁用「补齐并应用」，杜绝假「已补齐」 |
| fix | prd-api | 工作流校验对重复变量 key / null 节点 config 容错，不再崩 SSE；SSE 错误事件补 message 字段让前端显示真实失败原因 |
| fix | prd-api | 自动接线改为「补缺连线」：漏接一跳的处理节点自动从前序节点补上游，避免它当空输入独立根却被判可执行 |
| fix | prd-admin | 「一句话起步」auto-send 与历史加载竞态：历史晚返回不再覆盖刚追加的流式消息 |
| fix | prd-admin | 画布保存补回 variables：AI 缺项补齐填入的变量默认值（如 cookie）不再在 handleSave 时丢失，并带入执行变量 |
| fix | prd-api | 缺项扫描新增条件必填：TAPD 选 Cookie 认证时 cookie/dscToken 必填、选 Open API 时 authToken 必填，避免漏报后执行才炸 |
| fix | prd-api | 自动接线改为按插槽粒度：data-merger 等多输入节点的每个必填输入槽都补上游，补不上的暴露为结构问题（不再单输入静默通过） |
| fix | prd-api | 校验结果随对话消息持久化：刷新对话历史后「应用门禁」与缺项卡可恢复 |
| fix | prd-admin | 应用门禁加严：结构无效（环/重复/停用舱补不掉）时禁用「应用到编辑器」「补齐并应用」，并提示先解决结构问题 |
