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
