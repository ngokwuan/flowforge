import { z } from 'zod';

export const updateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(100),
});
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;

// OWNER is deliberately not assignable here: ownership transfer is a separate,
// more careful operation that does not exist yet.
export const addMemberSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(['EDITOR', 'VIEWER']),
});
export type AddMemberInput = z.infer<typeof addMemberSchema>;
