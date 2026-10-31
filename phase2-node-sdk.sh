#!/usr/bin/env bash
# FlowForge Phase 2.4: node SDK (node definitions, config validation, SSRF-safe HTTP node)
# and its integration into the API.
# Run from the repo root:  bash phase2-node-sdk.sh
# Files in packages/node-sdk are OVERWRITTEN (they are ours). API files that already
# exist are skipped; existing API files are patched in place (idempotent).
# Install first:
#   pnpm --filter @flowforge/node-sdk add zod undici
#   pnpm --filter @flowforge/node-sdk add -D vitest @types/node
#   pnpm --filter api add @flowforge/node-sdk@workspace:*
set -e

write() {
  if [ -e "$1" ]; then
    echo "skip      $1 (already exists)"
    cat > /dev/null
  else
    mkdir -p "$(dirname "$1")"
    cat > "$1"
    echo "create    $1"
  fi
}

write_force() {
  mkdir -p "$(dirname "$1")"
  if [ -e "$1" ]; then echo "overwrite $1"; else echo "create    $1"; fi
  cat > "$1"
}

[ -d packages/node-sdk ] || { echo "packages/node-sdk not found"; exit 1; }
[ -f apps/api/src/app.module.ts ] || { echo "apps/api/src/app.module.ts not found"; exit 1; }
[ -f packages/shared/src/workflow.ts ] || { echo "Run phase2-workflow-schema.sh first"; exit 1; }
if ! grep -q '"undici"' packages/node-sdk/package.json; then
  echo "Missing dependencies. Run first:"
  echo "  pnpm --filter @flowforge/node-sdk add zod undici"
  echo "  pnpm --filter @flowforge/node-sdk add -D vitest @types/node"
  echo "  pnpm --filter api add @flowforge/node-sdk@workspace:*"
  exit 1
fi

# ---------- packages/node-sdk ----------

write_force packages/node-sdk/tsconfig.json <<'FLOWFORGE_EOF'
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
FLOWFORGE_EOF

write_force packages/node-sdk/src/types.ts <<'FLOWFORGE_EOF'
import type { z } from 'zod';

export type NodeCategory = 'trigger' | 'logic' | 'integration' | 'ai';

export interface NodeContext<TConfig> {
  // Already resolved: expressions like {{ ... }} are replaced by the engine first.
  config: TConfig;
  // Output of the upstream node(s). The engine decides the exact shape.
  input: unknown;
  // Aborted when the execution is cancelled or the step times out.
  signal: AbortSignal;
}

export interface NodeResult {
  output: unknown;
  // Which outgoing handle the engine follows (for example "true" or "false").
  // Omit it for nodes that have a single output.
  handle?: string;
}

export interface NodeDefinition<TSchema extends z.ZodType = z.ZodType> {
  type: string; // stable key stored in workflows, e.g. "http.request"
  name: string;
  category: NodeCategory;
  description: string;
  configSchema: TSchema;
  handles: readonly string[];
  execute(ctx: NodeContext<z.output<TSchema>>): Promise<NodeResult>;
}

export const defineNode = <TSchema extends z.ZodType>(
  definition: NodeDefinition<TSchema>,
): NodeDefinition<TSchema> => definition;

// Thrown by nodes. `retryable` tells the engine whether trying again can help
// (a 503 or a timeout) or not (a 404, a blocked address, a bad config).
export class NodeExecutionError extends Error {
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    message: string,
    options: { retryable?: boolean; details?: unknown } = {},
  ) {
    super(message);
    this.name = 'NodeExecutionError';
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}
FLOWFORGE_EOF

write_force packages/node-sdk/src/network-guard.ts <<'FLOWFORGE_EOF'
import { lookup as dnsLookup } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';

export class BlockedAddressError extends Error {
  constructor(address: string) {
    super(`Blocked destination ${address}: private or reserved network`);
    this.name = 'BlockedAddressError';
  }
}

function parseIPv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function parseIPv6(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);

  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two hextets.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    text =
      text.slice(0, lastColon + 1) +
      ((v4[0] << 8) | v4[1]).toString(16) +
      ':' +
      ((v4[2] << 8) | v4[3]).toString(16);
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];

  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...rest];
  }

  const values = groups.map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN,
  );
  return values.length === 8 && values.every((value) => !Number.isNaN(value))
    ? values
    : null;
}

function isBlockedIPv4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this" network
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, includes cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol, TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

const v4FromHextets = (high: number, low: number) => [
  high >> 8,
  high & 0xff,
  low >> 8,
  low & 0xff,
];

function isBlockedIPv6(h: number[]): boolean {
  const zeros = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);

  if (zeros(0, 7) && (h[7] === 0 || h[7] === 1)) return true; // :: and ::1
  if (zeros(0, 5) && h[5] === 0xffff) return isBlockedIPv4(v4FromHextets(h[6], h[7])); // IPv4-mapped
  if (zeros(0, 6)) return isBlockedIPv4(v4FromHextets(h[6], h[7])); // IPv4-compatible
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) {
    return isBlockedIPv4(v4FromHextets(h[6], h[7])); // NAT64
  }
  if (h[0] === 0x2002) return isBlockedIPv4(v4FromHextets(h[1], h[2])); // 6to4
  if (h[0] === 0x2001 && h[1] === 0) return true; // Teredo
  if (h[0] === 0x2001 && h[1] === 0xdb8) return true; // documentation
  if (h[0] === 0x100 && zeros(1, 4)) return true; // discard-only
  return (
    (h[0] & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (h[0] & 0xffc0) === 0xfe80 || // link-local
    (h[0] & 0xffc0) === 0xfec0 || // deprecated site-local
    (h[0] & 0xff00) === 0xff00 // multicast
  );
}

/** True when the address must not be reached from a user-controlled request. */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = parseIPv4(address);
    return octets === null || isBlockedIPv4(octets);
  }
  if (version === 6) {
    const hextets = parseIPv6(address);
    return hextets === null || isBlockedIPv6(hextets);
  }
  return true; // not an IP at all: fail closed
}

const stripBrackets = (host: string) =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

/** Static check for URLs typed into a workflow. DNS names are checked at connect time. */
export function isBlockedHostLiteral(hostname: string): boolean {
  const host = stripBrackets(hostname);
  return isIP(host) !== 0 && isBlockedAddress(host);
}

/**
 * DNS lookup for the HTTP client. It validates the addresses it is about to hand
 * to the socket, so the check and the connection use the same answer. That closes
 * the DNS-rebinding gap that exists when you resolve once to check and again to connect.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    const done = callback as (...args: unknown[]) => void;
    if (error) return done(error);

    const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
    if (blocked) return done(new BlockedAddressError(blocked.address));

    if (options.all) return done(null, addresses);
    return done(null, addresses[0].address, addresses[0].family);
  });
};
FLOWFORGE_EOF

write_force packages/node-sdk/src/nodes/trigger-manual.ts <<'FLOWFORGE_EOF'
import { z } from 'zod';
import { defineNode } from '../types';

// Starts a run by hand. The input given when the run was created becomes its output.
export const triggerManualNode = defineNode({
  type: 'trigger.manual',
  name: 'Manual trigger',
  category: 'trigger',
  description: 'Starts the workflow when someone runs it by hand.',
  configSchema: z.object({}),
  handles: ['default'],
  async execute({ input }) {
    return { output: input ?? {} };
  },
});
FLOWFORGE_EOF

write_force packages/node-sdk/src/nodes/logic-if.ts <<'FLOWFORGE_EOF'
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { defineNode, NodeExecutionError } from '../types';

const OPERATORS = [
  'equals',
  'notEquals',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'isEmpty',
  'isNotEmpty',
] as const;

const configSchema = z
  .object({
    left: z.unknown().optional(),
    operator: z.enum(OPERATORS),
    right: z.unknown().optional(),
  })
  .refine(
    (config) =>
      ['isEmpty', 'isNotEmpty'].includes(config.operator) ||
      config.right !== undefined,
    { message: 'Toán tử này cần giá trị so sánh "right"', path: ['right'] },
  );

type Operator = (typeof OPERATORS)[number];

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' || Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function compare(operator: Operator, left: unknown, right: unknown): boolean {
  switch (operator) {
    case 'equals':
      return isDeepStrictEqual(left, right);
    case 'notEquals':
      return !isDeepStrictEqual(left, right);
    case 'isEmpty':
      return isEmpty(left);
    case 'isNotEmpty':
      return !isEmpty(left);
    case 'contains':
      if (typeof left === 'string' && typeof right === 'string') return left.includes(right);
      if (Array.isArray(left)) return left.some((item) => isDeepStrictEqual(item, right));
      return false;
    default: {
      // Ordering is defined for two numbers or two strings, never across types.
      const comparable =
        (typeof left === 'number' && typeof right === 'number') ||
        (typeof left === 'string' && typeof right === 'string');
      if (!comparable) {
        throw new NodeExecutionError(
          `Không thể so sánh "${operator}" giữa ${typeof left} và ${typeof right}`,
        );
      }
      const a = left as number | string;
      const b = right as number | string;
      if (operator === 'gt') return a > b;
      if (operator === 'gte') return a >= b;
      if (operator === 'lt') return a < b;
      return a <= b;
    }
  }
}

// No implicit type coercion: "42" does not equal 42. Surprises here would route
// a workflow down the wrong branch without any error.
export const logicIfNode = defineNode({
  type: 'logic.if',
  name: 'If / Else',
  category: 'logic',
  description: 'Sends the run down the "true" or "false" branch.',
  configSchema,
  handles: ['true', 'false'],
  async execute({ config }) {
    const result = compare(config.operator, config.left, config.right);
    return { output: { result }, handle: result ? 'true' : 'false' };
  },
});
FLOWFORGE_EOF

write_force packages/node-sdk/src/nodes/http-request.ts <<'FLOWFORGE_EOF'
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
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET'),
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
        Object.keys(headers).every((name) => !FORBIDDEN_HEADERS.has(name.toLowerCase())),
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
      throw new NodeExecutionError(`Phản hồi vượt quá giới hạn ${maxBytes} byte`);
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
        throw new NodeExecutionError('Chỉ hỗ trợ http và https, không chứa tài khoản trong URL');
      }
      // Literal IPs skip DNS, so they are checked here; names are checked in the lookup.
      if (!options.allowPrivateNetwork && isBlockedHostLiteral(url.hostname)) {
        throw new NodeExecutionError('Địa chỉ đích nằm trong mạng nội bộ nên bị chặn');
      }

      const headers: Record<string, string> = { ...config.headers };
      let body: string | undefined;
      if (config.body !== undefined && config.method !== 'GET' && config.method !== 'HEAD') {
        if (typeof config.body === 'string') {
          body = config.body;
        } else {
          body = JSON.stringify(config.body);
          if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
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
          signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
        });
      } catch (error) {
        if (signal.aborted) {
          throw new NodeExecutionError('Bước đã bị hủy');
        }
        if (causeChainHas(error, (e) => e instanceof BlockedAddressError)) {
          throw new NodeExecutionError('Địa chỉ đích nằm trong mạng nội bộ nên bị chặn');
        }
        if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
          throw new NodeExecutionError(`Hết thời gian chờ sau ${config.timeoutMs} ms`, {
            retryable: true,
          });
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
            response.status >= 500 || response.status === 429 || response.status === 408,
          details: output,
        });
      }
      return { output };
    },
  });
}

// The instance the platform uses: strict, private networks are blocked.
export const httpRequestNode = createHttpRequestNode();
FLOWFORGE_EOF

write_force packages/node-sdk/src/registry.ts <<'FLOWFORGE_EOF'
import { z } from 'zod';
import { httpRequestNode } from './nodes/http-request';
import { logicIfNode } from './nodes/logic-if';
import { triggerManualNode } from './nodes/trigger-manual';
import type { NodeDefinition } from './types';

// Adding a node type means adding one file under nodes/ and one line here.
const definitions: NodeDefinition[] = [triggerManualNode, logicIfNode, httpRequestNode];

const byType = new Map(definitions.map((definition) => [definition.type, definition]));

export const getNodeDefinition = (type: string) => byType.get(type);

/** Metadata for the editor: it builds each node's form from `configSchema`. */
export function listNodeTypes() {
  return definitions.map((definition) => ({
    type: definition.type,
    name: definition.name,
    category: definition.category,
    description: definition.description,
    handles: [...definition.handles],
    configSchema: z.toJSONSchema(definition.configSchema, { io: 'input' }),
  }));
}
FLOWFORGE_EOF

write_force packages/node-sdk/src/validate.ts <<'FLOWFORGE_EOF'
import { getNodeDefinition } from './registry';

export interface NodeConfigIssue {
  code: 'UNKNOWN_NODE_TYPE' | 'INVALID_NODE_CONFIG';
  message: string;
  path: (string | number)[];
}

interface WorkflowLike {
  nodes: Array<{ type: string; config: Record<string, unknown> }>;
}

/**
 * Checks every node's type and config against the node registry. On success the
 * returned definition carries the parsed configs, so defaults (method, timeout, ...)
 * are written into the stored workflow explicitly.
 */
export function normalizeNodeConfigs<T extends WorkflowLike>(
  definition: T,
): { ok: true; definition: T } | { ok: false; issues: NodeConfigIssue[] } {
  const issues: NodeConfigIssue[] = [];

  const nodes = definition.nodes.map((node, index) => {
    const nodeType = getNodeDefinition(node.type);
    if (!nodeType) {
      issues.push({
        code: 'UNKNOWN_NODE_TYPE',
        message: `Loại node "${node.type}" không tồn tại`,
        path: ['nodes', index, 'type'],
      });
      return node;
    }

    const parsed = nodeType.configSchema.safeParse(node.config);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({
          code: 'INVALID_NODE_CONFIG',
          message: issue.message,
          path: [
            'nodes',
            index,
            'config',
            ...issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
          ],
        });
      }
      return node;
    }
    return { ...node, config: parsed.data as Record<string, unknown> };
  });

  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, definition: { ...definition, nodes } };
}
FLOWFORGE_EOF

write_force packages/node-sdk/src/index.ts <<'FLOWFORGE_EOF'
export * from './types';
export * from './registry';
export * from './validate';
export { createHttpRequestNode, httpRequestNode } from './nodes/http-request';
export { isBlockedAddress, isBlockedHostLiteral, BlockedAddressError } from './network-guard';
FLOWFORGE_EOF

write_force packages/node-sdk/src/network-guard.test.ts <<'FLOWFORGE_EOF'
import { describe, expect, it } from 'vitest';
import { isBlockedAddress, isBlockedHostLiteral } from './network-guard';

describe('isBlockedAddress', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
  ])('blocks private or reserved IPv4 %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '93.184.216.34'])(
    'allows public IPv4 %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it.each([
    '::',
    '::1',
    'fc00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    'fe80::1%eth0',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:7f00:1', // the same address in hex form
    '::ffff:169.254.169.254',
    '::10.0.0.1',
    '64:ff9b::a00:1', // NAT64 wrapping 10.0.0.1
    '2002:7f00:1::', // 6to4 wrapping 127.0.0.1
  ])('blocks private or reserved IPv6 %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8'])(
    'allows public IPv6 %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it('fails closed for anything that is not an IP address', () => {
    expect(isBlockedAddress('example.com')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
    expect(isBlockedAddress('999.1.1.1')).toBe(true);
  });
});

describe('isBlockedHostLiteral', () => {
  it('checks IP literals, including bracketed IPv6', () => {
    expect(isBlockedHostLiteral('127.0.0.1')).toBe(true);
    expect(isBlockedHostLiteral('[::1]')).toBe(true);
    expect(isBlockedHostLiteral('8.8.8.8')).toBe(false);
  });

  it('leaves DNS names to the connect-time check', () => {
    expect(isBlockedHostLiteral('example.com')).toBe(false);
    expect(isBlockedHostLiteral('localhost')).toBe(false);
  });

  it('sees through alternative spellings once the URL parser normalizes them', () => {
    expect(isBlockedHostLiteral(new URL('http://2130706433/').hostname)).toBe(true); // decimal 127.0.0.1
    expect(isBlockedHostLiteral(new URL('http://0x7f.1/').hostname)).toBe(true); // hex 127.0.0.1
    expect(isBlockedHostLiteral(new URL('http://[::ffff:127.0.0.1]/').hostname)).toBe(true);
  });
});
FLOWFORGE_EOF

write_force packages/node-sdk/src/nodes/logic-if.test.ts <<'FLOWFORGE_EOF'
import { describe, expect, it } from 'vitest';
import { NodeExecutionError } from '../types';
import { logicIfNode } from './logic-if';

const run = (config: Record<string, unknown>) =>
  logicIfNode.execute({
    config: logicIfNode.configSchema.parse(config),
    input: undefined,
    signal: new AbortController().signal,
  });

describe('logic.if', () => {
  it('follows the true handle when the condition holds', async () => {
    const result = await run({ left: 5, operator: 'gt', right: 3 });
    expect(result).toEqual({ output: { result: true }, handle: 'true' });
  });

  it('follows the false handle otherwise', async () => {
    const result = await run({ left: 1, operator: 'gt', right: 3 });
    expect(result.handle).toBe('false');
  });

  it('does not coerce types: "42" is not 42', async () => {
    expect((await run({ left: '42', operator: 'equals', right: 42 })).handle).toBe('false');
    expect((await run({ left: 42, operator: 'equals', right: 42 })).handle).toBe('true');
  });

  it('compares objects and arrays by value', async () => {
    expect((await run({ left: { a: [1, 2] }, operator: 'equals', right: { a: [1, 2] } })).handle).toBe('true');
    expect((await run({ left: [1, { id: 2 }], operator: 'contains', right: { id: 2 } })).handle).toBe('true');
    expect((await run({ left: 'hello world', operator: 'contains', right: 'lo wo' })).handle).toBe('true');
  });

  it('handles empty checks without a right-hand side', async () => {
    expect((await run({ left: '', operator: 'isEmpty' })).handle).toBe('true');
    expect((await run({ left: [], operator: 'isEmpty' })).handle).toBe('true');
    expect((await run({ left: {}, operator: 'isEmpty' })).handle).toBe('true');
    expect((await run({ left: 0, operator: 'isEmpty' })).handle).toBe('false');
    expect((await run({ left: 'x', operator: 'isNotEmpty' })).handle).toBe('true');
  });

  it('refuses to order values of different types', async () => {
    await expect(run({ left: '5', operator: 'gt', right: 3 })).rejects.toBeInstanceOf(NodeExecutionError);
  });

  it('requires a right-hand side except for the empty checks', () => {
    expect(logicIfNode.configSchema.safeParse({ left: 1, operator: 'equals' }).success).toBe(false);
    expect(logicIfNode.configSchema.safeParse({ left: 1, operator: 'isEmpty' }).success).toBe(true);
    expect(logicIfNode.configSchema.safeParse({ operator: 'nope', right: 1 }).success).toBe(false);
  });
});
FLOWFORGE_EOF

write_force packages/node-sdk/src/nodes/http-request.test.ts <<'FLOWFORGE_EOF'
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodeExecutionError } from '../types';
import { createHttpRequestNode, httpRequestNode } from './http-request';

let server: Server;
let base: string;
const lastRequest: { method?: string; headers?: Record<string, unknown>; body?: string } = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      lastRequest.method = req.method;
      lastRequest.headers = req.headers;
      lastRequest.body = Buffer.concat(chunks).toString('utf8');

      switch (req.url) {
        case '/json':
          res.setHeader('content-type', 'application/json');
          return res.end(JSON.stringify({ hello: 'world' }));
        case '/text':
          return res.end('plain text');
        case '/not-found':
          res.statusCode = 404;
          return res.end('nope');
        case '/boom':
          res.statusCode = 503;
          return res.end('down');
        case '/limited':
          res.statusCode = 429;
          return res.end('slow down');
        case '/redirect':
          res.statusCode = 302;
          res.setHeader('location', 'http://169.254.169.254/latest/meta-data');
          return res.end();
        case '/big':
          return res.end('x'.repeat(5000));
        case '/slow':
          return void setTimeout(() => res.end('late'), 1500);
        default:
          return res.end('ok');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

// Talks to the local test server, so the private-network guard is switched off.
const open = createHttpRequestNode({ allowPrivateNetwork: true });

const run = (node: typeof open, config: Record<string, unknown>, signal = new AbortController().signal) =>
  node.execute({ config: node.configSchema.parse(config), input: undefined, signal });

describe('http.request behaviour', () => {
  it('returns status, headers and a parsed JSON body', async () => {
    const { output } = await run(open, { url: `${base}/json` });
    expect(output).toMatchObject({ status: 200, ok: true, body: { hello: 'world' } });
  });

  it('returns plain text as a string', async () => {
    const { output } = await run(open, { url: `${base}/text` });
    expect(output).toMatchObject({ body: 'plain text' });
  });

  it('sends JSON bodies with a content type and custom headers', async () => {
    await run(open, {
      method: 'POST',
      url: `${base}/echo`,
      headers: { 'X-Token': 'abc' },
      body: { n: 1 },
    });
    expect(lastRequest.method).toBe('POST');
    expect(lastRequest.body).toBe('{"n":1}');
    expect(lastRequest.headers).toMatchObject({ 'content-type': 'application/json', 'x-token': 'abc' });
  });

  it('does not send a body with GET', async () => {
    await run(open, { method: 'GET', url: `${base}/echo`, body: { ignored: true } });
    expect(lastRequest.body).toBe('');
  });

  it('fails the step on 4xx and marks it as not retryable', async () => {
    await expect(run(open, { url: `${base}/not-found` })).rejects.toMatchObject({
      name: 'NodeExecutionError',
      retryable: false,
    });
  });

  it('marks 5xx and 429 as retryable', async () => {
    await expect(run(open, { url: `${base}/boom` })).rejects.toMatchObject({ retryable: true });
    await expect(run(open, { url: `${base}/limited` })).rejects.toMatchObject({ retryable: true });
  });

  it('returns the status as output when failOnError is false', async () => {
    const { output } = await run(open, { url: `${base}/not-found`, failOnError: false });
    expect(output).toMatchObject({ status: 404, ok: false });
  });

  it('does not follow redirects', async () => {
    const { output } = await run(open, { url: `${base}/redirect` });
    expect(output).toMatchObject({
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data' },
    });
  });

  it('rejects a response larger than the limit', async () => {
    await expect(run(open, { url: `${base}/big`, maxResponseBytes: 1024 })).rejects.toBeInstanceOf(
      NodeExecutionError,
    );
  });

  it('times out slow servers and marks the failure retryable', async () => {
    await expect(run(open, { url: `${base}/slow`, timeoutMs: 200 })).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('stops when the run is cancelled, without retrying', async () => {
    const controller = new AbortController();
    const pending = run(open, { url: `${base}/slow` }, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ retryable: false });
  });
});

// The engine resolves {{ }} expressions and only then calls execute, so a URL can
// reach execute without ever having passed the save-time check. These tests call
// execute directly with a resolved config to prove the run-time guard stands alone.
const runResolved = (url: string) =>
  httpRequestNode.execute({
    config: {
      method: 'GET',
      url,
      headers: {},
      timeoutMs: 5000,
      maxResponseBytes: 1048576,
      failOnError: true,
    },
    input: undefined,
    signal: new AbortController().signal,
  });

describe('http.request SSRF protection', () => {
  const blocked = { name: 'NodeExecutionError', retryable: false };

  it.each([
    ['loopback IP', 'http://127.0.0.1:9/'],
    ['cloud metadata IP', 'http://169.254.169.254/latest/meta-data'],
    ['private IP', 'http://10.0.0.5/'],
    ['IPv6 loopback', 'http://[::1]:9/'],
    ['IPv4-mapped IPv6', 'http://[::ffff:127.0.0.1]:9/'],
    ['decimal-encoded loopback', 'http://2130706433:9/'],
  ])('blocks %s', async (_label, url) => {
    await expect(runResolved(url)).rejects.toMatchObject(blocked);
  });

  it('blocks a DNS name that resolves to a private address', async () => {
    // "localhost" resolves to 127.0.0.1; the lookup used by the client refuses it.
    const port = new URL(base).port;
    await expect(runResolved(`http://localhost:${port}/json`)).rejects.toMatchObject(blocked);
  });

  it('blocks the local test server when the guard is on, even by IP', async () => {
    await expect(runResolved(`${base}/json`)).rejects.toMatchObject(blocked);
  });
});

describe('http.request config', () => {
  const parse = (config: Record<string, unknown>) => httpRequestNode.configSchema.safeParse(config);

  it('fills in defaults', () => {
    const result = parse({ url: 'https://example.com' });
    expect(result.success && result.data).toMatchObject({
      method: 'GET',
      headers: {},
      timeoutMs: 10000,
      maxResponseBytes: 1048576,
      failOnError: true,
    });
  });

  it('accepts a templated URL', () => {
    expect(parse({ url: '{{ steps.trigger.output.url }}' }).success).toBe(true);
  });

  it.each([
    'file:///etc/passwd',
    'ftp://example.com/x',
    'not a url',
    'http://user:pass@example.com/',
    'http://127.0.0.1/admin',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
  ])('rejects the URL %s at save time', (url) => {
    expect(parse({ url }).success).toBe(false);
  });

  it('rejects headers the client must control', () => {
    expect(parse({ url: 'https://example.com', headers: { Host: 'evil' } }).success).toBe(false);
    expect(parse({ url: 'https://example.com', headers: { 'Bad Name': 'x' } }).success).toBe(false);
  });

  it('bounds timeout and response size', () => {
    expect(parse({ url: 'https://example.com', timeoutMs: 10 }).success).toBe(false);
    expect(parse({ url: 'https://example.com', timeoutMs: 999999 }).success).toBe(false);
    expect(parse({ url: 'https://example.com', maxResponseBytes: 10 ** 9 }).success).toBe(false);
  });
});
FLOWFORGE_EOF

write_force packages/node-sdk/src/registry.test.ts <<'FLOWFORGE_EOF'
import { describe, expect, it } from 'vitest';
import { getNodeDefinition, listNodeTypes } from './registry';
import { normalizeNodeConfigs } from './validate';

const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({
  id,
  type,
  name: id,
  config,
  position: { x: 0, y: 0 },
});

describe('registry', () => {
  it('finds registered nodes and returns undefined for unknown types', () => {
    expect(getNodeDefinition('http.request')?.name).toBe('HTTP Request');
    expect(getNodeDefinition('does.not.exist')).toBeUndefined();
  });

  it('lists every node with a JSON Schema for its config', () => {
    const types = listNodeTypes();
    expect(types.map((t) => t.type).sort()).toEqual(['http.request', 'logic.if', 'trigger.manual']);

    const http = types.find((t) => t.type === 'http.request')!;
    expect(http.configSchema).toMatchObject({ type: 'object' });
    expect(Object.keys((http.configSchema as { properties: object }).properties)).toContain('url');
    expect((http.configSchema as { required: string[] }).required).toContain('url');
    expect(types.find((t) => t.type === 'logic.if')!.handles).toEqual(['true', 'false']);
  });

  it('every registered type has a unique key and a trigger prefix only for triggers', () => {
    const types = listNodeTypes();
    expect(new Set(types.map((t) => t.type)).size).toBe(types.length);
    for (const t of types) {
      expect(t.type.startsWith('trigger.')).toBe(t.category === 'trigger');
    }
  });
});

describe('normalizeNodeConfigs', () => {
  it('accepts valid nodes and writes defaults into the config', () => {
    const result = normalizeNodeConfigs({
      nodes: [node('t', 'trigger.manual'), node('a', 'http.request', { url: 'https://example.com' })],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.nodes[1].config).toMatchObject({ method: 'GET', timeoutMs: 10000 });
    }
  });

  it('reports an unknown node type with a path to it', () => {
    const result = normalizeNodeConfigs({ nodes: [node('t', 'trigger.manual'), node('x', 'nope.nope')] });
    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: 'UNKNOWN_NODE_TYPE', path: ['nodes', 1, 'type'] }],
    });
  });

  it('reports a bad config with a path into the config', () => {
    const result = normalizeNodeConfigs({ nodes: [node('a', 'http.request', {})] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]).toMatchObject({ code: 'INVALID_NODE_CONFIG', path: ['nodes', 0, 'config', 'url'] });
    }
  });

  it('collects the issues of every node, not only the first', () => {
    const result = normalizeNodeConfigs({
      nodes: [node('a', 'http.request', {}), node('b', 'logic.if', { operator: 'bogus' }), node('c', 'zzz')],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const bad = new Set(result.issues.map((i) => i.path[1]));
      expect(bad).toEqual(new Set([0, 1, 2]));
    }
  });
});
FLOWFORGE_EOF

node - <<'FLOWFORGE_EOF'
const fs = require('fs');
const file = 'packages/node-sdk/package.json';
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
pkg.main ??= 'dist/index.js';
pkg.types ??= 'dist/index.d.ts';
pkg.scripts = { build: 'tsc -p tsconfig.json', ...pkg.scripts, test: 'vitest run' };
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log('edit      packages/node-sdk/package.json (main, types, scripts)');
FLOWFORGE_EOF

# ---------- API: validate nodes on save, expose node types ----------

write apps/api/src/workflows/workflow-nodes.pipe.ts <<'FLOWFORGE_EOF'
import { BadRequestException, PipeTransform } from '@nestjs/common';
import { normalizeNodeConfigs } from '@flowforge/node-sdk';
import type { WorkflowDefinition } from '@flowforge/shared';

// Runs after ZodValidationPipe. The shared schema checks structure and graph shape;
// this checks every node's type and config against the node registry and replaces
// each config with its parsed form, so defaults are stored explicitly.
export class WorkflowNodesPipe implements PipeTransform {
  transform(value: { definition?: WorkflowDefinition }) {
    if (!value.definition) return value;

    const result = normalizeNodeConfigs(value.definition);
    if (!result.ok) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Dữ liệu không hợp lệ',
        details: result.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return { ...value, definition: result.definition };
  }
}
FLOWFORGE_EOF

write apps/api/src/node-types/node-types.controller.ts <<'FLOWFORGE_EOF'
import { Controller, Get, UseGuards } from '@nestjs/common';
import { listNodeTypes } from '@flowforge/node-sdk';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

// Everything the editor needs to draw the node palette and each node's form.
// The web app never imports node-sdk: it contains server-only code.
@Controller('node-types')
@UseGuards(JwtAuthGuard)
export class NodeTypesController {
  private readonly types = listNodeTypes();

  @Get()
  list() {
    return this.types;
  }
}
FLOWFORGE_EOF

write apps/api/src/node-types/node-types.module.ts <<'FLOWFORGE_EOF'
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NodeTypesController } from './node-types.controller';

@Module({
  imports: [AuthModule], // JwtAuthGuard needs JwtService
  controllers: [NodeTypesController],
})
export class NodeTypesModule {}
FLOWFORGE_EOF

node - <<'FLOWFORGE_EOF'
const fs = require('fs');

// 1) Add WorkflowNodesPipe after the Zod pipe on create and update.
{
  const file = 'apps/api/src/workflows/workflows.controller.ts';
  if (!fs.existsSync(file)) {
    console.log('WARNING   ' + file + ' not found (run phase2-workflows-crud.sh first)');
  } else {
    let s = fs.readFileSync(file, 'utf8');
    if (s.includes('WorkflowNodesPipe')) {
      console.log('skip      workflows.controller.ts (pipe already added)');
    } else {
      s = s.replace(
        /new ZodValidationPipe\((createWorkflowSchema|updateWorkflowSchema)\)/g,
        'new ZodValidationPipe($1), new WorkflowNodesPipe()',
      );
      s = s.replace(
        /(import \{ WorkflowsService \} from [^\n]+\n)/,
        "$1import { WorkflowNodesPipe } from './workflow-nodes.pipe';\n",
      );
      const uses = (s.match(/new WorkflowNodesPipe\(\)/g) || []).length;
      if (uses !== 2 || !s.includes("from './workflow-nodes.pipe'")) {
        console.log('WARNING   could not patch workflows.controller.ts automatically.');
        console.log("          Import WorkflowNodesPipe from './workflow-nodes.pipe' and add");
        console.log('          `new WorkflowNodesPipe()` after the ZodValidationPipe in the');
        console.log('          @Body of both create and update.');
      } else {
        fs.writeFileSync(file, s);
        console.log('edit      workflows.controller.ts (node config validation on create and update)');
      }
    }
  }
}

// 2) Register NodeTypesModule.
{
  const file = 'apps/api/src/app.module.ts';
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes('NodeTypesModule')) {
    console.log('skip      app.module.ts (NodeTypesModule already registered)');
  } else {
    const before = s;
    const anchor = ['ExecutionsModule', 'WorkflowsModule', 'WorkspacesModule'].find((name) =>
      s.includes(name + ','),
    );
    if (anchor) {
      s = s.replace(
        new RegExp('(import \\{ ' + anchor + ' \\} from [^\\n]+\\n)'),
        "$1import { NodeTypesModule } from './node-types/node-types.module';\n",
      );
      s = s.replace(new RegExp('(\\n\\s*)' + anchor + ','), '$1' + anchor + ',$1NodeTypesModule,');
    }
    if (s === before || !s.includes('NodeTypesModule,')) {
      console.log('WARNING   could not patch app.module.ts automatically. Add:');
      console.log("          import { NodeTypesModule } from './node-types/node-types.module';");
      console.log('          and add NodeTypesModule to the imports array.');
    } else {
      fs.writeFileSync(file, s);
      console.log('edit      app.module.ts (registered NodeTypesModule)');
    }
  }
}

// 3) An existing test adds an http.request node with an empty config, which is now invalid.
{
  const file = 'apps/api/test/executions.e2e-spec.ts';
  if (fs.existsSync(file)) {
    let s = fs.readFileSync(file, 'utf8');
    const next = s.replace(
      /(id: 'extra',[\s\S]*?config:\s*)\{\}/,
      "$1{ url: 'https://example.com/extra' }",
    );
    if (next !== s) {
      fs.writeFileSync(file, next);
      console.log('edit      executions.e2e-spec.ts (the extra node now has a valid url)');
    } else {
      console.log('skip      executions.e2e-spec.ts (nothing to change)');
    }
  }
}
FLOWFORGE_EOF

write apps/api/test/workflow-nodes.e2e-spec.ts <<'FLOWFORGE_EOF'
import '../src/config/load-env.config';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/config/app.config';
import { PrismaService } from '../src/prisma/prisma.service';

const DOMAIN = `@${randomUUID()}.flowforge.test`;
const PASSWORD = 'Sup3rSecret!';

interface Actor {
  email: string;
  token: string;
}

interface TestNode {
  id: string;
  type: string;
  name: string;
  config?: Record<string, unknown>;
}

const trigger: TestNode = { id: 'trigger', type: 'trigger.manual', name: 'Start' };

// trigger -> n1 -> n2 -> ... as a simple chain.
const chain = (...nodes: TestNode[]) => ({
  nodes: [trigger, ...nodes],
  edges: nodes.map((node, i) => ({
    id: `e${i}`,
    source: i === 0 ? trigger.id : nodes[i - 1].id,
    target: node.id,
  })),
});

const http = (config?: Record<string, unknown>): TestNode => ({
  id: 'call',
  type: 'http.request',
  name: 'Call',
  config,
});

const wfUrl = (ws: string, id?: string) =>
  `/api/v1/workspaces/${ws}/workflows${id ? `/${id}` : ''}`;

describe('Node validation on workflows (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let alice: Actor;
  let aliceWs: string;

  const auth = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });
  const create = (definition: unknown) =>
    request(server)
      .post(wfUrl(aliceWs))
      .set(auth(alice))
      .send({ name: 'Flow', definition });
  const paths = (res: request.Response) =>
    (res.body.details as Array<{ path: string }>).map((d) => d.path);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    server = app.getHttpServer();

    const email = `alice-${randomUUID()}${DOMAIN}`;
    await request(server)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, name: 'alice' })
      .expect(201);
    const login = await request(server)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    alice = { email, token: login.body.accessToken as string };
    const list = await request(server)
      .get('/api/v1/workspaces')
      .set(auth(alice))
      .expect(200);
    aliceWs = list.body[0].id as string;
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { endsWith: DOMAIN } },
      select: { memberships: { select: { workspaceId: true } } },
    });
    const workspaceIds = users.flatMap((u) =>
      u.memberships.map((m) => m.workspaceId),
    );
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await app.close();
  });

  it('rejects an unknown node type and points at it', async () => {
    const res = await create(
      chain({ id: 'x', type: 'does.not.exist', name: 'X' }),
    ).expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(paths(res)).toContain('nodes.1.type');
  });

  it('rejects an http.request node without a url', async () => {
    const res = await create(chain(http({}))).expect(400);
    expect(paths(res)).toContain('nodes.1.config.url');
  });

  it.each([
    'file:///etc/passwd',
    'http://169.254.169.254/latest/meta-data',
    'http://127.0.0.1:8080/admin',
    'http://[::1]/',
    'http://user:secret@example.com/',
  ])('rejects the url %s at save time', async (url) => {
    const res = await create(chain(http({ url }))).expect(400);
    expect(paths(res)).toContain('nodes.1.config.url');
  });

  it('accepts a templated url, which is only known at run time', async () => {
    const url = '{{ steps.trigger.output.url }}';
    const res = await create(chain(http({ url }))).expect(201);
    expect(res.body.definition.nodes[1].config.url).toBe(url);
  });

  it('stores node defaults explicitly', async () => {
    const res = await create(chain(http({ url: 'https://example.com/api' }))).expect(201);
    expect(res.body.definition.nodes[1].config).toEqual({
      method: 'GET',
      url: 'https://example.com/api',
      headers: {},
      timeoutMs: 10000,
      maxResponseBytes: 1048576,
      failOnError: true,
    });
  });

  it('validates the If / Else node config', async () => {
    const bad = await create(
      chain({
        id: 'check',
        type: 'logic.if',
        name: 'Check',
        config: { left: 1, operator: 'equals' },
      }),
    ).expect(400);
    expect(paths(bad)).toContain('nodes.1.config.right');

    await create(
      chain({
        id: 'check',
        type: 'logic.if',
        name: 'Check',
        config: { left: 1, operator: 'equals', right: 1 },
      }),
    ).expect(201);
  });

  it('reports the problems of several nodes in one response', async () => {
    const res = await create({
      nodes: [
        trigger,
        { id: 'a', type: 'http.request', name: 'A', config: {} },
        { id: 'b', type: 'nope.nope', name: 'B', config: {} },
      ],
      edges: [
        { id: 'e0', source: 'trigger', target: 'a' },
        { id: 'e1', source: 'a', target: 'b' },
      ],
    }).expect(400);
    expect(paths(res)).toEqual(
      expect.arrayContaining(['nodes.1.config.url', 'nodes.2.type']),
    );
  });

  it('applies the same validation on update and leaves the workflow untouched', async () => {
    const created = await create(
      chain(http({ url: 'https://example.com/ok' })),
    ).expect(201);
    const url = wfUrl(aliceWs, created.body.id);

    const res = await request(server)
      .patch(url)
      .set(auth(alice))
      .send({ version: 1, definition: chain(http({ url: 'http://10.0.0.1/' })) })
      .expect(400);
    expect(paths(res)).toContain('nodes.1.config.url');

    const current = await request(server).get(url).set(auth(alice)).expect(200);
    expect(current.body.version).toBe(1);
    expect(current.body.definition.nodes[1].config.url).toBe('https://example.com/ok');
  });

  describe('GET /node-types', () => {
    it('requires authentication', async () => {
      await request(server).get('/api/v1/node-types').expect(401);
    });

    it('lists every node type with a JSON Schema for its config', async () => {
      const res = await request(server)
        .get('/api/v1/node-types')
        .set(auth(alice))
        .expect(200);

      const types = (res.body as Array<{ type: string }>).map((t) => t.type);
      expect(types).toEqual(
        expect.arrayContaining(['trigger.manual', 'logic.if', 'http.request']),
      );
      for (const node of res.body as Array<{ configSchema: { type: string } }>) {
        expect(node.configSchema.type).toBe('object');
      }
    });
  });
});
FLOWFORGE_EOF

write docs/adr/0007-node-sdk-and-ssrf-protection.md <<'FLOWFORGE_EOF'
# ADR 0007: Node SDK and protection against server-side request forgery

## Status
Accepted

## Context
Every node type must be declared once and used by three consumers: the API (to
validate a workflow when it is saved), the worker (to run it) and the editor (to
draw a form). The HTTP Request node is also the riskiest feature in the product:
it makes the platform call addresses chosen by its users. A tenant could aim it at
`169.254.169.254` (cloud credentials), at `localhost`, or at services inside the
private network.

## Decision
- **One declaration per node** in `packages/node-sdk`: a stable `type` key, a Zod
  `configSchema`, the output `handles`, and an `execute` function. Adding a node is
  one file plus one line in the registry.
- **Validation on save:** the API checks every node's type and config against the
  registry and stores the *parsed* config, so defaults are written explicitly and a
  stored workflow does not change meaning if a default changes later. The engine
  will validate again after resolving `{{ }}` expressions and before `execute`.
- **The editor gets metadata over HTTP** (`GET /node-types`, config as JSON
  Schema). The web app never imports node-sdk, which contains server-only code.
- **`NodeExecutionError.retryable`** tells the engine whether trying again can help
  (5xx, 429, timeouts, connection failures) or cannot (4xx, blocked address, bad
  config).
- **If / Else does no type coercion:** `"42"` does not equal `42`, and ordering
  works only between two numbers or two strings. A surprise here would send a run
  down the wrong branch silently.
- **HTTP node, outgoing requests:**
  - Only `http` and `https`; no credentials in the URL; the client controls
    `Host`, `Content-Length` and similar headers.
  - Literal IP addresses are rejected at save time and again at run time.
  - DNS names are checked inside the connection's own lookup: the addresses
    that were validated are the ones the socket connects to, so there is no
    window for DNS rebinding.
  - Blocked: loopback, private, link-local (including cloud metadata), carrier NAT,
    multicast and reserved ranges, and IPv6 equivalents including IPv4-mapped,
    NAT64 and 6to4 forms. Anything that cannot be parsed is blocked.
  - Redirects are returned, not followed, so a public URL cannot bounce a request
    inward.
  - Timeout 100 ms to 60 s (default 10 s); response size limit 1 MiB by default,
    10 MiB at most; the run's cancellation signal is honored.
  - `allowPrivateNetwork` exists only as a factory option for tests and local
    development, never as a workflow setting.

## Consequences
- The blocked ranges are maintained by hand and must be reviewed periodically.
- Redirects must be handled by the workflow author (the 3xx response is output).
- There is no per-workspace allow-list yet; calling an internal service on purpose
  is not possible. If an egress proxy is introduced, enforce the same rules there.
- Responses are read as UTF-8 text; binary payloads are not supported.
- The guard protects this node only. Any future node that fetches a user-supplied
  URL (webhooks out, AI tools, file import) must reuse `guardedLookup`.
FLOWFORGE_EOF

echo
echo "Done. Next steps are in the chat."