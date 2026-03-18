#!/usr/bin/env node

// src/index.ts
import "dotenv/config";
import { Command } from "commander";

// src/auth.ts
import keytar from "keytar";
import fs2 from "fs";
import path2 from "path";
import os from "os";
import http from "http";

// src/logger.ts
import fs from "fs";
import path from "path";
var LEVEL_ORDER = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 4
};
var Logger = class {
  constructor() {
    this.stream = null;
    this.level = process.env.META_ADS_CLI_LOG_LEVEL || "none";
    this.logFile = process.env.META_ADS_CLI_LOG_FILE || null;
    if (this.logFile) {
      const dir = path.dirname(this.logFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      const ext = path.extname(this.logFile);
      const base = this.logFile.slice(0, -ext.length || void 0);
      const rotatedPath = `${base}-${date}${ext || ".log"}`;
      this.stream = fs.createWriteStream(rotatedPath, { flags: "a" });
    }
  }
  shouldLog(level) {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }
  write(level, message, data) {
    if (!this.shouldLog(level)) return;
    const entry = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      message,
      ...data !== void 0 ? { data } : {}
    };
    if (this.stream) {
      this.stream.write(JSON.stringify(entry) + "\n");
    }
    if (!this.logFile || level === "warn" || level === "error") {
      const prefix = level === "error" ? "Error" : level === "warn" ? "Warning" : level;
      if (level === "debug" || level === "info") {
        if (!this.logFile) {
          console.error(`[${prefix}] ${message}`);
        }
      } else {
        console.error(`[${prefix}] ${message}`);
      }
    }
  }
  debug(message, data) {
    this.write("debug", message, data);
  }
  info(message, data) {
    this.write("info", message, data);
  }
  warn(message, data) {
    this.write("warn", message, data);
  }
  error(message, data) {
    this.write("error", message, data);
  }
  close() {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
};
var logger = new Logger();
var logger_default = logger;

// src/auth.ts
var SERVICE_NAME = "meta-ads-cli";
var TOKEN_CACHE_ACCOUNT = "meta-token-cache";
var CONFIG_DIR = path2.join(os.homedir(), ".config", "meta-ads-cli");
var FALLBACK_TOKEN_PATH = path2.join(CONFIG_DIR, "token-cache.json");
var AUTH_SCOPE = "business_management,public_profile,pages_show_list,pages_read_engagement,ads_management,ads_read,read_insights,leads_retrieval";
var AUTH_REDIRECT_URI = "http://localhost:8899/callback";
function ensureConfigDir() {
  if (!fs2.existsSync(CONFIG_DIR)) {
    fs2.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}
var AuthManager = class {
  constructor() {
    this.tokenData = null;
    this.appId = process.env.META_ADS_CLI_APP_ID || process.env.META_APP_ID || "";
    this.appSecret = process.env.META_ADS_CLI_APP_SECRET || process.env.META_APP_SECRET || "";
  }
  async initialize() {
    await this.loadTokenCache();
  }
  async loadTokenCache() {
    try {
      let cacheData;
      try {
        const data = await keytar.getPassword(SERVICE_NAME, TOKEN_CACHE_ACCOUNT);
        if (data) cacheData = data;
      } catch {
      }
      if (!cacheData && fs2.existsSync(FALLBACK_TOKEN_PATH)) {
        cacheData = fs2.readFileSync(FALLBACK_TOKEN_PATH, "utf8");
      }
      if (cacheData) {
        const parsed = JSON.parse(cacheData);
        if (parsed.expiresIn) {
          const expiryTime = parsed.createdAt + parsed.expiresIn;
          if (Date.now() / 1e3 > expiryTime) {
            logger_default.info("Cached token is expired, discarding");
            this.tokenData = null;
            return;
          }
        }
        this.tokenData = parsed;
        logger_default.info("Loaded cached token");
      }
    } catch {
    }
  }
  async saveTokenCache() {
    if (!this.tokenData) return;
    ensureConfigDir();
    const cacheData = JSON.stringify(this.tokenData);
    try {
      await keytar.setPassword(SERVICE_NAME, TOKEN_CACHE_ACCOUNT, cacheData);
    } catch {
      fs2.writeFileSync(FALLBACK_TOKEN_PATH, cacheData);
    }
  }
  async getToken() {
    const envToken = process.env.META_ADS_CLI_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN;
    if (envToken) return envToken;
    if (this.tokenData?.accessToken) {
      if (this.tokenData.expiresIn) {
        const expiryTime = this.tokenData.createdAt + this.tokenData.expiresIn;
        if (Date.now() / 1e3 > expiryTime) {
          throw new Error("Token expired. Run: meta-ads auth login");
        }
      }
      return this.tokenData.accessToken;
    }
    throw new Error("Not logged in. Run: meta-ads auth login");
  }
  async login() {
    if (!this.appId) {
      throw new Error(
        "No App ID configured. Set META_ADS_CLI_APP_ID in your .env file or run: meta-ads auth setup"
      );
    }
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || "/", `http://localhost:8899`);
        if (url.pathname === "/callback") {
          res.writeHead(200, { "Content-Type": "text/html" });
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
        if (url.pathname === "/token" && req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });
          req.on("end", async () => {
            try {
              const data = JSON.parse(body);
              const shortLivedToken = data.access_token;
              const expiresIn = data.expires_in ? parseInt(data.expires_in) : void 0;
              let finalToken = shortLivedToken;
              let finalExpiresIn = expiresIn;
              if (this.appSecret) {
                try {
                  const exchanged = await this.exchangeForLongLivedToken(shortLivedToken);
                  if (exchanged) {
                    finalToken = exchanged.accessToken;
                    finalExpiresIn = exchanged.expiresIn;
                    logger_default.info(`Exchanged for long-lived token (expires in ${finalExpiresIn}s)`);
                  }
                } catch (err) {
                  logger_default.warn(`Could not exchange for long-lived token: ${err}`);
                }
              }
              this.tokenData = {
                accessToken: finalToken,
                expiresIn: finalExpiresIn,
                createdAt: Math.floor(Date.now() / 1e3)
              };
              await this.saveTokenCache();
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true }));
              server.close();
              resolve(finalToken);
            } catch (err) {
              res.writeHead(400);
              res.end("Invalid request");
              server.close();
              reject(err);
            }
          });
          return;
        }
        res.writeHead(404);
        res.end("Not found");
      });
      server.listen(8899, () => {
        const authUrl = `https://www.facebook.com/v24.0/dialog/oauth?client_id=${this.appId}&redirect_uri=${encodeURIComponent(AUTH_REDIRECT_URI)}&scope=${AUTH_SCOPE}&response_type=token`;
        console.log("\nOpen this URL in your browser to authenticate:\n");
        console.log(`  ${authUrl}
`);
        console.log("Waiting for authentication...\n");
      });
      setTimeout(() => {
        server.close();
        reject(new Error("Authentication timed out after 5 minutes"));
      }, 3e5);
    });
  }
  async exchangeForLongLivedToken(shortLivedToken) {
    const url = `https://graph.facebook.com/v24.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${this.appId}&client_secret=${this.appSecret}&fb_exchange_token=${shortLivedToken}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.access_token) return null;
    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
      createdAt: Math.floor(Date.now() / 1e3)
    };
  }
  async logout() {
    this.tokenData = null;
    try {
      await keytar.deletePassword(SERVICE_NAME, TOKEN_CACHE_ACCOUNT);
    } catch {
    }
    if (fs2.existsSync(FALLBACK_TOKEN_PATH)) {
      fs2.unlinkSync(FALLBACK_TOKEN_PATH);
    }
  }
  async verifyLogin() {
    try {
      const token = await this.getToken();
      const response = await fetch(
        `https://graph.facebook.com/v24.0/me?access_token=${token}`
      );
      if (response.ok) {
        const data = await response.json();
        return { success: true, user: data };
      }
      return { success: false };
    } catch {
      return { success: false };
    }
  }
  getAppId() {
    return this.appId;
  }
};

// src/mime.ts
var MIME_TYPES = {
  // Images
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  // Video
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".m4v": "video/x-m4v",
  ".3gp": "video/3gpp",
  // Audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  // Documents
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".html": "text/html",
  // Archives
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar"
};
function detectMimeType(filename) {
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || "";
  return MIME_TYPES[ext] || "application/octet-stream";
}

// src/meta-client.ts
var MAX_RETRIES = 3;
var MAX_PAGES = 100;
var API_VERSION = "v24.0";
var MetaClient = class {
  constructor(auth, dryRun2 = false, apiVersion2, readOnly2 = false) {
    this.auth = auth;
    this.dryRun = dryRun2;
    this.readOnly = readOnly2;
    this.apiVersion = apiVersion2 || process.env.META_ADS_CLI_API_VERSION || API_VERSION;
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;
  }
  buildUrl(endpoint, params) {
    let url = `${this.baseUrl}/${endpoint}`;
    if (params && Object.keys(params).length > 0) {
      const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
      url += (url.includes("?") ? "&" : "?") + qs;
    }
    return url;
  }
  async request(endpoint, options = {}) {
    const method = options.method || "GET";
    if (this.readOnly && method !== "GET") {
      throw new Error(`Read-only mode: ${method} requests are blocked. Remove --read-only to allow writes.`);
    }
    if (this.dryRun) {
      const url = this.buildUrl(endpoint, options.params);
      console.log(`[dry-run] ${method} ${url}`);
      if (options.body) {
        console.log(`[dry-run] Body: ${JSON.stringify(options.body)}`);
      }
      return { data: { dryRun: true, method, endpoint }, status: 0 };
    }
    const token = await this.auth.getToken();
    const allParams = {
      access_token: token,
      ...options.params
    };
    logger_default.debug(`${method} ${endpoint}`, options.params);
    let lastError = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      let response;
      if (method === "GET" || method === "DELETE") {
        const url = this.buildUrl(endpoint, allParams);
        response = await fetch(url, { method });
      } else {
        const url = this.buildUrl(endpoint);
        const formBody = new URLSearchParams({
          ...allParams,
          ...options.body
        });
        response = await fetch(url, {
          method,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: formBody.toString()
        });
      }
      logger_default.debug(`Response: ${response.status} ${response.statusText}`, { attempt });
      if (response.status === 429) {
        const waitMs = Math.pow(2, attempt) * 1e3;
        if (attempt < MAX_RETRIES - 1) {
          logger_default.warn(`Rate limited. Retrying in ${waitMs / 1e3}s...`);
          console.error(`Rate limited. Retrying in ${waitMs / 1e3}s...`);
          await sleep(waitMs);
          continue;
        }
      }
      if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
        const waitMs = Math.pow(2, attempt) * 1e3;
        logger_default.warn(`Server error (${response.status}). Retrying in ${waitMs / 1e3}s...`);
        console.error(`Server error (${response.status}). Retrying in ${waitMs / 1e3}s...`);
        await sleep(waitMs);
        continue;
      }
      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        if (!response.ok) {
          throw new Error(`Meta API error (${response.status}): ${text}`);
        }
        return { data: { rawResponse: text }, status: response.status };
      }
      const obj = json;
      if (!response.ok || obj.error) {
        const errorObj = obj.error;
        const errorMessage = errorObj?.message || text;
        const errorCode = errorObj?.code;
        logger_default.error(`API error ${response.status}: ${errorMessage}`);
        if (response.status === 401 || errorCode === 190 || errorCode === 102) {
          throw new Error(`Authentication failed. Run: meta-ads auth login`);
        }
        if (response.status === 403 || errorCode === 200) {
          throw new Error(`Permission denied: ${errorMessage}`);
        }
        throw new Error(`Meta API error (${response.status}): ${errorMessage}`);
      }
      const paging = obj.paging;
      const cursors = paging?.cursors;
      const nextCursor = cursors?.after || void 0;
      return { data: json, status: response.status, nextCursor };
    }
    throw lastError || new Error("Request failed after retries");
  }
  async requestAllPages(endpoint, options = {}, pageLimit, pageDelayMs) {
    const maxPages = pageLimit || MAX_PAGES;
    const delayMs = pageDelayMs || 0;
    const first = await this.request(endpoint, options);
    const data = first.data;
    if (!data.data || !Array.isArray(data.data)) {
      return first;
    }
    let allItems = [...data.data];
    let nextCursor = first.nextCursor;
    let pageCount = 1;
    while (nextCursor && pageCount < maxPages) {
      if (delayMs > 0) await sleep(delayMs);
      const nextOptions = {
        ...options,
        params: {
          ...options.params,
          after: nextCursor
        }
      };
      const nextResponse = await this.request(endpoint, nextOptions);
      const nextData = nextResponse.data;
      if (nextData.data && Array.isArray(nextData.data)) {
        allItems = allItems.concat(nextData.data);
      }
      nextCursor = nextResponse.nextCursor;
      pageCount++;
    }
    if (pageCount >= maxPages && nextCursor) {
      console.error(`Warning: Reached page limit (${maxPages}). Results may be incomplete.`);
    }
    logger_default.info(`Paginated: ${allItems.length} items across ${pageCount} pages`);
    data.data = allItems;
    return { data, status: first.status };
  }
  /**
   * Upload a file (image or video) via multipart form data.
   * For videos > 25MB, uses resumable upload with chunked streaming.
   */
  async uploadFile(endpoint, filePath) {
    const { readFileSync, statSync } = await import("fs");
    const stat = statSync(filePath);
    const fileSize = stat.size;
    const contentType = detectMimeType(filePath);
    logger_default.info(`Uploading ${filePath} (${fileSize} bytes, ${contentType})`);
    if (this.dryRun) {
      console.log(`[dry-run] POST ${this.baseUrl}/${endpoint}`);
      console.log(`[dry-run] File: ${filePath} (${fileSize} bytes, ${contentType})`);
      return { data: { dryRun: true, method: "POST", fileSize, contentType }, status: 0 };
    }
    const token = await this.auth.getToken();
    const content = readFileSync(filePath);
    const boundary = `----MetaAdsCLI${Date.now()}`;
    const parts = [];
    parts.push(Buffer.from(`--${boundary}\r
Content-Disposition: form-data; name="access_token"\r
\r
${token}\r
`));
    const filename = filePath.split("/").pop() || "file";
    parts.push(Buffer.from(`--${boundary}\r
Content-Disposition: form-data; name="source"; filename="${filename}"\r
Content-Type: ${contentType}\r
\r
`));
    parts.push(content);
    parts.push(Buffer.from(`\r
--${boundary}--\r
`));
    const body = Buffer.concat(parts);
    const url = `${this.baseUrl}/${endpoint}`;
    console.error(`Uploading ${filename} (${(fileSize / 1024 / 1024).toFixed(1)} MB)...`);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.byteLength)
      },
      body
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Upload failed (${response.status}): ${errorText}`);
    }
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      return { data: json, status: response.status };
    } catch {
      return { data: { message: "Upload complete", size: fileSize }, status: response.status };
    }
  }
};
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/commands/auth.ts
function registerAuthCommands(program2, getAuth2) {
  const auth = program2.command("auth").description("Authentication management");
  auth.command("login").description("Login via Meta OAuth flow (opens browser)").action(async () => {
    const authManager2 = getAuth2();
    await authManager2.initialize();
    try {
      await authManager2.login();
      const result = await authManager2.verifyLogin();
      if (result.success && result.user) {
        console.log(`Logged in as ${result.user.name} (ID: ${result.user.id})`);
      } else {
        console.log('Login completed. Run "meta-ads auth status" to verify.');
      }
    } catch (err) {
      console.error("Login failed:", err.message);
      process.exit(1);
    }
  });
  auth.command("logout").description("Log out and clear saved credentials").action(async () => {
    const authManager2 = getAuth2();
    await authManager2.initialize();
    await authManager2.logout();
    console.log("Logged out successfully.");
  });
  auth.command("status").description("Verify current login status").action(async () => {
    const authManager2 = getAuth2();
    await authManager2.initialize();
    const result = await authManager2.verifyLogin();
    if (result.success && result.user) {
      console.log(`Logged in as ${result.user.name} (ID: ${result.user.id})`);
      console.log(`App ID: ${authManager2.getAppId() || "(not set)"}`);
    } else {
      console.log("Not logged in. Run: meta-ads auth login");
    }
  });
  auth.command("setup").description("Configure Meta App credentials").action(async () => {
    console.log("Meta Ads CLI Setup");
    console.log("==================\n");
    console.log("To use this CLI, you need a Meta App with Ads API access.");
    console.log("1. Go to https://developers.facebook.com/apps");
    console.log("2. Create or select an app");
    console.log('3. Add "Marketing API" product to your app\n');
    console.log("Then set these environment variables in your .env file:\n");
    console.log("  META_ADS_CLI_APP_ID=your_app_id");
    console.log("  META_ADS_CLI_APP_SECRET=your_app_secret\n");
    console.log("Optional: Set a default ad account:");
    console.log("  META_ADS_CLI_ACCOUNT_ID=act_XXXXXXXXX\n");
    console.log("After configuration, run: meta-ads auth login");
  });
  auth.command("login-link").description("Generate a login URL for authentication").action(async () => {
    const authManager2 = getAuth2();
    const appId = authManager2.getAppId();
    if (!appId) {
      console.error("No App ID configured. Set META_ADS_CLI_APP_ID or run: meta-ads auth setup");
      process.exit(1);
    }
    const scope = "business_management,public_profile,pages_show_list,pages_read_engagement,ads_management,ads_read,read_insights,leads_retrieval";
    const url = `https://www.facebook.com/v24.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent("http://localhost:8899/callback")}&scope=${scope}&response_type=token`;
    console.log("\nOpen this URL in your browser to authenticate:\n");
    console.log(`  ${url}
`);
  });
  auth.command("refresh-token").description("Refresh the current access token for extended validity").action(async () => {
    const authManager2 = getAuth2();
    await authManager2.initialize();
    try {
      const token = await authManager2.getToken();
      const appId = process.env.META_ADS_CLI_APP_ID || process.env.META_APP_ID || "";
      const appSecret = process.env.META_ADS_CLI_APP_SECRET || process.env.META_APP_SECRET || "";
      if (!appSecret) {
        console.error("App Secret required for token refresh. Set META_ADS_CLI_APP_SECRET");
        process.exit(1);
      }
      const url = `https://graph.facebook.com/v24.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${token}`;
      const response = await fetch(url);
      if (!response.ok) {
        const err = await response.text();
        console.error(`Token refresh failed: ${err}`);
        process.exit(1);
      }
      const data = await response.json();
      console.log(`Token refreshed successfully.`);
      if (data.expires_in) {
        console.log(`Expires in: ${Math.round(data.expires_in / 86400)} days`);
      }
      console.log(`
New token: ${data.access_token.slice(0, 20)}...`);
      console.log("\nTo use it, set: META_ADS_CLI_ACCESS_TOKEN=<token>");
    } catch (err) {
      console.error("Token refresh failed:", err.message);
      process.exit(1);
    }
  });
}

// src/formatter.ts
function formatOutput(data, format) {
  switch (format) {
    case "json":
      return JSON.stringify(data, null, 2);
    case "table":
      return formatTable(data);
    case "csv":
      return formatCsv(data);
    case "text":
      return formatText(data);
    case "yaml":
      return formatYaml(data);
    default:
      return JSON.stringify(data, null, 2);
  }
}
function flattenObject(obj, prefix = "") {
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (val === null || val === void 0) {
      result[fullKey] = "";
    } else if (Array.isArray(val)) {
      if (val.length > 0 && typeof val[0] === "object") {
        const summaries = val.map((item) => {
          if (typeof item === "object" && item !== null) {
            const flat = flattenObject(item);
            return flat["name"] || flat["id"] || flat["displayName"] || Object.values(flat)[0] || "";
          }
          return String(item);
        });
        result[fullKey] = summaries.join(", ");
      } else {
        result[fullKey] = val.join(", ");
      }
    } else if (typeof val === "object") {
      Object.assign(result, flattenObject(val, fullKey));
    } else {
      result[fullKey] = String(val);
    }
  }
  return result;
}
function formatTable(data) {
  const items = extractItems(data);
  if (items.length === 0) return "(no results)";
  const flatItems = items.map((item) => {
    if (typeof item !== "object" || item === null) return { value: String(item) };
    return flattenObject(item);
  });
  const keySet = /* @__PURE__ */ new Set();
  for (const item of flatItems) {
    for (const key of Object.keys(item)) {
      keySet.add(key);
    }
  }
  const columns = Array.from(keySet);
  if (columns.length === 0) return JSON.stringify(data, null, 2);
  const widths = {};
  for (const col of columns) {
    widths[col] = col.length;
  }
  for (const item of flatItems) {
    for (const col of columns) {
      const val = item[col] ?? "";
      widths[col] = Math.min(Math.max(widths[col], val.length), 50);
    }
  }
  const header = columns.map((c) => c.padEnd(widths[c])).join("  ");
  const separator = columns.map((c) => "-".repeat(widths[c])).join("  ");
  const rows = flatItems.map((item) => {
    return columns.map((col) => {
      const val = item[col] ?? "";
      return val.substring(0, 50).padEnd(widths[col]);
    }).join("  ");
  });
  return [header, separator, ...rows].join("\n");
}
function formatCsv(data) {
  const items = extractItems(data);
  if (items.length === 0) return "";
  const flatItems = items.map((item) => {
    if (typeof item !== "object" || item === null) return { value: String(item) };
    return flattenObject(item);
  });
  const keySet = /* @__PURE__ */ new Set();
  for (const item of flatItems) {
    for (const key of Object.keys(item)) {
      keySet.add(key);
    }
  }
  const columns = Array.from(keySet);
  const header = columns.map(csvEscape).join(",");
  const rows = flatItems.map((item) => {
    return columns.map((col) => csvEscape(item[col] ?? "")).join(",");
  });
  return [header, ...rows].join("\n");
}
function formatText(data) {
  const items = extractItems(data);
  if (items.length === 0) {
    if (typeof data === "object" && data !== null) {
      const flat = flattenObject(data);
      return Object.entries(flat).map(([k, v]) => `${k}: ${v}`).join("\n");
    }
    return String(data);
  }
  return items.map((item, i) => {
    if (typeof item !== "object" || item === null) return String(item);
    const flat = flattenObject(item);
    const entries = Object.entries(flat).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    return `[${i + 1}]
${entries}`;
  }).join("\n\n");
}
function formatYaml(data) {
  return toYaml(data, 0);
}
function toYaml(data, indent) {
  const pad = "  ".repeat(indent);
  if (data === null || data === void 0) return `${pad}null
`;
  if (typeof data === "boolean") return `${pad}${data}
`;
  if (typeof data === "number") return `${pad}${data}
`;
  if (typeof data === "string") {
    if (data.includes("\n") || data.includes('"') || data.includes(":")) {
      return `${pad}"${data.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"
`;
    }
    return `${pad}${data}
`;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return `${pad}[]
`;
    let out = "";
    for (const item of data) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const entries = Object.entries(item);
        if (entries.length > 0) {
          const [firstKey, firstVal] = entries[0];
          out += `${pad}- ${firstKey}: ${inlineValue(firstVal)}
`;
          for (let j = 1; j < entries.length; j++) {
            out += `${pad}  ${entries[j][0]}: ${inlineValue(entries[j][1])}
`;
          }
          continue;
        }
      }
      out += `${pad}- ${inlineValue(item)}
`;
    }
    return out;
  }
  if (typeof data === "object") {
    const entries = Object.entries(data);
    if (entries.length === 0) return `${pad}{}
`;
    let out = "";
    for (const [key, val] of entries) {
      if (typeof val === "object" && val !== null && !Array.isArray(val)) {
        out += `${pad}${key}:
${toYaml(val, indent + 1)}`;
      } else if (Array.isArray(val)) {
        out += `${pad}${key}:
${toYaml(val, indent + 1)}`;
      } else {
        out += `${pad}${key}: ${inlineValue(val)}
`;
      }
    }
    return out;
  }
  return `${pad}${String(data)}
`;
}
function inlineValue(val) {
  if (val === null || val === void 0) return "null";
  if (typeof val === "boolean" || typeof val === "number") return String(val);
  if (typeof val === "string") {
    if (val.includes("\n") || val.includes('"') || val.includes(":") || val.includes("#")) {
      return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
    }
    return val;
  }
  if (Array.isArray(val)) return JSON.stringify(val);
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}
function extractItems(data) {
  if (Array.isArray(data)) return data;
  if (typeof data === "object" && data !== null) {
    const obj = data;
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj.value)) return obj.value;
  }
  return [data];
}
function csvEscape(val) {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

// src/errors.ts
function handleErrors(fn) {
  return (async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });
}

// src/commands/accounts.ts
function registerAccountCommands(program2, getClient2) {
  const accounts = program2.command("accounts").description("Ad account management");
  accounts.command("list").description("List ad accounts accessible by current user").option("--limit <n>", "Maximum number of accounts", "200").option("--user-id <id>", "User ID (default: me)", "me").option("--all", "Fetch all pages").option("--page-limit <n>", "Max pages when using --all").option("-o, --output <format>", "Output format: json, table, csv, text, yaml", "json").action(handleErrors(async (opts) => {
    const client = getClient2();
    const params = {
      fields: "id,name,account_id,account_status,amount_spent,balance,currency,age,business_city,business_country_code",
      limit: opts.limit
    };
    const endpoint = `${opts.userId}/adaccounts`;
    const response = opts.all ? await client.requestAllPages(
      endpoint,
      { params },
      opts.pageLimit ? parseInt(opts.pageLimit) : void 0
    ) : await client.request(endpoint, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  accounts.command("get <accountId>").description("Get detailed info for a specific ad account").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (accountId, opts) => {
    const client = getClient2();
    const id = accountId.startsWith("act_") ? accountId : `act_${accountId}`;
    const params = {
      fields: "id,name,account_id,account_status,amount_spent,balance,currency,age,business_city,business_country_code,timezone_name,spend_cap,funding_source_details"
    };
    const response = await client.request(id, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
}

// src/commands/campaigns.ts
function getDefaultAccountId() {
  return process.env.META_ADS_CLI_ACCOUNT_ID || "";
}
function registerCampaignCommands(program2, getClient2) {
  const campaigns = program2.command("campaigns").alias("camp").description("Campaign management");
  campaigns.command("list").description("List campaigns for an ad account").option("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId()).option("--limit <n>", "Maximum number of campaigns", "10").option("--status <status>", "Filter by effective status (ACTIVE, PAUSED, ARCHIVED)").option("--after <cursor>", "Pagination cursor").option("--all", "Fetch all pages").option("--page-limit <n>", "Max pages when using --all").option("--page-delay <ms>", "Delay between pages in ms").option("-o, --output <format>", "Output format: json, table, csv, text, yaml", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) {
      throw new Error("Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID");
    }
    const client = getClient2();
    const params = {
      fields: "id,name,objective,status,daily_budget,lifetime_budget,buying_type,start_time,stop_time,created_time,updated_time,bid_strategy",
      limit: opts.limit
    };
    if (opts.status) {
      params.effective_status = JSON.stringify([opts.status]);
    }
    if (opts.after) {
      params.after = opts.after;
    }
    const endpoint = `${opts.accountId}/campaigns`;
    const response = opts.all ? await client.requestAllPages(
      endpoint,
      { params },
      opts.pageLimit ? parseInt(opts.pageLimit) : void 0,
      opts.pageDelay ? parseInt(opts.pageDelay) : void 0
    ) : await client.request(endpoint, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  campaigns.command("get <campaignId>").description("Get detailed info for a specific campaign").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (campaignId, opts) => {
    const client = getClient2();
    const params = {
      fields: "id,name,objective,status,daily_budget,lifetime_budget,buying_type,start_time,stop_time,created_time,updated_time,bid_strategy,special_ad_categories,budget_remaining,configured_status"
    };
    const response = await client.request(campaignId, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  campaigns.command("create").description("Create a new campaign").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId()).requiredOption("--name <name>", "Campaign name").requiredOption("--objective <objective>", "Campaign objective (OUTCOME_AWARENESS, OUTCOME_TRAFFIC, OUTCOME_ENGAGEMENT, OUTCOME_LEADS, OUTCOME_SALES, OUTCOME_APP_PROMOTION)").option("--status <status>", "Initial status", "PAUSED").option("--daily-budget <cents>", "Daily budget in cents").option("--lifetime-budget <cents>", "Lifetime budget in cents").option("--bid-strategy <strategy>", "Bid strategy (LOWEST_COST_WITHOUT_CAP, LOWEST_COST_WITH_BID_CAP, COST_CAP)").option("--bid-cap <cents>", "Bid cap in cents").option("--spend-cap <cents>", "Campaign spend cap in cents").option("--buying-type <type>", "Buying type (e.g., AUCTION)").option("--special-ad-categories <categories>", "Comma-separated special ad categories").option("--cbo", "Enable campaign budget optimization").option("--adset-level-budgets", "Use ad set level budgets instead of campaign level").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) {
      throw new Error("Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID");
    }
    const client = getClient2();
    const body = {
      name: opts.name,
      objective: opts.objective,
      status: opts.status,
      special_ad_categories: opts.specialAdCategories ? JSON.stringify(opts.specialAdCategories.split(",")) : "[]"
    };
    if (!opts.adsetLevelBudgets) {
      if (opts.dailyBudget) body.daily_budget = opts.dailyBudget;
      if (opts.lifetimeBudget) body.lifetime_budget = opts.lifetimeBudget;
      if (opts.cbo) body.campaign_budget_optimization = "true";
    }
    if (opts.bidStrategy) body.bid_strategy = opts.bidStrategy;
    if (opts.bidCap) body.bid_cap = opts.bidCap;
    if (opts.spendCap) body.spend_cap = opts.spendCap;
    if (opts.buyingType) body.buying_type = opts.buyingType;
    const response = await client.request(`${opts.accountId}/campaigns`, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  campaigns.command("update <campaignId>").description("Update an existing campaign").option("--name <name>", "New campaign name").option("--status <status>", "New status (ACTIVE, PAUSED, ARCHIVED)").option("--daily-budget <cents>", "New daily budget in cents").option("--lifetime-budget <cents>", "New lifetime budget in cents").option("--bid-strategy <strategy>", "New bid strategy").option("--bid-cap <cents>", "New bid cap in cents").option("--spend-cap <cents>", "New spend cap in cents").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (campaignId, opts) => {
    const client = getClient2();
    const body = {};
    if (opts.name) body.name = opts.name;
    if (opts.status) body.status = opts.status;
    if (opts.dailyBudget) body.daily_budget = opts.dailyBudget;
    if (opts.lifetimeBudget) body.lifetime_budget = opts.lifetimeBudget;
    if (opts.bidStrategy) body.bid_strategy = opts.bidStrategy;
    if (opts.bidCap) body.bid_cap = opts.bidCap;
    if (opts.spendCap) body.spend_cap = opts.spendCap;
    if (Object.keys(body).length === 0) {
      throw new Error("No update parameters provided");
    }
    const response = await client.request(campaignId, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  campaigns.command("delete <campaignId>").description("Delete (archive) a campaign").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (campaignId, opts) => {
    const client = getClient2();
    const response = await client.request(campaignId, {
      method: "POST",
      body: { status: "DELETED" }
    });
    console.log(formatOutput(response.data, opts.output));
  }));
}

// src/commands/adsets.ts
function getDefaultAccountId2() {
  return process.env.META_ADS_CLI_ACCOUNT_ID || "";
}
function registerAdSetCommands(program2, getClient2) {
  const adsets = program2.command("adsets").description("Ad set management");
  adsets.command("list").description("List ad sets for an ad account").option("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId2()).option("--campaign-id <id>", "Filter by campaign ID").option("--limit <n>", "Maximum number of ad sets", "10").option("--status <status>", "Filter by effective status").option("--all", "Fetch all pages").option("--page-limit <n>", "Max pages when using --all").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) {
      throw new Error("Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID");
    }
    const client = getClient2();
    const params = {
      fields: "id,name,campaign_id,status,daily_budget,lifetime_budget,targeting,bid_amount,bid_strategy,optimization_goal,billing_event,start_time,end_time,is_dynamic_creative",
      limit: opts.limit
    };
    if (opts.status) {
      params.effective_status = JSON.stringify([opts.status]);
    }
    let endpoint;
    if (opts.campaignId) {
      endpoint = `${opts.campaignId}/adsets`;
    } else {
      endpoint = `${opts.accountId}/adsets`;
    }
    const response = opts.all ? await client.requestAllPages(
      endpoint,
      { params },
      opts.pageLimit ? parseInt(opts.pageLimit) : void 0
    ) : await client.request(endpoint, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  adsets.command("get <adsetId>").description("Get detailed info for a specific ad set").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (adsetId, opts) => {
    const client = getClient2();
    const params = {
      fields: "id,name,campaign_id,status,daily_budget,lifetime_budget,targeting,bid_amount,bid_strategy,optimization_goal,billing_event,start_time,end_time,is_dynamic_creative,frequency_control_specs,promoted_object,destination_type"
    };
    const response = await client.request(adsetId, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  adsets.command("create").description("Create a new ad set").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId2()).requiredOption("--campaign-id <id>", "Campaign ID").requiredOption("--name <name>", "Ad set name").requiredOption("--optimization-goal <goal>", "Optimization goal (LINK_CLICKS, REACH, CONVERSIONS, etc.)").requiredOption("--billing-event <event>", "Billing event (IMPRESSIONS, LINK_CLICKS, etc.)").option("--status <status>", "Initial status", "PAUSED").option("--daily-budget <cents>", "Daily budget in cents").option("--lifetime-budget <cents>", "Lifetime budget in cents").option("--bid-amount <cents>", "Bid amount in cents").option("--bid-strategy <strategy>", "Bid strategy").option("--targeting <json>", "Targeting spec as JSON string").option("--start-time <time>", "Start time (ISO 8601)").option("--end-time <time>", "End time (ISO 8601)").option("--promoted-object <json>", "Promoted object as JSON string").option("--dynamic-creative", "Enable dynamic creative").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) {
      throw new Error("Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID");
    }
    const client = getClient2();
    const body = {
      campaign_id: opts.campaignId,
      name: opts.name,
      optimization_goal: opts.optimizationGoal,
      billing_event: opts.billingEvent,
      status: opts.status
    };
    if (opts.dailyBudget) body.daily_budget = opts.dailyBudget;
    if (opts.lifetimeBudget) body.lifetime_budget = opts.lifetimeBudget;
    if (opts.bidAmount) body.bid_amount = opts.bidAmount;
    if (opts.bidStrategy) body.bid_strategy = opts.bidStrategy;
    if (opts.targeting) body.targeting = opts.targeting;
    if (opts.startTime) body.start_time = opts.startTime;
    if (opts.endTime) body.end_time = opts.endTime;
    if (opts.promotedObject) body.promoted_object = opts.promotedObject;
    if (opts.dynamicCreative) body.is_dynamic_creative = "true";
    const response = await client.request(`${opts.accountId}/adsets`, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  adsets.command("update <adsetId>").description("Update an existing ad set").option("--name <name>", "New ad set name").option("--status <status>", "New status (ACTIVE, PAUSED, ARCHIVED)").option("--daily-budget <cents>", "New daily budget in cents").option("--lifetime-budget <cents>", "New lifetime budget in cents").option("--bid-amount <cents>", "New bid amount in cents").option("--bid-strategy <strategy>", "New bid strategy").option("--targeting <json>", "New targeting spec as JSON string").option("--optimization-goal <goal>", "New optimization goal").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (adsetId, opts) => {
    const client = getClient2();
    const body = {};
    if (opts.name) body.name = opts.name;
    if (opts.status) body.status = opts.status;
    if (opts.dailyBudget) body.daily_budget = opts.dailyBudget;
    if (opts.lifetimeBudget) body.lifetime_budget = opts.lifetimeBudget;
    if (opts.bidAmount) body.bid_amount = opts.bidAmount;
    if (opts.bidStrategy) body.bid_strategy = opts.bidStrategy;
    if (opts.targeting) body.targeting = opts.targeting;
    if (opts.optimizationGoal) body.optimization_goal = opts.optimizationGoal;
    if (Object.keys(body).length === 0) {
      throw new Error("No update parameters provided");
    }
    const response = await client.request(adsetId, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  adsets.command("delete <adsetId>").description("Delete (archive) an ad set").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (adsetId, opts) => {
    const client = getClient2();
    const response = await client.request(adsetId, {
      method: "POST",
      body: { status: "DELETED" }
    });
    console.log(formatOutput(response.data, opts.output));
  }));
}

// src/commands/ads.ts
function getDefaultAccountId3() {
  return process.env.META_ADS_CLI_ACCOUNT_ID || "";
}
function registerAdCommands(program2, getClient2) {
  const ads = program2.command("ads").description("Ad management");
  ads.command("list").description("List ads for an ad account").option("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId3()).option("--campaign-id <id>", "Filter by campaign ID").option("--adset-id <id>", "Filter by ad set ID").option("--limit <n>", "Maximum number of ads", "10").option("--status <status>", "Filter by effective status").option("--all", "Fetch all pages").option("--page-limit <n>", "Max pages when using --all").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) {
      throw new Error("Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID");
    }
    const client = getClient2();
    const params = {
      fields: "id,name,adset_id,campaign_id,status,creative,bid_amount,created_time,updated_time",
      limit: opts.limit
    };
    if (opts.status) {
      params.effective_status = JSON.stringify([opts.status]);
    }
    let endpoint;
    if (opts.adsetId) {
      endpoint = `${opts.adsetId}/ads`;
    } else if (opts.campaignId) {
      endpoint = `${opts.campaignId}/ads`;
    } else {
      endpoint = `${opts.accountId}/ads`;
    }
    const response = opts.all ? await client.requestAllPages(
      endpoint,
      { params },
      opts.pageLimit ? parseInt(opts.pageLimit) : void 0
    ) : await client.request(endpoint, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  ads.command("get <adId>").description("Get detailed info for a specific ad").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (adId, opts) => {
    const client = getClient2();
    const params = {
      fields: "id,name,adset_id,campaign_id,status,creative,bid_amount,tracking_specs,created_time,updated_time,effective_status"
    };
    const response = await client.request(adId, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  ads.command("create").description("Create a new ad").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId3()).requiredOption("--name <name>", "Ad name").requiredOption("--adset-id <id>", "Ad set ID").requiredOption("--creative-id <id>", "Creative ID").option("--status <status>", "Initial status", "PAUSED").option("--bid-amount <cents>", "Bid amount in cents").option("--tracking-specs <json>", "Tracking specs as JSON string").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) {
      throw new Error("Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID");
    }
    const client = getClient2();
    const body = {
      name: opts.name,
      adset_id: opts.adsetId,
      creative: JSON.stringify({ creative_id: opts.creativeId }),
      status: opts.status
    };
    if (opts.bidAmount) body.bid_amount = opts.bidAmount;
    if (opts.trackingSpecs) body.tracking_specs = opts.trackingSpecs;
    const response = await client.request(`${opts.accountId}/ads`, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  ads.command("update <adId>").description("Update an existing ad").option("--name <name>", "New ad name").option("--status <status>", "New status (ACTIVE, PAUSED)").option("--bid-amount <cents>", "New bid amount").option("--creative-id <id>", "New creative ID").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (adId, opts) => {
    const client = getClient2();
    const body = {};
    if (opts.name) body.name = opts.name;
    if (opts.status) body.status = opts.status;
    if (opts.bidAmount) body.bid_amount = opts.bidAmount;
    if (opts.creativeId) body.creative = JSON.stringify({ creative_id: opts.creativeId });
    if (Object.keys(body).length === 0) {
      throw new Error("No update parameters provided");
    }
    const response = await client.request(adId, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  ads.command("delete <adId>").description("Delete an ad").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (adId, opts) => {
    const client = getClient2();
    const response = await client.request(adId, {
      method: "POST",
      body: { status: "DELETED" }
    });
    console.log(formatOutput(response.data, opts.output));
  }));
}

// src/commands/creatives.ts
function getDefaultAccountId4() {
  return process.env.META_ADS_CLI_ACCOUNT_ID || "";
}
function registerCreativeCommands(program2, getClient2) {
  const creatives = program2.command("creatives").description("Ad creative management");
  creatives.command("list").description("List ad creatives for an account").option("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId4()).option("--limit <n>", "Maximum number of creatives", "10").option("--all", "Fetch all pages").option("--page-limit <n>", "Max pages when using --all").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) {
      throw new Error("Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID");
    }
    const client = getClient2();
    const params = {
      fields: "id,name,status,thumbnail_url,image_url,object_story_spec,asset_feed_spec",
      limit: opts.limit
    };
    const endpoint = `${opts.accountId}/adcreatives`;
    const response = opts.all ? await client.requestAllPages(
      endpoint,
      { params },
      opts.pageLimit ? parseInt(opts.pageLimit) : void 0
    ) : await client.request(endpoint, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  creatives.command("get <creativeId>").description("Get detailed info for a specific creative").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (creativeId, opts) => {
    const client = getClient2();
    const params = {
      fields: "id,name,status,thumbnail_url,image_url,image_hash,object_story_spec,asset_feed_spec,call_to_action_type,effective_object_story_id"
    };
    const response = await client.request(creativeId, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  creatives.command("get-for-ad <adId>").description("Get creatives for a specific ad").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (adId, opts) => {
    const client = getClient2();
    const params = {
      fields: "id,name,status,thumbnail_url,image_url,object_story_spec"
    };
    const response = await client.request(`${adId}/adcreatives`, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  creatives.command("create-image").description("Create an image ad creative").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId4()).requiredOption("--image-hash <hash>", "Image hash (from upload-image)").option("--name <name>", "Creative name").option("--page-id <id>", "Facebook Page ID").option("--link-url <url>", "Destination URL").option("--message <text>", "Ad body text").option("--headline <text>", "Ad headline").option("--description <text>", "Ad description").option("--cta <type>", "Call to action type (LEARN_MORE, SHOP_NOW, SIGN_UP, etc.)").option("--instagram-actor-id <id>", "Instagram account ID").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) {
      throw new Error("Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID");
    }
    const client = getClient2();
    const body = {};
    if (opts.name) body.name = opts.name;
    const linkData = {
      image_hash: opts.imageHash
    };
    if (opts.linkUrl) linkData.link = opts.linkUrl;
    if (opts.message) linkData.message = opts.message;
    if (opts.headline) linkData.name = opts.headline;
    if (opts.description) linkData.description = opts.description;
    if (opts.cta) {
      linkData.call_to_action = { type: opts.cta };
    }
    const objectStorySpec = {
      link_data: linkData
    };
    if (opts.pageId) objectStorySpec.page_id = opts.pageId;
    if (opts.instagramActorId) objectStorySpec.instagram_actor_id = opts.instagramActorId;
    body.object_story_spec = JSON.stringify(objectStorySpec);
    const response = await client.request(`${opts.accountId}/adcreatives`, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  creatives.command("create-video").description("Create a video ad creative").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId4()).requiredOption("--video-id <id>", "Video ID (from upload-video)").requiredOption("--page-id <id>", "Facebook Page ID").option("--name <name>", "Creative name").option("--message <text>", "Ad body text").option("--link-url <url>", "Destination URL").option("--cta <type>", "Call to action type", "LEARN_MORE").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) {
      throw new Error("Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID");
    }
    const client = getClient2();
    const body = {};
    if (opts.name) body.name = opts.name;
    const videoData = {
      video_id: opts.videoId,
      message: opts.message || "",
      call_to_action: {
        type: opts.cta,
        value: opts.linkUrl ? { link: opts.linkUrl } : void 0
      }
    };
    body.object_story_spec = JSON.stringify({
      page_id: opts.pageId,
      video_data: videoData
    });
    const response = await client.request(`${opts.accountId}/adcreatives`, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  creatives.command("update <creativeId>").description("Update a creative").option("--name <name>", "New creative name").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (creativeId, opts) => {
    const client = getClient2();
    const body = {};
    if (opts.name) body.name = opts.name;
    if (Object.keys(body).length === 0) {
      throw new Error("No update parameters provided");
    }
    const response = await client.request(creativeId, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  creatives.command("upload-image").description("Upload an image to the ad account").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId4()).option("--url <url>", "Image URL to upload").option("--name <name>", "Image name").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) {
      throw new Error("Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID");
    }
    if (!opts.url) {
      throw new Error("Image URL required. Use --url");
    }
    const client = getClient2();
    const body = {
      url: opts.url
    };
    if (opts.name) body.name = opts.name;
    const response = await client.request(`${opts.accountId}/adimages`, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  creatives.command("upload-video").description("Upload a video file or URL to the ad account").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId4()).option("--file <path>", "Local video file path").option("--url <url>", "Video URL to upload").option("--title <title>", "Video title").option("--description <desc>", "Video description").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) {
      throw new Error("Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID");
    }
    if (!opts.file && !opts.url) {
      throw new Error("Either --file or --url is required");
    }
    const client = getClient2();
    if (opts.file) {
      const response = await client.uploadFile(`${opts.accountId}/advideos`, opts.file);
      console.log(formatOutput(response.data, opts.output));
    } else {
      const body = {
        file_url: opts.url
      };
      if (opts.title) body.title = opts.title;
      if (opts.description) body.description = opts.description;
      const response = await client.request(`${opts.accountId}/advideos`, {
        method: "POST",
        body
      });
      console.log(formatOutput(response.data, opts.output));
    }
  }));
  creatives.command("save-image <adId>").description("Download and save an ad image locally").option("--output-path <path>", "Output file path", "./ad-image.jpg").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (adId, opts) => {
    const client = getClient2();
    const params = {
      fields: "id,name,creative"
    };
    const adResponse = await client.request(adId, { params });
    const ad = adResponse.data;
    const creative = ad.creative;
    if (creative?.id) {
      const creativeParams = {
        fields: "id,image_url,thumbnail_url"
      };
      const creativeResponse = await client.request(String(creative.id), { params: creativeParams });
      const creativeData = creativeResponse.data;
      const imageUrl = creativeData.image_url || creativeData.thumbnail_url;
      if (imageUrl) {
        const { writeFileSync } = await import("fs");
        const imgResponse = await fetch(String(imageUrl));
        const buffer = Buffer.from(await imgResponse.arrayBuffer());
        writeFileSync(opts.outputPath, buffer);
        console.log(formatOutput({
          ad_id: adId,
          image_url: imageUrl,
          saved_to: opts.outputPath,
          size_bytes: buffer.byteLength
        }, opts.output));
      } else {
        console.log(formatOutput({ error: "No image URL found for this ad" }, opts.output));
      }
    } else {
      console.log(formatOutput({ error: "No creative found for this ad" }, opts.output));
    }
  }));
}

// src/commands/insights.ts
function getDefaultAccountId5() {
  return process.env.META_ADS_CLI_ACCOUNT_ID || "";
}
function registerInsightCommands(program2, getClient2) {
  const insights = program2.command("insights").description("Performance analytics and reporting");
  insights.command("get <objectId>").description("Get performance insights for any object (account, campaign, adset, ad)").option("--time-range <range>", "Time range: today, yesterday, last_7d, last_30d, last_90d, this_month, last_month, maximum", "last_30d").option("--date-start <date>", "Custom date range start (YYYY-MM-DD)").option("--date-end <date>", "Custom date range end (YYYY-MM-DD)").option("--breakdown <breakdown>", "Breakdown: age, gender, country, device, platform, publisher_platform, impression_device").option("--level <level>", "Level of aggregation: account, campaign, adset, ad", "ad").option("--fields <fields>", "Comma-separated metric fields").option("--limit <n>", "Maximum number of results", "25").option("--after <cursor>", "Pagination cursor").option("--all", "Fetch all pages").option("--page-limit <n>", "Max pages when using --all").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (objectId, opts) => {
    const client = getClient2();
    const defaultFields = "impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,conversions,cost_per_action_type,date_start,date_stop";
    const params = {
      fields: opts.fields || defaultFields,
      limit: opts.limit,
      level: opts.level
    };
    if (opts.dateStart && opts.dateEnd) {
      params.time_range = JSON.stringify({
        since: opts.dateStart,
        until: opts.dateEnd
      });
    } else {
      const rangeMap = {};
      const now = /* @__PURE__ */ new Date();
      const fmt = (d) => d.toISOString().slice(0, 10);
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const ranges = {
        today: () => ({ since: fmt(now), until: fmt(now) }),
        yesterday: () => ({ since: fmt(yesterday), until: fmt(yesterday) }),
        last_7d: () => {
          const d = new Date(now);
          d.setDate(d.getDate() - 7);
          return { since: fmt(d), until: fmt(now) };
        },
        last_30d: () => {
          const d = new Date(now);
          d.setDate(d.getDate() - 30);
          return { since: fmt(d), until: fmt(now) };
        },
        last_90d: () => {
          const d = new Date(now);
          d.setDate(d.getDate() - 90);
          return { since: fmt(d), until: fmt(now) };
        },
        this_month: () => {
          const start = new Date(now.getFullYear(), now.getMonth(), 1);
          return { since: fmt(start), until: fmt(now) };
        },
        last_month: () => {
          const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          const end = new Date(now.getFullYear(), now.getMonth(), 0);
          return { since: fmt(start), until: fmt(end) };
        }
      };
      if (opts.timeRange !== "maximum" && ranges[opts.timeRange]) {
        params.time_range = JSON.stringify(ranges[opts.timeRange]());
      }
    }
    if (opts.breakdown) {
      params.breakdowns = opts.breakdown;
    }
    if (opts.after) {
      params.after = opts.after;
    }
    const endpoint = `${objectId}/insights`;
    const response = opts.all ? await client.requestAllPages(
      endpoint,
      { params },
      opts.pageLimit ? parseInt(opts.pageLimit) : void 0
    ) : await client.request(endpoint, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  insights.command("account").description("Get insights for the default ad account").option("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId5()).option("--time-range <range>", "Time range", "last_30d").option("--breakdown <breakdown>", "Breakdown dimension").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) {
      throw new Error("Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID");
    }
    const client = getClient2();
    const params = {
      fields: "impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,date_start,date_stop",
      level: "account"
    };
    if (opts.breakdown) {
      params.breakdowns = opts.breakdown;
    }
    const response = await client.request(`${opts.accountId}/insights`, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  insights.command("video <adId>").description("Get video performance metrics for an ad").option("--time-range <range>", "Time range", "maximum").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (adId, opts) => {
    const client = getClient2();
    const params = {
      fields: "video_play_actions,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions,video_avg_time_watched_actions,video_thruplay_watched_actions,impressions,reach,spend"
    };
    const response = await client.request(`${adId}/insights`, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
}

// src/commands/targeting.ts
function getDefaultAccountId6() {
  return process.env.META_ADS_CLI_ACCOUNT_ID || "";
}
function registerTargetingCommands(program2, getClient2) {
  const targeting = program2.command("targeting").description("Audience targeting and research");
  targeting.command("search-interests <query>").description("Search interest targeting options").option("--limit <n>", "Maximum results", "25").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (query, opts) => {
    const client = getClient2();
    const params = {
      type: "adinterest",
      q: query,
      limit: opts.limit
    };
    const response = await client.request("search", { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  targeting.command("suggest-interests").description("Get interest suggestions based on existing interests").requiredOption("--interests <ids>", "Comma-separated interest IDs").option("--limit <n>", "Maximum results", "25").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const client = getClient2();
    const params = {
      type: "adinterestsuggestion",
      interest_list: JSON.stringify(opts.interests.split(",")),
      limit: opts.limit
    };
    const response = await client.request("search", { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  targeting.command("search-behaviors").description("Get available behavior targeting options").option("--limit <n>", "Maximum results", "50").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const client = getClient2();
    const params = {
      type: "adTargetingCategory",
      class: "behaviors",
      limit: opts.limit
    };
    const response = await client.request("search", { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  targeting.command("search-demographics").description("Get demographic targeting options").option("--class <class>", "Demographic class (demographics, life_events, industries, income, family_statuses)", "demographics").option("--limit <n>", "Maximum results", "50").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const client = getClient2();
    const params = {
      type: "adTargetingCategory",
      class: opts.class,
      limit: opts.limit
    };
    const response = await client.request("search", { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  targeting.command("search-geo <query>").description("Search geographic locations").option("--type <type>", "Location type: country, region, city, zip, geo_market, electoral_district").option("--limit <n>", "Maximum results", "25").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (query, opts) => {
    const client = getClient2();
    const params = {
      type: "adgeolocation",
      q: query,
      limit: opts.limit
    };
    if (opts.type) {
      params.location_types = JSON.stringify([opts.type]);
    }
    const response = await client.request("search", { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  targeting.command("estimate-audience").description("Estimate audience size for a targeting spec").option("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId6()).requiredOption("--targeting <json>", "Targeting spec as JSON string").option("--optimization-goal <goal>", "Optimization goal", "REACH").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) {
      throw new Error("Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID");
    }
    const client = getClient2();
    const params = {
      targeting_spec: opts.targeting,
      optimization_goal: opts.optimizationGoal
    };
    const response = await client.request(`${opts.accountId}/delivery_estimate`, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
}

// src/commands/audiences.ts
function getDefaultAccountId7() {
  return process.env.META_ADS_CLI_ACCOUNT_ID || "";
}
function registerAudienceCommands(program2, getClient2) {
  const audiences = program2.command("audiences").description("Custom and lookalike audience management");
  audiences.command("list").description("List custom audiences for an account").option("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId7()).option("--limit <n>", "Maximum results", "25").option("--all", "Fetch all pages").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) {
      throw new Error("Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID");
    }
    const client = getClient2();
    const params = {
      fields: "id,name,description,approximate_count,data_source,delivery_status,operation_status,subtype,time_created,time_updated",
      limit: opts.limit
    };
    const endpoint = `${opts.accountId}/customaudiences`;
    const response = opts.all ? await client.requestAllPages(endpoint, { params }) : await client.request(endpoint, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  audiences.command("get <audienceId>").description("Get details for a custom audience").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (audienceId, opts) => {
    const client = getClient2();
    const params = {
      fields: "id,name,description,approximate_count,data_source,delivery_status,operation_status,subtype,time_created,time_updated,lookalike_spec,rule"
    };
    const response = await client.request(audienceId, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  audiences.command("create-custom").description("Create a custom audience").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId7()).requiredOption("--name <name>", "Audience name").option("--description <desc>", "Audience description").option("--subtype <type>", "Audience subtype (CUSTOM, WEBSITE, APP, OFFLINE_CONVERSION)").option("--rule <json>", "Audience rule as JSON").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) {
      throw new Error("Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID");
    }
    const client = getClient2();
    const body = {
      name: opts.name
    };
    if (opts.description) body.description = opts.description;
    if (opts.subtype) body.subtype = opts.subtype;
    if (opts.rule) body.rule = opts.rule;
    const response = await client.request(`${opts.accountId}/customaudiences`, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  audiences.command("create-lookalike").description("Create a lookalike audience from a source audience").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId7()).requiredOption("--source-audience-id <id>", "Source audience ID").option("--name <name>", "Audience name").option("--countries <countries>", "Comma-separated target country codes (e.g., US,GB)").option("--ratio <ratio>", "Lookalike ratio (0.01-0.20)", "0.01").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) {
      throw new Error("Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID");
    }
    const client = getClient2();
    const countries = opts.countries ? opts.countries.split(",") : ["US"];
    const lookalikeSpec = {
      type: "similarity",
      country: countries[0],
      ratio: parseFloat(opts.ratio),
      origin: [{ id: opts.sourceAudienceId, type: "custom_audience" }]
    };
    const body = {
      name: opts.name || `Lookalike - ${opts.sourceAudienceId}`,
      subtype: "LOOKALIKE",
      origin_audience_id: opts.sourceAudienceId,
      lookalike_spec: JSON.stringify(lookalikeSpec)
    };
    const response = await client.request(`${opts.accountId}/customaudiences`, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  audiences.command("update <audienceId>").description("Update an existing custom audience").option("--name <name>", "New audience name").option("--description <desc>", "New description").option("--rule <json>", "New audience rule as JSON").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (audienceId, opts) => {
    const client = getClient2();
    const body = {};
    if (opts.name) body.name = opts.name;
    if (opts.description) body.description = opts.description;
    if (opts.rule) body.rule = opts.rule;
    if (Object.keys(body).length === 0) throw new Error("No update parameters provided");
    const response = await client.request(audienceId, { method: "POST", body });
    console.log(formatOutput(response.data, opts.output));
  }));
  audiences.command("overlap").description("Analyze overlap between multiple audiences").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId7()).requiredOption("--audience-ids <ids>", "Comma-separated audience IDs (2-5)").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const ids = opts.audienceIds.split(",").map((id) => id.trim());
    const results = [];
    for (const id of ids) {
      const params = {
        fields: "id,name,approximate_count"
      };
      const response = await client.request(id, { params });
      results.push(response.data);
    }
    const combinedTargeting = {
      custom_audiences: ids.map((id) => ({ id }))
    };
    const estimateParams = {
      targeting_spec: JSON.stringify(combinedTargeting),
      optimization_goal: "REACH"
    };
    const estimate = await client.request(`${opts.accountId}/delivery_estimate`, { params: estimateParams });
    console.log(formatOutput({
      audiences: results,
      combined_estimate: estimate.data,
      note: "Combined estimate shows the merged audience reach. Compare with individual counts to gauge overlap."
    }, opts.output));
  }));
  audiences.command("delete <audienceId>").description("Delete a custom audience").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (audienceId, opts) => {
    const client = getClient2();
    const response = await client.request(audienceId, { method: "DELETE" });
    console.log(formatOutput(response.data, opts.output));
  }));
  const pixels = program2.command("pixels").description("Pixel and conversion tracking");
  pixels.command("list").description("List pixels for an ad account").option("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId7()).option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) {
      throw new Error("Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID");
    }
    const client = getClient2();
    const params = {
      fields: "id,name,code,creation_time,data_use_setting,last_fired_time,is_created_by_app"
    };
    const response = await client.request(`${opts.accountId}/adspixels`, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  pixels.command("create").description("Create a new tracking pixel").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId7()).requiredOption("--name <name>", "Pixel name").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) {
      throw new Error("Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID");
    }
    const client = getClient2();
    const body = { name: opts.name };
    const response = await client.request(`${opts.accountId}/adspixels`, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  pixels.command("events <pixelId>").description("Get pixel events").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (pixelId, opts) => {
    const client = getClient2();
    const params = {
      fields: "data"
    };
    const response = await client.request(`${pixelId}/stats`, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
}

// src/commands/pages.ts
function getDefaultAccountId8() {
  return process.env.META_ADS_CLI_ACCOUNT_ID || "";
}
function registerPageCommands(program2, getClient2) {
  const pages = program2.command("pages").description("Facebook Page management");
  pages.command("list").description("List pages for an ad account").option("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId8()).option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) {
      throw new Error("Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID");
    }
    const client = getClient2();
    const params = {
      fields: "id,name,category,fan_count,link,picture"
    };
    const response = await client.request("me/accounts", { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  pages.command("search <term>").description("Search pages by name").option("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId8()).option("-o, --output <format>", "Output format", "json").action(handleErrors(async (term, opts) => {
    const client = getClient2();
    const params = {
      type: "page",
      q: term,
      fields: "id,name,category,fan_count,link"
    };
    const response = await client.request("search", { params });
    console.log(formatOutput(response.data, opts.output));
  }));
}

// src/commands/leads.ts
function getDefaultAccountId9() {
  return process.env.META_ADS_CLI_ACCOUNT_ID || "";
}
function registerLeadCommands(program2, getClient2) {
  const leads = program2.command("leads").description("Lead form and lead management");
  leads.command("forms").description("List lead forms for an ad account").option("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId9()).option("--page-id <id>", "Page ID to list forms for").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const client = getClient2();
    let endpoint;
    if (opts.pageId) {
      endpoint = `${opts.pageId}/leadgen_forms`;
    } else if (opts.accountId) {
      endpoint = `${opts.accountId}/leadgen_forms`;
    } else {
      throw new Error("Either --account-id or --page-id required");
    }
    const params = {
      fields: "id,name,status,leads_count,created_time"
    };
    const response = await client.request(endpoint, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  leads.command("get <formId>").description("Get leads from a lead form").option("--limit <n>", "Maximum leads to return", "25").option("--all", "Fetch all pages").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (formId, opts) => {
    const client = getClient2();
    const params = {
      fields: "id,created_time,field_data,ad_id,ad_name,campaign_id,campaign_name",
      limit: opts.limit
    };
    const endpoint = `${formId}/leads`;
    const response = opts.all ? await client.requestAllPages(endpoint, { params }) : await client.request(endpoint, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  leads.command("create-form").description("Create a new lead form").requiredOption("--page-id <id>", "Page ID").requiredOption("--name <name>", "Form name").option("--questions <json>", "Questions as JSON array").option("--privacy-policy-url <url>", "Privacy policy URL").option("--thank-you-page-url <url>", "Thank you page URL").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const client = getClient2();
    const body = {
      name: opts.name
    };
    if (opts.questions) body.questions = opts.questions;
    if (opts.privacyPolicyUrl) {
      body.privacy_policy = JSON.stringify({ url: opts.privacyPolicyUrl });
    }
    if (opts.thankYouPageUrl) {
      body.thank_you_page = JSON.stringify({ url: opts.thankYouPageUrl });
    }
    const response = await client.request(`${opts.pageId}/leadgen_forms`, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  leads.command("export <formId>").description("Export all leads from a form (fetches all pages)").option("-o, --output <format>", "Output format (csv recommended for export)", "csv").action(handleErrors(async (formId, opts) => {
    const client = getClient2();
    const params = {
      fields: "id,created_time,field_data,ad_id,ad_name,campaign_id,campaign_name",
      limit: "500"
    };
    const response = await client.requestAllPages(`${formId}/leads`, { params }, 50);
    console.log(formatOutput(response.data, opts.output));
  }));
  leads.command("quality <formId>").description("Analyze lead quality for a form").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (formId, opts) => {
    const client = getClient2();
    const params = {
      fields: "id,created_time,field_data,ad_id,ad_name,campaign_id",
      limit: "100"
    };
    const response = await client.request(`${formId}/leads`, { params });
    const leads2 = response.data.data || [];
    let totalFields = 0;
    let filledFields = 0;
    const fieldCompleteness = {};
    for (const lead of leads2) {
      const fieldData = lead.field_data || [];
      for (const field of fieldData) {
        const name = String(field.name || "unknown");
        if (!fieldCompleteness[name]) fieldCompleteness[name] = { total: 0, filled: 0 };
        fieldCompleteness[name].total++;
        totalFields++;
        if (field.values && field.values.length > 0 && field.values[0]) {
          fieldCompleteness[name].filled++;
          filledFields++;
        }
      }
    }
    console.log(formatOutput({
      form_id: formId,
      total_leads: leads2.length,
      overall_completeness: totalFields > 0 ? `${(filledFields / totalFields * 100).toFixed(1)}%` : "N/A",
      field_analysis: Object.entries(fieldCompleteness).map(([name, stats]) => ({
        field: name,
        completeness: `${(stats.filled / stats.total * 100).toFixed(0)}%`,
        filled: stats.filled,
        total: stats.total
      }))
    }, opts.output));
  }));
  leads.command("webhooks <formId>").description("Setup webhooks for real-time lead notifications").requiredOption("--url <url>", "Webhook URL to receive lead notifications").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (formId, opts) => {
    const client = getClient2();
    const body = {
      object: "page",
      callback_url: opts.url,
      fields: "leadgen",
      verify_token: `meta_ads_cli_${Date.now()}`
    };
    const response = await client.request(`${formId}/subscriptions`, {
      method: "POST",
      body
    });
    console.log(formatOutput({
      form_id: formId,
      webhook_url: opts.url,
      subscription: response.data
    }, opts.output));
  }));
}

// src/commands/catalog.ts
function getDefaultAccountId10() {
  return process.env.META_ADS_CLI_ACCOUNT_ID || "";
}
function registerCatalogCommands(program2, getClient2) {
  const catalog = program2.command("catalog").description("Product catalog management");
  catalog.command("list").description("List product catalogs").option("--business-id <id>", "Business ID").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.businessId) {
      throw new Error("Business ID required. Use --business-id");
    }
    const client = getClient2();
    const params = {
      fields: "id,name,product_count,vertical,da_display_settings"
    };
    const response = await client.request(`${opts.businessId}/owned_product_catalogs`, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  catalog.command("get <catalogId>").description("Get catalog details").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (catalogId, opts) => {
    const client = getClient2();
    const params = {
      fields: "id,name,product_count,vertical,da_display_settings,feed_count"
    };
    const response = await client.request(catalogId, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  catalog.command("products <catalogId>").description("List products in a catalog").option("--limit <n>", "Maximum products", "25").option("--all", "Fetch all pages").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (catalogId, opts) => {
    const client = getClient2();
    const params = {
      fields: "id,name,description,price,currency,image_url,url,availability,brand,category",
      limit: opts.limit
    };
    const endpoint = `${catalogId}/products`;
    const response = opts.all ? await client.requestAllPages(endpoint, { params }) : await client.request(endpoint, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  catalog.command("product-sets <catalogId>").description("List product sets in a catalog").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (catalogId, opts) => {
    const client = getClient2();
    const params = {
      fields: "id,name,filter,product_count"
    };
    const response = await client.request(`${catalogId}/product_sets`, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  catalog.command("create").description("Create a product catalog").requiredOption("--business-id <id>", "Business ID").requiredOption("--name <name>", "Catalog name").option("--vertical <vertical>", "Vertical (commerce, hotels, flights, destinations, home_listings)").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const client = getClient2();
    const body = {
      name: opts.name
    };
    if (opts.vertical) body.vertical = opts.vertical;
    const response = await client.request(`${opts.businessId}/owned_product_catalogs`, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  catalog.command("create-product-set").description("Create a product set within a catalog").requiredOption("--catalog-id <id>", "Catalog ID").requiredOption("--name <name>", "Product set name").option("--filter <json>", "Product filter as JSON").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const client = getClient2();
    const body = {
      name: opts.name
    };
    if (opts.filter) body.filter = opts.filter;
    const response = await client.request(`${opts.catalogId}/product_sets`, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  catalog.command("upload-feed").description("Upload or update a product feed for a catalog").requiredOption("--catalog-id <id>", "Catalog ID").requiredOption("--name <name>", "Feed name").option("--feed-url <url>", "URL to fetch product feed from").option("--schedule <json>", 'Feed schedule as JSON (e.g., {"interval":"HOURLY"})').option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const client = getClient2();
    const body = {
      name: opts.name
    };
    if (opts.feedUrl) body.url = opts.feedUrl;
    if (opts.schedule) body.schedule = opts.schedule;
    const response = await client.request(`${opts.catalogId}/product_feeds`, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  catalog.command("dynamic-template").description("Create a dynamic ad template for product-based ads").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId10()).requiredOption("--name <name>", "Template name").requiredOption("--catalog-id <id>", "Catalog ID").requiredOption("--page-id <id>", "Facebook Page ID").option("--message <text>", "Ad body text (use {{product.name}} for dynamic fields)").option("--headline <text>", "Headline template").option("--description <text>", "Description template").option("--cta <type>", "Call to action", "SHOP_NOW").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const templateData = {
      call_to_action: { type: opts.cta },
      multi_share_end_card: false
    };
    if (opts.message) templateData.message = opts.message;
    if (opts.headline) templateData.name = opts.headline;
    if (opts.description) templateData.description = opts.description;
    const body = {
      name: opts.name,
      object_story_spec: JSON.stringify({
        page_id: opts.pageId,
        template_data: templateData
      })
    };
    const response = await client.request(`${opts.accountId}/adcreatives`, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  catalog.command("collection-ad").description("Create a collection ad with multiple products").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId10()).requiredOption("--campaign-id <id>", "Campaign ID").requiredOption("--adset-id <id>", "Ad set ID").requiredOption("--page-id <id>", "Facebook Page ID").requiredOption("--product-set-id <id>", "Product set ID").option("--name <name>", "Ad name", "Collection Ad").option("--headline <text>", "Collection headline").option("--cta <type>", "Call to action", "SHOP_NOW").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const creativeBody = {
      name: `${opts.name} - Creative`,
      object_story_spec: JSON.stringify({
        page_id: opts.pageId,
        template_data: {
          product_set_id: opts.productSetId,
          call_to_action: { type: opts.cta },
          name: opts.headline || ""
        }
      })
    };
    const creativeResponse = await client.request(`${opts.accountId}/adcreatives`, {
      method: "POST",
      body: creativeBody
    });
    const creativeId = creativeResponse.data.id;
    const adBody = {
      name: opts.name,
      adset_id: opts.adsetId,
      creative: JSON.stringify({ creative_id: creativeId }),
      status: "PAUSED"
    };
    const adResponse = await client.request(`${opts.accountId}/ads`, {
      method: "POST",
      body: adBody
    });
    console.log(formatOutput({
      creative: creativeResponse.data,
      ad: adResponse.data
    }, opts.output));
  }));
  catalog.command("product-performance <catalogId>").description("Get performance metrics for products in a catalog").option("--date-start <date>", "Start date (YYYY-MM-DD)").option("--date-end <date>", "End date (YYYY-MM-DD)").option("--limit <n>", "Max products", "25").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (catalogId, opts) => {
    const client = getClient2();
    const params = {
      fields: "id,name,price,currency,availability,image_url",
      limit: opts.limit
    };
    const productsResponse = await client.request(`${catalogId}/products`, { params });
    const insightParams = {
      fields: "id,name,product_count"
    };
    const catalogResponse = await client.request(catalogId, { params: insightParams });
    console.log(formatOutput({
      catalog: catalogResponse.data,
      products: productsResponse.data
    }, opts.output));
  }));
}

// src/commands/bidding.ts
function registerBiddingCommands(program2, getClient2) {
  const bidding = program2.command("bidding").description("Bid strategy management and analysis");
  bidding.command("validate").description("Validate a bid strategy configuration").requiredOption("--bid-strategy <strategy>", "Bid strategy (LOWEST_COST_WITHOUT_CAP, LOWEST_COST_WITH_BID_CAP, COST_CAP, etc.)").requiredOption("--optimization-goal <goal>", "Optimization goal").requiredOption("--billing-event <event>", "Billing event").option("--target-roas <roas>", "Target ROAS value").option("--target-cost <cost>", "Target cost value").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const validStrategies = [
      "LOWEST_COST_WITHOUT_CAP",
      "LOWEST_COST_WITH_BID_CAP",
      "COST_CAP",
      "LOWEST_COST_WITH_MIN_ROAS",
      "TARGET_COST"
    ];
    const validGoals = [
      "LINK_CLICKS",
      "REACH",
      "CONVERSIONS",
      "APP_INSTALLS",
      "OFFSITE_CONVERSIONS",
      "LANDING_PAGE_VIEWS",
      "IMPRESSIONS",
      "LEAD_GENERATION",
      "VALUE"
    ];
    const validEvents = ["IMPRESSIONS", "LINK_CLICKS", "APP_INSTALLS", "NONE"];
    const result = {
      bid_strategy: opts.bidStrategy,
      optimization_goal: opts.optimizationGoal,
      billing_event: opts.billingEvent,
      valid: true,
      warnings: []
    };
    if (!validStrategies.includes(opts.bidStrategy)) {
      result.valid = false;
      result.warnings.push(`Unknown bid strategy: ${opts.bidStrategy}. Valid: ${validStrategies.join(", ")}`);
    }
    if (!validGoals.includes(opts.optimizationGoal)) {
      result.warnings.push(`Unknown optimization goal: ${opts.optimizationGoal}. Valid: ${validGoals.join(", ")}`);
    }
    if (!validEvents.includes(opts.billingEvent)) {
      result.warnings.push(`Unknown billing event: ${opts.billingEvent}. Valid: ${validEvents.join(", ")}`);
    }
    if (opts.bidStrategy === "LOWEST_COST_WITH_MIN_ROAS" && !opts.targetRoas) {
      result.valid = false;
      result.warnings.push("LOWEST_COST_WITH_MIN_ROAS requires --target-roas");
    }
    console.log(formatOutput(result, opts.output));
  }));
  bidding.command("analyze <adsetIds>").description("Analyze bid performance for ad sets (comma-separated IDs)").option("--time-range <range>", "Time range", "last_7d").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (adsetIds, opts) => {
    const client = getClient2();
    const ids = adsetIds.split(",");
    const results = [];
    for (const id of ids) {
      const params = {
        fields: "id,name,bid_strategy,bid_amount,optimization_goal,billing_event,daily_budget,status"
      };
      const adsetResponse = await client.request(id.trim(), { params });
      const insightParams = {
        fields: "impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,cost_per_action_type"
      };
      const insightsResponse = await client.request(`${id.trim()}/insights`, { params: insightParams });
      results.push({
        adset: adsetResponse.data,
        insights: insightsResponse.data
      });
    }
    console.log(formatOutput(results, opts.output));
  }));
  bidding.command("learning-phase <adsetIds>").description("Monitor learning phase status for ad sets (comma-separated IDs)").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (adsetIds, opts) => {
    const client = getClient2();
    const ids = adsetIds.split(",");
    const results = [];
    for (const id of ids) {
      const params = {
        fields: "id,name,status,bid_strategy,optimization_goal,issues_info"
      };
      const response = await client.request(id.trim(), { params });
      results.push(response.data);
    }
    console.log(formatOutput(results, opts.output));
  }));
  bidding.command("budget-schedule").description("Create a budget schedule for a campaign").requiredOption("--campaign-id <id>", "Campaign ID").requiredOption("--budget-value <value>", "Budget value").requiredOption("--budget-type <type>", "Budget value type (ABSOLUTE, MULTIPLIER)").requiredOption("--time-start <time>", "Schedule start time (ISO 8601)").requiredOption("--time-end <time>", "Schedule end time (ISO 8601)").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const client = getClient2();
    const body = {
      budget_value: opts.budgetValue,
      budget_value_type: opts.budgetType,
      time_start: opts.timeStart,
      time_end: opts.timeEnd
    };
    const response = await client.request(`${opts.campaignId}/budget_schedules`, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  bidding.command("seasonal-schedule").description("Create seasonal bid adjustments for ad sets").requiredOption("--adset-ids <ids>", "Comma-separated ad set IDs").requiredOption("--pattern <pattern>", "Pattern: holiday_boost, weekend_reduction, weekday_focus").requiredOption("--adjustment <pct>", "Adjustment percentage (e.g., 20 for +20%, -15 for -15%)").requiredOption("--start-date <date>", "Start date (YYYY-MM-DD)").requiredOption("--end-date <date>", "End date (YYYY-MM-DD)").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const client = getClient2();
    const ids = opts.adsetIds.split(",").map((id) => id.trim());
    const adjustment = parseFloat(opts.adjustment) / 100;
    const results = [];
    for (const id of ids) {
      const adsetResponse = await client.request(id, {
        params: { fields: "id,name,bid_amount,daily_budget" }
      });
      const adset = adsetResponse.data;
      const currentBudget = parseInt(String(adset.daily_budget || 0));
      if (currentBudget > 0) {
        const adjustedBudget = Math.round(currentBudget * (1 + adjustment));
        results.push({
          adset_id: id,
          adset_name: adset.name,
          current_daily_budget: currentBudget,
          adjusted_daily_budget: adjustedBudget,
          adjustment_pct: opts.adjustment + "%",
          pattern: opts.pattern,
          period: { start: opts.startDate, end: opts.endDate },
          note: 'Use "meta-ads adsets update" to apply adjusted budgets when the seasonal period begins.'
        });
      }
    }
    console.log(formatOutput(results, opts.output));
  }));
  bidding.command("competitor-analysis <campaignId>").description("Analyze competitor bidding landscape via auction insights").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (campaignId, opts) => {
    const client = getClient2();
    const params = {
      fields: "impressions,clicks,spend,cpc,cpm,ctr,reach,frequency"
    };
    const insightsResponse = await client.request(`${campaignId}/insights`, { params });
    const campaignResponse = await client.request(campaignId, {
      params: { fields: "id,name,objective,bid_strategy,daily_budget" }
    });
    const insights = insightsResponse.data.data?.[0] || {};
    const cpm = parseFloat(String(insights.cpm || 0));
    const recommendations = [];
    if (cpm > 15) recommendations.push("High CPM suggests competitive auction \u2014 consider niche targeting");
    if (cpm < 5) recommendations.push("Low CPM suggests opportunity \u2014 consider scaling budget");
    console.log(formatOutput({
      campaign: campaignResponse.data,
      insights,
      bid_landscape: {
        competitiveness: cpm > 15 ? "high" : cpm > 8 ? "moderate" : "low",
        cpm_benchmark: cpm,
        recommendations
      }
    }, opts.output));
  }));
  bidding.command("optimize-budget").description("Get budget allocation recommendations across campaigns").requiredOption("--account-id <id>", "Ad account ID (act_XXX)").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const client = getClient2();
    const insightsParams = {
      fields: "campaign_id,campaign_name,impressions,clicks,spend,cpc,cpm,ctr,actions,cost_per_action_type",
      level: "campaign",
      limit: "50"
    };
    const insightsResponse = await client.request(`${opts.accountId}/insights`, { params: insightsParams });
    const campaigns = insightsResponse.data.data || [];
    const ranked = campaigns.map((c) => ({
      campaign_id: c.campaign_id,
      campaign_name: c.campaign_name,
      spend: parseFloat(String(c.spend || 0)),
      cpc: parseFloat(String(c.cpc || 0)),
      ctr: parseFloat(String(c.ctr || 0)),
      efficiency_score: parseFloat(String(c.ctr || 0)) / Math.max(parseFloat(String(c.cpc || 1)), 0.01)
    })).sort((a, b) => b.efficiency_score - a.efficiency_score);
    const totalSpend = ranked.reduce((s, c) => s + c.spend, 0);
    console.log(formatOutput({
      account_id: opts.accountId,
      total_spend: totalSpend.toFixed(2),
      campaigns_ranked_by_efficiency: ranked.map((c, i) => ({
        rank: i + 1,
        ...c,
        recommendation: i < ranked.length / 3 ? "INCREASE budget" : i > ranked.length * 2 / 3 ? "DECREASE budget" : "MAINTAIN"
      }))
    }, opts.output));
  }));
  bidding.command("recommendations").description("Get personalized bid strategy recommendations based on campaign goals").requiredOption("--objective <objective>", "Campaign objective (OUTCOME_TRAFFIC, OUTCOME_SALES, etc.)").requiredOption("--budget-range <range>", "Budget range (low, medium, high)").requiredOption("--target-metric <metric>", "Target metric (cpc, cpa, roas)").option("--business-type <type>", "Business type (ecommerce, saas, local, agency)", "ecommerce").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const recommendations = {
      objective: opts.objective,
      budget_range: opts.budgetRange,
      target_metric: opts.targetMetric,
      business_type: opts.businessType,
      strategies: []
    };
    const strategies = recommendations.strategies;
    if (opts.targetMetric === "cpc") {
      strategies.push({ strategy: "LOWEST_COST_WITH_BID_CAP", reason: "Best for controlling per-click costs", risk: "low" });
      strategies.push({ strategy: "COST_CAP", reason: "Maintains average cost within target", risk: "medium" });
    } else if (opts.targetMetric === "roas") {
      strategies.push({ strategy: "LOWEST_COST_WITH_MIN_ROAS", reason: "Optimizes for return on ad spend", risk: "medium" });
    } else {
      strategies.push({ strategy: "LOWEST_COST_WITHOUT_CAP", reason: "Maximizes results within budget", risk: "low" });
      strategies.push({ strategy: "COST_CAP", reason: "Keeps cost per action near target", risk: "medium" });
    }
    if (opts.budgetRange === "high") {
      strategies.push({ strategy: "TARGET_COST", reason: "Consistent cost at scale", risk: "high" });
    }
    console.log(formatOutput(recommendations, opts.output));
  }));
  bidding.command("auto-adjustments <adsetIds>").description("Generate automated bid adjustment recommendations (comma-separated IDs)").option("--threshold <value>", "Performance threshold (0.0-1.0)", "0.5").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (adsetIds, opts) => {
    const client = getClient2();
    const ids = adsetIds.split(",").map((id) => id.trim());
    const threshold = parseFloat(opts.threshold);
    const adjustments = [];
    for (const id of ids) {
      const [adset, insights] = await Promise.all([
        client.request(id, { params: { fields: "id,name,bid_amount,bid_strategy,daily_budget,optimization_goal" } }),
        client.request(`${id}/insights`, { params: { fields: "impressions,clicks,spend,cpc,cpm,ctr,actions,cost_per_action_type" } })
      ]);
      const adsetData = adset.data;
      const insightData = insights.data.data?.[0] || {};
      const cpc = parseFloat(String(insightData.cpc || 0));
      const ctr = parseFloat(String(insightData.ctr || 0));
      const currentBid = parseInt(String(adsetData.bid_amount || 0));
      let action = "no_change";
      let newBid = currentBid;
      let reason = "";
      if (ctr > threshold * 2 && cpc < 1) {
        action = "increase_bid";
        newBid = Math.round(currentBid * 1.15);
        reason = "Strong performance \u2014 increase bid to capture more volume";
      } else if (ctr < threshold * 0.5 || cpc > 5) {
        action = "decrease_bid";
        newBid = Math.round(currentBid * 0.85);
        reason = "Poor performance \u2014 decrease bid to reduce waste";
      }
      adjustments.push({
        adset_id: id,
        adset_name: adsetData.name,
        current_bid: currentBid,
        recommended_bid: newBid,
        action,
        reason,
        metrics: { cpc, ctr }
      });
    }
    console.log(formatOutput(adjustments, opts.output));
  }));
  bidding.command("cross-campaign-coordination").description("Coordinate bids across multiple campaigns to avoid overlap").requiredOption("--campaign-ids <ids>", "Comma-separated campaign IDs").option("--strategy <strategy>", "Coordination strategy (balanced, priority, budget_pool)", "balanced").option("--total-budget <cents>", "Total budget pool in cents").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const client = getClient2();
    const ids = opts.campaignIds.split(",").map((id) => id.trim());
    const results = [];
    for (const id of ids) {
      const [campaign, insights] = await Promise.all([
        client.request(id, { params: { fields: "id,name,daily_budget,bid_strategy,objective,status" } }),
        client.request(`${id}/insights`, { params: { fields: "spend,cpc,cpm,ctr,impressions,actions" } })
      ]);
      const insightData = insights.data.data?.[0] || {};
      results.push({ campaign: campaign.data, insights: insightData });
    }
    const ranked = results.map((r, i) => {
      const item = r;
      const insight = item.insights;
      const ctr = parseFloat(String(insight.ctr || 0));
      const cpc = parseFloat(String(insight.cpc || 0));
      return { ...item, efficiency: ctr / Math.max(cpc, 0.01), rank: 0 };
    }).sort((a, b) => b.efficiency - a.efficiency);
    ranked.forEach((r, i) => r.rank = i + 1);
    console.log(formatOutput({
      strategy: opts.strategy,
      campaigns: ranked,
      recommendation: `Allocate more budget to top-ranked campaigns (${opts.strategy} strategy)`
    }, opts.output));
  }));
  bidding.command("scaling-recommendation <campaignId>").description("Get recommendations for scaling campaign budgets").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (campaignId, opts) => {
    const client = getClient2();
    const [campaign, insights] = await Promise.all([
      client.request(campaignId, { params: { fields: "id,name,daily_budget,lifetime_budget,bid_strategy,objective,status" } }),
      client.request(`${campaignId}/insights`, { params: { fields: "impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,cost_per_action_type" } })
    ]);
    const campaignData = campaign.data;
    const insightData = insights.data.data?.[0] || {};
    const currentBudget = parseFloat(String(campaignData.daily_budget || 0));
    const frequency = parseFloat(String(insightData.frequency || 0));
    const ctr = parseFloat(String(insightData.ctr || 0));
    const cpc = parseFloat(String(insightData.cpc || 0));
    let scalingAction = "maintain";
    let suggestedBudget = currentBudget;
    const reasons = [];
    if (frequency < 2 && ctr > 1 && cpc < 2) {
      scalingAction = "scale_up";
      suggestedBudget = Math.round(currentBudget * 1.2);
      reasons.push("Low frequency + strong CTR = room to grow");
    } else if (frequency > 4) {
      scalingAction = "scale_down_or_expand";
      reasons.push("High frequency \u2014 audience saturated");
    } else if (cpc > 5) {
      scalingAction = "optimize_first";
      reasons.push("High CPC \u2014 optimize targeting before scaling");
    } else {
      reasons.push("Performance is stable \u2014 gradual 10-20% increases recommended");
      suggestedBudget = Math.round(currentBudget * 1.1);
    }
    console.log(formatOutput({
      campaign_id: campaignId,
      campaign_name: campaignData.name,
      current_daily_budget: currentBudget,
      suggested_daily_budget: suggestedBudget,
      scaling_action: scalingAction,
      reasons,
      metrics: { frequency, ctr, cpc }
    }, opts.output));
  }));
}

// src/commands/duplication.ts
function registerDuplicationCommands(program2, getClient2) {
  const dup = program2.command("duplicate").alias("dup").description("Campaign, ad set, and ad duplication");
  dup.command("campaign <campaignId>").description("Duplicate a campaign").option("--name-suffix <suffix>", "Suffix for duplicated name", " - Copy").option("--status <status>", "Status for duplicated campaign", "PAUSED").option("--deep-copy", "Include ad sets and ads in duplication").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (campaignId, opts) => {
    const client = getClient2();
    const origParams = {
      fields: "id,name,objective,status,daily_budget,lifetime_budget,bid_strategy,special_ad_categories,buying_type"
    };
    const origResponse = await client.request(campaignId, { params: origParams });
    const original = origResponse.data;
    const accountId = original.id ? String(original.id).split("_")[0] : "";
    const body = {
      name: `${original.name}${opts.nameSuffix}`,
      objective: String(original.objective || ""),
      status: opts.status,
      special_ad_categories: JSON.stringify(original.special_ad_categories || [])
    };
    if (original.daily_budget) body.daily_budget = String(original.daily_budget);
    if (original.lifetime_budget) body.lifetime_budget = String(original.lifetime_budget);
    if (original.bid_strategy) body.bid_strategy = String(original.bid_strategy);
    const copyBody = {
      status_option: opts.status
    };
    if (opts.deepCopy) {
      copyBody.deep_copy = "true";
    }
    const response = await client.request(`${campaignId}/copies`, {
      method: "POST",
      body: copyBody
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  dup.command("adset <adsetId>").description("Duplicate an ad set").option("--campaign-id <id>", "Target campaign ID (default: same campaign)").option("--name-suffix <suffix>", "Suffix for duplicated name", " - Copy").option("--status <status>", "Status for duplicated ad set", "PAUSED").option("--deep-copy", "Include ads in duplication").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (adsetId, opts) => {
    const client = getClient2();
    const copyBody = {
      status_option: opts.status
    };
    if (opts.campaignId) {
      copyBody.campaign_id = opts.campaignId;
    }
    if (opts.deepCopy) {
      copyBody.deep_copy = "true";
    }
    const response = await client.request(`${adsetId}/copies`, {
      method: "POST",
      body: copyBody
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  dup.command("ad <adId>").description("Duplicate an ad").option("--adset-id <id>", "Target ad set ID (default: same ad set)").option("--name-suffix <suffix>", "Suffix for duplicated name", " - Copy").option("--status <status>", "Status for duplicated ad", "PAUSED").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (adId, opts) => {
    const client = getClient2();
    const copyBody = {
      status_option: opts.status
    };
    if (opts.adsetId) {
      copyBody.adset_id = opts.adsetId;
    }
    const response = await client.request(`${adId}/copies`, {
      method: "POST",
      body: copyBody
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  dup.command("creative <creativeId>").description("Duplicate a creative with optional modifications").option("--name-suffix <suffix>", "Suffix for duplicated name", " - Copy").option("--new-headline <text>", "Override headline").option("--new-description <text>", "Override description").option("--new-cta <type>", "Override call-to-action type").option("--new-link-url <url>", "Override destination URL").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (creativeId, opts) => {
    const client = getClient2();
    const origParams = {
      fields: "id,name,object_story_spec,asset_feed_spec,image_hash,call_to_action_type"
    };
    const origResponse = await client.request(creativeId, { params: origParams });
    const original = origResponse.data;
    const body = {};
    body.name = `${original.name || "Creative"}${opts.nameSuffix}`;
    if (original.object_story_spec) {
      const spec = original.object_story_spec;
      if (opts.newHeadline || opts.newDescription || opts.newCta || opts.newLinkUrl) {
        const linkData = spec.link_data || {};
        if (opts.newHeadline) linkData.name = opts.newHeadline;
        if (opts.newDescription) linkData.description = opts.newDescription;
        if (opts.newLinkUrl) linkData.link = opts.newLinkUrl;
        if (opts.newCta) linkData.call_to_action = { type: opts.newCta };
        spec.link_data = linkData;
      }
      body.object_story_spec = JSON.stringify(spec);
    }
    const accountId = process.env.META_ADS_CLI_ACCOUNT_ID;
    if (!accountId) {
      throw new Error("Account ID required for creative duplication. Set META_ADS_CLI_ACCOUNT_ID");
    }
    const response = await client.request(`${accountId}/adcreatives`, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
}

// src/commands/ads-library.ts
function registerAdsLibraryCommands(program2, getClient2) {
  const library = program2.command("library").description("Meta Ads Library search and analysis");
  library.command("search").description("Search the Meta Ads Library").requiredOption("--query <query>", "Search query").option("--country <code>", "Country code (e.g., US, GB)", "US").option("--ad-type <type>", "Ad type: ALL, POLITICAL_AND_ISSUE_ADS, HOUSING_ADS, etc.", "ALL").option("--platform <platform>", "Platform: FACEBOOK, INSTAGRAM, AUDIENCE_NETWORK, MESSENGER").option("--active-status <status>", "Status: ALL, ACTIVE, INACTIVE", "ALL").option("--page-id <id>", "Filter by specific page ID").option("--limit <n>", "Maximum results", "25").option("--all", "Fetch all pages").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const client = getClient2();
    const params = {
      search_terms: opts.query,
      ad_reached_countries: JSON.stringify([opts.country]),
      ad_type: opts.adType,
      ad_active_status: opts.activeStatus,
      fields: "id,ad_creation_time,ad_creative_bodies,ad_creative_link_captions,ad_creative_link_descriptions,ad_creative_link_titles,ad_delivery_start_time,ad_delivery_stop_time,ad_snapshot_url,currency_lower_bound,currency_upper_bound,impressions,page_id,page_name,publisher_platforms,spend",
      limit: opts.limit
    };
    if (opts.platform) {
      params.publisher_platform = opts.platform;
    }
    if (opts.pageId) {
      params.search_page_ids = JSON.stringify([opts.pageId]);
    }
    const endpoint = "ads_archive";
    const response = opts.all ? await client.requestAllPages(endpoint, { params }) : await client.request(endpoint, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  library.command("page-ads <pageId>").description("Get all ads for a specific page").option("--country <code>", "Country code", "US").option("--active-status <status>", "Status: ALL, ACTIVE, INACTIVE", "ACTIVE").option("--limit <n>", "Maximum results", "25").option("--all", "Fetch all pages").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (pageId, opts) => {
    const client = getClient2();
    const params = {
      search_page_ids: JSON.stringify([pageId]),
      ad_reached_countries: JSON.stringify([opts.country]),
      ad_type: "ALL",
      ad_active_status: opts.activeStatus,
      fields: "id,ad_creation_time,ad_creative_bodies,ad_creative_link_titles,ad_delivery_start_time,ad_snapshot_url,page_name,publisher_platforms,spend",
      limit: opts.limit
    };
    const endpoint = "ads_archive";
    const response = opts.all ? await client.requestAllPages(endpoint, { params }) : await client.request(endpoint, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  library.command("batch-search").description("Search Ads Library for multiple brands in parallel").requiredOption("--brands <json>", "JSON array of {query, page_id?} objects").option("--country <code>", "Country code", "US").option("--limit <n>", "Max results per brand", "10").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const client = getClient2();
    const brands = JSON.parse(opts.brands);
    const results = [];
    for (const brand of brands) {
      const params = {
        ad_reached_countries: JSON.stringify([opts.country]),
        ad_type: "ALL",
        ad_active_status: "ACTIVE",
        fields: "id,ad_creation_time,ad_creative_bodies,ad_creative_link_titles,page_name,publisher_platforms,spend",
        limit: opts.limit
      };
      if (brand.page_id) {
        params.search_page_ids = JSON.stringify([brand.page_id]);
      } else {
        params.search_terms = brand.query;
      }
      const response = await client.request("ads_archive", { params });
      const ads = response.data.data || [];
      results.push({
        brand: brand.query || brand.page_id,
        ads_found: ads.length,
        ads: ads.slice(0, parseInt(opts.limit))
      });
    }
    console.log(formatOutput(results, opts.output));
  }));
}

// src/commands/conversions.ts
function getDefaultAccountId11() {
  return process.env.META_ADS_CLI_ACCOUNT_ID || "";
}
function registerConversionCommands(program2, getClient2) {
  const conversions = program2.command("conversions").alias("conv").description("Conversions API and server-side tracking");
  conversions.command("send-event").description("Send a server-side conversion event via the Conversions API").requiredOption("--pixel-id <id>", "Meta Pixel ID").requiredOption("--event-name <name>", "Event name (Purchase, Lead, CompleteRegistration, AddToCart, ViewContent, etc.)").option("--event-time <timestamp>", "Unix timestamp (defaults to now)").option("--user-data <json>", "User data JSON (em, ph, external_id, client_ip_address, fbp, fbc)").option("--custom-data <json>", "Custom data JSON (value, currency, content_ids, content_type, num_items)").option("--event-source-url <url>", "URL where event occurred").option("--action-source <source>", "Action source (website, email, phone_call, chat, other)", "website").option("--test-event-code <code>", "Test event code from Events Manager (for debugging)").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const client = getClient2();
    const eventData = {
      event_name: opts.eventName,
      event_time: opts.eventTime ? parseInt(opts.eventTime) : Math.floor(Date.now() / 1e3),
      action_source: opts.actionSource
    };
    if (opts.userData) eventData.user_data = JSON.parse(opts.userData);
    if (opts.customData) eventData.custom_data = JSON.parse(opts.customData);
    if (opts.eventSourceUrl) eventData.event_source_url = opts.eventSourceUrl;
    const body = {
      data: JSON.stringify([eventData])
    };
    if (opts.testEventCode) body.test_event_code = opts.testEventCode;
    const response = await client.request(`${opts.pixelId}/events`, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  conversions.command("custom-conversions").description("List custom conversions for an account").option("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId11()).option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const params = {
      fields: "id,name,description,pixel,custom_event_type,default_conversion_value,rule,creation_time"
    };
    const response = await client.request(`${opts.accountId}/customconversions`, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  conversions.command("create-custom").description("Create a custom conversion event").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId11()).requiredOption("--name <name>", "Custom conversion name").requiredOption("--pixel-id <id>", "Pixel ID").requiredOption("--rule <json>", "Conversion rule as JSON").option("--event-type <type>", "Custom event type (e.g., PURCHASE, LEAD)").option("--default-value <value>", "Default conversion value").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const body = {
      name: opts.name,
      pixel: opts.pixelId,
      rule: opts.rule
    };
    if (opts.eventType) body.custom_event_type = opts.eventType;
    if (opts.defaultValue) body.default_conversion_value = opts.defaultValue;
    const response = await client.request(`${opts.accountId}/customconversions`, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  conversions.command("setup-tracking").description("Setup conversion tracking for an account").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId11()).requiredOption("--pixel-id <id>", "Pixel ID to configure").option("--first-party-cookies", "Enable first-party cookies").option("--automatic-matching", "Enable automatic advanced matching").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const body = {};
    if (opts.firstPartyCookies) body.first_party_cookies_enabled = "true";
    if (opts.automaticMatching) body.automatic_matching_enabled = "true";
    const response = await client.request(opts.pixelId, {
      method: "POST",
      body
    });
    console.log(formatOutput(response.data, opts.output));
  }));
  conversions.command("validate-setup <pixelId>").description("Validate conversion tracking setup for a pixel").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (pixelId, opts) => {
    const client = getClient2();
    const pixelParams = {
      fields: "id,name,code,creation_time,data_use_setting,last_fired_time,is_created_by_app"
    };
    const pixelResponse = await client.request(pixelId, { params: pixelParams });
    const statsResponse = await client.request(`${pixelId}/stats`, {
      params: { fields: "data" }
    });
    const result = {
      pixel: pixelResponse.data,
      stats: statsResponse.data,
      validation: {
        pixel_exists: true,
        has_recent_activity: !!pixelResponse.data.last_fired_time
      }
    };
    console.log(formatOutput(result, opts.output));
  }));
}

// src/commands/retargeting.ts
function getDefaultAccountId12() {
  return process.env.META_ADS_CLI_ACCOUNT_ID || "";
}
function registerRetargetingCommands(program2, getClient2) {
  const retargeting = program2.command("retargeting").alias("retar").description("Advanced retargeting audience and campaign strategies");
  retargeting.command("website-behavior").description("Create website behavior-based retargeting audience").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId12()).requiredOption("--pixel-id <id>", "Meta Pixel ID").requiredOption("--name <name>", "Audience name").option("--retention-days <days>", "Days to retain users (1-180)", "30").option("--rule <json>", "Custom audience rule as JSON").option("--url-contains <url>", "URL contains filter").option("--exclude-converters", "Exclude users who have converted").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const rule = opts.rule ? opts.rule : JSON.stringify({
      inclusions: {
        operator: "or",
        rules: [{
          event_sources: [{ id: opts.pixelId, type: "pixel" }],
          retention_seconds: parseInt(opts.retentionDays) * 86400,
          filter: opts.urlContains ? {
            operator: "and",
            filters: [{ field: "url", operator: "i_contains", value: opts.urlContains }]
          } : { operator: "and", filters: [{ field: "event", operator: "eq", value: "PageView" }] }
        }]
      }
    });
    const body = {
      name: opts.name,
      subtype: "WEBSITE",
      retention_days: opts.retentionDays,
      rule,
      pixel_id: opts.pixelId
    };
    const response = await client.request(`${opts.accountId}/customaudiences`, { method: "POST", body });
    console.log(formatOutput(response.data, opts.output));
  }));
  retargeting.command("video-engagement").description("Create video engagement retargeting audience").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId12()).requiredOption("--name <name>", "Audience name").option("--video-ids <ids>", "Comma-separated video IDs").option("--engagement-type <type>", "Engagement: video_watched, video_completed, thruplayed", "video_watched").option("--retention-days <days>", "Retention days", "30").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const body = {
      name: opts.name,
      subtype: "ENGAGEMENT",
      description: `Video engagement audience: ${opts.engagementType}`,
      retention_days: opts.retentionDays
    };
    if (opts.videoIds) {
      const rule = {
        inclusions: {
          operator: "or",
          rules: [{
            object_id: opts.videoIds.split(","),
            event_sources: [{ type: "video" }]
          }]
        }
      };
      body.rule = JSON.stringify(rule);
    }
    const response = await client.request(`${opts.accountId}/customaudiences`, { method: "POST", body });
    console.log(formatOutput(response.data, opts.output));
  }));
  retargeting.command("app-event").description("Create app event retargeting audience").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId12()).requiredOption("--name <name>", "Audience name").requiredOption("--app-id <id>", "App ID").option("--event-name <event>", "App event to target").option("--retention-days <days>", "Retention days", "30").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const rule = {
      inclusions: {
        operator: "or",
        rules: [{
          event_sources: [{ id: opts.appId, type: "app" }],
          retention_seconds: parseInt(opts.retentionDays) * 86400
        }]
      }
    };
    if (opts.eventName) {
      rule.inclusions.rules[0] = {
        ...rule.inclusions.rules[0],
        filter: { operator: "and", filters: [{ field: "event", operator: "eq", value: opts.eventName }] }
      };
    }
    const body = {
      name: opts.name,
      subtype: "APP",
      retention_days: opts.retentionDays,
      rule: JSON.stringify(rule)
    };
    const response = await client.request(`${opts.accountId}/customaudiences`, { method: "POST", body });
    console.log(formatOutput(response.data, opts.output));
  }));
  retargeting.command("product").description("Create product retargeting audience from catalog").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId12()).requiredOption("--name <name>", "Audience name").requiredOption("--product-set-id <id>", "Product set ID").option("--event-type <type>", "Event: ViewContent, AddToCart, Purchase", "ViewContent").option("--retention-days <days>", "Retention days", "14").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const body = {
      name: opts.name,
      subtype: "CUSTOM",
      description: `Product retargeting: ${opts.eventType}`,
      product_set_id: opts.productSetId,
      retention_days: opts.retentionDays
    };
    const response = await client.request(`${opts.accountId}/customaudiences`, { method: "POST", body });
    console.log(formatOutput(response.data, opts.output));
  }));
  retargeting.command("funnel").description("Create multi-stage retargeting funnel (awareness \u2192 consideration \u2192 conversion)").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId12()).requiredOption("--pixel-id <id>", "Meta Pixel ID").requiredOption("--funnel-name <name>", "Funnel name prefix").option("--stages <json>", "Funnel stages config as JSON array", '[{"name":"Visitors","event":"PageView","retention":30},{"name":"Engaged","event":"ViewContent","retention":14},{"name":"Cart","event":"AddToCart","retention":7}]').option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const stages = JSON.parse(opts.stages);
    const results = [];
    for (const stage of stages) {
      const rule = {
        inclusions: {
          operator: "or",
          rules: [{
            event_sources: [{ id: opts.pixelId, type: "pixel" }],
            retention_seconds: stage.retention * 86400,
            filter: { operator: "and", filters: [{ field: "event", operator: "eq", value: stage.event }] }
          }]
        }
      };
      const body = {
        name: `${opts.funnelName} - ${stage.name}`,
        subtype: "WEBSITE",
        retention_days: String(stage.retention),
        rule: JSON.stringify(rule),
        pixel_id: opts.pixelId
      };
      const response = await client.request(`${opts.accountId}/customaudiences`, { method: "POST", body });
      results.push({ stage: stage.name, ...response.data });
    }
    console.log(formatOutput(results, opts.output));
  }));
  retargeting.command("dynamic-campaign").description("Setup a dynamic retargeting campaign with catalog products").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId12()).requiredOption("--campaign-name <name>", "Campaign name").requiredOption("--product-set-id <id>", "Product set ID").requiredOption("--page-id <id>", "Facebook Page ID").option("--daily-budget <cents>", "Daily budget in cents", "5000").option("--objective <obj>", "Campaign objective", "OUTCOME_SALES").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const campBody = {
      name: opts.campaignName,
      objective: opts.objective,
      status: "PAUSED",
      daily_budget: opts.dailyBudget,
      special_ad_categories: "[]"
    };
    const campResponse = await client.request(`${opts.accountId}/campaigns`, { method: "POST", body: campBody });
    const campaignId = campResponse.data.id;
    const adsetBody = {
      campaign_id: campaignId,
      name: `${opts.campaignName} - Dynamic Retargeting`,
      optimization_goal: "OFFSITE_CONVERSIONS",
      billing_event: "IMPRESSIONS",
      status: "PAUSED",
      daily_budget: opts.dailyBudget,
      promoted_object: JSON.stringify({ product_set_id: opts.productSetId }),
      is_dynamic_creative: "false"
    };
    const adsetResponse = await client.request(`${opts.accountId}/adsets`, { method: "POST", body: adsetBody });
    console.log(formatOutput({
      campaign: campResponse.data,
      adset: adsetResponse.data,
      note: "Dynamic retargeting campaign created. Add creatives and activate when ready."
    }, opts.output));
  }));
  retargeting.command("frequency-optimization").description("Setup frequency capping for retargeting campaigns").requiredOption("--adset-id <id>", "Ad set ID").option("--max-impressions <n>", "Max impressions per user", "3").option("--interval-days <days>", "Frequency cap interval in days", "7").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (adsetId, opts) => {
    const client = getClient2();
    const frequencyControlSpecs = [{
      event: "IMPRESSIONS",
      interval_days: parseInt(opts.intervalDays),
      max_frequency: parseInt(opts.maxImpressions)
    }];
    const body = {
      frequency_control_specs: JSON.stringify(frequencyControlSpecs)
    };
    const response = await client.request(adsetId, { method: "POST", body });
    console.log(formatOutput(response.data, opts.output));
  }));
}

// src/commands/ab-testing.ts
function getDefaultAccountId13() {
  return process.env.META_ADS_CLI_ACCOUNT_ID || "";
}
function registerAbTestingCommands(program2, getClient2) {
  const abtest = program2.command("ab-test").description("A/B testing for bid strategies and creatives");
  abtest.command("create").description("Create an A/B test by duplicating a campaign with different bid strategies").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId13()).requiredOption("--name <name>", "Test name").requiredOption("--campaign-id <id>", "Base campaign ID to duplicate").requiredOption("--variant-bid-strategy <strategy>", "Bid strategy for variant B").option("--budget-split <ratio>", "Budget split for variant A (0.0-1.0)", "0.5").option("--variant-bid-amount <cents>", "Bid amount for variant B").option("--duration-days <days>", "Test duration in days", "14").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const origParams = {
      fields: "id,name,objective,status,daily_budget,lifetime_budget,bid_strategy,special_ad_categories"
    };
    const origResponse = await client.request(opts.campaignId, { params: origParams });
    const original = origResponse.data;
    const totalBudget = parseInt(String(original.daily_budget || 1e4));
    const split = parseFloat(opts.budgetSplit);
    const controlBody = {
      status_option: "PAUSED"
    };
    const controlResponse = await client.request(`${opts.campaignId}/copies`, {
      method: "POST",
      body: controlBody
    });
    const variantCopyResponse = await client.request(`${opts.campaignId}/copies`, {
      method: "POST",
      body: { status_option: "PAUSED" }
    });
    const variantId = variantCopyResponse.data.copied_campaign_id || variantCopyResponse.data.id;
    if (variantId) {
      const updateBody = {
        name: `${opts.name} - Variant B (${opts.variantBidStrategy})`,
        bid_strategy: opts.variantBidStrategy,
        daily_budget: String(Math.round(totalBudget * (1 - split)))
      };
      if (opts.variantBidAmount) updateBody.bid_cap = opts.variantBidAmount;
      await client.request(variantId, { method: "POST", body: updateBody });
    }
    console.log(formatOutput({
      test_name: opts.name,
      control: controlResponse.data,
      variant: variantCopyResponse.data,
      budget_split: { control: `${split * 100}%`, variant: `${(1 - split) * 100}%` },
      duration_days: parseInt(opts.durationDays),
      note: "Both campaigns created as PAUSED. Activate both when ready to start the test."
    }, opts.output));
  }));
  abtest.command("analyze <campaignIdA> <campaignIdB>").description("Analyze A/B test results by comparing two campaigns").option("--time-range <range>", "Time range for comparison", "last_7d").option("--metrics <fields>", "Metrics to compare", "impressions,clicks,spend,cpc,cpm,ctr,conversions,cost_per_action_type").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (campaignIdA, campaignIdB, opts) => {
    const client = getClient2();
    const insightFields = opts.metrics;
    const [insightsA, insightsB] = await Promise.all([
      client.request(`${campaignIdA}/insights`, { params: { fields: insightFields } }),
      client.request(`${campaignIdB}/insights`, { params: { fields: insightFields } })
    ]);
    const [campaignA, campaignB] = await Promise.all([
      client.request(campaignIdA, { params: { fields: "id,name,bid_strategy,daily_budget,status" } }),
      client.request(campaignIdB, { params: { fields: "id,name,bid_strategy,daily_budget,status" } })
    ]);
    const dataA = insightsA.data.data?.[0] || {};
    const dataB = insightsB.data.data?.[0] || {};
    const comparison = {};
    for (const metric of ["cpc", "cpm", "ctr", "spend"]) {
      const valA = parseFloat(String(dataA[metric] || 0));
      const valB = parseFloat(String(dataB[metric] || 0));
      const lowerIsBetter = metric !== "ctr";
      const winner = lowerIsBetter ? valA < valB ? "A" : valA > valB ? "B" : "tie" : valA > valB ? "A" : valA < valB ? "B" : "tie";
      comparison[metric] = { a: valA, b: valB, winner, diff_pct: valA ? ((valB - valA) / valA * 100).toFixed(1) + "%" : "N/A" };
    }
    console.log(formatOutput({
      campaign_a: campaignA.data,
      campaign_b: campaignB.data,
      insights_a: dataA,
      insights_b: dataB,
      comparison
    }, opts.output));
  }));
}

// src/commands/analytics.ts
function getDefaultAccountId14() {
  return process.env.META_ADS_CLI_ACCOUNT_ID || "";
}
function registerAnalyticsCommands(program2, getClient2) {
  const analytics = program2.command("analytics").description("Advanced performance analytics and trend analysis");
  analytics.command("trends <objectId>").description("Analyze performance trends over time for a campaign/adset/ad").option("--days <n>", "Number of days to analyze", "30").option("--metrics <fields>", "Metrics to track", "impressions,clicks,spend,cpc,cpm,ctr,actions").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (objectId, opts) => {
    const client = getClient2();
    const now = /* @__PURE__ */ new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - parseInt(opts.days));
    const params = {
      fields: opts.metrics,
      time_range: JSON.stringify({
        since: start.toISOString().slice(0, 10),
        until: now.toISOString().slice(0, 10)
      }),
      time_increment: "1"
      // Daily breakdown
    };
    const response = await client.request(`${objectId}/insights`, { params });
    const data = response.data.data || [];
    if (data.length >= 2) {
      const first = data[0];
      const last = data[data.length - 1];
      const trendAnalysis = {};
      for (const metric of ["spend", "cpc", "cpm", "ctr"]) {
        const valFirst = parseFloat(String(first[metric] || 0));
        const valLast = parseFloat(String(last[metric] || 0));
        if (valFirst > 0) {
          const change = (valLast - valFirst) / valFirst * 100;
          trendAnalysis[metric] = {
            start: valFirst,
            end: valLast,
            change_pct: change.toFixed(1) + "%",
            direction: change > 5 ? "increasing" : change < -5 ? "decreasing" : "stable"
          };
        }
      }
      console.log(formatOutput({
        daily_data: data,
        trend_analysis: trendAnalysis,
        period: { start: start.toISOString().slice(0, 10), end: now.toISOString().slice(0, 10) }
      }, opts.output));
    } else {
      console.log(formatOutput(response.data, opts.output));
    }
  }));
  analytics.command("creative-fatigue <adId>").description("Detect creative fatigue by analyzing CTR/frequency degradation").option("--days <n>", "Days to analyze", "14").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (adId, opts) => {
    const client = getClient2();
    const now = /* @__PURE__ */ new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - parseInt(opts.days));
    const params = {
      fields: "impressions,clicks,ctr,frequency,reach,spend,date_start,date_stop",
      time_range: JSON.stringify({
        since: start.toISOString().slice(0, 10),
        until: now.toISOString().slice(0, 10)
      }),
      time_increment: "1"
    };
    const response = await client.request(`${adId}/insights`, { params });
    const dailyData = response.data.data || [];
    let fatigueDetected = false;
    let fatigueSignals = [];
    if (dailyData.length >= 3) {
      const firstHalf = dailyData.slice(0, Math.floor(dailyData.length / 2));
      const secondHalf = dailyData.slice(Math.floor(dailyData.length / 2));
      const avgCtrFirst = firstHalf.reduce((s, d) => s + parseFloat(String(d.ctr || 0)), 0) / firstHalf.length;
      const avgCtrSecond = secondHalf.reduce((s, d) => s + parseFloat(String(d.ctr || 0)), 0) / secondHalf.length;
      const avgFreqLast = parseFloat(String(dailyData[dailyData.length - 1].frequency || 0));
      if (avgCtrSecond < avgCtrFirst * 0.8) {
        fatigueDetected = true;
        fatigueSignals.push(`CTR declined ${((1 - avgCtrSecond / avgCtrFirst) * 100).toFixed(0)}% in second half`);
      }
      if (avgFreqLast > 3) {
        fatigueDetected = true;
        fatigueSignals.push(`High frequency: ${avgFreqLast.toFixed(1)} (>3.0 threshold)`);
      }
    }
    console.log(formatOutput({
      ad_id: adId,
      fatigue_detected: fatigueDetected,
      fatigue_signals: fatigueSignals,
      recommendation: fatigueDetected ? "Consider refreshing creative or expanding audience to reduce frequency" : "No significant fatigue detected",
      daily_data: dailyData
    }, opts.output));
  }));
  analytics.command("competitive-intel").description("Get competitive intelligence from Ads Library tracking").requiredOption("--page-ids <ids>", "Comma-separated competitor page IDs").option("--country <code>", "Country code", "US").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const client = getClient2();
    const pageIds = opts.pageIds.split(",");
    const results = [];
    for (const pageId of pageIds) {
      const params = {
        search_page_ids: JSON.stringify([pageId.trim()]),
        ad_reached_countries: JSON.stringify([opts.country]),
        ad_type: "ALL",
        ad_active_status: "ACTIVE",
        fields: "id,ad_creation_time,ad_creative_bodies,ad_creative_link_titles,ad_delivery_start_time,page_name,publisher_platforms,spend",
        limit: "25"
      };
      const response = await client.request("ads_archive", { params });
      const ads = response.data.data || [];
      results.push({
        page_id: pageId.trim(),
        active_ads_count: ads.length,
        ads: ads.slice(0, 10)
        // Top 10
      });
    }
    console.log(formatOutput(results, opts.output));
  }));
  analytics.command("report").description("Generate a performance summary report").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId14()).option("--time-range <range>", "Time range", "last_30d").option("--level <level>", "Report level: account, campaign", "campaign").option("--breakdowns <dims>", "Breakdown dimensions (age, gender, country)").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const params = {
      fields: "campaign_name,impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,conversions,cost_per_action_type",
      level: opts.level,
      limit: "100"
    };
    if (opts.breakdowns) params.breakdowns = opts.breakdowns;
    const response = await client.request(`${opts.accountId}/insights`, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
  analytics.command("optimization-insights").description("Get meta-cognition insights from past optimization patterns").option("--resource-type <type>", "Resource type: campaign, adset, ad").option("--resource-id <id>", "Specific resource ID").option("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId14()).option("--days <n>", "Days to analyze", "30").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const client = getClient2();
    const entityId = opts.resourceId || opts.accountId;
    if (!entityId) throw new Error("Either --resource-id or --account-id required");
    const now = /* @__PURE__ */ new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - parseInt(opts.days));
    const params = {
      fields: "impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,date_start,date_stop",
      time_range: JSON.stringify({
        since: start.toISOString().slice(0, 10),
        until: now.toISOString().slice(0, 10)
      }),
      time_increment: "1",
      level: opts.resourceType || "campaign"
    };
    const response = await client.request(`${entityId}/insights`, { params });
    const dailyData = response.data.data || [];
    const insights = {
      total_data_points: dailyData.length,
      patterns: []
    };
    if (dailyData.length >= 7) {
      const dowSpend = {};
      for (const d of dailyData) {
        const dow = new Date(String(d.date_start)).getDay();
        if (!dowSpend[dow]) dowSpend[dow] = [];
        dowSpend[dow].push(parseFloat(String(d.spend || 0)));
      }
      const dowAvg = Object.entries(dowSpend).map(([dow, vals]) => ({
        day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parseInt(dow)],
        avg_spend: (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)
      }));
      insights.day_of_week_spend = dowAvg;
      const firstWeek = dailyData.slice(0, 7);
      const lastWeek = dailyData.slice(-7);
      const avgCtrFirst = firstWeek.reduce((s, d) => s + parseFloat(String(d.ctr || 0)), 0) / 7;
      const avgCtrLast = lastWeek.reduce((s, d) => s + parseFloat(String(d.ctr || 0)), 0) / 7;
      if (avgCtrLast > avgCtrFirst * 1.1) {
        insights.patterns.push("CTR is improving over time");
      } else if (avgCtrLast < avgCtrFirst * 0.9) {
        insights.patterns.push("CTR is declining \u2014 consider creative refresh");
      }
    }
    console.log(formatOutput(insights, opts.output));
  }));
}

// src/commands/ai.ts
function getDefaultAccountId15() {
  return process.env.META_ADS_CLI_ACCOUNT_ID || "";
}
function registerAiCommands(program2, getClient2) {
  const ai = program2.command("ai").description("AI-powered performance scoring, anomaly detection, and recommendations");
  ai.command("score <entityId>").description("Get AI-powered performance score for a campaign, ad set, or ad").requiredOption("--type <type>", "Entity type: campaign, adset, ad").option("--time-range <range>", "Time range for analysis", "last_7d").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (entityId, opts) => {
    const client = getClient2();
    const insightsParams = {
      fields: "impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,conversions,cost_per_action_type"
    };
    const insightsResponse = await client.request(`${entityId}/insights`, { params: insightsParams });
    const insights = insightsResponse.data.data?.[0] || {};
    const impressions = parseFloat(String(insights.impressions || 0));
    const clicks = parseFloat(String(insights.clicks || 0));
    const spend = parseFloat(String(insights.spend || 0));
    const ctr = parseFloat(String(insights.ctr || 0));
    const cpc = parseFloat(String(insights.cpc || 0));
    const frequency = parseFloat(String(insights.frequency || 0));
    const efficiencyScore = Math.min(100, ctr > 0 ? ctr * 20 : 0);
    const engagementScore = Math.min(100, clicks > 0 ? Math.log10(clicks) * 25 : 0);
    const costScore = cpc > 0 ? Math.max(0, 100 - cpc * 10) : 50;
    const reachScore = Math.min(100, impressions > 0 ? Math.log10(impressions) * 15 : 0);
    const frequencyPenalty = frequency > 3 ? (frequency - 3) * 10 : 0;
    const overallScore = Math.max(0, Math.min(
      100,
      efficiencyScore * 0.3 + engagementScore * 0.2 + costScore * 0.25 + reachScore * 0.15 + 10 - frequencyPenalty
    ));
    const recommendations = [];
    if (ctr < 1) recommendations.push("Low CTR \u2014 test new creative or refine targeting");
    if (frequency > 3) recommendations.push("High frequency \u2014 expand audience or refresh creative");
    if (cpc > 2) recommendations.push("High CPC \u2014 consider lowering bids or optimizing for cheaper actions");
    if (impressions < 1e3) recommendations.push("Low delivery \u2014 increase budget or broaden targeting");
    console.log(formatOutput({
      entity_id: entityId,
      entity_type: opts.type,
      overall_score: Math.round(overallScore),
      component_scores: {
        efficiency: Math.round(efficiencyScore),
        engagement: Math.round(engagementScore),
        cost_effectiveness: Math.round(costScore),
        reach: Math.round(reachScore)
      },
      trend_direction: overallScore > 60 ? "good" : overallScore > 40 ? "needs_attention" : "poor",
      recommendations,
      insights
    }, opts.output));
  }));
  ai.command("anomalies <entityId>").description("Detect performance anomalies using statistical analysis").requiredOption("--type <type>", "Entity type: campaign, adset, ad").option("--sensitivity <level>", "Sensitivity (0.0-1.0, higher = more alerts)", "0.8").option("--days <n>", "Days of data to analyze", "14").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (entityId, opts) => {
    const client = getClient2();
    const now = /* @__PURE__ */ new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - parseInt(opts.days));
    const params = {
      fields: "impressions,clicks,spend,cpc,cpm,ctr,date_start,date_stop",
      time_range: JSON.stringify({
        since: start.toISOString().slice(0, 10),
        until: now.toISOString().slice(0, 10)
      }),
      time_increment: "1"
    };
    const response = await client.request(`${entityId}/insights`, { params });
    const dailyData = response.data.data || [];
    const anomalies = [];
    const sensitivity = parseFloat(opts.sensitivity);
    for (const metric of ["spend", "cpc", "ctr", "impressions"]) {
      const values = dailyData.map((d) => parseFloat(String(d[metric] || 0)));
      if (values.length < 3) continue;
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const stdDev = Math.sqrt(values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length);
      const threshold = stdDev * (2 - sensitivity);
      for (let i = 0; i < values.length; i++) {
        if (Math.abs(values[i] - mean) > threshold && threshold > 0) {
          anomalies.push({
            date: dailyData[i].date_start,
            metric,
            value: values[i],
            expected: mean.toFixed(2),
            deviation: ((values[i] - mean) / stdDev).toFixed(1) + " std devs",
            type: values[i] > mean ? "spike" : "drop"
          });
        }
      }
    }
    console.log(formatOutput({
      entity_id: entityId,
      anomalies_detected: anomalies.length,
      anomalies,
      analysis_period: { days: parseInt(opts.days), data_points: dailyData.length }
    }, opts.output));
  }));
  ai.command("recommendations").description("Get AI-powered optimization recommendations for an account").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId15()).option("--type <type>", "Recommendation type: performance, budget, creative, audience", "performance").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const campaignParams = {
      fields: "id,name,objective,status,daily_budget,bid_strategy",
      effective_status: JSON.stringify(["ACTIVE"]),
      limit: "50"
    };
    const campaignsResponse = await client.request(`${opts.accountId}/campaigns`, { params: campaignParams });
    const campaigns = campaignsResponse.data.data || [];
    const recommendations = [];
    for (const campaign of campaigns.slice(0, 10)) {
      const insightParams = {
        fields: "impressions,clicks,spend,cpc,cpm,ctr,frequency,actions"
      };
      const insightResponse = await client.request(`${campaign.id}/insights`, { params: insightParams });
      const insight = insightResponse.data.data?.[0] || {};
      const ctr = parseFloat(String(insight.ctr || 0));
      const cpc = parseFloat(String(insight.cpc || 0));
      const frequency = parseFloat(String(insight.frequency || 0));
      const recs = [];
      if (ctr < 0.5) recs.push("Very low CTR \u2014 consider testing new ad creatives");
      if (cpc > 5) recs.push("High CPC \u2014 try broader targeting or lower-funnel optimization");
      if (frequency > 4) recs.push("High frequency \u2014 audience may be saturated");
      if (!campaign.bid_strategy || campaign.bid_strategy === "LOWEST_COST_WITHOUT_CAP") {
        recs.push("No bid cap \u2014 consider COST_CAP for better cost control");
      }
      if (recs.length > 0) {
        recommendations.push({
          campaign_id: campaign.id,
          campaign_name: campaign.name,
          recommendations: recs,
          metrics: { ctr, cpc, frequency }
        });
      }
    }
    console.log(formatOutput({
      account_id: opts.accountId,
      recommendation_type: opts.type,
      total_campaigns_analyzed: campaigns.length,
      recommendations
    }, opts.output));
  }));
  ai.command("export-dataset").description("Export ML-ready dataset for external analysis").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId15()).option("--data-type <type>", "Data type: performance, audience, creative", "performance").option("--time-range <range>", "Time range", "last_30d").option("--level <level>", "Granularity: campaign, adset, ad", "ad").option("-o, --output <format>", "Output format", "csv").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const params = {
      fields: "campaign_name,campaign_id,adset_name,adset_id,ad_name,ad_id,impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,conversions,cost_per_action_type,date_start,date_stop",
      level: opts.level,
      limit: "500",
      time_increment: "1"
    };
    const response = await client.requestAllPages(`${opts.accountId}/insights`, { params }, 10);
    console.log(formatOutput(response.data, opts.output));
  }));
}

// src/commands/bulk.ts
function getDefaultAccountId16() {
  return process.env.META_ADS_CLI_ACCOUNT_ID || "";
}
function sleep2(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function registerBulkCommands(program2, getClient2) {
  const bulk = program2.command("bulk").description("Bulk operations for campaigns, creatives, and optimization");
  bulk.command("create-campaigns").description("Create multiple campaigns from a JSON config").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId16()).requiredOption("--config <json>", "JSON array of campaign configs").option("--batch-size <n>", "Campaigns per batch", "5").option("--delay-ms <ms>", "Delay between batches", "2000").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const campaigns = JSON.parse(opts.config);
    const batchSize = parseInt(opts.batchSize);
    const delayMs = parseInt(opts.delayMs);
    const results = { created: [], failed: [] };
    for (let i = 0; i < campaigns.length; i += batchSize) {
      if (i > 0) await sleep2(delayMs);
      const batch = campaigns.slice(i, i + batchSize);
      const batchPromises = batch.map(async (config) => {
        try {
          const body = {
            name: String(config.name || ""),
            objective: String(config.objective || "OUTCOME_TRAFFIC"),
            status: String(config.status || "PAUSED"),
            special_ad_categories: JSON.stringify(config.special_ad_categories || [])
          };
          if (config.daily_budget) body.daily_budget = String(config.daily_budget);
          if (config.bid_strategy) body.bid_strategy = String(config.bid_strategy);
          const response = await client.request(`${opts.accountId}/campaigns`, { method: "POST", body });
          return { success: true, name: config.name, data: response.data };
        } catch (err) {
          return { success: false, name: config.name, error: err.message };
        }
      });
      const batchResults = await Promise.all(batchPromises);
      for (const r of batchResults) {
        if (r.success) results.created.push(r);
        else results.failed.push(r);
      }
      console.error(`Progress: ${Math.min(i + batchSize, campaigns.length)}/${campaigns.length}`);
    }
    console.log(formatOutput({
      total: campaigns.length,
      created: results.created.length,
      failed: results.failed.length,
      results
    }, opts.output));
  }));
  bulk.command("update-status").description("Bulk update status for multiple objects").requiredOption("--ids <ids>", "Comma-separated object IDs").requiredOption("--status <status>", "New status (ACTIVE, PAUSED, ARCHIVED)").option("--delay-ms <ms>", "Delay between requests", "500").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const client = getClient2();
    const ids = opts.ids.split(",").map((id) => id.trim());
    const results = { updated: [], failed: [] };
    for (const id of ids) {
      try {
        const response = await client.request(id, { method: "POST", body: { status: opts.status } });
        results.updated.push({ id, data: response.data });
      } catch (err) {
        results.failed.push({ id, error: err.message });
      }
      if (parseInt(opts.delayMs) > 0) await sleep2(parseInt(opts.delayMs));
    }
    console.log(formatOutput({
      total: ids.length,
      updated: results.updated.length,
      failed: results.failed.length,
      results
    }, opts.output));
  }));
  bulk.command("analyze").description("Bulk performance analysis for multiple entities").requiredOption("--ids <ids>", "Comma-separated entity IDs").option("--metrics <fields>", "Metrics to fetch", "impressions,clicks,spend,cpc,cpm,ctr,actions").option("--time-range <range>", "Time range", "last_7d").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const client = getClient2();
    const ids = opts.ids.split(",").map((id) => id.trim());
    const results = [];
    for (const id of ids) {
      try {
        const [entity, insights] = await Promise.all([
          client.request(id, { params: { fields: "id,name,status" } }),
          client.request(`${id}/insights`, { params: { fields: opts.metrics } })
        ]);
        results.push({
          entity: entity.data,
          insights: insights.data.data?.[0] || {}
        });
      } catch (err) {
        results.push({ id, error: err.message });
      }
    }
    console.log(formatOutput(results, opts.output));
  }));
  bulk.command("upload-creatives").description("Bulk upload image creatives from URLs").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId16()).requiredOption("--images <json>", "JSON array of {url, name} objects").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const images = JSON.parse(opts.images);
    const results = { uploaded: [], failed: [] };
    for (const img of images) {
      try {
        const body = { url: img.url };
        if (img.name) body.name = img.name;
        const response = await client.request(`${opts.accountId}/adimages`, { method: "POST", body });
        results.uploaded.push({ url: img.url, data: response.data });
      } catch (err) {
        results.failed.push({ url: img.url, error: err.message });
      }
      await sleep2(500);
    }
    console.log(formatOutput({
      total: images.length,
      uploaded: results.uploaded.length,
      failed: results.failed.length,
      results
    }, opts.output));
  }));
}

// src/commands/instagram.ts
function getDefaultAccountId17() {
  return process.env.META_ADS_CLI_ACCOUNT_ID || "";
}
function registerInstagramCommands(program2, getClient2) {
  const instagram = program2.command("instagram").alias("ig").description("Instagram Shopping and business profile management");
  instagram.command("sync-catalog").description("Sync a product catalog to Instagram Business account").requiredOption("--instagram-id <id>", "Instagram Business account ID").requiredOption("--catalog-id <id>", "Product catalog ID").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    const client = getClient2();
    const igParams = {
      fields: "id,username,name,followers_count,is_business_account"
    };
    const igResponse = await client.request(opts.instagramId, { params: igParams });
    const catParams = {
      fields: "id,name,product_count,vertical"
    };
    const catResponse = await client.request(opts.catalogId, { params: catParams });
    const response = await client.request(`${opts.instagramId}/product_catalogs`, {
      method: "POST",
      body: { catalog_id: opts.catalogId }
    });
    console.log(formatOutput({
      instagram_account: igResponse.data,
      catalog: catResponse.data,
      sync_result: response.data
    }, opts.output));
  }));
  instagram.command("create-shopping-ad").description("Create an Instagram Shopping ad").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId17()).requiredOption("--adset-id <id>", "Ad set ID").requiredOption("--product-set-id <id>", "Product set ID").requiredOption("--instagram-id <id>", "Instagram account ID").option("--name <name>", "Ad name").option("--status <status>", "Initial status", "PAUSED").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const creativeBody = {
      name: opts.name ? `${opts.name} - Creative` : "Shopping Creative",
      object_story_spec: JSON.stringify({
        instagram_actor_id: opts.instagramId,
        template_data: {
          product_set_id: opts.productSetId,
          call_to_action: { type: "SHOP_NOW" }
        }
      })
    };
    const creativeResponse = await client.request(`${opts.accountId}/adcreatives`, { method: "POST", body: creativeBody });
    const creativeId = creativeResponse.data.id;
    const adBody = {
      name: opts.name || "Instagram Shopping Ad",
      adset_id: opts.adsetId,
      creative: JSON.stringify({ creative_id: creativeId }),
      status: opts.status
    };
    const adResponse = await client.request(`${opts.accountId}/ads`, { method: "POST", body: adBody });
    console.log(formatOutput({
      creative: creativeResponse.data,
      ad: adResponse.data
    }, opts.output));
  }));
  instagram.command("profile <instagramId>").description("Get/manage Instagram Business profile").option("--update-bio <text>", "Update biography").option("--update-website <url>", "Update website URL").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (instagramId, opts) => {
    const client = getClient2();
    if (opts.updateBio || opts.updateWebsite) {
      const body = {};
      if (opts.updateBio) body.biography = opts.updateBio;
      if (opts.updateWebsite) body.website = opts.updateWebsite;
      const response = await client.request(instagramId, { method: "POST", body });
      console.log(formatOutput(response.data, opts.output));
    } else {
      const params = {
        fields: "id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url,is_business_account"
      };
      const response = await client.request(instagramId, { params });
      console.log(formatOutput(response.data, opts.output));
    }
  }));
  instagram.command("shopping-insights <instagramId>").description("Get Instagram Shopping performance insights").option("--time-range <range>", "Time range", "last_30d").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (instagramId, opts) => {
    const client = getClient2();
    const params = {
      fields: "impressions,reach,profile_views,website_clicks",
      period: "day",
      metric: "impressions,reach,profile_views,website_clicks"
    };
    const response = await client.request(`${instagramId}/insights`, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
}

// src/commands/monitoring.ts
function getDefaultAccountId18() {
  return process.env.META_ADS_CLI_ACCOUNT_ID || "";
}
function registerMonitoringCommands(program2, getClient2) {
  const monitoring = program2.command("monitor").description("Real-time performance monitoring and automated alerts");
  monitoring.command("check <entityId>").description("Check performance against alert thresholds for a campaign/adset").option("--max-cpc <value>", "Alert if CPC exceeds this value").option("--min-ctr <value>", "Alert if CTR drops below this value").option("--max-frequency <value>", "Alert if frequency exceeds this value").option("--max-spend <value>", "Alert if daily spend exceeds this value").option("--min-conversions <value>", "Alert if conversions drop below this value").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (entityId, opts) => {
    const client = getClient2();
    const params = {
      fields: "impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,conversions"
    };
    const response = await client.request(`${entityId}/insights`, { params });
    const data = response.data.data?.[0] || {};
    const alerts = [];
    if (opts.maxCpc) {
      const cpc = parseFloat(String(data.cpc || 0));
      if (cpc > parseFloat(opts.maxCpc)) {
        alerts.push({ type: "HIGH_CPC", severity: "warning", message: `CPC ${cpc} exceeds threshold ${opts.maxCpc}`, current: cpc, threshold: parseFloat(opts.maxCpc) });
      }
    }
    if (opts.minCtr) {
      const ctr = parseFloat(String(data.ctr || 0));
      if (ctr < parseFloat(opts.minCtr)) {
        alerts.push({ type: "LOW_CTR", severity: "warning", message: `CTR ${ctr} below threshold ${opts.minCtr}`, current: ctr, threshold: parseFloat(opts.minCtr) });
      }
    }
    if (opts.maxFrequency) {
      const freq = parseFloat(String(data.frequency || 0));
      if (freq > parseFloat(opts.maxFrequency)) {
        alerts.push({ type: "HIGH_FREQUENCY", severity: "warning", message: `Frequency ${freq} exceeds threshold ${opts.maxFrequency}`, current: freq, threshold: parseFloat(opts.maxFrequency) });
      }
    }
    if (opts.maxSpend) {
      const spend = parseFloat(String(data.spend || 0));
      if (spend > parseFloat(opts.maxSpend)) {
        alerts.push({ type: "BUDGET_DEPLETION", severity: "critical", message: `Spend ${spend} exceeds threshold ${opts.maxSpend}`, current: spend, threshold: parseFloat(opts.maxSpend) });
      }
    }
    console.log(formatOutput({
      entity_id: entityId,
      current_metrics: data,
      alerts_triggered: alerts.length,
      alerts,
      status: alerts.length === 0 ? "OK" : alerts.some((a) => a.severity === "critical") ? "CRITICAL" : "WARNING"
    }, opts.output));
  }));
  monitoring.command("auto-pause").description("Auto-pause entities that exceed thresholds").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId18()).option("--max-cpc <value>", "Pause if CPC exceeds this value").option("--max-spend <value>", "Pause if spend exceeds this value").option("--min-roas <value>", "Pause if ROAS drops below this value").option("--level <level>", "Level: campaign, adset, ad", "adset").option("--confirm", "Actually pause (without this flag, dry-run only)").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const listParams = {
      fields: "id,name,status",
      effective_status: JSON.stringify(["ACTIVE"]),
      limit: "100"
    };
    const entityEndpoint = opts.level === "campaign" ? `${opts.accountId}/campaigns` : opts.level === "ad" ? `${opts.accountId}/ads` : `${opts.accountId}/adsets`;
    const listResponse = await client.request(entityEndpoint, { params: listParams });
    const entities = listResponse.data.data || [];
    const toPause = [];
    for (const entity of entities) {
      const insightResponse = await client.request(`${entity.id}/insights`, {
        params: { fields: "spend,cpc,actions,cost_per_action_type" }
      });
      const insight = insightResponse.data.data?.[0] || {};
      const reasons = [];
      if (opts.maxCpc && parseFloat(String(insight.cpc || 0)) > parseFloat(opts.maxCpc)) {
        reasons.push(`CPC ${insight.cpc} > ${opts.maxCpc}`);
      }
      if (opts.maxSpend && parseFloat(String(insight.spend || 0)) > parseFloat(opts.maxSpend)) {
        reasons.push(`Spend ${insight.spend} > ${opts.maxSpend}`);
      }
      if (reasons.length > 0) {
        toPause.push({ id: String(entity.id), name: String(entity.name), reason: reasons.join("; ") });
      }
    }
    if (opts.confirm && toPause.length > 0) {
      for (const item of toPause) {
        await client.request(item.id, { method: "POST", body: { status: "PAUSED" } });
      }
    }
    console.log(formatOutput({
      entities_checked: entities.length,
      entities_to_pause: toPause.length,
      paused: opts.confirm,
      details: toPause,
      note: opts.confirm ? "Entities have been paused" : "Dry-run mode. Use --confirm to actually pause."
    }, opts.output));
  }));
  monitoring.command("dashboard").description("Quick performance dashboard for an account").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId18()).option("-o, --output <format>", "Output format", "table").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const params = {
      fields: "campaign_name,campaign_id,impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions",
      level: "campaign",
      limit: "25"
    };
    const response = await client.request(`${opts.accountId}/insights`, { params });
    console.log(formatOutput(response.data, opts.output));
  }));
}

// src/commands/workflows.ts
function getDefaultAccountId19() {
  return process.env.META_ADS_CLI_ACCOUNT_ID || "";
}
function registerWorkflowCommands(program2, getClient2) {
  const wf = program2.command("workflow").alias("wf").description("Cross-service workflows combining multiple API calls");
  wf.command("campaign-health <campaignId>").description("Full health check: campaign details + insights + ad set status + creative fatigue").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (campaignId, opts) => {
    const client = getClient2();
    const [campaign, insights, adsets, ads] = await Promise.all([
      client.request(campaignId, {
        params: { fields: "id,name,objective,status,daily_budget,lifetime_budget,bid_strategy,budget_remaining,start_time,stop_time" }
      }),
      client.request(`${campaignId}/insights`, {
        params: { fields: "impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,conversions,cost_per_action_type" }
      }),
      client.request(`${campaignId}/adsets`, {
        params: { fields: "id,name,status,daily_budget,optimization_goal,bid_strategy", limit: "50" }
      }),
      client.request(`${campaignId}/ads`, {
        params: { fields: "id,name,status,effective_status", limit: "50" }
      })
    ]);
    const insightData = insights.data.data?.[0] || {};
    const adsetData = adsets.data.data || [];
    const adData = ads.data.data || [];
    const health = [];
    const frequency = parseFloat(String(insightData.frequency || 0));
    const ctr = parseFloat(String(insightData.ctr || 0));
    const spend = parseFloat(String(insightData.spend || 0));
    if (frequency > 3) health.push("WARNING: High frequency \u2014 audience saturation risk");
    if (ctr < 0.5) health.push("WARNING: Low CTR \u2014 creative may need refresh");
    if (spend === 0) health.push("WARNING: Zero spend \u2014 check delivery status");
    const pausedAds = adData.filter((a) => a.status === "PAUSED").length;
    if (pausedAds > adData.length / 2) health.push(`INFO: ${pausedAds}/${adData.length} ads are paused`);
    if (health.length === 0) health.push("OK: No issues detected");
    console.log(formatOutput({
      campaign: campaign.data,
      insights: insightData,
      ad_sets: { total: adsetData.length, data: adsetData },
      ads: { total: adData.length, active: adData.length - pausedAds, paused: pausedAds },
      health_check: health
    }, opts.output));
  }));
  wf.command("full-audit").description("Full account audit: all campaigns with insights, budget analysis, recommendations").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId19()).option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const account = await client.request(opts.accountId, {
      params: { fields: "id,name,account_status,balance,currency,spend_cap,amount_spent" }
    });
    const campaignInsights = await client.request(`${opts.accountId}/insights`, {
      params: {
        fields: "campaign_id,campaign_name,impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions",
        level: "campaign",
        limit: "100"
      }
    });
    const campaignData = campaignInsights.data.data || [];
    let totalSpend = 0;
    const recommendations = [];
    for (const c of campaignData) {
      const spend = parseFloat(String(c.spend || 0));
      const ctr = parseFloat(String(c.ctr || 0));
      const cpc = parseFloat(String(c.cpc || 0));
      const frequency = parseFloat(String(c.frequency || 0));
      totalSpend += spend;
      const recs = [];
      if (ctr < 0.5) recs.push("Low CTR \u2014 refresh creative");
      if (frequency > 4) recs.push("Audience saturation \u2014 expand targeting");
      if (cpc > 3 && spend > 100) recs.push("High CPC with significant spend \u2014 optimize bidding");
      if (recs.length > 0) {
        recommendations.push({
          campaign: c.campaign_name,
          campaign_id: c.campaign_id,
          spend,
          issues: recs
        });
      }
    }
    console.log(formatOutput({
      account: account.data,
      summary: {
        total_campaigns: campaignData.length,
        total_spend: totalSpend.toFixed(2),
        campaigns_with_issues: recommendations.length
      },
      campaign_performance: campaignData,
      recommendations
    }, opts.output));
  }));
  wf.command("launch-campaign").description("End-to-end campaign launch: create campaign + adset + ad in one step").requiredOption("--account-id <id>", "Ad account ID (act_XXX)", getDefaultAccountId19()).requiredOption("--name <name>", "Campaign name").requiredOption("--objective <obj>", "Campaign objective").requiredOption("--daily-budget <cents>", "Daily budget in cents").requiredOption("--creative-id <id>", "Creative ID to use").option("--optimization-goal <goal>", "Optimization goal", "LINK_CLICKS").option("--billing-event <event>", "Billing event", "IMPRESSIONS").option("--targeting <json>", "Targeting spec as JSON").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (opts) => {
    if (!opts.accountId) throw new Error("Account ID required");
    const client = getClient2();
    const campResponse = await client.request(`${opts.accountId}/campaigns`, {
      method: "POST",
      body: {
        name: opts.name,
        objective: opts.objective,
        status: "PAUSED",
        daily_budget: opts.dailyBudget,
        special_ad_categories: "[]"
      }
    });
    const campaignId = campResponse.data.id;
    const adsetBody = {
      campaign_id: campaignId,
      name: `${opts.name} - Ad Set`,
      optimization_goal: opts.optimizationGoal,
      billing_event: opts.billingEvent,
      status: "PAUSED",
      daily_budget: opts.dailyBudget
    };
    if (opts.targeting) adsetBody.targeting = opts.targeting;
    const adsetResponse = await client.request(`${opts.accountId}/adsets`, {
      method: "POST",
      body: adsetBody
    });
    const adsetId = adsetResponse.data.id;
    const adResponse = await client.request(`${opts.accountId}/ads`, {
      method: "POST",
      body: {
        name: `${opts.name} - Ad`,
        adset_id: adsetId,
        creative: JSON.stringify({ creative_id: opts.creativeId }),
        status: "PAUSED"
      }
    });
    console.log(formatOutput({
      campaign: campResponse.data,
      adset: adsetResponse.data,
      ad: adResponse.data,
      note: "All created as PAUSED. Review and activate when ready."
    }, opts.output));
  }));
  wf.command("duplicate-and-test <campaignId>").description("Duplicate a campaign and set up A/B test with variant bid strategy").requiredOption("--variant-strategy <strategy>", "Bid strategy for variant").option("--name-prefix <prefix>", "Name prefix for test", "AB Test").option("-o, --output <format>", "Output format", "json").action(handleErrors(async (campaignId, opts) => {
    const client = getClient2();
    const [controlCopy, variantCopy] = await Promise.all([
      client.request(`${campaignId}/copies`, { method: "POST", body: { status_option: "PAUSED" } }),
      client.request(`${campaignId}/copies`, { method: "POST", body: { status_option: "PAUSED" } })
    ]);
    const controlId = controlCopy.data.copied_campaign_id;
    const variantId = variantCopy.data.copied_campaign_id;
    if (controlId) {
      await client.request(controlId, { method: "POST", body: { name: `${opts.namePrefix} - Control` } });
    }
    if (variantId) {
      await client.request(variantId, {
        method: "POST",
        body: { name: `${opts.namePrefix} - Variant (${opts.variantStrategy})`, bid_strategy: opts.variantStrategy }
      });
    }
    console.log(formatOutput({
      original_campaign: campaignId,
      control: { id: controlId, ...controlCopy.data },
      variant: { id: variantId, bid_strategy: opts.variantStrategy, ...variantCopy.data },
      note: "Both campaigns created as PAUSED. Activate both simultaneously to start test."
    }, opts.output));
  }));
}

// src/commands/schema.ts
var ENDPOINTS = {
  accounts: {
    list: { method: "GET", path: "{user_id}/adaccounts", description: "List ad accounts", params: ["fields", "limit"] },
    get: { method: "GET", path: "{account_id}", description: "Get account details", params: ["fields"] }
  },
  campaigns: {
    list: { method: "GET", path: "{account_id}/campaigns", description: "List campaigns", params: ["fields", "limit", "effective_status", "after"] },
    get: { method: "GET", path: "{campaign_id}", description: "Get campaign details", params: ["fields"] },
    create: { method: "POST", path: "{account_id}/campaigns", description: "Create campaign", params: ["name", "objective", "status", "daily_budget", "lifetime_budget", "bid_strategy", "special_ad_categories"] },
    update: { method: "POST", path: "{campaign_id}", description: "Update campaign", params: ["name", "status", "daily_budget", "lifetime_budget", "bid_strategy"] },
    delete: { method: "POST", path: "{campaign_id}", description: "Delete campaign", params: ["status=DELETED"] },
    duplicate: { method: "POST", path: "{campaign_id}/copies", description: "Duplicate campaign", params: ["status_option", "deep_copy"] }
  },
  adsets: {
    list: { method: "GET", path: "{account_id}/adsets", description: "List ad sets", params: ["fields", "limit", "effective_status"] },
    get: { method: "GET", path: "{adset_id}", description: "Get ad set details", params: ["fields"] },
    create: { method: "POST", path: "{account_id}/adsets", description: "Create ad set", params: ["campaign_id", "name", "optimization_goal", "billing_event", "targeting", "daily_budget"] },
    update: { method: "POST", path: "{adset_id}", description: "Update ad set", params: ["name", "status", "daily_budget", "targeting", "bid_amount"] },
    delete: { method: "POST", path: "{adset_id}", description: "Delete ad set", params: ["status=DELETED"] }
  },
  ads: {
    list: { method: "GET", path: "{account_id}/ads", description: "List ads", params: ["fields", "limit", "effective_status"] },
    get: { method: "GET", path: "{ad_id}", description: "Get ad details", params: ["fields"] },
    create: { method: "POST", path: "{account_id}/ads", description: "Create ad", params: ["name", "adset_id", "creative", "status"] },
    update: { method: "POST", path: "{ad_id}", description: "Update ad", params: ["name", "status", "creative"] }
  },
  creatives: {
    list: { method: "GET", path: "{account_id}/adcreatives", description: "List creatives", params: ["fields", "limit"] },
    get: { method: "GET", path: "{creative_id}", description: "Get creative details", params: ["fields"] },
    create: { method: "POST", path: "{account_id}/adcreatives", description: "Create creative", params: ["name", "object_story_spec", "asset_feed_spec"] }
  },
  insights: {
    get: { method: "GET", path: "{object_id}/insights", description: "Get performance insights", params: ["fields", "time_range", "breakdowns", "level", "limit"] }
  },
  targeting: {
    "search-interests": { method: "GET", path: "search", description: "Search interests", params: ["type=adinterest", "q", "limit"] },
    "search-geo": { method: "GET", path: "search", description: "Search locations", params: ["type=adgeolocation", "q", "location_types"] },
    "search-behaviors": { method: "GET", path: "search", description: "Search behaviors", params: ["type=adTargetingCategory", "class=behaviors"] },
    "estimate-audience": { method: "GET", path: "{account_id}/delivery_estimate", description: "Estimate audience size", params: ["targeting_spec", "optimization_goal"] }
  },
  audiences: {
    list: { method: "GET", path: "{account_id}/customaudiences", description: "List custom audiences", params: ["fields", "limit"] },
    create: { method: "POST", path: "{account_id}/customaudiences", description: "Create audience", params: ["name", "subtype", "rule"] },
    delete: { method: "DELETE", path: "{audience_id}", description: "Delete audience", params: [] }
  },
  pixels: {
    list: { method: "GET", path: "{account_id}/adspixels", description: "List pixels", params: ["fields"] },
    create: { method: "POST", path: "{account_id}/adspixels", description: "Create pixel", params: ["name"] }
  },
  library: {
    search: { method: "GET", path: "ads_archive", description: "Search Ads Library", params: ["search_terms", "ad_reached_countries", "ad_type", "fields"] }
  }
};
function registerSchemaCommands(program2) {
  program2.command("schema [service] [operation]").description("Show API schema for services and operations").option("-o, --output <format>", "Output format", "json").action((service, operation, opts) => {
    if (!service) {
      const services = Object.keys(ENDPOINTS).map((name) => ({
        service: name,
        operations: Object.keys(ENDPOINTS[name]).join(", ")
      }));
      console.log(formatOutput(services, opts.output));
      return;
    }
    const svc = ENDPOINTS[service];
    if (!svc) {
      console.error(`Unknown service: ${service}. Available: ${Object.keys(ENDPOINTS).join(", ")}`);
      process.exit(1);
    }
    if (!operation) {
      const ops = Object.entries(svc).map(([name, schema]) => ({
        operation: name,
        method: schema.method,
        path: schema.path,
        description: schema.description
      }));
      console.log(formatOutput(ops, opts.output));
      return;
    }
    const op = svc[operation];
    if (!op) {
      console.error(`Unknown operation: ${operation}. Available: ${Object.keys(svc).join(", ")}`);
      process.exit(1);
    }
    console.log(formatOutput({
      service,
      operation,
      ...op
    }, opts.output));
  });
}

// src/commands/generate-skills.ts
import fs3 from "fs";
import path3 from "path";
var SKILLS = [
  {
    name: "meta-ads-accounts",
    description: "List and manage Meta ad accounts",
    command: "meta-ads accounts",
    examples: ["meta-ads accounts list", "meta-ads accounts get act_123456"]
  },
  {
    name: "meta-ads-campaigns",
    description: "Create, read, update, and delete Meta ad campaigns",
    command: "meta-ads campaigns",
    examples: [
      "meta-ads campaigns list --account-id act_123",
      "meta-ads campaigns get 12345",
      'meta-ads campaigns create --account-id act_123 --name "My Campaign" --objective OUTCOME_TRAFFIC',
      "meta-ads campaigns update 12345 --status ACTIVE"
    ]
  },
  {
    name: "meta-ads-adsets",
    description: "Create, read, update, and delete Meta ad sets",
    command: "meta-ads adsets",
    examples: [
      "meta-ads adsets list --account-id act_123",
      'meta-ads adsets create --account-id act_123 --campaign-id 456 --name "My AdSet" --optimization-goal LINK_CLICKS --billing-event IMPRESSIONS'
    ]
  },
  {
    name: "meta-ads-ads",
    description: "Create, read, update, and delete Meta ads",
    command: "meta-ads ads",
    examples: [
      "meta-ads ads list --account-id act_123",
      'meta-ads ads create --account-id act_123 --name "My Ad" --adset-id 456 --creative-id 789'
    ]
  },
  {
    name: "meta-ads-creatives",
    description: "Manage ad creatives (images, videos)",
    command: "meta-ads creatives",
    examples: [
      "meta-ads creatives list --account-id act_123",
      'meta-ads creatives create-image --account-id act_123 --image-hash abc123 --page-id 456 --link-url https://example.com --headline "Click here"'
    ]
  },
  {
    name: "meta-ads-insights",
    description: "Get performance analytics and reporting",
    command: "meta-ads insights",
    examples: [
      "meta-ads insights get 12345 --time-range last_7d",
      "meta-ads insights get act_123 --level campaign --breakdown age",
      "meta-ads insights account --account-id act_123"
    ]
  },
  {
    name: "meta-ads-targeting",
    description: "Search interests, behaviors, demographics, and locations for audience targeting",
    command: "meta-ads targeting",
    examples: [
      'meta-ads targeting search-interests "fitness"',
      'meta-ads targeting search-geo "New York"',
      `meta-ads targeting estimate-audience --account-id act_123 --targeting '{"geo_locations":{"countries":["US"]}}'`
    ]
  },
  {
    name: "meta-ads-audiences",
    description: "Manage custom and lookalike audiences",
    command: "meta-ads audiences",
    examples: [
      "meta-ads audiences list --account-id act_123",
      "meta-ads audiences create-lookalike --account-id act_123 --source-audience-id 456 --countries US,GB"
    ]
  },
  {
    name: "meta-ads-library",
    description: "Search the Meta Ads Library for competitor ads",
    command: "meta-ads library",
    examples: [
      'meta-ads library search --query "running shoes" --country US',
      "meta-ads library page-ads 12345 --active-status ACTIVE"
    ]
  },
  {
    name: "meta-ads-bidding",
    description: "Bid strategy validation and analysis",
    command: "meta-ads bidding",
    examples: [
      "meta-ads bidding validate --bid-strategy COST_CAP --optimization-goal CONVERSIONS --billing-event IMPRESSIONS",
      "meta-ads bidding analyze 123,456,789 --time-range last_7d"
    ]
  },
  {
    name: "meta-ads-duplicate",
    description: "Duplicate campaigns, ad sets, and ads",
    command: "meta-ads duplicate",
    examples: [
      "meta-ads duplicate campaign 12345 --deep-copy",
      "meta-ads duplicate adset 67890 --campaign-id 11111"
    ]
  },
  {
    name: "meta-ads-leads",
    description: "Manage lead forms and retrieve leads",
    command: "meta-ads leads",
    examples: [
      "meta-ads leads forms --page-id 12345",
      "meta-ads leads get 67890 --all"
    ]
  },
  {
    name: "meta-ads-catalog",
    description: "Product catalog management for e-commerce",
    command: "meta-ads catalog",
    examples: [
      "meta-ads catalog list --business-id 12345",
      "meta-ads catalog products 67890 --limit 50"
    ]
  },
  {
    name: "meta-ads-pixels",
    description: "Pixel and conversion tracking management",
    command: "meta-ads pixels",
    examples: [
      "meta-ads pixels list --account-id act_123",
      'meta-ads pixels create --account-id act_123 --name "My Pixel"'
    ]
  },
  {
    name: "meta-ads-conversions",
    description: "Conversions API for server-side event tracking",
    command: "meta-ads conversions",
    examples: [
      `meta-ads conversions send-event --pixel-id 123 --event-name Purchase --custom-data '{"value":29.99,"currency":"USD"}'`,
      "meta-ads conversions validate-setup 123",
      "meta-ads conversions custom-conversions --account-id act_123"
    ]
  },
  {
    name: "meta-ads-retargeting",
    description: "Advanced retargeting strategies: website behavior, video engagement, funnels",
    command: "meta-ads retargeting",
    examples: [
      'meta-ads retargeting website-behavior --account-id act_123 --pixel-id 456 --name "Cart Abandoners" --url-contains "/cart"',
      'meta-ads retargeting funnel --account-id act_123 --pixel-id 456 --funnel-name "Purchase Funnel"',
      'meta-ads retargeting dynamic-campaign --account-id act_123 --campaign-name "DPA" --product-set-id 789 --page-id 111'
    ]
  },
  {
    name: "meta-ads-ab-test",
    description: "A/B testing for bid strategies and creatives",
    command: "meta-ads ab-test",
    examples: [
      'meta-ads ab-test create --account-id act_123 --name "Bid Test" --campaign-id 456 --variant-bid-strategy COST_CAP',
      "meta-ads ab-test analyze 111 222 --metrics impressions,clicks,spend,cpc,ctr"
    ]
  },
  {
    name: "meta-ads-analytics",
    description: "Advanced analytics: trends, creative fatigue, competitive intel",
    command: "meta-ads analytics",
    examples: [
      "meta-ads analytics trends 12345 --days 14",
      "meta-ads analytics creative-fatigue 67890",
      "meta-ads analytics competitive-intel --page-ids 111,222,333"
    ]
  },
  {
    name: "meta-ads-ai",
    description: "AI-powered performance scoring, anomaly detection, and recommendations",
    command: "meta-ads ai",
    examples: [
      "meta-ads ai score 12345 --type campaign",
      "meta-ads ai anomalies 12345 --type adset --sensitivity 0.8",
      "meta-ads ai recommendations --account-id act_123",
      "meta-ads ai export-dataset --account-id act_123 -o csv > data.csv"
    ]
  },
  {
    name: "meta-ads-bulk",
    description: "Bulk operations: batch campaign creation, status updates, analysis",
    command: "meta-ads bulk",
    examples: [
      "meta-ads bulk update-status --ids 123,456,789 --status PAUSED",
      "meta-ads bulk analyze --ids 123,456,789"
    ]
  },
  {
    name: "meta-ads-instagram",
    description: "Instagram Shopping: catalog sync, shopping ads, profile management",
    command: "meta-ads instagram",
    examples: [
      "meta-ads instagram sync-catalog --instagram-id 123 --catalog-id 456",
      "meta-ads instagram profile 123",
      "meta-ads instagram shopping-insights 123"
    ]
  },
  {
    name: "meta-ads-monitor",
    description: "Real-time performance monitoring, alerts, and auto-pause",
    command: "meta-ads monitor",
    examples: [
      "meta-ads monitor check 12345 --max-cpc 3 --min-ctr 0.5",
      "meta-ads monitor auto-pause --account-id act_123 --max-cpc 5",
      "meta-ads monitor dashboard --account-id act_123 -o table"
    ]
  },
  {
    name: "meta-ads-workflow",
    description: "Cross-service workflows: health checks, audits, campaign launches",
    command: "meta-ads workflow",
    examples: [
      "meta-ads workflow campaign-health 12345",
      "meta-ads workflow full-audit --account-id act_123",
      'meta-ads workflow launch-campaign --account-id act_123 --name "Quick" --objective OUTCOME_TRAFFIC --daily-budget 5000 --creative-id 67890',
      "meta-ads workflow duplicate-and-test 12345 --variant-strategy COST_CAP"
    ]
  },
  {
    name: "meta-ads-shared",
    description: "Shared patterns: authentication, output formats, pagination, global flags",
    command: "meta-ads",
    examples: [
      "meta-ads auth login",
      "meta-ads auth status",
      "meta-ads campaigns list --account-id act_123 -o table",
      "meta-ads campaigns list --account-id act_123 --all --page-limit 5",
      'meta-ads campaigns create --account-id act_123 --name "Test" --objective OUTCOME_TRAFFIC --dry-run',
      "meta-ads schema campaigns create"
    ]
  }
];
function generateSkillMd(skill) {
  return `---
name: ${skill.name}
description: ${skill.description}
---

# ${skill.name}

${skill.description}

## Usage

\`\`\`bash
${skill.examples.join("\n")}
\`\`\`

## Prerequisites

- Meta Ads CLI installed and authenticated (\`meta-ads auth login\`)
- Ad account configured via \`META_ADS_CLI_ACCOUNT_ID\` or \`--account-id\` flag

## Output Formats

All commands support \`-o\` / \`--output\` flag with: json, table, csv, text, yaml
`;
}
function registerGenerateSkillsCommand(program2) {
  program2.command("generate-skills").description("Generate SKILL.md files for Claude Code / OpenClaw agents").option("--output-dir <dir>", "Output directory for skills", "./skills").action((opts) => {
    const outDir = path3.resolve(opts.outputDir);
    if (!fs3.existsSync(outDir)) {
      fs3.mkdirSync(outDir, { recursive: true });
    }
    for (const skill of SKILLS) {
      const skillDir = path3.join(outDir, skill.name);
      if (!fs3.existsSync(skillDir)) {
        fs3.mkdirSync(skillDir, { recursive: true });
      }
      const content = generateSkillMd(skill);
      const filePath = path3.join(skillDir, "SKILL.md");
      fs3.writeFileSync(filePath, content);
      console.log(`Generated: ${filePath}`);
    }
    const indexLines = [
      "# Meta Ads CLI \u2014 Agent Skills Index",
      "",
      "| Skill | Description | Command |",
      "|-------|-------------|---------|"
    ];
    for (const skill of SKILLS) {
      indexLines.push(`| [${skill.name}](./${skill.name}/SKILL.md) | ${skill.description} | \`${skill.command}\` |`);
    }
    indexLines.push("");
    fs3.writeFileSync(path3.join(outDir, "INDEX.md"), indexLines.join("\n"));
    console.log(`Generated: ${path3.join(outDir, "INDEX.md")}`);
    console.log(`
Generated ${SKILLS.length} skill files + INDEX.md in ${outDir}`);
  });
}

// src/commands/setup.ts
import readline from "readline";
import fs4 from "fs";
import path4 from "path";
function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}
function registerSetupCommand(program2, getAuth2) {
  program2.command("setup").description("Interactive setup wizard for Meta Ads CLI").option("--non-interactive", "Print instructions without prompts").action(async (opts) => {
    if (opts.nonInteractive) {
      printStaticInstructions();
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log("\n=== Meta Ads CLI Setup Wizard ===\n");
    console.log("Step 1: Checking existing configuration...");
    const existingAppId = process.env.META_ADS_CLI_APP_ID || process.env.META_APP_ID;
    const existingToken = process.env.META_ADS_CLI_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN;
    const existingAccount = process.env.META_ADS_CLI_ACCOUNT_ID;
    if (existingAppId) {
      console.log(`  Found App ID: ${existingAppId}`);
    }
    if (existingToken) {
      console.log(`  Found access token: ${existingToken.slice(0, 10)}...`);
    }
    if (existingAccount) {
      console.log(`  Found account ID: ${existingAccount}`);
    }
    console.log("");
    console.log("Step 2: Meta App credentials");
    console.log("  Create a Meta app at: https://developers.facebook.com/apps");
    console.log('  Add the "Marketing API" product to your app\n');
    const appId = await prompt(rl, `  Meta App ID ${existingAppId ? `(${existingAppId})` : ""}: `);
    const appSecret = await prompt(rl, "  Meta App Secret (for long-lived tokens, optional): ");
    console.log("\nStep 3: Default ad account");
    console.log('  Format: act_XXXXXXXXX (run "meta-ads accounts list" to find yours)\n');
    const accountId = await prompt(rl, `  Default Account ID ${existingAccount ? `(${existingAccount})` : "(optional)"}: `);
    console.log("\nStep 4: Saving configuration...");
    const envPath = path4.resolve(".env");
    const envLines = [];
    if (fs4.existsSync(envPath)) {
      const existing = fs4.readFileSync(envPath, "utf8");
      for (const line of existing.split("\n")) {
        if (!line.startsWith("META_ADS_CLI_") && !line.startsWith("META_APP_") && !line.startsWith("META_ACCESS_TOKEN")) {
          envLines.push(line);
        }
      }
    }
    envLines.push("");
    envLines.push("# Meta Ads CLI Configuration");
    envLines.push(`META_ADS_CLI_APP_ID=${appId || existingAppId || ""}`);
    if (appSecret) envLines.push(`META_ADS_CLI_APP_SECRET=${appSecret}`);
    if (accountId || existingAccount) envLines.push(`META_ADS_CLI_ACCOUNT_ID=${accountId || existingAccount || ""}`);
    fs4.writeFileSync(envPath, envLines.join("\n").trim() + "\n");
    console.log(`  Saved to ${envPath}`);
    if (existingToken) {
      console.log("\nStep 5: Testing connection...");
      try {
        const auth = getAuth2();
        await auth.initialize();
        const result = await auth.verifyLogin();
        if (result.success && result.user) {
          console.log(`  Connected as: ${result.user.name} (ID: ${result.user.id})`);
        } else {
          console.log("  Could not verify connection. Run: meta-ads auth login");
        }
      } catch {
        console.log("  Could not verify connection. Run: meta-ads auth login");
      }
    } else {
      console.log("\nStep 5: Authentication");
      console.log("  Run: meta-ads auth login");
    }
    console.log("\nSetup complete! Next steps:");
    console.log("  1. meta-ads auth login       (authenticate)");
    console.log("  2. meta-ads auth status       (verify)");
    console.log("  3. meta-ads accounts list     (list your ad accounts)");
    console.log("  4. meta-ads campaigns list    (list campaigns)\n");
    rl.close();
  });
}
function printStaticInstructions() {
  console.log("Meta Ads CLI Setup");
  console.log("==================\n");
  console.log("1. Go to https://developers.facebook.com/apps");
  console.log('2. Create or select an app, add "Marketing API" product');
  console.log("3. Set environment variables in .env:\n");
  console.log("  META_ADS_CLI_APP_ID=your_app_id");
  console.log("  META_ADS_CLI_APP_SECRET=your_app_secret");
  console.log("  META_ADS_CLI_ACCOUNT_ID=act_XXXXXXXXX\n");
  console.log("4. Run: meta-ads auth login");
  console.log("5. Run: meta-ads auth status\n");
}

// src/index.ts
var program = new Command();
program.name("meta-ads").description("Meta Ads CLI - Manage Facebook & Instagram advertising via the Graph API").version("0.2.0").option("--dry-run", "Preview the API request without executing it").option("--read-only", "Restrict to read-only operations (block POST/DELETE)").option("--api-version <version>", "Graph API version (default: v24.0)", "v24.0");
var dryRun = process.argv.includes("--dry-run");
var readOnly = process.argv.includes("--read-only");
var apiVersion = "v24.0";
var apiIdx = process.argv.indexOf("--api-version");
if (apiIdx !== -1 && process.argv[apiIdx + 1]) {
  apiVersion = process.argv[apiIdx + 1];
}
if (process.env.META_ADS_CLI_API_VERSION) {
  apiVersion = process.env.META_ADS_CLI_API_VERSION;
}
var authManager = null;
var metaClient = null;
function getAuth() {
  if (!authManager) {
    authManager = new AuthManager();
  }
  return authManager;
}
function getClient() {
  if (!metaClient) {
    const auth = getAuth();
    metaClient = new MetaClient(auth, dryRun, apiVersion, readOnly);
  }
  return metaClient;
}
registerAuthCommands(program, getAuth);
registerAccountCommands(program, getClient);
registerCampaignCommands(program, getClient);
registerAdSetCommands(program, getClient);
registerAdCommands(program, getClient);
registerCreativeCommands(program, getClient);
registerInsightCommands(program, getClient);
registerTargetingCommands(program, getClient);
registerAudienceCommands(program, getClient);
registerRetargetingCommands(program, getClient);
registerPageCommands(program, getClient);
registerLeadCommands(program, getClient);
registerCatalogCommands(program, getClient);
registerInstagramCommands(program, getClient);
registerBiddingCommands(program, getClient);
registerDuplicationCommands(program, getClient);
registerBulkCommands(program, getClient);
registerAdsLibraryCommands(program, getClient);
registerAnalyticsCommands(program, getClient);
registerAiCommands(program, getClient);
registerAbTestingCommands(program, getClient);
registerConversionCommands(program, getClient);
registerMonitoringCommands(program, getClient);
registerWorkflowCommands(program, getClient);
registerSchemaCommands(program);
registerGenerateSkillsCommand(program);
registerSetupCommand(program, getAuth);
program.hook("preAction", async (thisCommand) => {
  const commandChain = [];
  let cmd = thisCommand;
  while (cmd) {
    commandChain.unshift(cmd.name());
    cmd = cmd.parent;
  }
  const skipAuth = ["auth", "setup", "schema", "generate-skills"];
  if (skipAuth.some((s) => commandChain.includes(s))) return;
  if (dryRun) return;
  logger_default.info(`Running: meta-ads ${commandChain.slice(1).join(" ")}`);
  const auth = getAuth();
  await auth.initialize();
});
program.parseAsync(process.argv).catch((err) => {
  logger_default.error(err.message);
  console.error("Error:", err.message);
  process.exit(1);
});
//# sourceMappingURL=index.js.map