# Aplikasi TTD Elektronik via QR Code — PT REMS

Web app untuk upload dokumen (PDF/JPG/PNG), lalu ditandatangani secara elektronik dengan QR Code yang bisa ditempatkan bebas di posisi manapun pada dokumen. QR berisi link ke halaman verifikasi publik.

## Fitur
- Login per personil (username & password sendiri)
- Upload dokumen dengan metadata wajib: nama dokumen, nomor dokumen, departemen (pilih dari dropdown, bukan ketik bebas)
- Editor drag-and-drop untuk menempatkan posisi & ukuran QR pada dokumen (support multi-halaman PDF)
- **Bisa tempel QR lebih dari satu kali di dokumen yang sama** (mis. alur review berjenjang: dibuat QA, diperiksa Supervisor, disetujui Manager) — tiap QR baru menumpuk di atas versi sebelumnya tanpa menghapus QR yang sudah ada
- QR di-embed permanen ke file PDF/gambar
- Halaman verifikasi publik (dibuka saat QR di-scan) menampilkan detail dokumen & penandatangan
- **Dokumen hasil TTD otomatis tersimpan ke Google Drive** (folder per departemen, satu file yang terus ter-update seiring bertambahnya TTD — bukan file baru menumpuk tiap kali ditandatangani)
- Halaman **Kelola User & Departemen** (khusus admin): tambah/hapus personil, reset password, kelola daftar departemen beserta kaitan folder Google Drive-nya

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
5. Login pertama kali dengan salah satu akun default (dua-duanya berperan admin penuh):
   - Username: `admin` / Password: `admin123`
   - Username: `dev` / Password: `dev1066` (akun developer, akses sama seperti admin)
   - **WAJIB segera ganti kedua password ini** sebelum dipakai beneran (lihat bagian "Mengganti Password Admin" di bawah).

## Konfigurasi Production (Wajib sebelum dipakai beneran)

Buat file `.env` (salin dari `.env.example`) dan isi:

```
PORT=3000
BASE_URL=https://ttd.remspharma.co.id   # ganti sesuai domain asli Anda — ini yang akan tertulis di QR
SESSION_SECRET=isi-dengan-string-acak-yang-panjang-dan-rahasia
```

**BASE_URL harus domain publik yang bisa diakses siapa saja** (termasuk auditor BPOM/eksternal yang scan QR dari HP mereka) — jangan `localhost`.

**Tentang login (`SESSION_SECRET`):** Aplikasi ini pakai token JWT tersimpan di cookie browser untuk login, bukan session di memori server. Ini sengaja dipilih supaya kompatibel dengan Vercel (serverless) — kalau pakai session biasa, tiap request bisa "dilempar" ke instance server berbeda dan Anda akan terus-menerus dianggap belum login. `SESSION_SECRET` dipakai untuk menandatangani token ini — **wajib diisi dengan string acak yang panjang** di production (Vercel/server kantor), jangan pakai nilai default di kode.

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

## Tahap 1: Deploy ke Vercel

⚠️ **WAJIB dibaca dulu — ini bukan cuma catatan tambahan:** Vercel itu *serverless* — setiap request bisa "dilempar" ke instance server yang berbeda-beda, dan masing-masing instance **tidak berbagi memori atau file** satu sama lain. Kalau data (user, dokumen, tanda tangan) disimpan sebagai file biasa, akibatnya:
- User baru yang ditambahkan **kadang muncul kadang tidak** (tergantung instance mana yang kebagian request)
- Fitur multi-QR (tempel QR berkali-kali) **bisa gagal**, karena sistem tidak selalu tahu dokumen ini sudah punya QR sebelumnya atau belum
- QR yang digenerate **bisa mengarah ke `localhost`** kalau environment variable `BASE_URL` tidak ter-set dengan benar di lingkungan Production

**Solusinya, dan ini WAJIB untuk deploy ke Vercel:** pakai **database terpusat** (bukan file), supaya semua instance baca-tulis ke sumber data yang sama. Project ini sudah saya siapkan untuk otomatis pakai **Upstash Redis** (database key-value gratis, terintegrasi langsung di Vercel Marketplace) kalau tersedia — kalau tidak diaktifkan, akan otomatis fallback ke file biasa (cukup untuk lokal/server kantor yang cuma 1 proses selalu nyala, tapi **tidak cukup untuk Vercel**).

### Langkah A: Aktifkan Upstash Redis (WAJIB untuk Vercel)
1. Buka [vercel.com](https://vercel.com), masuk ke project Anda (`qr-signature-app`)
2. Klik tab **Storage** di project tersebut
3. Klik **Create Database** (atau **Browse Marketplace** kalau tidak muncul langsung), cari **Upstash** / **Redis**
4. Pilih paket gratis (Free/Hobby), pilih region (pilih yang terdekat, mis. Singapore)
5. Klik **Connect** ke project `qr-signature-app` Anda
6. Vercel akan **otomatis mengisi** environment variable `KV_REST_API_URL` dan `KV_REST_API_TOKEN` ke project Anda — Anda tidak perlu copy-paste apapun secara manual

Setelah ini aktif, **semua data (user, dokumen, tanda tangan) akan konsisten** di semua instance Vercel — masalah "kadang muncul kadang tidak" akan hilang.

### Langkah B: Set BASE_URL dengan benar (supaya QR tidak mengarah ke localhost)
Ini yang sering kelewat: environment variable harus diisi **khusus untuk environment "Production"**, bukan cuma "Development".

1. Di dashboard Vercel project Anda, buka **Settings > Environment Variables**
2. Cari (atau tambah) `BASE_URL`
3. **Pastikan dicentang untuk "Production"** (bukan cuma Preview/Development)
4. Isi dengan domain production Anda yang sebenarnya, contoh: `https://qr-signature-app.vercel.app` (tanpa `/` di akhir — cek domain persis di tab **Domains**)
5. Lakukan hal yang sama untuk `SESSION_SECRET` dan semua `GDRIVE_*` — pastikan semuanya dicentang untuk Production

Setelah kedua langkah di atas (Upstash + BASE_URL) selesai, **deploy ulang** supaya perubahan environment variable terpakai:
```
vercel --prod
```

⚠️ Environment variable yang baru ditambahkan/diubah di dashboard **tidak otomatis berlaku** ke deployment yang sudah jalan — selalu perlu `vercel --prod` ulang setelahnya.

### Langkah C: Deploy pertama kali (kalau belum pernah)
1. Install Vercel CLI: `npm install -g vercel`
2. Login: `vercel login`
3. Di folder project: `vercel` (ikuti wizard)
4. Setelah dapat URL pertama, lakukan Langkah A dan B di atas
5. Deploy ulang: `vercel --prod`
6. Buka URL-nya, login dengan `admin`/`admin123` atau `dev`/`dev1066`

## Alur Kerja Lebih Mudah: GitHub + Auto-Deploy

Kalau sekarang terasa ribet karena tiap ada fitur baru harus: copy folder → `npm install` → `vercel --prod` manual, ini bisa disederhanakan dengan menghubungkan **GitHub**. Setelah terhubung, tiap saya kirim file baru, Anda tinggal push ke GitHub — **Vercel otomatis deploy sendiri**, tidak perlu command `vercel --prod` lagi, dan tidak perlu copy folder ke folder baru lagi (Git yang jaga histori perubahan, backup manual Anda tidak diperlukan lagi).

### Setup (dilakukan sekali saja):
1. Buat akun di [github.com](https://github.com) kalau belum punya
2. Buat repository baru, **pilih Private** (supaya kode tidak publik), beri nama bebas misal `qr-signature-app`
3. Di komputer Anda, folder project (Folder B), jalankan:
   ```
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/USERNAME-ANDA/qr-signature-app.git
   git push -u origin main
   ```
   (Ganti `USERNAME-ANDA` dengan username GitHub Anda. Saat push pertama kali biasanya diminta login GitHub lewat browser.)
4. Di dashboard Vercel, buka project Anda, ke **Settings > Git**, klik **Connect Git Repository**, pilih repo GitHub yang baru dibuat itu

Setelah ini terhubung: tiap saya kasih Anda file baru, caranya jadi:
```
(timpa file yang berubah ke folder project Anda)
git add .
git commit -m "update fitur X"
git push
```
Vercel otomatis mendeteksi push ini dan mulai deploy — tidak perlu `vercel --prod` manual lagi. Anda bisa pantau progresnya di dashboard Vercel, tab **Deployments**.

**Bonus:** dengan Git, kalau ada update yang ternyata bikin error, Anda bisa lihat riwayat versi sebelumnya di tab Deployments dan klik "Promote to Production" untuk balik ke versi yang masih normal — jauh lebih aman daripada mengandalkan folder backup manual.

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

Login sebagai **admin**, lalu klik link **"Kelola User & Departemen"** di pojok kanan atas dashboard (hanya muncul untuk akun admin). Di halaman itu Anda bisa:
- Tambah personil baru (username, password awal, nama, departemen, peran)
- Reset password personil kapan saja
- Hapus akun personil
- Kelola daftar departemen (dropdown yang muncul saat upload dokumen) dan mengaitkan tiap departemen ke folder Google Drive tertentu

Tidak perlu lagi lewat command line/API manual — semua sudah ada UI-nya di `/admin.html`.

## Mengganti Password Admin

Login sebagai admin, buka halaman **Kelola User & Departemen**, klik **"Reset Password"** di baris akun `admin`. Atau kalau lupa password sama sekali: hapus file `data/store.json`, lalu jalankan ulang aplikasi (akun admin default akan dibuat lagi dengan password `admin123`).

## Struktur Data

- **Data (user, dokumen, tanda tangan):** disimpan di **Upstash Redis** kalau berjalan di Vercel dengan Storage sudah dikonek (lihat Tahap 1, Langkah A) — ini sumber data terpusat yang konsisten di semua instance. Kalau Upstash belum dikonek (mis. saat testing lokal), otomatis fallback ke file `data/store.json` — cukup untuk lokal/server kantor (satu proses saja yang selalu nyala), **tapi tidak cukup untuk Vercel** karena filesystem-nya tidak dibagi antar-instance.
- `uploads/` — file asli yang diupload (belum ditandatangani). Di Vercel ini tersimpan sementara di `/tmp` (khusus untuk generate preview saat proses tanda tangan) — di server kantor, tersimpan permanen di folder project.
- `signed/` — file hasil setelah QR di-embed (inilah yang dibuka publik lewat link verifikasi, dan yang dikirim ke Google Drive)

Catatan: kalau nanti pindah ke server kantor dan tidak mau pakai Upstash (koneksi internet ke luar mungkin dibatasi), aplikasi akan otomatis pakai file `data/store.json` biasa — ini aman karena di server kantor cuma ada 1 proses yang selalu nyala (lewat PM2), beda dengan Vercel yang bisa punya banyak instance sekaligus.

## Catatan Compliance (CPOB)
Setiap tanda tangan tercatat (siapa, dokumen apa, kapan) — bisa dipakai sebagai audit trail. Untuk kebutuhan yang lebih ketat (mis. tidak bisa dihapus/diedit, log akses, dsb.), beri tahu saya dan saya bisa perkuat lapisan audit trail-nya.

## Belum Termasuk di Versi Ini (bisa ditambahkan)
- Halaman ganti password mandiri untuk personil
- Halaman UI untuk admin menambah/mengelola user (saat ini via API)
- Notifikasi email saat dokumen menunggu tanda tangan
- Multi-level approval (lebih dari satu tanda tangan per dokumen)
