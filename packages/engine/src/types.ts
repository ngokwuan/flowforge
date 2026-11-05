import type { WorkflowDefinition } from '@flowforge/shared';

export type FinalStatus = 'SUCCESS' | 'FAILED' | 'CANCELLED';

// NOT_CLAIMED: another worker already took this execution (or it is finished).
export type RunOutcome = FinalStatus | 'NOT_CLAIMED';

export interface ClaimedExecution {
  id: string;
  workspaceId: string;
  definition: WorkflowDefinition; // the snapshot taken when the run was created
  input: Record<string, unknown> | null;
}

export interface StepFinish {
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  output?: unknown;
  error?: string;
  attempt: number;
}

/**
 * Everything the engine needs from storage. The worker implements it with the
 * database; tests use InMemoryExecutionStore. Keeping it this small is what lets
 * the engine be tested without a database.
 */
export interface ExecutionStore {
  /** Atomically moves QUEUED to RUNNING. Returns null when it was not QUEUED. */
  claim(executionId: string): Promise<ClaimedExecution | null>;
  initSteps(
    executionId: string,
    nodes: Array<{ id: string; type: string }>,
  ): Promise<void>;
  startStep(executionId: string, nodeId: string, input: unknown): Promise<void>;
  finishStep(
    executionId: string,
    nodeId: string,
    result: StepFinish,
  ): Promise<void>;
  finish(
    executionId: string,
    status: FinalStatus,
    error?: string,
  ): Promise<void>;
}

export interface EngineLogger {
  error(message: string, detail?: unknown): void;
}
