/**
 * Exit codes are part of the CLI's contract with scripts and agents.
 * Plain errors (anything not typed below) exit 1.
 */
export const ExitCode = {
  GENERIC: 1,
  USAGE: 2,
  AUTH: 3,
  PERMISSION: 4,
  RATE_LIMIT: 5,
  API: 6,
  POLICY: 7,
  NETWORK: 8,
} as const;

export type ErrorType = 'error' | 'usage' | 'auth' | 'permission' | 'rate_limit' | 'api' | 'policy' | 'network';

const EXIT_FOR_TYPE: Record<ErrorType, number> = {
  error: ExitCode.GENERIC,
  usage: ExitCode.USAGE,
  auth: ExitCode.AUTH,
  permission: ExitCode.PERMISSION,
  rate_limit: ExitCode.RATE_LIMIT,
  api: ExitCode.API,
  policy: ExitCode.POLICY,
  network: ExitCode.NETWORK,
};

/** An error with a known type, so it maps to a stable exit code. */
export class CliError extends Error {
  readonly type: ErrorType;
  readonly retryable: boolean;

  constructor(message: string, type: ErrorType = 'error', retryable = false) {
    super(message);
    this.name = 'CliError';
    this.type = type;
    this.retryable = retryable;
  }

  get exitCode(): number {
    return EXIT_FOR_TYPE[this.type];
  }
}

/** Bad flags, IDs or input. */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 'usage');
    this.name = 'UsageError';
  }
}

/** Blocked by --read-only, the spend cap, or the policy file. */
export class PolicyError extends CliError {
  constructor(message: string) {
    super(message, 'policy');
    this.name = 'PolicyError';
  }
}

/** Timeout, DNS or connection failure before Meta answered. */
export class NetworkError extends CliError {
  constructor(message: string) {
    super(message, 'network', true);
    this.name = 'NetworkError';
  }
}

/** An error response from the Graph API, with Meta's diagnostic fields. */
export class MetaApiError extends CliError {
  readonly httpStatus: number;
  readonly code?: number;
  readonly subcode?: number;
  readonly fbtraceId?: string;
  readonly userTitle?: string;
  readonly userMessage?: string;

  constructor(message: string, details: {
    type?: ErrorType; httpStatus: number; code?: number; subcode?: number;
    fbtraceId?: string; userTitle?: string; userMessage?: string; retryable?: boolean;
  }) {
    super(message, details.type ?? 'api', details.retryable ?? false);
    this.name = 'MetaApiError';
    this.httpStatus = details.httpStatus;
    this.code = details.code;
    this.subcode = details.subcode;
    this.fbtraceId = details.fbtraceId;
    this.userTitle = details.userTitle;
    this.userMessage = details.userMessage;
  }
}

let errorFormat: 'text' | 'json' = process.env.META_ADS_CLI_ERROR_FORMAT === 'json' ? 'json' : 'text';

/** Set by --error-format; json prints one JSON object to stderr. */
export function setErrorFormat(format: string | undefined): void {
  if (format === undefined) return;
  if (format !== 'text' && format !== 'json') {
    throw new UsageError(`--error-format must be "text" or "json", got: "${format}"`);
  }
  errorFormat = format;
}

export function getErrorFormat(): 'text' | 'json' {
  return errorFormat;
}

export function exitCodeFor(err: unknown): number {
  return err instanceof CliError ? err.exitCode : ExitCode.GENERIC;
}

/** The JSON shape printed with --error-format json. */
export function errorToJson(err: unknown): { error: Record<string, unknown> } {
  const message = err instanceof Error ? err.message : String(err);
  const out: Record<string, unknown> = {
    message,
    type: err instanceof CliError ? err.type : 'error',
    exit_code: exitCodeFor(err),
    retryable: err instanceof CliError ? err.retryable : false,
  };
  if (err instanceof MetaApiError) {
    out.http_status = err.httpStatus;
    if (err.code !== undefined) out.code = err.code;
    if (err.subcode !== undefined) out.subcode = err.subcode;
    if (err.fbtraceId) out.fbtrace_id = err.fbtraceId;
    if (err.userTitle) out.user_title = err.userTitle;
    if (err.userMessage) out.user_message = err.userMessage;
  }
  return { error: out };
}

/** Print an error to stderr in the selected format. */
export function reportError(err: unknown): void {
  if (errorFormat === 'json') {
    console.error(JSON.stringify(errorToJson(err)));
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  const trace = err instanceof MetaApiError && err.fbtraceId ? ` (fbtrace_id: ${err.fbtraceId})` : '';
  console.error(`Error: ${message}${trace}`);
}

/**
 * Wraps an async command action with consistent error handling.
 * Catches errors and prints user-friendly messages instead of stack traces.
 */
export function handleErrors<T extends (...args: any[]) => Promise<void>>(fn: T): T {
  return (async (...args: Parameters<T>) => {
    try {
      await fn(...args);
    } catch (err) {
      reportError(err);
      process.exit(exitCodeFor(err));
    }
  }) as T;
}
