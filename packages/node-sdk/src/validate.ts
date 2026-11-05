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
            ...issue.path.map((part) =>
              typeof part === 'symbol' ? String(part) : part,
            ),
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
