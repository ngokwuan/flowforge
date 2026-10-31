import { z } from 'zod';
import { defineNode } from '../types';

// Starts a run by hand. The input given when the run was created becomes its output.
export const triggerManualNode = defineNode({
  type: 'trigger.manual',
  name: 'Manual trigger',
  category: 'trigger',
  description: 'Starts the workflow when someone runs it by hand.',
  configSchema: z.object({}),
  handles: ['default'],
  async execute({ input }) {
    return { output: input ?? {} };
  },
});
