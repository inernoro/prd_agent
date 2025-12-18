import { fail, ok, type ApiResponse } from '@/types/api';
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

export const listModelLabExperimentsMock: ListModelLabExperimentsContract = async () => {
  return ok({ items: [], page: 1, pageSize: 20 });
};

export const createModelLabExperimentMock: CreateModelLabExperimentContract = async () => {
  return fail('MOCK', 'mock 模式未实现大模型实验室') as unknown as ApiResponse<any>;
};

export const getModelLabExperimentMock: GetModelLabExperimentContract = async () => {
  return fail('MOCK', 'mock 模式未实现大模型实验室') as unknown as ApiResponse<any>;
};

export const updateModelLabExperimentMock: UpdateModelLabExperimentContract = async () => {
  return fail('MOCK', 'mock 模式未实现大模型实验室') as unknown as ApiResponse<any>;
};

export const deleteModelLabExperimentMock: DeleteModelLabExperimentContract = async () => {
  return fail('MOCK', 'mock 模式未实现大模型实验室') as unknown as ApiResponse<any>;
};

export const listModelLabModelSetsMock: ListModelLabModelSetsContract = async () => {
  return ok({ items: [] });
};

export const upsertModelLabModelSetMock: UpsertModelLabModelSetContract = async () => {
  return fail('MOCK', 'mock 模式未实现大模型实验室') as unknown as ApiResponse<any>;
};

export const runModelLabStreamMock: RunModelLabStreamContract = async () => {
  return fail('MOCK', 'mock 模式未实现大模型实验室') as unknown as ApiResponse<true>;
};


