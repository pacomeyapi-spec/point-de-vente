const express  = require('express');
const Database = require('better-sqlite3');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'pv')
  : path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'pv.db'));

db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS accounts (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'Mobile Money',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS days (
    date                 TEXT PRIMARY KEY,
    manager_cash_morning REAL NOT NULL DEFAULT 0,
    manager_cash_evening REAL NOT NULL DEFAULT 0,
    closed               INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS account_days (
    account_id TEXT NOT NULL,
    date       TEXT NOT NULL,
    period     TEXT NOT NULL,
    balance    REAL NOT NULL DEFAULT 0,
    cash       REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, date, period)
  );
  CREATE TABLE IF NOT EXISTS adjustments (
    id         TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    date       TEXT NOT NULL,
    type       TEXT NOT NULL,
    amount     REAL NOT NULL,
    reason     TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
`);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function ensureDay(date) {
  const exists = db.prepare('SELECT 1 FROM days WHERE date = ?').get(date);
  if (!exists) db.prepare('INSERT INTO days (date) VALUES (?)').run(date);
}

app.get('/api/accounts', (req, res) => {
  res.json(db.prepare('SELECT * FROM accounts ORDER BY created_at ASC').all());
});
app.post('/api/accounts', (req, res) => {
  const { name, type } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  const acc = { id: uid(), name: name.trim(), type: type || 'Mobile Money', created_at: Date.now() };
  db.prepare('INSERT INTO accounts (id, name, type, created_at) VALUES (?, ?, ?, ?)').run(acc.id, acc.name, acc.type, acc.created_at);
  res.json(acc);
});
app.put('/api/accounts/:id', (req, res) => {
  const { name, type } = req.body;
  db.prepare('UPDATE accounts SET name = ?, type = ? WHERE id = ?').run(name?.trim() || '', type || 'Mobile Money', req.params.id);
  res.json({ ok: true });
});
app.delete('/api/accounts/:id', (req, res) => {
  db.prepare('DELETE FROM adjustments WHERE account_id = ?').run(req.params.id);
  db.prepare('DELETE FROM account_days WHERE account_id = ?').run(req.params.id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/days/:date', (req, res) => {
  const { date } = req.params;
  ensureDay(date);
  const day  = db.prepare('SELECT * FROM days WHERE date = ?').get(date);
  const ads  = db.prepare('SELECT * FROM account_days WHERE date = ?').all(date);
  const adjs = db.prepare('SELECT * FROM adjustments WHERE date = ? ORDER BY created_at ASC').all(date);
  const morning = {}, evening = {};
  for (const ad of ads) {
    const target = ad.period === 'morning' ? morning : evening;
    target[ad.account_id] = { balance: ad.balance, cash: ad.cash };
  }
  res.json({ date, morning, evening, adjustments: adjs, managerCash: day.manager_cash_morning, eveningManagerCash: day.manager_cash_evening, closed: !!day.closed });
});

app.post('/api/days/:date/morning', (req, res) => {
  const { date } = req.params;
  const { accounts, managerCash } = req.body;
  ensureDay(date);
  db.prepare('UPDATE days SET manager_cash_morning = ? WHERE date = ?').run(managerCash || 0, date);
  const upsert = db.prepare(`INSERT INTO account_days (account_id, date, period, balance, cash) VALUES (?, ?, 'morning', ?, ?) ON CONFLICT(account_id, date, period) DO UPDATE SET balance = excluded.balance, cash = excluded.cash`);
  db.transaction(() => { for (const [id, d] of Object.entries(accounts || {})) upsert.run(id, date, d.balance || 0, d.cash || 0); })();
  res.json({ ok: true });
});

app.post('/api/days/:date/evening', (req, res) => {
  const { date } = req.params;
  const { accounts, eveningManagerCash } = req.body;
  ensureDay(date);
  db.prepare('UPDATE days SET manager_cash_evening = ?, closed = 1 WHERE date = ?').run(eveningManagerCash || 0, date);
  const upsert = db.prepare(`INSERT INTO account_days (account_id, date, period, balance, cash) VALUES (?, ?, 'evening', ?, ?) ON CONFLICT(account_id, date, period) DO UPDATE SET balance = excluded.balance, cash = excluded.cash`);
  db.transaction(() => { for (const [id, d] of Object.entries(accounts || {})) upsert.run(id, date, d.balance || 0, d.cash || 0); })();
  res.json({ ok: true });
});

app.post('/api/days/:date/adjustments', (req, res) => {
  const { date } = req.params;
  const { accountId, type, amount, reason } = req.body;
  if (!accountId || !amount || amount <= 0) return res.status(400).json({ error: 'Invalide' });
  ensureDay(date);
  const adj = { id: uid(), account_id: accountId, date, type: type || 'add', amount: parseFloat(amount), reason: reason || '', created_at: Date.now() };
  db.prepare('INSERT INTO adjustments (id, account_id, date, type, amount, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(adj.id, adj.account_id, adj.date, adj.type, adj.amount, adj.reason, adj.created_at);
  res.json(adj);
});
app.delete('/api/adjustments/:id', (req, res) => {
  db.prepare('DELETE FROM adjustments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/history', (req, res) => {
  res.json(db.prepare('SELECT date FROM days ORDER BY date DESC').all().map(d => d.date));
});
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('Point de Vente demarré sur le port ' + PORT);
  console.log('Base de données : ' + path.join(DATA_DIR, 'pv.db'));
});
