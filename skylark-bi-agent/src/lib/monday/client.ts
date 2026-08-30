/**
 * monday.com GraphQL client.
 *
 * monday's API fails in specific, recoverable ways — a per-minute complexity
 * budget, a separate rate limit, and occasional 5xx on large item pages. Each
 * gets its own handling rather than a blanket retry, because retrying a
 * complexity exhaustion immediately just burns the budget again.
 */

export type MondayErrorKind =
  | 'auth' | 'rate_limit' | 'complexity' | 'not_found' | 'network' | 'graphql' | 'unknown';

export class MondayError extends Error {
  readonly kind: MondayErrorKind;
  readonly retryAfterMs?: number;
  readonly detail?: unknown;

  constructor(message: string, kind: MondayErrorKind, retryAfterMs?: number, detail?: unknown) {
    super(message);
    this.name = 'MondayError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.detail = detail;
  }

  /** Message safe to show a non-technical user. */
  get userMessage(): string {
    switch (this.kind) {
      case 'auth':
        return 'monday.com rejected the API token. It may have been revoked or regenerated — check MONDAY_API_TOKEN.';
      case 'rate_limit':
        return 'monday.com is rate-limiting requests right now. Waiting a moment and retrying usually clears it.';
      case 'complexity':
        return 'This query asked monday.com for more data than its per-minute budget allows. Narrowing the question to fewer columns or a shorter period will get through.';
      case 'not_found':
        return 'That board could not be found in this monday.com account. Check the board IDs, or run the importer to create them.';
      case 'network':
        return 'Could not reach monday.com. This is usually a transient network issue.';
      default:
        return `monday.com returned an error: ${this.message}`;
    }
  }
}

const API_URL = 'https://api.monday.com/v2';
const API_VERSION = '2024-10';

export type ClientOptions = {
  token: string;
  /** Total attempts per request, including the first. */
  maxAttempts?: number;
  timeoutMs?: number;
  onRetry?: (info: { attempt: number; waitMs: number; reason: string }) => void;
};

export type QueryStats = { requests: number; retries: number; complexityUsed: number };

export class MondayClient {
  private readonly token: string;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly onRetry?: ClientOptions['onRetry'];
  readonly stats: QueryStats = { requests: 0, retries: 0, complexityUsed: 0 };

  constructor(opts: ClientOptions) {
    if (!opts.token) {
      throw new MondayError('No monday.com API token configured.', 'auth');
    }
    this.token = opts.token;
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.timeoutMs = opts.timeoutMs ?? 45_000;
    this.onRetry = opts.onRetry;
  }

  async query<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    let lastError: MondayError | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await this.once<T>(query, variables);
      } catch (err) {
        const e = err instanceof MondayError
          ? err
          : new MondayError(String((err as Error)?.message ?? err), 'unknown');
        lastError = e;

        const retryable = e.kind === 'rate_limit' || e.kind === 'complexity' || e.kind === 'network';
        if (!retryable || attempt === this.maxAttempts) throw e;

        // Complexity resets on a minute window, so honour the server's own
        // reset hint when it gives one instead of backing off blindly.
        const wait = e.retryAfterMs ?? Math.min(30_000, 800 * 2 ** (attempt - 1)) + Math.random() * 400;
        this.stats.retries += 1;
        this.onRetry?.({ attempt, waitMs: wait, reason: e.kind });
        await sleep(wait);
      }
    }
    throw lastError ?? new MondayError('Request failed.', 'unknown');
  }

  private async once<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    this.stats.requests += 1;

    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          Authorization: this.token,
          'Content-Type': 'application/json',
          'API-Version': API_VERSION,
        },
        body: JSON.stringify({ query, variables }),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = (err as Error)?.name === 'AbortError'
        ? `monday.com did not respond within ${this.timeoutMs / 1000}s.`
        : `Network error contacting monday.com: ${(err as Error)?.message}`;
      throw new MondayError(msg, 'network');
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      throw new MondayError(`monday.com returned ${res.status}.`, 'auth');
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      throw new MondayError('Rate limited.', 'rate_limit', Number.isFinite(ra) ? ra * 1000 : 10_000);
    }
    if (res.status >= 500) {
      throw new MondayError(`monday.com returned ${res.status}.`, 'network');
    }

    const text = await res.text();
    let body: {
      data?: T;
      errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
      error_message?: string;
      error_code?: string;
      account_id?: number;
    };
    try {
      body = JSON.parse(text);
    } catch {
      throw new MondayError(`monday.com returned a non-JSON response: ${text.slice(0, 200)}`, 'unknown');
    }

    // monday reports some failures outside the GraphQL errors array.
    if (body.error_code || body.error_message) {
      const code = String(body.error_code ?? '');
      const msg = String(body.error_message ?? code);
      if (/complexity/i.test(code + msg)) {
        const secs = Number(msg.match(/reset in (\d+)/i)?.[1] ?? 30);
        throw new MondayError(msg, 'complexity', (secs + 1) * 1000);
      }
      if (/rate.?limit|minute/i.test(code + msg)) {
        throw new MondayError(msg, 'rate_limit', 12_000);
      }
      if (/unauthor|token/i.test(code + msg)) throw new MondayError(msg, 'auth');
      throw new MondayError(msg, 'unknown', undefined, body);
    }

    if (body.errors?.length) {
      const messages = body.errors.map((e) => e.message).join('; ');
      if (/complexity/i.test(messages)) {
        const secs = Number(messages.match(/reset in (\d+)/i)?.[1] ?? 30);
        throw new MondayError(messages, 'complexity', (secs + 1) * 1000);
      }
      if (/rate.?limit/i.test(messages)) throw new MondayError(messages, 'rate_limit', 12_000);
      if (/unauthor|authentication/i.test(messages)) throw new MondayError(messages, 'auth');
      if (/does not exist|not found|invalid.*board/i.test(messages)) {
        throw new MondayError(messages, 'not_found');
      }
      // A partial-data response is still usable; only fail when there is none.
      if (body.data == null) throw new MondayError(messages, 'graphql', undefined, body.errors);
    }

    if (body.data == null) throw new MondayError('monday.com returned no data.', 'graphql');
    return body.data;
  }

  async me(): Promise<{ id: string; name: string; email: string; account: { id: string; name: string; slug: string } }> {
    const d = await this.query<{ me: { id: string; name: string; email: string; account: { id: string; name: string; slug: string } } }>(
      `query { me { id name email account { id name slug } } }`,
    );
    return d.me;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
