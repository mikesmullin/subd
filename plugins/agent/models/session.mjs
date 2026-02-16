import { YamlCollection } from '../../../common/yaml-db.mjs';
import { globals } from '../../../common/globals.mjs';
import { Utils } from '../../../common/utils.mjs';
import { FSM } from '../../../common/fsm.mjs';
import path from 'path';
import crypto from 'crypto';

export const SESSION_ID_PATTERN = /^\d{13}-\d+-[a-f0-9]{4}$/i;

// Session states
export const SessionState = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCESS: 'success',
  ERROR: 'error',
  PAUSED: 'paused',
  STOPPED: 'stopped'
};

// Session FSM with transition rules
const sessionFSM = new FSM({
  'pause': 'pending,running -> paused',
  'resume': 'paused -> pending',
  'retry': 'success,error -> pending',
  'stop': 'pending,running,paused -> stopped',
  'run': 'stopped -> running',
  'start': 'pending -> running',
  'complete': 'running -> success',
  'fail': 'running -> error'
});

// Detect container mode: --session arg means we're inside a container
const isContainerMode = process.argv.includes('--session');

// Build the sessions path: host uses glob pattern across workspaces, container uses local db/sessions
const sessionsPath = isContainerMode
  ? './db/sessions'
  : globals.dbPaths.sessions;

const collection = new YamlCollection(sessionsPath);
globals.dbCollections.add(collection);

export class SessionModel {
  static nextSessionId = 0;
  static initialized = false;

  static get collection() { return collection; }

  static init() {
    if (this.initialized) return;
    // collection.ensureLoaded();
    const ids = collection.list()
      .map(id => parseInt(id))
      .filter(id => !isNaN(id));
    
    this.nextSessionId = ids.length > 0 ? Math.max(...ids) + 1 : 1;
    this.initialized = true;
  }

  static generateId() {
    const ts = Date.now();
    const pid = process.pid;
    const rand = crypto.randomBytes(2).toString('hex');
    return `${ts}-${pid}-${rand}`;
  }

  static isCanonicalId(id) {
    return typeof id === 'string' && SESSION_ID_PATTERN.test(id.trim());
  }

  static ensureCanonicalId(id = null) {
    if (typeof id === 'string' && id.trim()) {
      const trimmed = id.trim();
      if (!this.isCanonicalId(trimmed)) {
        throw new Error(`Invalid session id format: ${trimmed}. Expected: <timestampMs>-<pid>-<hex4>`);
      }
      return trimmed;
    }
    return this.generateId();
  }

  static resetId() {
    this.nextSessionId = 1;
  }

  static transition(id, action) {
    // Force reload to ensure we have the latest state (especially if modified by container)
    this.collection.loadAll();
    const session = this.load(id);
    if (!session) {
      return { success: false, error: `Session ${id} not found` };
    }

    const currentState = session.metadata?.status || SessionState.PENDING;
    
    const result = sessionFSM.transition(currentState, action);
    
    if (!result.success) {
      Utils.logWarn(`Invalid transition action ${action} for session ${id}: ${result.from} -> ? (${result.error})`);
      return { success: false, oldState: currentState, error: result.error };
    }

    session.metadata.status = result.to;
    session.metadata.lastTransition = {
      action,
      from: result.from,
      to: result.to,
      timestamp: new Date().toISOString()
    };
    this.save(id, session);
    this.collection.save();

    Utils.logInfo(`Session ${id} action '${action}' transitioned: ${result.from} -> ${result.to}`);
    return { success: true, oldState: result.from, newState: result.to };
  }

  static create(id, data, options = { persist: true }) {
    const canonicalId = this.ensureCanonicalId(id);
    const createdAt = new Date();
    const containerId = `${canonicalId}_${Math.floor(createdAt.getTime() / 1000)}`;
    const session = { 
      apiVersion: 'daemon/v1',
      kind: 'Agent',
      metadata: {
        id: canonicalId,
        name: data.name,
        containerId,  // Unique container name: {sessionId}_{unixTimestamp}
        created: createdAt.toISOString(),
        last_pid: process.pid,
        status: SessionState.PENDING,  // Start in PENDING state
        tools: data.template?.spec?.tools || data.template?.metadata?.tools || [],
        labels: data.template?.metadata?.labels || [],
        ...data.template?.metadata
      },
      spec: {
        ...data.template?.spec,
        messages: data.messages || []
      }
    };
    // Remove tools from spec if it was copied over
    if (session.spec.tools) delete session.spec.tools;
    
    // Only persist to collection if requested (host agent creation should NOT persist)
    if (options.persist) {
      collection.set(canonicalId, session);
    }
    return session;
  }

  static load(id) {
    return collection.get(id);
  }

  static save(id, data) {
    const canonicalId = this.ensureCanonicalId(id);
    if (!data.metadata || typeof data.metadata !== 'object') {
      data.metadata = {};
    }
    data.metadata.id = canonicalId;
    collection.set(canonicalId, data);
    collection.save();
  }

  static list(options = { includeDeleted: false }) {
    const allIds = collection.list();
    if (options.includeDeleted) return allIds;
    
    // Filter out deleted sessions
    return allIds.filter(id => {
      const session = collection.get(id);
      return !session?.metadata?.deletedAt;
    });
  }

  static delete(id) {
    const session = this.load(id);
    if (!session) return false;
    
    session.metadata.deletedAt = new Date().toISOString();
    this.save(id, session);
    this.collection.save();
    return true;
  }
}
