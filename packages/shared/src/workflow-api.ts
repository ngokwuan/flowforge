import { z } from 'zod';
import { workflowDefinitionSchema } from './workflow';

export const createWorkflowSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  definition: workflowDefinitionSchema,
});
export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;

// `version` is the version the client last read. The update only applies if the
// workflow is still at that version (optimistic locking).
export const updateWorkflowSchema = z
  .object({
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(), // null clears it
    definition: workflowDefinitionSchema.optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.description !== undefined ||
      body.definition !== undefined,
    { message: 'Cần ít nhất một trường để cập nhật', path: [] },
  );
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowSchema>;

export const listWorkflowsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(100).optional(),
});
export type ListWorkflowsQuery = z.infer<typeof listWorkflowsQuerySchema>;
