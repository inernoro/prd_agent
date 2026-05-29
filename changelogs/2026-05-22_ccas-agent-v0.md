| feat | prd-api | 新增赋码采集关联系统综合智能体（ccas-agent）后端：CcasAgentController + 三大子能力（PRD 文档生成 SSE / 设备素材库生成与管理 / 流程图 LLM→JSON 解析）+ 权限 ccas-agent.use + AppCaller 注册（ccas-agent.prd::chat / ccas-agent.flow::chat / ccas-agent.equipment::generation） |
| feat | prd-api | 新增 MongoDB 集合 ccas_equipment_assets / ccas_flow_diagrams + AppNames.CcasAgent / AppDomainPaths.DomainCcasAgent |
| feat | prd-admin | 新增赋码采集关联智能体三 Tab 页面：PRD 生成（工程版+敏捷版双模板，Part A/B 两阶段流式）/ 设备素材库（6 风格预设 + 收藏 + 删除）/ 流程示意图（ReactFlow + 素材图节点 + 区段色块 + 历史持久化） |
| feat | prd-admin | toolboxStore + navRegistry 注册 builtin-ccas-agent（wip）+ shortLabel 加「赋码」+ apiClient 路由识别 |
| feat | .claude/skills | 落盘用户提供的 product-document-generator skill（SKILL.md + 4 个 template，工程版主+子文档 + 敏捷版） |
