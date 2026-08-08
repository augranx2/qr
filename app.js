const express = require('express');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const { PDFDocument } = require('pdf-lib');
const gdrive = require('./google-drive');
const db = require('./db');

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

// On Vercel only /tmp is writable; locally/on-prem we use real project folders so files persist.
const UPLOAD_DIR = process.env.VERCEL ? path.join('/tmp', 'uploads') : path.join(__dirname, 'uploads');
const SIGNED_DIR = process.env.VERCEL ? path.join('/tmp', 'signed') : path.join(__dirname, 'signed');
for (const dir of [UPLOAD_DIR, SIGNED_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const JWT_SECRET = process.env.SESSION_SECRET || 'change-this-secret-in-production';
const TOKEN_MAX_AGE = 1000 * 60 * 60 * 8; // 8 hours

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', (req, res, next) => {
  // Only allow access to uploads if logged in (raw uploaded docs are internal, not yet signed)
  if (!getUserFromRequest(req)) return res.status(401).send('Unauthorized');
  next();
}, express.static(UPLOAD_DIR));
app.use('/signed', express.static(SIGNED_DIR)); // signed docs are viewable via the public verification page

// ---------- Multer upload config ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Tipe file tidak didukung. Gunakan PDF, JPG, atau PNG.'));
  }
});

// ---------- Auth helpers (stateless JWT in an httpOnly cookie - works across serverless instances) ----------
function getUserFromRequest(req) {
  const token = req.cookies && req.cookies.auth_token;
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null; // expired or tampered token
  }
}

function requireLogin(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Belum login' });
  req.user = user;
  next();
}

// ---------- AUTH ROUTES ----------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await db.getUserByUsername(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Username atau password salah' });
  }
  const payload = { id: user.id, username: user.username, full_name: user.full_name, department: user.department, role: user.role };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || !!process.env.VERCEL,
    sameSite: 'lax',
    maxAge: TOKEN_MAX_AGE
  });
  res.json({ user: payload });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ user: getUserFromRequest(req) });
});

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Hanya admin yang bisa melakukan ini' });
  next();
}

// List personil accounts (admin only)
app.get('/api/users', requireLogin, requireAdmin, async (req, res) => {
  res.json({ users: await db.listUsers() });
});

// Admin-only: create personil accounts
app.post('/api/users', requireLogin, requireAdmin, async (req, res) => {
  const { username, password, full_name, department, role } = req.body;
  if (!username || !password || !full_name) return res.status(400).json({ error: 'Data tidak lengkap' });
  try {
    await db.createUser({ username, password, full_name, department, role });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Username sudah dipakai' });
  }
});

// Admin-only: reset a user's password
app.post('/api/users/:id/reset-password', requireLogin, requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 4) return res.status(400).json({ error: 'Password baru minimal 4 karakter' });
  try {
    await db.resetUserPassword(Number(req.params.id), password);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Admin-only: delete a user
app.delete('/api/users/:id', requireLogin, requireAdmin, async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Tidak bisa menghapus akun sendiri' });
  try {
    await db.deleteUser(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- DEPARTMENTS (controlled list used for upload dropdown + Drive folder mapping) ----------
app.get('/api/departments', requireLogin, async (req, res) => {
  res.json({ departments: await db.listDepartments() });
});

app.post('/api/departments', requireLogin, requireAdmin, async (req, res) => {
  try {
    await db.addDepartment(req.body.name || '');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/departments/:name', requireLogin, requireAdmin, async (req, res) => {
  await db.removeDepartment(req.params.name);
  res.json({ ok: true });
});

// Admin-only: manually link a department to an existing Google Drive folder
// (paste a folder ID instead of letting the app auto-create a new one)
app.post('/api/departments/:name/drive-folder', requireLogin, requireAdmin, async (req, res) => {
  const { folderId } = req.body;
  if (!folderId) return res.status(400).json({ error: 'Folder ID wajib diisi' });
  await db.setDriveFolderId(req.params.name, folderId.trim());
  res.json({ ok: true });
});

// ---------- DOCUMENT UPLOAD ----------
app.post('/api/documents', requireLogin, upload.single('file'), async (req, res) => {
  try {
    const { doc_name, doc_number, department } = req.body;
    if (!doc_name || !doc_number || !department) {
      return res.status(400).json({ error: 'Nama dokumen, nomor dokumen, dan departemen wajib diisi' });
    }
    if (!req.file) return res.status(400).json({ error: 'File wajib diupload' });

    const ext = path.extname(req.file.originalname).toLowerCase();
    const file_type = ext === '.pdf' ? 'pdf' : 'image';
    const id = uuidv4();

    let page_width = null, page_height = null;
    if (file_type === 'pdf') {
      const bytes = fs.readFileSync(req.file.path);
      const pdfDoc = await PDFDocument.load(bytes);
      const firstPage = pdfDoc.getPage(0);
      page_width = firstPage.getWidth();
      page_height = firstPage.getHeight();
    }

    await db.createDocument({
      id, doc_name, doc_number, department, file_type,
      original_filename: req.file.originalname,
      stored_filename: req.file.filename,
      uploaded_by: req.user.id,
      page_width, page_height
    });

    res.json({ id, file_type, stored_filename: req.file.filename });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Gagal memproses dokumen' });
  }
});

// List documents
app.get('/api/documents', requireLogin, async (req, res) => {
  res.json({ documents: await db.getAllDocumentsWithUploader() });
});

app.get('/api/documents/:id', requireLogin, async (req, res) => {
  const doc = await db.getDocumentById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Dokumen tidak ditemukan' });
  const signature_count = await db.getSignatureCountForDocument(doc.id);
  // If this document already has at least one QR embedded, preview/edit on top of that
  // version instead of the original upload, so new QR placements don't overlap old ones.
  const current_file_url = doc.signed_filename ? `/signed/${doc.signed_filename}` : `/uploads/${doc.stored_filename}`;
  res.json({ document: { ...doc, signature_count, current_file_url } });
});

// ---------- SIGNING (place QR + embed) ----------
app.post('/api/documents/:id/sign', requireLogin, async (req, res) => {
  try {
    const doc = await db.getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Dokumen tidak ditemukan' });

    const { qr_x, qr_y, qr_size, page_number } = req.body;
    if (qr_x == null || qr_y == null || qr_size == null) {
      return res.status(400).json({ error: 'Posisi QR belum ditentukan' });
    }

    const signatureId = uuidv4();
    const verifyUrl = `${BASE_URL}/verify/${signatureId}`;
    const qrDataUrl = await QRCode.toDataURL(verifyUrl, { margin: 1, width: 300 });
    const qrPngBytes = Buffer.from(qrDataUrl.split(',')[1], 'base64');

    // If this document already has a QR embedded from a previous signature, keep building on
    // top of that version (so QR codes accumulate) instead of starting again from the original.
    const baseFilename = doc.signed_filename || doc.stored_filename;
    const baseDir = doc.signed_filename ? SIGNED_DIR : UPLOAD_DIR;
    const inputPath = path.join(baseDir, baseFilename);
    const outFilename = `${signatureId}${path.extname(doc.stored_filename)}`;
    const outPath = path.join(SIGNED_DIR, outFilename);

    if (doc.file_type === 'pdf') {
      const bytes = fs.readFileSync(inputPath);
      const pdfDoc = await PDFDocument.load(bytes);
      const pageIdx = (page_number || 1) - 1;
      const page = pdfDoc.getPages()[pageIdx];
      const pngImage = await pdfDoc.embedPng(qrPngBytes);
      const { width: pw, height: ph } = page.getSize();
      const qrSizePt = qr_size * pw; // qr_size given as fraction of page width
      // qr_x, qr_y come in as fraction from top-left; pdf-lib origin is bottom-left
      const x = qr_x * pw;
      const y = ph - (qr_y * ph) - qrSizePt;
      page.drawImage(pngImage, { x, y, width: qrSizePt, height: qrSizePt });
      const finalBytes = await pdfDoc.save();
      fs.writeFileSync(outPath, finalBytes);
    } else {
      // Image documents: composite QR onto the image using sharp
      const sharpLib = require('sharp');
      const base = sharpLib(inputPath);
      const meta = await base.metadata();
      const qrSizePx = Math.round(qr_size * meta.width);
      const resizedQr = await sharpLib(qrPngBytes).resize(qrSizePx, qrSizePx).toBuffer();
      const left = Math.round(qr_x * meta.width);
      const top = Math.round(qr_y * meta.height);
      await base.composite([{ input: resizedQr, left, top }]).toFile(outPath);
    }

    await db.createSignature({
      id: signatureId, document_id: doc.id, signed_by: req.user.id,
      qr_x, qr_y, qr_size, page_number: page_number || 1
    });

    let driveInfo = null;
    let driveError = null;
    if (gdrive.isConfigured()) {
      try {
        const mimeType = doc.file_type === 'pdf' ? 'application/pdf' : (path.extname(outFilename) === '.png' ? 'image/png' : 'image/jpeg');
        if (doc.drive_file_id) {
          // Document already has a Drive file from an earlier signature - overwrite it in place
          // so the folder doesn't fill up with a duplicate per signature.
          driveInfo = await gdrive.updateSignedDocument({ fileId: doc.drive_file_id, filePath: outPath, mimeType });
        } else {
          driveInfo = await gdrive.uploadSignedDocument({
            filePath: outPath,
            fileName: `${doc.doc_number} - ${doc.doc_name}${path.extname(outFilename)}`,
            mimeType,
            department: doc.department
          });
        }
      } catch (e) {
        console.error('Gagal upload ke Google Drive:', e.message);
        driveError = e.message;
      }
    }
    await db.markDocumentSigned(doc.id, outFilename, driveInfo);

    res.json({
      ok: true, signatureId, verifyUrl, signedFile: `/signed/${outFilename}`,
      signatureCount: await db.getSignatureCountForDocument(doc.id),
      driveUploaded: !!driveInfo,
      driveViewLink: driveInfo ? driveInfo.webViewLink : null,
      driveError
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Gagal menandatangani dokumen: ' + e.message });
  }
});

// Internal helper: find the signature id for an already-signed document
app.get('/api/documents/:id/signature', requireLogin, async (req, res) => {
  const sig = await db.getLatestSignatureForDocument(req.params.id);
  if (!sig) return res.status(404).json({ error: 'Dokumen ini belum ditandatangani' });
  res.json({ signatureId: sig.id });
});

// ---------- PUBLIC VERIFICATION PAGE (data endpoint) ----------
app.get('/api/verify/:signatureId', async (req, res) => {
  const sig = await db.getSignatureWithDetails(req.params.signatureId);
  if (!sig) return res.status(404).json({ error: 'Tanda tangan tidak ditemukan atau tidak valid' });
  res.json({ signature: sig });
});

app.get('/verify/:signatureId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'verify.html'));
});

module.exports = app;
