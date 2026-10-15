import { z } from 'zod';

// Node types that start a workflow look like "trigger.webhook", "trigger.cron".
export const TRIGGER_PREFIX = 'trigger.';
export const isTriggerType = (type: string) => type.startsWith(TRIGGER_PREFIX);

const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Chỉ dùng chữ, số, gạch ngang và gạch dưới');

export const workflowNodeSchema = z.object({
  id: idSchema,
  type: z.string().min(1).max(100), // e.g. "http.request", "logic.if"
  name: z.string().trim().min(1).max(100),
  config: z.record(z.string(), z.unknown()).default({}),
  position: z
    .object({ x: z.number(), y: z.number() })
    .default({ x: 0, y: 0 }),
});

export const workflowEdgeSchema = z.object({
  id: idSchema,
  source: idSchema,
  target: idSchema,
  // Which output of the source node this edge leaves from (e.g. "true"/"false").
  sourceHandle: z.string().max(50).optional(),
});

export const workflowStructureSchema = z.object({
  nodes: z.array(workflowNodeSchema).min(1).max(100),
  edges: z.array(workflowEdgeSchema).max(300),
});

export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;
export type WorkflowDefinition = z.infer<typeof workflowStructureSchema>;

export type GraphIssueCode =
  | 'DUPLICATE_NODE_ID'
  | 'DUPLICATE_EDGE_ID'
  | 'EDGE_UNKNOWN_NODE'
  | 'SELF_LOOP'
  | 'NO_TRIGGER'
  | 'MULTIPLE_TRIGGERS'
  | 'TRIGGER_HAS_INPUT'
  | 'CYCLE'
  | 'UNREACHABLE_NODE';

export interface GraphIssue {
  code: GraphIssueCode;
  message: string;
  path: (string | number)[];
}

/**
 * Kahn's algorithm. Returns node ids so that every node comes after all of its
 * predecessors, or null when the graph has a cycle. Ties keep the order of
 * `nodes`, so the result is deterministic. Edges that point to unknown nodes are
 * ignored here; validateWorkflowGraph reports them.
 */
export function topologicalOrder(
  def: Pick<WorkflowDefinition, 'nodes' | 'edges'>,
): string[] | null {
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of def.nodes) {
    inDegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const edge of def.edges) {
    if (!inDegree.has(edge.source) || !inDegree.has(edge.target)) continue;
    outgoing.get(edge.source)!.push(edge.target);
    inDegree.set(edge.target, inDegree.get(edge.target)! + 1);
  }

  const queue = def.nodes
    .filter((node) => inDegree.get(node.id) === 0)
    .map((node) => node.id);
  const order: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of outgoing.get(id)!) {
      const remaining = inDegree.get(next)! - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  return order.length === def.nodes.length ? order : null;
}

function reachableFrom(
  startId: string,
  edges: WorkflowEdge[],
): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge.target);
    outgoing.set(edge.source, list);
  }

  const seen = new Set<string>([startId]);
  const stack = [startId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const next of outgoing.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

/** Checks the rules a runnable workflow graph must satisfy. Empty array = valid. */
export function validateWorkflowGraph(def: WorkflowDefinition): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const nodeIds = new Set<string>();

  def.nodes.forEach((node, i) => {
    if (nodeIds.has(node.id)) {
      issues.push({
        code: 'DUPLICATE_NODE_ID',
        message: `Trùng id node "${node.id}"`,
        path: ['nodes', i, 'id'],
      });
    }
    nodeIds.add(node.id);
  });

  const edgeIds = new Set<string>();
  def.edges.forEach((edge, i) => {
    if (edgeIds.has(edge.id)) {
      issues.push({
        code: 'DUPLICATE_EDGE_ID',
        message: `Trùng id cạnh "${edge.id}"`,
        path: ['edges', i, 'id'],
      });
    }
    edgeIds.add(edge.id);

    for (const end of ['source', 'target'] as const) {
      if (!nodeIds.has(edge[end])) {
        issues.push({
          code: 'EDGE_UNKNOWN_NODE',
          message: `Cạnh "${edge.id}" trỏ tới node không tồn tại "${edge[end]}"`,
          path: ['edges', i, end],
        });
      }
    }

    if (edge.source === edge.target) {
      issues.push({
        code: 'SELF_LOOP',
        message: `Node "${edge.source}" không thể nối với chính nó`,
        path: ['edges', i],
      });
    }
  });

  const triggers = def.nodes.filter((node) => isTriggerType(node.type));
  if (triggers.length === 0) {
    issues.push({
      code: 'NO_TRIGGER',
      message: 'Workflow cần đúng một node trigger',
      path: ['nodes'],
    });
  } else if (triggers.length > 1) {
    issues.push({
      code: 'MULTIPLE_TRIGGERS',
      message: 'Workflow chỉ được có một node trigger',
      path: ['nodes'],
    });
  }

  const triggerIds = new Set(triggers.map((node) => node.id));
  def.edges.forEach((edge, i) => {
    if (triggerIds.has(edge.target)) {
      issues.push({
        code: 'TRIGGER_HAS_INPUT',
        message: 'Không thể nối vào node trigger',
        path: ['edges', i, 'target'],
      });
    }
  });

  // Cycle and reachability results are only meaningful when ids and edges are sound.
  const sound = !issues.some(
    (issue) =>
      issue.code === 'DUPLICATE_NODE_ID' || issue.code === 'EDGE_UNKNOWN_NODE',
  );
  if (sound) {
    if (topologicalOrder(def) === null) {
      issues.push({
        code: 'CYCLE',
        message: 'Workflow có vòng lặp, chưa hỗ trợ',
        path: ['edges'],
      });
    } else if (triggers.length === 1) {
      const reachable = reachableFrom(triggers[0].id, def.edges);
      def.nodes.forEach((node, i) => {
        if (!reachable.has(node.id)) {
          issues.push({
            code: 'UNREACHABLE_NODE',
            message: `Node "${node.id}" không nối được tới trigger`,
            path: ['nodes', i],
          });
        }
      });
    }
  }

  return issues;
}

// The schema the API validates against: structure first, then the graph rules.
// Graph problems surface as ordinary validation errors with a path to the culprit.
export const workflowDefinitionSchema = workflowStructureSchema.superRefine(
  (def, ctx) => {
    for (const issue of validateWorkflowGraph(def)) {
      ctx.addIssue({
        code: 'custom',
        message: issue.message,
        path: issue.path,
      });
    }
  },
);
