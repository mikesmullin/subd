import { globals } from '../../common/globals.mjs';
import { CoreTools } from './tools.mjs';

export class CorePlugin {
  constructor() {
    globals.pluginsRegistry.set('core', this);
    this.tools = new CoreTools(this);
    this.registerTools();
  }

  registerTools() {
    globals.dslRegistry.set('core__memory_context', this.tools.context.bind(this.tools));
  }

  get definition() {
    return this.tools.definition;
  }
}

export const corePlugin = new CorePlugin();
