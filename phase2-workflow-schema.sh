#!/usr/bin/env bash
# FlowForge Phase 2.1: workflow definition, graph validation, database models.
# Run from the repo root:  bash phase2-workflow-schema.sh
# NEW files are skipped if they exist. Files marked "force" are overwritten.
# prisma/schema.prisma is EDITED in place (idempotent). Commit first.
set -e

write() {
  if [ -e "$1" ]; then
    echo "skip      $1 (already exists)"
    cat > /dev/null
  else
    mkdir -p "$(dirname "$1")"
    cat > "$1"
    echo "create    $1"
  fi
}

write_force() {
  mkdir -p "$(dirname "$1")"
  if [ -e "$1" ]; then echo "overwrite $1"; else echo "create    $1"; fi
  cat > "$1"
}

[ -f apps/api/prisma/schema.prisma ] || { echo "apps/api/prisma/schema.prisma not found"; exit 1; }

# ---------- Shared: workflow definition + graph validation ----------

write packages/shared/src/workflow.ts <<'EOF'
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
EOF

if ! grep -q "'./workflow'" packages/shared/src/index.ts; then
  echo "export * from './workflow';" >> packages/shared/src/index.ts
  echo "append    packages/shared/src/index.ts (export workflow)"
fi

write_force packages/shared/tsconfig.json <<'EOF'
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
EOF

node -e "
const fs = require('fs');
const f = 'packages/shared/package.json';
const p = JSON.parse(fs.readFileSync(f, 'utf8'));
p.scripts = { ...p.scripts, test: 'vitest run' };
fs.writeFileSync(f, JSON.stringify(p, null, 2) + '\n');
"
echo "edit      packages/shared/package.json (test script)"

write packages/shared/src/workflow.test.ts <<'EOF'
import { describe, expect, it } from 'vitest';
import {
  topologicalOrder,
  validateWorkflowGraph,
  workflowDefinitionSchema,
  type WorkflowDefinition,
} from './workflow';

const node = (id: string, type = 'http.request') => ({
  id,
  type,
  name: id,
  config: {},
  position: { x: 0, y: 0 },
});
const edge = (source: string, target: string) => ({
  id: `${source}-${target}`,
  source,
  target,
});
const trigger = (id = 't') => node(id, 'trigger.manual');
const def = (
  nodes: ReturnType<typeof node>[],
  edges: ReturnType<typeof edge>[],
): WorkflowDefinition => ({ nodes, edges });
const codes = (d: WorkflowDefinition) =>
  validateWorkflowGraph(d).map((issue) => issue.code);

describe('validateWorkflowGraph', () => {
  it('accepts a valid linear workflow', () => {
    const d = def([trigger(), node('a'), node('b')], [edge('t', 'a'), edge('a', 'b')]);
    expect(validateWorkflowGraph(d)).toEqual([]);
  });

  it('accepts parallel branches that rejoin, and orders them correctly', () => {
    const d = def(
      [trigger(), node('a'), node('b'), node('c')],
      [edge('t', 'a'), edge('t', 'b'), edge('a', 'c'), edge('b', 'c')],
    );
    expect(validateWorkflowGraph(d)).toEqual([]);
    const order = topologicalOrder(d)!;
    expect(order[0]).toBe('t');
    expect(order[3]).toBe('c');
  });

  it('requires a trigger', () => {
    expect(codes(def([node('a')], []))).toContain('NO_TRIGGER');
  });

  it('rejects more than one trigger', () => {
    const d = def([trigger('t1'), trigger('t2')], []);
    expect(codes(d)).toContain('MULTIPLE_TRIGGERS');
  });

  it('rejects an edge into the trigger', () => {
    const d = def([trigger(), node('a')], [edge('t', 'a'), edge('a', 't')]);
    expect(codes(d)).toContain('TRIGGER_HAS_INPUT');
  });

  it('detects a cycle', () => {
    const d = def(
      [trigger(), node('a'), node('b')],
      [edge('t', 'a'), edge('a', 'b'), edge('b', 'a')],
    );
    expect(codes(d)).toContain('CYCLE');
  });

  it('detects a self loop', () => {
    const d = def([trigger(), node('a')], [edge('t', 'a'), edge('a', 'a')]);
    expect(codes(d)).toContain('SELF_LOOP');
  });

  it('detects an edge to an unknown node', () => {
    const d = def([trigger()], [edge('t', 'ghost')]);
    expect(codes(d)).toContain('EDGE_UNKNOWN_NODE');
  });

  it('detects duplicate node ids', () => {
    const d = def([trigger(), node('a'), node('a')], [edge('t', 'a')]);
    expect(codes(d)).toContain('DUPLICATE_NODE_ID');
  });

  it('reports every node that cannot be reached from the trigger', () => {
    const d = def(
      [trigger(), node('a'), node('b'), node('c')],
      [edge('t', 'a'), edge('b', 'c')],
    );
    const unreachable = validateWorkflowGraph(d).filter(
      (issue) => issue.code === 'UNREACHABLE_NODE',
    );
    expect(unreachable.map((issue) => issue.path)).toEqual([
      ['nodes', 2],
      ['nodes', 3],
    ]);
  });
});

describe('workflowDefinitionSchema', () => {
  const valid = {
    nodes: [
      { id: 't', type: 'trigger.manual', name: 'Start' },
      { id: 'a', type: 'http.request', name: 'Call API' },
    ],
    edges: [{ id: 'e1', source: 't', target: 'a' }],
  };

  it('applies defaults for config and position', () => {
    const parsed = workflowDefinitionSchema.parse(valid);
    expect(parsed.nodes[1].config).toEqual({});
    expect(parsed.nodes[1].position).toEqual({ x: 0, y: 0 });
  });

  it('rejects an id with spaces and points at it', () => {
    const bad = structuredClone(valid);
    bad.nodes[1].id = 'has space';
    const result = workflowDefinitionSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['nodes', 1, 'id']);
    }
  });

  it('reports graph problems as validation issues with a path', () => {
    const island = structuredClone(valid);
    island.nodes.push({ id: 'x', type: 'http.request', name: 'Lonely' });
    const result = workflowDefinitionSchema.safeParse(island);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['nodes', 2]);
    }
  });

  it('rejects an empty node list', () => {
    expect(workflowDefinitionSchema.safeParse({ nodes: [], edges: [] }).success).toBe(false);
  });
});

describe('topologicalOrder', () => {
  it('returns null for a cycle', () => {
    const d = def([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a')]);
    expect(topologicalOrder(d)).toBeNull();
  });

  it('puts every node after all of its predecessors', () => {
    const d = def(
      [node('e'), node('d'), node('c'), node('b'), node('a')],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd'), edge('d', 'e')],
    );
    const order = topologicalOrder(d)!;
    expect(order).toHaveLength(5);
    for (const e of d.edges) {
      expect(order.indexOf(e.source)).toBeLessThan(order.indexOf(e.target));
    }
  });
});
EOF

# ---------- Database models ----------

node - <<'NODE'
const fs = require('fs');
const file = 'apps/api/prisma/schema.prisma';
let s = fs.readFileSync(file, 'utf8');

function addFields(model, fields) {
  const re = new RegExp('(model ' + model + ' \\{[\\s\\S]*?)(\\n\\})');
  const m = s.match(re);
  if (!m) throw new Error('model ' + model + ' not found in schema.prisma');
  const missing = fields.filter(
    (f) => !new RegExp('\\n\\s*' + f.name + '\\s').test(m[1]),
  );
  if (missing.length === 0) return;
  s = s.replace(re, (_all, body, end) =>
    body + '\n' + missing.map((f) => '  ' + f.line).join('\n') + end,
  );
  console.log('edit      schema.prisma: ' + model + ' += ' + missing.map((f) => f.name).join(', '));
}

addFields('Workspace', [
  { name: 'workflows', line: 'workflows   Workflow[]' },
  { name: 'executions', line: 'executions  Execution[]' },
]);
addFields('User', [
  { name: 'workflowsCreated', line: 'workflowsCreated Workflow[]' },
]);

if (!/model Workflow \{/.test(s)) {
  s += `
enum ExecutionStatus {
  QUEUED
  RUNNING
  SUCCESS
  FAILED
  CANCELLED
}

enum StepStatus {
  PENDING
  RUNNING
  SUCCESS
  FAILED
  SKIPPED
}

enum TriggerType {
  MANUAL
  WEBHOOK
  CRON
}

model Workflow {
  id          String   @id @default(uuid())
  workspaceId String
  name        String
  description String?
  // Nodes and edges, validated by workflowDefinitionSchema before every save.
  definition  Json
  // Bumped on every save; updates carry the version they read (optimistic locking).
  version     Int      @default(1)
  isActive    Boolean  @default(false)
  createdById String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  workspace   Workspace   @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  createdBy   User?       @relation(fields: [createdById], references: [id], onDelete: SetNull)
  executions  Execution[]

  @@index([workspaceId, updatedAt])
}

model Execution {
  id              String          @id @default(uuid())
  // Denormalized from the workflow so tenant-scoped queries need no join.
  workspaceId     String
  workflowId      String
  workflowVersion Int
  // Snapshot taken when the run is created: editing the workflow later must not
  // change a run that is queued, running, or already finished.
  definition      Json
  status          ExecutionStatus @default(QUEUED)
  trigger         TriggerType
  input           Json?
  error           String?
  // Lets a webhook delivered twice create only one execution.
  idempotencyKey  String?
  queuedAt        DateTime        @default(now())
  startedAt       DateTime?
  finishedAt      DateTime?
  workspace       Workspace       @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  workflow        Workflow        @relation(fields: [workflowId], references: [id], onDelete: Cascade)
  steps           ExecutionStep[]

  @@unique([workflowId, idempotencyKey])
  @@index([workspaceId, queuedAt])
  @@index([workflowId, queuedAt])
}

model ExecutionStep {
  id          String     @id @default(uuid())
  executionId String
  nodeId      String
  nodeType    String
  status      StepStatus @default(PENDING)
  attempt     Int        @default(0)
  input       Json?
  output      Json?
  error       String?
  startedAt   DateTime?
  finishedAt  DateTime?
  execution   Execution  @relation(fields: [executionId], references: [id], onDelete: Cascade)

  @@unique([executionId, nodeId])
  @@index([executionId])
}
`;
  console.log('edit      schema.prisma: added Workflow, Execution, ExecutionStep and enums');
} else {
  console.log('skip      schema.prisma (Workflow model already present)');
}

fs.writeFileSync(file, s);
NODE

echo
echo "Done. Next steps are in the chat."