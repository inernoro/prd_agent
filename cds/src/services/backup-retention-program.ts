import fs from 'node:fs';
import { DISK_RESOURCE_NATIVE } from './disk-resource-native.js';
/** Shared native implementation; runtime assets are copied by both build entrypoints. */
export const BACKUP_RETENTION_PROGRAM = DISK_RESOURCE_NATIVE + '\n' + fs.readFileSync(new URL('./backup-retention-native.py', import.meta.url), 'utf8');
