const express = require('express');
const session = require('express-session');
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

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 } // 8 hours
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', (req, res, next) => {
  // Only allow access to uploads if logged in (raw uploaded docs are internal, not yet signed)
  if (!req.session.user) return res.status(401).send('Unauthorized');
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

// ---------- Auth middleware ----------
function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Belum login' });
  next();
}

// ---------- AUTH ROUTES ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.getUserByUsername(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Username atau password salah' });
  }
  req.session.user = { id: user.id, username: user.username, full_name: user.full_name, department: user.department, role: user.role };
  res.json({ user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

// Admin-only: create personil accounts
app.post('/api/users', requireLogin, (req, res) => {
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Hanya admin yang bisa menambah user' });
  const { username, password, full_name, department, role } = req.body;
  if (!username || !password || !full_name) return res.status(400).json({ error: 'Data tidak lengkap' });
  try {
    db.createUser({ username, password, full_name, department, role });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Username sudah dipakai' });
  }
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

    db.createDocument({
      id, doc_name, doc_number, department, file_type,
      original_filename: req.file.originalname,
      stored_filename: req.file.filename,
      uploaded_by: req.session.user.id,
      page_width, page_height
    });

    res.json({ id, file_type, stored_filename: req.file.filename });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Gagal memproses dokumen' });
  }
});

// List documents
app.get('/api/documents', requireLogin, (req, res) => {
  res.json({ documents: db.getAllDocumentsWithUploader() });
});

app.get('/api/documents/:id', requireLogin, (req, res) => {
  const doc = db.getDocumentById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Dokumen tidak ditemukan' });
  res.json({ document: doc });
});

// ---------- SIGNING (place QR + embed) ----------
app.post('/api/documents/:id/sign', requireLogin, async (req, res) => {
  try {
    const doc = db.getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Dokumen tidak ditemukan' });

    const { qr_x, qr_y, qr_size, page_number } = req.body;
    if (qr_x == null || qr_y == null || qr_size == null) {
      return res.status(400).json({ error: 'Posisi QR belum ditentukan' });
    }

    const signatureId = uuidv4();
    const verifyUrl = `${BASE_URL}/verify/${signatureId}`;
    const qrDataUrl = await QRCode.toDataURL(verifyUrl, { margin: 1, width: 300 });
    const qrPngBytes = Buffer.from(qrDataUrl.split(',')[1], 'base64');

    const inputPath = path.join(UPLOAD_DIR, doc.stored_filename);
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

    db.createSignature({
      id: signatureId, document_id: doc.id, signed_by: req.session.user.id,
      qr_x, qr_y, qr_size, page_number: page_number || 1
    });

    let driveInfo = null;
    let driveError = null;
    if (gdrive.isConfigured()) {
      try {
        const mimeType = doc.file_type === 'pdf' ? 'application/pdf' : (path.extname(outFilename) === '.png' ? 'image/png' : 'image/jpeg');
        driveInfo = await gdrive.uploadSignedDocument({
          filePath: outPath,
          fileName: `${doc.doc_number} - ${doc.doc_name}${path.extname(outFilename)}`,
          mimeType,
          department: doc.department
        });
      } catch (e) {
        console.error('Gagal upload ke Google Drive:', e.message);
        driveError = e.message;
      }
    }
    db.markDocumentSigned(doc.id, outFilename, driveInfo);

    res.json({
      ok: true, signatureId, verifyUrl, signedFile: `/signed/${outFilename}`,
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
app.get('/api/documents/:id/signature', requireLogin, (req, res) => {
  const sig = db.getLatestSignatureForDocument(req.params.id);
  if (!sig) return res.status(404).json({ error: 'Dokumen ini belum ditandatangani' });
  res.json({ signatureId: sig.id });
});

// ---------- PUBLIC VERIFICATION PAGE (data endpoint) ----------
app.get('/api/verify/:signatureId', (req, res) => {
  const sig = db.getSignatureWithDetails(req.params.signatureId);
  if (!sig) return res.status(404).json({ error: 'Tanda tangan tidak ditemukan atau tidak valid' });
  res.json({ signature: sig });
});

app.get('/verify/:signatureId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'verify.html'));
});

module.exports = app;
