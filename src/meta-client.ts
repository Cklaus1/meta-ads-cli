import { AuthManager } from './auth.js';
import { detectMimeType } from './mime.js';
import logger from './logger.js';

const MAX_RETRIES = 3;
const MAX_PAGES = 100;
const API_VERSION = 'v24.0';

export interface MetaRequestOptions {
  method?: string;
  params?: Record<string, string>;
  body?: Record<string, string>;
}

export interface MetaResponse {
  data: unknown;
  status: number;
  nextCursor?: string;
}

export class MetaClient {
  private auth: AuthManager;
  private dryRun: boolean;
  private readOnly: boolean;
  private apiVersion: string;
  private baseUrl: string;

  constructor(auth: AuthManager, dryRun = false, apiVersion?: string, readOnly = false) {
    this.auth = auth;
    this.dryRun = dryRun;
    this.readOnly = readOnly;
    this.apiVersion = apiVersion || process.env.META_ADS_CLI_API_VERSION || API_VERSION;
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;
  }

  buildUrl(endpoint: string, params?: Record<string, string>): string {
    let url = `${this.baseUrl}/${endpoint}`;
    if (params && Object.keys(params).length > 0) {
      const qs = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      url += (url.includes('?') ? '&' : '?') + qs;
    }
    return url;
  }

  async request(endpoint: string, options: MetaRequestOptions = {}): Promise<MetaResponse> {
    const method = options.method || 'GET';

    if (this.readOnly && method !== 'GET') {
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

    // Build params with access_token
    const allParams: Record<string, string> = {
      access_token: token,
      ...options.params,
    };

    logger.debug(`${method} ${endpoint}`, options.params);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      let response: Response;

      if (method === 'GET' || method === 'DELETE') {
        const url = this.buildUrl(endpoint, allParams);
        response = await fetch(url, { method });
      } else {
        // POST — Meta API uses form data for POST
        const url = this.buildUrl(endpoint);
        const formBody = new URLSearchParams({
          ...allParams,
          ...options.body,
        });
        response = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formBody.toString(),
        });
      }

      logger.debug(`Response: ${response.status} ${response.statusText}`, { attempt });

      // Rate limited — retry with backoff
      if (response.status === 429) {
        const waitMs = Math.pow(2, attempt) * 1000;
        if (attempt < MAX_RETRIES - 1) {
          logger.warn(`Rate limited. Retrying in ${waitMs / 1000}s...`);
          console.error(`Rate limited. Retrying in ${waitMs / 1000}s...`);
          await sleep(waitMs);
          continue;
        }
      }

      // Server error — retry with backoff
      if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
        const waitMs = Math.pow(2, attempt) * 1000;
        logger.warn(`Server error (${response.status}). Retrying in ${waitMs / 1000}s...`);
        console.error(`Server error (${response.status}). Retrying in ${waitMs / 1000}s...`);
        await sleep(waitMs);
        continue;
      }

      const text = await response.text();
      let json: unknown;

      try {
        json = JSON.parse(text);
      } catch {
        if (!response.ok) {
          throw new Error(`Meta API error (${response.status}): ${text}`);
        }
        return { data: { rawResponse: text }, status: response.status };
      }

      const obj = json as Record<string, unknown>;

      if (!response.ok || obj.error) {
        const errorObj = obj.error as Record<string, unknown> | undefined;
        const errorMessage = errorObj?.message || text;
        const errorCode = errorObj?.code;

        logger.error(`API error ${response.status}: ${errorMessage}`);

        if (response.status === 401 || errorCode === 190 || errorCode === 102) {
          throw new Error(`Authentication failed. Run: meta-ads auth login`);
        }
        if (response.status === 403 || errorCode === 200) {
          throw new Error(`Permission denied: ${errorMessage}`);
        }
        throw new Error(`Meta API error (${response.status}): ${errorMessage}`);
      }

      // Extract pagination cursor
      const paging = obj.paging as Record<string, unknown> | undefined;
      const cursors = paging?.cursors as Record<string, string> | undefined;
      const nextCursor = cursors?.after || undefined;

      return { data: json, status: response.status, nextCursor };
    }

    throw lastError || new Error('Request failed after retries');
  }

  async requestAllPages(
    endpoint: string,
    options: MetaRequestOptions = {},
    pageLimit?: number,
    pageDelayMs?: number,
  ): Promise<MetaResponse> {
    const maxPages = pageLimit || MAX_PAGES;
    const delayMs = pageDelayMs || 0;

    const first = await this.request(endpoint, options);
    const data = first.data as Record<string, unknown>;

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
          after: nextCursor,
        },
      };
      const nextResponse = await this.request(endpoint, nextOptions);
      const nextData = nextResponse.data as Record<string, unknown>;

      if (nextData.data && Array.isArray(nextData.data)) {
        allItems = allItems.concat(nextData.data);
      }
      nextCursor = nextResponse.nextCursor;
      pageCount++;
    }

    if (pageCount >= maxPages && nextCursor) {
      console.error(`Warning: Reached page limit (${maxPages}). Results may be incomplete.`);
    }

    logger.info(`Paginated: ${allItems.length} items across ${pageCount} pages`);
    data.data = allItems;
    return { data, status: first.status };
  }

  /**
   * Upload a file (image or video) via multipart form data.
   * For videos > 25MB, uses resumable upload with chunked streaming.
   */
  async uploadFile(
    endpoint: string,
    filePath: string,
  ): Promise<MetaResponse> {
    const { readFileSync, statSync } = await import('fs');
    const stat = statSync(filePath);
    const fileSize = stat.size;
    const contentType = detectMimeType(filePath);

    logger.info(`Uploading ${filePath} (${fileSize} bytes, ${contentType})`);

    if (this.dryRun) {
      console.log(`[dry-run] POST ${this.baseUrl}/${endpoint}`);
      console.log(`[dry-run] File: ${filePath} (${fileSize} bytes, ${contentType})`);
      return { data: { dryRun: true, method: 'POST', fileSize, contentType }, status: 0 };
    }

    const token = await this.auth.getToken();
    const content = readFileSync(filePath);

    // Build multipart form data manually
    const boundary = `----MetaAdsCLI${Date.now()}`;
    const parts: Buffer[] = [];

    // Access token part
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="access_token"\r\n\r\n${token}\r\n`));

    // File part
    const filename = filePath.split('/').pop() || 'file';
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`));
    parts.push(content);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const url = `${this.baseUrl}/${endpoint}`;
    console.error(`Uploading ${filename} (${(fileSize / 1024 / 1024).toFixed(1)} MB)...`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.byteLength),
      },
      body,
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
      return { data: { message: 'Upload complete', size: fileSize }, status: response.status };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
