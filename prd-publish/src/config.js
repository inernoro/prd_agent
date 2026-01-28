import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env file
dotenvConfig({ path: resolve(__dirname, '../.env') });

export const config = {
  // Authentication (optional - if no password, auth is disabled)
  auth: {
    password: process.env.PUBLISH_PASSWORD || '',
  },

  // Server
  server: {
    port: parseInt(process.env.PUBLISH_PORT || '3939', 10),
    host: process.env.PUBLISH_HOST || '0.0.0.0',
  },

  // Git
  git: {
    repoPath: process.env.PUBLISH_REPO_PATH || process.cwd(),
    branch: process.env.PUBLISH_BRANCH || 'main',
  },

  // Execution
  exec: {
    script: process.env.PUBLISH_EXEC_SCRIPT || './scripts/deploy-example.sh',
    timeout: parseInt(process.env.PUBLISH_EXEC_TIMEOUT || '300000', 10),
  },

  // Retry
  retry: {
    autoRetry: process.env.PUBLISH_AUTO_RETRY === 'true',
    maxCount: parseInt(process.env.PUBLISH_RETRY_COUNT || '3', 10),
    delay: parseInt(process.env.PUBLISH_RETRY_DELAY || '5000', 10),
  },

  // Paths
  paths: {
    baseDir: resolve(__dirname, '..'),
    dataDir: resolve(__dirname, '../data'),
    historyFile: resolve(__dirname, '../data/history.json'),
    publicDir: resolve(__dirname, '../public'),
  },
};

/**
 * Check if auth is enabled
 * @returns {boolean}
 */
export function isAuthEnabled() {
  return Boolean(config.auth.password);
}

export default config;
