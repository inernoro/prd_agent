// 默认走真实后端；需要离线演示/开发时可通过 VITE_USE_MOCK=true 切到 mock 实现

import type { LoginContract } from '@/services/contracts/auth';
import type { GetUsersContract, GenerateInviteCodesContract, UpdateUserRoleContract, UpdateUserStatusContract } from '@/services/contracts/adminUsers';
import type { GetActiveGroupsContract, GetGapStatsContract, GetMessageTrendContract, GetOverviewStatsContract, GetTokenUsageContract } from '@/services/contracts/adminStats';
import type { CreatePlatformContract, DeletePlatformContract, GetPlatformsContract, UpdatePlatformContract } from '@/services/contracts/platforms';
import type { CreateModelContract, DeleteModelContract, GetModelsContract, SetMainModelContract, TestModelContract, UpdateModelContract } from '@/services/contracts/models';
import type { ActivateLLMConfigContract, CreateLLMConfigContract, DeleteLLMConfigContract, GetLLMConfigsContract, UpdateLLMConfigContract } from '@/services/contracts/llmConfigs';
import { useAuthStore } from '@/stores/authStore';
import { fail, type ApiResponse } from '@/types/api';

import { loginMock } from '@/services/mock/impl/auth';
import { getUsersMock, generateInviteCodesMock, updateUserRoleMock, updateUserStatusMock } from '@/services/mock/impl/adminUsers';
import { getActiveGroupsMock, getGapStatsMock, getMessageTrendMock, getOverviewStatsMock, getTokenUsageMock } from '@/services/mock/impl/adminStats';
import { createPlatformMock, deletePlatformMock, getPlatformsMock, updatePlatformMock } from '@/services/mock/impl/platforms';
import { createModelMock, deleteModelMock, getModelsMock, setMainModelMock, testModelMock, updateModelMock } from '@/services/mock/impl/models';
import { activateLLMConfigMock, createLLMConfigMock, deleteLLMConfigMock, getLLMConfigsMock, updateLLMConfigMock } from '@/services/mock/impl/llmConfigs';

import { loginReal } from '@/services/real/auth';
import { createPlatformReal, deletePlatformReal, getPlatformsReal, updatePlatformReal } from '@/services/real/platforms';
import { createModelReal, deleteModelReal, getModelsReal, setMainModelReal, testModelReal, updateModelReal } from '@/services/real/models';

function withAuth<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<ApiResponse<TResult>>
) {
  return async (...args: TArgs): Promise<ApiResponse<TResult>> => {
    const token = useAuthStore.getState().token;
    if (!token) return fail('UNAUTHORIZED', '未登录');
    return await fn(...args);
  };
}

const useMock = ['1', 'true', 'yes'].includes(((import.meta.env.VITE_USE_MOCK as string | undefined) ?? '').toLowerCase());

export const login: LoginContract = useMock ? loginMock : loginReal;

export const getUsers: GetUsersContract = withAuth(getUsersMock);
export const updateUserRole: UpdateUserRoleContract = withAuth(updateUserRoleMock);
export const updateUserStatus: UpdateUserStatusContract = withAuth(updateUserStatusMock);
export const generateInviteCodes: GenerateInviteCodesContract = withAuth(generateInviteCodesMock);

export const getOverviewStats: GetOverviewStatsContract = withAuth(getOverviewStatsMock);
export const getTokenUsage: GetTokenUsageContract = withAuth(getTokenUsageMock);
export const getMessageTrend: GetMessageTrendContract = withAuth(getMessageTrendMock);
export const getActiveGroups: GetActiveGroupsContract = withAuth(getActiveGroupsMock);
export const getGapStats: GetGapStatsContract = withAuth(getGapStatsMock);

export const getPlatforms: GetPlatformsContract = withAuth(useMock ? getPlatformsMock : getPlatformsReal);
export const createPlatform: CreatePlatformContract = withAuth(useMock ? createPlatformMock : createPlatformReal);
export const updatePlatform: UpdatePlatformContract = withAuth(useMock ? updatePlatformMock : updatePlatformReal);
export const deletePlatform: DeletePlatformContract = withAuth(useMock ? deletePlatformMock : deletePlatformReal);

export const getModels: GetModelsContract = withAuth(useMock ? getModelsMock : getModelsReal);
export const createModel: CreateModelContract = withAuth(useMock ? createModelMock : createModelReal);
export const updateModel: UpdateModelContract = withAuth(useMock ? updateModelMock : updateModelReal);
export const deleteModel: DeleteModelContract = withAuth(useMock ? deleteModelMock : deleteModelReal);
export const testModel: TestModelContract = withAuth(useMock ? testModelMock : testModelReal);
export const setMainModel: SetMainModelContract = withAuth(useMock ? setMainModelMock : setMainModelReal);

export const getLLMConfigs: GetLLMConfigsContract = withAuth(getLLMConfigsMock);
export const createLLMConfig: CreateLLMConfigContract = withAuth(createLLMConfigMock);
export const updateLLMConfig: UpdateLLMConfigContract = withAuth(updateLLMConfigMock);
export const deleteLLMConfig: DeleteLLMConfigContract = withAuth(deleteLLMConfigMock);
export const activateLLMConfig: ActivateLLMConfigContract = withAuth(activateLLMConfigMock);
