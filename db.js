const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// On Vercel, only /tmp is writable, and it resets between cold starts/deployments.
// Locally or on a real server, we use the project's own /data folder so it persists properly.
const DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'data')
  : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function defaultStore() {
  return { users: [], documents: [], signatures: [], driveFolders: {}, _nextUserId: 1 };
}

function load() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = defaultStore();
    const hash = bcrypt.hashSync('admin123', 10);
    initial.users.push({
      id: 1, username: 'admin', password_hash: hash, full_name: 'Administrator',
      department: 'QA', role: 'admin', created_at: new Date().toISOString()
    });
    initial._nextUserId = 2;
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    console.log('Seeded default admin user -> username: admin / password: admin123 (GANTI SEGERA)');
    return initial;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}

let store = load();
if (!store.driveFolders) store.driveFolders = {}; // safety net for stores created before this field existed

function persist() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

module.exports = {
  // ---- users ----
  getUserByUsername(username) {
    return store.users.find(u => u.username === username) || null;
  },
  createUser({ username, password, full_name, department, role }) {
    if (store.users.some(u => u.username === username)) {
      throw new Error('Username sudah dipakai');
    }
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
    persist();
    return user;
  },
  getUserById(id) {
    return store.users.find(u => u.id === id) || null;
  },

  // ---- documents ----
  createDocument(doc) {
    store.documents.push({ ...doc, created_at: new Date().toISOString(), status: 'pending', signed_filename: null });
    persist();
  },
  getDocumentById(id) {
    return store.documents.find(d => d.id === id) || null;
  },
  getAllDocumentsWithUploader() {
    return store.documents
      .slice()
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .map(d => {
        const uploader = this.getUserById(d.uploaded_by);
        return { ...d, uploaded_by_name: uploader ? uploader.full_name : 'Unknown' };
      });
  },
  markDocumentSigned(id, signed_filename, driveInfo) {
    const doc = store.documents.find(d => d.id === id);
    if (doc) {
      doc.status = 'signed';
      doc.signed_filename = signed_filename;
      if (driveInfo) {
        doc.drive_file_id = driveInfo.fileId;
        doc.drive_view_link = driveInfo.webViewLink;
      }
      persist();
    }
  },

  // ---- google drive folder cache ----
  getDriveFolderId(department) {
    return store.driveFolders[department] || null;
  },
  setDriveFolderId(department, folderId) {
    store.driveFolders[department] = folderId;
    persist();
  },

  // ---- signatures ----
  createSignature(sig) {
    store.signatures.push({ ...sig, signed_at: new Date().toISOString() });
    persist();
  },
  getLatestSignatureForDocument(documentId) {
    const sigs = store.signatures.filter(s => s.document_id === documentId);
    if (sigs.length === 0) return null;
    return sigs.sort((a, b) => new Date(b.signed_at) - new Date(a.signed_at))[0];
  },
  getSignatureWithDetails(signatureId) {
    const sig = store.signatures.find(s => s.id === signatureId);
    if (!sig) return null;
    const doc = this.getDocumentById(sig.document_id);
    const signer = this.getUserById(sig.signed_by);
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
  },

  DATA_DIR
};
