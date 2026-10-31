// Serveur de l'app coloc : API JSON + fichiers statiques, sans dépendance externe.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join, extname, dirname, resolve, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || join(ROOT, 'data', 'coloc.db');

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS shopping (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    qty TEXT,
    added_by INTEGER REFERENCES people(id) ON DELETE SET NULL,
    bought_by INTEGER REFERENCES people(id) ON DELETE SET NULL,
    bought_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    assignee_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
    recurrence TEXT NOT NULL DEFAULT 'none',
    rotate INTEGER NOT NULL DEFAULT 1,
    due_date TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    last_done_by INTEGER REFERENCES people(id) ON DELETE SET NULL,
    last_done_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ---------- Outils ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const RECURRENCES = ['none', 'daily', 'weekly', 'biweekly', 'monthly'];

function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${label} est requis`);
  const t = value.trim();
  if (t.length > max) throw new HttpError(400, `${label} est trop long (max ${max})`);
  return t;
}

function optText(value, max, label) {
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
  return text(value, max, label);
}

function personId(value) {
  if (value == null || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM people WHERE id = ?').get(id)) {
    throw new HttpError(400, 'Coloc inconnu');
  }
  return id;
}

function dateStr(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, 'Date invalide');
  return value;
}

function recurrence(value) {
  const r = value ?? 'none';
  if (!RECURRENCES.includes(r)) throw new HttpError(400, 'Récurrence invalide');
  return r;
}

const pad = (n) => String(n).padStart(2, '0');

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Ajoute une période à une date AAAA-MM-JJ (le 31 janvier + 1 mois donne le 28/29 février).
function addPeriod(date, rec) {
  let [y, m, d] = date.split('-').map(Number);
  if (rec === 'monthly') {
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${y}-${pad(m)}-${pad(Math.min(d, lastDay))}`;
  }
  const days = { daily: 1, weekly: 7, biweekly: 14 }[rec];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

// Prochain coloc actif après `current` (dans l'ordre d'arrivée), en boucle.
function nextAssignee(current) {
  const ids = db.prepare('SELECT id FROM people WHERE active = 1 ORDER BY id').all().map((r) => r.id);
  if (!ids.length) return null;
  return ids.find((id) => id > (current ?? 0)) ?? ids[0];
}

function getState() {
  return {
    people: db.prepare('SELECT * FROM people ORDER BY id').all(),
    shopping: db.prepare('SELECT * FROM shopping ORDER BY created_at DESC, id DESC').all(),
    tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
    settings: Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value])),
  };
}

function mustExist(table, id) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, 'Élément introuvable');
  return row;
}

// ---------- Routes ----------

const routes = [];
function route(method, pattern, handler) {
  const re = new RegExp('^' + pattern.replace(/:id/g, '(\\d+)') + '$');
  routes.push({ method, re, handler });
}

route('GET', '/api/state', () => getState());

// Colocs
route('POST', '/api/people', (_, b) => {
  const name = text(b.name, 40, 'Le nom');
  const r = db.prepare('INSERT INTO people (name) VALUES (?)').run(name);
  return { id: Number(r.lastInsertRowid) };
});

route('PATCH', '/api/people/:id', (id, b) => {
  const person = mustExist('people', id);
  if (b.name !== undefined) db.prepare('UPDATE people SET name = ? WHERE id = ?').run(text(b.name, 40, 'Le nom'), id);
  if (b.active !== undefined) {
    const active = b.active ? 1 : 0;
    db.prepare('UPDATE people SET active = ? WHERE id = ?').run(active, id);
    if (person.active && !active) {
      // Le coloc part : ses tâches en cours passent au suivant (rotation) ou deviennent non assignées.
      const open = db.prepare('SELECT * FROM tasks WHERE assignee_id = ? AND done = 0').all(id);
      for (const t of open) {
        const next = t.recurrence !== 'none' && t.rotate ? nextAssignee(id) : null;
        db.prepare('UPDATE tasks SET assignee_id = ? WHERE id = ?').run(next, t.id);
      }
    }
  }
  return { ok: true };
});

route('DELETE', '/api/people/:id', (id) => {
  const person = mustExist('people', id);
  if (person.active) throw new HttpError(400, "Marque d'abord ce coloc comme parti");
  db.prepare('DELETE FROM people WHERE id = ?').run(id);
  return { ok: true };
});

// Courses
route('POST', '/api/shopping', (_, b) => {
  const r = db
    .prepare('INSERT INTO shopping (name, qty, added_by) VALUES (?, ?, ?)')
    .run(text(b.name, 100, "L'article"), optText(b.qty, 30, 'La quantité'), personId(b.added_by));
  return { id: Number(r.lastInsertRowid) };
});

route('PATCH', '/api/shopping/:id', (id, b) => {
  mustExist('shopping', id);
  if (b.bought) {
    db.prepare("UPDATE shopping SET bought_by = ?, bought_at = datetime('now') WHERE id = ?").run(personId(b.by), id);
  } else {
    db.prepare('UPDATE shopping SET bought_by = NULL, bought_at = NULL WHERE id = ?').run(id);
  }
  return { ok: true };
});

route('DELETE', '/api/shopping/:id', (id) => {
  db.prepare('DELETE FROM shopping WHERE id = ?').run(id);
  return { ok: true };
});

route('POST', '/api/shopping/clear-bought', () => {
  db.prepare('DELETE FROM shopping WHERE bought_at IS NOT NULL').run();
  return { ok: true };
});

// Tâches
function taskFields(b) {
  return {
    title: text(b.title, 120, 'Le titre'),
    assignee_id: personId(b.assignee_id),
    recurrence: recurrence(b.recurrence),
    rotate: b.rotate === false ? 0 : 1,
    due_date: dateStr(b.due_date),
  };
}

route('POST', '/api/tasks', (_, b) => {
  const f = taskFields(b);
  if (f.recurrence !== 'none' && !f.due_date) f.due_date = today();
  const r = db
    .prepare('INSERT INTO tasks (title, assignee_id, recurrence, rotate, due_date) VALUES (?, ?, ?, ?, ?)')
    .run(f.title, f.assignee_id, f.recurrence, f.rotate, f.due_date);
  return { id: Number(r.lastInsertRowid) };
});

route('PUT', '/api/tasks/:id', (id, b) => {
  mustExist('tasks', id);
  const f = taskFields(b);
  if (f.recurrence !== 'none' && !f.due_date) f.due_date = today();
  db.prepare('UPDATE tasks SET title = ?, assignee_id = ?, recurrence = ?, rotate = ?, due_date = ? WHERE id = ?').run(
    f.title, f.assignee_id, f.recurrence, f.rotate, f.due_date, id,
  );
  return { ok: true };
});

route('POST', '/api/tasks/:id/complete', (id, b) => {
  const t = mustExist('tasks', id);
  const by = personId(b.by);
  if (t.recurrence === 'none') {
    db.prepare("UPDATE tasks SET done = 1, last_done_by = ?, last_done_at = datetime('now') WHERE id = ?").run(by, id);
  } else {
    // Tâche récurrente : on avance l'échéance et on passe au coloc suivant.
    const now = today();
    const base = t.due_date && t.due_date >= now ? t.due_date : now;
    const nextDue = addPeriod(base, t.recurrence);
    const assignee = t.rotate ? nextAssignee(t.assignee_id ?? by) : t.assignee_id;
    db.prepare(
      "UPDATE tasks SET due_date = ?, assignee_id = ?, last_done_by = ?, last_done_at = datetime('now') WHERE id = ?",
    ).run(nextDue, assignee, by, id);
  }
  return { ok: true };
});

route('POST', '/api/tasks/:id/reopen', (id) => {
  mustExist('tasks', id);
  db.prepare('UPDATE tasks SET done = 0 WHERE id = ?').run(id);
  return { ok: true };
});

route('DELETE', '/api/tasks/:id', (id) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  return { ok: true };
});

route('POST', '/api/tasks/clear-done', () => {
  db.prepare('DELETE FROM tasks WHERE done = 1').run();
  return { ok: true };
});

// Réglages
route('PUT', '/api/settings', (_, b) => {
  if (b.tricount_url !== undefined) {
    const url = optText(b.tricount_url, 500, 'Le lien');
    if (url && !/^https:\/\/\S+$/i.test(url)) throw new HttpError(400, 'Le lien doit commencer par https://');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      'tricount_url', url,
    );
  }
  return { ok: true };
});

// ---------- Serveur HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100_000) {
        reject(new HttpError(413, 'Requête trop grosse'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolveBody({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolveBody(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new HttpError(400, 'JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function serveStatic(req, res, pathname) {
  const file = resolve(PUBLIC, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(PUBLIC + sep)) return send(res, 403, { error: 'Interdit' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Introuvable' });
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Méthode non autorisée' });
    return serveStatic(req, res, decodeURIComponent(pathname));
  }
  try {
    for (const r of routes) {
      const m = r.method === req.method && pathname.match(r.re);
      if (!m) continue;
      const body = req.method === 'GET' ? {} : await readBody(req);
      return send(res, 200, r.handler(m[1] ? Number(m[1]) : null, body));
    }
    send(res, 404, { error: 'Route inconnue' });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    send(res, err.status || 500, { error: err instanceof HttpError ? err.message : 'Erreur serveur' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🏠 App coloc lancée`);
  console.log(`   Sur ce Mac :      http://localhost:${PORT}`);
  for (const nets of Object.values(networkInterfaces())) {
    for (const n of nets ?? []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`   Sur le wifi :     http://${n.address}:${PORT}`);
    }
  }
  console.log('');
});
