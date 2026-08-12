| fix | prd-api | 分层不再回填画布单目标，原图不会被第一层顶掉；失败时也不再把原图翻成 error |
| fix | prd-api | 分层层数不再被按普通生图夹到 5，请求 6-10 层时 Total 与 Done 不再自相矛盾 |
| fix | prd-admin | 分层导出改取满幅原件，裁剪版不再被拉伸铺满整张 PSD 画布 |
| fix | prd-admin | 导出前自检补上登录凭据，不再把每一层都误报成不可读 |
| fix | prd-admin | 快捷编辑产物继承 frameId，编辑结果不再被 Frame 导出忽略 |
| fix | prd-admin | 分层只在 run 跑到终态才认部分结果，避免后到的图层永远到不了画布 |
| fix | prd-admin | 分层要求原图已落盘，不再放行 Worker 根本读不了的 URL-only 引用 |
| fix | llmgw | 账号与安全页补登记进教程维护映射，修掉 tutorial drift |
| test | prd-api | 口令下限守卫改判 LocalPasswordPolicy 单点权威，不再钉死一行内联字面量 |
| test | prd-admin | 冒烟「满幅」判据留 2% 容差，修掉让拉伸缺陷判绿的窄判据；新增导出取满幅与三条读图路的守卫 |
