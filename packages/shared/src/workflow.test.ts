import { describe, expect, it } from 'vitest';
import {
  topologicalOrder,
  validateWorkflowGraph,
  workflowDefinitionSchema,
  type WorkflowDefinition,
} from './workflow';

const node = (id: string, type = 'http.request') => ({
  id,
  type,
  name: id,
  config: {},
  position: { x: 0, y: 0 },
});
const edge = (source: string, target: string) => ({
  id: `${source}-${target}`,
  source,
  target,
});
const trigger = (id = 't') => node(id, 'trigger.manual');
const def = (
  nodes: ReturnType<typeof node>[],
  edges: ReturnType<typeof edge>[],
): WorkflowDefinition => ({ nodes, edges });
const codes = (d: WorkflowDefinition) =>
  validateWorkflowGraph(d).map((issue) => issue.code);

describe('validateWorkflowGraph', () => {
  it('accepts a valid linear workflow', () => {
    const d = def(
      [trigger(), node('a'), node('b')],
      [edge('t', 'a'), edge('a', 'b')],
    );
    expect(validateWorkflowGraph(d)).toEqual([]);
  });

  it('accepts parallel branches that rejoin, and orders them correctly', () => {
    const d = def(
      [trigger(), node('a'), node('b'), node('c')],
      [edge('t', 'a'), edge('t', 'b'), edge('a', 'c'), edge('b', 'c')],
    );
    expect(validateWorkflowGraph(d)).toEqual([]);
    const order = topologicalOrder(d)!;
    expect(order[0]).toBe('t');
    expect(order[3]).toBe('c');
  });

  it('requires a trigger', () => {
    expect(codes(def([node('a')], []))).toContain('NO_TRIGGER');
  });

  it('rejects more than one trigger', () => {
    const d = def([trigger('t1'), trigger('t2')], []);
    expect(codes(d)).toContain('MULTIPLE_TRIGGERS');
  });

  it('rejects an edge into the trigger', () => {
    const d = def([trigger(), node('a')], [edge('t', 'a'), edge('a', 't')]);
    expect(codes(d)).toContain('TRIGGER_HAS_INPUT');
  });

  it('detects a cycle', () => {
    const d = def(
      [trigger(), node('a'), node('b')],
      [edge('t', 'a'), edge('a', 'b'), edge('b', 'a')],
    );
    expect(codes(d)).toContain('CYCLE');
  });

  it('detects a self loop', () => {
    const d = def([trigger(), node('a')], [edge('t', 'a'), edge('a', 'a')]);
    expect(codes(d)).toContain('SELF_LOOP');
  });

  it('detects an edge to an unknown node', () => {
    const d = def([trigger()], [edge('t', 'ghost')]);
    expect(codes(d)).toContain('EDGE_UNKNOWN_NODE');
  });

  it('detects duplicate node ids', () => {
    const d = def([trigger(), node('a'), node('a')], [edge('t', 'a')]);
    expect(codes(d)).toContain('DUPLICATE_NODE_ID');
  });

  it('reports every node that cannot be reached from the trigger', () => {
    const d = def(
      [trigger(), node('a'), node('b'), node('c')],
      [edge('t', 'a'), edge('b', 'c')],
    );
    const unreachable = validateWorkflowGraph(d).filter(
      (issue) => issue.code === 'UNREACHABLE_NODE',
    );
    expect(unreachable.map((issue) => issue.path)).toEqual([
      ['nodes', 2],
      ['nodes', 3],
    ]);
  });
});

describe('workflowDefinitionSchema', () => {
  const valid = {
    nodes: [
      { id: 't', type: 'trigger.manual', name: 'Start' },
      { id: 'a', type: 'http.request', name: 'Call API' },
    ],
    edges: [{ id: 'e1', source: 't', target: 'a' }],
  };

  it('applies defaults for config and position', () => {
    const parsed = workflowDefinitionSchema.parse(valid);
    expect(parsed.nodes[1].config).toEqual({});
    expect(parsed.nodes[1].position).toEqual({ x: 0, y: 0 });
  });

  it('rejects an id with spaces and points at it', () => {
    const bad = structuredClone(valid);
    bad.nodes[1].id = 'has space';
    const result = workflowDefinitionSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['nodes', 1, 'id']);
    }
  });

  it('reports graph problems as validation issues with a path', () => {
    const island = structuredClone(valid);
    island.nodes.push({ id: 'x', type: 'http.request', name: 'Lonely' });
    const result = workflowDefinitionSchema.safeParse(island);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['nodes', 2]);
    }
  });

  it('rejects an empty node list', () => {
    expect(
      workflowDefinitionSchema.safeParse({ nodes: [], edges: [] }).success,
    ).toBe(false);
  });
});

describe('topologicalOrder', () => {
  it('returns null for a cycle', () => {
    const d = def([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a')]);
    expect(topologicalOrder(d)).toBeNull();
  });

  it('puts every node after all of its predecessors', () => {
    const d = def(
      [node('e'), node('d'), node('c'), node('b'), node('a')],
      [
        edge('a', 'b'),
        edge('a', 'c'),
        edge('b', 'd'),
        edge('c', 'd'),
        edge('d', 'e'),
      ],
    );
    const order = topologicalOrder(d)!;
    expect(order).toHaveLength(5);
    for (const e of d.edges) {
      expect(order.indexOf(e.source)).toBeLessThan(order.indexOf(e.target));
    }
  });
});
