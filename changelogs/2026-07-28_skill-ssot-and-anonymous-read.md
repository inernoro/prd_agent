| feat | prd-api | 海鲜市场读技能全面免凭据：列表/详情/标签/下载改匿名，只有上传与收藏订阅仍要凭据 |
| refactor | prd-api | findmapskills 正文合并为单一事实源，后端删除内嵌的第二份 SKILL.md 与 README |
| fix | prd-api | 技能安装目录统一为项目级三宿主探测，套装 installCommand 与 INSTALL.md 不再写用户主目录 |
| fix | prd-api | findmapskills 进 catalog 后去重，市场列表不再出现两条同名条目 |
| fix | 技能 | findmapskills 改为项目级安装 + Key 可选，读操作不再因缺 Key 中断 |
| feat | cds | cds 核心技能补「技能怎么看怎么装」一节，写明与 findmapskills 的职责分工 |
| test | cds | 新增跨仓守卫：三处安装约定探测顺序一致、不写用户主目录、单行式合法、后端无内嵌副本 |
| test | prd-api | 新增免凭据守卫：8 个读端点必须匿名，3 个写端点必须留凭据 |
| rule | 规范 | 新增 skill-install-contract：安装位置、三处同步、职责边界、单一事实源 |
