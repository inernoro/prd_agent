| fix | cds | 系统设置「用户管理 / 用户痕迹」不再按认证模式整条隐藏，非 GitHub OAuth 模式改为说明当前模式、为什么不可用、如何启用 |
| fix | cds | 修复「接入 Agent → 上手助手」在黑色皮肤下看不清：整块写死的浅色调色板改走主题 token，新增 --status-ink（落在 ok/warn/bad/info 实色上的文字墨色） |
| fix | cds | 上手助手页签不再落到 system 接入目标，口令始终带上 connect --new-project；技能包下载改指匿名端点 /api/skills/cds-pack/download（原 /api/export-skill 需登录） |
| test | cds | palette-contrast-guard 增加中性色棘轮（stone/slate/zinc/gray/neutral/bg-white）与上手助手零硬编码断言；agent-onboarding 增加零凭据起步与接入目标解析用例 |
| docs | cds | 教程与指南同步零凭据接入链路：guide.cds.tutorial 增「为什么不用先准备密钥」与接入目标步骤、guide.cds.agent-onboarding-harness 增目标选择步骤、guide.cds.ai-auth 增首次接入链路与用户管理认证模式说明、design.cds.project-bootstrap 增鸡生蛋三断点与防复发判据 |
| polish | cds | 上手助手 CDS 卡片文案写明「不需要先准备任何密钥」 |
