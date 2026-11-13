import fs from 'node:fs';
/** Shared native implementation; runtime assets are copied by both build entrypoints. */
export const DISK_RESOURCE_NATIVE = fs.readFileSync(new URL('./disk-resource-native.py', import.meta.url), 'utf8');
