# Login lewat Portal REMS (SSO) — TTE

Kode ini sudah siap memakai login Portal REMS, tapi **belum aktif**. Selama
`SSO_AKTIF` belum bernilai `true`, seluruh tambahan dilewati dan TTE berjalan
persis seperti sebelumnya.

Perubahan sengaja dibuat sekecil mungkin: sistem sesi, tanda tangan, dan data
akun TTE tidak diubah. Saat SSO aktif, TTE hanya menerbitkan sesi TTE-nya
sendiri untuk akun TTE dengan username yang sama dengan login portal.
Disarankan dicatat sebagai change control sebelum diaktifkan.

## A. Sekarang: deploy dalam keadaan mati

1. Upload isi zip ke repository TTE, biarkan Vercel deploy.
2. Tambahkan Environment Variables di Vercel:

| Nama | Isi |
| --- | --- |
| `SSO_AKTIF` | `false` sekarang. Ubah ke `true` saat mengaktifkan. |
| `SSO_SECRET` | Sama persis dengan `SSO_SECRET` di project portal |
| `PORTAL_URL` | `https://portal.myrama.id` |
| `PORTAL_REDIS_URL` | Nilai `UPSTASH_REDIS_REST_URL` di project portal |
| `PORTAL_REDIS_TOKEN` | Nilai `UPSTASH_REDIS_REST_TOKEN` di project portal |

3. Periksa juga `SESSION_SECRET` sudah terisi teks acak panjang. Bila kosong,
   TTE memakai nilai bawaan yang tertulis di kode sumber.
4. Redeploy. Pastikan TTE masih bisa login seperti biasa.

## B. Aktifkan paling akhir

Setelah EMV, EMNV, SPA, dan DMS lancar: ubah `SSO_AKTIF` menjadi `true`, lalu
Redeploy.

## Mengembalikan ke login lama

Ubah `SSO_AKTIF` menjadi `false`, lalu Redeploy.

## Yang berubah saat SSO aktif

- Halaman depan TTE langsung mengarah ke login portal, lalu ke dashboard TTE.
- Portal menentukan siapa yang boleh masuk TTE. Role (admin/personil),
  jabatan, departemen, dan status aktif tetap dibaca dari database TTE.
- User yang punya akses TTE di portal tapi belum punya akun TTE akan melihat
  pesan "Akun TTE belum ada".
- Keluar dari TTE mengakhiri sesi portal. Bila sesi portal berakhir, sesi TTE
  ikut diputus.
- Ganti password lewat portal. Halaman verifikasi QR tetap terbuka untuk umum.
- Login lewat portal tercatat di audit trail TTE sebagai "login" dengan
  keterangan "via Portal REMS".
