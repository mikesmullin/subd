import { YamlCollection } from '../../../common/yaml-db.mjs';
import { globals } from '../../../common/globals.mjs';
import path from 'path';

// Approvals are stored in db/approvals/
const approvalsPath = globals.dbPaths.approvals;

const collection = new YamlCollection(approvalsPath);
globals.dbCollections.add(collection);

export class ApprovalModel {
  static get collection() { return collection; }

  static init() {
    // Ensure directory exists
    collection.loadAll();
  }

  static create(data) {
    const id = data.id;
    this.collection.set(id, {
      ...data,
      created: new Date().toISOString(),
      status: 'pending'
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
  
  static update(id, updates) {
      const item = this.collection.get(id);
      if (!item) return false;
      this.collection.set(id, { ...item, ...updates });
      this.collection.save();
      return true;
  }
}
