import { verifyToken, isAuthRequired } from '../services/authService.js';

/**
 * Extract token from request
 * Supports: Header (Bearer token), Query param (?token=xxx)
 */
function extractToken(req) {
  // Try Authorization header first
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      return parts[1];
    }
  }

  // Try query param (for SSE and other cases)
  if (req.query.token) {
    return req.query.token;
  }

  return null;
}

/**
 * Authentication middleware
 * If PUBLISH_PASSWORD is not set, allows all requests
 * If set, validates session token from header or query param
 */
export function authMiddleware(req, res, next) {
  // If auth not required, allow all
  if (!isAuthRequired()) {
    req.user = { username: 'anonymous' };
    return next();
  }

  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({
      success: false,
      error: '未提供认证令牌',
    });
  }

  const result = verifyToken(token);

  if (!result.valid) {
    return res.status(401).json({
      success: false,
      error: '认证令牌无效或已过期',
    });
  }

  req.user = { username: result.username };
  next();
}

/**
 * Optional authentication middleware
 * Allows unauthenticated requests but attaches user if token is valid
 */
export function optionalAuthMiddleware(req, res, next) {
  const token = extractToken(req);

  if (token) {
    const result = verifyToken(token);
    if (result.valid) {
      req.user = { username: result.username };
    }
  }

  if (!req.user) {
    req.user = { username: 'anonymous' };
  }

  next();
}
