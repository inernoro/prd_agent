| fix | prd-api | 修复网页托管「替换网页不生效」——SiteUrl 追加 ?v={UpdatedAt.Ticks} 版本指纹，内容不变命中缓存、重新上传击穿缓存 |
| feat | prd-api | IAssetStorage.UploadToKeyAsync 支持 Cache-Control，网页托管对象设 public, max-age=3600 |
