import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import authRoutes from './routes/authRoutes.js';
import gitRoutes from './routes/gitRoutes.js';
import deployRoutes from './routes/deployRoutes.js';
import historyRoutes from './routes/historyRoutes.js';
import { config } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function createApp() {
  const app = express();

  // Security middleware
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
      },
    },
  }));

  // CORS
  app.use(cors({
    origin: true,
    credentials: true,
  }));

  // Body parsing
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Static files
  app.use(express.static(config.paths.publicDir));

  // Health check (no auth required)
  app.get('/api/health', (req, res) => {
    res.json({
      success: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  });

  // API routes
  app.use('/api', authRoutes);
  app.use('/api', gitRoutes);
  app.use('/api/deploy', deployRoutes);
  app.use('/api/history', historyRoutes);

  // SPA fallback - serve index.html for all non-API routes
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(join(config.paths.publicDir, 'index.html'));
    } else {
      res.status(404).json({
        success: false,
        error: 'API endpoint not found',
      });
    }
  });

  // Error handler
  app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
      success: false,
      error: process.env.NODE_ENV === 'development' ? err.message : '服务器内部错误',
    });
  });

  return app;
}

export default createApp;
