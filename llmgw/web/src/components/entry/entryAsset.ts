import { getRuntimeBasePath } from '@/lib/runtimeBase';

/** The same prebuilt console runs at /llmgw and at a preview subdomain root. */
export function entryAsset(file: string) {
  return `${getRuntimeBasePath()}/media/entry/${file}`;
}
