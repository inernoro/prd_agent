export {
  getDimensions as getReviewDimensions,
  updateDimensions as updateReviewDimensions,
  createSubmission as createReviewSubmission,
  getMySubmissions as getMyReviewSubmissions,
  getAllSubmissions as getAllReviewSubmissions,
  getSubmission as getReviewSubmission,
  rerunSubmission as rerunReviewSubmission,
  reuploadAfterError as reuploadReviewAfterError,
  reuploadOnFailure as reuploadReviewOnFailure,
  getSubmissionResults as getReviewSubmissionResults,
  getResultStreamUrl as getReviewResultStreamUrl,
  getSubmitters as getReviewSubmitters,
  listReviewWebhooks,
  createReviewWebhook,
  updateReviewWebhook,
  deleteReviewWebhook,
  testReviewWebhook,
} from '@/services/real/productReview';
export type {
  ReviewDimensionConfig,
  ReviewDimensionScore,
  ReviewSubmission,
  ReviewResult,
  ReviewWebhookConfig,
  DimensionCheckItem,
  DimensionCheckItemResult,
  CheckboxState,
} from '@/services/real/productReview';

// ============ 产品评审员 — 需求评估（Excel 需求表批量评估 + 优先级排序） ============
export {
  createAssessment,
  listAssessments,
  getAssessment,
  rerunAssessment,
  getAssessmentStreamUrl,
  downloadAssessmentReport,
} from '@/services/real/productReviewAssessment';
export type {
  RequirementAssessmentRun,
  RequirementAssessmentItem,
  RequirementAssessmentStatus,
  RequirementFactorScore,
  RequirementFactorDefinition,
  RequirementItemStatus,
} from '@/services/real/productReviewAssessment';
