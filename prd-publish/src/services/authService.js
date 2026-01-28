import crypto from 'crypto';
import { config } from '../config.js';

// Simple session store (in-memory)
const sessions = new Map();
const SESSION_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Check if authentication is required
 * @returns {boolean}
 */
export function isAuthRequired() {
  return Boolean(config.auth.password);
}

/**
 * Generate a session token
 * @returns {string}
 */
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Validate password
 * @param {string} password - The password to check
 * @returns {boolean}
 */
export function validatePassword(password) {
  return password === config.auth.password;
}

/**
 * Create a new session
 * @param {string} username - The username (display name)
 * @returns {string} Session token
 */
export function createSession(username) {
  const token = generateSessionToken();
  sessions.set(token, {
    username,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_EXPIRY,
  });
  return token;
}

/**
 * Verify session token
 * @param {string} token - The session token
 * @returns {{ valid: boolean, username?: string }}
 */
export function verifyToken(token) {
  // If auth is not required, always valid
  if (!isAuthRequired()) {
    return { valid: true, username: 'anonymous' };
  }

  if (!token) {
    return { valid: false };
  }

  const session = sessions.get(token);
  if (!session) {
    return { valid: false };
  }

  // Check expiry
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return { valid: false };
  }

  return { valid: true, username: session.username };
}

/**
 * Login with password
 * @param {string} password - The password
 * @param {string} username - Display name (optional)
 * @returns {{ success: boolean, token?: string, error?: string }}
 */
export function login(password, username = 'admin') {
  // If auth not required, just create session
  if (!isAuthRequired()) {
    const token = createSession(username);
    return { success: true, token };
  }

  if (!validatePassword(password)) {
    return { success: false, error: '密码错误' };
  }

  const token = createSession(username);
  return { success: true, token };
}

/**
 * Destroy session
 * @param {string} token - Session token
 */
export function logout(token) {
  sessions.delete(token);
}

/**
 * Clean expired sessions
 */
export function cleanExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (now > session.expiresAt) {
      sessions.delete(token);
    }
  }
}

// Clean up every hour
setInterval(cleanExpiredSessions, 60 * 60 * 1000);

// Export for testing
export const _internal = {
  sessions,
  SESSION_EXPIRY,
  resetSessions: () => sessions.clear(),
};
