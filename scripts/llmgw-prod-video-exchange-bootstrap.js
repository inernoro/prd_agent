// Idempotently create a Volcengine Seedance video exchange and bind production
// video-gen model pools to it. Run through
// scripts/llmgw-prod-video-exchange-bootstrap.sh so production data is backed
// up first in execute mode.

const dryRunRaw = (process.env.LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_DRY_RUN || "1").toLowerCase();
const dryRun = !(dryRunRaw === "0" || dryRunRaw === "false");
const exchangeId = process.env.LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_EXCHANGE_ID || "volcengine-seedance-video";
const exchangeName = process.env.LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_EXCHANGE_NAME || "火山方舟 Seedance 视频生成";
const poolId = process.env.LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_POOL_ID || "video_seedance_2_0_fast_pool";
const poolName = process.env.LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_POOL_NAME || "视频 Seedance 2.0 Fast";
const poolCode = process.env.LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_POOL_CODE || "video-seedance-2-fast";
const modelId = process.env.LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_MODEL_ID || "doubao-seedance-2-0-fast-260128";
const modelDisplayName = process.env.LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_MODEL_DISPLAY_NAME || "Doubao Seedance 2.0 Fast";
const targetUrl = process.env.LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_TARGET_URL || "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks";
const sourcePlatformId = process.env.LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_SOURCE_PLATFORM_ID || "";
const resetHealthRaw = (process.env.LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_RESET_HEALTH || "0").toLowerCase();
const resetHealth = resetHealthRaw === "1" || resetHealthRaw === "true";
const bindCallersRaw = (process.env.LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_BIND_CALLERS || "1").toLowerCase();
const bindCallers = !(bindCallersRaw === "0" || bindCallersRaw === "false");
const targetCallersRaw = process.env.LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_TARGET_CALLERS || "video-agent.videogen::video-gen,visual-agent.videogen::video-gen";
const targetCallers = targetCallersRaw.split(/[,\s]+/).map((x) => x.trim()).filter((x) => x.length > 0);

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

function requirementFor(caller, modelType) {
  return (caller.ModelRequirements || []).find((req) => String(req.ModelType || "").toLowerCase() === modelType);
}

function findSourcePlatform() {
  if (sourcePlatformId) {
    const exact = db.llmplatforms.findOne({ _id: sourcePlatformId });
    if (!exact) fail(`source Volcengine platform not found: ${sourcePlatformId}`);
    return exact;
  }

  const fromPool = db.model_groups.findOne({
    _id: poolId,
    ModelType: "video-gen",
    "Models.ModelId": modelId,
  });
  const poolModel = fromPool && (fromPool.Models || []).find((m) => m.ModelId === modelId);
  if (poolModel && poolModel.PlatformId) {
    const platform = db.llmplatforms.findOne({ _id: poolModel.PlatformId });
    if (platform && /volces\.com\/api\/v3/i.test(platform.ApiUrl || "")) return platform;
  }

  return db.llmplatforms.findOne({
    Enabled: true,
    ApiUrl: /ark\.cn-.*volces\.com\/api\/v3/i,
    ApiKeyEncrypted: { $exists: true, $ne: "" },
  });
}

const sourcePlatform = findSourcePlatform();
if (!sourcePlatform) {
  fail("enabled Volcengine Ark platform with encrypted key not found");
}
if (!sourcePlatform.ApiKeyEncrypted) {
  fail(`source Volcengine platform has no encrypted key: ${sourcePlatform.Name || sourcePlatform._id}`);
}

const missingCallers = targetCallers.filter((code) => !db.llm_app_callers.findOne({ AppCode: code }));
if (missingCallers.length > 0) {
  fail(`target video appCallers missing: ${missingCallers.join(", ")}`);
}

const now = new Date();
const existingPool = db.model_groups.findOne({ _id: poolId });
let nextHealthStatus = 0;
let nextLastFailedAt = null;
let nextConsecutiveFailures = 0;
if (existingPool) {
  const existingModel = (existingPool.Models || []).find((m) => m.ModelId === modelId);
  if (existingModel && !resetHealth) {
    nextHealthStatus = existingModel.HealthStatus === undefined ? 0 : existingModel.HealthStatus;
    nextLastFailedAt = existingModel.LastFailedAt || null;
    nextConsecutiveFailures = existingModel.ConsecutiveFailures || 0;
  }
}

const planned = {
  dryRun,
  exchangeId,
  exchangeName,
  transformerType: "volcengine-video",
  targetUrl,
  modelId,
  poolId,
  resetHealth,
  bindCallers,
  targetCallers,
  sourcePlatformId: sourcePlatform._id,
  sourcePlatformName: sourcePlatform.Name,
  sourcePlatformApiUrl: sourcePlatform.ApiUrl,
  keySource: "llmplatforms.ApiKeyEncrypted copied to model_exchanges.TargetApiKeyEncrypted",
  nextHealthStatus,
};
printjson(planned);

if (dryRun) {
  print("LLM Gateway video exchange bootstrap dry-run: no data changed");
  quit(0);
}

db.model_exchanges.updateOne(
  { _id: exchangeId },
  {
    $setOnInsert: { CreatedAt: now },
    $set: {
      Name: exchangeName,
      ModelAlias: modelId,
      ModelAliases: [modelId],
      Models: [
        {
          ModelId: modelId,
          DisplayName: modelDisplayName,
          ModelType: "video-gen",
          Description: "火山方舟 Seedance 原生异步视频生成模型",
          Enabled: true,
        },
      ],
      TargetUrl: targetUrl,
      TargetApiKeyEncrypted: sourcePlatform.ApiKeyEncrypted,
      TargetAuthScheme: "Bearer",
      TransformerType: "volcengine-video",
      TransformerConfig: {
        sourcePlatformId: sourcePlatform._id,
        sourcePlatformName: sourcePlatform.Name,
      },
      Enabled: true,
      Description: "LLM Gateway 视频发布门默认 exchange：把 MAP OpenRouter 视频请求转换为火山方舟 contents/generations/tasks。",
      UpdatedAt: now,
    },
  },
  { upsert: true },
);

db.model_groups.updateOne(
  { _id: poolId },
  {
    $setOnInsert: { CreatedAt: now },
    $set: {
      Name: poolName,
      Code: poolCode,
      Priority: 10,
      ModelType: "video-gen",
      IsDefaultForType: false,
      Models: [
        {
          ModelId: modelId,
          PlatformId: exchangeId,
          Priority: 1,
          HealthStatus: nextHealthStatus,
          LastFailedAt: nextLastFailedAt,
          LastSuccessAt: null,
          ConsecutiveFailures: nextConsecutiveFailures,
          ConsecutiveSuccesses: 0,
          EnablePromptCache: false,
          MaxTokens: null,
          InputPricePerMillion: null,
          OutputPricePerMillion: null,
          PricePerCall: null,
        },
      ],
      StrategyType: 0,
      Description: "LLM Gateway 视频发布门默认池：Seedance 通过 volcengine-video exchange 调用。",
      UpdatedAt: now,
    },
  },
  { upsert: true },
);

if (bindCallers) {
  for (const code of targetCallers) {
    const caller = db.llm_app_callers.findOne({ AppCode: code });
    const requirements = caller.ModelRequirements || [];
    let found = false;
    const nextRequirements = requirements.map((req) => {
      if (String(req.ModelType || "").toLowerCase() !== "video-gen") return req;
      found = true;
      return {
        ...req,
        ModelGroupIds: uniq([poolId, ...(req.ModelGroupIds || [])]),
        ModelGroupId: poolId,
        IsRequired: req.IsRequired !== false,
      };
    });
    if (!found) {
      nextRequirements.push({
        ModelType: "video-gen",
        Purpose: `用于 ${caller.DisplayName || code}`,
        ModelGroupIds: [poolId],
        ModelGroupId: poolId,
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
  print("LLM Gateway video exchange bootstrap: caller binding skipped");
}

print("LLM Gateway video exchange bootstrap completed");
