import { CoreContext } from './context.mjs';

export class CoreTools {
  constructor(plugin) {
    this.plugin = plugin;
    this.coreContext = new CoreContext(plugin);
  }

  async context(args, context) {
    return await this.coreContext.context(args, context);
  }

  get definition() {
    return [
      {
        type: 'function',
        function: {
          name: 'core__memory_context',
          description: 'Show agent context window memory usage report.',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Optional session id.' }
            }
          }
        },
        metadata: {
          help: 'context [id]',
          alias: (args) => {
            if (args.length >= 1 && args[0] === 'context') {
              return { name: 'core__memory_context', args: { id: args[1] } };
            }
            return false;
          }
        }
      }
    ];
  }
}
