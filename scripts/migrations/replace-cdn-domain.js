// MongoDB 字符串查找替换: pa.759800.com → map.ebcone.net
//
// 用法:
//   # 1) Dry-run (默认, 不写入)
//   mongosh "mongodb://user:pwd@host:port/prd_agent" scripts/migrations/replace-cdn-domain.js
//
//   # 2) 真正执行
//   mongosh "mongodb://..." --eval "var DRY_RUN=false" scripts/migrations/replace-cdn-domain.js
//
// 也可以覆盖默认域名:
//   mongosh "..." --eval "var OLD='a.com'; var NEW='b.com'; var DRY_RUN=false" scripts/migrations/replace-cdn-domain.js

if (typeof OLD === "undefined") { var OLD = "pa.759800.com"; }
if (typeof NEW === "undefined") { var NEW = "map.ebcone.net"; }
if (typeof DRY_RUN === "undefined") { var DRY_RUN = true; }

// 递归把任意值里的字符串子串 OLD 替换成 NEW, 返回 {value, changed}
function walk(v) {
    if (typeof v === "string") {
        if (v.indexOf(OLD) === -1) return { value: v, changed: false };
        return { value: v.split(OLD).join(NEW), changed: true };
    }
    if (Array.isArray(v)) {
        var arr = [], chg = false;
        for (var i = 0; i < v.length; i++) {
            var r = walk(v[i]);
            if (r.changed) chg = true;
            arr.push(r.value);
        }
        return { value: arr, changed: chg };
    }
    if (v && typeof v === "object" && !v._bsontype && !(v instanceof Date)) {
        var obj = {}, chg2 = false;
        var keys = Object.keys(v);
        for (var k = 0; k < keys.length; k++) {
            var r2 = walk(v[keys[k]]);
            if (r2.changed) chg2 = true;
            obj[keys[k]] = r2.value;
        }
        return { value: obj, changed: chg2 };
    }
    return { value: v, changed: false };
}

print("DB=" + db.getName() + "  " + OLD + " → " + NEW + "  " + (DRY_RUN ? "[DRY RUN]" : "[WRITE]"));

var totalMatched = 0, totalUpdated = 0;
var collections = db.getCollectionNames().sort();

for (var ci = 0; ci < collections.length; ci++) {
    var name = collections[ci];
    if (name.indexOf("system.") === 0) continue;

    var coll = db.getCollection(name);
    var matched = 0, updated = 0;
    var cursor = coll.find({}).batchSize(500);

    while (cursor.hasNext()) {
        var doc = cursor.next();
        var r = walk(doc);
        if (!r.changed) continue;
        matched++;
        if (!DRY_RUN) {
            coll.replaceOne({ _id: doc._id }, r.value);
            updated++;
        }
    }

    if (matched > 0) {
        print("  " + name + ": matched=" + matched + (DRY_RUN ? "" : " updated=" + updated));
        totalMatched += matched;
        totalUpdated += updated;
    }
}

print("");
print("Total: matched=" + totalMatched + (DRY_RUN ? "" : " updated=" + totalUpdated));
if (DRY_RUN) print("DRY RUN — 加 --eval \"var DRY_RUN=false\" 真正执行");
