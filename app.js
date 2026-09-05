const express = require('express');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
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
// ---------------------------------------------------------------------------
// Kebijakan sesi login
// Mengikuti praktik yang lazim dipakai untuk sistem terkendali (NIST SP 800-63B
// AAL2, yang juga jadi rujukan umum kontrol akses ISO 27001 A.9 / Annex A 8.5):
//   - IDLE  : sesi berakhir setelah 30 menit tanpa aktivitas
//   - ABSOLUT: sesi wajib login ulang setelah 12 jam, seaktif apa pun pemakainya
// Batas idle diperbarui setiap kali ada request (sliding), jadi orang yang sedang
// bekerja tidak tiba-tiba terlempar keluar; yang meninggalkan browser terbuka
// atau menutupnya tanpa logout akan kedaluwarsa sendiri.
// ---------------------------------------------------------------------------
const IDLE_TIMEOUT_MS = 1000 * 60 * 30;        // 30 menit tanpa aktivitas
const ABSOLUTE_SESSION_MS = 1000 * 60 * 60 * 12; // 12 jam sejak login
const TOKEN_MAX_AGE = IDLE_TIMEOUT_MS;

// ---------------------------------------------------------------------------
// Geometri "stempel" TTE: QR di atas (ditengahkan), lalu nama penandatangan dan
// tanggal/jam. Semua angka di bawah adalah FRAKSI dari LEBAR stempel (qr_size),
// supaya proporsional di kertas ukuran apa pun.
//
// Catatan: QR sengaja hanya memakai sebagian lebar stempel (qrRatio), sehingga
// baris nama/tanggal boleh lebih lebar daripada QR-nya - nama panjang tidak perlu
// dikecilkan sampai tidak terbaca. Tidak ada garis tepi; hanya latar putih supaya
// QR dan keterangannya tetap terbaca di atas area dokumen yang ada isinya.
//
// Nilai yang sama persis dipakai kotak preview di public/sign.html - kalau salah
// satu diubah, ubah keduanya supaya yang terlihat saat menempel sama dengan cetakan.
// ---------------------------------------------------------------------------
const STAMP = {
  padTop: 0.03,     // ruang kosong di atas QR
  qrRatio: 0.80,    // lebar/tinggi QR = 80% lebar stempel, ditengahkan
  gapQr: 0.015,     // jarak QR -> baris nama (dibuat rapat, quiet zone QR sudah memberi jarak visual sendiri)
  nameFont: 0.115,  // tinggi huruf nama
  gapText: 0.025,   // jarak baris nama -> baris tanggal/jam
  timeFont: 0.10,   // tinggi huruf tanggal/jam
  padBottom: 0.03   // ruang kosong di bawah baris tanggal/jam
};
// tinggi total stempel = lebar x heightRatio
STAMP.heightRatio = STAMP.padTop + STAMP.qrRatio + STAMP.gapQr + STAMP.nameFont +
                    STAMP.gapText + STAMP.timeFont + STAMP.padBottom;
// Teks boleh memakai hampir seluruh lebar stempel (lebih lebar dari QR-nya).
STAMP.textWidth = 0.98;

// Tanggal & jam ditampilkan dalam WIB supaya seragam untuk semua penandatangan,
// tidak ikut zona waktu server (Vercel berjalan di UTC).
function formatStampDateTime(iso) {
  const d = new Date(iso);
  try {
    const p = new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(d).reduce((acc, part) => (acc[part.type] = part.value, acc), {});
    return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second} WIB`;
  } catch (e) {
    // Fallback kalau data zona waktu tidak tersedia di runtime: geser manual +7 jam
    const wib = new Date(d.getTime() + 7 * 60 * 60 * 1000);
    const pad2 = n => String(n).padStart(2, '0');
    return `${pad2(wib.getUTCDate())}/${pad2(wib.getUTCMonth() + 1)}/${wib.getUTCFullYear()} ` +
           `${pad2(wib.getUTCHours())}:${pad2(wib.getUTCMinutes())}:${pad2(wib.getUTCSeconds())} WIB`;
  }
}

// Font standar PDF (Helvetica) hanya mendukung WinAnsi - karakter di luar itu akan
// membuat pdf-lib melempar error, jadi dibuang lebih dulu daripada menggagalkan TTD.
function sanitizeWinAnsi(text) {
  return String(text || '').replace(/[^\x20-\xFF]/g, '').trim();
}

// Mengecilkan ukuran huruf sampai muat di lebar stempel (nama panjang tetap utuh,
// tidak terpotong di tengah).
function fitPdfFontSize(font, text, maxWidth, startSize) {
  let size = startSize;
  while (size > 3 && font.widthOfTextAtSize(text, size) > maxWidth) size -= 0.25;
  return size;
}

function escapeXml(text) {
  return String(text || '').replace(/[<>&'"]/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ));
}

// Versi perkiraan dari fitPdfFontSize untuk dokumen gambar (SVG tidak bisa diukur
// dulu seperti font PDF, jadi lebar huruf diperkirakan ~0.58 x ukuran huruf).
function fitSvgFontSize(text, maxWidth, startSize) {
  let size = startSize;
  while (size > 4 && String(text || '').length * size * 0.58 > maxWidth) size -= 0.5;
  return Math.round(size * 10) / 10;
}

// Blok keterangan (nama + tanggal/jam) untuk dokumen gambar, dirender sebagai SVG
// dengan latar TRANSPARAN - tidak ada rect/latar putih, jadi hanya hurufnya yang
// terlihat di atas gambar. QR ditempel terpisah di atas SVG ini (sharp composite).
function buildStampSvg({ W, H, name, time }) {
  const maxTextWidth = W * STAMP.textWidth;
  const nameSize = fitSvgFontSize(name, maxTextWidth, STAMP.nameFont * W);
  const timeSize = fitSvgFontSize(time, maxTextWidth, STAMP.timeFont * W);
  const nameBaseline = (STAMP.padTop + STAMP.qrRatio + STAMP.gapQr + STAMP.nameFont) * W;
  const timeBaseline = nameBaseline + (STAMP.gapText + STAMP.timeFont) * W;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <text x="${W / 2}" y="${nameBaseline}" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-weight="bold" font-size="${nameSize}" fill="#000000">${escapeXml(name)}</text>
  <text x="${W / 2}" y="${timeBaseline}" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="${timeSize}" fill="#000000">${escapeXml(time)}</text>
</svg>`;
}

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
    const payload = jwt.verify(token, JWT_SECRET);
    // Batas absolut: token bisa saja masih "hidup" karena terus diperpanjang,
    // tapi sesi tetap harus berakhir 12 jam setelah login pertama.
    if (payload.loginAt && Date.now() - payload.loginAt > ABSOLUTE_SESSION_MS) return null;
    return payload;
  } catch (e) {
    return null; // kedaluwarsa atau token dirusak
  }
}

function issueSessionCookie(res, payload) {
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: Math.floor(IDLE_TIMEOUT_MS / 1000) });
  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || !!process.env.VERCEL,
    sameSite: 'lax',
    maxAge: TOKEN_MAX_AGE
  });
}

// Mencatat berakhirnya sesi ke audit trail. Server tidak punya cara "tahu" bahwa
// seseorang menutup browser, jadi yang dicatat adalah saat token kedaluwarsa itu
// dipakai lagi - dari situ terlihat kapan sesinya berakhir dan milik siapa.
async function logExpiredSession(req) {
  const token = req.cookies && req.cookies.auth_token;
  if (!token) return;
  try {
    const stale = jwt.decode(token);
    if (!stale || !stale.username) return;
    await db.logAudit({
      type: 'session_expired', user_id: stale.id, username: stale.username,
      full_name: stale.full_name
    });
  } catch (e) { /* token tidak bisa dibaca - tidak ada yang bisa dicatat */ }
}

function requireLogin(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user) {
    // Cookie ada tapi sudah kedaluwarsa -> catat sekali lalu bersihkan cookienya,
    // supaya tidak dicatat berulang setiap request dari tab yang sama.
    if (req.cookies && req.cookies.auth_token) {
      logExpiredSession(req).catch(() => {});
      res.clearCookie('auth_token');
    }
    return res.status(401).json({ error: 'Sesi Anda telah berakhir. Silakan login kembali.', expired: true });
  }
  req.user = user;
  // Sliding expiration: setiap aktivitas memperpanjang batas idle 30 menit,
  // tanpa menggeser batas absolut karena loginAt ikut dibawa apa adanya.
  issueSessionCookie(res, {
    id: user.id, username: user.username, full_name: user.full_name,
    department: user.department, role: user.role, jabatan: user.jabatan || null,
    loginAt: user.loginAt || Date.now()
  });
  next();
}

// ---------- AUTH ROUTES ----------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await db.getUserByUsername(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Username atau password salah' });
  }
  const payload = {
    id: user.id, username: user.username, full_name: user.full_name,
    department: user.department, role: user.role, jabatan: user.jabatan || null,
    loginAt: Date.now() // penanda untuk batas sesi absolut 12 jam
  };
  issueSessionCookie(res, payload);
  await db.logAudit({ type: 'login', user_id: user.id, username: user.username, full_name: user.full_name });
  res.json({ user: payload });
});

app.post('/api/logout', async (req, res) => {
  const user = getUserFromRequest(req);
  if (user) await db.logAudit({ type: 'logout', user_id: user.id, username: user.username, full_name: user.full_name });
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

// Siapa yang boleh MELIHAT dokumen: admin, pengupload, siapa pun yang departemennya
// terdaftar di allowed_departments, dan siapa pun yang di-tag langsung (allowed_users).
function canAccessDocument(user, doc) {
  if (user.role === 'admin') return true;
  if (doc.uploaded_by === user.id) return true;
  if ((doc.allowed_users || []).includes(user.id)) return true;
  const allowed = doc.allowed_departments || [];
  // Kalau dokumen dibatasi ke orang tertentu saja (tanpa departemen), daftar departemen
  // yang kosong TIDAK boleh diartikan "semua orang boleh" seperti pada dokumen lama.
  if (allowed.length === 0) return (doc.allowed_users || []).length === 0;
  return allowed.includes(user.department);
}

// Siapa yang boleh MENANDATANGANI - sengaja lebih sempit daripada "boleh melihat".
// Dua mode yang bisa dipakai bersamaan saat upload:
//   - pilih DEPARTEMEN  -> semua personil departemen itu bisa TTD
//   - tag ORANG langsung -> hanya orang yang di-tag itu yang bisa TTD
// Pengupload TIDAK otomatis bisa TTD kalau dia sendiri tidak masuk salah satu daftar;
// kalau tidak, dokumen yang sengaja di-tag ke satu orang tetap bisa ditandatangani
// orang lain dan pembatasannya jadi tidak ada artinya.
function canSignDocument(user, doc) {
  if (user.role === 'admin') return true;
  if ((doc.allowed_users || []).includes(user.id)) return true;
  const allowedDepts = doc.allowed_departments || [];
  if (allowedDepts.includes(user.department)) return true;
  // Dokumen lama (sebelum fitur ini ada) yang tidak punya dua daftar itu sama sekali:
  // jatuhkan ke perilaku lama, yaitu departemen pemilik dokumen.
  if (allowedDepts.length === 0 && (doc.allowed_users || []).length === 0) {
    return user.department === doc.department || doc.uploaded_by === user.id;
  }
  return false;
}

// Archiving/deleting is for admins, the person who uploaded it, or anyone from the
// same department that owns the document (the "pemilik file" - not just the individual
// uploader, but their whole department).
function canManageDocument(user, doc) {
  if (user.role === 'admin') return true;
  if (doc.uploaded_by === user.id) return true;
  return user.department === doc.department;
}

// Permanent delete (which also removes the actual files from disk/Google Drive) is
// intentionally narrower than archive/manage: only the person who originally uploaded
// the document, or an admin, can do this - not "anyone in the same department" - since
// it's destructive, irreversible, and invalidates any QR already printed for it.
function canDeleteDocument(user, doc) {
  if (user.role === 'admin') return true;
  return doc.uploaded_by === user.id;
}

// Audit trail terbuka untuk: admin, siapa pun yang jabatannya mengandung "manager",
// dan seluruh personil Quality Assurance - QA memang bertugas menelusuri riwayat
// dokumen, jadi mereka perlu bisa melihat sekaligus mengunduhnya.
function canViewAuditTrail(user) {
  if (user.role === 'admin') return true;
  if (user.jabatan && /manager/i.test(user.jabatan)) return true;
  return !!(user.department && /\bQA\b|quality assurance/i.test(user.department));
}

function requireAuditAccess(req, res, next) {
  if (!canViewAuditTrail(req.user)) return res.status(403).json({ error: 'Hanya admin, manager, dan QA yang bisa melihat audit trail' });
  next();
}

// Daftar personil untuk fitur "tag orang" saat upload. Berbeda dari /api/users di atas
// yang admin-only: ini boleh diakses semua user yang login, tapi hanya mengembalikan
// data secukupnya untuk memilih nama (tanpa role/hash password).
app.get('/api/users/directory', requireLogin, async (req, res) => {
  const users = await db.listUsers();
  res.json({
    users: users
      .map(u => ({ id: u.id, username: u.username, full_name: u.full_name, department: u.department, jabatan: u.jabatan || null }))
      // Urut A-Z murni berdasarkan nama, bukan dikelompokkan per departemen dulu -
      // untuk memilih orang, mata mencari nama, bukan departemen.
      .sort((a, b) => a.full_name.localeCompare(b.full_name, 'id'))
  });
});

// ---------- NOTIFIKASI ----------
app.get('/api/notifications', requireLogin, async (req, res) => {
  const items = await db.listNotifications(req.user.id);
  res.json({ notifications: items, unread: items.filter(n => !n.read).length });
});

app.post('/api/notifications/read', requireLogin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) && req.body.ids.length > 0 ? req.body.ids : null;
  await db.markNotificationsRead(req.user.id, ids);
  res.json({ ok: true });
});

// Hapus notifikasi (satu atau semua). Dipakai tombol "Bersihkan" di Pusat Notifikasi;
// lonceng sendiri hanya menandai sudah dibaca, tidak menghapus riwayatnya.
app.post('/api/notifications/clear', requireLogin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) && req.body.ids.length > 0 ? req.body.ids : null;
  await db.clearNotifications(req.user.id, ids);
  res.json({ ok: true });
});

// Menerjemahkan "departemen yang boleh TTD" + "orang yang di-tag" menjadi daftar id user
// yang perlu diberi notifikasi. `excludeUserId` dipakai supaya orang tidak dapat notifikasi
// dari perbuatannya sendiri.
async function resolveNotificationTargets({ departments = [], userIds = [], excludeUserId = null }) {
  const all = await db.listUsers();
  const ids = new Set(userIds.filter(v => v != null));
  for (const u of all) {
    if (departments.includes(u.department)) ids.add(u.id);
  }
  if (excludeUserId != null) ids.delete(excludeUserId);
  return [...ids];
}

// List personil accounts (admin only)
app.get('/api/users', requireLogin, requireAdmin, async (req, res) => {
  res.json({ users: await db.listUsers() });
});

// Admin-only: create personil accounts
app.post('/api/users', requireLogin, requireAdmin, async (req, res) => {
  const { username, password, full_name, department, role, jabatan } = req.body;
  if (!username || !password || !full_name) return res.status(400).json({ error: 'Data tidak lengkap' });
  try {
    await db.createUser({ username, password, full_name, department, role, jabatan });
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

// Self-service: any logged-in user can change their OWN password, by proving they know
// the current one first (unlike the admin reset above, which doesn't need the old password).
app.post('/api/me/change-password', requireLogin, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'Password lama dan baru wajib diisi' });
  if (newPassword.length < 4) return res.status(400).json({ error: 'Password baru minimal 4 karakter' });
  const user = await db.getUserById(req.user.id);
  if (!user || !bcrypt.compareSync(oldPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Password lama salah' });
  }
  await db.resetUserPassword(req.user.id, newPassword);
  await db.logAudit({ type: 'change_password', user_id: user.id, username: user.username, full_name: user.full_name });
  res.json({ ok: true });
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

// Admin-only: edit an existing user's full name, jabatan, department, or role
app.patch('/api/users/:id', requireLogin, requireAdmin, async (req, res) => {
  try {
    const { full_name, jabatan, department, role } = req.body;
    await db.updateUser(Number(req.params.id), { full_name, jabatan, department, role });
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

// Admin-only: replace the whole department list with the standard 11 full-name
// departments in one click (for deployments seeded before that list existed)
app.post('/api/departments/reset-to-default', requireLogin, requireAdmin, async (req, res) => {
  await db.resetDepartmentsToDefault();
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

    // allowed_departments & allowed_users datang sebagai string JSON (field multipart
    // selalu string). Dua-duanya opsional dan boleh dipakai bersamaan:
    //   - allowed_departments: semua personil departemen tsb bisa lihat + TTD
    //   - allowed_users: hanya orang-orang itu yang bisa TTD
    // Kalau dua-duanya kosong, jatuh ke perilaku lama: departemen pemilik dokumen.
    let allowedDepartments = [];
    try {
      const parsed = JSON.parse(req.body.allowed_departments || '[]');
      if (Array.isArray(parsed)) allowedDepartments = parsed.filter(Boolean);
    } catch (e) { /* ignore malformed input, fall back to default below */ }
    let allowedUsers = [];
    try {
      const parsed = JSON.parse(req.body.allowed_users || '[]');
      if (Array.isArray(parsed)) allowedUsers = parsed.map(Number).filter(n => Number.isFinite(n));
    } catch (e) { /* ignore malformed input */ }
    if (allowedDepartments.length === 0 && allowedUsers.length === 0) allowedDepartments = [department];

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

    // Save the ORIGINAL file straight to Google Drive - the app's own server storage is
    // only ever used as brief scratch space during a single request, never relied on
    // across requests (important on Vercel, where local disk isn't shared/persistent).
    let driveOriginal = null;
    if (gdrive.isConfigured()) {
      try {
        const mimeType = file_type === 'pdf' ? 'application/pdf' : (ext === '.png' ? 'image/png' : 'image/jpeg');
        driveOriginal = await gdrive.uploadSignedDocument({
          filePath: req.file.path,
          fileName: `${doc_number} - ${doc_name}${ext}`,
          mimeType,
          department,
          category: 'File Asli'
        });
      } catch (e) {
        console.error('Gagal upload dokumen asli ke Google Drive:', e.message);
      }
    }

    await db.createDocument({
      id, doc_name, doc_number, department, file_type,
      original_filename: req.file.originalname,
      stored_filename: req.file.filename,
      uploaded_by: req.user.id,
      page_width, page_height,
      allowed_departments: allowedDepartments,
      allowed_users: allowedUsers,
      drive_original_file_id: driveOriginal ? driveOriginal.fileId : null,
      drive_original_view_link: driveOriginal ? driveOriginal.webViewLink : null
    });

    await db.logAudit({
      type: 'upload_document', user_id: req.user.id, username: req.user.username, full_name: req.user.full_name,
      document_id: id, doc_name, doc_number
    });

    // Beri tahu semua yang diminta TTD (personil departemen terpilih + orang yang di-tag).
    // Gagal mengirim notifikasi tidak boleh menggagalkan upload yang sudah berhasil.
    try {
      const targets = await resolveNotificationTargets({
        departments: allowedDepartments, userIds: allowedUsers, excludeUserId: req.user.id
      });
      await db.addNotifications(targets, {
        type: 'sign_request',
        title: 'Dokumen baru menunggu TTD Anda',
        body: `${doc_number} — ${doc_name}, diupload oleh ${req.user.full_name}`,
        document_id: id
      });
    } catch (e) {
      console.error('Gagal mengirim notifikasi upload:', e.message);
    }

    res.json({ id, file_type, stored_filename: req.file.filename, driveUploaded: !!driveOriginal });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Gagal memproses dokumen' });
  }
});

// List documents - only shows documents the requesting user's department is allowed to
// see (admins and the original uploader always see everything they're involved with)
app.get('/api/documents', requireLogin, async (req, res) => {
  const all = await db.getAllDocumentsWithUploader();
  const visible = all.filter(doc => canAccessDocument(req.user, doc));
  res.json({ documents: visible });
});

app.get('/api/documents/:id', requireLogin, async (req, res) => {
  const doc = await db.getDocumentById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Dokumen tidak ditemukan' });
  if (!canAccessDocument(req.user, doc)) return res.status(403).json({ error: 'Departemen Anda tidak memiliki akses ke dokumen ini' });
  const allSigs = await db.getAllSignaturesForDocument(doc.id);
  const allowedUsers = doc.allowed_users || [];
  const requiredDepartments = (doc.allowed_departments && doc.allowed_departments.length > 0)
    ? doc.allowed_departments
    : (allowedUsers.length > 0 ? [] : [doc.department]);
  const signedDepartments = [...new Set(allSigs.map(s => s.signer_department).filter(Boolean))];
  const signedUsers = [...new Set(allSigs.map(s => s.signed_by).filter(v => v != null))];
  const isComplete = requiredDepartments.every(d => signedDepartments.includes(d)) &&
                     allowedUsers.every(uid => signedUsers.includes(uid));
  // Preview/edit always goes through our own file-serving route below, which fetches
  // fresh from Google Drive each time - never assumes anything is still on local disk.
  const current_file_url = `/api/documents/${doc.id}/file`;
  // Nama orang yang di-tag di-resolve di sini supaya halaman TTD tidak perlu
  // meminta seluruh direktori user hanya untuk menampilkan beberapa nama.
  let requiredUserNames = [];
  if (allowedUsers.length > 0) {
    const users = await db.listUsers();
    const byId = new Map(users.map(u => [u.id, u]));
    requiredUserNames = allowedUsers.map(uid => ({
      id: uid,
      full_name: byId.has(uid) ? byId.get(uid).full_name : `User #${uid}`,
      signed: signedUsers.includes(uid)
    }));
  }
  res.json({
    document: {
      ...doc, signature_count: allSigs.length, current_file_url,
      required_departments: requiredDepartments, signed_departments: signedDepartments,
      required_users: allowedUsers, signed_users: signedUsers,
      required_user_names: requiredUserNames,
      // Halaman sign.html memakai ini untuk menonaktifkan tombol TTD lebih awal,
      // daripada membiarkan user menempel QR lalu baru ditolak server.
      can_sign: canSignDocument(req.user, doc),
      completion_status: allSigs.length === 0 ? 'pending' : (isComplete ? 'complete' : 'partial')
    }
  });
});

// Serves the document's current file (latest signed version if any, else the original) -
// always fetched fresh from Google Drive when configured, so it works no matter which
// Vercel instance handles the request. Falls back to local disk only when Drive isn't set up.
app.get('/api/documents/:id/file', requireLogin, async (req, res) => {
  const doc = await db.getDocumentById(req.params.id);
  if (!doc) return res.status(404).send('Dokumen tidak ditemukan');
  if (!canAccessDocument(req.user, doc)) return res.status(403).send('Departemen Anda tidak memiliki akses ke dokumen ini');

  const mimeType = doc.file_type === 'pdf'
    ? 'application/pdf'
    : (path.extname(doc.original_filename || '').toLowerCase() === '.png' ? 'image/png' : 'image/jpeg');

  try {
    const driveFileId = doc.drive_file_id || doc.drive_original_file_id;
    if (gdrive.isConfigured() && driveFileId) {
      const buffer = await gdrive.downloadFileBuffer(driveFileId);
      res.setHeader('Content-Type', mimeType);
      return res.send(buffer);
    }
    // Fallback for local/office-server use without Drive configured
    const baseDir = doc.signed_filename ? SIGNED_DIR : UPLOAD_DIR;
    const filename = doc.signed_filename || doc.stored_filename;
    return res.sendFile(path.join(baseDir, filename));
  } catch (e) {
    console.error('Gagal memuat file dokumen:', e.message);
    res.status(500).send('Gagal memuat file');
  }
});

// ---------- SIGNING (place QR + embed) ----------
app.post('/api/documents/:id/sign', requireLogin, async (req, res) => {
  try {
    const doc = await db.getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Dokumen tidak ditemukan' });
    if (!canAccessDocument(req.user, doc)) return res.status(403).json({ error: 'Anda tidak memiliki akses ke dokumen ini' });
    if (!canSignDocument(req.user, doc)) {
      return res.status(403).json({
        error: (doc.allowed_users || []).length > 0
          ? 'Dokumen ini hanya bisa ditandatangani oleh personil yang di-tag secara khusus'
          : 'Departemen Anda tidak termasuk yang diminta menandatangani dokumen ini'
      });
    }

    const { qr_x, qr_y, qr_size, page_number } = req.body;
    if (qr_x == null || qr_y == null || qr_size == null) {
      return res.status(400).json({ error: 'Posisi QR belum ditentukan' });
    }

    const signatureId = uuidv4();
    const verifyUrl = `${BASE_URL}/verify/${signatureId}`;
    // QR digenerate pada resolusi tinggi (1024px). Ukuran cetaknya hanya beberapa cm,
    // jadi ini setara >600 dpi - modul QR tetap tajam saat di-zoom maupun dicetak,
    // tidak lagi terlihat seperti gambar kecil yang dibesarkan. `margin: 2` menyisakan
    // quiet zone putih di sekeliling QR supaya tetap bisa discan walau ditempel di
    // atas area dokumen yang ada isinya (bagian ini satu-satunya yang tidak transparan).
    const qrDataUrl = await QRCode.toDataURL(verifyUrl, { margin: 2, width: 1024, errorCorrectionLevel: 'M' });
    const qrPngBytes = Buffer.from(qrDataUrl.split(',')[1], 'base64');

    // If this document already has a QR embedded from a previous signature, keep building on
    // top of that version (so QR codes accumulate) instead of starting again from the original.
    // Fetch fresh from Google Drive when available - never assume a previous request's local
    // file is still around (it may have been written by a different Vercel instance).
    const sourceDriveFileId = doc.drive_file_id || doc.drive_original_file_id;
    let sourceBytes;
    if (gdrive.isConfigured() && sourceDriveFileId) {
      sourceBytes = await gdrive.downloadFileBuffer(sourceDriveFileId);
    } else {
      const baseFilename = doc.signed_filename || doc.stored_filename;
      const baseDir = doc.signed_filename ? SIGNED_DIR : UPLOAD_DIR;
      sourceBytes = fs.readFileSync(path.join(baseDir, baseFilename));
    }
    const outFilename = `${signatureId}${path.extname(doc.stored_filename)}`;
    const outPath = path.join(SIGNED_DIR, outFilename);

    // Waktu TTD dihitung sekali di sini lalu dipakai untuk DUA hal: teks yang tercetak
    // di stempel dan nilai signed_at yang disimpan ke database - supaya jam yang
    // terlihat di dokumen persis sama dengan yang muncul di halaman verifikasi.
    const signedAt = new Date().toISOString();
    const stampTime = formatStampDateTime(signedAt);
    const stampName = req.user.full_name || req.user.username || '';

    if (doc.file_type === 'pdf') {
      const pdfDoc = await PDFDocument.load(sourceBytes);
      const pageIdx = (page_number || 1) - 1;
      const page = pdfDoc.getPages()[pageIdx];
      const pngImage = await pdfDoc.embedPng(qrPngBytes);
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const { width: pw, height: ph } = page.getSize();

      // qr_size = lebar stempel sebagai fraksi lebar halaman; tingginya mengikuti
      // heightRatio karena sekarang ada blok keterangan di bawah QR.
      const W = qr_size * pw;
      const H = W * STAMP.heightRatio;
      // qr_x, qr_y datang sebagai fraksi dari kiri-atas; origin pdf-lib ada di kiri-bawah
      const X = qr_x * pw;
      const T = ph - (qr_y * ph); // tepi ATAS stempel dalam koordinat pdf-lib

      // TIDAK ada latar maupun garis tepi yang digambar di sini: seluruh area stempel
      // selain QR dibiarkan transparan, sehingga isi dokumen di belakangnya tetap
      // terlihat. Nama dan tanggal/jam digambar sebagai TEKS PDF asli (vektor), bukan
      // gambar - jadi tetap tajam berapa pun perbesaran dan resolusi cetaknya.
      // Kotak putih kecil di sekitar QR datang dari quiet zone QR itu sendiri.

      // QR ditengahkan dan hanya memakai sebagian lebar stempel, sehingga baris nama
      // dan tanggal/jam di bawahnya boleh lebih lebar daripada QR-nya.
      const qrSide = STAMP.qrRatio * W;
      page.drawImage(pngImage, {
        x: X + (W - qrSide) / 2,
        y: T - (STAMP.padTop * W) - qrSide,
        width: qrSide, height: qrSide
      });

      const maxTextWidth = W * STAMP.textWidth;
      const nameText = sanitizeWinAnsi(stampName);
      const timeText = sanitizeWinAnsi(stampTime);
      const nameSize = fitPdfFontSize(fontBold, nameText, maxTextWidth, STAMP.nameFont * W);
      const timeSize = fitPdfFontSize(fontRegular, timeText, maxTextWidth, STAMP.timeFont * W);
      const nameBaseline = T - (STAMP.padTop + STAMP.qrRatio + STAMP.gapQr + STAMP.nameFont) * W;
      const timeBaseline = nameBaseline - (STAMP.gapText + STAMP.timeFont) * W;
      page.drawText(nameText, {
        x: X + (W - fontBold.widthOfTextAtSize(nameText, nameSize)) / 2,
        y: nameBaseline, size: nameSize, font: fontBold, color: rgb(0, 0, 0)
      });
      page.drawText(timeText, {
        x: X + (W - fontRegular.widthOfTextAtSize(timeText, timeSize)) / 2,
        y: timeBaseline, size: timeSize, font: fontRegular, color: rgb(0, 0, 0)
      });

      const finalBytes = await pdfDoc.save();
      fs.writeFileSync(outPath, finalBytes);
    } else {
      // Dokumen gambar: stempel dirakit sebagai SVG (latar + teks) lalu QR ditempel
      // di atasnya, dua-duanya di-composite ke gambar asli dengan sharp.
      const sharpLib = require('sharp');
      const base = sharpLib(sourceBytes);
      const meta = await base.metadata();

      let W = Math.max(48, Math.round(qr_size * meta.width));
      let H = Math.round(W * STAMP.heightRatio);
      // Stempel tidak boleh lebih besar dari gambarnya sendiri (sharp menolak composite
      // yang keluar dari kanvas), jadi dikecilkan proporsional kalau kelewat besar.
      if (H > meta.height) { const k = meta.height / H; W = Math.floor(W * k); H = Math.floor(H * k); }
      if (W > meta.width) { const k = meta.width / W; W = Math.floor(W * k); H = Math.floor(H * k); }

      const qrSide = Math.max(24, Math.round(STAMP.qrRatio * W));
      const left = Math.max(0, Math.min(Math.round(qr_x * meta.width), meta.width - W));
      const top = Math.max(0, Math.min(Math.round(qr_y * meta.height), meta.height - H));

      const stampSvg = Buffer.from(buildStampSvg({ W, H, name: stampName, time: stampTime }));
      const resizedQr = await sharpLib(qrPngBytes).resize(qrSide, qrSide).toBuffer();
      await base.composite([
        { input: stampSvg, left, top },
        { input: resizedQr, left: left + Math.round((W - qrSide) / 2), top: top + Math.round(STAMP.padTop * W) }
      ]).toFile(outPath);
    }

    await db.createSignature({
      id: signatureId, document_id: doc.id, signed_by: req.user.id,
      signer_department: req.user.department,
      qr_x, qr_y, qr_size, page_number: page_number || 1,
      signed_at: signedAt // sama persis dengan jam yang tercetak di stempel
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
            department: doc.department,
            category: 'File TTD QR Code'
          });
        }
      } catch (e) {
        console.error('Gagal upload ke Google Drive:', e.message);
        driveError = e.message;
      }
    }
    await db.markDocumentSigned(doc.id, outFilename, driveInfo);
    await db.logAudit({
      type: 'sign_document', user_id: req.user.id, username: req.user.username, full_name: req.user.full_name,
      document_id: doc.id, doc_name: doc.doc_name, doc_number: doc.doc_number, signature_id: signatureId
    });

    // Notifikasi setelah TTD: pengupload selalu diberi tahu, dan kalau dokumennya sudah
    // lengkap semua pihak yang terlibat ikut diberi tahu. Sama seperti di upload, kegagalan
    // di sini tidak boleh membatalkan TTD yang sudah tersimpan.
    try {
      const fresh = await db.getDocumentById(doc.id);
      const allSigs = await db.getAllSignaturesForDocument(doc.id);
      const reqDepts = (fresh.allowed_departments && fresh.allowed_departments.length > 0)
        ? fresh.allowed_departments
        : ((fresh.allowed_users || []).length > 0 ? [] : [fresh.department]);
      const reqUsers = fresh.allowed_users || [];
      const signedDepts = [...new Set(allSigs.map(s => s.signer_department).filter(Boolean))];
      const signedUsers = [...new Set(allSigs.map(s => s.signed_by).filter(v => v != null))];
      const complete = reqDepts.every(d => signedDepts.includes(d)) && reqUsers.every(u => signedUsers.includes(u));

      if (complete) {
        const everyone = await resolveNotificationTargets({
          departments: reqDepts, userIds: [...reqUsers, fresh.uploaded_by], excludeUserId: null
        });
        await db.addNotifications(everyone, {
          type: 'document_complete',
          title: 'Dokumen sudah lengkap TTD',
          body: `${fresh.doc_number} — ${fresh.doc_name} telah ditandatangani semua pihak`,
          document_id: fresh.id
        });
      } else {
        // Belum lengkap: kabari pengupload, plus ingatkan yang belum tandatangan.
        const pendingDepts = reqDepts.filter(d => !signedDepts.includes(d));
        const pendingUsers = reqUsers.filter(u => !signedUsers.includes(u));
        const targets = await resolveNotificationTargets({
          departments: pendingDepts, userIds: [...pendingUsers, fresh.uploaded_by], excludeUserId: req.user.id
        });
        await db.addNotifications(targets, {
          type: 'signed',
          title: `${req.user.full_name} menandatangani dokumen`,
          body: `${fresh.doc_number} — ${fresh.doc_name}. Masih menunggu TTD pihak lain.`,
          document_id: fresh.id
        });
      }
    } catch (e) {
      console.error('Gagal mengirim notifikasi TTD:', e.message);
    }

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
  const doc = await db.getDocumentById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Dokumen tidak ditemukan' });
  if (!canAccessDocument(req.user, doc)) return res.status(403).json({ error: 'Departemen Anda tidak memiliki akses ke dokumen ini' });
  const sig = await db.getLatestSignatureForDocument(req.params.id);
  if (!sig) return res.status(404).json({ error: 'Dokumen ini belum ditandatangani' });
  res.json({ signatureId: sig.id });
});

// Archive/unarchive - hides (or restores) a document from the main dashboard lists.
// Doesn't touch files or signature records, so already-printed QR codes still work.
app.post('/api/documents/:id/archive', requireLogin, async (req, res) => {
  const doc = await db.getDocumentById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Dokumen tidak ditemukan' });
  if (!canManageDocument(req.user, doc)) return res.status(403).json({ error: 'Anda tidak punya izin untuk mengarsipkan dokumen ini' });
  const archived = req.body.archived !== false; // default true (archive); pass {archived:false} to restore
  await db.setDocumentArchived(req.params.id, archived);
  await db.logAudit({
    type: archived ? 'archive_document' : 'unarchive_document',
    user_id: req.user.id, username: req.user.username, full_name: req.user.full_name,
    document_id: doc.id, doc_name: doc.doc_name, doc_number: doc.doc_number
  });
  res.json({ ok: true });
});

// Permanent delete - removes the document's files from local disk AND Google Drive (the
// original upload as well as any signed/QR version), all of its signature records, then
// the document record itself. This is deliberately allowed even for already-signed
// documents (e.g. the wrong person signed, or the file needs to be voided) - which is
// exactly why it's restricted to only the uploader or an admin (see canDeleteDocument),
// not "anyone in the same department" like Archive is. Any QR already printed/scanned
// for this document will stop resolving once this runs - use Archive instead if you just
// want to hide a document from the dashboard without invalidating printed QR codes.
app.delete('/api/documents/:id', requireLogin, async (req, res) => {
  const doc = await db.getDocumentById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Dokumen tidak ditemukan' });
  if (!canDeleteDocument(req.user, doc)) return res.status(403).json({ error: 'Hanya personil yang mengupload dokumen ini atau admin yang bisa menghapusnya' });

  // Best-effort cleanup of the actual files - a file that's already missing/gone
  // shouldn't block removing the (now-broken-anyway) record, so failures here are
  // logged but never thrown back to the client.
  for (const filePath of [
    doc.stored_filename && path.join(UPLOAD_DIR, doc.stored_filename),
    doc.signed_filename && path.join(SIGNED_DIR, doc.signed_filename)
  ].filter(Boolean)) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { console.error('Gagal menghapus file lokal:', filePath, e.message); }
  }
  if (gdrive.isConfigured()) {
    for (const fileId of [doc.drive_original_file_id, doc.drive_file_id].filter(Boolean)) {
      try { await gdrive.deleteFile(fileId); } catch (e) { console.error('Gagal menghapus file di Google Drive:', fileId, e.message); }
    }
  }

  const signatureCount = await db.getSignatureCountForDocument(req.params.id);
  await db.deleteDocument(req.params.id); // also removes this document's signature records
  await db.logAudit({
    type: 'delete_document', user_id: req.user.id, username: req.user.username, full_name: req.user.full_name,
    document_id: doc.id, doc_name: doc.doc_name, doc_number: doc.doc_number, was_signed: signatureCount > 0
  });
  res.json({ ok: true });
});

// ---------- AUDIT TRAIL (admin / manager / QA) ----------
app.get('/api/audit-log', requireLogin, requireAuditAccess, async (req, res) => {
  const entries = await db.listAuditLog(500);
  res.json({ entries });
});

// Unduh audit trail sebagai CSV. Dibuat di server (bukan di browser) supaya seluruh
// data ikut terunduh, bukan hanya yang kebetulan sedang tampil di layar.
app.get('/api/audit-log/export', requireLogin, requireAuditAccess, async (req, res) => {
  const entries = await db.listAuditLog(500);
  const LABELS = {
    login: 'Login', logout: 'Logout', upload_document: 'Upload Dokumen',
    sign_document: 'Tanda Tangan', change_password: 'Ganti Password',
    archive_document: 'Arsipkan Dokumen', unarchive_document: 'Kembalikan dari Arsip',
    delete_document: 'Hapus Dokumen', session_expired: 'Sesi Berakhir'
  };
  // Bungkus tiap sel dengan tanda kutip dan gandakan kutip di dalamnya - nama dokumen
  // sering mengandung koma, yang tanpa ini akan menggeser kolom di Excel.
  const cell = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const rows = [['Waktu (WIB)', 'Aktivitas', 'Username', 'Nama Lengkap', 'Departemen', 'No. Dokumen', 'Nama Dokumen']];
  for (const e of entries) {
    rows.push([
      formatStampDateTime(e.timestamp).replace(' WIB', ''),
      LABELS[e.type] || e.type,
      e.username || '', e.full_name || '', e.department || '',
      e.doc_number || '', e.doc_name || ''
    ]);
  }
  const csv = rows.map(r => r.map(cell).join(',')).join('\r\n');
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-trail-${stamp}.csv"`);
  // BOM UTF-8 supaya Excel di Windows membaca huruf beraksen dengan benar.
  res.send('\uFEFF' + csv);
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
