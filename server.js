const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const { PDFDocument } = require('pdf-lib');
const sharp = null; // placeholder if image compositing library needed later
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

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
  // Only allow access to uploads if logged in (raw uploaded docs are internal)
  if (!req.session.user) return res.status(401).send('Unauthorized');
  next();
}, express.static(path.join(__dirname, 'uploads')));
app.use('/signed', express.static(path.join(__dirname, 'signed'))); // signed docs are viewable via verification page

// ---------- Multer upload config ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
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
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
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
    const hash = bcrypt.hashSync(password, 10);
    db.prepare(`INSERT INTO users (username, password_hash, full_name, department, role) VALUES (?, ?, ?, ?, ?)`)
      .run(username, hash, full_name, department || null, role || 'personil');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'Username sudah dipakai' });
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

    db.prepare(`INSERT INTO documents (id, doc_name, doc_number, department, file_type, original_filename, stored_filename, uploaded_by, page_width, page_height)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, doc_name, doc_number, department, file_type, req.file.originalname, req.file.filename, req.session.user.id, page_width, page_height);

    res.json({ id, file_type, stored_filename: req.file.filename });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Gagal memproses dokumen' });
  }
});

// List documents (pending ones needing signature, and own history)
app.get('/api/documents', requireLogin, (req, res) => {
  const docs = db.prepare(`
    SELECT d.*, u.full_name as uploaded_by_name
    FROM documents d JOIN users u ON u.id = d.uploaded_by
    ORDER BY d.created_at DESC
  `).all();
  res.json({ documents: docs });
});

app.get('/api/documents/:id', requireLogin, (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Dokumen tidak ditemukan' });
  res.json({ document: doc });
});

// ---------- SIGNING (place QR + embed) ----------
app.post('/api/documents/:id/sign', requireLogin, async (req, res) => {
  try {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Dokumen tidak ditemukan' });

    const { qr_x, qr_y, qr_size, page_number } = req.body;
    if (qr_x == null || qr_y == null || qr_size == null) {
      return res.status(400).json({ error: 'Posisi QR belum ditentukan' });
    }

    const signatureId = uuidv4();
    const verifyUrl = `${BASE_URL}/verify/${signatureId}`;
    const qrDataUrl = await QRCode.toDataURL(verifyUrl, { margin: 1, width: 300 });
    const qrPngBytes = Buffer.from(qrDataUrl.split(',')[1], 'base64');

    const inputPath = path.join(__dirname, 'uploads', doc.stored_filename);
    const outFilename = `${signatureId}${path.extname(doc.stored_filename)}`;
    const outPath = path.join(__dirname, 'signed', outFilename);

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

    db.prepare(`INSERT INTO signatures (id, document_id, signed_by, qr_x, qr_y, qr_size, page_number) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(signatureId, doc.id, req.session.user.id, qr_x, qr_y, qr_size, page_number || 1);
    db.prepare(`UPDATE documents SET status = 'signed', signed_filename = ? WHERE id = ?`).run(outFilename, doc.id);

    res.json({ ok: true, signatureId, verifyUrl, signedFile: `/signed/${outFilename}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Gagal menandatangani dokumen: ' + e.message });
  }
});

// Internal helper: find the signature id for an already-signed document
app.get('/api/documents/:id/signature', requireLogin, (req, res) => {
  const sig = db.prepare('SELECT id FROM signatures WHERE document_id = ? ORDER BY signed_at DESC LIMIT 1').get(req.params.id);
  if (!sig) return res.status(404).json({ error: 'Dokumen ini belum ditandatangani' });
  res.json({ signatureId: sig.id });
});

// ---------- PUBLIC VERIFICATION PAGE (data endpoint) ----------
app.get('/api/verify/:signatureId', (req, res) => {
  const sig = db.prepare(`
    SELECT s.*, d.doc_name, d.doc_number, d.department, d.signed_filename, d.file_type,
           u.full_name as signer_name, u.department as signer_department
    FROM signatures s
    JOIN documents d ON d.id = s.document_id
    JOIN users u ON u.id = s.signed_by
    WHERE s.id = ?
  `).get(req.params.signatureId);
  if (!sig) return res.status(404).json({ error: 'Tanda tangan tidak ditemukan atau tidak valid' });
  res.json({ signature: sig });
});

app.get('/verify/:signatureId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'verify.html'));
});

app.listen(PORT, () => {
  console.log(`QR Signature App berjalan di ${BASE_URL}`);
});
