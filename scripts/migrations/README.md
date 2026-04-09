# 一次性数据迁移脚本

## replace-cdn-domain.js — CDN 域名字符串替换

把 MongoDB 所有集合里的 `pa.759800.com` 替换成 `map.ebcone.net`。

### 为什么需要这个脚本

`prd-api/src/PrdAgent.Infrastructure/Services/AssetStorage/TencentCosStorage.cs:359` 的 `BuildPublicUrl` 把 `${TENCENT_COS_PUBLIC_BASE_URL}/{key}` 拼成**完整 URL** 之后, 作为字符串写入了大量 Model 的 `*Url` 字段:

- `image_assets.Url`, `OriginalUrl`
- `attachments.Url`, `ThumbnailUrl`
- `hosted_sites.SiteUrl`, `CoverImageUrl`(网页托管)
- `submissions.CoverUrl`, `InitImageUrl`, `WatermarkPreviewUrl`
- `submissions.GenerationSnapshot.InitImageUrl`、`ImageRefs[].Url`(嵌套)
- `desktop_assets.Url`, `desktop_update_caches.CosPackageUrl`
- `watermark_font_assets.Url`, `watermark_configs.PreviewUrl`
- `image_master_workspaces.LatestPreviewUrl`, `PreviewUrl`
- `workspaces.LatestPreviewUrl`, `PreviewUrl`
- `upload_artifacts.CosUrl`
- `defect_reports.Url`, `ThumbnailUrl`
- `llmrequestlogs.CosUrl`, `Url`, `OriginalUrl`
- `tutorial_email_assets.FileUrl`, `ThumbnailUrl`
- `transcript_items.FileUrl`
- `image_gen_run_items.Url`
- `video_gen_runs.*Url`
- ……还有很多

**改 `TENCENT_COS_PUBLIC_BASE_URL` 环境变量只影响新写入的数据**, 老记录里的 URL 仍然带着旧域名, 所以需要这个一次性脚本批量字符串替换存量。

注意: 头像 (`AvatarUrlBuilder`)、`AuthzController` 返回给前端的 `cdnBaseUrl`、水印字体 (`WatermarkFontRegistry`) 这几个路径是**运行时动态拼**的, 重启进程就行, 不需要动数据库。

### 标准操作流程

```bash
# 0) 先重启 prd-api 让新 TENCENT_COS_PUBLIC_BASE_URL 生效
#    (避免一边迁移一边又写入旧数据)
docker compose restart api

# 1) 备份
mongodump --uri "mongodb://..." --out backup-$(date +%F)

# 2) Dry-run (默认, 不写入)
mongosh "mongodb://..." scripts/migrations/replace-cdn-domain.js

# 3) 真正执行
mongosh "mongodb://..." --eval "var DRY_RUN=false" scripts/migrations/replace-cdn-domain.js

# 4) 验证残留
mongosh "mongodb://..." scripts/migrations/verify-cdn-domain.js
# 期望输出: ✅ 未发现任何文档包含 pa.759800.com
```

### DataGrip MongoDB Console 一键版

如果手头只有 DataGrip, 不想装 mongosh, 直接把下面这段粘进 MongoDB Console 跑:

```javascript
var OLD = "pa.759800.com", NEW = "map.ebcone.net";
function w(v) {
  if (typeof v === "string") return v.indexOf(OLD) >= 0 ? v.split(OLD).join(NEW) : v;
  if (Array.isArray(v)) return v.map(w);
  if (v && typeof v === "object" && !v._bsontype && !(v instanceof Date)) {
    var o = {}; for (var k in v) o[k] = w(v[k]); return o;
  }
  return v;
}
db.getCollectionNames().forEach(function(n) {
  if (n.indexOf("system.") === 0) return;
  var c = db.getCollection(n), m = 0;
  c.find({}).forEach(function(d) {
    if (JSON.stringify(d).indexOf(OLD) < 0) return;
    c.replaceOne({ _id: d._id }, w(d));   // dry-run 时把这行注释掉
    m++;
  });
  if (m) print(n + ": " + m);
});
```

跑完会打印每个被改的集合 + 改了几条。**先备份**。

### 想换其它域名对

通过 `--eval` 覆盖 `OLD`/`NEW`:

```bash
mongosh "..." --eval "var OLD='a.com'; var NEW='b.com'; var DRY_RUN=false" \
  scripts/migrations/replace-cdn-domain.js
```

DataGrip 版本则直接改第一行的 `OLD` / `NEW` 即可。

### 设计要点

- **递归扫所有集合的所有字符串字段**, 含嵌套数组/子文档, 不依赖字段白名单
- **子串替换**, 不是正则: `pa.759800.com` 出现在哪里都会被替换(包括 `i.pa.759800.com`、`cdn.pa.759800.com` 等任何子域名)
- **幂等**: 重复执行无害, 已经是新域名的字段不会再被改
- 默认 `DRY_RUN=true`, 不会意外写入
- 跳过 `system.*` 集合, 避免误改 MongoDB 元数据
- 大集合(`llmrequestlogs` / `apirequestlogs`)耗时较长, 建议低峰执行

## verify-cdn-domain.js — 残留扫描(只读)

只扫不写, 列出所有仍含旧域名的集合、字段路径、样例 `_id`。迁移前后各跑一次对比。
