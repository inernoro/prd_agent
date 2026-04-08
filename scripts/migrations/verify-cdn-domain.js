// 只读验证脚本: 扫描所有集合, 列出仍然包含旧 CDN 域名的字段路径与样例。
// 用于迁移前后的核对, 不会写入任何数据。
//
// 用法:
//   mongosh "mongodb://user:pwd@host:port/prd_agent" scripts/migrations/verify-cdn-domain.js
//
// 输出:
//   - 每个命中的集合: 命中文档数 + 命中字段路径(去重) + 一条样例 _id
//   - 总命中集合/文档数

if (typeof OLD_DOMAIN === "undefined") { var OLD_DOMAIN = "i.pa.759800.com"; }
if (typeof MAX_PATHS_PER_COLLECTION === "undefined") { var MAX_PATHS_PER_COLLECTION = 30; }

function isPlainObject(v) {
    if (v === null || typeof v !== "object") return false;
    if (Array.isArray(v)) return false;
    if (v._bsontype) return false;
    if (v instanceof Date) return false;
    return true;
}

// 递归收集包含 OLD_DOMAIN 的字段路径
function findPaths(value, prefix, out) {
    if (typeof value === "string") {
        if (value.indexOf(OLD_DOMAIN) !== -1) {
            out.add(prefix || "(root)");
        }
        return;
    }
    if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i++) {
            findPaths(value[i], prefix + "[]", out);
        }
        return;
    }
    if (isPlainObject(value)) {
        var keys = Object.keys(value);
        for (var k = 0; k < keys.length; k++) {
            var key = keys[k];
            findPaths(value[key], prefix ? prefix + "." + key : key, out);
        }
    }
}

print("======================================================");
print("CDN 域名残留扫描 (只读)");
print("  数据库: " + db.getName());
print("  关键词: " + OLD_DOMAIN);
print("======================================================");

var allCollections = db.getCollectionNames().sort();
var hitSummary = [];
var totalHitDocs = 0;

for (var ci = 0; ci < allCollections.length; ci++) {
    var collName = allCollections[ci];
    if (collName.indexOf("system.") === 0) continue;

    var coll = db.getCollection(collName);
    var cursor = coll.find({}).batchSize(500);

    var hitDocs = 0;
    var pathSet = new Set();
    var sampleId = null;

    while (cursor.hasNext()) {
        var doc = cursor.next();
        var pathsInDoc = new Set();
        findPaths(doc, "", pathsInDoc);
        if (pathsInDoc.size > 0) {
            hitDocs++;
            if (sampleId === null) sampleId = doc._id;
            pathsInDoc.forEach(function (p) { pathSet.add(p); });
        }
    }

    if (hitDocs > 0) {
        hitSummary.push({ name: collName, hits: hitDocs, paths: pathSet, sampleId: sampleId });
        totalHitDocs += hitDocs;
    }
}

if (hitSummary.length === 0) {
    print("");
    print("✅ 未发现任何文档包含 " + OLD_DOMAIN + " - 迁移已干净。");
} else {
    print("");
    print("命中明细 (按集合):");
    print("");
    for (var i = 0; i < hitSummary.length; i++) {
        var s = hitSummary[i];
        print("  " + s.name + "  (" + s.hits + " 个文档)");
        print("    样例 _id: " + tojsononeline(s.sampleId));
        var pathArr = Array.from(s.paths).sort();
        var shown = pathArr.slice(0, MAX_PATHS_PER_COLLECTION);
        for (var j = 0; j < shown.length; j++) {
            print("      - " + shown[j]);
        }
        if (pathArr.length > shown.length) {
            print("      … (" + (pathArr.length - shown.length) + " more)");
        }
        print("");
    }
    print("======================================================");
    print("汇总: " + hitSummary.length + " 个集合, " + totalHitDocs + " 个文档仍含旧域名");
    print("======================================================");
}
