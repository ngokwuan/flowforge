import { z } from 'zod';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/**
 * The input/output context passed between nodes during execution.
 * Each node receives the merged outputs of all upstream nodes.
 */
export type NodeContext = Record<string, unknown>;

/**
 * Every node's execute function receives this bag of arguments.
 */
export interface ExecuteArgs<TConfig = unknown> {
  /** Validated configuration for this node instance */
  config: TConfig;
  /** Merged output from all upstream nodes */
  input: NodeContext;
  /** Execution-scoped logger — messages go to the run log */
  log: (message: string, data?: unknown) => void;
}

/**
 * Return value of a node's execute function.
 * `output` is merged into the context for downstream nodes.
 */
export interface ExecuteResult {
  output: NodeContext;
}

// ---------------------------------------------------------------------------
// Node definition
// ---------------------------------------------------------------------------

/**
 * A NodeDefinition describes a single node type.
 *
 * - `configSchema` is a Zod schema. The frontend generates a form from it;
 *   the worker validates config before calling execute().
 * - `execute` is the runtime logic. It must be pure and side-effect-free
 *   aside from calling `log`.
 *
 * @example
 * ```ts
 * export const httpRequestNode: NodeDefinition<typeof configSchema> = {
 *   type: 'http-request',
 *   label: 'HTTP Request',
 *   category: 'integrations',
 *   configSchema,
 *   async execute({ config, input, log }) {
 *     log('fetching', config.url);
 *     const res = await fetch(config.url, { method: config.method });
 *     return { output: { body: await res.json(), status: res.status } };
 *   },
 * };
 * ```
 */
export interface NodeDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Unique machine identifier, e.g. "http-request" */
  type: string;
  /** Human-readable label shown on the canvas */
  label: string;
  /** Groups nodes in the sidebar picker */
  category: 'triggers' | 'logic' | 'integrations' | 'ai';
  /** Zod schema — used for form generation and runtime validation */
  configSchema: TSchema;
  /** Runtime logic */
  execute(args: ExecuteArgs<z.infer<TSchema>>): Promise<ExecuteResult>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, NodeDefinition>();

/** Register a node so it is discoverable by the worker and the UI. */
export function registerNode(def: NodeDefinition): void {
  if (registry.has(def.type)) {
    throw new Error(`Node type "${def.type}" is already registered.`);
  }
  registry.set(def.type, def);
}

/** Look up a registered node by its type string. */
export function getNode(type: string): NodeDefinition | undefined {
  return registry.get(type);
}

/** Return all registered node definitions (for the sidebar picker). */
export function getAllNodes(): NodeDefinition[] {
  return Array.from(registry.values());
}
