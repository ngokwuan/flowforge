import { z } from 'zod';
import { httpRequestNode } from './nodes/http-request';
import { logicIfNode } from './nodes/logic-if';
import { triggerManualNode } from './nodes/trigger-manual';
import type { NodeDefinition } from './types';

// Adding a node type means adding one file under nodes/ and one line here.
const definitions: NodeDefinition[] = [
  triggerManualNode,
  logicIfNode,
  httpRequestNode,
];

const byType = new Map(
  definitions.map((definition) => [definition.type, definition]),
);

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
