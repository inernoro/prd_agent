// 生产环境：严禁 mock/假数据。此处只允许真实后端实现。

import type { LoginContract, ResetPasswordContract } from '@/services/contracts/auth';
import type {
  GetAdminAuthzMeContract,
  GetAdminPermissionCatalogContract,
  GetAdminMenuCatalogContract,
  GetSystemRolesContract,
  CreateSystemRoleContract,
  UpdateSystemRoleContract,
  DeleteSystemRoleContract,
  ResetBuiltInSystemRolesContract,
  GetUserAuthzContract,
  UpdateUserAuthzContract,
} from '@/services/contracts/authz';
import type {
  GetAdminNotificationsContract,
  HandleAdminNotificationContract,
  HandleAllAdminNotificationsContract,
} from '@/services/contracts/notifications';
import type {
  GetUsersContract,
  GenerateInviteCodesContract,
  CreateAdminUserContract,
  BulkCreateAdminUsersContract,
  UpdateUserPasswordContract,
  UpdateUserAvatarContract,
  UpdateUserDisplayNameContract,
  UpdateUserRoleContract,
  UpdateUserStatusContract,
  GetUserProfileContract,
  UnlockUserContract,
  ForceExpireUserContract,
  ForceExpireAllContract,
  BulkDeleteUsersContract,
} from '@/services/contracts/adminUsers';
import type { GetActiveGroupsContract, GetGapStatsContract, GetMessageTrendContract, GetOverviewStatsContract, GetTokenUsageContract } from '@/services/contracts/adminStats';
import type { GetExecutiveOverviewContract, GetExecutiveTrendsContract, GetExecutiveTeamContract, GetExecutiveAgentsContract, GetExecutiveModelsContract, GetExecutiveLeaderboardContract } from '@/services/contracts/executive';
import type { CreatePlatformContract, DeletePlatformContract, GetPlatformsContract, UpdatePlatformContract } from '@/services/contracts/platforms';
import type { ClearImageGenModelContract, ClearIntentModelContract, ClearVisionModelContract, CreateModelContract, DeleteModelContract, GetModelsContract, SetImageGenModelContract, SetIntentModelContract, SetMainModelContract, SetVisionModelContract, TestModelContract, UpdateModelContract, UpdateModelPrioritiesContract, GetModelAdapterInfoContract, GetModelsAdapterInfoBatchContract, GetAdapterInfoByModelNameContract } from '@/services/contracts/models';
import type { ActivateLLMConfigContract, CreateLLMConfigContract, DeleteLLMConfigContract, GetLLMConfigsContract, UpdateLLMConfigContract } from '@/services/contracts/llmConfigs';
import type { GetLlmLogDetailContract, GetLlmLogsContract, GetLlmLogsMetaContract, GetLlmModelStatsContract, GetReplayCurlContract } from '@/services/contracts/llmLogs';
import type { GetAdminDocumentContentContract } from '@/services/contracts/adminDocuments';
import type { ListUploadArtifactsContract } from '@/services/contracts/uploadArtifacts';
import type { AdminImpersonateContract } from '@/services/contracts/lab';
import type {
  CreateModelLabExperimentContract,
  DeleteModelLabExperimentContract,
  GetModelLabExperimentContract,
  ListModelLabExperimentsContract,
  ListModelLabModelSetsContract,
  RunModelLabStreamContract,
  UpdateModelLabExperimentContract,
  UpsertModelLabModelSetContract,
} from '@/services/contracts/modelLab';
import type {
  CancelImageGenRunContract,
  ClarifyImageGenPromptContract,
  CreateImageGenRunContract,
  GenerateImageGenContract,
  GetImageGenRunContract,
  GetImageGenSizeCapsContract,
  PlanImageGenContract,
  RunImageGenBatchStreamContract,
  RunImageGenRunStreamContract,
  StreamImageGenRunWithRetryContract,
} from '@/services/contracts/imageGen';
import type { DeleteModelLabGroupContract, ListModelLabGroupsContract, UpsertModelLabGroupContract } from '@/services/contracts/modelLabGroups';
import type { AiChatGetHistoryContract, AiChatUploadDocumentContract } from '@/services/contracts/aiChat';
import type { SuggestGroupNameContract } from '@/services/contracts/intent';
import type {
  ExportConfigContract,
  GetDataSummaryContract,
  ImportConfigContract,
  PreviewImportConfigContract,
  PreviewUsersPurgeContract,
  PurgeDataContract,
  PurgeUsersContract,
} from '@/services/contracts/data';
import type { GetApiLogDetailContract, GetApiLogsContract, GetApiLogsMetaContract } from '@/services/contracts/apiLogs';
import type {
  GetAdminSystemPromptsContract,
  PutAdminSystemPromptsContract,
  ResetAdminSystemPromptsContract,
} from '@/services/contracts/systemPrompts';
import type {
  DeleteAdminImageGenPlanPromptOverrideContract,
  GetAdminImageGenPlanPromptOverrideContract,
  PutAdminImageGenPlanPromptOverrideContract,
} from '@/services/contracts/promptOverrides';
import type { UploadNoHeadAvatarContract } from '@/services/contracts/avatarAssets';
import type { UploadUserAvatarContract } from '@/services/contracts/userAvatarUpload';
import type {
  AddVisualAgentMessageContract,
  AddVisualAgentWorkspaceMessageContract,
  CreateVisualAgentSessionContract,
  CreateVisualAgentWorkspaceContract,
  DeleteVisualAgentAssetContract,
  DeleteVisualAgentWorkspaceContract,
  RefreshVisualAgentWorkspaceCoverContract,
  GetVisualAgentCanvasContract,
  GetVisualAgentSessionContract,
  GetVisualAgentWorkspaceCanvasContract,
  GetVisualAgentWorkspaceDetailContract,
  ListVisualAgentSessionsContract,
  ListVisualAgentWorkspaceMessagesContract,
  ListVisualAgentWorkspacesContract,
  SaveVisualAgentCanvasContract,
  SaveVisualAgentWorkspaceCanvasContract,
  SaveVisualAgentWorkspaceViewportContract,
  UploadImageAssetContract,
  UploadVisualAgentWorkspaceAssetContract,
  DeleteVisualAgentWorkspaceAssetContract,
  UpdateVisualAgentWorkspaceContract,
  CreateWorkspaceImageGenRunContract,
} from '@/services/contracts/visualAgent';
import type {
  CreateDesktopAssetKeyContract,
  CreateDesktopAssetSkinContract,
  DeleteDesktopAssetKeyContract,
  DeleteDesktopAssetSkinContract,
  ListDesktopAssetKeysContract,
  ListDesktopAssetSkinsContract,
  UpdateDesktopAssetSkinContract,
  UploadDesktopAssetContract,
} from '@/services/contracts/desktopAssets';
import type { GetDesktopBrandingSettingsContract, UpdateDesktopBrandingSettingsContract } from '@/services/contracts/desktopBranding';
import type {
  DeleteHomepageAssetContract,
  GetHomepageAssetsPublicContract,
  ListHomepageAssetsContract,
  UploadHomepageAssetContract,
} from '@/services/contracts/homepageAssets';
import type {
  DeleteAdminGroupContract,
  DeleteAdminGroupMessagesContract,
  GenerateAdminGapSummaryContract,
  GetAdminGroupGapsContract,
  GetAdminGroupMembersContract,
  GetAdminGroupMessagesContract,
  GetAdminGroupsContract,
  RegenerateAdminGroupInviteContract,
  RemoveAdminGroupMemberContract,
  SimulateMessageContract,
  SimulateStreamMessagesContract,
  UpdateAdminGapStatusContract,
  UpdateAdminGroupContract,
} from '@/services/contracts/adminGroups';
import type {
  ListLiteraryPromptsContract,
  CreateLiteraryPromptContract,
  UpdateLiteraryPromptContract,
  DeleteLiteraryPromptContract,
  ListLiteraryPromptsMarketplaceContract,
  PublishLiteraryPromptContract,
  UnpublishLiteraryPromptContract,
  ForkLiteraryPromptContract,
  OptimizeLiteraryPromptContract,
} from '@/services/contracts/literaryPrompts';
import type {
  GetLiteraryAgentConfigContract,
  UpdateLiteraryAgentConfigContract,
  UploadReferenceImageContract,
  ClearReferenceImageContract,
  ListReferenceImageConfigsContract,
  CreateReferenceImageConfigContract,
  UpdateReferenceImageConfigContract,
  UpdateReferenceImageFileContract,
  DeleteReferenceImageConfigContract,
  ActivateReferenceImageConfigContract,
  DeactivateReferenceImageConfigContract,
  GetActiveReferenceImageConfigContract,
  GetLiteraryAgentModelsContract,
  GetLiteraryAgentChatModelsContract,
  GetLiteraryAgentImageGenModelsContract,
  GetLiteraryAgentAllModelsContract,
  GetLiteraryAgentMainModelContract,
  CreateLiteraryAgentImageGenRunContract,
  CancelLiteraryAgentImageGenRunContract,
  StreamLiteraryAgentImageGenRunWithRetryContract,
  ListReferenceImageConfigsMarketplaceContract,
  PublishReferenceImageConfigContract,
  UnpublishReferenceImageConfigContract,
  ForkReferenceImageConfigContract,
} from '@/services/contracts/literaryAgentConfig';
import type {
  ListDefectTemplatesContract,
  CreateDefectTemplateContract,
  UpdateDefectTemplateContract,
  DeleteDefectTemplateContract,
  ShareDefectTemplateContract,
  ListDefectsContract,
  GetDefectContract,
  CreateDefectContract,
  UpdateDefectContract,
  DeleteDefectContract,
  SubmitDefectContract,
  ProcessDefectContract,
  ResolveDefectContract,
  RejectDefectContract,
  UpdateDefectSeverityContract,
  CloseDefectContract,
  ReopenDefectContract,
  GetDefectMessagesContract,
  SendDefectMessageContract,
  AddDefectAttachmentContract,
  DeleteDefectAttachmentContract,
  GetDefectStatsContract,
  GetDefectUsersContract,
  PolishDefectContract,
  ListDeletedDefectsContract,
  RestoreDefectContract,
  PermanentDeleteDefectContract,
  ListDefectFoldersContract,
  CreateDefectFolderContract,
  UpdateDefectFolderContract,
  DeleteDefectFolderContract,
  MoveDefectToFolderContract,
  BatchMoveDefectsContract,
  PreviewApiLogsContract,
  VerifyPassContract,
  VerifyFailContract,
  ListDefectProjectsContract,
  CreateDefectProjectContract,
  UpdateDefectProjectContract,
  ArchiveDefectProjectContract,
  ListDefectTeamsContract,
  GetDefectStatsOverviewContract,
  GetDefectStatsTrendContract,
  GetDefectStatsByUserContract,
  ListDefectWebhooksContract,
  CreateDefectWebhookContract,
  UpdateDefectWebhookContract,
  DeleteDefectWebhookContract,
  AnalyzeDefectImageContract,
  CreateDefectShareContract,
  ListDefectSharesContract,
  RevokeDefectShareContract,
  ListDefectFixReportsContract,
  AcceptDefectFixItemContract,
  RejectDefectFixItemContract,
  CreateBatchShareContract,
  GetShareScoresContract,
} from '@/services/contracts/defectAgent';
import type { IOpenPlatformService } from '@/services/contracts/openPlatform';
import type { IAutomationsService } from '@/services/contracts/automations';
import type { IModelGroupsService } from '@/services/contracts/modelGroups';
import type { IAppCallersService } from '@/services/contracts/appCallers';
import type { ISchedulerConfigService } from '@/services/contracts/schedulerConfig';
import type { GetUserPreferencesContract, UpdateNavLayoutContract, UpdateThemeConfigContract, UpdateVisualAgentPreferencesContract, UpdateLiteraryAgentPreferencesContract } from '@/services/contracts/userPreferences';
import type {
  GetModelSizesContract,
  GetWatermarksContract,
  GetWatermarkByAppContract,
  CreateWatermarkContract,
  UpdateWatermarkContract,
  DeleteWatermarkContract,
  BindWatermarkAppContract,
  UnbindWatermarkAppContract,
  GetWatermarkFontsContract,
  UploadWatermarkFontContract,
  DeleteWatermarkFontContract,
  UploadWatermarkIconContract,
  ListWatermarksMarketplaceContract,
  PublishWatermarkContract,
  UnpublishWatermarkContract,
  ForkWatermarkContract,
} from '@/services/contracts/watermark';
import { useAuthStore } from '@/stores/authStore';
import { fail, type ApiResponse } from '@/types/api';

import { loginReal, resetPasswordReal } from '@/services/real/auth';
import {
  getAdminAuthzMeReal,
  getAdminPermissionCatalogReal,
  getAdminMenuCatalogReal,
  getSystemRolesReal,
  createSystemRoleReal,
  updateSystemRoleReal,
  deleteSystemRoleReal,
  resetBuiltInSystemRolesReal,
  getUserAuthzReal,
  updateUserAuthzReal,
} from '@/services/real/authz';
import {
  getUsersReal,
  generateInviteCodesReal,
  createUserReal,
  bulkCreateUsersReal,
  updateUserPasswordReal,
  updateUserAvatarReal,
  updateUserDisplayNameReal,
  getUserProfileReal,
  updateUserRoleReal,
  updateUserStatusReal,
  unlockUserReal,
  forceExpireUserReal,
  forceExpireAllReal,
  initializeUsersReal,
  bulkDeleteUsersReal,
} from '@/services/real/adminUsers';
import { getActiveGroupsReal, getGapStatsReal, getMessageTrendReal, getOverviewStatsReal, getTokenUsageReal } from '@/services/real/adminStats';
import { getExecutiveOverviewReal, getExecutiveTrendsReal, getExecutiveTeamReal, getExecutiveAgentsReal, getExecutiveModelsReal, getExecutiveLeaderboardReal } from '@/services/real/executive';
import { createPlatformReal, deletePlatformReal, getPlatformsReal, updatePlatformReal } from '@/services/real/platforms';
import { clearImageGenModelReal, clearIntentModelReal, clearVisionModelReal, createModelReal, deleteModelReal, getModelsReal, setImageGenModelReal, setIntentModelReal, setMainModelReal, setVisionModelReal, testModelReal, updateModelReal, updateModelPrioritiesReal, getModelAdapterInfoReal, getModelsAdapterInfoBatchReal, getAdapterInfoByModelNameReal } from '@/services/real/models';
import { activateLLMConfigReal, createLLMConfigReal, deleteLLMConfigReal, getLLMConfigsReal, updateLLMConfigReal } from '@/services/real/llmConfigs';
import { getLlmLogDetailReal, getLlmLogsMetaReal, getLlmLogsReal, getLlmModelStatsReal, getBatchModelStatsReal, getReplayCurlReal } from '@/services/real/llmLogs';
import { getAdminDocumentContentReal } from '@/services/real/adminDocuments';
import { listUploadArtifactsReal } from '@/services/real/uploadArtifacts';
import {
  deleteWatermarkFontReal,
  getModelSizesReal,
  getWatermarkFontsReal,
  getWatermarksReal,
  getWatermarkByAppReal,
  createWatermarkReal,
  updateWatermarkReal,
  deleteWatermarkReal,
  bindWatermarkAppReal,
  unbindWatermarkAppReal,
  uploadWatermarkFontReal,
  uploadWatermarkIconReal,
  testWatermarkReal,
  listWatermarksMarketplaceReal,
  publishWatermarkReal,
  unpublishWatermarkReal,
  forkWatermarkReal,
} from '@/services/real/watermark';
import { adminImpersonateReal } from '@/services/real/lab';
import {
  createModelLabExperimentReal,
  deleteModelLabExperimentReal,
  getModelLabExperimentReal,
  listModelLabExperimentsReal,
  listModelLabModelSetsReal,
  runModelLabStreamReal,
  updateModelLabExperimentReal,
  upsertModelLabModelSetReal,
} from '@/services/real/modelLab';
import {
  cancelImageGenRunReal,
  clarifyImageGenPromptReal,
  createImageGenRunReal,
  generateImageGenReal,
  getImageGenRunReal,
  getImageGenSizeCapsReal,
  planImageGenReal,
  runImageGenBatchStreamReal,
  runImageGenRunStreamReal,
  streamImageGenRunWithRetryReal,
} from '@/services/real/imageGen';
import { deleteModelLabGroupReal, listModelLabGroupsReal, upsertModelLabGroupReal } from '@/services/real/modelLabGroups';
import { getAiChatHistoryReal, uploadAiChatDocumentReal, addDocumentToSession as addDocumentToSessionReal, removeDocumentFromSession as removeDocumentFromSessionReal } from '@/services/real/aiChat';
import { suggestGroupNameReal } from '@/services/real/intent';
import {
  addVisualAgentMessageReal,
  addVisualAgentWorkspaceMessageReal,
  createVisualAgentSessionReal,
  createVisualAgentWorkspaceReal,
  deleteVisualAgentAssetReal,
  deleteVisualAgentWorkspaceReal,
  refreshVisualAgentWorkspaceCoverReal,
  getVisualAgentCanvasReal,
  getVisualAgentSessionReal,
  getVisualAgentWorkspaceCanvasReal,
  getVisualAgentWorkspaceDetailReal,
  listVisualAgentWorkspaceMessagesReal,
  listVisualAgentSessionsReal,
  listVisualAgentWorkspacesReal,
  saveVisualAgentCanvasReal,
  saveVisualAgentWorkspaceCanvasReal,
  saveVisualAgentWorkspaceViewportReal,
  uploadImageAssetReal,
  uploadVisualAgentWorkspaceAssetReal,
  deleteVisualAgentWorkspaceAssetReal,
  updateVisualAgentWorkspaceReal,
  createWorkspaceImageGenRunReal,
  generateArticleMarkersReal,
  extractArticleMarkersReal,
  exportArticleReal,
  updateArticleMarkerReal,
  generateVisualAgentWorkspaceTitleReal,
  getVisualAgentImageGenModelsReal,
  getVisualAgentAdapterInfoReal,
} from '@/services/real/visualAgent';
import {
  exportConfigReal,
  getDataSummaryReal,
  importConfigReal,
  previewImportConfigReal,
  previewUsersPurgeReal,
  purgeDataReal,
  purgeUsersReal,
} from '@/services/real/data';
import { getApiLogDetailReal, getApiLogsMetaReal, getApiLogsReal } from '@/services/real/apiLogs';
import { getAdminSystemPromptsReal, putAdminSystemPromptsReal, resetAdminSystemPromptsReal } from '@/services/real/systemPrompts';
import {
  deleteAdminImageGenPlanPromptOverrideReal,
  getAdminImageGenPlanPromptOverrideReal,
  putAdminImageGenPlanPromptOverrideReal,
} from '@/services/real/promptOverrides';
import {
  deleteAdminGroupReal,
  deleteAdminGroupMessagesReal,
  generateAdminGapSummaryReal,
  getAdminGroupGapsReal,
  getAdminGroupMembersReal,
  getAdminGroupMessagesReal,
  getAdminGroupsReal,
  regenerateAdminGroupInviteReal,
  removeAdminGroupMemberReal,
  simulateMessageReal,
  simulateStreamMessagesReal,
  updateAdminGapStatusReal,
  updateAdminGroupReal,
} from '@/services/real/adminGroups';
import {
  createDesktopAssetKey as createDesktopAssetKeyReal,
  createDesktopAssetSkin as createDesktopAssetSkinReal,
  deleteDesktopAssetSkin as deleteDesktopAssetSkinReal,
  listDesktopAssetKeys as listDesktopAssetKeysReal,
  deleteDesktopAssetKey as deleteDesktopAssetKeyReal,
  listDesktopAssetSkins as listDesktopAssetSkinsReal,
  updateDesktopAssetSkin as updateDesktopAssetSkinReal,
  uploadDesktopAsset as uploadDesktopAssetReal,
  getDesktopAssetsMatrix as getDesktopAssetsMatrixReal,
} from '@/services/real/desktopAssets';
import { uploadNoHeadAvatar as uploadNoHeadAvatarReal } from '@/services/real/avatarAssets';
import { uploadUserAvatar as uploadUserAvatarReal } from '@/services/real/userAvatarUpload';
import { uploadMyAvatar as uploadMyAvatarReal, updateMyAvatar as updateMyAvatarReal } from '@/services/real/profile';
import { getDesktopBrandingSettings as getDesktopBrandingSettingsReal, updateDesktopBrandingSettings as updateDesktopBrandingSettingsReal } from '@/services/real/desktopBranding';
import {
  listHomepageAssets as listHomepageAssetsReal,
  uploadHomepageAsset as uploadHomepageAssetReal,
  deleteHomepageAsset as deleteHomepageAssetReal,
  getHomepageAssetsPublic as getHomepageAssetsPublicReal,
} from '@/services/real/homepageAssets';
import {
  listLiteraryPromptsReal,
  createLiteraryPromptReal,
  updateLiteraryPromptReal,
  deleteLiteraryPromptReal,
  listLiteraryPromptsMarketplaceReal,
  publishLiteraryPromptReal,
  unpublishLiteraryPromptReal,
  forkLiteraryPromptReal,
  optimizeLiteraryPromptReal,
} from '@/services/real/literaryPrompts';
import {
  getLiteraryAgentConfigReal,
  updateLiteraryAgentConfigReal,
  uploadReferenceImageReal,
  clearReferenceImageReal,
  listReferenceImageConfigsReal,
  createReferenceImageConfigReal,
  updateReferenceImageConfigReal,
  updateReferenceImageFileReal,
  deleteReferenceImageConfigReal,
  activateReferenceImageConfigReal,
  deactivateReferenceImageConfigReal,
  getActiveReferenceImageConfigReal,
  getLiteraryAgentModelsReal,
  getLiteraryAgentChatModelsReal,
  getLiteraryAgentImageGenModelsReal,
  getLiteraryAgentAllModelsReal,
  getLiteraryAgentMainModelReal,
  createLiteraryAgentImageGenRunReal,
  cancelLiteraryAgentImageGenRunReal,
  streamLiteraryAgentImageGenRunWithRetryReal,
  listReferenceImageConfigsMarketplaceReal,
  publishReferenceImageConfigReal,
  unpublishReferenceImageConfigReal,
  forkReferenceImageConfigReal,
} from '@/services/real/literaryAgentConfig';
import {
  listDefectTemplatesReal,
  createDefectTemplateReal,
  updateDefectTemplateReal,
  deleteDefectTemplateReal,
  shareDefectTemplateReal,
  listDefectsReal,
  getDefectReal,
  createDefectReal,
  updateDefectReal,
  deleteDefectReal,
  submitDefectReal,
  processDefectReal,
  resolveDefectReal,
  rejectDefectReal,
  updateDefectSeverityReal,
  closeDefectReal,
  reopenDefectReal,
  getDefectMessagesReal,
  sendDefectMessageReal,
  addDefectAttachmentReal,
  deleteDefectAttachmentReal,
  getDefectStatsReal,
  getDefectUsersReal,
  polishDefectReal,
  analyzeDefectImageReal,
  listDeletedDefectsReal,
  restoreDefectReal,
  permanentDeleteDefectReal,
  listDefectFoldersReal,
  createDefectFolderReal,
  updateDefectFolderReal,
  deleteDefectFolderReal,
  moveDefectToFolderReal,
  batchMoveDefectsReal,
  previewApiLogsReal,
  verifyPassReal,
  verifyFailReal,
  listDefectProjectsReal,
  createDefectProjectReal,
  updateDefectProjectReal,
  archiveDefectProjectReal,
  listDefectTeamsReal,
  getDefectStatsOverviewReal,
  getDefectStatsTrendReal,
  getDefectStatsByUserReal,
  listDefectWebhooksReal,
  createDefectWebhookReal,
  updateDefectWebhookReal,
  deleteDefectWebhookReal,
  createDefectShareReal,
  listDefectSharesReal,
  revokeDefectShareReal,
  listDefectFixReportsReal,
  acceptDefectFixItemReal,
  createBatchShareReal,
  getShareScoresReal,
  rejectDefectFixItemReal,
} from '@/services/real/defectAgent';
import { OpenPlatformService } from '@/services/real/openPlatform';
import { AutomationsService } from '@/services/real/automations';
import { ModelGroupsService } from '@/services/real/modelGroups';
import { AppCallersService } from '@/services/real/appCallers';
import { SchedulerConfigService } from '@/services/real/schedulerConfig';
import { getUserPreferencesReal, updateNavLayoutReal, updateThemeConfigReal, updateVisualAgentPreferencesReal, updateLiteraryAgentPreferencesReal, updateAgentSwitcherPreferencesReal } from '@/services/real/userPreferences';
import {
  getAdminNotificationsReal,
  handleAdminNotificationReal,
  handleAllAdminNotificationsReal,
} from '@/services/real/notifications';
import type {
  GetMobileFeedContract,
  GetMobileStatsContract,
  GetMobileAssetsContract,
} from '@/services/contracts/mobile';
import {
  getMobileFeedReal,
  getMobileStatsReal,
  getMobileAssetsReal,
} from '@/services/real/mobile';
import type {
  ListReportTeamsContract,
  GetReportTeamContract,
  CreateReportTeamContract,
  UpdateReportTeamContract,
  DeleteReportTeamContract,
  LeaveReportTeamContract,
  AddReportTeamMemberContract,
  BatchAddReportTeamMembersContract,
  RemoveReportTeamMemberContract,
  UpdateReportTeamMemberContract,
  ListReportUsersContract,
  ListReportTemplatesContract,
  GetReportTemplateContract,
  CreateReportTemplateContract,
  UpdateReportTemplateContract,
  DeleteReportTemplateContract,
  ListWeeklyReportsContract,
  GetWeeklyReportContract,
  CreateWeeklyReportContract,
  UpdateWeeklyReportContract,
  UploadReportRichTextImageContract,
  UploadDailyLogImageContract,
  DeleteWeeklyReportContract,
  SubmitWeeklyReportContract,
  ReviewWeeklyReportContract,
  ReturnWeeklyReportContract,
  GetTeamDashboardContract,
  SaveDailyLogContract,
  ListDailyLogsContract,
  GetDailyLogContract,
  DeleteDailyLogContract,
  ListDataSourcesContract,
  CreateDataSourceContract,
  UpdateDataSourceContract,
  DeleteDataSourceContract,
  TestDataSourceContract,
  SyncDataSourceContract,
  ListDataSourceCommitsContract,
  GenerateReportContract,
  GetCollectedActivityContract,
  ListCommentsContract,
  CreateCommentContract,
  DeleteCommentContract,
  ListReportLikesContract,
  LikeReportContract,
  UnlikeReportContract,
  RecordReportViewContract,
  GetReportViewsSummaryContract,
  GetPlanComparisonContract,
  GenerateTeamSummaryContract,
  GetTeamSummaryContract,
  GetTeamSummaryViewContract,
  GetTeamReportsViewContract,
  GetPersonalTrendsContract,
  GetTeamTrendsContract,
  MarkVacationContract,
  CancelVacationContract,
  ListMyAiSourcesContract,
  UpdateMyAiSourceContract,
  GetMyAiReportPromptContract,
  UpdateMyAiReportPromptContract,
  ResetMyAiReportPromptContract,
  GetTeamAiSummaryPromptContract,
  UpdateTeamAiSummaryPromptContract,
  ResetTeamAiSummaryPromptContract,
  GetMyDailyLogTagsContract,
  UpdateMyDailyLogTagsContract,
  ListPersonalSourcesContract,
  CreatePersonalSourceContract,
  UpdatePersonalSourceContract,
  DeletePersonalSourceContract,
  TestPersonalSourceContract,
  SyncPersonalSourceContract,
  GetPersonalStatsContract,
  GetTeamWorkflowContract,
  RunTeamWorkflowContract,
  UpdateIdentityMappingsContract,
  SeedSystemTemplatesContract,
  ListWebhooksContract,
  CreateWebhookContract,
  UpdateWebhookContract,
  DeleteWebhookContract,
  TestWebhookContract,
} from '@/services/contracts/reportAgent';
import {
  listReportTeamsReal,
  getReportTeamReal,
  createReportTeamReal,
  updateReportTeamReal,
  deleteReportTeamReal,
  leaveReportTeamReal,
  addReportTeamMemberReal,
  batchAddReportTeamMembersReal,
  removeReportTeamMemberReal,
  updateReportTeamMemberReal,
  listReportUsersReal,
  listReportTemplatesReal,
  getReportTemplateReal,
  createReportTemplateReal,
  updateReportTemplateReal,
  deleteReportTemplateReal,
  listWeeklyReportsReal,
  getWeeklyReportReal,
  createWeeklyReportReal,
  updateWeeklyReportReal,
  uploadReportRichTextImageReal,
  uploadDailyLogImageReal,
  deleteWeeklyReportReal,
  submitWeeklyReportReal,
  reviewWeeklyReportReal,
  returnWeeklyReportReal,
  getTeamDashboardReal,
  saveDailyLogReal,
  listDailyLogsReal,
  getDailyLogReal,
  deleteDailyLogReal,
  listDataSourcesReal,
  createDataSourceReal,
  updateDataSourceReal,
  deleteDataSourceReal,
  testDataSourceReal,
  syncDataSourceReal,
  listDataSourceCommitsReal,
  generateReportReal,
  getCollectedActivityReal,
  listCommentsReal,
  createCommentReal,
  deleteCommentReal,
  listReportLikesReal,
  likeReportReal,
  unlikeReportReal,
  recordReportViewReal,
  getReportViewsSummaryReal,
  getPlanComparisonReal,
  generateTeamSummaryReal,
  getTeamSummaryReal,
  getTeamSummaryViewReal,
  getTeamReportsViewReal,
  getPersonalTrendsReal,
  getTeamTrendsReal,
  exportReportMarkdownReal,
  exportTeamSummaryMarkdownReal,
  markVacationReal,
  cancelVacationReal,
  listMyAiSourcesReal,
  updateMyAiSourceReal,
  getMyAiReportPromptReal,
  updateMyAiReportPromptReal,
  resetMyAiReportPromptReal,
  getTeamAiSummaryPromptReal,
  updateTeamAiSummaryPromptReal,
  resetTeamAiSummaryPromptReal,
  getMyDailyLogTagsReal,
  updateMyDailyLogTagsReal,
  listPersonalSourcesReal,
  createPersonalSourceReal,
  updatePersonalSourceReal,
  deletePersonalSourceReal,
  testPersonalSourceReal,
  syncPersonalSourceReal,
  getPersonalStatsReal,
  getTeamWorkflowReal,
  runTeamWorkflowReal,
  updateIdentityMappingsReal,
  seedSystemTemplatesReal,
  listWebhooksReal,
  createWebhookReal,
  updateWebhookReal,
  deleteWebhookReal,
  testWebhookReal,
  createTeamWeekShareReal,
  listTeamWeekSharesReal,
  revokeTeamWeekShareReal,
  viewTeamWeekShareReal,
} from '@/services/real/reportAgent';
export type {
  CreateTeamWeekShareInput,
  TeamWeekShareCreateResult,
  TeamWeekShareItem,
  TeamWeekShareViewItem,
  TeamWeekShareViewData,
} from '@/services/real/reportAgent';

function withAuth<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<ApiResponse<TResult>>
) {
  return async (...args: TArgs): Promise<ApiResponse<TResult>> => {
    const token = useAuthStore.getState().token;
    if (!token) return fail('UNAUTHORIZED', '未登录');
    return await fn(...args);
  };
}

export const login: LoginContract = loginReal;
export const resetPassword: ResetPasswordContract = resetPasswordReal;

export const getAdminAuthzMe: GetAdminAuthzMeContract = withAuth(getAdminAuthzMeReal);
export const getAdminPermissionCatalog: GetAdminPermissionCatalogContract = withAuth(getAdminPermissionCatalogReal);
export const getAdminMenuCatalog: GetAdminMenuCatalogContract = withAuth(getAdminMenuCatalogReal);
export const getSystemRoles: GetSystemRolesContract = withAuth(getSystemRolesReal);
export const createSystemRole: CreateSystemRoleContract = withAuth(createSystemRoleReal);
export const updateSystemRole: UpdateSystemRoleContract = withAuth(updateSystemRoleReal);
export const deleteSystemRole: DeleteSystemRoleContract = withAuth(deleteSystemRoleReal);
export const resetBuiltInSystemRoles: ResetBuiltInSystemRolesContract = withAuth(resetBuiltInSystemRolesReal);
export const getUserAuthz: GetUserAuthzContract = withAuth(getUserAuthzReal);
export const updateUserAuthz: UpdateUserAuthzContract = withAuth(updateUserAuthzReal);
export const getAdminNotifications: GetAdminNotificationsContract = withAuth(getAdminNotificationsReal);
export const handleAdminNotification: HandleAdminNotificationContract = withAuth(handleAdminNotificationReal);
export const handleAllAdminNotifications: HandleAllAdminNotificationsContract = withAuth(handleAllAdminNotificationsReal);

export const getUsers: GetUsersContract = withAuth(getUsersReal);
export const createUser: CreateAdminUserContract = withAuth(createUserReal);
export const bulkCreateUsers: BulkCreateAdminUsersContract = withAuth(bulkCreateUsersReal);
export const updateUserRole: UpdateUserRoleContract = withAuth(updateUserRoleReal);
export const updateUserStatus: UpdateUserStatusContract = withAuth(updateUserStatusReal);
export const updateUserPassword: UpdateUserPasswordContract = withAuth(updateUserPasswordReal);
export const updateUserAvatar: UpdateUserAvatarContract = withAuth(updateUserAvatarReal);
export const updateUserDisplayName: UpdateUserDisplayNameContract = withAuth(updateUserDisplayNameReal);
export const unlockUser: UnlockUserContract = withAuth(unlockUserReal);
export const generateInviteCodes: GenerateInviteCodesContract = withAuth(generateInviteCodesReal);
export const forceExpireUser: ForceExpireUserContract = withAuth(forceExpireUserReal);
export const forceExpireAll: ForceExpireAllContract = withAuth(forceExpireAllReal);
export const initializeUsers = withAuth(initializeUsersReal);
export const getUserProfile: GetUserProfileContract = withAuth(getUserProfileReal);
export const bulkDeleteUsers: BulkDeleteUsersContract = withAuth(bulkDeleteUsersReal);

export const getOverviewStats: GetOverviewStatsContract = withAuth(getOverviewStatsReal);
export const getTokenUsage: GetTokenUsageContract = withAuth(getTokenUsageReal);
export const getMessageTrend: GetMessageTrendContract = withAuth(getMessageTrendReal);
export const getActiveGroups: GetActiveGroupsContract = withAuth(getActiveGroupsReal);
export const getGapStats: GetGapStatsContract = withAuth(getGapStatsReal);

// Executive Dashboard
export const getExecutiveOverview: GetExecutiveOverviewContract = withAuth(getExecutiveOverviewReal);
export const getExecutiveTrends: GetExecutiveTrendsContract = withAuth(getExecutiveTrendsReal);
export const getExecutiveTeam: GetExecutiveTeamContract = withAuth(getExecutiveTeamReal);
export const getExecutiveAgents: GetExecutiveAgentsContract = withAuth(getExecutiveAgentsReal);
export const getExecutiveModels: GetExecutiveModelsContract = withAuth(getExecutiveModelsReal);
export const getExecutiveLeaderboard: GetExecutiveLeaderboardContract = withAuth(getExecutiveLeaderboardReal);

export const getAdminGroups: GetAdminGroupsContract = withAuth(getAdminGroupsReal);
export const getAdminGroupMembers: GetAdminGroupMembersContract = withAuth(getAdminGroupMembersReal);
export const removeAdminGroupMember: RemoveAdminGroupMemberContract = withAuth(removeAdminGroupMemberReal);
export const regenerateAdminGroupInvite: RegenerateAdminGroupInviteContract = withAuth(regenerateAdminGroupInviteReal);
export const updateAdminGroup: UpdateAdminGroupContract = withAuth(updateAdminGroupReal);
export const deleteAdminGroup: DeleteAdminGroupContract = withAuth(deleteAdminGroupReal);
export const deleteAdminGroupMessages: DeleteAdminGroupMessagesContract = withAuth(deleteAdminGroupMessagesReal);

// gaps 复用用户侧接口（/api/v1/groups/{groupId}/gaps），由后端做权限控制；后台仅聚合展示+状态变更
export const getAdminGroupGaps: GetAdminGroupGapsContract = withAuth(getAdminGroupGapsReal);
export const updateAdminGapStatus: UpdateAdminGapStatusContract = withAuth(updateAdminGapStatusReal);
export const generateAdminGapSummary: GenerateAdminGapSummaryContract = withAuth(generateAdminGapSummaryReal);

export const getAdminGroupMessages: GetAdminGroupMessagesContract = withAuth(getAdminGroupMessagesReal);
export const simulateMessage: SimulateMessageContract = withAuth(simulateMessageReal);
export const simulateStreamMessages: SimulateStreamMessagesContract = withAuth(simulateStreamMessagesReal);

export const getPlatforms: GetPlatformsContract = withAuth(getPlatformsReal);
export const createPlatform: CreatePlatformContract = withAuth(createPlatformReal);
export const updatePlatform: UpdatePlatformContract = withAuth(updatePlatformReal);
export const deletePlatform: DeletePlatformContract = withAuth(deletePlatformReal);

export const getModels: GetModelsContract = withAuth(getModelsReal);
export const createModel: CreateModelContract = withAuth(createModelReal);
export const updateModel: UpdateModelContract = withAuth(updateModelReal);
export const deleteModel: DeleteModelContract = withAuth(deleteModelReal);
export const testModel: TestModelContract = withAuth(testModelReal);
export const updateModelPriorities: UpdateModelPrioritiesContract = withAuth(updateModelPrioritiesReal);
export const setMainModel: SetMainModelContract = withAuth(setMainModelReal);
export const setIntentModel: SetIntentModelContract = withAuth(setIntentModelReal);
export const clearIntentModel: ClearIntentModelContract = withAuth(clearIntentModelReal);
export const setVisionModel: SetVisionModelContract = withAuth(setVisionModelReal);
export const clearVisionModel: ClearVisionModelContract = withAuth(clearVisionModelReal);
export const setImageGenModel: SetImageGenModelContract = withAuth(setImageGenModelReal);
export const clearImageGenModel: ClearImageGenModelContract = withAuth(clearImageGenModelReal);
export const getModelAdapterInfo: GetModelAdapterInfoContract = withAuth(getModelAdapterInfoReal);
export const getModelsAdapterInfoBatch: GetModelsAdapterInfoBatchContract = withAuth(getModelsAdapterInfoBatchReal);
export const getAdapterInfoByModelName: GetAdapterInfoByModelNameContract = withAuth(getAdapterInfoByModelNameReal);

export const getLLMConfigs: GetLLMConfigsContract = withAuth(getLLMConfigsReal);
export const createLLMConfig: CreateLLMConfigContract = withAuth(createLLMConfigReal);
export const updateLLMConfig: UpdateLLMConfigContract = withAuth(updateLLMConfigReal);
export const deleteLLMConfig: DeleteLLMConfigContract = withAuth(deleteLLMConfigReal);
export const activateLLMConfig: ActivateLLMConfigContract = withAuth(activateLLMConfigReal);

export const getLlmLogs: GetLlmLogsContract = withAuth(getLlmLogsReal);
export const getLlmLogDetail: GetLlmLogDetailContract = withAuth(getLlmLogDetailReal);
export const getLlmLogsMeta: GetLlmLogsMetaContract = withAuth(getLlmLogsMetaReal);
export const getLlmModelStats: GetLlmModelStatsContract = withAuth(getLlmModelStatsReal);
export const getBatchModelStats = withAuth(getBatchModelStatsReal);
export const getReplayCurl: GetReplayCurlContract = withAuth(getReplayCurlReal);
export const listUploadArtifacts: ListUploadArtifactsContract = withAuth(listUploadArtifactsReal);
export const getAdminDocumentContent: GetAdminDocumentContentContract = withAuth(getAdminDocumentContentReal);

export const getApiLogs: GetApiLogsContract = withAuth(getApiLogsReal);
export const getApiLogDetail: GetApiLogDetailContract = withAuth(getApiLogDetailReal);

export const getAdminSystemPrompts: GetAdminSystemPromptsContract = withAuth(getAdminSystemPromptsReal);
export const putAdminSystemPrompts: PutAdminSystemPromptsContract = withAuth(putAdminSystemPromptsReal);
export const resetAdminSystemPrompts: ResetAdminSystemPromptsContract = withAuth(resetAdminSystemPromptsReal);
export const getApiLogsMeta: GetApiLogsMetaContract = withAuth(getApiLogsMetaReal);

export const getAdminImageGenPlanPromptOverride: GetAdminImageGenPlanPromptOverrideContract = withAuth(getAdminImageGenPlanPromptOverrideReal);
export const putAdminImageGenPlanPromptOverride: PutAdminImageGenPlanPromptOverrideContract = withAuth(putAdminImageGenPlanPromptOverrideReal);
export const deleteAdminImageGenPlanPromptOverride: DeleteAdminImageGenPlanPromptOverrideContract = withAuth(deleteAdminImageGenPlanPromptOverrideReal);

export const adminImpersonate: AdminImpersonateContract = withAuth(adminImpersonateReal);

export const listModelLabExperiments: ListModelLabExperimentsContract = withAuth(listModelLabExperimentsReal);
export const createModelLabExperiment: CreateModelLabExperimentContract = withAuth(createModelLabExperimentReal);
export const getModelLabExperiment: GetModelLabExperimentContract = withAuth(getModelLabExperimentReal);
export const updateModelLabExperiment: UpdateModelLabExperimentContract = withAuth(updateModelLabExperimentReal);
export const deleteModelLabExperiment: DeleteModelLabExperimentContract = withAuth(deleteModelLabExperimentReal);
export const listModelLabModelSets: ListModelLabModelSetsContract = withAuth(listModelLabModelSetsReal);
export const upsertModelLabModelSet: UpsertModelLabModelSetContract = withAuth(upsertModelLabModelSetReal);
export const runModelLabStream: RunModelLabStreamContract = withAuth(runModelLabStreamReal);

export const planImageGen: PlanImageGenContract = withAuth(planImageGenReal);
export const clarifyImageGenPrompt: ClarifyImageGenPromptContract = withAuth(clarifyImageGenPromptReal);
export const generateImageGen: GenerateImageGenContract = withAuth(generateImageGenReal);
export const runImageGenBatchStream: RunImageGenBatchStreamContract = withAuth(runImageGenBatchStreamReal);
export const getImageGenSizeCaps: GetImageGenSizeCapsContract = withAuth(getImageGenSizeCapsReal);
export const createImageGenRun: CreateImageGenRunContract = withAuth(createImageGenRunReal);
export const getImageGenRun: GetImageGenRunContract = withAuth(getImageGenRunReal);
export const runImageGenRunStream: RunImageGenRunStreamContract = withAuth(runImageGenRunStreamReal);
export const streamImageGenRunWithRetry: StreamImageGenRunWithRetryContract = withAuth(streamImageGenRunWithRetryReal);
export const cancelImageGenRun: CancelImageGenRunContract = withAuth(cancelImageGenRunReal);

export const listModelLabGroups: ListModelLabGroupsContract = withAuth(listModelLabGroupsReal);
export const upsertModelLabGroup: UpsertModelLabGroupContract = withAuth(upsertModelLabGroupReal);
export const deleteModelLabGroup: DeleteModelLabGroupContract = withAuth(deleteModelLabGroupReal);

export const uploadAiChatDocument: AiChatUploadDocumentContract = withAuth(uploadAiChatDocumentReal);
export const getAiChatHistory: AiChatGetHistoryContract = withAuth(getAiChatHistoryReal);
export const addDocumentToSession = withAuth(addDocumentToSessionReal);
export const removeDocumentFromSession = withAuth(removeDocumentFromSessionReal);

export const suggestGroupName: SuggestGroupNameContract = withAuth(suggestGroupNameReal);

export const listDesktopAssetSkins: ListDesktopAssetSkinsContract = withAuth(listDesktopAssetSkinsReal);
export const createDesktopAssetSkin: CreateDesktopAssetSkinContract = withAuth(createDesktopAssetSkinReal);
export const updateDesktopAssetSkin: UpdateDesktopAssetSkinContract = withAuth(updateDesktopAssetSkinReal);
export const deleteDesktopAssetSkin: DeleteDesktopAssetSkinContract = withAuth(deleteDesktopAssetSkinReal);
export const listDesktopAssetKeys: ListDesktopAssetKeysContract = withAuth(listDesktopAssetKeysReal);
export const createDesktopAssetKey: CreateDesktopAssetKeyContract = withAuth(createDesktopAssetKeyReal);
export const deleteDesktopAssetKey: DeleteDesktopAssetKeyContract = withAuth(deleteDesktopAssetKeyReal);
export const uploadDesktopAsset: UploadDesktopAssetContract = withAuth(uploadDesktopAssetReal);
export const getDesktopAssetsMatrix = withAuth(getDesktopAssetsMatrixReal);

export const uploadNoHeadAvatar: UploadNoHeadAvatarContract = withAuth(uploadNoHeadAvatarReal);
export const uploadUserAvatar: UploadUserAvatarContract = withAuth(uploadUserAvatarReal);
export const uploadMyAvatar = withAuth(uploadMyAvatarReal);
export const updateMyAvatar = withAuth(updateMyAvatarReal);

export const getDesktopBrandingSettings: GetDesktopBrandingSettingsContract = withAuth(getDesktopBrandingSettingsReal);
export const updateDesktopBrandingSettings: UpdateDesktopBrandingSettingsContract = withAuth(updateDesktopBrandingSettingsReal);

export const listHomepageAssets: ListHomepageAssetsContract = withAuth(listHomepageAssetsReal);
export const uploadHomepageAsset: UploadHomepageAssetContract = withAuth(uploadHomepageAssetReal);
export const deleteHomepageAsset: DeleteHomepageAssetContract = withAuth(deleteHomepageAssetReal);
export const getHomepageAssetsPublic: GetHomepageAssetsPublicContract = withAuth(getHomepageAssetsPublicReal);

export const createVisualAgentSession: CreateVisualAgentSessionContract = withAuth(createVisualAgentSessionReal);
export const listVisualAgentSessions: ListVisualAgentSessionsContract = withAuth(listVisualAgentSessionsReal);
export const getVisualAgentSession: GetVisualAgentSessionContract = withAuth(getVisualAgentSessionReal);
export const addVisualAgentMessage: AddVisualAgentMessageContract = withAuth(addVisualAgentMessageReal);
export const uploadImageAsset: UploadImageAssetContract = withAuth(uploadImageAssetReal);
export const deleteVisualAgentAsset: DeleteVisualAgentAssetContract = withAuth(deleteVisualAgentAssetReal);
export const getVisualAgentCanvas: GetVisualAgentCanvasContract = withAuth(getVisualAgentCanvasReal);
export const saveVisualAgentCanvas: SaveVisualAgentCanvasContract = withAuth(saveVisualAgentCanvasReal);

export const listVisualAgentWorkspaces: ListVisualAgentWorkspacesContract = withAuth(listVisualAgentWorkspacesReal);
export const createVisualAgentWorkspace: CreateVisualAgentWorkspaceContract = withAuth(createVisualAgentWorkspaceReal);
export const updateVisualAgentWorkspace: UpdateVisualAgentWorkspaceContract = withAuth(updateVisualAgentWorkspaceReal);
export const deleteVisualAgentWorkspace: DeleteVisualAgentWorkspaceContract = withAuth(deleteVisualAgentWorkspaceReal);
export const getVisualAgentWorkspaceDetail: GetVisualAgentWorkspaceDetailContract = withAuth(getVisualAgentWorkspaceDetailReal);
export const addVisualAgentWorkspaceMessage: AddVisualAgentWorkspaceMessageContract = withAuth(addVisualAgentWorkspaceMessageReal);
export const listVisualAgentWorkspaceMessages: ListVisualAgentWorkspaceMessagesContract = withAuth(listVisualAgentWorkspaceMessagesReal);
export const getVisualAgentWorkspaceCanvas: GetVisualAgentWorkspaceCanvasContract = withAuth(getVisualAgentWorkspaceCanvasReal);
export const saveVisualAgentWorkspaceCanvas: SaveVisualAgentWorkspaceCanvasContract = withAuth(saveVisualAgentWorkspaceCanvasReal);
export const saveVisualAgentWorkspaceViewport: SaveVisualAgentWorkspaceViewportContract = withAuth(saveVisualAgentWorkspaceViewportReal);
export const uploadVisualAgentWorkspaceAsset: UploadVisualAgentWorkspaceAssetContract = withAuth(uploadVisualAgentWorkspaceAssetReal);
export const deleteVisualAgentWorkspaceAsset: DeleteVisualAgentWorkspaceAssetContract = withAuth(deleteVisualAgentWorkspaceAssetReal);
export const createWorkspaceImageGenRun: CreateWorkspaceImageGenRunContract = withAuth(createWorkspaceImageGenRunReal);
export const refreshVisualAgentWorkspaceCover: RefreshVisualAgentWorkspaceCoverContract = withAuth(refreshVisualAgentWorkspaceCoverReal);

export const generateVisualAgentWorkspaceTitle = generateVisualAgentWorkspaceTitleReal;
export const generateArticleMarkers = generateArticleMarkersReal;
export const extractArticleMarkers = extractArticleMarkersReal;
export const exportArticle = exportArticleReal;
export const updateArticleMarker = updateArticleMarkerReal;
export const getVisualAgentImageGenModels = getVisualAgentImageGenModelsReal;
export const getVisualAgentAdapterInfo = getVisualAgentAdapterInfoReal;

export const exportConfig: ExportConfigContract = withAuth(exportConfigReal);
export const importConfig: ImportConfigContract = withAuth(importConfigReal);
export const previewImportConfig: PreviewImportConfigContract = withAuth(previewImportConfigReal);
export const getDataSummary: GetDataSummaryContract = withAuth(getDataSummaryReal);
export const purgeData: PurgeDataContract = withAuth(purgeDataReal);
export const previewUsersPurge: PreviewUsersPurgeContract = withAuth(previewUsersPurgeReal);
export const purgeUsers: PurgeUsersContract = withAuth(purgeUsersReal);

export const listLiteraryPrompts: ListLiteraryPromptsContract = withAuth(listLiteraryPromptsReal);
export const createLiteraryPrompt: CreateLiteraryPromptContract = withAuth(createLiteraryPromptReal);
export const updateLiteraryPrompt: UpdateLiteraryPromptContract = withAuth(updateLiteraryPromptReal);
export const deleteLiteraryPrompt: DeleteLiteraryPromptContract = withAuth(deleteLiteraryPromptReal);
// Literary Prompts 海鲜市场
export const listLiteraryPromptsMarketplace: ListLiteraryPromptsMarketplaceContract = withAuth(listLiteraryPromptsMarketplaceReal);
export const publishLiteraryPrompt: PublishLiteraryPromptContract = withAuth(publishLiteraryPromptReal);
export const unpublishLiteraryPrompt: UnpublishLiteraryPromptContract = withAuth(unpublishLiteraryPromptReal);
export const forkLiteraryPrompt: ForkLiteraryPromptContract = withAuth(forkLiteraryPromptReal);
export const optimizeLiteraryPrompt: OptimizeLiteraryPromptContract = withAuth(optimizeLiteraryPromptReal);

// Literary Agent Config
export const getLiteraryAgentConfig: GetLiteraryAgentConfigContract = withAuth(getLiteraryAgentConfigReal);
export const updateLiteraryAgentConfig: UpdateLiteraryAgentConfigContract = withAuth(updateLiteraryAgentConfigReal);
export const uploadReferenceImage: UploadReferenceImageContract = uploadReferenceImageReal;  // 已内置 token 处理
export const clearReferenceImage: ClearReferenceImageContract = withAuth(clearReferenceImageReal);

// Reference Image Configs (新的多配置 API)
export const listReferenceImageConfigs: ListReferenceImageConfigsContract = withAuth(listReferenceImageConfigsReal);
export const createReferenceImageConfig: CreateReferenceImageConfigContract = createReferenceImageConfigReal;  // 已内置 token 处理
export const updateReferenceImageConfig: UpdateReferenceImageConfigContract = withAuth(updateReferenceImageConfigReal);
export const updateReferenceImageFile: UpdateReferenceImageFileContract = updateReferenceImageFileReal;  // 已内置 token 处理
export const deleteReferenceImageConfig: DeleteReferenceImageConfigContract = withAuth(deleteReferenceImageConfigReal);
export const activateReferenceImageConfig: ActivateReferenceImageConfigContract = withAuth(activateReferenceImageConfigReal);
export const deactivateReferenceImageConfig: DeactivateReferenceImageConfigContract = withAuth(deactivateReferenceImageConfigReal);
export const getActiveReferenceImageConfig: GetActiveReferenceImageConfigContract = withAuth(getActiveReferenceImageConfigReal);
export const getLiteraryAgentModels: GetLiteraryAgentModelsContract = withAuth(getLiteraryAgentModelsReal);
export const getLiteraryAgentChatModels: GetLiteraryAgentChatModelsContract = withAuth(getLiteraryAgentChatModelsReal);
export const getLiteraryAgentImageGenModels: GetLiteraryAgentImageGenModelsContract = withAuth(getLiteraryAgentImageGenModelsReal);
export const getLiteraryAgentAllModels: GetLiteraryAgentAllModelsContract = withAuth(getLiteraryAgentAllModelsReal);
export const getLiteraryAgentMainModel: GetLiteraryAgentMainModelContract = withAuth(getLiteraryAgentMainModelReal);
export const createLiteraryAgentImageGenRun: CreateLiteraryAgentImageGenRunContract = withAuth(createLiteraryAgentImageGenRunReal);
export const cancelLiteraryAgentImageGenRun: CancelLiteraryAgentImageGenRunContract = withAuth(cancelLiteraryAgentImageGenRunReal);
export const streamLiteraryAgentImageGenRunWithRetry: StreamLiteraryAgentImageGenRunWithRetryContract = withAuth(streamLiteraryAgentImageGenRunWithRetryReal);
// Reference Image Configs 海鲜市场
export const listReferenceImageConfigsMarketplace: ListReferenceImageConfigsMarketplaceContract = withAuth(listReferenceImageConfigsMarketplaceReal);
export const publishReferenceImageConfig: PublishReferenceImageConfigContract = withAuth(publishReferenceImageConfigReal);
export const unpublishReferenceImageConfig: UnpublishReferenceImageConfigContract = withAuth(unpublishReferenceImageConfigReal);
export const forkReferenceImageConfig: ForkReferenceImageConfigContract = withAuth(forkReferenceImageConfigReal);

// Defect Agent
export const listDefectTemplates: ListDefectTemplatesContract = withAuth(listDefectTemplatesReal);
export const createDefectTemplate: CreateDefectTemplateContract = withAuth(createDefectTemplateReal);
export const updateDefectTemplate: UpdateDefectTemplateContract = withAuth(updateDefectTemplateReal);
export const deleteDefectTemplate: DeleteDefectTemplateContract = withAuth(deleteDefectTemplateReal);
export const shareDefectTemplate: ShareDefectTemplateContract = withAuth(shareDefectTemplateReal);
export const listDefects: ListDefectsContract = withAuth(listDefectsReal);
export const getDefect: GetDefectContract = withAuth(getDefectReal);
export const createDefect: CreateDefectContract = withAuth(createDefectReal);
export const updateDefect: UpdateDefectContract = withAuth(updateDefectReal);
export const deleteDefect: DeleteDefectContract = withAuth(deleteDefectReal);
export const submitDefect: SubmitDefectContract = withAuth(submitDefectReal);
export const processDefect: ProcessDefectContract = withAuth(processDefectReal);
export const resolveDefect: ResolveDefectContract = withAuth(resolveDefectReal);
export const rejectDefect: RejectDefectContract = withAuth(rejectDefectReal);
export const updateDefectSeverity: UpdateDefectSeverityContract = withAuth(updateDefectSeverityReal);
export const closeDefect: CloseDefectContract = withAuth(closeDefectReal);
export const reopenDefect: ReopenDefectContract = withAuth(reopenDefectReal);
export const getDefectMessages: GetDefectMessagesContract = withAuth(getDefectMessagesReal);
export const sendDefectMessage: SendDefectMessageContract = withAuth(sendDefectMessageReal);
export const addDefectAttachment: AddDefectAttachmentContract = withAuth(addDefectAttachmentReal);
export const deleteDefectAttachment: DeleteDefectAttachmentContract = withAuth(deleteDefectAttachmentReal);
export const getDefectStats: GetDefectStatsContract = withAuth(getDefectStatsReal);
export const getDefectUsers: GetDefectUsersContract = withAuth(getDefectUsersReal);
export const polishDefect: PolishDefectContract = withAuth(polishDefectReal);
export const analyzeDefectImage: AnalyzeDefectImageContract = withAuth(analyzeDefectImageReal);
export const listDeletedDefects: ListDeletedDefectsContract = withAuth(listDeletedDefectsReal);
export const restoreDefect: RestoreDefectContract = withAuth(restoreDefectReal);
export const permanentDeleteDefect: PermanentDeleteDefectContract = withAuth(permanentDeleteDefectReal);
export const listDefectFolders: ListDefectFoldersContract = withAuth(listDefectFoldersReal);
export const createDefectFolder: CreateDefectFolderContract = withAuth(createDefectFolderReal);
export const updateDefectFolder: UpdateDefectFolderContract = withAuth(updateDefectFolderReal);
export const deleteDefectFolder: DeleteDefectFolderContract = withAuth(deleteDefectFolderReal);
export const moveDefectToFolder: MoveDefectToFolderContract = withAuth(moveDefectToFolderReal);
export const batchMoveDefects: BatchMoveDefectsContract = withAuth(batchMoveDefectsReal);
export const previewApiLogs: PreviewApiLogsContract = withAuth(previewApiLogsReal);
// Phase 2: 验收
export const verifyPass: VerifyPassContract = withAuth(verifyPassReal);
export const verifyFail: VerifyFailContract = withAuth(verifyFailReal);
// Phase 1: 项目 + 团队
export const listDefectProjects: ListDefectProjectsContract = withAuth(listDefectProjectsReal);
export const createDefectProject: CreateDefectProjectContract = withAuth(createDefectProjectReal);
export const updateDefectProject: UpdateDefectProjectContract = withAuth(updateDefectProjectReal);
export const archiveDefectProject: ArchiveDefectProjectContract = withAuth(archiveDefectProjectReal);
export const listDefectTeams: ListDefectTeamsContract = withAuth(listDefectTeamsReal);
// Phase 4: 统计看板
export const getDefectStatsOverview: GetDefectStatsOverviewContract = withAuth(getDefectStatsOverviewReal);
export const getDefectStatsTrend: GetDefectStatsTrendContract = withAuth(getDefectStatsTrendReal);
export const getDefectStatsByUser: GetDefectStatsByUserContract = withAuth(getDefectStatsByUserReal);
// Phase 5: Webhook
export const listDefectWebhooks: ListDefectWebhooksContract = withAuth(listDefectWebhooksReal);
export const createDefectWebhook: CreateDefectWebhookContract = withAuth(createDefectWebhookReal);
export const updateDefectWebhook: UpdateDefectWebhookContract = withAuth(updateDefectWebhookReal);
export const deleteDefectWebhook: DeleteDefectWebhookContract = withAuth(deleteDefectWebhookReal);
// Defect Shares
export const createDefectShare: CreateDefectShareContract = withAuth(createDefectShareReal);
export const listDefectShares: ListDefectSharesContract = withAuth(listDefectSharesReal);
export const revokeDefectShare: RevokeDefectShareContract = withAuth(revokeDefectShareReal);
export const listDefectFixReports: ListDefectFixReportsContract = withAuth(listDefectFixReportsReal);
export const acceptDefectFixItem: AcceptDefectFixItemContract = withAuth(acceptDefectFixItemReal);
export const rejectDefectFixItem: RejectDefectFixItemContract = withAuth(rejectDefectFixItemReal);
export const createBatchShare: CreateBatchShareContract = withAuth(createBatchShareReal);
export const getShareScores: GetShareScoresContract = withAuth(getShareScoresReal);

// ─── Mobile Dashboard ───
export const getMobileFeed: GetMobileFeedContract = withAuth(getMobileFeedReal);
export const getMobileStats: GetMobileStatsContract = withAuth(getMobileStatsReal);
export const getMobileAssets: GetMobileAssetsContract = withAuth(getMobileAssetsReal);

// ─── Report Agent 周报管理 ───
export const listReportTeams: ListReportTeamsContract = withAuth(listReportTeamsReal);
export const getReportTeam: GetReportTeamContract = withAuth(getReportTeamReal);
export const createReportTeam: CreateReportTeamContract = withAuth(createReportTeamReal);
export const updateReportTeam: UpdateReportTeamContract = withAuth(updateReportTeamReal);
export const deleteReportTeam: DeleteReportTeamContract = withAuth(deleteReportTeamReal);
export const leaveReportTeam: LeaveReportTeamContract = withAuth(leaveReportTeamReal);
export const addReportTeamMember: AddReportTeamMemberContract = withAuth(addReportTeamMemberReal);
export const batchAddReportTeamMembers: BatchAddReportTeamMembersContract = withAuth(batchAddReportTeamMembersReal);
export const removeReportTeamMember: RemoveReportTeamMemberContract = withAuth(removeReportTeamMemberReal);
export const updateReportTeamMember: UpdateReportTeamMemberContract = withAuth(updateReportTeamMemberReal);
export const listReportUsers: ListReportUsersContract = withAuth(listReportUsersReal);
export const listReportTemplates: ListReportTemplatesContract = withAuth(listReportTemplatesReal);
export const getReportTemplate: GetReportTemplateContract = withAuth(getReportTemplateReal);
export const createReportTemplate: CreateReportTemplateContract = withAuth(createReportTemplateReal);
export const updateReportTemplate: UpdateReportTemplateContract = withAuth(updateReportTemplateReal);
export const deleteReportTemplate: DeleteReportTemplateContract = withAuth(deleteReportTemplateReal);
export const listWeeklyReports: ListWeeklyReportsContract = withAuth(listWeeklyReportsReal);
export const getWeeklyReport: GetWeeklyReportContract = withAuth(getWeeklyReportReal);
export const createWeeklyReport: CreateWeeklyReportContract = withAuth(createWeeklyReportReal);
export const updateWeeklyReport: UpdateWeeklyReportContract = withAuth(updateWeeklyReportReal);
export const uploadReportRichTextImage: UploadReportRichTextImageContract = withAuth(uploadReportRichTextImageReal);
export const uploadDailyLogImage: UploadDailyLogImageContract = withAuth(uploadDailyLogImageReal);
export const deleteWeeklyReport: DeleteWeeklyReportContract = withAuth(deleteWeeklyReportReal);
export const submitWeeklyReport: SubmitWeeklyReportContract = withAuth(submitWeeklyReportReal);
export const reviewWeeklyReport: ReviewWeeklyReportContract = withAuth(reviewWeeklyReportReal);
export const returnWeeklyReport: ReturnWeeklyReportContract = withAuth(returnWeeklyReportReal);
export const getTeamDashboard: GetTeamDashboardContract = withAuth(getTeamDashboardReal);
// Report Agent Phase 2: Daily Logs + Data Sources + AI Generation
export const saveDailyLog: SaveDailyLogContract = withAuth(saveDailyLogReal);
export const listDailyLogs: ListDailyLogsContract = withAuth(listDailyLogsReal);
export const getDailyLog: GetDailyLogContract = withAuth(getDailyLogReal);
export const deleteDailyLog: DeleteDailyLogContract = withAuth(deleteDailyLogReal);
export const listDataSources: ListDataSourcesContract = withAuth(listDataSourcesReal);
export const createDataSource: CreateDataSourceContract = withAuth(createDataSourceReal);
export const updateDataSource: UpdateDataSourceContract = withAuth(updateDataSourceReal);
export const deleteDataSource: DeleteDataSourceContract = withAuth(deleteDataSourceReal);
export const testDataSource: TestDataSourceContract = withAuth(testDataSourceReal);
export const syncDataSource: SyncDataSourceContract = withAuth(syncDataSourceReal);
export const listDataSourceCommits: ListDataSourceCommitsContract = withAuth(listDataSourceCommitsReal);
export const generateReport: GenerateReportContract = withAuth(generateReportReal);
export const getCollectedActivity: GetCollectedActivityContract = withAuth(getCollectedActivityReal);
// Report Agent Phase 3: Comments + Plan Comparison + Team Summary
export const listComments: ListCommentsContract = withAuth(listCommentsReal);
export const createComment: CreateCommentContract = withAuth(createCommentReal);
export const deleteComment: DeleteCommentContract = withAuth(deleteCommentReal);
export const listReportLikes: ListReportLikesContract = withAuth(listReportLikesReal);
export const likeReport: LikeReportContract = withAuth(likeReportReal);
export const unlikeReport: UnlikeReportContract = withAuth(unlikeReportReal);
export const recordReportView: RecordReportViewContract = withAuth(recordReportViewReal);
export const getReportViewsSummary: GetReportViewsSummaryContract = withAuth(getReportViewsSummaryReal);
export const getPlanComparison: GetPlanComparisonContract = withAuth(getPlanComparisonReal);
export const generateTeamSummary: GenerateTeamSummaryContract = withAuth(generateTeamSummaryReal);
export const getTeamSummary: GetTeamSummaryContract = withAuth(getTeamSummaryReal);
export const getTeamSummaryView: GetTeamSummaryViewContract = withAuth(getTeamSummaryViewReal);
export const getTeamReportsView: GetTeamReportsViewContract = withAuth(getTeamReportsViewReal);
// Report Agent Phase 4: Trends + Export + Vacation
export const getPersonalTrends: GetPersonalTrendsContract = withAuth(getPersonalTrendsReal);
export const getTeamTrends: GetTeamTrendsContract = withAuth(getTeamTrendsReal);
export const exportReportMarkdown = exportReportMarkdownReal;
export const exportTeamSummaryMarkdown = exportTeamSummaryMarkdownReal;
export const markVacation: MarkVacationContract = withAuth(markVacationReal);
export const cancelVacation: CancelVacationContract = withAuth(cancelVacationReal);
// Report Agent Phase 5/6 v2.0: Personal Sources + Workflow + Identity Mappings
export const listMyAiSources: ListMyAiSourcesContract = withAuth(listMyAiSourcesReal);
export const updateMyAiSource: UpdateMyAiSourceContract = withAuth(updateMyAiSourceReal);
export const getMyAiReportPrompt: GetMyAiReportPromptContract = withAuth(getMyAiReportPromptReal);
export const updateMyAiReportPrompt: UpdateMyAiReportPromptContract = withAuth(updateMyAiReportPromptReal);
export const resetMyAiReportPrompt: ResetMyAiReportPromptContract = withAuth(resetMyAiReportPromptReal);
export const getTeamAiSummaryPrompt: GetTeamAiSummaryPromptContract = withAuth(getTeamAiSummaryPromptReal);
export const updateTeamAiSummaryPrompt: UpdateTeamAiSummaryPromptContract = withAuth(updateTeamAiSummaryPromptReal);
export const resetTeamAiSummaryPrompt: ResetTeamAiSummaryPromptContract = withAuth(resetTeamAiSummaryPromptReal);
export const getMyDailyLogTags: GetMyDailyLogTagsContract = withAuth(getMyDailyLogTagsReal);
export const updateMyDailyLogTags: UpdateMyDailyLogTagsContract = withAuth(updateMyDailyLogTagsReal);
export const listPersonalSources: ListPersonalSourcesContract = withAuth(listPersonalSourcesReal);
export const createPersonalSource: CreatePersonalSourceContract = withAuth(createPersonalSourceReal);
export const updatePersonalSource: UpdatePersonalSourceContract = withAuth(updatePersonalSourceReal);
export const deletePersonalSource: DeletePersonalSourceContract = withAuth(deletePersonalSourceReal);
export const testPersonalSource: TestPersonalSourceContract = withAuth(testPersonalSourceReal);
export const syncPersonalSource: SyncPersonalSourceContract = withAuth(syncPersonalSourceReal);
export const getPersonalStats: GetPersonalStatsContract = withAuth(getPersonalStatsReal);
export const getTeamWorkflow: GetTeamWorkflowContract = withAuth(getTeamWorkflowReal);
export const runTeamWorkflow: RunTeamWorkflowContract = withAuth(runTeamWorkflowReal);
export const updateIdentityMappings: UpdateIdentityMappingsContract = withAuth(updateIdentityMappingsReal);
export const seedSystemTemplates: SeedSystemTemplatesContract = withAuth(seedSystemTemplatesReal);
export const listWebhooks: ListWebhooksContract = withAuth(listWebhooksReal);
export const createWebhook: CreateWebhookContract = withAuth(createWebhookReal);
export const updateWebhook: UpdateWebhookContract = withAuth(updateWebhookReal);
export const deleteWebhook: DeleteWebhookContract = withAuth(deleteWebhookReal);
export const testWebhook: TestWebhookContract = withAuth(testWebhookReal);
// Team-week share links
export const createTeamWeekShare = createTeamWeekShareReal;
export const listTeamWeekShares = listTeamWeekSharesReal;
export const revokeTeamWeekShare = revokeTeamWeekShareReal;
export const viewTeamWeekShare = viewTeamWeekShareReal;

// Arena 竞技场
import {
  listArenaGroupsReal,
  createArenaGroupReal,
  updateArenaGroupReal,
  deleteArenaGroupReal,
  listArenaSlotsReal,
  createArenaSlotReal,
  updateArenaSlotReal,
  deleteArenaSlotReal,
  toggleArenaSlotReal,
  getArenaLineupReal,
  revealArenaSlotsReal,
  createArenaRunReal,
  getArenaRunReal,
  cancelArenaRunReal,
  saveArenaBattleReal,
  listArenaBattlesReal,
  getArenaBattleReal,
  uploadArenaAttachmentReal,
} from '@/services/real/arena';
export type { ArenaAttachmentInfo } from '@/services/real/arena';

export const listArenaGroups = withAuth(listArenaGroupsReal);
export const createArenaGroup = withAuth(createArenaGroupReal);
export const updateArenaGroup = withAuth(updateArenaGroupReal);
export const deleteArenaGroup = withAuth(deleteArenaGroupReal);
export const listArenaSlots = withAuth(listArenaSlotsReal);
export const createArenaSlot = withAuth(createArenaSlotReal);
export const updateArenaSlot = withAuth(updateArenaSlotReal);
export const deleteArenaSlot = withAuth(deleteArenaSlotReal);
export const toggleArenaSlot = withAuth(toggleArenaSlotReal);
export const getArenaLineup = withAuth(getArenaLineupReal);
export const revealArenaSlots = withAuth(revealArenaSlotsReal);
export const createArenaRun = withAuth(createArenaRunReal);
export const getArenaRun = withAuth(getArenaRunReal);
export const cancelArenaRun = withAuth(cancelArenaRunReal);
export const saveArenaBattle = withAuth(saveArenaBattleReal);
export const listArenaBattles = withAuth(listArenaBattlesReal);
export const getArenaBattle = withAuth(getArenaBattleReal);
export const uploadArenaAttachment = uploadArenaAttachmentReal;

export const openPlatformService: IOpenPlatformService = new OpenPlatformService();
export const automationsService: IAutomationsService = new AutomationsService();
export const modelGroupsService: IModelGroupsService = new ModelGroupsService();
export const appCallersService: IAppCallersService = new AppCallersService();
export const schedulerConfigService: ISchedulerConfigService = new SchedulerConfigService();

// 导出新服务的方法
export const getModelGroups = async () => {
  const response = await modelGroupsService.getModelGroups();
  if (response.success && response.data) {
    return response.data;
  }
  throw new Error(response.error?.message || '获取模型分组失败');
};
export const createModelGroup = (data: Parameters<IModelGroupsService['createModelGroup']>[0]) => modelGroupsService.createModelGroup(data);
export const updateModelGroup = (id: string, data: Parameters<IModelGroupsService['updateModelGroup']>[1]) => modelGroupsService.updateModelGroup(id, data);
export const deleteModelGroup = (id: string) => modelGroupsService.deleteModelGroup(id);
export const getGroupMonitoring = async (groupId: string) => {
  const response = await modelGroupsService.getGroupMonitoring(groupId);
  if (response.success && response.data) {
    return response.data;
  }
  throw new Error(response.error?.message || '获取监控数据失败');
};
export const simulateDowngrade = (groupId: string, modelId: string, platformId: string, failureCount: number) => modelGroupsService.simulateDowngrade(groupId, modelId, platformId, failureCount);
export const simulateRecover = (groupId: string, modelId: string, platformId: string, successCount: number) => modelGroupsService.simulateRecover(groupId, modelId, platformId, successCount);
export const resetModelHealth = (groupId: string, modelId: string) => modelGroupsService.resetModelHealth(groupId, modelId);
export const resetAllModelsHealth = (groupId: string) => modelGroupsService.resetAllModelsHealth(groupId);
export const predictNextDispatch = async (groupId: string) => {
  const response = await modelGroupsService.predictNextDispatch(groupId);
  if (response.success && response.data) {
    return response.data;
  }
  throw new Error(response.error?.message || '获取调度预测失败');
};

export const getAppCallers = async () => {
  const response = await appCallersService.getAppCallers(1, 500);
  if (response.success && response.data) {
    return response.data.items;
  }
  throw new Error(response.error?.message || '获取应用列表失败');
};
export const updateAppCaller = (id: string, data: Parameters<IAppCallersService['updateAppCaller']>[1]) => appCallersService.updateAppCaller(id, data);
export const deleteAppCaller = (id: string) => appCallersService.deleteAppCaller(id);
export const scanAppCallers = () => appCallersService.scanAppCallers();
export const resolveModels = (items: { appCallerCode: string; modelType: string }[]) => appCallersService.resolveModels(items);

export const getSchedulerConfig = async () => {
  const response = await schedulerConfigService.getSchedulerConfig();
  if (response.success && response.data) {
    return response.data;
  }
  throw new Error(response.error?.message || '获取系统配置失败');
};
export const updateSchedulerConfig = (config: Parameters<ISchedulerConfigService['updateSchedulerConfig']>[0]) => schedulerConfigService.updateSchedulerConfig(config);

export const getUserPreferences: GetUserPreferencesContract = withAuth(getUserPreferencesReal);
export const updateNavLayout: UpdateNavLayoutContract = withAuth(updateNavLayoutReal);
export const updateThemeConfig: UpdateThemeConfigContract = withAuth(updateThemeConfigReal);
export const updateVisualAgentPreferences: UpdateVisualAgentPreferencesContract = withAuth(updateVisualAgentPreferencesReal);
export const updateLiteraryAgentPreferences: UpdateLiteraryAgentPreferencesContract = withAuth(updateLiteraryAgentPreferencesReal);
import type { UpdateAgentSwitcherPreferencesContract } from '@/services/contracts/userPreferences';
export const updateAgentSwitcherPreferences: UpdateAgentSwitcherPreferencesContract = withAuth(updateAgentSwitcherPreferencesReal);

export const getWatermarks: GetWatermarksContract = withAuth(getWatermarksReal);
export const getWatermarkByApp: GetWatermarkByAppContract = withAuth(getWatermarkByAppReal);
export const createWatermark: CreateWatermarkContract = withAuth(createWatermarkReal);
export const updateWatermark: UpdateWatermarkContract = withAuth(updateWatermarkReal);
export const deleteWatermark: DeleteWatermarkContract = withAuth(deleteWatermarkReal);
export const bindWatermarkApp: BindWatermarkAppContract = withAuth(bindWatermarkAppReal);
export const unbindWatermarkApp: UnbindWatermarkAppContract = withAuth(unbindWatermarkAppReal);
export const testWatermark = testWatermarkReal;
export const getWatermarkFonts: GetWatermarkFontsContract = withAuth(getWatermarkFontsReal);
export const uploadWatermarkFont: UploadWatermarkFontContract = withAuth(uploadWatermarkFontReal);
export const uploadWatermarkIcon: UploadWatermarkIconContract = withAuth(uploadWatermarkIconReal);
export const deleteWatermarkFont: DeleteWatermarkFontContract = withAuth(deleteWatermarkFontReal);
export const getModelSizes: GetModelSizesContract = withAuth(getModelSizesReal);
// Watermark 海鲜市场
export const listWatermarksMarketplace: ListWatermarksMarketplaceContract = withAuth(listWatermarksMarketplaceReal);
export const publishWatermark: PublishWatermarkContract = withAuth(publishWatermarkReal);
export const unpublishWatermark: UnpublishWatermarkContract = withAuth(unpublishWatermarkReal);
export const forkWatermark: ForkWatermarkContract = withAuth(forkWatermarkReal);

// 海鲜市场「技能」板块（zip 上传）
import type {
  DeleteMarketplaceSkillContract,
  FavoriteMarketplaceSkillContract,
  ForkMarketplaceSkillContract,
  GetMarketplaceSkillTagsContract,
  ListMarketplaceSkillsContract,
  ListMyFavoriteSkillsContract,
  UnfavoriteMarketplaceSkillContract,
  UploadMarketplaceSkillContract,
} from '@/services/contracts/marketplaceSkills';
import {
  deleteMarketplaceSkillReal,
  favoriteMarketplaceSkillReal,
  forkMarketplaceSkillReal,
  getMarketplaceSkillTagsReal,
  listMarketplaceSkillsReal,
  listMyFavoriteSkillsReal,
  unfavoriteMarketplaceSkillReal,
  uploadMarketplaceSkillReal,
} from '@/services/real/marketplaceSkills';
export const listMarketplaceSkills: ListMarketplaceSkillsContract = withAuth(listMarketplaceSkillsReal);
export const listMyFavoriteSkills: ListMyFavoriteSkillsContract = withAuth(listMyFavoriteSkillsReal);
export const getMarketplaceSkillTags: GetMarketplaceSkillTagsContract = withAuth(getMarketplaceSkillTagsReal);
export const uploadMarketplaceSkill: UploadMarketplaceSkillContract = withAuth(uploadMarketplaceSkillReal);
export const forkMarketplaceSkill: ForkMarketplaceSkillContract = withAuth(forkMarketplaceSkillReal);
export const favoriteMarketplaceSkill: FavoriteMarketplaceSkillContract = withAuth(favoriteMarketplaceSkillReal);
export const unfavoriteMarketplaceSkill: UnfavoriteMarketplaceSkillContract = withAuth(unfavoriteMarketplaceSkillReal);
export const deleteMarketplaceSkill: DeleteMarketplaceSkillContract = withAuth(deleteMarketplaceSkillReal);

// 限流配置服务
import type {
  GetGlobalRateLimitContract,
  UpdateGlobalRateLimitContract,
  GetUserRateLimitContract,
  UpdateUserRateLimitContract,
  GetExemptUsersContract,
  GetCustomConfigsContract,
} from '@/services/contracts/rateLimit';
import {
  getGlobalRateLimitReal,
  updateGlobalRateLimitReal,
  getUserRateLimitReal,
  updateUserRateLimitReal,
  getExemptUsersReal,
  getCustomConfigsReal,
} from '@/services/real/rateLimit';

export const getGlobalRateLimit: GetGlobalRateLimitContract = withAuth(getGlobalRateLimitReal);
export const updateGlobalRateLimit: UpdateGlobalRateLimitContract = withAuth(updateGlobalRateLimitReal);
export const getUserRateLimit: GetUserRateLimitContract = withAuth(getUserRateLimitReal);
export const updateUserRateLimit: UpdateUserRateLimitContract = withAuth(updateUserRateLimitReal);
export const getExemptUsers: GetExemptUsersContract = withAuth(getExemptUsersReal);
export const getCustomConfigs: GetCustomConfigsContract = withAuth(getCustomConfigsReal);

// Channel Adapter 多通道适配器服务
import type { IChannelService } from '@/services/contracts/channels';
import { ChannelService } from '@/services/real/channels';
export const channelService: IChannelService = new ChannelService();
// Changelog 更新中心（代码级周报）
export {
  getCurrentWeekChangelog,
  getChangelogReleases,
  getChangelogGitHubLogs,
  postChangelogAiSummary,
  listChangelogReportSources,
  createChangelogReportSource,
  updateChangelogReportSource,
  deleteChangelogReportSource,
} from '@/services/real/changelog';
export type {
  ChangelogChangeType,
  ChangelogEntry,
  ChangelogFragment,
  CurrentWeekView,
  ChangelogDay,
  ChangelogRelease,
  ReleasesView,
  GitHubLogEntry,
  GitHubLogsView,
  ChangelogAiSummarySubtab,
  ChangelogAiSummaryDto,
  ChangelogReportSource,
  ChangelogReportSourceUpsert,
} from '@/services/real/changelog';

// Weekly Poster 周报海报（登录后主页轮播弹窗）
export {
  getCurrentWeeklyPoster,
  listWeeklyPosters,
  getWeeklyPoster,
  createWeeklyPoster,
  updateWeeklyPoster,
  deleteWeeklyPoster,
  publishWeeklyPoster,
  unpublishWeeklyPoster,
  listWeeklyPosterTemplates,
  autopilotWeeklyPoster,
  generateWeeklyPosterPageImage,
} from '@/services/real/weeklyPoster';
export type {
  WeeklyPoster,
  WeeklyPosterPage,
  WeeklyPosterStatus,
  WeeklyPosterListView,
  WeeklyPosterUpsertInput,
  WeeklyPosterTemplateKey,
  WeeklyPosterPresentationMode,
  WeeklyPosterSourceType,
  WeeklyPosterTemplateMeta,
  WeeklyPosterAutopilotResult,
  WeeklyPosterAutopilotInput,
} from '@/services/real/weeklyPoster';

// AI Toolbox 百宝箱
export {
  // 新版工具集合 API
  listToolboxItems,
  getToolboxItem,
  createToolboxItem,
  updateToolboxItem,
  deleteToolboxItem,
  runToolboxItem,
  listToolboxAgents,
  subscribeToolboxRunEvents,
  streamDirectChat,
  streamCapabilityChat,
  uploadAttachment,
  // Session & Messages
  listToolboxSessions,
  createToolboxSession,
  deleteToolboxSession,
  listToolboxMessages,
  appendToolboxMessage,
  // Marketplace
  listMarketplaceItems,
  forkToolboxItem,
  toggleToolboxItemPublish,
  // Legacy API
  getToolboxRun,
  listToolboxRuns,
} from '@/services/real/aiToolbox';
export type {
  ToolboxItem,
  ToolboxItemRun,
  AgentInfo,
  UploadedAttachment,
  ToolboxRunEvent,
  DirectChatMessage,
  ToolboxSessionInfo,
  ToolboxMessageInfo,
  // Legacy types
  IntentResult,
  ToolboxArtifact,
  ToolboxRun,
  ToolboxRunStep,
} from '@/services/real/aiToolbox';

// Workflow Agent 工作流引擎
import type {
  ListWorkflowsContract,
  CreateWorkflowContract,
  GetWorkflowContract,
  UpdateWorkflowContract,
  DeleteWorkflowContract,
  ExecuteWorkflowContract,
  ListExecutionsContract,
  GetExecutionContract,
  CancelExecutionContract,
  ResumeFromNodeContract,
  ContinueExecutionContract,
  GetNodeLogsContract,
  CreateShareLinkContract,
  ListShareLinksContract,
  RevokeShareContract,
  ListCapsuleTypesContract,
  GetCapsuleTypeContract,
  TestRunCapsuleContract,
  GetChatHistoryContract,
  AiFillParametersContract,
} from '@/services/contracts/workflowAgent';
import {
  listWorkflowsReal,
  createWorkflowReal,
  getWorkflowReal,
  updateWorkflowReal,
  deleteWorkflowReal,
  executeWorkflowReal,
  listExecutionsReal,
  getExecutionReal,
  cancelExecutionReal,
  resumeFromNodeReal,
  continueExecutionReal,
  getNodeLogsReal,
  createShareLinkReal,
  listShareLinksReal,
  revokeShareReal,
  listCapsuleTypesReal,
  getCapsuleTypeReal,
  testRunCapsuleReal,
  getChatHistoryReal,
  aiFillParametersReal,
} from '@/services/real/workflowAgent';

export const listWorkflows: ListWorkflowsContract = withAuth(listWorkflowsReal);
export const createWorkflow: CreateWorkflowContract = withAuth(createWorkflowReal);
export const getWorkflow: GetWorkflowContract = withAuth(getWorkflowReal);
export const updateWorkflow: UpdateWorkflowContract = withAuth(updateWorkflowReal);
export const deleteWorkflow: DeleteWorkflowContract = withAuth(deleteWorkflowReal);
export const executeWorkflow: ExecuteWorkflowContract = withAuth(executeWorkflowReal);
export const listExecutions: ListExecutionsContract = withAuth(listExecutionsReal);
export const getExecution: GetExecutionContract = withAuth(getExecutionReal);
export const cancelExecution: CancelExecutionContract = withAuth(cancelExecutionReal);
export const resumeFromNode: ResumeFromNodeContract = withAuth(resumeFromNodeReal);
export const continueExecution: ContinueExecutionContract = withAuth(continueExecutionReal);
export const getNodeLogs: GetNodeLogsContract = withAuth(getNodeLogsReal);
export const createShareLink: CreateShareLinkContract = withAuth(createShareLinkReal);
export const listShareLinks: ListShareLinksContract = withAuth(listShareLinksReal);
export const revokeShare: RevokeShareContract = withAuth(revokeShareReal);
export const listCapsuleTypes: ListCapsuleTypesContract = withAuth(listCapsuleTypesReal);
export const getCapsuleType: GetCapsuleTypeContract = withAuth(getCapsuleTypeReal);
export const testRunCapsule: TestRunCapsuleContract = withAuth(testRunCapsuleReal);
export const getChatHistory: GetChatHistoryContract = withAuth(getChatHistoryReal);
export { chatWorkflowReal as chatWorkflow } from '@/services/real/workflowAgent';
export { analyzeExecutionReal as analyzeExecution } from '@/services/real/workflowAgent';
export { validateTapdCookie } from '@/services/real/workflowAgent';
export const aiFillParameters: AiFillParametersContract = withAuth(aiFillParametersReal);

// 数据迁移服务
import type {
  GetCollectionMappingsContract,
  GetCollectionDataContract,
  ValidateCollectionContract,
  DeleteCollectionContract,
  DeleteDocumentContract,
  DeleteAppDataContract,
} from '@/services/contracts/data-migration';
import {
  getCollectionMappingsReal,
  getCollectionDataReal,
  validateCollectionReal,
  deleteCollectionReal,
  deleteDocumentReal,
  deleteAppDataReal,
} from '@/services/real/data-migration';

export const getCollectionMappings: GetCollectionMappingsContract = withAuth(getCollectionMappingsReal);
export const getCollectionData: GetCollectionDataContract = withAuth(getCollectionDataReal);
export const validateCollection: ValidateCollectionContract = withAuth(validateCollectionReal);
export const deleteCollection: DeleteCollectionContract = withAuth(deleteCollectionReal);
export const deleteDocument: DeleteDocumentContract = withAuth(deleteDocumentReal);
export const deleteAppData: DeleteAppDataContract = withAuth(deleteAppDataReal);

// Tutorial Email 教程邮件
export {
  listTutorialEmailSequences,
  getTutorialEmailSequence,
  createTutorialEmailSequence,
  updateTutorialEmailSequence,
  deleteTutorialEmailSequence,
  listTutorialEmailTemplates,
  getTutorialEmailTemplate,
  createTutorialEmailTemplate,
  updateTutorialEmailTemplate,
  deleteTutorialEmailTemplate,
  listTutorialEmailAssets,
  createTutorialEmailAsset,
  deleteTutorialEmailAsset,
  listTutorialEmailEnrollments,
  enrollTutorialEmailUser,
  unsubscribeTutorialEmailEnrollment,
  batchEnrollTutorialEmail,
  testSendTutorialEmail,
  generateTutorialEmailTemplate,
  quickSendTutorialEmail,
} from '@/services/real/tutorialEmail';
export type {
  TutorialEmailSequence,
  TutorialEmailTemplate,
  TutorialEmailAsset,
  TutorialEmailEnrollment,
  TutorialEmailStep,
} from '@/services/real/tutorialEmail';

// ── Web Hosting 网页托管 ──
export {
  uploadSite,
  reuploadSite,
  createFromContent,
  listSites,
  getSite,
  updateSite,
  deleteSite,
  batchDeleteSites,
  setSiteVisibility,
  listFolders as listSiteFolders,
  listTags as listSiteTags,
  createShareLink as createSiteShareLink,
  listShares as listSiteShares,
  revokeShare as revokeSiteShare,
  viewShare as viewSiteShare,
  saveSharedSite,
  listShareViewLogs,
} from '@/services/real/webPages';
export type { HostedSite, HostedSiteFile, ShareLinkItem, TagCount, SharedSiteInfo, ShareViewData, ShareViewLogItem } from '@/services/real/webPages';

// ── Public Profile 个人公开主页 ──
export {
  fetchPublicProfile,
  updateMyPublicPage,
  retractPublicItem,
} from '@/services/real/publicProfile';
export type { RetractDomain } from '@/services/real/publicProfile';
export type {
  PublicProfile,
  PublicProfileUser,
  PublicSection,
  PublicSite,
  PublicSkill,
  PublicProfileDocumentStore,
  PublicLiteraryPrompt,
  PublicWorkspace,
  PublicEmergenceTree,
  PublicWorkflow,
} from '@/services/real/publicProfile';

// ── Account Data Transfer 数据分享 ──
export {
  listTransfersReal as listTransfers,
  getTransferReal as getTransfer,
  createTransferReal as createTransfer,
  acceptTransferReal as acceptTransfer,
  rejectTransferReal as rejectTransfer,
  cancelTransferReal as cancelTransfer,
  listMyWorkspacesReal as listMyWorkspaces,
  listMyConfigsReal as listMyConfigs,
} from '@/services/real/dataTransfer';

// ── Review Agent 产品评审员 ──
export {
  getDimensions as getReviewDimensions,
  updateDimensions as updateReviewDimensions,
  createSubmission as createReviewSubmission,
  getMySubmissions as getMyReviewSubmissions,
  getAllSubmissions as getAllReviewSubmissions,
  getSubmission as getReviewSubmission,
  rerunSubmission as rerunReviewSubmission,
  getResultStreamUrl as getReviewResultStreamUrl,
  getSubmitters as getReviewSubmitters,
  listReviewWebhooks,
  createReviewWebhook,
  updateReviewWebhook,
  deleteReviewWebhook,
  testReviewWebhook,
} from '@/services/real/reviewAgent';
export type {
  ReviewDimensionConfig,
  ReviewDimensionScore,
  ReviewSubmission,
  ReviewResult,
  ReviewWebhookConfig,
} from '@/services/real/reviewAgent';

// ============ PR Review（pr-review）基于每用户 GitHub Device Flow 的审查工作台 ============
export {
  getPrReviewAuthStatus,
  startPrReviewDeviceFlow,
  pollPrReviewDeviceFlow,
  disconnectPrReviewGitHub,
  listPrReviewItems,
  createPrReviewItem,
  refreshPrReviewItem,
  updatePrReviewItemNote,
  deletePrReviewItem,
  getPrReviewAlignment,
  getPrReviewAlignmentStreamUrl,
  getPrReviewSummary,
  getPrReviewSummaryStreamUrl,
} from '@/services/real/prReview';
export type {
  PrReviewState,
  PrReviewSnapshotDto,
  PrReviewItemDto,
  PrReviewListResponse,
  PrReviewAuthStatus,
  PrReviewDeviceFlowStart,
  PrReviewDeviceFlowPoll,
  PrReviewDeviceFlowPollStatus,
  PrAlignmentReportDto,
  PrSummaryReportDto,
} from '@/services/real/prReview';

// ── Document Store 文档空间 ──
export {
  createDocumentStoreReal as createDocumentStore,
  listDocumentStoresReal as listDocumentStores,
  getDocumentStoreReal as getDocumentStore,
  updateDocumentStoreReal as updateDocumentStore,
  deleteDocumentStoreReal as deleteDocumentStore,
  addDocumentEntryReal as addDocumentEntry,
  listDocumentEntriesReal as listDocumentEntries,
  updateDocumentEntryReal as updateDocumentEntry,
  deleteDocumentEntryReal as deleteDocumentEntry,
  uploadDocumentFile,
  getDocumentContent,
  addSubscription,
  addGitHubSubscription,
  setPrimaryEntry,
  createFolder,
  triggerSync,
  listSubscriptionDetail,
  updateSubscription,
  generateSubtitle,
  listReprocessTemplates,
  startReprocess,
  getAgentRun,
  getLatestAgentRun,
  // 批次 C：浏览事件埋点
  logEntryView,
  leaveEntryView,
  listStoreViewEvents,
  // 批次 D：划词评论
  createInlineComment,
  listInlineComments,
  deleteInlineComment,
  togglePinnedEntry,
  listDocumentStoresWithPreview,
  searchDocumentEntries,
  moveDocumentEntry,
  updateDocumentContent,
  setFolderPrimaryChild,
  rebuildContentIndex,
  listPublicDocumentStores,
  getPublicDocumentStore,
  listPublicStoreEntries,
  getPublicEntryContent,
  likeDocumentStore,
  unlikeDocumentStore,
  favoriteDocumentStore,
  unfavoriteDocumentStore,
  listMyFavoriteDocumentStores,
  listMyLikedDocumentStores,
  createShareLink as createDocStoreShareLink,
  listShareLinks as listDocStoreShareLinks,
  revokeShareLink as revokeDocStoreShareLink,
} from '@/services/real/documentStore';
export type {
  DocumentStore,
  DocumentEntry,
  DocumentStoreWithPreview,
  InteractionStoreCard,
  PublicDocumentStore,
  PublicStoreDetail,
  DocumentStoreShareLink,
  CreateDocumentStoreInput,
  AddDocumentEntryInput,
  DocumentSyncLogEntry,
  SubscriptionDetail,
  DocumentStoreAgentRun,
  ReprocessTemplate,
  DocumentStoreViewEvent,
  DocumentStoreViewStats,
  DocumentInlineComment,
} from '@/services/contracts/documentStore';

// ── Emergence Explorer 涌现探索器 ──
export {
  createEmergenceTreeReal as createEmergenceTree,
  listEmergenceTreesReal as listEmergenceTrees,
  getEmergenceTreeReal as getEmergenceTree,
  deleteEmergenceTreeReal as deleteEmergenceTree,
  updateEmergenceNodeReal as updateEmergenceNode,
  deleteEmergenceNodeReal as deleteEmergenceNode,
  exportEmergenceTreeReal as exportEmergenceTree,
} from '@/services/real/emergence';
export type {
  EmergenceTree,
  EmergenceNode,
  CreateEmergenceTreeInput,
  UpdateEmergenceNodeInput,
} from '@/services/contracts/emergence';
