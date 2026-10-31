import { Agent, fetch } from 'undici';
import { z } from 'zod';
import {
  BlockedAddressError,
  guardedLookup,
  isBlockedHostLiteral,
} from '../network-guard';
import { defineNode, NodeExecutionError } from '../types';

const isTemplate = (value: string) => /\{\{[\s\S]*\}\}/.test(value);

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

// Headers the HTTP client must control itself.
const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
]);

function buildConfigSchema(blockPrivateLiterals: boolean) {
  return z.object({
    method: z
      .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
      .default('GET'),
    url: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      // A URL with {{ }} is only known at run time; everything else must be a
      // plain http(s) URL that does not point at a private address.
      .refine((value) => isTemplate(value) || isHttpUrl(value), {
        message: 'URL phải là http hoặc https hợp lệ, không chứa tài khoản',
      })
      .refine(
        (value) =>
          !blockPrivateLiterals ||
          isTemplate(value) ||
          !isHttpUrl(value) ||
          !isBlockedHostLiteral(new URL(value).hostname),
        { message: 'URL trỏ tới địa chỉ mạng nội bộ nên bị chặn' },
      ),
    headers: z
      .record(z.string().regex(/^[A-Za-z0-9-]+$/), z.string().max(4096))
      .refine(
        (headers) =>
          Object.keys(headers).every(
            (name) => !FORBIDDEN_HEADERS.has(name.toLowerCase()),
          ),
        { message: 'Không được đặt các header do hệ thống quản lý' },
      )
      .default({}),
    body: z.unknown().optional(),
    timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
    maxResponseBytes: z
      .number()
      .int()
      .min(1024)
      .max(10 * 1024 * 1024)
      .default(1024 * 1024),
    // When true (default) a 4xx/5xx answer fails the step, so retries and error
    // handling apply. When false the status is returned as ordinary output.
    failOnError: z.boolean().default(true),
  });
}

function causeChainHas(error: unknown, test: (e: unknown) => boolean): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    if (test(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// Reads at most maxBytes. Leaving the loop early cancels the underlying stream.
async function readLimited(
  body: AsyncIterable<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!body) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new NodeExecutionError(
        `Phản hồi vượt quá giới hạn ${maxBytes} byte`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface HttpRequestNodeOptions {
  // Tests and local development only. Never enable it for user-supplied workflows.
  allowPrivateNetwork?: boolean;
}

export function createHttpRequestNode(options: HttpRequestNodeOptions = {}) {
  const agent = options.allowPrivateNetwork
    ? new Agent()
    : new Agent({ connect: { lookup: guardedLookup } });
  // The save-time check on literal private IPs applies to the strict node only.
  const configSchema = buildConfigSchema(!options.allowPrivateNetwork);

  return defineNode({
    type: 'http.request',
    name: 'HTTP Request',
    category: 'integration',
    description: 'Calls an HTTP endpoint and returns the response.',
    configSchema,
    handles: ['default'],
    async execute({ config, signal }) {
      let url: URL;
      try {
        url = new URL(config.url);
      } catch {
        throw new NodeExecutionError('URL không hợp lệ');
      }
      if (!isHttpUrl(url.href)) {
        throw new NodeExecutionError(
          'Chỉ hỗ trợ http và https, không chứa tài khoản trong URL',
        );
      }
      // Literal IPs skip DNS, so they are checked here; names are checked in the lookup.
      if (!options.allowPrivateNetwork && isBlockedHostLiteral(url.hostname)) {
        throw new NodeExecutionError(
          'Địa chỉ đích nằm trong mạng nội bộ nên bị chặn',
        );
      }

      const headers: Record<string, string> = { ...config.headers };
      let body: string | undefined;
      if (
        config.body !== undefined &&
        config.method !== 'GET' &&
        config.method !== 'HEAD'
      ) {
        if (typeof config.body === 'string') {
          body = config.body;
        } else {
          body = JSON.stringify(config.body);
          if (
            !Object.keys(headers).some(
              (name) => name.toLowerCase() === 'content-type',
            )
          ) {
            headers['Content-Type'] = 'application/json';
          }
        }
      }

      let response;
      try {
        response = await fetch(url, {
          method: config.method,
          headers,
          body,
          dispatcher: agent,
          // Redirects are returned, not followed: each hop would need its own
          // address check, and a public URL must not be able to bounce us inward.
          redirect: 'manual',
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(config.timeoutMs),
          ]),
        });
      } catch (error) {
        if (signal.aborted) {
          throw new NodeExecutionError('Bước đã bị hủy');
        }
        if (causeChainHas(error, (e) => e instanceof BlockedAddressError)) {
          throw new NodeExecutionError(
            'Địa chỉ đích nằm trong mạng nội bộ nên bị chặn',
          );
        }
        if (
          error instanceof Error &&
          ['TimeoutError', 'AbortError'].includes(error.name)
        ) {
          throw new NodeExecutionError(
            `Hết thời gian chờ sau ${config.timeoutMs} ms`,
            {
              retryable: true,
            },
          );
        }
        // Network failures (reset, refused, DNS) are usually temporary.
        throw new NodeExecutionError('Không kết nối được tới máy chủ đích', {
          retryable: true,
        });
      }

      const text = await readLimited(
        response.body as unknown as AsyncIterable<Uint8Array> | null,
        config.maxResponseBytes,
      );
      const contentType = response.headers.get('content-type') ?? '';
      let parsed: unknown = text;
      if (contentType.includes('json') && text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // keep the raw text
        }
      }

      const output = {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        headers: Object.fromEntries(response.headers.entries()),
        body: parsed,
      };

      if (config.failOnError && response.status >= 400) {
        throw new NodeExecutionError(`HTTP ${response.status}`, {
          retryable:
            response.status >= 500 ||
            response.status === 429 ||
            response.status === 408,
          details: output,
        });
      }
      return { output };
    },
  });
}

// The instance the platform uses: strict, private networks are blocked.
export const httpRequestNode = createHttpRequestNode();
