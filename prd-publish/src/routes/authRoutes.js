import { Router } from 'express';
import { login, logout, verifyToken, isAuthRequired } from '../services/authService.js';

const router = Router();

/**
 * GET /api/auth/status
 * Check if authentication is required
 */
router.get('/auth/status', (req, res) => {
  res.json({
    success: true,
    authRequired: isAuthRequired(),
  });
});

/**
 * POST /api/login
 * Login with password (username is optional display name)
 */
router.post('/login', (req, res) => {
  const { password, username } = req.body;

  // If auth not required, just return a token
  if (!isAuthRequired()) {
    const result = login('', username || 'admin');
    return res.json({
      success: true,
      token: result.token,
    });
  }

  if (!password) {
    return res.status(400).json({
      success: false,
      error: '密码不能为空',
    });
  }

  const result = login(password, username || 'admin');

  if (result.success) {
    return res.json({
      success: true,
      token: result.token,
    });
  } else {
    return res.status(401).json({
      success: false,
      error: result.error,
    });
  }
});

/**
 * POST /api/logout
 * Logout (destroy session)
 */
router.post('/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      logout(parts[1]);
    }
  }

  res.json({
    success: true,
    message: '已登出',
  });
});

/**
 * GET /api/verify
 * Verify if current token is valid
 */
router.get('/verify', (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    // If auth not required, still valid
    if (!isAuthRequired()) {
      return res.json({ valid: true, user: 'anonymous' });
    }
    return res.json({ valid: false });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.json({ valid: false });
  }

  const result = verifyToken(parts[1]);
  return res.json({
    valid: result.valid,
    user: result.username,
  });
});

export default router;
