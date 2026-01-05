// 生产环境：严禁 mock/假数据。此处只允许真实后端实现。

import type { LoginContract } from '@/services/contracts/auth';
import type {
  GetUsersContract,
  GenerateInviteCodesContract,
  CreateAdminUserContract,
  BulkCreateAdminUsersContract,
  UpdateUserPasswordContract,
  UpdateUserAvatarContract,
  UpdateUserRoleContract,
  UpdateUserStatusContract,
  UnlockUserContract,
  ForceExpireUserContract,
} from '@/services/contracts/adminUsers';
import type { GetActiveGroupsContract, GetGapStatsContract, GetMessageTrendContract, GetOverviewStatsContract, GetTokenUsageContract } from '@/services/contracts/adminStats';
import type { CreatePlatformContract, DeletePlatformContract, GetPlatformsContract, UpdatePlatformContract } from '@/services/contracts/platforms';
import type { ClearImageGenModelContract, ClearIntentModelContract, ClearVisionModelContract, CreateModelContract, DeleteModelContract, GetModelsContract, SetImageGenModelContract, SetIntentModelContract, SetMainModelContract, SetVisionModelContract, TestModelContract, UpdateModelContract, UpdateModelPrioritiesContract } from '@/services/contracts/models';
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
import type {
  AddImageMasterMessageContract,
  AddImageMasterWorkspaceMessageContract,
  CreateImageMasterSessionContract,
  CreateImageMasterWorkspaceContract,
  DeleteImageMasterAssetContract,
  DeleteImageMasterWorkspaceContract,
  RefreshImageMasterWorkspaceCoverContract,
  GetImageMasterCanvasContract,
  GetImageMasterSessionContract,
  GetImageMasterWorkspaceCanvasContract,
  GetImageMasterWorkspaceDetailContract,
  ListImageMasterSessionsContract,
  ListImageMasterWorkspacesContract,
  SaveImageMasterCanvasContract,
  SaveImageMasterWorkspaceCanvasContract,
  SaveImageMasterWorkspaceViewportContract,
  UploadImageAssetContract,
  UploadImageMasterWorkspaceAssetContract,
  DeleteImageMasterWorkspaceAssetContract,
  UpdateImageMasterWorkspaceContract,
  CreateWorkspaceImageGenRunContract,
} from '@/services/contracts/imageMaster';
import type {
  CreateDesktopAssetKeyContract,
  CreateDesktopAssetSkinContract,
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
  UpdateAdminGapStatusContract,
  UpdateAdminGroupContract,
} from '@/services/contracts/adminGroups';
import { useAuthStore } from '@/stores/authStore';
import { fail, type ApiResponse } from '@/types/api';

import { loginReal } from '@/services/real/auth';
import {
  getUsersReal,
  generateInviteCodesReal,
  createUserReal,
  bulkCreateUsersReal,
  updateUserPasswordReal,
  updateUserAvatarReal,
  updateUserRoleReal,
  updateUserStatusReal,
  unlockUserReal,
  forceExpireUserReal,
} from '@/services/real/adminUsers';
import { getActiveGroupsReal, getGapStatsReal, getMessageTrendReal, getOverviewStatsReal, getTokenUsageReal } from '@/services/real/adminStats';
import { createPlatformReal, deletePlatformReal, getPlatformsReal, updatePlatformReal } from '@/services/real/platforms';
import { clearImageGenModelReal, clearIntentModelReal, clearVisionModelReal, createModelReal, deleteModelReal, getModelsReal, setImageGenModelReal, setIntentModelReal, setMainModelReal, setVisionModelReal, testModelReal, updateModelReal, updateModelPrioritiesReal } from '@/services/real/models';
import { activateLLMConfigReal, createLLMConfigReal, deleteLLMConfigReal, getLLMConfigsReal, updateLLMConfigReal } from '@/services/real/llmConfigs';
import { getLlmLogDetailReal, getLlmLogsMetaReal, getLlmLogsReal, getLlmModelStatsReal } from '@/services/real/llmLogs';
import { getAdminDocumentContentReal } from '@/services/real/adminDocuments';
import { listUploadArtifactsReal } from '@/services/real/uploadArtifacts';
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
  addImageMasterMessageReal,
  addImageMasterWorkspaceMessageReal,
  createImageMasterSessionReal,
  createImageMasterWorkspaceReal,
  deleteImageMasterAssetReal,
  deleteImageMasterWorkspaceReal,
  refreshImageMasterWorkspaceCoverReal,
  getImageMasterCanvasReal,
  getImageMasterSessionReal,
  getImageMasterWorkspaceCanvasReal,
  getImageMasterWorkspaceDetailReal,
  listImageMasterSessionsReal,
  listImageMasterWorkspacesReal,
  saveImageMasterCanvasReal,
  saveImageMasterWorkspaceCanvasReal,
  saveImageMasterWorkspaceViewportReal,
  uploadImageAssetReal,
  uploadImageMasterWorkspaceAssetReal,
  deleteImageMasterWorkspaceAssetReal,
  updateImageMasterWorkspaceReal,
  createWorkspaceImageGenRunReal,
} from '@/services/real/imageMaster';
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
  updateAdminGapStatusReal,
  updateAdminGroupReal,
} from '@/services/real/adminGroups';
import {
  createDesktopAssetKey as createDesktopAssetKeyReal,
  createDesktopAssetSkin as createDesktopAssetSkinReal,
  deleteDesktopAssetSkin as deleteDesktopAssetSkinReal,
  listDesktopAssetKeys as listDesktopAssetKeysReal,
  listDesktopAssetSkins as listDesktopAssetSkinsReal,
  updateDesktopAssetSkin as updateDesktopAssetSkinReal,
  uploadDesktopAsset as uploadDesktopAssetReal,
} from '@/services/real/desktopAssets';
import { getDesktopBrandingSettings as getDesktopBrandingSettingsReal, updateDesktopBrandingSettings as updateDesktopBrandingSettingsReal } from '@/services/real/desktopBranding';

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

export const getUsers: GetUsersContract = withAuth(getUsersReal);
export const createUser: CreateAdminUserContract = withAuth(createUserReal);
export const bulkCreateUsers: BulkCreateAdminUsersContract = withAuth(bulkCreateUsersReal);
export const updateUserRole: UpdateUserRoleContract = withAuth(updateUserRoleReal);
export const updateUserStatus: UpdateUserStatusContract = withAuth(updateUserStatusReal);
export const updateUserPassword: UpdateUserPasswordContract = withAuth(updateUserPasswordReal);
export const updateUserAvatar: UpdateUserAvatarContract = withAuth(updateUserAvatarReal);
export const unlockUser: UnlockUserContract = withAuth(unlockUserReal);
export const generateInviteCodes: GenerateInviteCodesContract = withAuth(generateInviteCodesReal);
export const forceExpireUser: ForceExpireUserContract = withAuth(forceExpireUserReal);

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

export const getLLMConfigs: GetLLMConfigsContract = withAuth(getLLMConfigsReal);
export const createLLMConfig: CreateLLMConfigContract = withAuth(createLLMConfigReal);
export const updateLLMConfig: UpdateLLMConfigContract = withAuth(updateLLMConfigReal);
export const deleteLLMConfig: DeleteLLMConfigContract = withAuth(deleteLLMConfigReal);
export const activateLLMConfig: ActivateLLMConfigContract = withAuth(activateLLMConfigReal);

export const getLlmLogs: GetLlmLogsContract = withAuth(getLlmLogsReal);
export const getLlmLogDetail: GetLlmLogDetailContract = withAuth(getLlmLogDetailReal);
export const getLlmLogsMeta: GetLlmLogsMetaContract = withAuth(getLlmLogsMetaReal);
export const getLlmModelStats: GetLlmModelStatsContract = withAuth(getLlmModelStatsReal);
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
export const uploadDesktopAsset: UploadDesktopAssetContract = withAuth(uploadDesktopAssetReal);

export const getDesktopBrandingSettings: GetDesktopBrandingSettingsContract = withAuth(getDesktopBrandingSettingsReal);
export const updateDesktopBrandingSettings: UpdateDesktopBrandingSettingsContract = withAuth(updateDesktopBrandingSettingsReal);

export const createImageMasterSession: CreateImageMasterSessionContract = withAuth(createImageMasterSessionReal);
export const listImageMasterSessions: ListImageMasterSessionsContract = withAuth(listImageMasterSessionsReal);
export const getImageMasterSession: GetImageMasterSessionContract = withAuth(getImageMasterSessionReal);
export const addImageMasterMessage: AddImageMasterMessageContract = withAuth(addImageMasterMessageReal);
export const uploadImageAsset: UploadImageAssetContract = withAuth(uploadImageAssetReal);
export const deleteImageMasterAsset: DeleteImageMasterAssetContract = withAuth(deleteImageMasterAssetReal);
export const getImageMasterCanvas: GetImageMasterCanvasContract = withAuth(getImageMasterCanvasReal);
export const saveImageMasterCanvas: SaveImageMasterCanvasContract = withAuth(saveImageMasterCanvasReal);

export const listImageMasterWorkspaces: ListImageMasterWorkspacesContract = withAuth(listImageMasterWorkspacesReal);
export const createImageMasterWorkspace: CreateImageMasterWorkspaceContract = withAuth(createImageMasterWorkspaceReal);
export const updateImageMasterWorkspace: UpdateImageMasterWorkspaceContract = withAuth(updateImageMasterWorkspaceReal);
export const deleteImageMasterWorkspace: DeleteImageMasterWorkspaceContract = withAuth(deleteImageMasterWorkspaceReal);
export const getImageMasterWorkspaceDetail: GetImageMasterWorkspaceDetailContract = withAuth(getImageMasterWorkspaceDetailReal);
export const addImageMasterWorkspaceMessage: AddImageMasterWorkspaceMessageContract = withAuth(addImageMasterWorkspaceMessageReal);
export const getImageMasterWorkspaceCanvas: GetImageMasterWorkspaceCanvasContract = withAuth(getImageMasterWorkspaceCanvasReal);
export const saveImageMasterWorkspaceCanvas: SaveImageMasterWorkspaceCanvasContract = withAuth(saveImageMasterWorkspaceCanvasReal);
export const saveImageMasterWorkspaceViewport: SaveImageMasterWorkspaceViewportContract = withAuth(saveImageMasterWorkspaceViewportReal);
export const uploadImageMasterWorkspaceAsset: UploadImageMasterWorkspaceAssetContract = withAuth(uploadImageMasterWorkspaceAssetReal);
export const deleteImageMasterWorkspaceAsset: DeleteImageMasterWorkspaceAssetContract = withAuth(deleteImageMasterWorkspaceAssetReal);
export const createWorkspaceImageGenRun: CreateWorkspaceImageGenRunContract = withAuth(createWorkspaceImageGenRunReal);
export const refreshImageMasterWorkspaceCover: RefreshImageMasterWorkspaceCoverContract = withAuth(refreshImageMasterWorkspaceCoverReal);

export const exportConfig: ExportConfigContract = withAuth(exportConfigReal);
export const importConfig: ImportConfigContract = withAuth(importConfigReal);
export const previewImportConfig: PreviewImportConfigContract = withAuth(previewImportConfigReal);
export const getDataSummary: GetDataSummaryContract = withAuth(getDataSummaryReal);
export const purgeData: PurgeDataContract = withAuth(purgeDataReal);
export const previewUsersPurge: PreviewUsersPurgeContract = withAuth(previewUsersPurgeReal);
export const purgeUsers: PurgeUsersContract = withAuth(purgeUsersReal);
