import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../src/prisma/prisma.service.js';

type NodeSpec = [id: string, type: string, config?: Record<string, unknown>];
type EdgeSpec = [source: string, target: string, handle?: string];

export const wf = (nodes: NodeSpec[], edges: EdgeSpec[]) => ({
  nodes: nodes.map(([id, type, config]) => ({
    id,
    type,
    name: `Node ${id}`,
    config: config ?? {},
    position: { x: 0, y: 0 },
  })),
  edges: edges.map(([source, target, handle], i) => ({
    id: `e${i}`,
    source,
    target,
    ...(handle ? { sourceHandle: handle } : {}),
  })),
});

export const TRIGGER: NodeSpec = ['t', 'trigger.manual'];

// trigger -> big? --true--> review
//                 \-false--> auto      (all real nodes from node-sdk)
export const approvalFlow = () =>
  wf(
    [
      TRIGGER,
      [
        'big',
        'logic.if',
        { left: '{{ trigger.amount }}', operator: 'gt', right: 100 },
      ],
      [
        'review',
        'logic.if',
        { left: 'review', operator: 'equals', right: 'review' },
      ],
      ['auto', 'logic.if', { left: 'auto', operator: 'equals', right: 'auto' }],
    ],
    [
      ['t', 'big'],
      ['big', 'review', 'true'],
      ['big', 'auto', 'false'],
    ],
  );

const workspaceIds: string[] = [];

export async function seedExecution(
  prisma: PrismaService,
  definition: object,
  options: { input?: object; queuedAt?: Date } = {},
) {
  const suffix = randomUUID();
  const workspace = await prisma.workspace.create({
    data: { name: 'Test', slug: `test-${suffix}` },
  });
  workspaceIds.push(workspace.id);

  const workflow = await prisma.workflow.create({
    data: {
      workspaceId: workspace.id,
      name: 'Flow',
      definition: definition as never,
    },
  });
  const execution = await prisma.execution.create({
    data: {
      workspaceId: workspace.id,
      workflowId: workflow.id,
      workflowVersion: 1,
      definition: definition as never,
      trigger: 'MANUAL',
      input: options.input as never,
      queuedAt: options.queuedAt,
    },
  });
  return { executionId: execution.id, workspaceId: workspace.id };
}

// Deleting a workspace cascades to its workflows, executions and steps.
export async function cleanup(prisma: PrismaService) {
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
}

export async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out. Last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export const FINAL = ['SUCCESS', 'FAILED', 'CANCELLED'];
