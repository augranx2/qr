const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// ---------------------------------------------------------------------------
// Storage backend selection
// ---------------------------------------------------------------------------
// On Vercel, each request can be handled by a different, short-lived instance.
// IMPORTANT: earlier versions of this file stored everything as ONE big JSON
// blob under a single Redis key (read whole blob -> mutate in memory -> write
// whole blob back). That has a lost-update race: if two requests land on two
// different instances close together, whichever one finishes its "read -> write"
// cycle LAST wins and silently overwrites the other's change (e.g. a second new
// user vanishing even though the first one persisted fine).
//
// This version stores each entity (each user, each document, each signature)
// as its OWN Redis hash field, so two different requests writing two different
// users/documents can never clobber each other - each write only touches the
// one field it's responsible for.
const KV_PREFIX = 'qrsig';
function findEnvValue(exactNames, suffix) {
  for (const name of exactNames) {
    if (process.env[name]) return process.env[name];
  }
  const match = Object.keys(process.env).find(k => k.endsWith(suffix));
  return match ? process.env[match] : null;
}

const KV_URL = findEnvValue(['KV_REST_API_URL'], '_KV_REST_API_URL');
// Deliberately look for the exact "_KV_REST_API_TOKEN" suffix - the read-only variant is
// named "..._KV_REST_API_READ_ONLY_TOKEN" and does NOT end with that suffix, so it's
// naturally excluded (we need read-write access to store data).
const KV_TOKEN = findEnvValue(['KV_REST_API_TOKEN'], '_KV_REST_API_TOKEN');
const KV_CONFIGURED = !!(KV_URL && KV_TOKEN);
let kv = null;
if (KV_CONFIGURED) {
  const { Redis } = require('@upstash/redis');
  kv = new Redis({ url: KV_URL, token: KV_TOKEN });
}

// Always log this at startup so it's easy to check in Vercel's Runtime Logs tab
// whether the app is really using Upstash or silently falling back to the file.
console.log(
  KV_CONFIGURED
    ? `[DB] Backend aktif: Upstash Redis, skema per-item (aman dari race condition antar-instance)`
    : `[DB] Backend aktif: file lokal (data/store.json) - PERINGATAN: ini TIDAK aman dipakai di Vercel karena bisa hilang antar-request.`
);

// ---------------------------------------------------------------------------
// Local file fallback (used only when Upstash isn't configured - fine for a
// single always-on process like local dev or PM2 on an office server, since
// there's no concurrency across separate instances to race against).
// ---------------------------------------------------------------------------
const DATA_DIR = process.env.VERCEL ? path.join('/tmp', 'data') : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
if (!KV_CONFIGURED && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function defaultAdmins() {
  const adminHash = bcrypt.hashSync('admin123', 10);
  const devHash = bcrypt.hashSync('dev1066', 10);
  return [
    { id: 1, username: 'admin', password_hash: adminHash, full_name: 'Administrator', department: 'QA', role: 'admin', created_at: new Date().toISOString() },
    { id: 2, username: 'dev', password_hash: devHash, full_name: 'Developer', department: 'QA', role: 'admin', created_at: new Date().toISOString() }
  ];
}
const DEFAULT_DEPARTMENTS = ['QA', 'Produksi', 'PPIC', 'Gudang', 'HRD'];

let fileCache = null;
function loadFileStore() {
  if (fileCache) return fileCache;
  if (!fs.existsSync(DATA_FILE)) {
    fileCache = { users: defaultAdmins(), documents: [], signatures: [], driveFolders: {}, departments: [...DEFAULT_DEPARTMENTS], _nextUserId: 3 };
    fs.writeFileSync(DATA_FILE, JSON.stringify(fileCache, null, 2));
    console.log('Seeded default admin accounts (file) -> admin/admin123 dan dev/dev1066 (GANTI SEGERA)');
    return fileCache;
  }
  fileCache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  if (!fileCache.driveFolders) fileCache.driveFolders = {};
  if (!fileCache.departments) fileCache.departments = [...DEFAULT_DEPARTMENTS];
  return fileCache;
}
function persistFileStore() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(fileCache, null, 2));
}

// ---------------------------------------------------------------------------
// Redis (Upstash) helpers - each entity type lives in its own hash, keyed by id.
// ---------------------------------------------------------------------------
const K = {
  users: `${KV_PREFIX}:users`,               // hash: userId -> JSON(user)
  usernameIndex: `${KV_PREFIX}:username_idx`, // hash: username -> userId
  nextUserId: `${KV_PREFIX}:next_user_id`,    // counter
  documents: `${KV_PREFIX}:documents`,        // hash: docId -> JSON(doc)
  signatures: `${KV_PREFIX}:signatures`,      // hash: sigId -> JSON(signature)
  departments: `${KV_PREFIX}:departments`,    // set of department names
  driveFolders: `${KV_PREFIX}:drive_folders`, // hash: department -> folderId
  seeded: `${KV_PREFIX}:seeded`               // flag so default admins are seeded exactly once
};

let seedPromise = null;
async function ensureSeeded() {
  if (!KV_CONFIGURED) return;
  if (seedPromise) return seedPromise; // avoid duplicate seeding within this same warm instance
  seedPromise = (async () => {
    // SET ... NX only succeeds if the key doesn't already exist - this makes the "has anyone
    // already seeded this?" check atomic even if two cold-starting instances race here at
    // the same time; only one of them will get the actual green light to seed.
    const acquired = await kv.set(K.seeded, '1', { nx: true });
    if (!acquired) return; // someone else already seeded (or is seeding right now)
    for (const user of defaultAdmins()) {
      await kv.hset(K.users, { [user.id]: JSON.stringify(user) });
      await kv.hset(K.usernameIndex, { [user.username]: String(user.id) });
    }
    await kv.set(K.nextUserId, 3);
    for (const dept of DEFAULT_DEPARTMENTS) {
      await kv.sadd(K.departments, dept);
    }
    console.log('Seeded default admin accounts (Upstash Redis) -> admin/admin123 dan dev/dev1066 (GANTI SEGERA)');
  })();
  return seedPromise;
}

module.exports = {
  isUsingKV: KV_CONFIGURED,

  // ---- users ----
  async getUserByUsername(username) {
    await ensureSeeded();
    if (KV_CONFIGURED) {
      const userId = await kv.hget(K.usernameIndex, username);
      if (!userId) return null;
      const raw = await kv.hget(K.users, String(userId));
      return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    }
    const store = loadFileStore();
    return store.users.find(u => u.username === username) || null;
  },
  async createUser({ username, password, full_name, department, role, jabatan }) {
    await ensureSeeded();
    if (KV_CONFIGURED) {
      const existing = await kv.hget(K.usernameIndex, username);
      if (existing) throw new Error('Username sudah dipakai');
      const id = await kv.incr(K.nextUserId);
      const user = {
        id, username, password_hash: bcrypt.hashSync(password, 10),
        full_name, department: department || null, role: role || 'personil',
        jabatan: jabatan || null,
        created_at: new Date().toISOString()
      };
      await kv.hset(K.users, { [id]: JSON.stringify(user) });
      await kv.hset(K.usernameIndex, { [username]: String(id) });
      return user;
    }
    const store = loadFileStore();
    if (store.users.some(u => u.username === username)) throw new Error('Username sudah dipakai');
    const user = {
      id: store._nextUserId++, username, password_hash: bcrypt.hashSync(password, 10),
      full_name, department: department || null, role: role || 'personil',
      jabatan: jabatan || null,
      created_at: new Date().toISOString()
    };
    store.users.push(user);
    persistFileStore();
    return user;
  },
  async getUserById(id) {
    await ensureSeeded();
    if (KV_CONFIGURED) {
      const raw = await kv.hget(K.users, String(id));
      return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    }
    const store = loadFileStore();
    return store.users.find(u => u.id === id) || null;
  },
  async listUsers() {
    await ensureSeeded();
    if (KV_CONFIGURED) {
      const all = await kv.hgetall(K.users) || {};
      return Object.values(all).map(raw => {
        const u = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const { password_hash, ...safe } = u;
        return safe;
      });
    }
    const store = loadFileStore();
    return store.users.map(({ password_hash, ...safe }) => safe);
  },
  async resetUserPassword(userId, newPassword) {
    await ensureSeeded();
    if (KV_CONFIGURED) {
      const raw = await kv.hget(K.users, String(userId));
      if (!raw) throw new Error('User tidak ditemukan');
      const user = typeof raw === 'string' ? JSON.parse(raw) : raw;
      user.password_hash = bcrypt.hashSync(newPassword, 10);
      await kv.hset(K.users, { [userId]: JSON.stringify(user) });
      return;
    }
    const store = loadFileStore();
    const user = store.users.find(u => u.id === userId);
    if (!user) throw new Error('User tidak ditemukan');
    user.password_hash = bcrypt.hashSync(newPassword, 10);
    persistFileStore();
  },
  async deleteUser(userId) {
    await ensureSeeded();
    if (KV_CONFIGURED) {
      const raw = await kv.hget(K.users, String(userId));
      if (!raw) throw new Error('User tidak ditemukan');
      const user = typeof raw === 'string' ? JSON.parse(raw) : raw;
      await kv.hdel(K.users, String(userId));
      await kv.hdel(K.usernameIndex, user.username);
      return;
    }
    const store = loadFileStore();
    const idx = store.users.findIndex(u => u.id === userId);
    if (idx === -1) throw new Error('User tidak ditemukan');
    store.users.splice(idx, 1);
    persistFileStore();
  },

  // ---- documents ----
  async createDocument(doc) {
    await ensureSeeded();
    const full = { ...doc, created_at: new Date().toISOString(), status: 'pending', signed_filename: null };
    if (KV_CONFIGURED) {
      await kv.hset(K.documents, { [doc.id]: JSON.stringify(full) });
      return;
    }
    const store = loadFileStore();
    store.documents.push(full);
    persistFileStore();
  },
  async getDocumentById(id) {
    await ensureSeeded();
    if (KV_CONFIGURED) {
      const raw = await kv.hget(K.documents, id);
      return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    }
    const store = loadFileStore();
    return store.documents.find(d => d.id === id) || null;
  },
  async getAllDocumentsWithUploader() {
    await ensureSeeded();
    if (KV_CONFIGURED) {
      const [docsRaw, usersRaw, sigsRaw] = await Promise.all([
        kv.hgetall(K.documents), kv.hgetall(K.users), kv.hgetall(K.signatures)
      ]);
      const docs = Object.values(docsRaw || {}).map(r => typeof r === 'string' ? JSON.parse(r) : r);
      const users = Object.values(usersRaw || {}).map(r => typeof r === 'string' ? JSON.parse(r) : r);
      const sigs = Object.values(sigsRaw || {}).map(r => typeof r === 'string' ? JSON.parse(r) : r);
      const usersById = new Map(users.map(u => [u.id, u]));
      return docs
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .map(d => ({
          ...d,
          uploaded_by_name: usersById.has(d.uploaded_by) ? usersById.get(d.uploaded_by).full_name : 'Unknown',
          signature_count: sigs.filter(s => s.document_id === d.id).length
        }));
    }
    const store = loadFileStore();
    const usersById = new Map(store.users.map(u => [u.id, u]));
    return store.documents
      .slice()
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .map(d => ({
        ...d,
        uploaded_by_name: usersById.has(d.uploaded_by) ? usersById.get(d.uploaded_by).full_name : 'Unknown',
        signature_count: store.signatures.filter(s => s.document_id === d.id).length
      }));
  },
  async markDocumentSigned(id, signed_filename, driveInfo) {
    await ensureSeeded();
    if (KV_CONFIGURED) {
      const raw = await kv.hget(K.documents, id);
      if (!raw) return;
      const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
      doc.status = 'signed';
      doc.signed_filename = signed_filename;
      if (driveInfo) { doc.drive_file_id = driveInfo.fileId; doc.drive_view_link = driveInfo.webViewLink; }
      await kv.hset(K.documents, { [id]: JSON.stringify(doc) });
      return;
    }
    const store = loadFileStore();
    const doc = store.documents.find(d => d.id === id);
    if (doc) {
      doc.status = 'signed';
      doc.signed_filename = signed_filename;
      if (driveInfo) { doc.drive_file_id = driveInfo.fileId; doc.drive_view_link = driveInfo.webViewLink; }
      persistFileStore();
    }
  },

  // ---- google drive folder cache ----
  async getDriveFolderId(department) {
    await ensureSeeded();
    if (KV_CONFIGURED) return (await kv.hget(K.driveFolders, department)) || null;
    const store = loadFileStore();
    return store.driveFolders[department] || null;
  },
  async setDriveFolderId(department, folderId) {
    await ensureSeeded();
    if (KV_CONFIGURED) { await kv.hset(K.driveFolders, { [department]: folderId }); return; }
    const store = loadFileStore();
    store.driveFolders[department] = folderId;
    persistFileStore();
  },

  // ---- departments ----
  async listDepartments() {
    await ensureSeeded();
    if (KV_CONFIGURED) {
      const [names, folders] = await Promise.all([kv.smembers(K.departments), kv.hgetall(K.driveFolders)]);
      return (names || []).map(name => ({ name, drive_folder_id: (folders && folders[name]) || null }));
    }
    const store = loadFileStore();
    return store.departments.map(name => ({ name, drive_folder_id: store.driveFolders[name] || null }));
  },
  async addDepartment(name) {
    await ensureSeeded();
    const trimmed = (name || '').trim();
    if (!trimmed) throw new Error('Nama departemen tidak boleh kosong');
    if (KV_CONFIGURED) {
      const exists = await kv.sismember(K.departments, trimmed);
      if (exists) throw new Error('Departemen sudah ada');
      await kv.sadd(K.departments, trimmed);
      return;
    }
    const store = loadFileStore();
    if (store.departments.includes(trimmed)) throw new Error('Departemen sudah ada');
    store.departments.push(trimmed);
    persistFileStore();
  },
  async removeDepartment(name) {
    await ensureSeeded();
    if (KV_CONFIGURED) { await kv.srem(K.departments, name); return; }
    const store = loadFileStore();
    store.departments = store.departments.filter(d => d !== name);
    persistFileStore();
  },

  // ---- signatures ----
  async createSignature(sig) {
    await ensureSeeded();
    const full = { ...sig, signed_at: new Date().toISOString() };
    if (KV_CONFIGURED) { await kv.hset(K.signatures, { [sig.id]: JSON.stringify(full) }); return; }
    const store = loadFileStore();
    store.signatures.push(full);
    persistFileStore();
  },
  async getLatestSignatureForDocument(documentId) {
    await ensureSeeded();
    if (KV_CONFIGURED) {
      const all = await kv.hgetall(K.signatures) || {};
      const sigs = Object.values(all).map(r => typeof r === 'string' ? JSON.parse(r) : r).filter(s => s.document_id === documentId);
      if (sigs.length === 0) return null;
      return sigs.sort((a, b) => new Date(b.signed_at) - new Date(a.signed_at))[0];
    }
    const store = loadFileStore();
    const sigs = store.signatures.filter(s => s.document_id === documentId);
    if (sigs.length === 0) return null;
    return sigs.sort((a, b) => new Date(b.signed_at) - new Date(a.signed_at))[0];
  },
  async getSignatureCountForDocument(documentId) {
    await ensureSeeded();
    if (KV_CONFIGURED) {
      const all = await kv.hgetall(K.signatures) || {};
      return Object.values(all).map(r => typeof r === 'string' ? JSON.parse(r) : r).filter(s => s.document_id === documentId).length;
    }
    const store = loadFileStore();
    return store.signatures.filter(s => s.document_id === documentId).length;
  },
  async getAllSignaturesForDocument(documentId) {
    await ensureSeeded();
    if (KV_CONFIGURED) {
      const [sigsRaw, usersRaw] = await Promise.all([kv.hgetall(K.signatures), kv.hgetall(K.users)]);
      const sigs = Object.values(sigsRaw || {}).map(r => typeof r === 'string' ? JSON.parse(r) : r).filter(s => s.document_id === documentId);
      const users = Object.values(usersRaw || {}).map(r => typeof r === 'string' ? JSON.parse(r) : r);
      const usersById = new Map(users.map(u => [u.id, u]));
      return sigs
        .sort((a, b) => new Date(a.signed_at) - new Date(b.signed_at))
        .map(s => ({ ...s, signer_name: usersById.has(s.signed_by) ? usersById.get(s.signed_by).full_name : 'Unknown' }));
    }
    const store = loadFileStore();
    const usersById = new Map(store.users.map(u => [u.id, u]));
    return store.signatures
      .filter(s => s.document_id === documentId)
      .sort((a, b) => new Date(a.signed_at) - new Date(b.signed_at))
      .map(s => ({ ...s, signer_name: usersById.has(s.signed_by) ? usersById.get(s.signed_by).full_name : 'Unknown' }));
  },
  async getSignatureWithDetails(signatureId) {
    await ensureSeeded();
    if (KV_CONFIGURED) {
      const raw = await kv.hget(K.signatures, signatureId);
      if (!raw) return null;
      const sig = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const [docRaw, signerRaw] = await Promise.all([
        kv.hget(K.documents, sig.document_id), kv.hget(K.users, String(sig.signed_by))
      ]);
      const doc = docRaw ? (typeof docRaw === 'string' ? JSON.parse(docRaw) : docRaw) : null;
      const signer = signerRaw ? (typeof signerRaw === 'string' ? JSON.parse(signerRaw) : signerRaw) : null;
      return {
        ...sig,
        doc_name: doc ? doc.doc_name : null,
        doc_number: doc ? doc.doc_number : null,
        department: doc ? doc.department : null,
        signed_filename: doc ? doc.signed_filename : null,
        file_type: doc ? doc.file_type : null,
        drive_view_link: doc ? (doc.drive_view_link || null) : null,
        signer_name: signer ? signer.full_name : 'Unknown',
        signer_department: signer ? signer.department : null,
        signer_jabatan: signer ? (signer.jabatan || null) : null
      };
    }
    const store = loadFileStore();
    const sig = store.signatures.find(s => s.id === signatureId);
    if (!sig) return null;
    const doc = store.documents.find(d => d.id === sig.document_id);
    const signer = store.users.find(u => u.id === sig.signed_by);
    return {
      ...sig,
      doc_name: doc.doc_name, doc_number: doc.doc_number, department: doc.department,
      signed_filename: doc.signed_filename, file_type: doc.file_type,
      drive_view_link: doc.drive_view_link || null,
      signer_name: signer ? signer.full_name : 'Unknown',
      signer_department: signer ? signer.department : null,
      signer_jabatan: signer ? (signer.jabatan || null) : null
    };
  }
};
