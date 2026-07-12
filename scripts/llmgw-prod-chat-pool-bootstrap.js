// Idempotently put a verified chat model at the front of a production chat pool.
// Run through scripts/llmgw-prod-chat-pool-bootstrap.sh so production data is
// backed up first in execute mode.
//
// Keep all work inside an IIFE. mongosh echoes some top-level assignment
// expressions when reading from stdin; wrapping avoids accidental DB document
// echoes in production dry-runs.

(function main() {
const dryRunRaw = (process.env.LLMGW_CHAT_BOOTSTRAP_DRY_RUN || "1").toLowerCase();
const dryRun = !(dryRunRaw === "0" || dryRunRaw === "false");
const modelName = process.env.LLMGW_CHAT_BOOTSTRAP_MODEL_NAME || "deepseek-ai/DeepSeek-V4-Flash";
const requestedPlatformId = (process.env.LLMGW_CHAT_BOOTSTRAP_PLATFORM_ID || "").trim();
const requestedPoolId = (process.env.LLMGW_CHAT_BOOTSTRAP_POOL_ID || "").trim();
const requestedPoolCode = (process.env.LLMGW_CHAT_BOOTSTRAP_POOL_CODE || "report-agent-weekly").trim();
const requestedPoolName = (process.env.LLMGW_CHAT_BOOTSTRAP_POOL_NAME || "周报生成专属池").trim();
const targetCallersRaw = process.env.LLMGW_CHAT_BOOTSTRAP_TARGET_CALLERS || "report-agent.generate::chat";
const targetCallers = targetCallersRaw.split(/[,\s]+/).map((x) => x.trim()).filter((x) => x.length > 0);
const bindCallersRaw = (process.env.LLMGW_CHAT_BOOTSTRAP_BIND_CALLERS || "1").toLowerCase();
const bindCallers = !(bindCallersRaw === "0" || bindCallersRaw === "false");
const isolatePoolRaw = (process.env.LLMGW_CHAT_BOOTSTRAP_ISOLATE_POOL || "1").toLowerCase();
const isolatePool = !(isolatePoolRaw === "0" || isolatePoolRaw === "false");
const requestedPriority = Number.parseInt(process.env.LLMGW_CHAT_BOOTSTRAP_PRIORITY || "1", 10);
const priority = Number.isFinite(requestedPriority) && requestedPriority > 0 ? requestedPriority : 1;
const gatewayDbName = (process.env.LLMGW_CHAT_BOOTSTRAP_GW_DB || "llm_gateway").trim();
// 这是服务端部署配置，不是 HTTP 请求参数。租户范围优先从 GW 权威 caller 读取；
// 只有旧 full-http 数据尚未回填 TenantId 时，才使用与 console-api 相同的内部租户默认值。
const configuredInternalTenantId = (process.env.LLMGW_INTERNAL_TENANT_ID || "tenant_map_internal").trim();

function fail(message) {
  print(`ERROR: ${message}`);
  quit(1);
}

function uniq(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function modelSortValue(model) {
  const value = Number(model.Priority);
  return Number.isFinite(value) ? value : 1000000;
}

function legacyOrTenantFilter(tenantId) {
  return {
    $or: [
      { TenantId: tenantId },
      { TenantId: { $exists: false } },
      { TenantId: null },
      { TenantId: "" },
    ],
  };
}

function exactCallerCandidates(collection, code) {
  return collection.find({
    AppCallerCode: code,
    RequestType: "chat",
  }).toArray();
}

const modelQuery = { Enabled: true, ModelName: modelName };
if (requestedPlatformId) {
  modelQuery.PlatformId = requestedPlatformId;
}

const candidates = db.llmmodels.find(modelQuery).sort({ Priority: 1, CreatedAt: 1 }).toArray();
if (candidates.length === 0) {
  fail(`enabled LLMModel not found for ModelName=${modelName}${requestedPlatformId ? ` platform=${requestedPlatformId}` : ""}`);
}

let selectedModel = null;
let selectedPlatform = null;
for (const candidate of candidates.sort((a, b) => modelSortValue(a) - modelSortValue(b))) {
  const platform = db.llmplatforms.findOne({ _id: candidate.PlatformId, Enabled: true });
  if (platform) {
    selectedModel = candidate;
    selectedPlatform = platform;
    break;
  }
}

if (!selectedModel || !selectedPlatform) {
  fail(`no enabled platform found for ModelName=${modelName}`);
}

const missingCallers = targetCallers.filter((code) => !db.llm_app_callers.findOne({ AppCode: code }));
if (missingCallers.length > 0) {
  fail(`chat appCallers missing: ${missingCallers.join(", ")}`);
}

let pool = null;
let poolWillBeCreated = false;
if (requestedPoolId) {
  pool = db.model_groups.findOne({ _id: requestedPoolId, ModelType: "chat" });
  if (!pool) fail(`target chat pool missing or not chat: ${requestedPoolId}`);
  if (isolatePool && String(pool.Code || "") !== requestedPoolCode) {
    fail(`isolated bootstrap refuses pool with Code=${pool.Code || "<empty>"}; expected ${requestedPoolCode}`);
  }
} else {
  pool = db.model_groups.findOne({ Code: requestedPoolCode, ModelType: "chat" });
  if (!pool) {
    const now = new Date();
    pool = {
      _id: new ObjectId().toString(),
      Name: requestedPoolName,
      Code: requestedPoolCode,
      Priority: 10,
      ModelType: "chat",
      IsDefaultForType: false,
      Models: [],
      StrategyType: 0,
      Description: "周报草稿生成专用；模型不可用时失败，不允许漂移到通用大池",
      CreatedAt: now,
      UpdatedAt: now,
    };
    poolWillBeCreated = true;
  }
}

const modelItem = {
  ModelId: modelName,
  PlatformId: selectedPlatform._id,
  Priority: priority,
  Protocol: selectedModel.Protocol || null,
  HealthStatus: 0,
  LastFailedAt: null,
  LastSuccessAt: new Date(),
  ConsecutiveFailures: 0,
  ConsecutiveSuccesses: 1,
  EnablePromptCache: selectedModel.EnablePromptCache ?? null,
  MaxTokens: selectedModel.MaxTokens ?? null,
  InputPricePerMillion: null,
  OutputPricePerMillion: null,
  PricePerCall: null,
};

if (isolatePool && targetCallers.length !== 1) {
  fail(`isolated GW authority bootstrap requires exactly one target caller; got ${targetCallers.length}`);
}
if (targetCallers.length === 0) {
  fail("chat pool bootstrap requires at least one target caller");
}
if (isolatePool && !bindCallers) {
  fail("isolated GW authority bootstrap requires caller binding");
}

const gatewayDb = db.getSiblingDB(gatewayDbName);
const gatewayCallerCandidates = exactCallerCandidates(gatewayDb.llmgw_app_callers, targetCallers[0]);
if (gatewayCallerCandidates.length !== 1) {
  fail(`GW authority caller must resolve exactly once for ${targetCallers[0]}; got ${gatewayCallerCandidates.length}`);
}

const gatewayCaller = gatewayCallerCandidates[0];
const callerTenantId = String(gatewayCaller.TenantId || "").trim();
const tenantId = callerTenantId || configuredInternalTenantId;
if (!tenantId) {
  fail("GW authority caller has no TenantId and server internal tenant configuration is empty");
}

const tenantScope = legacyOrTenantFilter(tenantId);
const gatewayCodePools = gatewayDb.llmgw_model_pools.find({
  Code: requestedPoolCode,
  ModelType: "chat",
  ...tenantScope,
}).toArray();
if (gatewayCodePools.length > 1) {
  fail(`GW authority pool is ambiguous for tenant=${tenantId} code=${requestedPoolCode}; got ${gatewayCodePools.length}`);
}

let gatewayPool = gatewayCodePools[0] || null;
let gatewayPoolWillBeCreated = false;
if (gatewayPool && gatewayPool.IsDefaultForType === true) {
  fail(`isolated GW authority pool must not be default: ${gatewayPool._id}`);
}
if (!gatewayPool) {
  const conflictingId = gatewayDb.llmgw_model_pools.findOne({ _id: pool._id });
  if (conflictingId) {
    fail(`GW authority pool id is already used by another pool: ${pool._id}`);
  }
  const now = new Date();
  gatewayPool = {
    _id: pool._id,
    TenantId: tenantId,
    Name: requestedPoolName,
    Code: requestedPoolCode,
    Priority: 10,
    ModelType: "chat",
    IsDefaultForType: false,
    Models: [],
    StrategyType: 0,
    Description: "周报草稿生成专用；模型不可用时失败，不允许漂移到通用大池",
    ConfigAuthority: "llm_gateway",
    CreatedAt: now,
    UpdatedAt: now,
  };
  gatewayPoolWillBeCreated = true;
}

const otherGatewayReferences = gatewayDb.llmgw_app_callers.find({
  ModelPoolId: gatewayPool._id,
  _id: { $ne: gatewayCaller._id },
  ...tenantScope,
}, { AppCallerCode: 1 }).toArray();
if (otherGatewayReferences.length > 0) {
  fail(`isolated GW authority pool is referenced by other callers: ${otherGatewayReferences.map((x) => x.AppCallerCode).join(", ")}`);
}

const currentGatewayPoolId = String(gatewayCaller.ModelPoolId || "").trim();
const currentGatewayPool = currentGatewayPoolId
  ? gatewayDb.llmgw_model_pools.findOne({ _id: currentGatewayPoolId, ...tenantScope })
  : null;
const currentGatewayMembers = currentGatewayPool && Array.isArray(currentGatewayPool.Models)
  ? currentGatewayPool.Models
  : [];
const currentGatewayMember = currentGatewayMembers.find((item) => {
  return String(item.ModelId || "") === modelName
    && String(item.PlatformId || "") === String(selectedPlatform._id);
});

const gatewayModel = gatewayDb.llmgw_models.findOne({
  $and: [
    {
      $or: [
        { _id: modelName },
        { ModelName: modelName },
        { Name: modelName },
      ],
    },
    { PlatformId: selectedPlatform._id },
    tenantScope,
  ],
});
const gatewayPlatform = gatewayDb.llmgw_platforms.findOne({
  _id: selectedPlatform._id,
  ...tenantScope,
});
if (!currentGatewayMember && (!gatewayModel || !gatewayPlatform)) {
  fail(`verified model is not available in GW authority for tenant=${tenantId}: ${modelName}`);
}

const gatewayModelItem = {
  ...(currentGatewayMember || modelItem),
  ModelId: modelName,
  PlatformId: selectedPlatform._id,
  Priority: priority,
};

const planned = {
  dryRun,
  poolId: pool._id,
  poolName: pool.Name,
  poolCode: pool.Code,
  poolWillBeCreated,
  modelName,
  platformId: selectedPlatform._id,
  platformName: selectedPlatform.Name,
  priority,
  bindCallers,
  isolatePool,
  targetCallers,
  gatewayAuthority: {
    database: gatewayDbName,
    tenantId,
    tenantSource: callerTenantId ? "caller" : "server-internal-default",
    callerId: gatewayCaller._id,
    callerCurrentPoolId: currentGatewayPoolId,
    poolId: gatewayPool._id,
    poolWillBeCreated: gatewayPoolWillBeCreated,
    otherReferenceCount: otherGatewayReferences.length,
    memberCountAfter: 1,
    isDefaultAfter: false,
  },
};
printjson(planned);

if (dryRun) {
  print("LLM Gateway chat pool bootstrap dry-run: MAP and GW authority data unchanged");
  quit(0);
}

const now = new Date();
if (poolWillBeCreated) {
  db.model_groups.insertOne(pool);
}
const existingModels = pool.Models || [];
const remainingModels = existingModels.filter((item) => {
  return !(String(item.ModelId || "") === modelName && String(item.PlatformId || "") === String(selectedPlatform._id));
});
const nextModels = isolatePool ? [modelItem] : [modelItem, ...remainingModels];

db.model_groups.updateOne(
  { _id: pool._id },
  {
    $set: {
      Models: nextModels,
      UpdatedAt: now,
    },
  },
);

if (bindCallers) {
  for (const code of targetCallers) {
    const caller = db.llm_app_callers.findOne({ AppCode: code });
    const requirements = caller.ModelRequirements || [];
    let found = false;
    const nextRequirements = requirements.map((req) => {
      if (String(req.ModelType || "").toLowerCase() !== "chat") return req;
      found = true;
      return {
        ...req,
        ModelGroupIds: isolatePool ? [pool._id] : uniq([pool._id, ...(req.ModelGroupIds || [])]),
        ModelGroupId: pool._id,
        IsRequired: req.IsRequired !== false,
      };
    });
    if (!found) {
      nextRequirements.push({
        ModelType: "chat",
        Purpose: `用于 ${caller.DisplayName || code}`,
        ModelGroupIds: [pool._id],
        ModelGroupId: pool._id,
        IsRequired: true,
      });
    }

    db.llm_app_callers.updateOne(
      { _id: caller._id },
      {
        $set: {
          ModelRequirements: nextRequirements,
          UpdatedAt: now,
        },
      },
    );
  }
} else {
  print("LLM Gateway chat pool bootstrap: caller binding skipped");
}

if (gatewayPoolWillBeCreated) {
  gatewayDb.llmgw_model_pools.insertOne(gatewayPool);
}
gatewayDb.llmgw_model_pools.updateOne(
  { _id: gatewayPool._id, ...legacyOrTenantFilter(tenantId) },
  {
    $set: {
      TenantId: tenantId,
      Name: requestedPoolName,
      Code: requestedPoolCode,
      Priority: 10,
      ModelType: "chat",
      IsDefaultForType: false,
      Models: [gatewayModelItem],
      StrategyType: 0,
      Description: "周报草稿生成专用；模型不可用时失败，不允许漂移到通用大池",
      ConfigAuthority: "llm_gateway",
      UpdatedAt: now,
    },
  },
);

if (bindCallers) {
  const callerWriteFilter = callerTenantId
    ? { _id: gatewayCaller._id, TenantId: tenantId, AppCallerCode: targetCallers[0], RequestType: "chat" }
    : { _id: gatewayCaller._id, AppCallerCode: targetCallers[0], RequestType: "chat", ...legacyOrTenantFilter(tenantId) };
  const callerWrite = gatewayDb.llmgw_app_callers.updateOne(
    callerWriteFilter,
    {
      $set: {
        TenantId: tenantId,
        ModelPoolId: gatewayPool._id,
        ModelPolicy: "pool",
        UpdatedAt: now,
      },
    },
  );
  if (callerWrite.matchedCount !== 1) {
    fail(`GW authority caller changed during apply; matched=${callerWrite.matchedCount}`);
  }
}

gatewayDb.llmgw_operation_audits.insertOne({
  _id: new ObjectId().toString(),
  TenantId: tenantId,
  Action: "report_agent.pool.isolate",
  TargetType: "llmgw_app_caller",
  TargetId: String(gatewayCaller._id),
  TargetName: targetCallers[0],
  Success: true,
  Reason: null,
  Changes: {
    previousPoolId: currentGatewayPoolId || null,
    modelPoolId: String(gatewayPool._id),
    modelPolicy: "pool",
    modelId: modelName,
    memberCount: 1,
    authority: "llm_gateway",
  },
  CreatedAt: now,
});

const verifiedGatewayPool = gatewayDb.llmgw_model_pools.findOne({
  _id: gatewayPool._id,
  TenantId: tenantId,
  Code: requestedPoolCode,
  ModelType: "chat",
  IsDefaultForType: false,
});
const verifiedGatewayCaller = gatewayDb.llmgw_app_callers.findOne({
  _id: gatewayCaller._id,
  TenantId: tenantId,
  AppCallerCode: targetCallers[0],
  RequestType: "chat",
  ModelPoolId: gatewayPool._id,
  ModelPolicy: "pool",
});
const verifiedMembers = verifiedGatewayPool && Array.isArray(verifiedGatewayPool.Models)
  ? verifiedGatewayPool.Models
  : [];
if (!verifiedGatewayCaller || verifiedMembers.length !== 1
    || String(verifiedMembers[0].ModelId || "") !== modelName
    || String(verifiedMembers[0].PlatformId || "") !== String(selectedPlatform._id)) {
  fail("GW authority post-write verification failed");
}

printjson({
  verified: true,
  tenantId,
  appCallerCode: targetCallers[0],
  modelPolicy: "pool",
  poolId: gatewayPool._id,
  poolCode: requestedPoolCode,
  memberCount: verifiedMembers.length,
  modelName,
  platformId: selectedPlatform._id,
});

print("LLM Gateway chat pool bootstrap completed");
})();
