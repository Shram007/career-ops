const fs = require('fs');
const yaml = require('js-yaml');

const cfg = yaml.load(fs.readFileSync('portals.yml', 'utf8'));
const sources = [ ...(cfg.tracked_companies || []), ...(cfg.referral_companies || []) ];

const apis = [];
for (const c of sources) {
  if (c && c.enabled !== false && c.api) {
    apis.push({ name: c.name || 'Unknown', url: String(c.api) });
  }
}

const uniq = [];
const seen = new Set();
for (const a of apis) {
  if (seen.has(a.url)) continue;
  seen.add(a.url);
  uniq.push(a);
}

async function check(entry) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    const res = await fetch(entry.url, {
      headers: {
        'user-agent': 'career-ops-endpoint-check/1.0',
        'accept': 'application/json,*/*'
      },
      signal: ac.signal,
    });
    clearTimeout(timer);

    const ct = (res.headers.get('content-type') || '').split(';')[0];
    let jobs = '-';

    if (res.ok && ct.includes('json')) {
      try {
        const json = await res.json();
        if (Array.isArray(json && json.jobs)) jobs = String(json.jobs.length);
        else if (Array.isArray(json && json.results)) jobs = String(json.results.length);
        else if (Array.isArray(json && json.data)) jobs = String(json.data.length);
        else jobs = 'json';
      } catch {
        jobs = 'json-parse-failed';
      }
    }

    return {
      name: entry.name,
      url: entry.url,
      status: res.status,
      ok: res.ok,
      contentType: ct || '-',
      jobs,
    };
  } catch (err) {
    return {
      name: entry.name,
      url: entry.url,
      status: 'ERR',
      ok: false,
      contentType: '-',
      jobs: '-',
      error: String(err && err.message ? err.message : err),
    };
  }
}

(async () => {
  const rows = [];
  for (const entry of uniq) {
    rows.push(await check(entry));
  }

  const okCount = rows.filter(r => r.ok).length;
  const failCount = rows.length - okCount;

  console.log('API endpoint check summary');
  console.log('--------------------------');
  console.log('Total: ' + rows.length);
  console.log('OK:    ' + okCount);
  console.log('Fail:  ' + failCount);
  console.log('');

  for (const r of rows) {
    const status = String(r.status).padEnd(3, ' ');
    console.log((r.ok ? 'OK  ' : 'FAIL') + ' | ' + status + ' | ' + r.name + ' | ' + r.contentType + ' | jobs=' + r.jobs);
    if (!r.ok && r.error) {
      console.log('       error: ' + r.error);
    }
    console.log('       ' + r.url);
  }
})();
