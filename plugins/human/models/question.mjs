import { YamlCollection } from '../../../common/yaml-db.mjs';
import { globals } from '../../../common/globals.mjs';
import path from 'path';

// Questions are stored in db/questions/
const questionsPath = globals.dbPaths.questions;

const collection = new YamlCollection(questionsPath);
globals.dbCollections.add(collection);

export class QuestionModel {
  static get collection() { return collection; }

  static init() {
    // Ensure directory exists
    collection.loadAll();
  }

  static create(data) {
    const id = data.id;
    this.collection.set(id, {
      ...data,
      created: new Date().toISOString()
    });
    this.collection.save();
    return id;
  }

  static get(id) {
    return this.collection.get(id);
  }

  static delete(id) {
    const result = this.collection.delete(id);
    this.collection.save();
    return result;
  }

  static list() {
    return this.collection.getAll();
  }
}
