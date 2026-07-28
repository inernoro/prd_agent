| feat | prd-api | 新增 dev-starter 与 qa-starter 角色套装，配套 dev-project / qa-project 初始化预设 |
| feat | prd-api | 官方技能对外简介统一改中文，覆盖市场卡片、CDS 技能栏、套装 INSTALL.md 与 sdd-init |
| fix | 技能 | sdd-init 补宿主到规则文件名的对应，.agents/.cursor 宿主生成 AGENTS.md |
| fix | 技能 | 四个技能去 emoji（create-skill-file、human-verify、验收模板两份） |
| test | 脚本 | 套装自测新增中文简介守卫；新增 ai-defect-resolve 内外两版协议契约不漂移守卫 |
| docs | 文档 | 规则 §6 改为准确描述：ai-defect-resolve 是有意的精简外发版，不合并只守契约 |
| feat | cds | 接入智能体新增「项目初始化」栏：选预设即得一条命令 + 一句话，真装技能而非只给提示词 |
| feat | cds | 新增匿名端点 /api/bootstrap/{preset} 生成引导脚本、/api/skills 代理 MAP 技能并缓存兜底 |
| feat | 技能 | 新增 phase0-guard：底座阶段护栏 + 面向老板与产品经理的六段式沟通规范、术语翻译、读者分层 |
| fix | cds | 技能缓存新鲜度补时钟偏斜守卫，避免文件时间在未来时缓存被永远判为新鲜 |
| test | cds | 新增 skill-proxy 与引导脚本守卫 13 项：缓存兜底、项目级安装、无密钥、注入转义 |
| docs | 文档 | 新增 design.cds.project-bootstrap 与 debt.cds.project-bootstrap |
| feat | cds | 接入智能体「海鲜市场」栏从跳转外链改为 CDS 内直接浏览技能套装与明细，客户无需 MAP 账号 |
| feat | cds | 项目初始化栏新增可展开的技能清单，显示这套装到底装哪些技能而非只显示套装名 |
| fix | 技能 | sdd-init 补宿主到规则文件名的对应（.agents/.cursor 生成 AGENTS.md，不再一律 CLAUDE.md） |
| fix | 技能 | sdd-init 补技能索引四条硬要求：触发词读正文不靠猜、用途必须中文、折叠标量读完整块、按用途分组 |
| chore | cds | 删除误提交的一次性验证脚本 fake-cds.local.mts |
| feat | prd-api | 海鲜市场新增角色技能套装：一条 curl 装齐一个角色的全部技能，匿名可下载，zip 内含 INSTALL.md 与 manifest |
| feat | prd-api | 新增匿名端点 GET /api/official-skills/bundles，返回角色标签与套装清单（含安装命令） |
| feat | prd-admin | 海鲜市场新增「我是」角色筛选行，按角色筛出套装与技能 |
| feat | 技能 | 新增 sdd-init 技能：探测项目现状，生成 CLAUDE.md 八条规则骨架 + doc 七类文档骨架 + 角色路线图与自检报告 |
| feat | 技能 | 补齐四个零仓库绑定但一直没上架的技能：plan-first、product-document-generator、doc-writer、flow-trace |
| refactor | prd-api | 技能依赖表从 Controller 硬编码搬到目录声明层，与套装共用递归展开逻辑 |
| fix | 技能 | 修正 tag 启发式误判：conflict-resolution 曾被标为「周报」、risk-matrix 标为「部署」 |
| fix | 技能 | acceptance-checklist 两个 reference 文件 de-emoji，对外分发内容不再夹带 emoji |
| test | prd-api | OfficialSkillCatalogTests 新增 7 项套装用例（注册、key 不撞、成员齐全、打包产物、fork、排序、角色） |
| test | 脚本 | 新增 scripts/test-official-skill-bundles.mjs 端到端自测：真解压校验分发产物，含三个负向用例 |
| docs | 文档 | 新增 design.skill.role-bundle 与 debt.skill.role-bundle，同步 index.yml 与目录索引 |
| feat | prd-api | 海鲜市场读技能全面免凭据：列表/详情/标签/下载改匿名，只有上传与收藏订阅仍要凭据 |
| refactor | prd-api | findmapskills 正文合并为单一事实源，后端删除内嵌的第二份 SKILL.md 与 README |
| fix | prd-api | 技能安装目录统一为项目级三宿主探测，套装 installCommand 与 INSTALL.md 不再写用户主目录 |
| fix | prd-api | findmapskills 进 catalog 后去重，市场列表不再出现两条同名条目 |
| fix | 技能 | findmapskills 改为项目级安装 + Key 可选，读操作不再因缺 Key 中断 |
| feat | cds | cds 核心技能补「技能怎么看怎么装」一节，写明与 findmapskills 的职责分工 |
| test | cds | 新增跨仓守卫：三处安装约定探测顺序一致、不写用户主目录、单行式合法、后端无内嵌副本 |
| test | prd-api | 新增免凭据守卫：8 个读端点必须匿名，3 个写端点必须留凭据 |
| rule | 规范 | 新增 skill-install-contract：安装位置、三处同步、职责边界、单一事实源 |
| fix | cds | 引导脚本必需包没装上时改为非零码退出，不再打一行 warning 就报「安装完成」，避免 CI 带着残缺技能集继续跑 |
| fix | cds | 引导脚本套装解压失败不再中断，改为计入未安装清单并在收尾统一报错 |
| fix | 脚本 | 打包器不再截断可执行文件：.py/.sh/.mjs/.js/.ts/.json/.yml 走 512KB 上限且超限直接失败，只有正文类文件才截断，修复 archive_report.py 被截成语法错误后分发给验收角色 |
| fix | prd-api | 官方技能虚拟注入的 iconEmoji 一律置空，移除三处装饰字符，遵守禁 emoji 规则 |
| test | cds | 新增引导脚本退出码语义用例：四个预设各跑一次真脚本断言非零退出与失败文案，并校验脚本本身语法合法 |
| test | prd-api | 修正套装 INSTALL.md 断言，与项目级安装约定对齐（此前仍断言用户主目录路径） |
| fix | cds | CDS 技能包改为内容签名缓存 + 单飞，匿名端点不再每请求递归复制技能树并 spawn tar |
| fix | cds | 本地 CDS 技能包必须五个技能齐全才发布，缺任一个回源上游，杜绝半成品被当成装好了 |
| fix | 技能 | sdd-init 探测扩到 .cursor/.agents 两个宿主目录并读取引导种子，Codex/Cursor 项目不再被误判成没装技能 |
| fix | 技能 | sdd-init 产出 doc/guide.list.directory.md 取代 doc/README.md，不再违反自己刚装进去的文档命名规范 |
| fix | 技能 | sdd-init 的角色手册安装命令与开篇描述改为项目级三宿主探测，清掉最后两处用户主目录残留 |
| test | cds | 安装约定守卫把 sdd-init 的 SKILL.md 与 role-playbooks.md 纳入探测顺序断言 |
| fix | cds | 引导脚本改为装到所有存在的宿主目录，不再只装第一个命中的，修复同时装了多个 Agent 的仓库「装完了当前 Agent 一个技能都看不见」 |
| fix | prd-api | 技能安装约定升级为多宿主遍历安装，installCommand 与 INSTALL.md 同步 |
| fix | prd-api | 匿名下载端点按「技能 + 调用方」做 10 分钟窗口去重，重复 POST 不再累加 DownloadCount，杜绝匿名刷热度排序与白造 Mongo 写入 |
| refactor | prd-api | 下载计数去重抽成共享 SkillDownloadCounter，站内与开放接口两个 controller 共用一份 |
| test | prd-api | 新增 SkillDownloadCounterTests：同调用方只计一次、不同技能/来源独立、登录按用户去重、指纹不含原始 IP、窗口长度有界 |
| test | cds | 安装约定守卫新增「装到所有存在宿主」断言，早期取第一个的写法回潮即红 |
| fix | prd-api | 套装 INSTALL.md 的解压命令同步为遍历全部宿主，此前仍写单数 $SKILLS_DIR 导致按说明操作只装一个目录 |
| test | prd-api | 三处安装约定断言改为校验「遍历宿主 + 兜底目录 + 遍历安装」，与多宿主契约对齐 |
| fix | prd-api | 下载计数去重的查+写合成原子操作，并发重放不再全部绕过去重窗口 |
| fix | prd-api | 匿名指纹改走 GetRealClientIp（反代 X-Real-IP），不再用上一跳地址把同一代理后的所有人连坐压制 |
| fix | prd-api | findmapskills 市场条目的 roles 改为读目录，不再写死空表导致按角色筛选时整条消失 |
| test | prd-api | 新增并发重放只计一次、真实客户端 IP 区分、findmapskills roles 与目录一致三个用例 |
| fix | cds | 引导脚本定位解压后的技能目录改用固定布局，不再依赖 GNU 扩展 find -maxdepth，避免 macOS 上解压成功却因 set -e 当场退出、一个技能没装 |
| docs | 文档 | emoji 债务台账用码位描述替代字面量，不在规则正文之外的文档里出现被禁字符 |
| chore | 文档 | 六个 2026-07-28 碎片合并为一个，符合「同一 PR 一个碎片文件」的约定 |
| fix | prd-api | 限流分桶改按真实客户端 IP，反代后所有匿名访客不再共用一个桶被互相拖垮 |
| fix | cds | 上游技能包回源补齐超时、体积上限、缓存与单飞，自托管实例的这条匿名路径不再可被拖垮 |
| fix | prd-api | 开放接口 /tags 补上官方目录与套装的标签，套装专属标签不再「查不到但能按它筛」 |
| refactor | prd-api | 标签发现抽成 OfficialSkillCatalog.DiscoverableTags，站内与开放接口共用一份 |
| test | prd-api | 新增限流分桶守卫与套装标签发现用例 |
| test | cds | 新增上游回源的缓存/单飞/体积上限/超时/时钟回拨五个用例 |
