const { google } = require('googleapis');
const fs = require('fs');
const db = require('./db');

const REQUIRED_ENV = ['GDRIVE_CLIENT_ID', 'GDRIVE_CLIENT_SECRET', 'GDRIVE_REFRESH_TOKEN', 'GDRIVE_ROOT_FOLDER_ID'];

function isConfigured() {
  return REQUIRED_ENV.every(k => !process.env[k]);
}

let authClient = null;
function getClient() {
  if (authClient) return authClient;
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(`Google Drive belum dikonfigurasi. Env var berikut belum diisi: ${missing.join(', ')}`);
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GDRIVE_CLIENT_ID,
    process.env.GDRIVE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.GDRIVE_REFRESH_TOKEN
  });

  authClient = oauth2Client;
  return authClient;
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

async function uploadSignedDocument({ filePath, fileName, mimeType, department, category }) {
  const drive = getDrive();
  const folderId = category
    ? await getOrCreateCategoryFolder(department, category)
    : await getOrCreateDepartmentFolder(department);
  
  if (!fs.existsSync(filePath)) {
    throw new Error(`File tidak ditemukan di path lokal server Vercel: ${filePath}`);
  }

  const res = await drive.files.create({
    requestBody: { 
      name: fileName, 
      parents: [folderId] 
    },
    media: { 
      mimeType: mimeType, 
      body: fs.createReadStream(filePath) 
    },
    fields: 'id, webViewLink'
  });
  return { fileId: res.data.id, webViewLink: res.data.webViewLink };
}

async function updateSignedDocument({ fileId, filePath, mimeType }) {
  const drive = getDrive();
  
  if (!fs.existsSync(filePath)) {
    throw new Error(`File tidak ditemukan di path lokal server Vercel: ${filePath}`);
  }

  const res = await drive.files.update({
    fileId: fileId,
    media: { 
      mimeType: mimeType, 
      body: fs.createReadStream(filePath) 
    },
    fields: 'id, webViewLink'
  });
  return { fileId: res.data.id, webViewLink: res.data.webViewLink };
}

async function downloadFileBuffer(fileId) {
  const drive = getDrive();
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

module.exports = { isConfigured, uploadSignedDocument, updateSignedDocument, downloadFileBuffer };
