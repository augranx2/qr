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
 * Uploads a signed document into the department's subfolder on Google Drive.
 * Returns { fileId, webViewLink } on success.
 */
async function uploadSignedDocument({ filePath, fileName, mimeType, department }) {
  const drive = getDrive();
  const folderId = await getOrCreateDepartmentFolder(department);
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

module.exports = { isConfigured, uploadSignedDocument, updateSignedDocument };
