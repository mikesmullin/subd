import { Utils } from '../../../common/utils.mjs';
import { GroupModel } from '../models/group.mjs';

export class GroupTools {
  constructor(plugin) {
    this.plugin = plugin;
  }

  async list(args) {
    const groups = GroupModel.list();
    const list = groups.length ? groups.join('\n') : '(none)';
    Utils.logInfo('Groups:\n' + list);
    return list;
  }

  async create(args) {
    const name = Array.isArray(args) ? args[0] : args.name;
    if (!name) return Utils.logError('Usage: group.new <name>');
    if (GroupModel.load(name)) return Utils.logError(`Group '${name}' already exists.`);
    
    GroupModel.create(name, { members: [] });
    Utils.logInfo(`Created group '${name}'`);
  }

  async detail(args) {
    const name = Array.isArray(args) ? args[0] : args.name;
    const group = GroupModel.load(name);
    if (!group) return Utils.logError(`Group '${name}' not found.`);
    Utils.logInfo(`Group '${name}':\n  Members: ${group.members?.join(', ') || '(none)'}`);
    return group;
  }

  async add(args) {
    let name, id;
    if (Array.isArray(args)) {
        name = args[0];
        id = args[1];
    } else {
        name = args.name;
        id = args.id;
    }
    let group = GroupModel.load(name);
    
    if (!group) {
      GroupModel.create(name, { members: [id] });
      Utils.logInfo(`Created group '${name}' and added session ${id}`);
      return;
    }
    
    // Exclusive membership check
    for (const g of GroupModel.list()) {
      const otherGroup = GroupModel.load(g);
      if (otherGroup && otherGroup.members?.includes(id) && g !== name) {
        return Utils.logError(`Session ${id} is already in group '${g}'. Remove it first.`);
      }
    }
    
    if (!group.members) group.members = [];
    if (!group.members.includes(id)) {
      group.members.push(id);
      GroupModel.save(name, group);
      Utils.logInfo(`Added session ${id} to group '${name}'`);
    } else {
      Utils.logInfo(`Session ${id} is already in group '${name}'`);
    }
  }

  async remove(args) {
    let name, id;
    if (Array.isArray(args)) {
        name = args[0];
        id = args[1];
    } else {
        name = args.name;
        id = args.id;
    }
    const group = GroupModel.load(name);
    if (!group) return Utils.logError(`Group '${name}' not found.`);
    
    if (group.members) {
      group.members = group.members.filter(m => m !== id);
      GroupModel.save(name, group);
      Utils.logInfo(`Removed session ${id} from group '${name}'`);
    }
  }

  async delete(args) {
    const name = Array.isArray(args) ? args[0] : args.name;
    if (!GroupModel.load(name)) return Utils.logError(`Group '${name}' not found.`);
    GroupModel.delete(name);
    Utils.logInfo(`Deleted group '${name}'`);
  }
}
