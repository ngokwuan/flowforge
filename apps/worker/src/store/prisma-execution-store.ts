import { Inject, Injectable } from '@nestjs/common';
import type {
  ClaimedExecution,
  ExecutionStore,
  FinalStatus,
  StepFinish,
} from '@flowforge/engine';
import type { WorkflowDefinition } from '@flowforge/shared';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

// A JSON column distinguishes "no value" (SQL NULL) from the JSON value null.
const toJson = (value: unknown) =>
  value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);

@Injectable()
export class PrismaExecutionStore implements ExecutionStore {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  // One UPDATE ... WHERE status = 'QUEUED'. The database decides who wins when
  // several workers try at once: exactly one gets count = 1.
  async claim(executionId: string): Promise<ClaimedExecution | null> {
    const { count } = await this.prisma.execution.updateMany({
      where: { id: executionId, status: 'QUEUED' },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    if (count === 0) return null;

    const row = await this.prisma.execution.findUnique({
      where: { id: executionId },
      select: { id: true, workspaceId: true, definition: true, input: true },
    });
    if (!row) return null;

    return {
      id: row.id,
      workspaceId: row.workspaceId,
      // Validated when the workflow was saved, then snapshotted into the execution.
      definition: row.definition as unknown as WorkflowDefinition,
      input: (row.input ?? null) as Record<string, unknown> | null,
    };
  }

  async initSteps(
    executionId: string,
    nodes: Array<{ id: string; type: string }>,
  ) {
    await this.prisma.executionStep.createMany({
      data: nodes.map((node) => ({
        executionId,
        nodeId: node.id,
        nodeType: node.type,
      })),
      skipDuplicates: true, // makes starting a step list safe to repeat
    });
  }

  async startStep(executionId: string, nodeId: string, input: unknown) {
    await this.prisma.executionStep.updateMany({
      where: { executionId, nodeId },
      data: {
        status: 'RUNNING',
        startedAt: new Date(),
        input: input === undefined ? undefined : toJson(input),
      },
    });
  }

  async finishStep(executionId: string, nodeId: string, result: StepFinish) {
    await this.prisma.executionStep.updateMany({
      where: { executionId, nodeId },
      data: {
        status: result.status,
        attempt: result.attempt,
        error: result.error ?? null,
        output: result.output === undefined ? undefined : toJson(result.output),
        finishedAt: new Date(),
      },
    });
  }

  // Only a RUNNING execution can finish, so a late call cannot overwrite a final state.
  async finish(executionId: string, status: FinalStatus, error?: string) {
    await this.prisma.execution.updateMany({
      where: { id: executionId, status: 'RUNNING' },
      data: { status, error: error ?? null, finishedAt: new Date() },
    });
  }
}
