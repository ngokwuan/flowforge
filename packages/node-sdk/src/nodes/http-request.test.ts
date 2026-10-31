import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodeExecutionError } from '../types';
import { createHttpRequestNode, httpRequestNode } from './http-request';

let server: Server;
let base: string;
const lastRequest: {
  method?: string;
  headers?: Record<string, unknown>;
  body?: string;
} = {};

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

const run = (
  node: typeof open,
  config: Record<string, unknown>,
  signal = new AbortController().signal,
) =>
  node.execute({
    config: node.configSchema.parse(config),
    input: undefined,
    signal,
  });

describe('http.request behaviour', () => {
  it('returns status, headers and a parsed JSON body', async () => {
    const { output } = await run(open, { url: `${base}/json` });
    expect(output).toMatchObject({
      status: 200,
      ok: true,
      body: { hello: 'world' },
    });
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
    expect(lastRequest.headers).toMatchObject({
      'content-type': 'application/json',
      'x-token': 'abc',
    });
  });

  it('does not send a body with GET', async () => {
    await run(open, {
      method: 'GET',
      url: `${base}/echo`,
      body: { ignored: true },
    });
    expect(lastRequest.body).toBe('');
  });

  it('fails the step on 4xx and marks it as not retryable', async () => {
    await expect(run(open, { url: `${base}/not-found` })).rejects.toMatchObject(
      {
        name: 'NodeExecutionError',
        retryable: false,
      },
    );
  });

  it('marks 5xx and 429 as retryable', async () => {
    await expect(run(open, { url: `${base}/boom` })).rejects.toMatchObject({
      retryable: true,
    });
    await expect(run(open, { url: `${base}/limited` })).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('returns the status as output when failOnError is false', async () => {
    const { output } = await run(open, {
      url: `${base}/not-found`,
      failOnError: false,
    });
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
    await expect(
      run(open, { url: `${base}/big`, maxResponseBytes: 1024 }),
    ).rejects.toBeInstanceOf(NodeExecutionError);
  });

  it('times out slow servers and marks the failure retryable', async () => {
    await expect(
      run(open, { url: `${base}/slow`, timeoutMs: 200 }),
    ).rejects.toMatchObject({
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
    await expect(
      runResolved(`http://localhost:${port}/json`),
    ).rejects.toMatchObject(blocked);
  });

  it('blocks the local test server when the guard is on, even by IP', async () => {
    await expect(runResolved(`${base}/json`)).rejects.toMatchObject(blocked);
  });
});

describe('http.request config', () => {
  const parse = (config: Record<string, unknown>) =>
    httpRequestNode.configSchema.safeParse(config);

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
    expect(
      parse({ url: 'https://example.com', headers: { Host: 'evil' } }).success,
    ).toBe(false);
    expect(
      parse({ url: 'https://example.com', headers: { 'Bad Name': 'x' } })
        .success,
    ).toBe(false);
  });

  it('bounds timeout and response size', () => {
    expect(parse({ url: 'https://example.com', timeoutMs: 10 }).success).toBe(
      false,
    );
    expect(
      parse({ url: 'https://example.com', timeoutMs: 999999 }).success,
    ).toBe(false);
    expect(
      parse({ url: 'https://example.com', maxResponseBytes: 10 ** 9 }).success,
    ).toBe(false);
  });
});
