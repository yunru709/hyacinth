export type {
  ChannelHandler,
  ChannelConfig,
  ChannelEvent,
  ChannelMessageEvent,
  ChannelConnectedEvent,
  ChannelDisconnectedEvent,
  ChannelErrorEvent,
  ChannelReply,
  ChannelState,
  ChannelStatus,
  AgentFactory,
  ReplyFn,
} from './interface.js';

export { ChannelManager } from './manager.js';
export { MessageQueue, QueueMessageMode } from './message-queue.js';
export type { QueueItem } from './message-queue.js';