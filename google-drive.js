const { google } = require('googleapis');
const fs = require('fs');
const db = require('./db');

const REQUIRED_ENV = ['GDRIVE_CLIENT_ID', 'GDRIVE_CLIENT_SECRET', 'GDRIVE_REFRESH_TOKEN', 'GDRIVE_ROOT_FOLDER_ID'];

function isConfigured() {
  return REQUIRED_ENV.every(k => !!process.env[k]);
}

let oauth2Client = null;
function getClient() {
  if (oauth2Client) return oauth2Client;
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(`Google Drive belum dikonfigurasi. Env var berikut belum diisi: ${missing.join(', ')}`);
  }
  oauth2Client = new google.auth.OAuth2(process.env.GDRIVE_CLIENT_ID, process.env.GDRIVE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: process.env.GDRIVE_REFRESH_TOKEN });
  return oauth2Client;
}

function getDrive() {
  return google.drive({ version: 'v3', auth: getClient() });
}

async function getOrCreateDepartmentFolder(department) {
  const cached = await db.getDriveFolderId(department);
  if (cached) return cached;

  const drive = getDrive();
  const rootId = process.env.GDRIVE_ROOT_FOLDER_ID;
  const safeName = department.trim().replace(/'/g, "\\'");
  const q = `'${rootId}' in parents and name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

  const res = await drive.files.list({ q, fields: 'files(id, name)', spaces: 'drive' });
  let folderId;
  if (res.data.files && res.data.files.length > 0) {
    folderId = res.data.files[0].id;
  } else {
    const created = await drive.files.create({
      requestBody: { name: department.trim(), mimeType: 'application/vnd.google-apps.folder', parents: [rootId] },
      fields: 'id'
    });
    folderId = created.data.id;
  }
  await db.setDriveFolderId(department, folderId);
  return folderId;
}

/**
 * Gets (or creates) a subfolder inside the department folder - e.g. "File Asli" or
 * "File TTD QR Code" - so original and signed documents end up neatly separated
 * even though they share the same top-level department folder. Cached the same way
 * as the department folder itself (under a compound key) to avoid repeat API calls.
 */
async function getOrCreateCategoryFolder(department, categoryName) {
  const cacheKey = `${department}::${categoryName}`;
  const cached = await db.getDriveFolderId(cacheKey);
  if (cached) return cached;

  const deptFolderId = await getOrCreateDepartmentFolder(department);
  const drive = getDrive();
  const safeCat = categoryName.replace(/'/g, "\\'");
  const q = `'${deptFolderId}' in parents and name = '${safeCat}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

  const res = await drive.files.list({ q, fields: 'files(id, name)', spaces: 'drive' });
  let folderId;
  if (res.data.files && res.data.files.length > 0) {
    folderId = res.data.files[0].id;
  } else {
    const created = await drive.files.create({
      requestBody: { name: categoryName, mimeType: 'application/vnd.google-apps.folder', parents: [deptFolderId] },
      fields: 'id'
    });
    folderId = created.data.id;
  }
  await db.setDriveFolderId(cacheKey, folderId);
  return folderId;
}

/**
 * Uploads a document into the department's folder on Google Drive - into a "File Asli"
 * or "File TTD QR Code" subfolder when `category` is given, otherwise directly into the
 * department folder. Returns { fileId, webViewLink } on success.
 */
async function uploadSignedDocument({ filePath, fileName, mimeType, department, category }) {
  const drive = getDrive();
  const folderId = category
    ? await getOrCreateCategoryFolder(department, category)
    : await getOrCreateDepartmentFolder(department);
  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType, body: fs.createReadStream(filePath) },
    fields: 'id, webViewLink'
  });
  return { fileId: res.data.id, webViewLink: res.data.webViewLink };
}

/**
 * Overwrites the content of an existing Drive file (used when a document gets an
 * additional QR signature - keeps one file per document instead of creating duplicates).
 * Returns { fileId, webViewLink } on success.
 */
async function updateSignedDocument({ fileId, filePath, mimeType }) {
  const drive = getDrive();
  const res = await drive.files.update({
    fileId,
    media: { mimeType, body: fs.createReadStream(filePath) },
    fields: 'id, webViewLink'
  });
  return { fileId: res.data.id, webViewLink: res.data.webViewLink };
}

/**
 * Downloads a file's raw bytes from Drive. Used so the app never has to rely on
 * anything being left over on local disk from a previous request - the file always
 * comes fresh from Drive, which is the durable source of truth.
 */
/**
 * Membuat sesi unggah "resumable" ke Google Drive dan mengembalikan URL sesinya.
 *
 * Dipakai untuk berkas besar: browser mengunggah langsung ke URL ini, sehingga
 * datanya TIDAK melewati server aplikasi. Ini menghindari batas ukuran body
 * request pada platform hosting (Vercel ~4,5 MB) yang menolak berkas besar
 * sebelum sampai ke kode aplikasi.
 *
 * URL sesi yang dikembalikan sudah membawa kredensialnya sendiri dan berlaku
 * singkat, jadi browser tidak perlu (dan tidak pernah) menerima token akses
 * Google milik aplikasi.
 */
async function createResumableUploadSession({ fileName, mimeType, department, category }) {
  const folderId = category
    ? await getOrCreateCategoryFolder(department, category)
    : await getOrCreateDepartmentFolder(department);

  const client = getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Gagal memperoleh access token Google Drive');

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType
      },
      body: JSON.stringify({ name: fileName, parents: [folderId] })
    }
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gagal membuat sesi upload Drive (${res.status}): ${detail.slice(0, 200)}`);
  }
  const uploadUrl = res.headers.get('location');
  if (!uploadUrl) throw new Error('Google Drive tidak mengembalikan URL sesi upload');
  return { uploadUrl, folderId };
}

/**
 * Mengambil metadata satu berkas. Dipakai untuk memastikan berkas yang diklaim
 * browser memang benar-benar ada di Drive sebelum dicatat ke basis data.
 */
async function getFileMeta(fileId) {
  const drive = getDrive();
  const res = await drive.files.get({ fileId, fields: 'id, name, size, mimeType, webViewLink, parents' });
  return res.data;
}

async function downloadFileBuffer(fileId) {
  const drive = getDrive();
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

/**
 * Permanently deletes a file from Google Drive (used when a document is deleted from
 * the app, to remove both the original and signed/QR copies, not just the app's own
 * record of them). If the file is already gone (e.g. deleted manually, or never
 * existed), Drive returns a 404 - that's treated as success since the end state
 * ("file no longer in Drive") is the same either way.
 */
async function deleteFile(fileId) {
  if (!fileId) return;
  const drive = getDrive();
  try {
    await drive.files.delete({ fileId });
  } catch (e) {
    const status = (e && (e.code || (e.response && e.response.status)));
    if (status === 404) return; // already gone - nothing left to do
    throw e;
  }
}

module.exports = {
  isConfigured, uploadSignedDocument, updateSignedDocument, downloadFileBuffer, deleteFile,
  createResumableUploadSession, getFileMeta
};
