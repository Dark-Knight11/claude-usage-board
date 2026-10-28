#!/usr/bin/env node
// Claude Code usage dashboard + terminal report. Zero dependencies.
//
//   claude-usage-board                      → web dashboard at http://localhost:4321
//   claude-usage-board report --since 7d    → terminal summary (see --help)
//
// Reads ~/.claude/projects/**/*.jsonl (Claude Code transcripts, incl. subagents).
// Live plan limits (5-hour / weekly %) are opt-in: pass --live-limits or click
// "Fetch live limits" in the dashboard. That reads Claude Code's OAuth token from
// the macOS keychain (or ~/.claude/.credentials.json) and calls Anthropic's usage
// endpoint; the token never leaves this process except to api.anthropic.com.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();

// Plain text when output is piped/redirected or NO_COLOR is set (also avoids stray codes in old consoles).
if (!process.stdout.isTTY || process.env.NO_COLOR) {
  const log = console.log;
  console.log = (...a) => log(...a.map(x => typeof x === 'string' ? x.replace(/\x1b\[[0-9;]*m/g, '') : x));
}
const CLAUDE_DIRS = [
  process.env.CLAUDE_CONFIG_DIR && path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'),
  path.join(HOME, '.claude', 'projects'),
  path.join(HOME, '.config', 'claude', 'projects'),
].filter(Boolean);

// USD per million tokens (API list prices). Cache write = 1.25x (5m) / 2x (1h) input.
// Plan subscribers don't pay this — it's an "API-equivalent" value estimate.
const PRICING = {
  'claude-fable-5-1':  { in: 10,  out: 50,  cr: 0.25 },
  'claude-fable-5':    { in: 10,  out: 50,  cr: 1.0 },
  'claude-opus-5-5':   { in: 4,   out: 20,  cr: 0.20 },
  'claude-opus-5':     { in: 5,   out: 25,  cr: 0.50 },
  'claude-opus-4-8':   { in: 5,   out: 25,  cr: 0.50 },
  'claude-opus-4-7':   { in: 5,   out: 25,  cr: 0.50 },
  'claude-opus-4-6':   { in: 5,   out: 25,  cr: 0.50 },
  'claude-opus-4-5':   { in: 5,   out: 25,  cr: 0.50 },
  'claude-opus-4':     { in: 15,  out: 75,  cr: 1.50 }, // Opus 4 / 4.1
  'claude-sonnet-5-5': { in: 2,   out: 10,  cr: 0.20 },
  'claude-sonnet-5':   { in: 2,   out: 10,  cr: 0.20 },
  'claude-sonnet-4':   { in: 3,   out: 15,  cr: 0.30 },
  'claude-haiku-5-5':  { in: 0.10, out: 0.50, cr: 0.01 },
  'claude-haiku-4':    { in: 1,   out: 5,   cr: 0.10 },
};
function priceFor(model) {
  if (!model) return null;
  if (PRICING[model]) return PRICING[model];
  const key = Object.keys(PRICING).sort((a, b) => b.length - a.length).find(k => model.startsWith(k));
  return key ? PRICING[key] : null;
}
function costOf(r) {
  const p = priceFor(r.model);
  if (!p) return 0;
  return (r.in * p.in + r.out * p.out + r.cw5 * p.in * 1.25 + r.cw1h * p.in * 2 + r.cr * p.cr) / 1e6;
}

// ---------- Log parsing (incremental, cached by file mtime/size) ----------
const fileCache = new Map(); // path -> {mtimeMs, size, records}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// Shortens a session's cwd for display: home → "~", desktop-app temp folders → one bucket.
// Windows paths use "\" and drive letters can differ in case (c:\ vs C:\), so compare loosely there.
function projectName(cwd, dirName, home = HOME, win = process.platform === 'win32') {
  if (!cwd) return dirName;
  if (cwd.replace(/\\/g, '/').includes('/scratch-workspaces/')) return '(scratch sessions)';
  const norm = s => win ? s.replace(/\//g, '\\').replace(/[\\/]+$/, '').toLowerCase() : s.replace(/\/+$/, '');
  const c = norm(cwd), h = norm(home);
  if (c === h) return '~';
  const sep = win ? '\\' : '/';
  return c.startsWith(h + sep) ? '~' + (win ? cwd.replace(/\//g, '\\') : cwd).slice(h.length) : cwd;
}

function parseFile(file, rootDir) {
  const rel = path.relative(rootDir, file);
  const dirName = rel.split(path.sep)[0];
  const isSub = rel.includes(`${path.sep}subagents${path.sep}`);
  const records = [];
  const meta = { isSub, session: null, cwd: null, relocatedCwd: null, costState: null };
  let lastTs = null;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { records, meta }; }
  for (const line of text.split('\n')) {
    // first cwd in the file = where the session was launched
    if (!meta.cwd) { const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line); if (m) meta.cwd = JSON.parse(`"${m[1]}"`); }
    if (line.includes('"type":"relocated"')) { try { meta.relocatedCwd = JSON.parse(line).relocatedCwd || meta.relocatedCwd; } catch {} }
    if (!meta.session) { const m = /"sessionId":"([^"]+)"/.exec(line); if (m) meta.session = m[1]; }
    const ts = /"timestamp":"([^"]+)"/.exec(line); if (ts) lastTs = Date.parse(ts[1]);
    if (!isSub && line.startsWith('{"type":"cost-state"')) {
      // Claude Code's running per-model totals for the session (incl. subagents and background calls).
      // Counters only grow, so keep the max of each; the line has no timestamp, so use the last one seen.
      try {
        const cs = JSON.parse(line);
        const acc = meta.costState || (meta.costState = { t: 0, models: {} });
        acc.t = lastTs || acc.t;
        for (const [model, mu] of Object.entries(cs.modelUsage || {})) {
          const a = acc.models[model] || (acc.models[model] = {});
          for (const k of ['inputTokens', 'outputTokens', 'thinkingTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'webSearchRequests'])
            a[k] = Math.max(a[k] || 0, mu[k] || 0);
        }
      } catch {}
      continue;
    }
    if (!line.includes('"usage"')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const m = d.message;
    if (!m || typeof m !== 'object' || !m.usage || d.type !== 'assistant') continue;
    if (m.model === '<synthetic>') continue;
    const u = m.usage;
    const cc = u.cache_creation || {};
    const cwTotal = u.cache_creation_input_tokens || 0;
    const cw1h = cc.ephemeral_1h_input_tokens || 0;
    const cw5 = cc.ephemeral_5m_input_tokens ?? Math.max(0, cwTotal - cw1h);
    records.push({
      id: `${m.id || ''}:${d.requestId || ''}`,
      t: Date.parse(d.timestamp),
      model: m.model || 'unknown',
      project: projectName(meta.cwd || d.cwd, dirName), // fallback; loadRecords assigns the session's project
      dir: d.cwd ? projectName(d.cwd, dirName) : '',
      session: d.sessionId || path.basename(file, '.jsonl'),
      branch: d.gitBranch || '',
      entry: d.entrypoint || '',
      sub: isSub || !!d.isSidechain,
      in: u.input_tokens || 0,
      out: u.output_tokens || 0,
      think: u.output_tokens_details?.thinking_tokens || 0,
      cw5, cw1h,
      cr: u.cache_read_input_tokens || 0,
      web: (u.server_tool_use?.web_search_requests || 0) + (u.server_tool_use?.web_fetch_requests || 0),
    });
  }
  return { records, meta };
}

function loadRecords() {
  const files = [];
  for (const root of CLAUDE_DIRS) {
    if (!fs.existsSync(root)) continue;
    for (const f of walk(root)) {
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      let c = fileCache.get(f);
      if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
        c = { mtimeMs: st.mtimeMs, size: st.size, ...parseFile(f, root) };
        fileCache.set(f, c);
      }
      files.push(c);
    }
  }

  // A session's project comes from its main transcript: where it was launched, or where it was
  // moved to. Subagent transcripts inherit it, even if the parent had cd'd elsewhere.
  const sessionProject = new Map();
  for (const { meta } of files) {
    if (meta.isSub || !meta.session) continue;
    const cwd = meta.relocatedCwd || meta.cwd;
    if (cwd) sessionProject.set(meta.session, projectName(cwd));
  }

  // Claude Code writes one line per content block of a response, all with the same usage → dedupe,
  // keeping the line with the most output in case a partial was ever logged.
  const byId = new Map();
  const all = [];
  for (const { records } of files) {
    for (const r of records) {
      r.project = sessionProject.get(r.session) || r.project;
      if (r.id === ':') { all.push(r); continue; }
      const prev = byId.get(r.id);
      if (!prev) { byId.set(r.id, r); all.push(r); }
      else if (r.out > prev.out) all[all.indexOf(prev)] = r, byId.set(r.id, r);
    }
  }
  all.push(...backgroundRecords(files, all, sessionProject));
  all.sort((a, b) => a.t - b.t);
  for (const r of all) r.cost = costOf(r);
  return all;
}

// Usage Claude Code counted in its cost records but never wrote to a transcript (e.g. title/summary
// calls, background Haiku). Per session+model: cost-record totals minus transcript records logged up
// to that snapshot, one synthetic record per type at the snapshot time, flagged bg.
function backgroundRecords(files, records, sessionProject) {
  const SLACK = 5000; // the snapshot is written just after the last timestamped line
  const out = [];
  for (const { meta } of files) {
    const cs = meta.costState;
    if (!cs || !meta.session || !cs.t) continue;
    const seen = {};
    for (const r of records) {
      if (r.session !== meta.session || r.t > cs.t + SLACK) continue;
      const a = seen[r.model] || (seen[r.model] = { in: 0, out: 0, think: 0, cr: 0, cw: 0, web: 0 });
      a.in += r.in; a.out += r.out; a.think += r.think; a.cr += r.cr; a.cw += r.cw5 + r.cw1h; a.web += r.web;
    }
    for (const [model, mu] of Object.entries(cs.models)) {
      const a = seen[model] || { in: 0, out: 0, think: 0, cr: 0, cw: 0, web: 0 };
      const d = {
        in: Math.max(0, mu.inputTokens - a.in), out: Math.max(0, mu.outputTokens - a.out),
        think: Math.max(0, mu.thinkingTokens - a.think), cr: Math.max(0, mu.cacheReadInputTokens - a.cr),
        cw: Math.max(0, mu.cacheCreationInputTokens - a.cw), web: Math.max(0, mu.webSearchRequests - a.web),
      };
      if (!d.in && !d.out && !d.cr && !d.cw) continue;
      out.push({
        id: `bg:${meta.session}:${model}`, t: cs.t, model, bg: true,
        project: sessionProject.get(meta.session) || projectName(meta.relocatedCwd || meta.cwd),
        session: meta.session, branch: '', entry: 'background', sub: false,
        in: d.in, out: d.out, think: Math.min(d.think, d.out), cw5: d.cw, cw1h: 0, cr: d.cr, web: d.web,
      });
    }
  }
  return out;
}

// ---------- Limits (local estimate) ----------
// Claude plans use rolling 5-hour session windows: a window opens at the first
// message (floored to the UTC hour) and lasts 5h; the next message after it ends opens a new one.
function sessionBlocks(records) {
  const H5 = 5 * 3600e3;
  const blocks = [];
  let cur = null;
  for (const r of records) {
    if (!cur || r.t >= cur.end) {
      const start = Math.floor(r.t / 3600e3) * 3600e3;
      cur = { start, end: start + H5, tokens: 0, cost: 0, msgs: 0, first: r.t, last: r.t };
      blocks.push(cur);
    }
    cur.tokens += r.in + r.out + r.cw5 + r.cw1h + r.cr;
    cur.cost += r.cost; cur.msgs++; cur.last = r.t;
  }
  return blocks;
}

// ---------- Live limits (opt-in) ----------
function readOAuthCreds() {
  if (process.env.CLAUDE_OAUTH_TOKEN) return { accessToken: process.env.CLAUDE_OAUTH_TOKEN };
  let raw = null;
  if (process.platform === 'darwin') {
    try { raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  }
  if (!raw) {
    try { raw = fs.readFileSync(path.join(HOME, '.claude', '.credentials.json'), 'utf8'); } catch {}
  }
  if (!raw) return null;
  try { return JSON.parse(raw)?.claudeAiOauth || null; } catch { return null; }
}

// Only the `claude` CLI refreshes this keychain entry (the desktop app keeps its own login),
// so after ~a day without terminal use the stored token goes stale.
const REFRESH_HINT = 'Run `claude` in a terminal once (start it and quit) to refresh the login, then try again.';

async function fetchLiveLimits() {
  const creds = readOAuthCreds();
  if (!creds?.accessToken) return { ok: false, error: 'No Claude Code login found in the keychain. ' + REFRESH_HINT };
  if (creds.expiresAt && creds.expiresAt < Date.now())
    return { ok: false, error: `Your saved Claude Code login expired ${new Date(creds.expiresAt).toLocaleString()}. ${REFRESH_HINT}` };
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${creds.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-usage-dashboard' },
    });
    if (res.status === 401) return { ok: false, error: 'Your Claude Code login was rejected (HTTP 401). ' + REFRESH_HINT };
    if (res.status === 403) return { ok: false, error: 'This login cannot read plan usage (HTTP 403). Your plan or org may not expose usage limits.' };
    if (!res.ok) return { ok: false, error: `Usage endpoint returned HTTP ${res.status}` };
    return { ok: true, data: await res.json(), fetchedAt: Date.now() };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------- CLI ----------
const fmt = n => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
const usd = n => '$' + n.toFixed(2);
function parseSince(s) {
  if (!s || s === 'all') return 0;
  const m = /^(\d+(?:\.\d+)?)\s*(m|h|d|w|mo)$/.exec(s);
  if (!m) throw new Error(`Bad --since "${s}". Use e.g. 30m, 5h, 7d, 2w, 3mo, all`);
  const mult = { m: 60e3, h: 3600e3, d: 864e5, w: 7 * 864e5, mo: 30 * 864e5 }[m[2]];
  return Date.now() - parseFloat(m[1]) * mult;
}
function total(r) { return r.in + r.out + r.cw5 + r.cw1h + r.cr; }

function table(rows, cols) {
  const widths = cols.map(c => Math.max(c.h.length, ...rows.map(r => String(c.v(r)).length)));
  const line = cells => cells.map((s, i) => cols[i].left ? String(s).padEnd(widths[i]) : String(s).padStart(widths[i])).join('  ');
  console.log('\x1b[1m' + line(cols.map(c => c.h)) + '\x1b[0m');
  console.log(widths.map(w => '─'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(cols.map(c => c.v(r))));
}

async function cli(args) {
  const get = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const since = parseSince(get('--since') || 'all');
  const by = get('--by') || 'model';
  const projFilter = get('--project');
  const all = loadRecords();
  const recs = all.filter(r => r.t >= since && (!projFilter || r.project.includes(projFilter)) && !(r.bg && args.includes('--no-background')));

  const groups = new Map();
  for (const r of recs) {
    const k = by === 'project' ? r.project : by === 'day' ? new Date(r.t).toLocaleDateString('en-CA') : by === 'session' ? r.session.slice(0, 8) + ' ' + r.project : r.model;
    const g = groups.get(k) || { key: k, in: 0, out: 0, cw: 0, cr: 0, tot: 0, cost: 0, n: 0, bg: 0 };
    g.in += r.in; g.out += r.out; g.cw += r.cw5 + r.cw1h; g.cr += r.cr; g.tot += total(r); g.cost += r.cost; if (!r.bg) g.n++; else g.bg += total(r);
    groups.set(k, g);
  }
  const rows = [...groups.values()].sort((a, b) => by === 'day' ? a.key.localeCompare(b.key) : b.tot - a.tot);
  if (args.includes('--json')) { console.log(JSON.stringify(rows, null, 2)); return; }

  const sum = rows.reduce((a, g) => ({ in: a.in + g.in, out: a.out + g.out, cw: a.cw + g.cw, cr: a.cr + g.cr, tot: a.tot + g.tot, cost: a.cost + g.cost, n: a.n + g.n }), { in: 0, out: 0, cw: 0, cr: 0, tot: 0, cost: 0, n: 0 });
  console.log(`\n\x1b[1;35mClaude usage\x1b[0m  ${get('--since') ? 'last ' + get('--since') : 'all time'} · by ${by}${projFilter ? ' · project~' + projFilter : ''}\n`);
  table(rows, [
    { h: by, v: g => g.key, left: true },
    { h: 'calls', v: g => g.n },
    { h: 'input', v: g => fmt(g.in) },
    { h: 'output', v: g => fmt(g.out) },
    { h: 'cache wr', v: g => fmt(g.cw) },
    { h: 'cache rd', v: g => fmt(g.cr) },
    { h: 'total', v: g => fmt(g.tot) },
    { h: 'bkgd', v: g => g.bg ? fmt(g.bg) : '–' },
    { h: 'API $', v: g => usd(g.cost) },
  ]);
  console.log(`\n\x1b[1mTotal\x1b[0m ${fmt(sum.tot)} tokens · ${sum.n} calls · ${usd(sum.cost)} API-equivalent`);
  const bgRecs = recs.filter(r => r.bg);
  if (bgRecs.length) console.log(`\x1b[2m  incl. ${fmt(bgRecs.reduce((a, r) => a + total(r), 0))} background tokens (${usd(bgRecs.reduce((a, r) => a + r.cost, 0))}) from Claude Code cost records, not in transcripts; hide with --no-background\x1b[0m`);

  const blocks = sessionBlocks(all);
  const b = blocks.at(-1);
  if (b && Date.now() < b.end) {
    const mins = Math.round((b.end - Date.now()) / 60e3);
    console.log(`\x1b[1m5h session\x1b[0m ${fmt(b.tokens)} tokens · ${usd(b.cost)} · resets in ${Math.floor(mins / 60)}h ${mins % 60}m`);
  } else console.log('\x1b[1m5h session\x1b[0m no active window');
  const wk = all.filter(r => r.t >= Date.now() - 7 * 864e5);
  console.log(`\x1b[1mLast 7 days\x1b[0m ${fmt(wk.reduce((a, r) => a + total(r), 0))} tokens · ${usd(wk.reduce((a, r) => a + r.cost, 0))}`);

  if (args.includes('--live-limits')) {
    const live = await fetchLiveLimits();
    if (!live.ok) console.log(`\x1b[33mLive limits: ${live.error}\x1b[0m`);
    else for (const [k, v] of Object.entries(live.data)) {
      if (v && typeof v === 'object' && 'utilization' in v)
        console.log(`\x1b[1mLive ${k}\x1b[0m ${Math.round(v.utilization)}% used${v.resets_at ? ' · resets ' + new Date(v.resets_at).toLocaleString() : ''}`);
    }
  }
  console.log();
}

// ---------- Server ----------
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version; } catch { return 'dev'; } })();

function openBrowser(url) {
  const [cmd, cmdArgs] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).unref(); } catch {}
}

function serve(port, { strictPort, open }) {
  const htmlPath = path.join(HERE, 'dashboard.html');
  const server = http.createServer(async (req, res) => {
    // Only answer requests addressed to this machine by name (blocks DNS-rebinding reads from other sites).
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) { res.writeHead(403).end('forbidden'); return; }
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/data') {
        const records = loadRecords();
        const body = JSON.stringify({ now: Date.now(), records, blocks: sessionBlocks(records), pricing: PRICING });
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(body);
      }
      if (url.pathname === '/api/live-limits') {
        // Reads the keychain and calls Anthropic, so require a POST with a custom header: a plain
        // cross-site link or form on another page can't trigger it.
        if (req.method !== 'POST' || req.headers['x-claude-usage'] !== '1') { res.writeHead(403).end('forbidden'); return; }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(await fetchLiveLimits()));
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY' });
        return res.end(fs.readFileSync(htmlPath));
      }
      res.writeHead(404).end('not found');
    } catch (e) {
      res.writeHead(500).end(String(e.stack || e));
    }
  });
  server.on('error', e => {
    if (e.code === 'EADDRINUSE' && !strictPort && port < 4340) return serve(port + 1, { strictPort, open });
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Try --port <n>.` : e.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    const dirs = CLAUDE_DIRS.filter(d => fs.existsSync(d));
    console.log(`\n  \x1b[1;38;5;173m✳ Claude Usage\x1b[0m  v${VERSION}\n`);
    console.log(`  Dashboard  \x1b[1m${url}\x1b[0m`);
    console.log(`  Logs       ${dirs.length ? dirs.join(', ') : '\x1b[33mno Claude Code logs found (~/.claude/projects)\x1b[0m'}`);
    console.log(`\n  \x1b[2mPress Ctrl+C to stop.\x1b[0m\n`);
    if (open) openBrowser(url);
  });
}

const HELP = `
Claude Usage — token usage dashboard for Claude Code (reads your local transcripts).

Usage
  claude-usage-board [options]           Start the dashboard and open it in your browser
  claude-usage-board report [options]    Print a usage summary in the terminal

Dashboard options
  --port <n>        Port to listen on (default 4321, or $PORT; picks the next free one if busy)
  --no-open         Don't open the browser

Report options
  --since <range>   30m, 5h, 7d, 2w, 3mo or all (default: all)
  --by <group>      model | project | day | session (default: model)
  --project <text>  Only projects whose path contains <text>
  --no-background   Leave out background usage from Claude Code's cost records
  --live-limits     Also fetch your real plan limits (uses your Claude Code login)
  --json            Output JSON

General
  -h, --help        Show this help
  -v, --version     Show the version

Data comes from ~/.claude/projects (or $CLAUDE_CONFIG_DIR/projects). Nothing is uploaded.
`;

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) console.log(HELP);
else if (args.includes('-v') || args.includes('--version')) console.log(VERSION);
else if (args[0] === 'report' || args[0] === 'cli') cli(args.slice(1)).catch(e => { console.error(e.message); process.exit(1); });
else {
  const i = args.indexOf('--port');
  const explicit = i >= 0 ? Number(args[i + 1]) : Number(process.env.PORT) || 0;
  if (i >= 0 && !(explicit > 0)) { console.error('--port needs a number'); process.exit(1); }
  serve(explicit || 4321, { strictPort: !!explicit, open: !args.includes('--no-open') });
}
