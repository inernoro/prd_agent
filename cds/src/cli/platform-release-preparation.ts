import { preparePlatformRelease, verifyPlatformReleasePreparation } from '../services/platform-release-preparation.js';

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'prepare' && args.length === 3) {
    console.log(JSON.stringify(await preparePlatformRelease(args[0], args[1], args[2]), null, 2));
  } else if (command === 'verify' && args.length === 2) {
    console.log(JSON.stringify(await verifyPlatformReleasePreparation(args[0], args[1]), null, 2));
  } else {
    throw new Error('用法：prepare <源码仓库根目录> <候选完整 SHA> <线上回退完整 SHA>；verify <准备目录> <回执 manifest SHA-256>。本工具不执行发布。');
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
