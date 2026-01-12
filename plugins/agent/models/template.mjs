import { YamlCollection } from '../../../common/yaml-db.mjs';
import { globals } from '../../../common/globals.mjs';

const collection = new YamlCollection(globals.dbPaths.templates);
globals.dbCollections.add(collection);

export class TemplateModel {
  static get collection() { return collection; }

  static create(name, data) {
    const template = { 
      apiVersion: 'daemon/v1',
      kind: 'Agent',
      metadata: {
        name,
        created: new Date().toISOString(),
        ...data?.metadata
      },
      spec: {
        system_prompt: '',
        ...data?.spec
      }
    };
    collection.set(name, template);
    return template;
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
