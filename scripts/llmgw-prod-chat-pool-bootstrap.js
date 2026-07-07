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
const targetCallersRaw = process.env.LLMGW_CHAT_BOOTSTRAP_TARGET_CALLERS || "report-agent.generate::chat";
const targetCallers = targetCallersRaw.split(/[,\s]+/).map((x) => x.trim()).filter((x) => x.length > 0);
const bindCallersRaw = (process.env.LLMGW_CHAT_BOOTSTRAP_BIND_CALLERS || "1").toLowerCase();
const bindCallers = !(bindCallersRaw === "0" || bindCallersRaw === "false");
const requestedPriority = Number.parseInt(process.env.LLMGW_CHAT_BOOTSTRAP_PRIORITY || "1", 10);
const priority = Number.isFinite(requestedPriority) && requestedPriority > 0 ? requestedPriority : 1;

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

function modelSortValue(model) {
  const value = Number(model.Priority);
  return Number.isFinite(value) ? value : 1000000;
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

let poolId = requestedPoolId;
if (!poolId) {
  for (const code of targetCallers) {
    const caller = db.llm_app_callers.findOne({ AppCode: code });
    const req = requirementFor(caller, "chat");
    const ids = uniq([req && req.ModelGroupId, ...((req && req.ModelGroupIds) || [])]);
    if (ids.length > 0) {
      poolId = ids[0];
      break;
    }
  }
}

if (!poolId) {
  const defaultPool = db.model_groups.findOne({ ModelType: "chat", IsDefaultForType: true }, { sort: { Priority: 1 } });
  if (defaultPool) poolId = defaultPool._id;
}

if (!poolId) {
  fail("no target chat pool found; set LLMGW_CHAT_BOOTSTRAP_POOL_ID");
}

const pool = db.model_groups.findOne({ _id: poolId, ModelType: "chat" });
if (!pool) {
  fail(`target chat pool missing or not chat: ${poolId}`);
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

const planned = {
  dryRun,
  poolId,
  poolName: pool.Name,
  modelName,
  platformId: selectedPlatform._id,
  platformName: selectedPlatform.Name,
  priority,
  bindCallers,
  targetCallers,
};
printjson(planned);

if (dryRun) {
  print("LLM Gateway chat pool bootstrap dry-run: no data changed");
  quit(0);
}

const now = new Date();
const existingModels = pool.Models || [];
const remainingModels = existingModels.filter((item) => {
  return !(String(item.ModelId || "") === modelName && String(item.PlatformId || "") === String(selectedPlatform._id));
});
const nextModels = [modelItem, ...remainingModels];

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
        ModelGroupIds: uniq([pool._id, ...(req.ModelGroupIds || [])]),
        ModelGroupId: req.ModelGroupId || pool._id,
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

print("LLM Gateway chat pool bootstrap completed");
})();
