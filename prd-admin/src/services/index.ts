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
} from '@/services/contracts/adminUsers';
import type { GetActiveGroupsContract, GetGapStatsContract, GetMessageTrendContract, GetOverviewStatsContract, GetTokenUsageContract } from '@/services/contracts/adminStats';
import type { CreatePlatformContract, DeletePlatformContract, GetPlatformsContract, UpdatePlatformContract } from '@/services/contracts/platforms';
import type { ClearImageGenModelContract, ClearIntentModelContract, ClearVisionModelContract, CreateModelContract, DeleteModelContract, GetModelsContract, SetImageGenModelContract, SetIntentModelContract, SetMainModelContract, SetVisionModelContract, TestModelContract, UpdateModelContract, UpdateModelPrioritiesContract, GetModelAdapterInfoContract, GetModelsAdapterInfoBatchContract, GetAdapterInfoByModelNameContract } from '@/services/contracts/models';
import type { ActivateLLMConfigContract, CreateLLMConfigContract, DeleteLLMConfigContract, GetLLMConfigsContract, UpdateLLMConfigContract } from '@/services/contracts/llmConfigs';
import type { GetLlmLogDetailContract, GetLlmLogsContract, GetLlmLogsMetaContract, GetLlmModelStatsContract } from '@/services/contracts/llmLogs';
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
import type { GetAdminPromptsContract, PutAdminPromptsContract, ResetAdminPromptsContract } from '@/services/contracts/prompts';
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
  GetLiteraryAgentImageGenModelsContract,
  GetLiteraryAgentAllModelsContract,
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
} from '@/services/contracts/defectAgent';
import type { IOpenPlatformService } from '@/services/contracts/openPlatform';
import type { IModelGroupsService } from '@/services/contracts/modelGroups';
import type { IAppCallersService } from '@/services/contracts/appCallers';
import type { ISchedulerConfigService } from '@/services/contracts/schedulerConfig';
import type { GetUserPreferencesContract, UpdateNavOrderContract, UpdateThemeConfigContract, UpdateVisualAgentPreferencesContract } from '@/services/contracts/userPreferences';
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
  initializeUsersReal,
} from '@/services/real/adminUsers';
import { getActiveGroupsReal, getGapStatsReal, getMessageTrendReal, getOverviewStatsReal, getTokenUsageReal } from '@/services/real/adminStats';
import { createPlatformReal, deletePlatformReal, getPlatformsReal, updatePlatformReal } from '@/services/real/platforms';
import { clearImageGenModelReal, clearIntentModelReal, clearVisionModelReal, createModelReal, deleteModelReal, getModelsReal, setImageGenModelReal, setIntentModelReal, setMainModelReal, setVisionModelReal, testModelReal, updateModelReal, updateModelPrioritiesReal, getModelAdapterInfoReal, getModelsAdapterInfoBatchReal, getAdapterInfoByModelNameReal } from '@/services/real/models';
import { activateLLMConfigReal, createLLMConfigReal, deleteLLMConfigReal, getLLMConfigsReal, updateLLMConfigReal } from '@/services/real/llmConfigs';
import { getLlmLogDetailReal, getLlmLogsMetaReal, getLlmLogsReal, getLlmModelStatsReal, getBatchModelStatsReal } from '@/services/real/llmLogs';
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
import { getAiChatHistoryReal, uploadAiChatDocumentReal } from '@/services/real/aiChat';
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
import { getAdminPromptsReal, putAdminPromptsReal, resetAdminPromptsReal } from '@/services/real/prompts';
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
import { getDesktopBrandingSettings as getDesktopBrandingSettingsReal, updateDesktopBrandingSettings as updateDesktopBrandingSettingsReal } from '@/services/real/desktopBranding';
import {
  listLiteraryPromptsReal,
  createLiteraryPromptReal,
  updateLiteraryPromptReal,
  deleteLiteraryPromptReal,
  listLiteraryPromptsMarketplaceReal,
  publishLiteraryPromptReal,
  unpublishLiteraryPromptReal,
  forkLiteraryPromptReal,
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
  getLiteraryAgentImageGenModelsReal,
  getLiteraryAgentAllModelsReal,
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
  closeDefectReal,
  reopenDefectReal,
  getDefectMessagesReal,
  sendDefectMessageReal,
  addDefectAttachmentReal,
  deleteDefectAttachmentReal,
  getDefectStatsReal,
  getDefectUsersReal,
  polishDefectReal,
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
} from '@/services/real/defectAgent';
import { OpenPlatformService } from '@/services/real/openPlatform';
import { ModelGroupsService } from '@/services/real/modelGroups';
import { AppCallersService } from '@/services/real/appCallers';
import { SchedulerConfigService } from '@/services/real/schedulerConfig';
import { getUserPreferencesReal, updateNavOrderReal, updateThemeConfigReal, updateVisualAgentPreferencesReal } from '@/services/real/userPreferences';
import {
  getAdminNotificationsReal,
  handleAdminNotificationReal,
  handleAllAdminNotificationsReal,
} from '@/services/real/notifications';

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
export const initializeUsers = withAuth(initializeUsersReal);
export const getUserProfile: GetUserProfileContract = withAuth(getUserProfileReal);

export const getOverviewStats: GetOverviewStatsContract = withAuth(getOverviewStatsReal);
export const getTokenUsage: GetTokenUsageContract = withAuth(getTokenUsageReal);
export const getMessageTrend: GetMessageTrendContract = withAuth(getMessageTrendReal);
export const getActiveGroups: GetActiveGroupsContract = withAuth(getActiveGroupsReal);
export const getGapStats: GetGapStatsContract = withAuth(getGapStatsReal);

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
export const listUploadArtifacts: ListUploadArtifactsContract = withAuth(listUploadArtifactsReal);
export const getAdminDocumentContent: GetAdminDocumentContentContract = withAuth(getAdminDocumentContentReal);

export const getApiLogs: GetApiLogsContract = withAuth(getApiLogsReal);
export const getApiLogDetail: GetApiLogDetailContract = withAuth(getApiLogDetailReal);

export const getAdminPrompts: GetAdminPromptsContract = withAuth(getAdminPromptsReal);
export const putAdminPrompts: PutAdminPromptsContract = withAuth(putAdminPromptsReal);
export const resetAdminPrompts: ResetAdminPromptsContract = withAuth(resetAdminPromptsReal);
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

export const getDesktopBrandingSettings: GetDesktopBrandingSettingsContract = withAuth(getDesktopBrandingSettingsReal);
export const updateDesktopBrandingSettings: UpdateDesktopBrandingSettingsContract = withAuth(updateDesktopBrandingSettingsReal);

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
export const getLiteraryAgentImageGenModels: GetLiteraryAgentImageGenModelsContract = withAuth(getLiteraryAgentImageGenModelsReal);
export const getLiteraryAgentAllModels: GetLiteraryAgentAllModelsContract = withAuth(getLiteraryAgentAllModelsReal);
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
export const closeDefect: CloseDefectContract = withAuth(closeDefectReal);
export const reopenDefect: ReopenDefectContract = withAuth(reopenDefectReal);
export const getDefectMessages: GetDefectMessagesContract = withAuth(getDefectMessagesReal);
export const sendDefectMessage: SendDefectMessageContract = withAuth(sendDefectMessageReal);
export const addDefectAttachment: AddDefectAttachmentContract = withAuth(addDefectAttachmentReal);
export const deleteDefectAttachment: DeleteDefectAttachmentContract = withAuth(deleteDefectAttachmentReal);
export const getDefectStats: GetDefectStatsContract = withAuth(getDefectStatsReal);
export const getDefectUsers: GetDefectUsersContract = withAuth(getDefectUsersReal);
export const polishDefect: PolishDefectContract = withAuth(polishDefectReal);
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

export const openPlatformService: IOpenPlatformService = new OpenPlatformService();
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
  const response = await appCallersService.getAppCallers();
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
export const updateNavOrder: UpdateNavOrderContract = withAuth(updateNavOrderReal);
export const updateThemeConfig: UpdateThemeConfigContract = withAuth(updateThemeConfigReal);
export const updateVisualAgentPreferences: UpdateVisualAgentPreferencesContract = withAuth(updateVisualAgentPreferencesReal);

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
  // Legacy API
  getToolboxRun,
  listToolboxRuns,
} from '@/services/real/aiToolbox';
export type {
  ToolboxItem,
  ToolboxItemRun,
  AgentInfo,
  ToolboxRunEvent,
  DirectChatMessage,
  // Legacy types
  IntentResult,
  ToolboxArtifact,
  ToolboxRun,
  ToolboxRunStep,
} from '@/services/real/aiToolbox';

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
