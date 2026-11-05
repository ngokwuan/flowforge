import type { WorkflowDefinition } from '@flowforge/shared';
import type {
  ClaimedExecution,
  ExecutionStore,
  FinalStatus,
  StepFinish,
} from './types';

export interface StepRecord {
  nodeId: string;
  nodeType: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';
  attempt: number;
  input?: unknown;
  output?: unknown;
  error?: string;
}

interface ExecutionRecord extends ClaimedExecution {
  status: 'QUEUED' | 'RUNNING' | FinalStatus;
  error?: string;
}

/** Keeps everything in memory. For tests of the engine and of code built on it. */
export class InMemoryExecutionStore implements ExecutionStore {
  readonly executions = new Map<string, ExecutionRecord>();
  private readonly steps = new Map<string, StepRecord>();

  add(execution: {
    id: string;
    definition: WorkflowDefinition;
    input?: Record<string, unknown> | null;
    workspaceId?: string;
  }) {
    this.executions.set(execution.id, {
      id: execution.id,
      workspaceId: execution.workspaceId ?? 'workspace-1',
      definition: execution.definition,
      input: execution.input ?? null,
      status: 'QUEUED',
    });
  }

  // The body has no await, so check-and-set cannot interleave with another claim.
  async claim(executionId: string): Promise<ClaimedExecution | null> {
    const execution = this.executions.get(executionId);
    if (!execution || execution.status !== 'QUEUED') return null;
    execution.status = 'RUNNING';
    return { ...execution };
  }

  async initSteps(
    executionId: string,
    nodes: Array<{ id: string; type: string }>,
  ) {
    for (const node of nodes) {
      this.steps.set(`${executionId}:${node.id}`, {
        nodeId: node.id,
        nodeType: node.type,
        status: 'PENDING',
        attempt: 0,
      });
    }
  }

  async startStep(executionId: string, nodeId: string, input: unknown) {
    Object.assign(this.require(executionId, nodeId), {
      status: 'RUNNING',
      input,
    });
  }

  async finishStep(executionId: string, nodeId: string, result: StepFinish) {
    Object.assign(this.require(executionId, nodeId), result);
  }

  async finish(executionId: string, status: FinalStatus, error?: string) {
    const execution = this.executions.get(executionId);
    if (execution) Object.assign(execution, { status, error });
  }

  statusOf(executionId: string) {
    return this.executions.get(executionId)?.status;
  }

  errorOf(executionId: string) {
    return this.executions.get(executionId)?.error;
  }

  step(executionId: string, nodeId: string) {
    return this.steps.get(`${executionId}:${nodeId}`);
  }

  stepsOf(executionId: string) {
    return [...this.steps.entries()]
      .filter(([key]) => key.startsWith(`${executionId}:`))
      .map(([, step]) => step);
  }

  private require(executionId: string, nodeId: string) {
    const step = this.steps.get(`${executionId}:${nodeId}`);
    if (!step) throw new Error(`Unknown step ${nodeId}`);
    return step;
  }
}
