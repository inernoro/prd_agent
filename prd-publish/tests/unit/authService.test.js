import { jest } from '@jest/globals';

// Mock config before importing
jest.unstable_mockModule('../../src/config.js', () => ({
  config: {
    auth: {
      username: 'testuser',
      password: 'testpass123',
      jwtSecret: 'test-secret-key',
      tokenExpiry: '1h',
    },
  },
}));

const {
  login,
  validateCredentials,
  generateToken,
  verifyToken,
  checkLockout,
  recordFailedAttempt,
  clearAttempts,
  _internal,
} = await import('../../src/services/authService.js');

describe('AuthService', () => {
  beforeEach(() => {
    // Reset login attempts before each test
    _internal.resetAttempts();
  });

  describe('validateCredentials', () => {
    it('should return true for valid credentials', () => {
      expect(validateCredentials('testuser', 'testpass123')).toBe(true);
    });

    it('should return false for invalid username', () => {
      expect(validateCredentials('wronguser', 'testpass123')).toBe(false);
    });

    it('should return false for invalid password', () => {
      expect(validateCredentials('testuser', 'wrongpass')).toBe(false);
    });

    it('should return false for empty credentials', () => {
      expect(validateCredentials('', '')).toBe(false);
    });
  });

  describe('generateToken', () => {
    it('should generate a valid JWT token', () => {
      const token = generateToken('testuser');
      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });

    it('should include username in token payload', () => {
      const token = generateToken('testuser');
      const result = verifyToken(token);
      expect(result.valid).toBe(true);
      expect(result.payload.username).toBe('testuser');
    });
  });

  describe('verifyToken', () => {
    it('should verify a valid token', () => {
      const token = generateToken('testuser');
      const result = verifyToken(token);
      expect(result.valid).toBe(true);
      expect(result.payload.username).toBe('testuser');
    });

    it('should reject an invalid token', () => {
      const result = verifyToken('invalid.token.here');
      expect(result.valid).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('should reject an empty token', () => {
      const result = verifyToken('');
      expect(result.valid).toBe(false);
    });
  });

  describe('checkLockout', () => {
    it('should return not locked for new user', () => {
      const result = checkLockout('newuser');
      expect(result.locked).toBe(false);
    });

    it('should return not locked after few failed attempts', () => {
      for (let i = 0; i < 3; i++) {
        recordFailedAttempt('testuser');
      }
      const result = checkLockout('testuser');
      expect(result.locked).toBe(false);
    });

    it('should return locked after threshold exceeded', () => {
      for (let i = 0; i < _internal.LOCKOUT_THRESHOLD; i++) {
        recordFailedAttempt('testuser');
      }
      const result = checkLockout('testuser');
      expect(result.locked).toBe(true);
      expect(result.remainingTime).toBeGreaterThan(0);
    });
  });

  describe('clearAttempts', () => {
    it('should clear failed attempts', () => {
      recordFailedAttempt('testuser');
      recordFailedAttempt('testuser');
      clearAttempts('testuser');
      const result = checkLockout('testuser');
      expect(result.locked).toBe(false);
    });
  });

  describe('login', () => {
    it('should return success for valid credentials', () => {
      const result = login('testuser', 'testpass123');
      expect(result.success).toBe(true);
      expect(result.token).toBeTruthy();
    });

    it('should return error for invalid credentials', () => {
      const result = login('testuser', 'wrongpass');
      expect(result.success).toBe(false);
      expect(result.error).toContain('用户名或密码错误');
    });

    it('should track failed attempts', () => {
      login('testuser', 'wrongpass');
      login('testuser', 'wrongpass');
      const attempts = _internal.loginAttempts.get('testuser');
      expect(attempts.count).toBe(2);
    });

    it('should clear attempts after successful login', () => {
      login('testuser', 'wrongpass');
      login('testuser', 'wrongpass');
      login('testuser', 'testpass123');
      const attempts = _internal.loginAttempts.get('testuser');
      expect(attempts).toBeUndefined();
    });

    it('should lockout after too many failures', () => {
      for (let i = 0; i < _internal.LOCKOUT_THRESHOLD; i++) {
        login('testuser', 'wrongpass');
      }
      const result = login('testuser', 'testpass123');
      expect(result.success).toBe(false);
      expect(result.error).toContain('锁定');
    });

    it('should show remaining attempts', () => {
      const result = login('testuser', 'wrongpass');
      expect(result.error).toContain('还剩');
    });
  });
});
