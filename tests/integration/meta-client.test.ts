import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MetaClient, parseUsageHeaders } from '../../src/meta-client.js';

// Mock the logger to suppress output
vi.mock('../../src/logger.js', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function createMockAuth() {
  return {
    getToken: vi.fn().mockResolvedValue('test-token-123'),
    initialize: vi.fn().mockResolvedValue(undefined),
  } as unknown as import('../../src/auth.js').AuthManager;
}

describe('MetaClient', () => {
  let auth: ReturnType<typeof createMockAuth>;
  let client: MetaClient;

  beforeEach(() => {
    auth = createMockAuth();
    client = new MetaClient(auth);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseUsageHeaders', () => {
    it('returns zero usage when headers are missing', () => {
      expect(parseUsageHeaders(undefined).peakPct).toBe(0);
    });

    it('parses X-App-Usage and reports the peak gauge', () => {
      const h = new Headers({ 'x-app-usage': JSON.stringify({ call_count: 20, total_time: 65, total_cputime: 10 }) });
      const u = parseUsageHeaders(h);
      expect(u.peakPct).toBe(65);
      expect(u.detail).toContain('total_time');
    });

    it('parses business-use-case usage with recovery estimate', () => {
      const h = new Headers({
        'x-business-use-case-usage': JSON.stringify({
          '123': [{ type: 'ads_management', call_count: 10, total_time: 81, estimated_time_to_regain_access: 32 }],
        }),
      });
      const u = parseUsageHeaders(h);
      expect(u.peakPct).toBe(81);
      expect(u.estimatedRecoverSec).toBe(32 * 60);
    });

    it('takes the max across multiple headers', () => {
      const h = new Headers({
        'x-app-usage': JSON.stringify({ call_count: 30 }),
        'x-ad-account-usage': JSON.stringify({ acc_id_util_pct: 95 }),
      });
      // ad-account-usage uses a different key shape; app-usage call_count wins here
      expect(parseUsageHeaders(h).peakPct).toBe(30);
    });
  });

  describe('buildUrl', () => {
    it('builds URL with endpoint', () => {
      const url = client.buildUrl('me/adaccounts');
      expect(url).toBe('https://graph.facebook.com/v25.0/me/adaccounts');
    });

    it('appends query parameters', () => {
      const url = client.buildUrl('me', { fields: 'id,name', limit: '10' });
      expect(url).toContain('fields=id%2Cname');
      expect(url).toContain('limit=10');
      expect(url).toContain('?');
    });

    it('encodes special characters in params', () => {
      const url = client.buildUrl('search', { q: 'hello world' });
      expect(url).toContain('q=hello%20world');
    });

    it('skips params when empty', () => {
      const url = client.buildUrl('me', {});
      expect(url).toBe('https://graph.facebook.com/v25.0/me');
    });
  });

  describe('request - dry-run mode', () => {
    it('returns mock response without making API call', async () => {
      const dryClient = new MetaClient(auth, true);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await dryClient.request('me/campaigns', {
        params: { fields: 'id,name' },
      });

      expect(result.status).toBe(0);
      expect(result.data).toMatchObject({ dryRun: true, method: 'GET' });
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[dry-run] GET')
      );
    });

    it('logs body in dry-run POST', async () => {
      const dryClient = new MetaClient(auth, true);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await dryClient.request('act_123/campaigns', {
        method: 'POST',
        body: { name: 'Test' },
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[dry-run] Body:')
      );
    });
  });

  describe('request - read-only mode', () => {
    it('allows GET requests', async () => {
      const roClient = new MetaClient(auth, false, undefined, true);
      const mockResponse = {
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ id: '123' })),
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as Response);

      const result = await roClient.request('me');
      expect(result.status).toBe(200);
    });

    it('blocks POST requests', async () => {
      const roClient = new MetaClient(auth, false, undefined, true);
      await expect(
        roClient.request('act_123/campaigns', { method: 'POST', body: { name: 'X' } })
      ).rejects.toThrow('Read-only mode');
    });

    it('blocks DELETE requests', async () => {
      const roClient = new MetaClient(auth, false, undefined, true);
      await expect(
        roClient.request('123', { method: 'DELETE' })
      ).rejects.toThrow('Read-only mode');
    });
  });

  describe('request - API responses', () => {
    it('returns parsed JSON on success', async () => {
      const responseData = { id: '123', name: 'My Campaign' };
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(responseData)),
      } as Response);

      const result = await client.request('123', { params: { fields: 'id,name' } });
      expect(result.data).toEqual(responseData);
      expect(result.status).toBe(200);
    });

    it('extracts pagination cursor', async () => {
      const responseData = {
        data: [{ id: '1' }],
        paging: { cursors: { after: 'cursor_abc' } },
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(responseData)),
      } as Response);

      const result = await client.request('act_123/campaigns');
      expect(result.nextCursor).toBe('cursor_abc');
    });

    it('sends POST as form-urlencoded', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ id: '456' })),
      } as Response);

      await client.request('act_123/campaigns', {
        method: 'POST',
        body: { name: 'New Campaign' },
      });

      const [, fetchOpts] = fetchSpy.mock.calls[0];
      expect(fetchOpts?.method).toBe('POST');
      expect(fetchOpts?.headers).toEqual({
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      const body = fetchOpts?.body as string;
      expect(body).toContain('name=New+Campaign');
      expect(body).toContain('access_token=test-token-123');
    });
  });

  describe('request - error handling', () => {
    it('throws auth error on 401', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 401,
        text: () =>
          Promise.resolve(
            JSON.stringify({ error: { message: 'Invalid token', code: 190 } })
          ),
      } as Response);

      await expect(client.request('me')).rejects.toThrow('Authentication failed');
    });

    it('throws auth error on error code 190', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({ error: { message: 'Token expired', code: 190 } })
          ),
      } as Response);

      await expect(client.request('me')).rejects.toThrow('Authentication failed');
    });

    it('throws auth error on error code 102', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({ error: { message: 'Session expired', code: 102 } })
          ),
      } as Response);

      await expect(client.request('me')).rejects.toThrow('Authentication failed');
    });

    it('throws permission error on 403', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 403,
        text: () =>
          Promise.resolve(
            JSON.stringify({ error: { message: 'No permission', code: 200 } })
          ),
      } as Response);

      await expect(client.request('me')).rejects.toThrow('Permission denied');
    });

    it('throws generic API error for other failures', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({ error: { message: 'Bad request', code: 100 } })
          ),
      } as Response);

      await expect(client.request('me')).rejects.toThrow('Meta API error (400)');
    });

    it('handles non-JSON error response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 502,
        text: () => Promise.resolve('Bad Gateway'),
      } as Response);

      // 502 triggers retry, so mock all 3 attempts
      await expect(client.request('me')).rejects.toThrow('Meta API error (502): Bad Gateway');
    });

    it('handles non-JSON success response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('OK'),
      } as Response);

      const result = await client.request('me');
      expect(result.data).toEqual({ rawResponse: 'OK' });
    });
  });

  describe('request - retry logic', () => {
    it('retries on 429 rate limit', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: () => Promise.resolve('{}'),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ id: '1' })),
        } as Response);

      vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await client.request('me');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result.status).toBe(200);
    });

    it('retries on 5xx server error', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Internal Server Error'),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ id: '1' })),
        } as Response);

      vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await client.request('me');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result.status).toBe(200);
    });

    it('throws a rate-limit error on a persistent rate-limit error code', async () => {
      // code 4 is a Meta app-level rate-limit code; the client recognizes it
      // (regardless of HTTP status) and surfaces a clear rate-limit message
      // once the auto-wait budget is exhausted.
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers(),
        text: () => Promise.resolve(JSON.stringify({ error: { message: 'Rate limited', code: 4 } })),
      } as Response);

      vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(client.request('me')).rejects.toThrow('Meta rate limit reached');
    });

    it('throws a generic API error for a persistent non-rate-limit 4xx', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 400,
        headers: new Headers(),
        text: () => Promise.resolve(JSON.stringify({ error: { message: 'Bad field', code: 100 } })),
      } as Response);

      vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(client.request('me')).rejects.toThrow('Meta API error (400)');
    });
  });

  describe('requestAllPages', () => {
    it('fetches single page when no pagination', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(JSON.stringify({ data: [{ id: '1' }, { id: '2' }] })),
      } as Response);

      const result = await client.requestAllPages('act_123/campaigns');
      const data = result.data as { data: unknown[] };
      expect(data.data).toHaveLength(2);
    });

    it('aggregates multiple pages', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                data: [{ id: '1' }],
                paging: { cursors: { after: 'cursor1' } },
              })
            ),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                data: [{ id: '2' }],
              })
            ),
        } as Response);

      const result = await client.requestAllPages('act_123/campaigns');
      const data = result.data as { data: unknown[] };
      expect(data.data).toHaveLength(2);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('respects page limit', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                data: [{ id: '1' }],
                paging: { cursors: { after: 'next' } },
              })
            ),
        } as Response)
      );

      vi.spyOn(console, 'error').mockImplementation(() => {});

      await client.requestAllPages('act_123/campaigns', {}, 2);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('returns immediately for non-array data', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(JSON.stringify({ id: '1', name: 'Single item' })),
      } as Response);

      const result = await client.requestAllPages('123');
      expect((result.data as Record<string, unknown>).id).toBe('1');
    });
  });

  describe('constructor', () => {
    it('uses provided API version', () => {
      const c = new MetaClient(auth, false, 'v19.0');
      const url = c.buildUrl('me');
      expect(url).toContain('v19.0');
    });

    it('defaults to v25.0', () => {
      const url = client.buildUrl('me');
      expect(url).toContain('v25.0');
    });
  });
});
