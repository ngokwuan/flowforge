import { describe, expect, it } from 'vitest';
import { getNodeDefinition, listNodeTypes } from './registry';
import { normalizeNodeConfigs } from './validate';

const node = (
  id: string,
  type: string,
  config: Record<string, unknown> = {},
) => ({
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
    expect(types.map((t) => t.type).sort()).toEqual([
      'http.request',
      'logic.if',
      'trigger.manual',
    ]);

    const http = types.find((t) => t.type === 'http.request')!;
    expect(http.configSchema).toMatchObject({ type: 'object' });
    expect(
      Object.keys((http.configSchema as { properties: object }).properties),
    ).toContain('url');
    expect((http.configSchema as { required: string[] }).required).toContain(
      'url',
    );
    expect(types.find((t) => t.type === 'logic.if')!.handles).toEqual([
      'true',
      'false',
    ]);
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
      nodes: [
        node('t', 'trigger.manual'),
        node('a', 'http.request', { url: 'https://example.com' }),
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.nodes[1].config).toMatchObject({
        method: 'GET',
        timeoutMs: 10000,
      });
    }
  });

  it('reports an unknown node type with a path to it', () => {
    const result = normalizeNodeConfigs({
      nodes: [node('t', 'trigger.manual'), node('x', 'nope.nope')],
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: 'UNKNOWN_NODE_TYPE', path: ['nodes', 1, 'type'] }],
    });
  });

  it('reports a bad config with a path into the config', () => {
    const result = normalizeNodeConfigs({
      nodes: [node('a', 'http.request', {})],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]).toMatchObject({
        code: 'INVALID_NODE_CONFIG',
        path: ['nodes', 0, 'config', 'url'],
      });
    }
  });

  it('collects the issues of every node, not only the first', () => {
    const result = normalizeNodeConfigs({
      nodes: [
        node('a', 'http.request', {}),
        node('b', 'logic.if', { operator: 'bogus' }),
        node('c', 'zzz'),
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const bad = new Set(result.issues.map((i) => i.path[1]));
      expect(bad).toEqual(new Set([0, 1, 2]));
    }
  });
});
