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
