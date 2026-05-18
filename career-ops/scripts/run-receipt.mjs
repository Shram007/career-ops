import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

function compactDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

export function writeRunReceipt(baseDir, stage, payload) {
  const now = new Date();
  const dayDir = join(baseDir, 'reports', 'pipeline-runs', compactDate(now));
  mkdirSync(dayDir, { recursive: true });

  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const fileName = `${stage}-${timestamp}.json`;
  const filePath = join(dayDir, fileName);

  const body = {
    stage,
    timestamp: now.toISOString(),
    ...payload,
  };

  writeFileSync(filePath, JSON.stringify(body, null, 2) + '\n', 'utf8');
  return filePath;
}
