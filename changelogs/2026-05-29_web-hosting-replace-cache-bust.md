| fix | prd-api | 修复网页托管「替换网页不生效」——SiteUrl 追加 ?v={UpdatedAt.Ticks} 版本指纹，内容不变命中缓存、重新上传击穿缓存 |
| feat | prd-api | IAssetStorage.UploadToKeyAsync 支持 Cache-Control，网页托管对象设 public, max-age=3600 |
| fix | prd-api | 缓存指纹改用 ContentVersion（仅创建/重传变化），改标题/可见性等元数据不再误击穿 PDF 缓存 |
