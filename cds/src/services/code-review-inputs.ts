import { createReportObjectStore, reportObjectStoreFromEnv, type ReportObjectStore } from './report-object-store.js';

/** Dedicated object prefix; source snapshots are private inputs and never report metadata. */
export interface CodeReviewInputs {
  configured(): boolean;
  put(taskId: string, projectId: string, zip: Buffer): Promise<string>;
  get(key: string): Promise<Buffer>;
}
export function createCodeReviewInputs(store?: ReportObjectStore): CodeReviewInputs {
  const config = store ? null : reportObjectStoreFromEnv();
  const objects = store ?? createReportObjectStore(config ? { ...config, prefix: `${config.prefix}/code-review-inputs` } : null);
  return {
    configured: () => objects.isConfigured(),
    async put(taskId, projectId, zip) {
      if (!objects.isConfigured()) throw new Error('审查源码需要持久化对象存储，请先配置 CDS 报告存储');
      const key = await objects.put({ id: taskId, projectId, format: 'md' }, zip.toString('base64'));
      if (!key) throw new Error('审查源码未能持久化');
      return key;
    },
    async get(key) {
      const data = await objects.get(key);
      if (!data) throw new Error('审查源码快照已丢失，请重新上传');
      return Buffer.from(data, 'base64');
    },
  };
}
