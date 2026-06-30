// LLM 网关统一 — Phase 0 取证脚本
// 关联设计：doc/design.llm-gateway-unification.md §9.2
//
// 目的：删除任何"疑似死代码"（策略引擎 / legacy 层 / orphan code）之前，
//       用真实库数据确认影响面。纯只读，不写任何集合。
//
// 运行：
//   mongosh "<连接串>/<dbName>" scripts/llm-gateway-phase0-forensics.mongo.js
//   或在 mongosh 里：load('scripts/llm-gateway-phase0-forensics.mongo.js')
//
// 注意：MongoDB 字段大小写取决于序列化约定。若某段输出为空，
//       先用本脚本顶部的 "SCHEMA PEEK" 看真实字段名，再调整下方聚合的字段路径。

function hr(t){ print('\n========== ' + t + ' =========='); }

// ---------- SCHEMA PEEK：先看真实字段名，避免大小写踩坑 ----------
hr('SCHEMA PEEK（各集合一条样本，确认字段大小写）');
['model_groups','llm_app_callers','model_exchanges','llmmodels','llmplatforms']
  .forEach(c => {
    const doc = db.getCollection(c).findOne();
    print('\n-- ' + c + ' --');
    print(doc ? JSON.stringify(Object.keys(doc)) : '(空集合或不存在)');
  });

// ---------- 问题1/2：策略引擎是否有人配（决定能否删 6 个策略） ----------
hr('1. model_groups.StrategyType 分布（全为 0=FailFast 则策略引擎可删）');
printjson(db.model_groups.aggregate([
  { $group: { _id: { $ifNull: ['$StrategyType', '$strategyType'] }, count: { $sum: 1 } } },
  { $sort: { _id: 1 } }
]).toArray());

hr('1b. 池总数 / 默认池数 / 每 ModelType 的池数');
print('池总数: ' + db.model_groups.countDocuments({}));
printjson(db.model_groups.aggregate([
  { $group: {
      _id: { $ifNull: ['$ModelType', '$modelType'] },
      pools: { $sum: 1 },
      defaults: { $sum: { $cond: [{ $ifNull: ['$IsDefaultForType', '$isDefaultForType'] }, 1, 0] } }
  } },
  { $sort: { _id: 1 } }
]).toArray());

// ---------- 问题3：appCallerCode 降级影响面 ----------
hr('2. llm_app_callers 总数 / 真有专属池绑定的数量（决定 code 降级影响面）');
const callers = db.llm_app_callers.find({}).toArray();
print('app_callers 总数: ' + callers.length);
let withBinding = 0, reqWithBinding = 0;
callers.forEach(c => {
  const reqs = c.ModelRequirements || c.modelRequirements || [];
  let any = false;
  reqs.forEach(r => {
    const ids = r.ModelGroupIds || r.modelGroupIds || [];
    if (ids.length > 0) { any = true; reqWithBinding++; }
  });
  if (any) withBinding++;
});
print('有>=1条专属池绑定的 caller 数: ' + withBinding);
print('非空 ModelGroupIds 的 requirement 条数: ' + reqWithBinding);
print('=> 其余 ' + (callers.length - withBinding) + ' 个 caller 可直接降级为纯标签（零绑定，走默认池）');

// ---------- 问题3：orphan code（registry 已无、库里还在）数量 ----------
// 注：registry 现有 156 条。此处只统计 IsSystemDefault 维度，
//     真正的 orphan 需与代码 registry 求差集（迁移时由 sync 对账逻辑产出）。
hr('3. 按 IsSystemDefault 拆分（user-custom 不可动，system-default 可对账软删）');
printjson(db.llm_app_callers.aggregate([
  { $group: { _id: { $ifNull: ['$IsSystemDefault', '$isSystemDefault'] }, count: { $sum: 1 } } }
]).toArray());

// ---------- 问题4：图片各协议真实占比（决定收敛优先级） ----------
hr('4. 近 30 天图片请求按协议/Exchange 占比（RequestType=generation/imagegen）');
const since = new Date(Date.now() - 30*24*3600*1000);
printjson(db.llmrequestlogs.aggregate([
  { $match: {
      $and: [
        { $or: [ { StartedAt: { $gte: since } }, { startedAt: { $gte: since } } ] },
        { $or: [
            { RequestType: { $in: ['generation','imagegen'] } },
            { requestType: { $in: ['generation','imagegen'] } }
        ] }
      ]
  } },
  { $group: {
      _id: {
        isExchange: { $ifNull: ['$IsExchange', '$isExchange'] },
        transformer: { $ifNull: ['$ExchangeTransformerType', '$exchangeTransformerType'] }
      },
      count: { $sum: 1 }
  } },
  { $sort: { count: -1 } }
]).toArray());

// ---------- 问题4：多少模型依赖 Exchange（决定退役节奏） ----------
hr('5. model_exchanges 启用数 + 池里指向 Exchange 的 item 数');
print('启用的 exchange 数: ' + db.model_exchanges.countDocuments(
  { $or: [ { Enabled: true }, { enabled: true } ] }));
// 池 item 里 PlatformId == "__exchange__" 或等于某个 exchange.Id 的，视为依赖 exchange
const exIds = db.model_exchanges.find({}, { _id: 1 }).toArray().map(x => String(x._id));
let exItemRefs = 0;
db.model_groups.find({}).toArray().forEach(g => {
  (g.Models || g.models || []).forEach(m => {
    const pid = String(m.PlatformId || m.platformId || '');
    if (pid === '__exchange__' || exIds.indexOf(pid) >= 0) exItemRefs++;
  });
});
print('池中依赖 exchange 的 item 数: ' + exItemRefs);

// ---------- 问题2：legacy 标记仍在用多少（决定迁移量） ----------
hr('6. llmmodels 上 legacy 标记的启用数量（迁进默认池后即可删第 3 层）');
['IsMain','IsIntent','IsVision','IsImageGen'].forEach(f => {
  const lower = f.charAt(0).toLowerCase() + f.slice(1);
  const n = db.llmmodels.countDocuments({ $or: [ { [f]: true }, { [lower]: true } ] });
  print('  ' + f + ' = true 的模型数: ' + n);
});

hr('取证完成。把以上输出回贴给我，我据此填 design 文档 §9.2 并定 P3 删除清单。');
