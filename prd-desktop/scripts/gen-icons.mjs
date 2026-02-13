/**
 * 图标生成跳过脚本
 * 对比 icon.png 的 MD5 与上次生成时的缓存值，一致则跳过 tauri icon 生成。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const SOURCE = resolve(root, 'icon.png');
const ICONS_DIR = resolve(root, 'src-tauri/icons');
const HASH_FILE = resolve(ICONS_DIR, '.icon.md5');

function md5(filePath) {
  return createHash('md5').update(readFileSync(filePath)).digest('hex');
}

const currentHash = md5(SOURCE);

// 如果 icons 目录存在 且 MD5 一致 → 跳过
if (existsSync(HASH_FILE)) {
  const cached = readFileSync(HASH_FILE, 'utf-8').trim();
  if (cached === currentHash) {
    console.log(`[gen-icons] icon.png unchanged (${currentHash.slice(0, 8)}...), skipped.`);
    process.exit(0);
  }
}

console.log(`[gen-icons] icon.png changed or first run, generating icons...`);
execSync('pnpm tauri icon ./icon.png --output src-tauri/icons', {
  cwd: root,
  stdio: 'inherit',
});

// 写入新 hash
writeFileSync(HASH_FILE, currentHash + '\n');
console.log(`[gen-icons] done. hash: ${currentHash.slice(0, 8)}...`);
