# Aplikasi TTD Elektronik via QR Code — PT REMS

Web app untuk upload dokumen (PDF/JPG/PNG), lalu ditandatangani secara elektronik dengan QR Code yang bisa ditempatkan bebas di posisi manapun pada dokumen. QR berisi link ke halaman verifikasi publik.

## Fitur
- Login per personil (username & password sendiri)
- Upload dokumen dengan metadata wajib: nama dokumen, nomor dokumen, departemen
- Editor drag-and-drop untuk menempatkan posisi & ukuran QR pada dokumen (support multi-halaman PDF)
- QR di-embed permanen ke file PDF/gambar
- Halaman verifikasi publik (dibuka saat QR di-scan) menampilkan detail dokumen & penandatangan
- **Dokumen hasil TTD otomatis tersimpan ke Google Drive** (folder per departemen), sambil tetap tersimpan juga di server
- Role admin untuk menambah akun personil baru

## Cara Menjalankan (Development/Testing)

1. Pastikan Node.js versi 18+ sudah terpasang di server.
2. Masuk ke folder project, install dependency:
   ```
   npm install
   ```
3. Jalankan:
   ```
   npm start
   ```
4. Buka `http://localhost:3000` di browser.
5. Login pertama kali dengan akun default:
   - Username: `admin`
   - Password: `admin123`
   - **WAJIB segera ganti password ini** (lihat bagian "Mengganti Password Admin" di bawah).

## Konfigurasi Production (Wajib sebelum dipakai beneran)

Buat file `.env` (salin dari `.env.example`) dan isi:

```
PORT=3000
BASE_URL=https://ttd.remspharma.co.id   # ganti sesuai domain asli Anda — ini yang akan tertulis di QR
SESSION_SECRET=isi-dengan-string-acak-yang-panjang-dan-rahasia
```

**BASE_URL harus domain publik yang bisa diakses siapa saja** (termasuk auditor BPOM/eksternal yang scan QR dari HP mereka) — jangan `localhost`.

Untuk menjalankan `.env` secara otomatis di server kantor, install `dotenv` (`npm install dotenv`) dan tambahkan `require('dotenv').config();` di baris pertama `server.js` — ini sengaja saya lepas dari kode karena saat pengujian package tersebut menampilkan pesan mencurigakan di log yang tidak semestinya ada di package resmi. **Sebelum menambahkannya kembali, saya sarankan tim IT Anda mengecek dulu integritas package `dotenv` di npm registry**, atau cukup set environment variable langsung di sistem/PM2 tanpa perlu package `dotenv` sama sekali (lihat bagian PM2 di bawah — cara ini yang saya rekomendasikan).

## Setup Google Drive (Menyimpan Otomatis Dokumen Hasil TTD)

Fitur ini menyimpan setiap dokumen yang sudah ditandatangani (ber-QR) ke Google Drive pribadi Anda, ke dalam folder sesuai departemen dokumen tersebut. Ini pakai **OAuth2 dengan akun Google Anda sendiri** (bukan service account) — karena Anda pakai Drive pribadi (200GB), bukan Google Workspace dengan Shared Drive. Artinya file yang terupload akan memakai kuota penyimpanan akun Google Anda, dan siapa saja yang boleh akses tetap Anda atur lewat fitur share folder Google Drive seperti biasa.

### Langkah 1: Buat kredensial di Google Cloud Console
1. Buka [console.cloud.google.com](https://console.cloud.google.com), buat project baru (nama bebas, mis. "TTD QR REMS")
2. Di menu **APIs & Services > Library**, cari "Google Drive API", klik **Enable**
3. Di menu **APIs & Services > OAuth consent screen**:
   - Pilih **User Type: External**
   - Isi nama aplikasi, email Anda
   - Di bagian **Test users**, tambahkan email Google Drive Anda sendiri
   - Simpan (tidak perlu submit untuk verifikasi Google, karena hanya dipakai internal)
4. Di menu **APIs & Services > Credentials**, klik **Create Credentials > OAuth client ID**:
   - Application type: **Desktop app**
   - Beri nama bebas, klik Create
   - Catat **Client ID** dan **Client Secret** yang muncul

### Langkah 2: Buat folder induk di Google Drive
1. Di Google Drive Anda, buat 1 folder induk, misal "Dokumen TTD PT REMS"
2. Buka folder tersebut, lihat URL-nya di browser: `https://drive.google.com/drive/folders/XXXXXXXXXXXXX`
3. Bagian `XXXXXXXXXXXXX` itu adalah Folder ID Anda — catat ini

Folder per departemen (QA, Produksi, dst) akan **dibuat otomatis oleh aplikasi** di dalam folder induk ini saat dokumen pertama dari departemen tersebut ditandatangani.

### Langkah 3: Dapatkan Refresh Token (dilakukan sekali saja)
1. Set environment variable sementara di terminal:
   ```
   export GDRIVE_CLIENT_ID="isi-dari-langkah-1"
   export GDRIVE_CLIENT_SECRET="isi-dari-langkah-1"
   ```
2. Jalankan:
   ```
   node get-refresh-token.js
   ```
3. Buka link yang muncul di terminal, login dengan akun Google Drive kantor Anda, klik **Allow**
4. Refresh token akan otomatis muncul di terminal — salin nilainya

### Langkah 4: Isi semua ke file `.env`
```
GDRIVE_CLIENT_ID=isi-dari-langkah-1
GDRIVE_CLIENT_SECRET=isi-dari-langkah-1
GDRIVE_REFRESH_TOKEN=isi-dari-langkah-3
GDRIVE_ROOT_FOLDER_ID=isi-dari-langkah-2
```

Restart aplikasi. Selesai — setiap dokumen yang ditandatangani sekarang otomatis tersalin ke Google Drive, masuk ke folder sesuai departemennya. Jika env var ini belum diisi, aplikasi tetap berjalan normal seperti biasa (dokumen hanya tersimpan di server, tidak error).

**Catatan keamanan:** `GDRIVE_REFRESH_TOKEN` setara dengan akses penuh ke Drive Anda (terbatas pada file yang dibuat aplikasi ini, karena scope yang dipakai adalah `drive.file`). Jangan commit ke Git, jangan share ke siapapun — simpan hanya sebagai environment variable di `.env` (lokal) atau di pengaturan environment variable Vercel/server (production).

**Kalau upload ke Drive gagal** (misal token kedaluwarsa, folder terhapus, dsb), dokumen **tetap berhasil ditandatangani dan tersimpan di server** — hanya bagian upload ke Drive-nya yang gagal, dicatat di log server. Tidak akan menghentikan proses TTD.

## Tahap 1: Deploy ke Vercel (untuk testing/review desain dulu)

⚠️ **Penting dipahami dulu:** Vercel itu *serverless* — filesystem-nya hanya bisa ditulis di folder sementara (`/tmp`), dan folder itu **akan terhapus** setiap ada deployment baru atau saat fungsi "tidur" lalu aktif lagi (cold start). Artinya:
- Dokumen yang diupload dan data (user, tanda tangan) **bisa hilang sewaktu-waktu** selama masa testing ini
- Cocok untuk: mengecek tampilan, alur kerja, drag-QR, hasil PDF ber-QR
- **Tidak cocok** untuk: menyimpan dokumen resmi jangka panjang — itu baru dilakukan di Tahap 2 (server kantor)

Kode di project ini sudah saya siapkan supaya otomatis mendeteksi jika berjalan di Vercel (lewat `vercel.json` + `api/index.js`) dan akan pakai `/tmp` secara otomatis — Anda tidak perlu ubah apa-apa.

### Langkah deploy:
1. Install Vercel CLI (butuh Node.js di komputer Anda):
   ```
   npm install -g vercel
   ```
2. Masuk ke folder project ini, lalu login:
   ```
   vercel login
   ```
3. Set environment variable dulu (BASE_URL akan otomatis terisi domain Vercel Anda — bisa juga diatur manual setelah deploy pertama, karena Vercel baru kasih tahu domainnya setelah deploy sekali):
   ```
   vercel
   ```
   Ikuti pertanyaan interaktifnya (pilih default untuk kebanyakan opsi).
4. Setelah deploy pertama selesai, Anda akan dapat URL seperti `https://qr-signature-app-xxxx.vercel.app`. Set env var `BASE_URL` dengan URL ini (supaya QR yang digenerate mengarah ke link yang benar):
   ```
   vercel env add BASE_URL
   ```
   Isi dengan URL di atas, lalu deploy ulang:
   ```
   vercel --prod
   ```
5. Buka URL tersebut, login dengan `admin` / `admin123`, dan coba seluruh alurnya.

**Catatan:** jika ingin data upload/tanda-tangan tidak hilang selama masa testing Vercel (misal untuk didemokan ke tim beberapa hari), beri tahu saya — saya bisa sambungkan ke database gratis seperti Vercel Postgres atau Turso, supaya lebih stabil sebelum pindah ke server kantor.

## Tahap 2: Pindah ke Server Kantor (Production Sesungguhnya)

Setelah desain & alur kerja disetujui, serahkan folder project ini ke tim IT Anda dengan instruksi berikut:

Disarankan pakai **PM2** supaya aplikasi tetap jalan setelah server restart:

```bash
npm install -g pm2
PORT=3000 BASE_URL=https://ttd.remspharma.co.id SESSION_SECRET=xxxxx pm2 start server.js --name ttd-qr-app
pm2 save
pm2 startup
```

Lalu pasang reverse proxy (Nginx) di depannya dengan HTTPS (wajib, karena ini menyangkut dokumen resmi perusahaan):

```nginx
server {
    listen 443 ssl;
    server_name ttd.remspharma.co.id;
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
    }
}
```

## Menambah Akun Personil Baru

Login sebagai admin, lalu panggil endpoint (bisa dibuatkan halaman UI-nya menyusul, untuk sekarang via API):

```bash
curl -X POST https://ttd.remspharma.co.id/api/users \
  -H "Content-Type: application/json" \
  --cookie "<cookie sesi admin>" \
  -d '{"username":"budi.qa","password":"passwordAwal123","full_name":"Budi Santoso","department":"QA","role":"personil"}'
```
Sarankan personil mengganti password setelah login pertama (fitur ganti password belum ada di versi ini — bisa saya tambahkan kalau diperlukan).

## Mengganti Password Admin

Untuk sekarang, cara tercepat adalah hapus file `data/store.json`, edit password default di `db.js` (bagian `bcrypt.hashSync('admin123', 10)`), lalu jalankan ulang — atau minta saya tambahkan halaman ganti password di update berikutnya.

## Struktur Data

- `data/store.json` — database berbasis file JSON (users, documents, signatures). **Backup rutin file ini.** Di Vercel, file ini otomatis disimpan di `/tmp` (sementara); di server kantor, tersimpan permanen di folder project.
- `uploads/` — file asli yang diupload (belum ditandatangani)
- `signed/` — file hasil setelah QR di-embed (inilah yang dibuka publik lewat link verifikasi)

Catatan: aplikasi ini sengaja menggunakan JSON file sebagai database (bukan SQLite/PostgreSQL) supaya tidak ada native module yang perlu dikompilasi — lebih portable untuk dijalankan di Vercel maupun server biasa. Kalau nanti jumlah dokumen sudah banyak (ratusan/ribuan) dan performa jadi masalah, beri tahu saya untuk dipindahkan ke database sungguhan.

## Catatan Compliance (CPOB)
Setiap tanda tangan tercatat di tabel `signatures` (siapa, dokumen apa, kapan) — bisa dipakai sebagai audit trail. Untuk kebutuhan yang lebih ketat (mis. tidak bisa dihapus/diedit, log akses, dsb.), beri tahu saya dan saya bisa perkuat lapisan audit trail-nya.

## Belum Termasuk di Versi Ini (bisa ditambahkan)
- Halaman ganti password mandiri untuk personil
- Halaman UI untuk admin menambah/mengelola user (saat ini via API)
- Notifikasi email saat dokumen menunggu tanda tangan
- Multi-level approval (lebih dari satu tanda tangan per dokumen)
