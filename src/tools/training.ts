import type { Tool } from './interface.js';
import type { TrainingScheduler } from '../training/scheduler.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';

function isValidTimeFormat(time: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

export function createToggleTrainingTool(
  trainingScheduler: TrainingScheduler,
  configCenter: RuntimeConfigCenter,
): Tool {
  return {
    name: 'toggle_training',
    description: '开关训练调度器',
    inputSchema: {
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
      required: ['enabled'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const enabled = args.enabled as boolean;
        trainingScheduler.setEnabled(enabled);
        configCenter.set('training.enabled', enabled);
        await configCenter.save();
        const status = trainingScheduler.getStatus();
        return `Training scheduler ${enabled ? 'enabled' : 'disabled'}. Running: ${status.running}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export function createTrainingStatusTool(trainingScheduler: TrainingScheduler): Tool {
  return {
    name: 'training_status',
    description: '查看训练调度器状态',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        return JSON.stringify(trainingScheduler.getStatus(), null, 2);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export function createSetTrainingScheduleTool(
  trainingScheduler: TrainingScheduler,
  configCenter: RuntimeConfigCenter,
): Tool {
  return {
    name: 'set_training_schedule',
    description: '修改训练调度时间',
    inputSchema: {
      type: 'object',
      properties: { time: { type: 'string', description: 'HH:MM format' } },
      required: ['time'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const time = args.time as string;
        if (!isValidTimeFormat(time)) {
          return `Error: Invalid time format "${time}". Expected HH:MM (e.g., "03:00", "14:30")`;
        }
        trainingScheduler.setScheduleTime(time);
        configCenter.set('training.scheduleTime', time);
        await configCenter.save();
        const status = trainingScheduler.getStatus();
        return `Training schedule time set to ${time}. Next scheduled run: ${status.nextScheduled}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
