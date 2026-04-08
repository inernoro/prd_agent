// 替换 MongoDB 中所有存量 URL 字段的旧 CDN 域名为新域名
//
// 背景:
//   TencentCosStorage.BuildPublicUrl 把 ${TENCENT_COS_PUBLIC_BASE_URL}/{key} 拼好后
//   作为完整 URL 写入了大量 Model 的 *Url 字段。环境变量改了之后, 老数据里的 URL
//   仍然带着旧域名, 因此需要这个一次性扫描脚本把所有集合里的字符串字段
//   "https://i.pa.759800.com" 替换成 "https://i.miduo.org"。
//
// 用法:
//   1. 先 dry-run 看看会改多少条:
//        mongosh "mongodb://user:pwd@host:port/prd_agent" scripts/migrations/replace-cdn-domain.js
//   2. 确认无误后, 把 DRY_RUN 改成 false 再执行:
//        mongosh "mongodb://..." --eval "var DRY_RUN=false" scripts/migrations/replace-cdn-domain.js
//
// 特性:
//   - 递归扫描每个文档的所有字符串字段(任意层级嵌套数组/对象), 不依赖字段白名单
//   - 即使将来新增了 URL 字段也不用改这个脚本, 重新跑一遍即可
//   - DRY_RUN 默认 true, 不会真的写入
//   - 支持通过环境变量覆盖: OLD_DOMAIN / NEW_DOMAIN
//   - 跳过 system.* 集合, 避免误改 MongoDB 元数据
//
// 注意:
//   - 大集合(如 llmrequestlogs, apirequestlogs)耗时较长, 建议先在副本集的 secondary 上试跑
//   - 执行前最好做一次 mongodump 备份
//   - 这是字符串子串替换, 不是正则; "i.pa.759800.com" 出现在哪里都会被替换

// ── 配置 ────────────────────────────────────────────────────────────────
var OLD_DOMAIN_DEFAULT = "i.pa.759800.com";
var NEW_DOMAIN_DEFAULT = "i.miduo.org";

if (typeof OLD_DOMAIN === "undefined") { var OLD_DOMAIN = OLD_DOMAIN_DEFAULT; }
if (typeof NEW_DOMAIN === "undefined") { var NEW_DOMAIN = NEW_DOMAIN_DEFAULT; }
if (typeof DRY_RUN === "undefined") { var DRY_RUN = true; }

// 跳过这些集合(纯日志/会变得非常大, 且不影响业务展示; 如需迁移可手动放开)
var SKIP_COLLECTIONS = new Set([
    // 如果想跳过日志集合, 把它们加进来即可
    // "apirequestlogs",
    // "openplatformrequestlogs",
]);

// ── 工具函数 ────────────────────────────────────────────────────────────
function isPlainObject(v) {
    if (v === null || typeof v !== "object") return false;
    if (Array.isArray(v)) return false;
    // BSON 特殊类型: ObjectId / Date / Decimal128 / Binary 等都不是 plain object
    if (v._bsontype) return false;
    if (v instanceof Date) return false;
    if (typeof ObjectId !== "undefined" && v instanceof ObjectId) return false;
    return true;
}

// 递归替换字符串。返回 {value, changed}
function walk(value) {
    if (typeof value === "string") {
        if (value.indexOf(OLD_DOMAIN) === -1) return { value: value, changed: false };
        // split/join 比 replace 更安全, 不受正则元字符影响
        var newVal = value.split(OLD_DOMAIN).join(NEW_DOMAIN);
        return { value: newVal, changed: true };
    }
    if (Array.isArray(value)) {
        var changedAny = false;
        var newArr = [];
        for (var i = 0; i < value.length; i++) {
            var r = walk(value[i]);
            if (r.changed) changedAny = true;
            newArr.push(r.value);
        }
        return { value: newArr, changed: changedAny };
    }
    if (isPlainObject(value)) {
        var changedAny2 = false;
        var newObj = {};
        var keys = Object.keys(value);
        for (var k = 0; k < keys.length; k++) {
            var key = keys[k];
            var r2 = walk(value[key]);
            if (r2.changed) changedAny2 = true;
            newObj[key] = r2.value;
        }
        return { value: newObj, changed: changedAny2 };
    }
    return { value: value, changed: false };
}

// ── 主流程 ──────────────────────────────────────────────────────────────
print("======================================================");
print("CDN 域名迁移脚本");
print("  数据库: " + db.getName());
print("  旧域名: " + OLD_DOMAIN);
print("  新域名: " + NEW_DOMAIN);
print("  模式  : " + (DRY_RUN ? "DRY RUN (不写入)" : "*** 实际写入 ***"));
print("======================================================");
print("");

var allCollections = db.getCollectionNames().sort();
var totalScanned = 0;
var totalMatched = 0;
var totalUpdated = 0;
var perCollectionStats = [];

for (var ci = 0; ci < allCollections.length; ci++) {
    var collName = allCollections[ci];
    if (collName.indexOf("system.") === 0) continue;
    if (SKIP_COLLECTIONS.has(collName)) {
        print("[SKIP] " + collName);
        continue;
    }

    var coll = db.getCollection(collName);

    // 用 $regex 在顶层 BSON 文本里粗筛一下, 减少需要走 walk() 的文档量。
    // 注意: $regex 只能匹配字符串字段; 但我们 walk() 是递归的, 所以即使字段
    // 嵌在数组/子对象里, 只要 BSON 里包含这个子串, 索引就会扫到。
    // 用 $text 不行, 因为没建文本索引。这里用 aggregate + $match 不可行(同样问题)。
    // 最稳妥的方式: 直接 find 所有文档逐一检查。对小集合无所谓, 大集合靠 batchSize 控制。
    var cursor = coll.find({}).batchSize(500);

    var scanned = 0;
    var matched = 0;
    var updated = 0;
    var failed = 0;

    while (cursor.hasNext()) {
        var doc = cursor.next();
        scanned++;
        var r = walk(doc);
        if (!r.changed) continue;
        matched++;

        if (DRY_RUN) continue;

        try {
            // 用 replaceOne 而不是 updateOne, 因为我们有完整新文档, 一次写入更简洁
            var res = coll.replaceOne({ _id: doc._id }, r.value);
            if (res && (res.modifiedCount === 1 || res.matchedCount === 1)) {
                updated++;
            } else {
                failed++;
                print("  [WARN] replace 未匹配: " + collName + " _id=" + tojsononeline(doc._id));
            }
        } catch (e) {
            failed++;
            print("  [ERROR] " + collName + " _id=" + tojsononeline(doc._id) + " : " + e.message);
        }
    }

    if (matched > 0) {
        var line = "  " + collName.padEnd(40) + " scanned=" + scanned +
            " matched=" + matched +
            (DRY_RUN ? "" : " updated=" + updated + (failed > 0 ? " failed=" + failed : ""));
        print(line);
        perCollectionStats.push({ collection: collName, scanned: scanned, matched: matched, updated: updated, failed: failed });
    }

    totalScanned += scanned;
    totalMatched += matched;
    totalUpdated += updated;
}

print("");
print("======================================================");
print("汇总:");
print("  扫描集合数  : " + allCollections.length);
print("  命中集合数  : " + perCollectionStats.length);
print("  扫描文档总数: " + totalScanned);
print("  含旧域名文档: " + totalMatched);
if (!DRY_RUN) {
    print("  实际更新文档: " + totalUpdated);
}
print("======================================================");

if (DRY_RUN) {
    print("");
    print("【DRY RUN】未做任何写入。确认上面的命中数后, 用以下命令真正执行:");
    print("  mongosh \"<connection-string>\" --eval \"var DRY_RUN=false\" " +
        "scripts/migrations/replace-cdn-domain.js");
}
