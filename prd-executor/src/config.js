import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenvConfig({ path: resolve(__dirname, '../.env') });

export const config = {
  // Redis
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    prefix: process.env.REDIS_PREFIX || 'executor',
  },

  // MongoDB
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/prd_executor',
    collection: 'executor_jobs',
  },

  // 并发控制
  concurrency: {
    max: parseInt(process.env.MAX_CONCURRENCY || '3', 10),
  },

  // 日志
  logs: {
    dir: process.env.LOGS_DIR || resolve(__dirname, '../logs'),
    retentionDays: parseInt(process.env.LOGS_RETENTION_DAYS || '30', 10),
  },

  // HTTP API
  api: {
    enabled: process.env.API_ENABLED !== 'false',
    port: parseInt(process.env.API_PORT || '3940', 10),
    host: process.env.API_HOST || '0.0.0.0',
  },

  // 队列
  queue: {
    enabled: process.env.QUEUE_ENABLED !== 'false',
    priorities: (process.env.QUEUE_PRIORITIES || 'high,normal,low').split(','),
    blockTimeout: parseInt(process.env.QUEUE_BLOCK_TIMEOUT || '5000', 10),
  },

  // 回调
  callback: {
    timeout: parseInt(process.env.CALLBACK_TIMEOUT || '10000', 10),
    retries: parseInt(process.env.CALLBACK_RETRIES || '3', 10),
  },

  // 执行
  execution: {
    defaultTimeout: parseInt(process.env.DEFAULT_TIMEOUT || '300000', 10),
  },
};

export default config;
