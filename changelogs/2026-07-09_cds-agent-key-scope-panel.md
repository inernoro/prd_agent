| feat | cds | 全局 Agent Key 统一授权面板：签发时可勾选作用域（允许创建新项目 / 操作所有现有项目 / 指定现有项目多选），签发全局 Key 默认「只能创建新项目」（碰不到现有项目），项目卡钥匙默认当前项目；create-only Key 建项目时后端返回新项目独立 scoped key |
| feat | cds | 新增 AgentKeyScopePanel 复用组件，全局 Key 签发弹窗 + CDS 系统设置 AccessKeysTab 共用同一套勾选面板，Key 列表展示解析后的授权范围 |
| feat | cds | cdscli project create 打印后端返回的 issuedProjectKey（新项目 scoped key，明文只一次），AI 建项目后可直接切到该 Key 操作新项目 |
