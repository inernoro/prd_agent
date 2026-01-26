import { verifyToken } from '../services/authService.js';

/**
 * Authentication middleware
 * Validates JWT token from Authorization header
 */
export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      success: false,
      error: '未提供认证令牌',
    });
  }

  // Extract token from "Bearer <token>"
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({
      success: false,
      error: '认证令牌格式无效',
    });
  }

  const token = parts[1];
  const result = verifyToken(token);

  if (!result.valid) {
    return res.status(401).json({
      success: false,
      error: '认证令牌无效或已过期',
    });
  }

  // Attach user info to request
  req.user = result.payload;
  next();
}

/**
 * Optional authentication middleware
 * Allows unauthenticated requests but attaches user if token is valid
 */
export function optionalAuthMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      const token = parts[1];
      const result = verifyToken(token);
      if (result.valid) {
        req.user = result.payload;
      }
    }
  }

  next();
}
