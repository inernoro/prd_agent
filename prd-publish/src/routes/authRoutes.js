import { Router } from 'express';
import { login, verifyToken } from '../services/authService.js';

const router = Router();

/**
 * POST /api/login
 * Login with username and password
 */
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      error: '用户名和密码不能为空',
    });
  }

  const result = login(username, password);

  if (result.success) {
    return res.json({
      success: true,
      token: result.token,
    });
  } else {
    return res.status(401).json({
      success: false,
      error: result.error,
      remainingTime: result.remainingTime,
    });
  }
});

/**
 * POST /api/logout
 * Logout (client should clear token)
 */
router.post('/logout', (req, res) => {
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
    return res.json({ valid: false });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.json({ valid: false });
  }

  const result = verifyToken(parts[1]);
  return res.json({
    valid: result.valid,
    user: result.payload?.username,
  });
});

export default router;
