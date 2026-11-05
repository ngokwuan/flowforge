import {
  topologicalOrder,
  type WorkflowEdge,
  type WorkflowNode,
} from '@flowforge/shared';
import {
  getNodeDefinition,
  NodeExecutionError,
  type NodeDefinition,
} from '@flowforge/node-sdk';
import { resolveTemplates, TemplateError } from './templates';
import type {
  ClaimedExecution,
  EngineLogger,
  ExecutionStore,
  FinalStatus,
  RunOutcome,
} from './types';

export interface RunOptions {
  store: ExecutionStore;
  /** Abort to cancel the run: running nodes see the signal, the rest are skipped. */
  signal?: AbortSignal;
  /** How many independent nodes may run at the same time. Default 4. */
  maxParallelism?: number;
  /** Largest serialized output a node may produce. Default 1,000,000 bytes. */
  maxOutputBytes?: number;
  /** Replaceable for tests. Defaults to the node-sdk registry. */
  resolveNode?: (type: string) => NodeDefinition | undefined;
  logger?: EngineLogger;
}

type StepOutcome = 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'SKIPPED';

/**
 * Runs one execution to the end. Only the worker that wins `store.claim` runs it,
 * so a job delivered twice cannot run a workflow twice.
 *
 * How the graph is walked:
 * - A node is READY when every node that points at it is finished (run or skipped).
 *   All ready nodes run at the same time, up to `maxParallelism`.
 * - An edge is ACTIVE when its source succeeded and, if the edge names a handle,
 *   the source chose that handle (If / Else picks "true" or "false").
 * - A node runs when at least one incoming edge is active, otherwise it is SKIPPED.
 *   So after an If / Else, the branch that was not taken is skipped, and a node
 *   where both branches meet still runs.
 * - A node's input is the output of its single active parent, or an object keyed
 *   by node id when several parents are active. The first node gets the run's input.
 * - The first failure stops scheduling. Nodes already running finish; everything
 *   not started is marked SKIPPED.
 */
export async function runExecution(
  executionId: string,
  options: RunOptions,
): Promise<RunOutcome> {
  const { store, logger } = options;

  const execution = await store.claim(executionId);
  if (!execution) return 'NOT_CLAIMED';

  try {
    return await run(execution, options);
  } catch (error) {
    // Storage or engine failure. Record it if the store still answers, and let the
    // caller know so the queue can react.
    logger?.error(`Execution ${executionId} crashed`, error);
    await store
      .finish(executionId, 'FAILED', 'Lỗi nội bộ khi chạy workflow')
      .catch(() => undefined);
    throw error;
  }
}

async function run(
  execution: ClaimedExecution,
  options: RunOptions,
): Promise<FinalStatus> {
  const { store, logger } = options;
  const signal = options.signal ?? new AbortController().signal;
  const resolveNode = options.resolveNode ?? getNodeDefinition;
  const maxParallelism = Math.max(1, options.maxParallelism ?? 4);
  const maxOutputBytes = options.maxOutputBytes ?? 1_000_000;

  const { id, definition } = execution;
  const nodes = definition.nodes;

  if (topologicalOrder(definition) === null) {
    await store.finish(id, 'FAILED', 'Workflow có vòng lặp');
    return 'FAILED';
  }
  await store.initSteps(
    id,
    nodes.map((node) => ({ id: node.id, type: node.type })),
  );

  const incoming = new Map<string, WorkflowEdge[]>(
    nodes.map((node) => [node.id, []]),
  );
  for (const edge of definition.edges) incoming.get(edge.target)?.push(edge);

  const state = new Map<string, 'SUCCESS' | 'FAILED' | 'SKIPPED'>();
  const results = new Map<string, { output: unknown; handle?: string }>();
  const triggerInput = execution.input ?? {};
  let failure: string | undefined;
  let cancelled = false;

  const isActive = (edge: WorkflowEdge) =>
    state.get(edge.source) === 'SUCCESS' &&
    (edge.sourceHandle === undefined ||
      edge.sourceHandle === (results.get(edge.source)?.handle ?? 'default'));

  async function processNode(node: WorkflowNode): Promise<StepOutcome> {
    const edges = incoming.get(node.id) ?? [];
    const isRoot = edges.length === 0;
    const active = edges.filter(isActive);

    if (!isRoot && active.length === 0) {
      state.set(node.id, 'SKIPPED');
      await store.finishStep(id, node.id, { status: 'SKIPPED', attempt: 0 });
      return 'SKIPPED';
    }

    const parents = [...new Set(active.map((edge) => edge.source))];
    const input = isRoot
      ? triggerInput
      : parents.length === 1
        ? results.get(parents[0])?.output
        : Object.fromEntries(
            parents.map((parent) => [parent, results.get(parent)?.output]),
          );

    await store.startStep(id, node.id, input);

    const fail = async (
      message: string,
      wasCancelled = false,
    ): Promise<StepOutcome> => {
      state.set(node.id, 'FAILED');
      await store.finishStep(id, node.id, {
        status: 'FAILED',
        error: message,
        attempt: 1,
      });
      if (wasCancelled) return 'CANCELLED';
      failure ??= `${node.name}: ${message}`;
      return 'FAILED';
    };

    const definitionOfNode = resolveNode(node.type);
    if (!definitionOfNode)
      return fail(`Loại node "${node.type}" không tồn tại`);

    // Expressions are resolved first, then the result is validated against the
    // node's schema. Validation happens here again because a value that only
    // exists now (a URL from a previous step) never passed the save-time checks.
    let resolved: unknown;
    try {
      const scope = {
        trigger: triggerInput,
        steps: Object.fromEntries(
          [...results].map(([stepId, r]) => [stepId, { output: r.output }]),
        ),
      };
      resolved = resolveTemplates(node.config, scope);
    } catch (error) {
      if (error instanceof TemplateError) return fail(error.message);
      throw error;
    }

    const parsed = definitionOfNode.configSchema.safeParse(resolved);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue.path.join('.');
      return fail(
        `Cấu hình không hợp lệ${where ? ` (${where})` : ''}: ${issue.message}`,
      );
    }

    let result;
    try {
      result = await definitionOfNode.execute({
        config: parsed.data,
        input,
        signal,
      });
    } catch (error) {
      if (signal.aborted) return fail('Bước đã bị hủy', true);
      if (error instanceof NodeExecutionError) return fail(error.message);
      // Anything else may carry internals (connection strings, stack traces).
      // It goes to the log, and the user only sees a generic message.
      logger?.error(`Node ${node.id} (${node.type}) crashed`, error);
      return fail('Node gặp lỗi không xác định');
    }

    const { handle } = result;
    if (handle !== undefined && !definitionOfNode.handles.includes(handle)) {
      return fail(`Node trả về nhánh không hợp lệ "${handle}"`);
    }

    const output = result.output ?? null;
    let size: number;
    try {
      size = new TextEncoder().encode(JSON.stringify(output)).length;
    } catch {
      return fail('Đầu ra của node không thể lưu lại');
    }
    if (size > maxOutputBytes) {
      return fail(`Đầu ra của node vượt quá giới hạn ${maxOutputBytes} byte`);
    }

    results.set(node.id, { output, handle });
    state.set(node.id, 'SUCCESS');
    await store.finishStep(id, node.id, {
      status: 'SUCCESS',
      output,
      attempt: 1,
    });
    return 'SUCCESS';
  }

  while (state.size < nodes.length) {
    if (signal.aborted) {
      cancelled = true;
      break;
    }
    if (failure) break;

    const ready = nodes.filter(
      (node) =>
        !state.has(node.id) &&
        (incoming.get(node.id) ?? []).every((edge) => state.has(edge.source)),
    );
    if (ready.length === 0) {
      failure = 'Không xác định được thứ tự chạy của workflow';
      break;
    }

    for (let start = 0; start < ready.length; start += maxParallelism) {
      const batch = ready.slice(start, start + maxParallelism);
      const outcomes = await Promise.all(batch.map(processNode));
      if (outcomes.includes('CANCELLED')) cancelled = true;
      if (cancelled || failure) break;
    }
  }

  for (const node of nodes) {
    if (!state.has(node.id)) {
      state.set(node.id, 'SKIPPED');
      await store.finishStep(id, node.id, { status: 'SKIPPED', attempt: 0 });
    }
  }

  const status: FinalStatus = cancelled
    ? 'CANCELLED'
    : failure
      ? 'FAILED'
      : 'SUCCESS';
  await store.finish(
    id,
    status,
    status === 'FAILED'
      ? failure
      : status === 'CANCELLED'
        ? 'Lần chạy đã bị hủy'
        : undefined,
  );
  return status;
}
