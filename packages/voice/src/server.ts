import { createGoalGateway } from './goal-gateway.ts';
import type { GoalResult } from '../../contracts/src/index.ts';

const { server } = createGoalGateway({
  // The Minecraft adapter will replace this fail-closed executor in its integration issue.
  execute: async (_goal, _signal): Promise<GoalResult> => ({
    status: 'failed',
    detail: 'Minecraft adapter is not connected yet.',
  }),
  isReady: () => false,
  onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
});

server.on('listening', () => process.stdout.write('Voice goal gateway listening on http://127.0.0.1:8001\n'));
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
