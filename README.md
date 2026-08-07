# Aplikasi TTD Elektronik via QR Code — PT REMS

Web app untuk upload dokumen (PDF/JPG/PNG), lalu ditandatangani secara elektronik dengan QR Code yang bisa ditempatkan bebas di posisi manapun pada dokumen. QR berisi link ke halaman verifikasi publik.

## Fitur
- Login per personil (username & password sendiri)
- Upload dokumen dengan metadata wajib: nama dokumen, nomor dokumen, departemen
- Editor drag-and-drop untuk menempatkan posisi & ukuran QR pada dokumen (support multi-halaman PDF)
- QR di-embed permanen ke file PDF/gambar
- Halaman verifikasi publik (dibuka saat QR di-scan) menampilkan detail dokumen & penandatangan
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

Untuk menjalankan `.env` secara otomatis, install `dotenv` lagi (`npm install dotenv`) dan tambahkan `require('dotenv').config();` di baris pertama `server.js` — ini sengaja saya lepas dari kode karena saat pengujian package tersebut menampilkan pesan mencurigakan di log yang tidak semestinya ada di package resmi. **Sebelum menambahkannya kembali, saya sarankan tim IT Anda mengecek dulu integritas package `dotenv` di npm registry**, atau cukup set environment variable langsung di sistem/PM2 tanpa perlu package `dotenv` sama sekali (lihat bagian Deployment di bawah).

## Deployment ke Server Sungguhan

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

Untuk sekarang, cara tercepat adalah hapus file `data/app.db`, edit password default di `db.js`, lalu jalankan ulang — atau minta saya tambahkan halaman ganti password di update berikutnya.

## Struktur Data

- `data/app.db` — database SQLite (users, documents, signatures). **Backup rutin file ini.**
- `uploads/` — file asli yang diupload (belum ditandatangani)
- `signed/` — file hasil setelah QR di-embed (inilah yang dibuka publik lewat link verifikasi)

## Catatan Compliance (CPOB)
Setiap tanda tangan tercatat di tabel `signatures` (siapa, dokumen apa, kapan) — bisa dipakai sebagai audit trail. Untuk kebutuhan yang lebih ketat (mis. tidak bisa dihapus/diedit, log akses, dsb.), beri tahu saya dan saya bisa perkuat lapisan audit trail-nya.

## Belum Termasuk di Versi Ini (bisa ditambahkan)
- Halaman ganti password mandiri untuk personil
- Halaman UI untuk admin menambah/mengelola user (saat ini via API)
- Notifikasi email saat dokumen menunggu tanda tangan
- Multi-level approval (lebih dari satu tanda tangan per dokumen)
