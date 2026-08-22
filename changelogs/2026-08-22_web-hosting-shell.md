| fix | prd-admin | 网页托管主控台外壳按设计稿屏 1 对齐：新增常驻左栏（空间/分组/标签），组织方式补「按来源」档，列表上方补结论行，上传按钮移到工具条右端 |
| refactor | prd-admin | 分组逻辑抽成 siteGrouping.ts（含按来源分节与档位可用性），结论行抽成 libraryHeadline.ts，各自带守卫测试 |
| feat | prd-admin | 空间选择记住上次停留位置（sessionStorage），切空间时不成立的组织方式自动落回按时间 |
