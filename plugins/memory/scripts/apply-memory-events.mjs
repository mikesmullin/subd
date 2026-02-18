import { spawnSync } from 'node:child_process';

function parseInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.memory)) {
      return parsed.memory;
    }
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const stdin = await Bun.stdin.text();
const events = parseInput(stdin);

const summary = {
  add: 0,
  update: 0,
  delete: 0,
  skipped: 0,
  errors: 0
};

for (const eventItem of events) {
  if (!eventItem || typeof eventItem !== 'object') {
    summary.skipped += 1;
    continue;
  }

  const event = String(eventItem.event || '').toUpperCase();
  const id = eventItem.id === undefined || eventItem.id === null ? '' : String(eventItem.id).trim();
  const text = eventItem.text === undefined || eventItem.text === null ? '' : String(eventItem.text).trim();
  const oldMemory = eventItem.old_memory === undefined || eventItem.old_memory === null
    ? ''
    : String(eventItem.old_memory).trim();

  let cmd = null;

  if (event === 'ADD' && text) {
    cmd = ['save', text];
    summary.add += 1;
  } else if (event === 'UPDATE' && id && text) {
    cmd = ['save', id, text];
    summary.update += 1;
  } else if (event === 'DELETE' && id) {
    const tombstone = `__DELETED__ ${oldMemory || text || 'memory entry'}`;
    cmd = ['save', id, tombstone];
    summary.delete += 1;
  } else {
    summary.skipped += 1;
    continue;
  }

  const result = spawnSync('memo', cmd, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (result.status !== 0) {
    summary.errors += 1;
  }
}

process.stdout.write(JSON.stringify(summary));
