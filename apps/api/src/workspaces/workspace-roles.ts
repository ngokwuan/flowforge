import type { Role } from '@flowforge/shared';

// Higher rank can do everything a lower rank can.
export const ROLE_RANK: Record<Role, number> = {
  VIEWER: 1,
  EDITOR: 2,
  OWNER: 3,
};

export const REQUIRED_ROLE_KEY = 'workspace:requiredRole';

// What WorkspaceAccessGuard attaches to the request for handlers to use.
export interface WorkspaceMembership {
  workspaceId: string;
  role: Role;
}
