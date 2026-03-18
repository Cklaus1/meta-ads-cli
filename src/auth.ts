import keytar from 'keytar';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import logger from './logger.js';

const SERVICE_NAME = 'meta-ads-cli';
const TOKEN_CACHE_ACCOUNT = 'meta-token-cache';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'meta-ads-cli');
const FALLBACK_TOKEN_PATH = path.join(CONFIG_DIR, 'token-cache.json');

const AUTH_SCOPE = 'business_management,public_profile,pages_show_list,pages_read_engagement,ads_management,ads_read,read_insights,leads_retrieval';
const AUTH_REDIRECT_URI = 'http://localhost:8899/callback';

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
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

  constructor() {
    this.appId = process.env.META_ADS_CLI_APP_ID
      || process.env.META_APP_ID
      || '';
    this.appSecret = process.env.META_ADS_CLI_APP_SECRET
      || process.env.META_APP_SECRET
      || '';
  }

  async initialize(): Promise<void> {
    await this.loadTokenCache();
  }

  private async loadTokenCache(): Promise<void> {
    try {
      let cacheData: string | undefined;
      try {
        const data = await keytar.getPassword(SERVICE_NAME, TOKEN_CACHE_ACCOUNT);
        if (data) cacheData = data;
      } catch {
        // keytar failed, try file fallback
      }

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
    ensureConfigDir();
    const cacheData = JSON.stringify(this.tokenData);
    try {
      await keytar.setPassword(SERVICE_NAME, TOKEN_CACHE_ACCOUNT, cacheData);
    } catch {
      fs.writeFileSync(FALLBACK_TOKEN_PATH, cacheData);
    }
  }

  async getToken(): Promise<string> {
    // Check env var token first (accept alternate variable names)
    const envToken = process.env.META_ADS_CLI_ACCESS_TOKEN
      || process.env.META_ACCESS_TOKEN;
    if (envToken) return envToken;

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
                if (token) {
                  fetch('/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ access_token: token, expires_in: expiresIn })
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
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            try {
              const data = JSON.parse(body);
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

      server.listen(8899, () => {
        const authUrl = `https://www.facebook.com/v24.0/dialog/oauth?client_id=${this.appId}&redirect_uri=${encodeURIComponent(AUTH_REDIRECT_URI)}&scope=${AUTH_SCOPE}&response_type=token`;
        console.log('\nOpen this URL in your browser to authenticate:\n');
        console.log(`  ${authUrl}\n`);
        console.log('Waiting for authentication...\n');
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        server.close();
        reject(new Error('Authentication timed out after 5 minutes'));
      }, 300000);
    });
  }

  private async exchangeForLongLivedToken(shortLivedToken: string): Promise<TokenData | null> {
    const url = `https://graph.facebook.com/v24.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${this.appId}&client_secret=${this.appSecret}&fb_exchange_token=${shortLivedToken}`;
    const response = await fetch(url);
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
    try {
      await keytar.deletePassword(SERVICE_NAME, TOKEN_CACHE_ACCOUNT);
    } catch {
      // ignore keytar errors
    }
    if (fs.existsSync(FALLBACK_TOKEN_PATH)) {
      fs.unlinkSync(FALLBACK_TOKEN_PATH);
    }
  }

  async verifyLogin(): Promise<{ success: boolean; user?: { name: string; id: string } }> {
    try {
      const token = await this.getToken();
      const response = await fetch(
        `https://graph.facebook.com/v24.0/me?access_token=${token}`
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

  getAppId(): string {
    return this.appId;
  }
}
