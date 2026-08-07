const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const db = new Database(path.join(__dirname, 'data', 'app.db'));

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  department TEXT,
  role TEXT DEFAULT 'personil', -- 'personil' or 'admin'
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, -- uuid
  doc_name TEXT NOT NULL,
  doc_number TEXT NOT NULL,
  department TEXT NOT NULL,
  file_type TEXT NOT NULL, -- 'pdf' or 'image'
  original_filename TEXT NOT NULL,
  stored_filename TEXT NOT NULL,
  uploaded_by INTEGER NOT NULL,
  status TEXT DEFAULT 'pending', -- 'pending' or 'signed'
  signed_filename TEXT,
  page_width REAL,
  page_height REAL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS signatures (
  id TEXT PRIMARY KEY, -- uuid, used in verification link
  document_id TEXT NOT NULL,
  signed_by INTEGER NOT NULL,
  qr_x REAL NOT NULL, -- position as fraction of page (0-1)
  qr_y REAL NOT NULL,
  qr_size REAL NOT NULL,
  page_number INTEGER DEFAULT 1,
  signed_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (document_id) REFERENCES documents(id),
  FOREIGN KEY (signed_by) REFERENCES users(id)
);
`);

// Seed a default admin if no users exist yet
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
if (userCount === 0) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare(`INSERT INTO users (username, password_hash, full_name, department, role) VALUES (?, ?, ?, ?, ?)`)
    .run('admin', hash, 'Administrator', 'QA', 'admin');
  console.log('Seeded default admin user -> username: admin / password: admin123 (GANTI SEGERA)');
}

module.exports = db;
