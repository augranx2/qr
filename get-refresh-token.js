// Jalankan skrip ini SEKALI SAJA di komputer Anda untuk mendapatkan refresh token.
// Cara pakai:
//   1. Set dulu GDRIVE_CLIENT_ID dan GDRIVE_CLIENT_SECRET (lihat README.md)
//   2. Jalankan: node get-refresh-token.js
//   3. Buka link yang muncul di terminal, login dengan akun Google Drive kantor Anda, klik Allow
//   4. Refresh token akan muncul di terminal - simpan sebagai GDRIVE_REFRESH_TOKEN di .env

const { google } = require('googleapis');
const http = require('http');

const CLIENT_ID = process.env.GDRIVE_CLIENT_ID;
const CLIENT_SECRET = process.env.GDRIVE_CLIENT_SECRET;
const PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set dulu environment variable GDRIVE_CLIENT_ID dan GDRIVE_CLIENT_SECRET sebelum menjalankan skrip ini.');
  console.error('Contoh: GDRIVE_CLIENT_ID=xxx GDRIVE_CLIENT_SECRET=yyy node get-refresh-token.js');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // paksa muncul consent screen supaya refresh_token pasti diberikan
  scope: ['https://www.googleapis.com/auth/drive.file']
});

console.log('\n=== LANGKAH SETUP GOOGLE DRIVE ===\n');
console.log('1. Buka link berikut di browser:\n');
console.log(authUrl);
console.log('\n2. Login dengan akun Google Drive kantor Anda, lalu klik Allow.');
console.log('3. Anda akan diarahkan kembali otomatis dan refresh token akan muncul di sini.\n');
console.log('Menunggu Anda menyelesaikan login di browser...\n');

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, REDIRECT_URI);
    const code = reqUrl.searchParams.get('code');
    if (!code) {
      res.end('Tidak ada kode otorisasi ditemukan. Coba ulangi dari awal.');
      return;
    }
    res.end('Berhasil! Anda bisa menutup tab ini dan kembali ke terminal.');
    const { tokens } = await oauth2Client.getToken(code);
    console.log('=== SIMPAN BARIS DI BAWAH INI KE FILE .env ANDA ===\n');
    console.log(`GDRIVE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('\n=====================================================\n');
    server.close();
    process.exit(0);
  } catch (e) {
    console.error('Gagal menukar kode otorisasi:', e.message);
    res.end('Terjadi kesalahan, cek terminal.');
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`(server siap menerima redirect di ${REDIRECT_URI})\n`);
});
