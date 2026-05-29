export function splitMarkdownRow(line) {
  if (!String(line || '').trim().startsWith('|')) return null;

  const trimmed = String(line).trim().replace(/^\|/, '').replace(/\|\s*$/, '');
  const fields = trimmed.split('|').map((part) => part.trim());
  return fields;
}

function looksLikeLocationCell(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return false;

  const canonical = new Set(['us', 'remote', 'remote (us)', 'outside us', 'unknown']);
  if (canonical.has(v)) return true;

  return /(united states|usa|u\.?s\.?|remote|hybrid|onsite|on-site|bay area|california|new york|seattle|washington|texas|uk|europe|emea|apac|canada|india|germany|singapore|australia)/i.test(v);
}

export function parseTrackerRow(line) {
  const fields = splitMarkdownRow(line);
  if (!fields || fields.length < 8) return null;

  if (fields[0] === '#' || fields[0].startsWith('---')) return null;

  const id = Number(fields[0]);
  if (!Number.isFinite(id)) return null;

  const hasLocationColumn = fields.length >= 10 && looksLikeLocationCell(fields[fields.length - 1]);
  const location = hasLocationColumn ? String(fields[fields.length - 1] || '').trim() : '';
  const notes = hasLocationColumn
    ? fields.slice(8, -1).join(' | ').trim()
    : fields.slice(8).join(' | ').trim();

  return {
    id,
    date: fields[1] || '',
    company: fields[2] || '',
    role: fields[3] || '',
    score: fields[4] || '',
    status: fields[5] || '',
    pdf: fields[6] || '',
    report: fields[7] || '',
    notes,
    location,
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

  const location = String(entry.location ?? '').trim();
  if (location) cells.push(location);

  return `| ${cells.join(' | ')} |`;
}
