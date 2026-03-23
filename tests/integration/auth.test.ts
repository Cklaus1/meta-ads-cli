import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthManager } from '../../src/auth.js';

// Mock keytar
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue(null),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
  },
}));

// Mock logger
vi.mock('../../src/logger.js', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('AuthManager', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.META_ADS_CLI_ACCESS_TOKEN;
    delete process.env.META_ACCESS_TOKEN;
    delete process.env.META_ADS_CLI_APP_ID;
    delete process.env.META_APP_ID;
    delete process.env.META_ADS_CLI_APP_SECRET;
    delete process.env.META_APP_SECRET;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getToken', () => {
    it('returns META_ADS_CLI_ACCESS_TOKEN env var first', async () => {
      process.env.META_ADS_CLI_ACCESS_TOKEN = 'env-token-1';
      const auth = new AuthManager();
      const token = await auth.getToken();
      expect(token).toBe('env-token-1');
    });

    it('returns META_ACCESS_TOKEN as fallback env var', async () => {
      process.env.META_ACCESS_TOKEN = 'env-token-2';
      const auth = new AuthManager();
      const token = await auth.getToken();
      expect(token).toBe('env-token-2');
    });

    it('prefers META_ADS_CLI_ACCESS_TOKEN over META_ACCESS_TOKEN', async () => {
      process.env.META_ADS_CLI_ACCESS_TOKEN = 'primary';
      process.env.META_ACCESS_TOKEN = 'fallback';
      const auth = new AuthManager();
      const token = await auth.getToken();
      expect(token).toBe('primary');
    });

    it('throws when no token available', async () => {
      const auth = new AuthManager();
      await expect(auth.getToken()).rejects.toThrow('Not logged in');
    });

    it('throws when cached token is expired', async () => {
      const keytar = await import('keytar');
      (keytar.default.getPassword as ReturnType<typeof vi.fn>).mockResolvedValue(
        JSON.stringify({
          accessToken: 'expired-token',
          expiresIn: 3600,
          createdAt: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago, expired 1hr ago
        })
      );

      const auth = new AuthManager();
      await auth.initialize();
      await expect(auth.getToken()).rejects.toThrow('Not logged in');
    });

    it('returns valid cached token', async () => {
      const keytar = await import('keytar');
      (keytar.default.getPassword as ReturnType<typeof vi.fn>).mockResolvedValue(
        JSON.stringify({
          accessToken: 'cached-token',
          expiresIn: 3600,
          createdAt: Math.floor(Date.now() / 1000), // just created
        })
      );

      const auth = new AuthManager();
      await auth.initialize();
      const token = await auth.getToken();
      expect(token).toBe('cached-token');
    });

    it('returns cached token without expiry', async () => {
      const keytar = await import('keytar');
      (keytar.default.getPassword as ReturnType<typeof vi.fn>).mockResolvedValue(
        JSON.stringify({
          accessToken: 'forever-token',
          createdAt: 0, // very old, but no expiresIn
        })
      );

      const auth = new AuthManager();
      await auth.initialize();
      const token = await auth.getToken();
      expect(token).toBe('forever-token');
    });
  });

  describe('getAppId', () => {
    it('reads META_ADS_CLI_APP_ID', () => {
      process.env.META_ADS_CLI_APP_ID = 'app-123';
      const auth = new AuthManager();
      expect(auth.getAppId()).toBe('app-123');
    });

    it('falls back to META_APP_ID', () => {
      process.env.META_APP_ID = 'app-456';
      const auth = new AuthManager();
      expect(auth.getAppId()).toBe('app-456');
    });

    it('returns empty string when not set', () => {
      const auth = new AuthManager();
      expect(auth.getAppId()).toBe('');
    });
  });

  describe('login', () => {
    it('throws when no App ID configured', async () => {
      const auth = new AuthManager();
      await expect(auth.login()).rejects.toThrow('No App ID configured');
    });
  });

  describe('logout', () => {
    it('clears token and does not throw', async () => {
      const auth = new AuthManager();
      // Should not throw even with no token
      await expect(auth.logout()).resolves.not.toThrow();
    });
  });

  describe('verifyLogin', () => {
    it('returns success false when not logged in', async () => {
      const auth = new AuthManager();
      const result = await auth.verifyLogin();
      expect(result.success).toBe(false);
    });

    it('returns success with user data on valid token', async () => {
      process.env.META_ADS_CLI_ACCESS_TOKEN = 'valid-token';
      const auth = new AuthManager();

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ name: 'Test User', id: '12345' }),
      } as Response);

      const result = await auth.verifyLogin();
      expect(result.success).toBe(true);
      expect(result.user).toEqual({ name: 'Test User', id: '12345' });
    });

    it('returns success false on API failure', async () => {
      process.env.META_ADS_CLI_ACCESS_TOKEN = 'bad-token';
      const auth = new AuthManager();

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 401,
      } as Response);

      const result = await auth.verifyLogin();
      expect(result.success).toBe(false);
    });
  });

  describe('initialize', () => {
    it('handles keytar failure gracefully', async () => {
      const keytar = await import('keytar');
      (keytar.default.getPassword as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('keytar not available')
      );

      const auth = new AuthManager();
      // Should not throw
      await expect(auth.initialize()).resolves.not.toThrow();
    });
  });
});
