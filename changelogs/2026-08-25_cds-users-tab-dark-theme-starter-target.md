| fix | cds | 系统设置「用户管理 / 用户痕迹」不再按认证模式整条隐藏，非 GitHub OAuth 模式改为说明当前模式、为什么不可用、如何启用 |
| fix | cds | 修复「接入 Agent → 上手助手」在黑色皮肤下看不清：整块写死的浅色调色板改走主题 token，新增 --status-ink（落在 ok/warn/bad/info 实色上的文字墨色） |
| fix | cds | 上手助手页签不再落到 system 接入目标，口令始终带上 connect --new-project；技能包下载改指匿名端点 /api/skills/cds-pack/download（原 /api/export-skill 需登录） |
| test | cds | palette-contrast-guard 增加中性色棘轮（stone/slate/zinc/gray/neutral/bg-white）与上手助手零硬编码断言；agent-onboarding 增加零凭据起步与接入目标解析用例 |
| docs | cds | 教程与指南同步零凭据接入链路：guide.cds.tutorial 增「为什么不用先准备密钥」与接入目标步骤、guide.cds.agent-onboarding-harness 增目标选择步骤、guide.cds.ai-auth 增首次接入链路与用户管理认证模式说明、design.cds.project-bootstrap 增鸡生蛋三断点与防复发判据 |
| polish | cds | 上手助手 CDS 卡片文案写明「不需要先准备任何密钥」 |
| docs | cds | debt.cds 记 D12：创建项目本身依赖宿主 Docker（建项目即建项目网络），无 dockerd 时 POST /api/projects 直接 500 —— 零凭据接入链路复测发现 |
| docs | cds | debt.cds 记 D13：页面批准换来的一次性 create-only Key 对全部只读接口放行（线上实测可枚举项目/分支/全局变量名/全局 Key 清单/自更新历史，值与明文已掩码），对外开放接入前需收敛为显式只读白名单 |
| fix | cds | 建项目+换钥收敛成 cdscli 单一实现（含用新钥匙回读自证、本地不再持有一次性钥匙的断言）；onboard 此前自己 POST 并丢弃返回的项目级 Key，用一次性授权走这条路会「项目建好、钥匙作废、下一步 401」 |
| feat | cds | cdscli connect 新增 --create-project：批准后在同一进程内建项目并换成项目级授权，一次性钥匙不再在模型手里停留；上手助手口令改为给这一条命令 |
| test | cds | 新增 test_cdscli_project_key_handover.py（6 例）：换钥落盘、onboard 同样换钥、回读失败与拿不到钥匙必须显式失败、一条命令全链路、建项目只允许一处实现 |
| fix | cds | Review 修复：--create-project 的参数校验移到发起授权申请之前（避免用户白批一次）、空白名称显式报错；换钥自证区分「4xx 明确被拒」与「网络抖动没验成」，后者不再把已完成的不可逆换钥报成失败；一次性身份判据加上「当前确实没有项目级钥匙」，残留 bootstrapKey 不再让正常建项目误报死局 |
| test | cds | Review 修复：中性色守卫补 text-white / text-black（棘轮重算）、单一实现守卫改正则（引号与 f-string 都盖住）、新增 3 例（参数校验先于申请、回读抖动不丢换钥、残留一次性钥匙不影响正常建项目）；上手助手复制按钮的白字挪进 index.css 里那条已强制底色的规则 |
| fix | cds | Review 修复：用户管理说明面板对 SSO 部署不再劝人改成 GitHub OAuth 模式，改为说明账号归上游身份源管理、切换属认证方案变更 |
| fix | cds | Codex Review 修复：一次性身份判据改为比对「本次请求实际发出的凭据」与存档 bootstrapKey（残留 bootstrapKey + 显式全权 Key 不再在项目已建好后误报死局）；用户管理说明面板新增探测失败态（可重试 + 错误详情），不再把 /api/auth/public-status 探测失败当成「认证未启用」 |
