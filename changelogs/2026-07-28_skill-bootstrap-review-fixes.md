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
