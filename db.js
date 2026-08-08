const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// ---------------------------------------------------------------------------
// Storage backend selection
// ---------------------------------------------------------------------------
// On Vercel, each request can be handled by a different, short-lived instance.
// A JSON file written to /tmp is NOT shared between those instances - so data
// (new users, new signatures, etc.) can randomly "disappear" depending on which
// instance handles the next request. Vercel KV is a real hosted key-value store,
// so all instances read/write the same centralized data - this fixes that.
//
// Locally, or on a real always-on server (PM2/office server), there's only ever
// one process, so the simple JSON file works fine and needs no extra setup.
const KV_CONFIGURED = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
let kv = null;
if (KV_CONFIGURED) {
  const { Redis } = require('@upstash/redis');
  kv = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

const DATA_DIR = process.env.VERCEL ? path.join('/tmp', 'data') : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const KV_KEY = 'qr_signature_app_store';

if (!KV_CONFIGURED && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function defaultStore() {
  const adminHash = bcrypt.hashSync('admin123', 10);
  const devHash = bcrypt.hashSync('dev1066', 10);
  return {
    users: [
      { id: 1, username: 'admin', password_hash: adminHash, full_name: 'Administrator', department: 'QA', role: 'admin', created_at: new Date().toISOString() },
      { id: 2, username: 'dev', password_hash: devHash, full_name: 'Developer', department: 'QA', role: 'admin', created_at: new Date().toISOString() }
    ],
    documents: [],
    signatures: [],
    driveFolders: {},
    departments: ['QA', 'Produksi', 'PPIC', 'Gudang', 'HRD'],
    _nextUserId: 3
  };
}

let cache = null; // per-invocation memory cache; KV (or the file) is always the real source of truth

async function loadStore() {
  if (KV_CONFIGURED) {
    const remote = await kv.get(KV_KEY);
    if (remote) { cache = remote; return cache; }
    cache = defaultStore();
    await kv.set(KV_KEY, cache);
    console.log('Seeded default admin accounts (Vercel KV) -> admin/admin123 dan dev/dev1066 (GANTI SEGERA)');
    return cache;
  }
  if (cache) return cache; // already loaded once in this long-lived process
  if (!fs.existsSync(DATA_FILE)) {
    cache = defaultStore();
    fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2));
    console.log('Seeded default admin accounts (file) -> admin/admin123 dan dev/dev1066 (GANTI SEGERA)');
    return cache;
  }
  cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  if (!cache.driveFolders) cache.driveFolders = {};
  if (!cache.departments) cache.departments = ['QA', 'Produksi', 'PPIC', 'Gudang', 'HRD'];
  return cache;
}

async function ensure() {
  if (!cache) await loadStore();
  return cache;
}

async function persist() {
  if (KV_CONFIGURED) {
    await kv.set(KV_KEY, cache);
  } else {
    fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2));
  }
}

module.exports = {
  isUsingKV: KV_CONFIGURED,

  // ---- users ----
  async getUserByUsername(username) {
    const store = await ensure();
    return store.users.find(u => u.username === username) || null;
  },
  async createUser({ username, password, full_name, department, role }) {
    const store = await ensure();
    if (store.users.some(u => u.username === username)) throw new Error('Username sudah dipakai');
    const user = {
      id: store._nextUserId++,
      username,
      password_hash: bcrypt.hashSync(password, 10),
      full_name,
      department: department || null,
      role: role || 'personil',
      created_at: new Date().toISOString()
    };
    store.users.push(user);
    await persist();
    return user;
  },
  async getUserById(id) {
    const store = await ensure();
    return store.users.find(u => u.id === id) || null;
  },
  async listUsers() {
    const store = await ensure();
    return store.users.map(({ password_hash, ...safe }) => safe);
  },
  async resetUserPassword(userId, newPassword) {
    const store = await ensure();
    const user = store.users.find(u => u.id === userId);
    if (!user) throw new Error('User tidak ditemukan');
    user.password_hash = bcrypt.hashSync(newPassword, 10);
    await persist();
  },
  async deleteUser(userId) {
    const store = await ensure();
    const idx = store.users.findIndex(u => u.id === userId);
    if (idx === -1) throw new Error('User tidak ditemukan');
    store.users.splice(idx, 1);
    await persist();
  },

  // ---- documents ----
  async createDocument(doc) {
    const store = await ensure();
    store.documents.push({ ...doc, created_at: new Date().toISOString(), status: 'pending', signed_filename: null });
    await persist();
  },
  async getDocumentById(id) {
    const store = await ensure();
    return store.documents.find(d => d.id === id) || null;
  },
  async getAllDocumentsWithUploader() {
    const store = await ensure();
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
    const store = await ensure();
    const doc = store.documents.find(d => d.id === id);
    if (doc) {
      doc.status = 'signed';
      doc.signed_filename = signed_filename;
      if (driveInfo) {
        doc.drive_file_id = driveInfo.fileId;
        doc.drive_view_link = driveInfo.webViewLink;
      }
      await persist();
    }
  },

  // ---- google drive folder cache ----
  async getDriveFolderId(department) {
    const store = await ensure();
    return store.driveFolders[department] || null;
  },
  async setDriveFolderId(department, folderId) {
    const store = await ensure();
    store.driveFolders[department] = folderId;
    await persist();
  },

  // ---- departments ----
  async listDepartments() {
    const store = await ensure();
    return store.departments.map(name => ({ name, drive_folder_id: store.driveFolders[name] || null }));
  },
  async addDepartment(name) {
    const store = await ensure();
    const trimmed = (name || '').trim();
    if (!trimmed) throw new Error('Nama departemen tidak boleh kosong');
    if (store.departments.includes(trimmed)) throw new Error('Departemen sudah ada');
    store.departments.push(trimmed);
    await persist();
  },
  async removeDepartment(name) {
    const store = await ensure();
    store.departments = store.departments.filter(d => d !== name);
    await persist();
  },

  // ---- signatures ----
  async createSignature(sig) {
    const store = await ensure();
    store.signatures.push({ ...sig, signed_at: new Date().toISOString() });
    await persist();
  },
  async getLatestSignatureForDocument(documentId) {
    const store = await ensure();
    const sigs = store.signatures.filter(s => s.document_id === documentId);
    if (sigs.length === 0) return null;
    return sigs.sort((a, b) => new Date(b.signed_at) - new Date(a.signed_at))[0];
  },
  async getSignatureCountForDocument(documentId) {
    const store = await ensure();
    return store.signatures.filter(s => s.document_id === documentId).length;
  },
  async getAllSignaturesForDocument(documentId) {
    const store = await ensure();
    const usersById = new Map(store.users.map(u => [u.id, u]));
    return store.signatures
      .filter(s => s.document_id === documentId)
      .sort((a, b) => new Date(a.signed_at) - new Date(b.signed_at))
      .map(s => ({ ...s, signer_name: usersById.has(s.signed_by) ? usersById.get(s.signed_by).full_name : 'Unknown' }));
  },
  async getSignatureWithDetails(signatureId) {
    const store = await ensure();
    const sig = store.signatures.find(s => s.id === signatureId);
    if (!sig) return null;
    const doc = store.documents.find(d => d.id === sig.document_id);
    const signer = store.users.find(u => u.id === sig.signed_by);
    return {
      ...sig,
      doc_name: doc.doc_name,
      doc_number: doc.doc_number,
      department: doc.department,
      signed_filename: doc.signed_filename,
      file_type: doc.file_type,
      drive_view_link: doc.drive_view_link || null,
      signer_name: signer ? signer.full_name : 'Unknown',
      signer_department: signer ? signer.department : null
    };
  }
};
