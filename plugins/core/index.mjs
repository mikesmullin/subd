import { globals } from '../../common/globals.mjs';
import { CoreTools } from './tools.mjs';

export class CorePlugin {
  constructor() {
    globals.pluginsRegistry.set('core', this);
    this.tools = new CoreTools(this);
    this.registerTools();
  }

  registerTools() {
    globals.dslRegistry.set('core__help', this.tools.help.bind(this.tools));
    globals.humanOnlyTools.add('core__help');
    
    globals.dslRegistry.set('core__widgets__list', this.tools.listWidgets.bind(this.tools));
    globals.humanOnlyTools.add('core__widgets__list');
    
    // Config management tools
    globals.dslRegistry.set('core__config__set', this.tools.configSet.bind(this.tools));
    globals.humanOnlyTools.add('core__config__set');
    
    globals.dslRegistry.set('core__config__get', this.tools.configGet.bind(this.tools));
    globals.humanOnlyTools.add('core__config__get');
    
    globals.dslRegistry.set('core__config__list', this.tools.configList.bind(this.tools));
    globals.humanOnlyTools.add('core__config__list');
    
    globals.dslRegistry.set('core__config__save', this.tools.configSave.bind(this.tools));
    globals.humanOnlyTools.add('core__config__save');
    
    globals.dslRegistry.set('core__config__load', this.tools.configLoad.bind(this.tools));
    globals.humanOnlyTools.add('core__config__load');
    
    globals.dslRegistry.set('core__config__reset', this.tools.configReset.bind(this.tools));
    globals.humanOnlyTools.add('core__config__reset');
    
    // System management tools
    globals.dslRegistry.set('core__system__exit', this.tools.exit.bind(this.tools));
    globals.humanOnlyTools.add('core__system__exit');
    
    globals.dslRegistry.set('core__system__pause', this.tools.pause.bind(this.tools));
    globals.humanOnlyTools.add('core__system__pause');
    
    globals.dslRegistry.set('core__system__resume', this.tools.resume.bind(this.tools));
    globals.humanOnlyTools.add('core__system__resume');
    
    globals.dslRegistry.set('core__system__stop', this.tools.stop.bind(this.tools));
    globals.humanOnlyTools.add('core__system__stop');
    
    globals.dslRegistry.set('core__system__clean', this.tools.clean.bind(this.tools));
    globals.humanOnlyTools.add('core__system__clean');
    
    globals.dslRegistry.set('core__memory_context', this.tools.context.bind(this.tools));
    globals.humanOnlyTools.add('core__memory_context');

  }

  get definition() {
    return this.tools.definition;
  }
}

export const corePlugin = new CorePlugin();
