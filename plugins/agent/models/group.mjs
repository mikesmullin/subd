import { YamlCollection } from '../../../common/yaml-db.mjs';
import { globals } from '../../../common/globals.mjs';

const collection = new YamlCollection(globals.dbPaths.groups);
globals.dbCollections.add(collection);

export class GroupModel {
  static get collection() { return collection; }

  static create(name, data) {
    const group = { 
      name, 
      created: new Date().toISOString(), 
      members: [],
      ...data 
    };
    collection.set(name, group);
    return group;
  }

  static load(name) {
    return collection.get(name);
  }

  static save(name, data) {
    collection.set(name, data);
  }

  static list() {
    return collection.list();
  }

  static delete(name) {
    return collection.delete(name);
  }
}
