| feat | prd-admin | 知识库划词评论新增「右侧批注栏」边读边看布局：评论卡片常驻正文右侧显示头像+名字+内容，与正文高亮 hover 联动 |
| feat | prd-admin | 划词评论支持「批注栏 / 内联」布局切换（右上角，个人偏好持久化），并改为选区就地输入（取代右侧抽屉） |
| feat | prd-api | 新增知识库最近批注聚合接口 GET /api/document-store/stores/{storeId}/recent-comments（按时间倒序，供验收智能体回读用户在验收文档上的批注） |
| feat | prd-admin | 知识库批注强关联：同色锚定（高亮下划线=卡片色条同色）+ 点气泡/卡片激活联动 + active-only 牵引连线 + 批注密集时折叠成一行 |
| fix | prd-admin | 修复批注牵引连线两个边界：高亮/卡片滚出正文可视区时不再画线（避免飞到窗口角/越过顶栏）；连线改连续 rAF 直接改 DOM，跟手不再延迟抖动 |
| fix | prd-admin | 修复批注评审 5 项：composer 提交落到选区所属条目（切档不串档）、删除/激活滚动加 stale 守卫、激活用真实锚点滚动且取消激活不跳视口 |
| fix | prd-agent | read_comments.py：--entry 改用 per-entry 接口拿全量（避免被 store 级 limit 挤出页）、since 查询 URL 编码 |
| fix | prd-admin | 批注评审二轮：创建后乐观插入防 UI 滞留、删光分组清激活态防幽灵连线、只读访客不弹写入 composer、收起批注栏时点气泡自动重开 |
| fix | prd-api | recent-comments 返回补 authorAvatar 字段，与 per-entry 接口对齐供 store 级轮询取头像 |
| fix | prd-admin | 批注评审三轮：连线不再用正文 bounds 误判右栏卡片致误隐藏、抽屉关闭同步 commentsCanCreate、margin/inline 删除按钮加二次确认 |
| fix | prd-admin | 批注删除后 bump fetchId 作废在途刷新，防止删除前的服务器快照晚到把已删评论复活 |
| fix | prd-admin | 批注栏/内联的回复改为落到该线程所属条目（base.entryId），防切档后回复写到别的文档 |
| fix | prd-admin,prd-api | 批注删除按钮按「库主/作者」逐条判定权限（recent list 返回 isOwner+viewerUserId），公开库非作者读者不再看到删不掉的删除按钮 |
