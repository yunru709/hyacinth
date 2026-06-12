/**
 * Example Greeter Plugin
 *
 * A minimal example plugin that registers a "hello" tool.
 * This demonstrates the plugin system end-to-end.
 */

/** @type {import('../../src/plugins/types.js').PluginDefinition} */
export default {
  id: 'example-greeter',
  name: 'Example Greeter',
  description: 'Registers a hello tool and a greeting skill',

  register: (api) => {
    // ── Register a tool ───────────────────────────────────────
    api.registerTool({
      name: 'hello',
      description: 'Greet the user with a friendly message',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name to greet',
          },
        },
        required: [],
      },
      execute: async (args) => {
        const name = args.name || 'world';
        return `Hello, ${name}! Greetings from the example-greeter plugin.`;
      },
    });

    api.logger.info('hello tool registered');

    // ── Register a skill ──────────────────────────────────────
    api.registerSkill({
      name: 'example-greeter-friendly',
      description: 'Greet the user warmly and ask about their day',
      promptTemplate: `You are a friendly assistant. Greet {{name}} warmly and ask about their day.`,
      relatedTools: ['hello'],
    });

    api.logger.info('example-greeter-friendly skill registered');
  },

  onActivate: async (api) => {
    api.logger.info('Plugin activated! Config:', api.getConfig());
  },

  onDeactivate: async (api) => {
    api.logger.info('Plugin deactivated. Goodbye!');
  },
};