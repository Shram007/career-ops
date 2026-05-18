const CANONICAL_DISPLAY = {
  evaluated: 'Evaluated',
  scored: 'Scored',
  pdf: "PDF'd",
  applied: 'Applied',
  responded: 'Responded',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
  discarded: 'Discarded',
  inactive: 'Inactive',
  skip: 'SKIP',
};

const ALIASES = {
  // Evaluated
  evaluada: 'evaluated',
  condicional: 'evaluated',
  hold: 'evaluated',
  evaluar: 'evaluated',
  verificar: 'evaluated',

  // Scored / PDF
  score: 'scored',
  scored: 'scored',
  pipeline_score: 'scored',
  "pdf'd": 'pdf',
  pdfd: 'pdf',
  pdfed: 'pdf',
  pdf: 'pdf',
  'pdf generated': 'pdf',

  // Applied lifecycle
  aplicado: 'applied',
  enviada: 'applied',
  aplicada: 'applied',
  applied: 'applied',
  sent: 'applied',
  respondido: 'responded',
  entrevista: 'interview',
  oferta: 'offer',

  // Closed paths
  rechazado: 'rejected',
  rechazada: 'rejected',
  descartado: 'discarded',
  descartada: 'discarded',
  cerrada: 'discarded',
  cancelada: 'discarded',
  inactive: 'inactive',
  expired: 'inactive',
  closed: 'inactive',
  dead: 'inactive',
  'no aplicar': 'skip',
  no_aplicar: 'skip',
  monitor: 'skip',
  'geo blocker': 'skip',
};

export const CANONICAL_STATUS_IDS = new Set(Object.keys(CANONICAL_DISPLAY));

function cleanToken(raw) {
  return String(raw || '').replace(/\*\*/g, '').trim();
}

function stripDateSuffix(token) {
  return token.replace(/\s+\d{4}[-/]\d{2}[-/]\d{2}.*$/, '').trim();
}

export function splitStatusHistory(raw) {
  const cleaned = cleanToken(raw);
  if (!cleaned) return [];
  return cleaned
    .split(/\s*(?:>|->|→)\s*/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function normalizeStatusToken(rawToken) {
  const original = cleanToken(rawToken);
  const withoutDate = stripDateSuffix(original);
  const lower = withoutDate.toLowerCase();

  if (!withoutDate || withoutDate === '-' || withoutDate === '—') {
    return { id: 'discarded', display: CANONICAL_DISPLAY.discarded };
  }
  if (/^duplicado/i.test(withoutDate) || /^dup\b/i.test(withoutDate)) {
    return { id: 'discarded', display: CANONICAL_DISPLAY.discarded, moveToNotes: true };
  }
  if (/^repost/i.test(withoutDate)) {
    return { id: 'discarded', display: CANONICAL_DISPLAY.discarded, moveToNotes: true };
  }
  if (/geo.?blocker/i.test(withoutDate)) {
    return { id: 'skip', display: CANONICAL_DISPLAY.skip };
  }

  const aliasId = ALIASES[lower];
  if (aliasId) {
    return { id: aliasId, display: CANONICAL_DISPLAY[aliasId] };
  }

  if (CANONICAL_STATUS_IDS.has(lower)) {
    return { id: lower, display: CANONICAL_DISPLAY[lower] };
  }

  return { id: null, display: null, unknown: true };
}

export function latestStatusToken(raw) {
  const tokens = splitStatusHistory(raw);
  const latest = tokens.length > 0 ? tokens[tokens.length - 1] : cleanToken(raw);
  const normalized = normalizeStatusToken(latest);
  return normalized.id || stripDateSuffix(latest).toLowerCase();
}

export function normalizeStatusHistory(raw) {
  const tokens = splitStatusHistory(raw);
  const sourceTokens = tokens.length > 0 ? tokens : [cleanToken(raw)];

  const normalized = [];
  let moveToNotes = false;

  for (const token of sourceTokens) {
    const parsed = normalizeStatusToken(token);
    if (parsed.unknown) {
      return { unknown: true, status: null };
    }
    if (parsed.moveToNotes) {
      moveToNotes = true;
    }
    if (normalized.length === 0 || normalized[normalized.length - 1] !== parsed.display) {
      normalized.push(parsed.display);
    }
  }

  return {
    unknown: false,
    status: normalized.join(' > '),
    moveToNotes,
  };
}

export function isBlockedStatus(raw) {
  const latest = latestStatusToken(raw);
  return latest === 'skip' || latest === 'discarded' || latest === 'rejected' || latest === 'inactive' || latest === 'pdf';
}

export function appendStatusHistory(currentStatus, nextStatus) {
  const current = normalizeStatusHistory(currentStatus);
  const next = normalizeStatusToken(nextStatus);
  if (next.unknown) {
    return String(currentStatus || '').trim();
  }

  if (current.unknown || !current.status) {
    return next.display;
  }

  const currentTokens = splitStatusHistory(current.status);
  const latestCurrent = currentTokens[currentTokens.length - 1] || '';
  if (latestCurrent.toLowerCase() === next.display.toLowerCase()) {
    return current.status;
  }

  return `${current.status} > ${next.display}`;
}
