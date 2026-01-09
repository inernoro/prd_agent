import type {
  ListLiteraryPromptsContract,
  CreateLiteraryPromptContract,
  UpdateLiteraryPromptContract,
  DeleteLiteraryPromptContract,
  LiteraryPrompt,
} from '../contracts/literaryPrompts';

const mockPrompts: LiteraryPrompt[] = [
  {
    id: 'mock-1',
    ownerUserId: 'admin-1',
    title: '文章配图标准模板',
    content: '你正在执行一个"文本增强"任务。输入是一篇完整文章。你的任务是：在不修改、不删减、不重排任何原文内容的前提下，在文章的合适位置插入若干条【插图提示词】。',
    scenarioType: 'article-illustration',
    order: 1,
    isSystem: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'mock-2',
    ownerUserId: 'admin-1',
    title: '全局通用模板',
    content: '这是一个全局共享的提示词模板，适用于所有场景。',
    scenarioType: null,
    order: 1,
    isSystem: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

export const listLiteraryPromptsMock: ListLiteraryPromptsContract = async (input) => {
  await new Promise((resolve) => setTimeout(resolve, 300));

  let items = mockPrompts;
  if (input.scenarioType && input.scenarioType !== 'global') {
    items = mockPrompts.filter(
      (p) => p.scenarioType === input.scenarioType || !p.scenarioType || p.scenarioType === 'global'
    );
  }

  return {
    success: true,
    data: { items },
    error: null,
  };
};

export const createLiteraryPromptMock: CreateLiteraryPromptContract = async (input) => {
  await new Promise((resolve) => setTimeout(resolve, 300));

  const prompt: LiteraryPrompt = {
    id: `mock-${Date.now()}`,
    ownerUserId: 'admin-1',
    title: input.title,
    content: input.content,
    scenarioType: input.scenarioType,
    order: mockPrompts.length + 1,
    isSystem: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  mockPrompts.push(prompt);

  return {
    success: true,
    data: { prompt },
    error: null,
  };
};

export const updateLiteraryPromptMock: UpdateLiteraryPromptContract = async (input) => {
  await new Promise((resolve) => setTimeout(resolve, 300));

  const index = mockPrompts.findIndex((p) => p.id === input.id);
  if (index === -1) {
    return {
      success: false,
      data: null,
      error: { code: 'DOCUMENT_NOT_FOUND', message: '提示词不存在' },
    };
  }

  const prompt = mockPrompts[index];
  if (input.title) prompt.title = input.title;
  if (input.content) prompt.content = input.content;
  if (input.scenarioType !== undefined) prompt.scenarioType = input.scenarioType;
  if (input.order) prompt.order = input.order;
  prompt.updatedAt = new Date().toISOString();

  return {
    success: true,
    data: { prompt },
    error: null,
  };
};

export const deleteLiteraryPromptMock: DeleteLiteraryPromptContract = async (input) => {
  await new Promise((resolve) => setTimeout(resolve, 300));

  const index = mockPrompts.findIndex((p) => p.id === input.id);
  if (index === -1) {
    return {
      success: false,
      data: null,
      error: { code: 'DOCUMENT_NOT_FOUND', message: '提示词不存在' },
    };
  }

  mockPrompts.splice(index, 1);

  return {
    success: true,
    data: { deleted: true },
    error: null,
  };
};
