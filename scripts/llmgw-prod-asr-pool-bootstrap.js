// Idempotently bind production ASR app callers to an ASR model pool backed by
// an existing Doubao ASR exchange. Run through
// scripts/llmgw-prod-asr-pool-bootstrap.sh so production data is backed up first.

const dryRunRaw = (process.env.LLMGW_ASR_BOOTSTRAP_DRY_RUN || "1").toLowerCase();
const dryRun = !(dryRunRaw === "0" || dryRunRaw === "false");
const poolId = process.env.LLMGW_ASR_BOOTSTRAP_POOL_ID || "asr_doubao_bigmodel_pool";
const poolName = process.env.LLMGW_ASR_BOOTSTRAP_POOL_NAME || "ASR 豆包 BigModel";
const poolCode = process.env.LLMGW_ASR_BOOTSTRAP_POOL_CODE || "asr-doubao-bigmodel";
const modelId = process.env.LLMGW_ASR_BOOTSTRAP_MODEL_ID || "doubao-asr-bigmodel";
const transformerType = process.env.LLMGW_ASR_BOOTSTRAP_TRANSFORMER || "doubao-asr";
const description = process.env.LLMGW_ASR_BOOTSTRAP_DESCRIPTION || "LLM Gateway ASR 发布门默认池：豆包 ASR exchange";
const bindCallersRaw = (process.env.LLMGW_ASR_BOOTSTRAP_BIND_CALLERS || "1").toLowerCase();
const bindCallers = !(bindCallersRaw === "0" || bindCallersRaw === "false");
const defaultForTypeRaw = (process.env.LLMGW_ASR_BOOTSTRAP_DEFAULT_FOR_TYPE || (bindCallers ? "1" : "0")).toLowerCase();
const defaultForType = !(defaultForTypeRaw === "0" || defaultForTypeRaw === "false");

const appCallers = [
  "document-store.subtitle::asr",
  "transcript-agent.transcribe::asr",
  "video-agent.v2d.transcribe::asr",
  "video-agent.video-to-text::asr",
];

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

const exchange = db.model_exchanges.findOne({
  Enabled: true,
  TransformerType: transformerType,
  $or: [
    { ModelAlias: modelId },
    { ModelAliases: modelId },
    { "Models.ModelId": modelId },
  ],
});

if (!exchange) {
  fail(`enabled ModelExchange not found for transformer=${transformerType} model=${modelId}`);
}

const missingCallers = appCallers.filter((code) => !db.llm_app_callers.findOne({ AppCode: code }));
if (missingCallers.length > 0) {
  fail(`ASR app callers missing: ${missingCallers.join(", ")}`);
}

const now = new Date();
const poolDoc = {
  Name: poolName,
  Code: poolCode,
  Priority: 10,
  ModelType: "asr",
  IsDefaultForType: defaultForType,
  Models: [
    {
      ModelId: modelId,
      PlatformId: exchange._id,
      Priority: 1,
      HealthStatus: 0,
      LastFailedAt: null,
      LastSuccessAt: null,
      ConsecutiveFailures: 0,
      ConsecutiveSuccesses: 0,
      EnablePromptCache: false,
      MaxTokens: null,
      InputPricePerMillion: null,
      OutputPricePerMillion: null,
      PricePerCall: null,
    },
  ],
  StrategyType: 0,
  Description: description,
  UpdatedAt: now,
};

const planned = {
  dryRun,
  poolId,
  poolName,
  modelId,
  exchangeId: exchange._id,
  exchangeName: exchange.Name,
  bindCallers,
  defaultForType,
  appCallers,
};
printjson(planned);

if (dryRun) {
  print("LLM Gateway ASR pool bootstrap dry-run: no data changed");
  quit(0);
}

db.model_groups.updateOne(
  { _id: poolId },
  {
    $setOnInsert: { CreatedAt: now },
    $set: poolDoc,
  },
  { upsert: true },
);

if (bindCallers) {
  for (const code of appCallers) {
    const caller = db.llm_app_callers.findOne({ AppCode: code });
    const requirements = caller.ModelRequirements || [];
    let found = false;
    const nextRequirements = requirements.map((req) => {
      if (req.ModelType !== "asr") return req;
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
        ModelType: "asr",
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
  print("LLM Gateway ASR pool bootstrap: caller binding skipped");
}

print("LLM Gateway ASR pool bootstrap completed");
