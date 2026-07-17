| feat | prd-admin | 知识库「接入 AI」弹窗一屏重设计：整屏收敛为一个问题（只读 / 可读可写）+ 一颗按钮（生成 Key 并同步复制智能体指令），名称自动生成、有效期默认 1 年，无关权限收进「更多权限」折叠，右栏常驻「接下来三步」预演并在创建成功后原位打勾；「我的 Key / 使用指南」降权为头部文字链 |
| refactor | prd-admin | 智能体接入指令模板抽为共享 SSOT（lib/agentAccessPrompts.ts），海鲜市场与知识库两个入口共用；只读 Key 的指令不再下发写入端点，避免 AI 照做后 403 |
| fix | prd-admin | 智能体指令改指真实可用的开放接口：读走 /api/open/document-store/*，写走受控发布协议 /api/open/document-store/publisher/*（sk-ak Key 在旧 JWT 业务路由上必 401，实测取证）；权限卡文案去掉开放接口做不到的「创建知识库」承诺 |
| fix | prd-admin | 知识库「使用指南」改为文档空间专属内容（读取端点 + 受控发布协议 curl 示例 + Key 生命周期说明），不再复用讲 findmapskills / marketplace 端点的海鲜市场 GuideTab |
