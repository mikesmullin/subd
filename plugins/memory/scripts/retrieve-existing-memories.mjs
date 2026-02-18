import { spawnSync } from 'node:child_process';

function parseInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.facts)) {
      return parsed.facts.filter((item) => typeof item === 'string');
    }
    if (Array.isArray(parsed)) return parsed.filter((item) => typeof item === 'string');
    if (typeof parsed === 'string') return [parsed];
    return [];
  } catch {
    return [];
  }
}

function parseRecallOutput(raw) {
  const lines = String(raw || '').split('\n');
  const out = [];

  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line || line.startsWith('Top ') || !line.includes('|')) continue;

    const [left, right] = line.split('|', 2);
    const idMatch = left.match(/\[(\d+)\]/);
    if (!idMatch) continue;

    const id = idMatch[1];
    const text = String(right || '').trim();
    if (!text || text.startsWith('__DELETED__')) continue;

    out.push({ id, text });
  }

  return out;
}

const stdin = await Bun.stdin.text();
const proposedMemories = parseInput(stdin);

const seen = new Set();
const existing = [];

for (const fact of proposedMemories) {
  const query = String(fact || '').trim();
  if (!query) continue;

  const result = spawnSync('memo', ['recall', '-k', '8', query], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (result.status !== 0) continue;

  for (const item of parseRecallOutput(result.stdout)) {
    const key = `${item.id}::${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    existing.push(item);
  }
}

process.stdout.write(JSON.stringify(existing));
