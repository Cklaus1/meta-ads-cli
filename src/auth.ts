import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import http from 'http';
import logger from './logger.js';
import { API_VERSION } from './meta-client.js';
import { CONFIG_DIR, ensurePrivateDir, writePrivateFile } from './private-file.js';

const SERVICE_NAME = 'meta-ads-cli';
const TOKEN_CACHE_ACCOUNT = 'meta-token-cache';

const FALLBACK_TOKEN_PATH = path.join(CONFIG_DIR, 'token-cache.json');

export const AUTH_SCOPE = [
  'business_management', 'public_profile', 'ads_management', 'ads_read', 'read_insights', 'leads_retrieval',
  'pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_engagement',
  'pages_manage_metadata', 'pages_messaging', 'instagram_basic', 'instagram_content_publish',
  'instagram_manage_insights', 'catalog_management',
].join(',');
// WhatsApp/Threads permissions need those products added to the app, so they
// aren't requested by default. Override the whole list with this env var.
export function authScope(): string {
  return process.env.META_ADS_CLI_AUTH_SCOPES || AUTH_SCOPE;
}
const AUTH_REDIRECT_URI = 'http://localhost:8899/callback';
// Keychain calls go over D-Bus on Linux and can block for 25s+ when no
// session bus or secret service is running (WSL, containers, CI).
const KEYCHAIN_TIMEOUT_MS = 2000;

type Keytar = typeof import('keytar');
let keytarPromise: Promise<Keytar | null> | null = null;

/** Load keytar lazily, so commands that never touch the keychain don't pay for it. */
function loadKeytar(): Promise<Keytar | null> {
  if (process.env.META_ADS_CLI_NO_KEYCHAIN) return Promise.resolve(null);
  // On Linux without a session bus, libsecret tries to autolaunch one and the
  // call blocks a libuv thread (keeping the process alive) for 25s or more.
  if (process.platform === 'linux' && !process.env.DBUS_SESSION_BUS_ADDRESS) return Promise.resolve(null);
  if (!keytarPromise) {
    keytarPromise = import('keytar').then(m => m.default ?? (m as unknown as Keytar)).catch(() => null);
  }
  return keytarPromise;
}

/** Run a keychain call, giving up (and falling back to the file cache) after a short timeout. */
async function withKeychain<T>(fn: (k: Keytar) => Promise<T>): Promise<T | undefined> {
  const keytar = await loadKeytar();
  if (!keytar) return undefined;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), KEYCHAIN_TIMEOUT_MS);
    timer.unref();
  });
  try {
    return await Promise.race([fn(keytar), timeout]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function envToken(): string | undefined {
  return process.env.META_ADS_CLI_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN || undefined;
}

interface TokenData {
  accessToken: string;
  expiresIn?: number;
  createdAt: number;
  userId?: string;
}

export class AuthManager {
  private appId: string;
  private appSecret: string;
  private tokenData: TokenData | null = null;
  private apiVersion: string;

  constructor(apiVersion: string = API_VERSION) {
    this.apiVersion = apiVersion;
    this.appId = process.env.META_ADS_CLI_APP_ID
      || process.env.META_APP_ID
      || '';
    this.appSecret = process.env.META_ADS_CLI_APP_SECRET
      || process.env.META_APP_SECRET
      || '';
  }

  async initialize(): Promise<void> {
    // An env token takes priority, so there's no need to touch the keychain.
    if (envToken()) return;
    await this.loadTokenCache();
  }

  private async loadTokenCache(): Promise<void> {
    try {
      let cacheData: string | undefined;
      const data = await withKeychain(k => k.getPassword(SERVICE_NAME, TOKEN_CACHE_ACCOUNT));
      if (data) cacheData = data;

      if (!cacheData && fs.existsSync(FALLBACK_TOKEN_PATH)) {
        cacheData = fs.readFileSync(FALLBACK_TOKEN_PATH, 'utf8');
      }

      if (cacheData) {
        const parsed = JSON.parse(cacheData) as TokenData;
        // Check expiry
        if (parsed.expiresIn) {
          const expiryTime = parsed.createdAt + parsed.expiresIn;
          if (Date.now() / 1000 > expiryTime) {
            logger.info('Cached token is expired, discarding');
            this.tokenData = null;
            return;
          }
        }
        this.tokenData = parsed;
        logger.info('Loaded cached token');
      }
    } catch {
      // ignore cache load errors
    }
  }

  private async saveTokenCache(): Promise<void> {
    if (!this.tokenData) return;
    ensurePrivateDir();
    const cacheData = JSON.stringify(this.tokenData);
    const saved = await withKeychain(async k => { await k.setPassword(SERVICE_NAME, TOKEN_CACHE_ACCOUNT, cacheData); return true; });
    if (!saved) {
      writePrivateFile(FALLBACK_TOKEN_PATH, cacheData);
    }
  }

  /** Cache a token obtained outside the login flow (e.g. refresh-token). */
  async storeToken(accessToken: string, expiresIn?: number): Promise<void> {
    this.tokenData = { accessToken, expiresIn, createdAt: Math.floor(Date.now() / 1000) };
    await this.saveTokenCache();
  }

  async getToken(): Promise<string> {
    // Check env var token first (accept alternate variable names)
    const token = envToken();
    if (token) return token;

    if (this.tokenData?.accessToken) {
      // Check expiry
      if (this.tokenData.expiresIn) {
        const expiryTime = this.tokenData.createdAt + this.tokenData.expiresIn;
        if (Date.now() / 1000 > expiryTime) {
          throw new Error('Token expired. Run: meta-ads auth login');
        }
      }
      return this.tokenData.accessToken;
    }

    throw new Error('Not logged in. Run: meta-ads auth login');
  }

  async login(): Promise<string> {
    if (!this.appId) {
      throw new Error(
        'No App ID configured. Set META_ADS_CLI_APP_ID in your .env file or run: meta-ads auth setup'
      );
    }

    // Random state ties the token POST back to the auth URL we generated, so
    // another page or host can't plant its own token in the cache.
    const state = crypto.randomBytes(24).toString('hex');

    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', `http://localhost:8899`);

        if (url.pathname === '/callback') {
          // Serve HTML that extracts the token from the URL fragment
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head><title>Meta Ads CLI - Authentication</title></head>
            <body>
              <h2>Processing authentication...</h2>
              <p id="status">Extracting token...</p>
              <script>
                const hash = window.location.hash.substring(1);
                const params = new URLSearchParams(hash);
                const token = params.get('access_token');
                const expiresIn = params.get('expires_in');
                const state = params.get('state');
                if (token) {
                  fetch('/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ access_token: token, expires_in: expiresIn, state })
                  }).then(() => {
                    document.getElementById('status').textContent = 'Authentication successful! You can close this window.';
                  });
                } else {
                  document.getElementById('status').textContent = 'Authentication failed. No token received.';
                }
              </script>
            </body>
            </html>
          `);
          return;
        }

        if (url.pathname === '/token' && req.method === 'POST') {
          const origin = req.headers.origin;
          const contentType = req.headers['content-type'] || '';
          if ((origin && origin !== 'http://localhost:8899') || !contentType.startsWith('application/json')) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
          }
          let body = '';
          req.on('data', chunk => {
            body += chunk;
            if (body.length > 16_384) req.destroy();
          });
          req.on('end', async () => {
            try {
              const data = JSON.parse(body);
              if (typeof data.state !== 'string' || data.state.length !== state.length
                || !crypto.timingSafeEqual(Buffer.from(data.state), Buffer.from(state))) {
                // Ignore forged requests and keep waiting for the real callback.
                res.writeHead(400);
                res.end('Invalid state');
                return;
              }
              const shortLivedToken = data.access_token;
              const expiresIn = data.expires_in ? parseInt(data.expires_in) : undefined;

              // Try to exchange for long-lived token
              let finalToken = shortLivedToken;
              let finalExpiresIn = expiresIn;

              if (this.appSecret) {
                try {
                  const exchanged = await this.exchangeForLongLivedToken(shortLivedToken);
                  if (exchanged) {
                    finalToken = exchanged.accessToken;
                    finalExpiresIn = exchanged.expiresIn;
                    logger.info(`Exchanged for long-lived token (expires in ${finalExpiresIn}s)`);
                  }
                } catch (err) {
                  logger.warn(`Could not exchange for long-lived token: ${err}`);
                }
              }

              this.tokenData = {
                accessToken: finalToken,
                expiresIn: finalExpiresIn,
                createdAt: Math.floor(Date.now() / 1000),
              };

              await this.saveTokenCache();

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));

              server.close();
              resolve(finalToken);
            } catch (err) {
              res.writeHead(400);
              res.end('Invalid request');
              server.close();
              reject(err);
            }
          });
          return;
        }

        res.writeHead(404);
        res.end('Not found');
      });

      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(
            'Port 8899 is already in use — another "meta-ads auth login" may still be running.\n'
            + 'Free it and try again:\n'
            + '  lsof -iTCP:8899 -sTCP:LISTEN     # find the process\n'
            + '  fuser -k 8899/tcp               # or kill it directly\n'
            + 'If nothing is listed, wait up to 5 minutes for a stale login to time out, then retry.'
          ));
        } else {
          reject(err);
        }
      });

      server.listen(8899, '127.0.0.1', () => {
        const authUrl = `https://www.facebook.com/${this.apiVersion}/dialog/oauth?client_id=${encodeURIComponent(this.appId)}`
          + `&redirect_uri=${encodeURIComponent(AUTH_REDIRECT_URI)}&scope=${encodeURIComponent(authScope())}&response_type=token&state=${state}`;
        console.log('\nOpen this URL in your browser to authenticate:\n');
        console.log(`  ${authUrl}\n`);
        console.log('Waiting for authentication...\n');
      });

      // Timeout after 5 minutes
      const timeout = setTimeout(() => {
        server.close();
        reject(new Error('Authentication timed out after 5 minutes'));
      }, 300000);
      timeout.unref();
    });
  }

  async exchangeForLongLivedToken(shortLivedToken: string): Promise<TokenData | null> {
    const qs = new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: this.appId,
      client_secret: this.appSecret,
      fb_exchange_token: shortLivedToken,
    });
    const url = `https://graph.facebook.com/${this.apiVersion}/oauth/access_token?${qs}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return null;
    const data = await response.json() as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;
    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
      createdAt: Math.floor(Date.now() / 1000),
    };
  }

  async logout(): Promise<void> {
    this.tokenData = null;
    await withKeychain(k => k.deletePassword(SERVICE_NAME, TOKEN_CACHE_ACCOUNT));
    if (fs.existsSync(FALLBACK_TOKEN_PATH)) {
      fs.unlinkSync(FALLBACK_TOKEN_PATH);
    }
  }

  async verifyLogin(): Promise<{ success: boolean; user?: { name: string; id: string } }> {
    try {
      const token = await this.getToken();
      const response = await fetch(
        `https://graph.facebook.com/${this.apiVersion}/me?access_token=${encodeURIComponent(token)}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (response.ok) {
        const data = await response.json() as { name: string; id: string };
        return { success: true, user: data };
      }
      return { success: false };
    } catch {
      return { success: false };
    }
  }

  getAppSecret(): string {
    return this.appSecret;
  }

  getApiVersion(): string {
    return this.apiVersion;
  }

  getAppId(): string {
    return this.appId;
  }
}
