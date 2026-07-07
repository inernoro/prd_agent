// Idempotently bind visual video app callers to the video-gen pool already
// used by the canonical video-agent caller. Run through
// scripts/llmgw-prod-video-caller-bootstrap.sh so production data is backed up
// first in execute mode.

const dryRunRaw = (process.env.LLMGW_VIDEO_BOOTSTRAP_DRY_RUN || "1").toLowerCase();
const dryRun = !(dryRunRaw === "0" || dryRunRaw === "false");
const sourceCallerCode = process.env.LLMGW_VIDEO_BOOTSTRAP_SOURCE_CALLER || "video-agent.videogen::video-gen";
const targetCallersRaw = process.env.LLMGW_VIDEO_BOOTSTRAP_TARGET_CALLERS || "visual-agent.videogen::video-gen";
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

const sourceCaller = db.llm_app_callers.findOne({ AppCode: sourceCallerCode });
if (!sourceCaller) {
  fail(`source video appCaller missing: ${sourceCallerCode}`);
}

const sourceRequirement = requirementFor(sourceCaller, "video-gen");
const sourcePoolIds = uniq((sourceRequirement && sourceRequirement.ModelGroupIds) || []);
const sourcePoolId = sourceRequirement && sourceRequirement.ModelGroupId;
const poolIds = uniq([sourcePoolId, ...sourcePoolIds]);
if (poolIds.length === 0) {
  fail(`source video appCaller has no video-gen ModelGroupIds: ${sourceCallerCode}`);
}

const missingPools = poolIds.filter((id) => !db.model_groups.findOne({ _id: id, ModelType: "video-gen" }));
if (missingPools.length > 0) {
  fail(`source video appCaller references missing video-gen pools: ${missingPools.join(", ")}`);
}

const missingCallers = targetCallers.filter((code) => !db.llm_app_callers.findOne({ AppCode: code }));
if (missingCallers.length > 0) {
  fail(`target video appCallers missing: ${missingCallers.join(", ")}`);
}

const planned = {
  dryRun,
  sourceCaller: sourceCallerCode,
  sourcePoolIds: poolIds,
  targetCallers,
};
printjson(planned);

if (dryRun) {
  print("LLM Gateway video caller bootstrap dry-run: no data changed");
  quit(0);
}

const now = new Date();
for (const code of targetCallers) {
  const caller = db.llm_app_callers.findOne({ AppCode: code });
  const requirements = caller.ModelRequirements || [];
  let found = false;
  const nextRequirements = requirements.map((req) => {
    if (String(req.ModelType || "").toLowerCase() !== "video-gen") return req;
    found = true;
    return {
      ...req,
      ModelGroupIds: uniq([...(req.ModelGroupIds || []), ...poolIds]),
      ModelGroupId: req.ModelGroupId || poolIds[0],
      IsRequired: req.IsRequired !== false,
    };
  });

  if (!found) {
    nextRequirements.push({
      ModelType: "video-gen",
      Purpose: `用于 ${caller.DisplayName || code}`,
      ModelGroupIds: poolIds,
      ModelGroupId: poolIds[0],
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

print("LLM Gateway video caller bootstrap completed");
