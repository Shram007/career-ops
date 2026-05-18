export function splitMarkdownRow(line) {
  if (!String(line || '').trim().startsWith('|')) return null;

  const trimmed = String(line).trim().replace(/^\|/, '').replace(/\|\s*$/, '');
  const fields = trimmed.split('|').map((part) => part.trim());
  return fields;
}

export function parseTrackerRow(line) {
  const fields = splitMarkdownRow(line);
  if (!fields || fields.length < 8) return null;

  if (fields[0] === '#' || fields[0].startsWith('---')) return null;

  const id = Number(fields[0]);
  if (!Number.isFinite(id)) return null;

  return {
    id,
    date: fields[1] || '',
    company: fields[2] || '',
    role: fields[3] || '',
    score: fields[4] || '',
    status: fields[5] || '',
    pdf: fields[6] || '',
    report: fields[7] || '',
    notes: fields.slice(8).join(' | ').trim(),
    fields,
  };
}

export function buildTrackerRow(entry) {
  const cells = [
    String(entry.id ?? ''),
    String(entry.date ?? ''),
    String(entry.company ?? ''),
    String(entry.role ?? ''),
    String(entry.score ?? ''),
    String(entry.status ?? ''),
    String(entry.pdf ?? ''),
    String(entry.report ?? ''),
    String(entry.notes ?? ''),
  ];
  return `| ${cells.join(' | ')} |`;
}
