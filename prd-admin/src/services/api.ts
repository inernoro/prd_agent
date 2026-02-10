/**
 * 统一 API 路径配置
 *
 * 使用方式:
 *   import { api } from '@/services/api';
 *   fetch(api.mds.models());           // GET /api/mds
 *   fetch(api.mds.model(id));          // GET /api/mds/{id}
 *   fetch(api.visualAgent.workspaces.detail(id)); // GET /api/visual-agent/image-master/workspaces/{id}/detail
 */

// ============ Auth 认证 ============
export const api = {
  auth: {
    login: () => '/api/v1/auth/login',
    register: () => '/api/v1/auth/register',
    refresh: () => '/api/v1/auth/refresh',
    validatePassword: () => '/api/v1/auth/validate-password',
    resetPassword: () => '/api/v1/auth/reset-password',
  },

  // ============ Authz 权限 ============
  authz: {
    me: () => '/api/authz/me',
    catalog: () => '/api/authz/catalog',
    menuCatalog: () => '/api/authz/menu-catalog',
    systemRoles: {
      list: () => '/api/authz/system-roles',
      byKey: (key: string) => `/api/authz/system-roles/${key}`,
      resetBuiltins: () => '/api/authz/system-roles/reset-builtins',
    },
    users: {
      authz: (userId: string) => `/api/authz/users/${userId}/authz`,
    },
  },

  // ============ Users 用户管理 ============
  users: {
    list: () => '/api/users',
    byId: (userId: string) => `/api/users/${userId}`,
    profile: (userId: string) => `/api/users/${userId}/profile`,
    role: (userId: string) => `/api/users/${userId}/role`,
    status: (userId: string) => `/api/users/${userId}/status`,
    password: (userId: string) => `/api/users/${userId}/password`,
    avatar: (userId: string) => `/api/users/${userId}/avatar`,
    avatarUpload: (userId: string) => `/api/users/${userId}/avatar/upload`,
    displayName: (userId: string) => `/api/users/${userId}/display-name`,
    unlock: (userId: string) => `/api/users/${userId}/unlock`,
    forceExpire: (userId: string) => `/api/users/${userId}/force-expire`,
    inviteCodes: () => '/api/users/invite-codes',
    initialize: () => '/api/users/initialize',
    bulk: () => '/api/users/bulk',
  },

  // ============ Groups 群组管理 ============
  groups: {
    list: () => '/api/groups',
    byId: (groupId: string) => `/api/groups/${groupId}`,
    members: (groupId: string) => `/api/groups/${groupId}/members`,
    removeMember: (groupId: string, userId: string) => `/api/groups/${groupId}/members/${userId}`,
    regenerateInvite: (groupId: string) => `/api/groups/${groupId}/regenerate-invite`,
    messages: (groupId: string) => `/api/groups/${groupId}/messages`,
    gaps: {
      list: (groupId: string) => `/api/v1/groups/${groupId}/gaps`,
      status: (groupId: string, gapId: string) => `/api/v1/groups/${groupId}/gaps/${gapId}/status`,
      summaryReport: (groupId: string) => `/api/v1/groups/${groupId}/gaps/summary-report`,
    },
  },

  // ============ MDS 模型管理 ============
  mds: {
    models: () => '/api/mds',
    model: (id: string) => `/api/mds/${id}`,
    test: (id: string) => `/api/mds/${id}/test`,
    priorities: () => '/api/mds/priorities',
    mainModel: () => '/api/mds/main-model',
    intentModel: () => '/api/mds/intent-model',
    visionModel: () => '/api/mds/vision-model',
    imageGenModel: () => '/api/mds/image-gen-model',
    adapterInfoBatch: () => '/api/mds/adapter-info/batch',
    adapterInfo: (modelId: string) => `/api/mds/${modelId}/adapter-info`,
    /** 根据平台侧模型ID（modelName）直接获取适配信息，无需查询数据库 */
    adapterInfoByModelName: (modelName: string) => `/api/mds/adapter-info?modelId=${encodeURIComponent(modelName)}`,

    // 平台
    platforms: {
      list: () => '/api/mds/platforms',
      byId: (id: string) => `/api/mds/platforms/${id}`,
    },

    // 模型分组
    modelGroups: {
      list: () => '/api/mds/model-groups',
      byId: (id: string) => `/api/mds/model-groups/${id}`,
      forApp: () => '/api/mds/model-groups/for-app',
      predict: (id: string) => `/api/mds/model-groups/${id}/predict`,
      resetModelHealth: (groupId: string, modelId: string) =>
        `/api/mds/model-groups/${groupId}/models/${encodeURIComponent(modelId)}/reset-health`,
      resetAllHealth: (groupId: string) =>
        `/api/mds/model-groups/${groupId}/reset-all-health`,
    },

    // LLM 配置
    llmConfigs: {
      list: () => '/api/mds/llm-configs',
      byId: (id: string) => `/api/mds/llm-configs/${id}`,
      activate: (id: string) => `/api/mds/llm-configs/${id}/activate`,
    },

    // 模型中继 (Exchange)
    exchanges: {
      list: () => '/api/mds/exchanges',
      byId: (id: string) => `/api/mds/exchanges/${id}`,
      test: (id: string) => `/api/mds/exchanges/${id}/test`,
      transformerTypes: () => '/api/mds/exchanges/transformer-types',
      forPool: () => '/api/mds/exchanges/for-pool',
    },

    // 调度器配置
    schedulerConfig: () => '/api/mds/scheduler-config',
  },

  // ============ Lab 实验室 ============
  lab: {
    impersonate: () => '/api/lab/impersonate',
    simulateMessage: () => '/api/lab/simulate-message',
    simulateStreamMessages: () => '/api/lab/simulate-stream-messages',

    // 模型实验
    model: {
      experiments: {
        list: () => '/api/lab/model/experiments',
        byId: (id: string) => `/api/lab/model/experiments/${id}`,
      },
      modelSets: () => '/api/lab/model/model-sets',
      labGroups: {
        list: () => '/api/lab/model/lab-groups',
        byId: (id: string) => `/api/lab/model/lab-groups/${id}`,
      },
      runsStream: () => '/api/lab/model/runs/stream',
    },

    // 模型测试
    modelTest: {
      stubs: {
        list: () => '/api/lab/model-test/stubs',
        byId: (id: string) => `/api/lab/model-test/stubs/${id}`,
        clear: () => '/api/lab/model-test/stubs/clear',
      },
      simulate: {
        downgrade: () => '/api/lab/model-test/simulate/downgrade',
        recover: () => '/api/lab/model-test/simulate/recover',
      },
      healthCheck: () => '/api/lab/model-test/health-check',
      groupMonitoring: (groupId: string) => `/api/lab/model-test/groups/${groupId}/monitoring`,
    },
  },

  // ============ Logs 日志 ============
  logs: {
    api: {
      list: () => '/api/logs/api',
      byId: (id: string) => `/api/logs/api/${id}`,
      meta: () => '/api/logs/api/meta',
    },
    llm: {
      list: () => '/api/logs/llm',
      byId: (id: string) => `/api/logs/llm/${id}`,
      replayCurl: (id: string) => `/api/logs/llm/${id}/replay-curl`,
      meta: () => '/api/logs/llm/meta',
      modelStats: () => '/api/logs/llm/model-stats',
      batchModelStats: () => '/api/logs/llm/model-stats/batch',
    },
    desktopPresence: {
      list: () => '/api/logs/desktop-presence',
      byUserId: (userId: string) => `/api/logs/desktop-presence/${userId}`,
    },
    settings: {
      llm: () => '/api/logs/settings/llm',
    },
  },

  // ============ Prompts 提示词 ============
  prompts: {
    list: () => '/api/prompts',
    reset: () => '/api/prompts/reset',
    system: {
      get: () => '/api/prompts/system',
      reset: () => '/api/prompts/system/reset',
    },
    overrides: {
      imageGenPlan: () => '/api/prompts/overrides/image-gen-plan',
    },
    optimize: {
      stream: () => '/api/prompts/optimize/stream',
    },
  },

  // ============ Data 数据管理 ============
  data: {
    config: {
      export: () => '/api/data/config/export',
      import: () => '/api/data/config/import',
      importPreview: () => '/api/data/config/import/preview',
    },
    summary: () => '/api/data/summary',
    purge: () => '/api/data/purge',
    users: {
      preview: () => '/api/data/users/preview',
      purge: () => '/api/data/users/purge',
    },
    documents: {
      content: (documentId: string, groupId: string) => `/api/data/documents/${documentId}/content?groupId=${groupId}`,
    },
  },

  // ============ Data Migration 数据迁移 ============
  dataMigration: {
    mappings: () => '/api/data-migration/mappings',
    collections: {
      data: (collectionName: string) => `/api/data-migration/collections/${collectionName}/data`,
      validation: (collectionName: string) => `/api/data-migration/collections/${collectionName}/validation`,
      delete: (collectionName: string) => `/api/data-migration/collections/${collectionName}`,
      document: (collectionName: string, documentId: string) => `/api/data-migration/collections/${collectionName}/documents/${documentId}`,
    },
    apps: {
      delete: (appName: string) => `/api/data-migration/apps/${appName}`,
    },
  },

  // ============ Assets 资源管理 ============
  assets: {
    desktop: {
      skins: {
        list: () => '/api/assets/desktop/skins',
        byId: (id: string) => `/api/assets/desktop/skins/${id}`,
      },
      keys: {
        list: () => '/api/assets/desktop/keys',
        byId: (id: string) => `/api/assets/desktop/keys/${id}`,
      },
      upload: () => '/api/assets/desktop/upload',
      matrix: () => '/api/assets/desktop/matrix',
    },
    desktopBranding: () => '/api/assets/desktop-branding',
    avatars: {
      nohead: () => '/api/assets/avatars/nohead',
    },
  },

  // ============ Dashboard 仪表盘 ============
  dashboard: {
    notifications: {
      list: () => '/api/dashboard/notifications',
      handle: (id: string) => `/api/dashboard/notifications/${id}/handle`,
      handleAll: () => '/api/dashboard/notifications/handle-all',
    },
    userPreferences: {
      get: () => '/api/dashboard/user-preferences',
      navOrder: () => '/api/dashboard/user-preferences/nav-order',
      theme: () => '/api/dashboard/user-preferences/theme',
      visualAgent: () => '/api/dashboard/user-preferences/visual-agent',
    },
    stats: {
      overview: () => '/api/dashboard/stats/overview',
      tokenUsage: () => '/api/dashboard/stats/token-usage',
      messageTrend: () => '/api/dashboard/stats/message-trend',
      activeGroups: () => '/api/dashboard/stats/active-groups',
      gapStats: () => '/api/dashboard/stats/gap-stats',
    },
  },

  // ============ Visual Agent 视觉创作 ============
  visualAgent: {
    imageMaster: {
      sessions: {
        list: () => '/api/visual-agent/image-master/sessions',
        byId: (id: string) => `/api/visual-agent/image-master/sessions/${id}`,
        messages: (sessionId: string) => `/api/visual-agent/image-master/sessions/${sessionId}/messages`,
        canvas: (id: string) => `/api/visual-agent/image-master/sessions/${id}/canvas`,
      },
      workspaces: {
        list: () => '/api/visual-agent/image-master/workspaces',
        byId: (id: string) => `/api/visual-agent/image-master/workspaces/${id}`,
        detail: (id: string) => `/api/visual-agent/image-master/workspaces/${id}/detail`,
        viewport: (id: string) => `/api/visual-agent/image-master/workspaces/${id}/viewport`,
        messages: (id: string) => `/api/visual-agent/image-master/workspaces/${id}/messages`,
        canvas: (id: string) => `/api/visual-agent/image-master/workspaces/${id}/canvas`,
        assets: (id: string) => `/api/visual-agent/image-master/workspaces/${id}/assets`,
        asset: (id: string, assetId: string) => `/api/visual-agent/image-master/workspaces/${id}/assets/${assetId}`,
        imageGenRuns: (id: string) => `/api/visual-agent/image-master/workspaces/${id}/image-gen/runs`,
        coverRefresh: (id: string) => `/api/visual-agent/image-master/workspaces/${id}/cover/refresh`,
        generateTitle: (id: string) => `/api/visual-agent/image-master/workspaces/${id}/generate-title`,
        article: {
          generateMarkers: (id: string) => `/api/visual-agent/image-master/workspaces/${id}/article/generate-markers`,
          extractMarkers: (id: string) => `/api/visual-agent/image-master/workspaces/${id}/article/extract-markers`,
          export: (id: string) => `/api/visual-agent/image-master/workspaces/${id}/article/export`,
          marker: (id: string, markerIndex: number) => `/api/visual-agent/image-master/workspaces/${id}/article/markers/${markerIndex}`,
        },
      },
      assets: {
        upload: () => '/api/visual-agent/image-master/assets',
        byId: (id: string) => `/api/visual-agent/image-master/assets/${id}`,
      },
      drawingBoard: {
        chat: () => '/api/visual-agent/image-master/drawing-board/chat',
      },
    },
    imageGen: {
      plan: () => '/api/visual-agent/image-gen/plan',
      generate: () => '/api/visual-agent/image-gen/generate',
      sizeCaps: () => '/api/visual-agent/image-gen/size-caps',
      /** 获取所有生图场景的模型池（合并去重） */
      models: () => '/api/visual-agent/image-gen/models',
      /** 根据平台侧模型ID获取适配信息（尺寸选项等） */
      adapterInfo: (modelId: string) => `/api/visual-agent/image-gen/adapter-info?modelId=${encodeURIComponent(modelId)}`,
      /** Visual Agent 域内日志查询（避免跨权限调用 /api/logs/llm） */
      logs: () => '/api/visual-agent/image-gen/logs',
      logsMeta: () => '/api/visual-agent/image-gen/logs/meta',
      logDetail: (id: string) => `/api/visual-agent/image-gen/logs/${id}`,
      runs: {
        create: () => '/api/visual-agent/image-gen/runs',
        byId: (runId: string) => `/api/visual-agent/image-gen/runs/${runId}`,
        cancel: (runId: string) => `/api/visual-agent/image-gen/runs/${runId}/cancel`,
      },
      batch: {
        stream: () => '/api/visual-agent/image-gen/batch/stream',
      },
    },
    uploadArtifacts: () => '/api/visual-agent/upload-artifacts',
  },

  // ============ PRD Agent ============
  prdAgent: {
    /** 提示词（只读，供 PRD Agent 页面快捷标签使用） */
    prompts: () => '/api/prd-agent/prompts',
    /** 系统提示词（只读，供 PRD Agent 页面展示系统提示词内容） */
    systemPrompts: () => '/api/prd-agent/prompts/system',
  },

  // ============ Literary Agent 文学创作 ============
  literaryAgent: {
    prompts: {
      list: () => '/api/literary-agent/prompts',
      byId: (id: string) => `/api/literary-agent/prompts/${id}`,
      // 海鲜市场
      marketplace: () => '/api/literary-agent/prompts/marketplace',
      publish: (id: string) => `/api/literary-agent/prompts/${id}/publish`,
      unpublish: (id: string) => `/api/literary-agent/prompts/${id}/unpublish`,
      fork: (id: string) => `/api/literary-agent/prompts/${id}/fork`,
    },
    /** 文学创作工作区（应用身份隔离，避免跨权限调用 visual-agent） */
    workspaces: {
      list: () => '/api/literary-agent/workspaces',
      byId: (id: string) => `/api/literary-agent/workspaces/${id}`,
      detail: (id: string) => `/api/literary-agent/workspaces/${id}/detail`,
      assets: (id: string) => `/api/literary-agent/workspaces/${id}/assets`,
    },
    config: {
      get: () => '/api/literary-agent/config',
      referenceImage: () => '/api/literary-agent/config/reference-image',
      referenceImages: {
        list: () => '/api/literary-agent/config/reference-images',
        byId: (id: string) => `/api/literary-agent/config/reference-images/${id}`,
        image: (id: string) => `/api/literary-agent/config/reference-images/${id}/image`,
        activate: (id: string) => `/api/literary-agent/config/reference-images/${id}/activate`,
        deactivate: (id: string) => `/api/literary-agent/config/reference-images/${id}/deactivate`,
        active: () => '/api/literary-agent/config/reference-images/active',
        // 海鲜市场
        marketplace: () => '/api/literary-agent/config/reference-images/marketplace',
        publish: (id: string) => `/api/literary-agent/config/reference-images/${id}/publish`,
        unpublish: (id: string) => `/api/literary-agent/config/reference-images/${id}/unpublish`,
        fork: (id: string) => `/api/literary-agent/config/reference-images/${id}/fork`,
      },
      /** 获取文生图模型池（无参考图场景） */
      modelsText2Img: () => '/api/literary-agent/config/models/text2img',
      /** 获取图生图模型池（有风格参考图场景） */
      modelsImg2Img: () => '/api/literary-agent/config/models/img2img',
      /** 获取所有模型池（文生图 + 图生图），一次性返回 */
      modelsAll: () => '/api/literary-agent/config/models/all',
      /** 兼容旧接口，根据是否有参考图自动选择 */
      modelsImageGen: () => '/api/literary-agent/config/models/image-gen',
      /** 获取主模型信息（用于显示标记生成使用的模型名称） */
      modelsMain: () => '/api/literary-agent/config/models/main',
    },
    /** 文学创作图片生成（应用身份隔离） */
    imageGen: {
      runs: {
        create: () => '/api/literary-agent/image-gen/runs',
        byId: (runId: string) => `/api/literary-agent/image-gen/runs/${runId}`,
        stream: (runId: string) => `/api/literary-agent/image-gen/runs/${runId}/stream`,
        cancel: (runId: string) => `/api/literary-agent/image-gen/runs/${runId}/cancel`,
      },
    },
  },

  // ============ Defect Agent 缺陷管理 ============
  defectAgent: {
    templates: {
      list: () => '/api/defect-agent/templates',
      byId: (id: string) => `/api/defect-agent/templates/${id}`,
      share: (id: string) => `/api/defect-agent/templates/${id}/share`,
    },
    defects: {
      list: () => '/api/defect-agent/defects',
      byId: (id: string) => `/api/defect-agent/defects/${id}`,
      submit: (id: string) => `/api/defect-agent/defects/${id}/submit`,
      process: (id: string) => `/api/defect-agent/defects/${id}/process`,
      resolve: (id: string) => `/api/defect-agent/defects/${id}/resolve`,
      reject: (id: string) => `/api/defect-agent/defects/${id}/reject`,
      close: (id: string) => `/api/defect-agent/defects/${id}/close`,
      reopen: (id: string) => `/api/defect-agent/defects/${id}/reopen`,
      messages: (id: string) => `/api/defect-agent/defects/${id}/messages`,
      attachments: (id: string) => `/api/defect-agent/defects/${id}/attachments`,
      attachment: (id: string, attachmentId: string) => `/api/defect-agent/defects/${id}/attachments/${attachmentId}`,
      restore: (id: string) => `/api/defect-agent/defects/${id}/restore`,
      permanent: (id: string) => `/api/defect-agent/defects/${id}/permanent`,
      move: (id: string) => `/api/defect-agent/defects/${id}/move`,
      batchMove: () => '/api/defect-agent/defects/batch-move',
    },
    folders: {
      list: () => '/api/defect-agent/folders',
      byId: (id: string) => `/api/defect-agent/folders/${id}`,
    },
    trash: () => '/api/defect-agent/defects/trash',
    stats: () => '/api/defect-agent/stats',
    users: () => '/api/defect-agent/users',
    polish: () => '/api/defect-agent/defects/polish',
    logs: {
      preview: () => '/api/defect-agent/logs/preview',
    },
  },

  // ============ Open Platform 开放平台 ============
  openPlatform: {
    apps: {
      list: () => '/api/open-platform/apps',
      byId: (id: string) => `/api/open-platform/apps/${id}`,
      toggle: (id: string) => `/api/open-platform/apps/${id}/toggle`,
    },
    appCallers: {
      list: () => '/api/open-platform/app-callers',
      byId: (id: string) => `/api/open-platform/app-callers/${id}`,
      stats: (id: string) => `/api/open-platform/app-callers/${id}/stats`,
      scan: () => '/api/open-platform/app-callers/scan',
      resolveModel: () => '/api/open-platform/app-callers/resolve-model',
      resolveModels: () => '/api/open-platform/app-callers/resolve-models',
    },
  },

  // ============ Channels 多通道适配器 ============
  channels: {
    settings: {
      get: () => '/api/admin/channels/settings',
      update: () => '/api/admin/channels/settings',
      test: () => '/api/admin/channels/settings/test',
      poll: () => '/api/admin/channels/settings/poll',
    },
    workflows: {
      list: () => '/api/admin/channels/workflows',
      byId: (id: string) => `/api/admin/channels/workflows/${id}`,
      toggle: (id: string) => `/api/admin/channels/workflows/${id}/toggle`,
    },
    whitelists: {
      list: () => '/api/admin/channels/whitelist',
      byId: (id: string) => `/api/admin/channels/whitelist/${id}`,
      toggle: (id: string) => `/api/admin/channels/whitelist/${id}/toggle`,
    },
    identityMappings: {
      list: () => '/api/admin/channels/identity-mappings',
      byId: (id: string) => `/api/admin/channels/identity-mappings/${id}`,
    },
    tasks: {
      list: () => '/api/admin/channels/tasks',
      byId: (id: string) => `/api/admin/channels/tasks/${id}`,
      retry: (id: string) => `/api/admin/channels/tasks/${id}/retry`,
      cancel: (id: string) => `/api/admin/channels/tasks/${id}/cancel`,
      stats: () => '/api/admin/channels/tasks/stats',
    },
    stats: () => '/api/admin/channels/stats',
  },

  // ============ Watermark 水印 ============
  watermark: {
    list: () => '/api/watermarks',
    byApp: (appKey: string) => `/api/watermarks/app/${appKey}`,
    byId: (id: string) => `/api/watermarks/${id}`,
    bind: (id: string, appKey: string) => `/api/watermarks/${id}/bind/${appKey}`,
    unbind: (id: string, appKey: string) => `/api/watermarks/${id}/unbind/${appKey}`,
    icons: () => '/api/watermark/icons',
    fonts: {
      list: () => '/api/watermark/fonts',
      byKey: (fontKey: string) => `/api/watermark/fonts/${fontKey}`,
    },
    // 海鲜市场
    marketplace: () => '/api/watermarks/marketplace',
    publish: (id: string) => `/api/watermarks/${id}/publish`,
    unpublish: (id: string) => `/api/watermarks/${id}/unpublish`,
    fork: (id: string) => `/api/watermarks/${id}/fork`,
  },

  // ============ Model Sizes ============
  modelSizes: (modelKey: string) => `/api/model/${modelKey}/sizes`,

  // ============ Settings 系统设置 ============
  settings: {
    init: {
      defaultGroups: () => '/api/settings/init/default-groups',
      migrateModels: () => '/api/settings/init/migrate-models',
      defaultConfig: () => '/api/settings/init/default-config',
      defaultApps: () => '/api/settings/init/default-apps',
      all: () => '/api/settings/init/all',
      scan: () => '/api/settings/init/scan',
      migratePermissions: () => '/api/settings/init/migrate-permissions',
    },
  },

  // ============ AI Toolbox 百宝箱 ============
  aiToolbox: {
    // 工具管理
    items: () => '/api/ai-toolbox/items',
    item: (id: string) => `/api/ai-toolbox/items/${id}`,
    runItem: (itemId: string) => `/api/ai-toolbox/items/${itemId}/run`,
    agents: () => '/api/ai-toolbox/agents',
    // 直接对话 (SSE)
    directChat: () => '/api/ai-toolbox/direct-chat',
    capabilityChat: (key: string) => `/api/ai-toolbox/capabilities/${key}/chat`,
    // Legacy - 运行记录
    chat: () => '/api/ai-toolbox/chat',
    analyze: () => '/api/ai-toolbox/analyze',
    runs: () => '/api/ai-toolbox/runs',
    run: (runId: string) => `/api/ai-toolbox/runs/${runId}`,
    execute: (runId: string) => `/api/ai-toolbox/runs/${runId}/execute`,
    stream: (runId: string) => `/api/ai-toolbox/runs/${runId}/stream`,
  },

  // ============ V1 API (用户端) ============
  v1: {
    documents: {
      list: () => '/api/v1/documents',
      byId: (documentId: string) => `/api/v1/documents/${documentId}`,
      content: (documentId: string) => `/api/v1/documents/${documentId}/content`,
      validate: () => '/api/v1/documents/validate',
    },
    sessions: {
      list: () => '/api/v1/sessions',
      byId: (sessionId: string) => `/api/v1/sessions/${sessionId}`,
      role: (sessionId: string) => `/api/v1/sessions/${sessionId}/role`,
      messages: (sessionId: string) => `/api/v1/sessions/${sessionId}/messages`,
      archive: (sessionId: string) => `/api/v1/sessions/${sessionId}/archive`,
      unarchive: (sessionId: string) => `/api/v1/sessions/${sessionId}/unarchive`,
    },
    groups: {
      list: () => '/api/v1/groups',
      byId: (groupId: string) => `/api/v1/groups/${groupId}`,
      members: (groupId: string) => `/api/v1/groups/${groupId}/members`,
      messages: (groupId: string) => `/api/v1/groups/${groupId}/messages`,
      session: (groupId: string) => `/api/v1/groups/${groupId}/session`,
      prd: (groupId: string) => `/api/v1/groups/${groupId}/prd`,
      name: (groupId: string) => `/api/v1/groups/${groupId}/name`,
      contextClear: (groupId: string) => `/api/v1/groups/${groupId}/context/clear`,
      join: () => '/api/v1/groups/join',
    },
    intent: {
      groupName: () => '/api/v1/intent/group-name',
    },
    prompts: () => '/api/v1/prompts',
  },
} as const;

export default api;
