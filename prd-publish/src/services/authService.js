import jwt from 'jsonwebtoken';
import { config } from '../config.js';

// Track login attempts for rate limiting
const loginAttempts = new Map();
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes

/**
 * Check if account is locked due to too many failed attempts
 * @param {string} username - The username to check
 * @returns {{ locked: boolean, remainingTime?: number }}
 */
export function checkLockout(username) {
  const attempts = loginAttempts.get(username);
  if (!attempts) {
    return { locked: false };
  }

  if (attempts.count >= LOCKOUT_THRESHOLD) {
    const elapsed = Date.now() - attempts.lastAttempt;
    if (elapsed < LOCKOUT_DURATION) {
      return {
        locked: true,
        remainingTime: Math.ceil((LOCKOUT_DURATION - elapsed) / 1000),
      };
    }
    // Reset after lockout duration
    loginAttempts.delete(username);
  }

  return { locked: false };
}

/**
 * Record a failed login attempt
 * @param {string} username - The username
 */
export function recordFailedAttempt(username) {
  const attempts = loginAttempts.get(username) || { count: 0, lastAttempt: 0 };
  attempts.count += 1;
  attempts.lastAttempt = Date.now();
  loginAttempts.set(username, attempts);
}

/**
 * Clear login attempts after successful login
 * @param {string} username - The username
 */
export function clearAttempts(username) {
  loginAttempts.delete(username);
}

/**
 * Validate credentials against config
 * @param {string} username - The username
 * @param {string} password - The password
 * @returns {boolean} Whether credentials are valid
 */
export function validateCredentials(username, password) {
  return username === config.auth.username && password === config.auth.password;
}

/**
 * Generate JWT token
 * @param {string} username - The username
 * @returns {string} JWT token
 */
export function generateToken(username) {
  return jwt.sign(
    {
      username,
      iat: Math.floor(Date.now() / 1000),
    },
    config.auth.jwtSecret,
    { expiresIn: config.auth.tokenExpiry }
  );
}

/**
 * Verify JWT token
 * @param {string} token - The JWT token
 * @returns {{ valid: boolean, payload?: object, error?: string }}
 */
export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, config.auth.jwtSecret);
    return { valid: true, payload };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

/**
 * Login user
 * @param {string} username - The username
 * @param {string} password - The password
 * @returns {{ success: boolean, token?: string, error?: string, remainingTime?: number }}
 */
export function login(username, password) {
  // Check lockout
  const lockout = checkLockout(username);
  if (lockout.locked) {
    return {
      success: false,
      error: `账号已锁定，请在 ${lockout.remainingTime} 秒后重试`,
      remainingTime: lockout.remainingTime,
    };
  }

  // Validate credentials
  if (!validateCredentials(username, password)) {
    recordFailedAttempt(username);
    const attempts = loginAttempts.get(username);
    const remaining = LOCKOUT_THRESHOLD - attempts.count;

    if (remaining > 0) {
      return {
        success: false,
        error: `用户名或密码错误，还剩 ${remaining} 次尝试机会`,
      };
    } else {
      return {
        success: false,
        error: `登录失败次数过多，账号已锁定 15 分钟`,
      };
    }
  }

  // Success
  clearAttempts(username);
  const token = generateToken(username);
  return { success: true, token };
}

// Export for testing
export const _internal = {
  loginAttempts,
  LOCKOUT_THRESHOLD,
  LOCKOUT_DURATION,
  resetAttempts: () => loginAttempts.clear(),
};
