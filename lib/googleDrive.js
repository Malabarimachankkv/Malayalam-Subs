const { google } = require('googleapis');
const { Readable } = require('stream');

// Auth as a Service Account (a robot Google account, not a real user) using
// credentials you generate once in Google Cloud Console. This avoids any
// interactive OAuth consent flow — the addon just needs the folder in your
// Drive shared with the service account's email as an Editor. See README for
// the step-by-step setup.
let authClient = null;
function getAuth() {
  if (authClient) return authClient;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY env var not set (see README for how to create one).');

  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (err) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON — paste the full contents of the key file.');
  }

  authClient = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return authClient;
}

let driveClient = null;
function getDrive() {
  if (driveClient) return driveClient;
  driveClient = google.drive({ version: 'v3', auth: getAuth() });
  return driveClient;
}

const FOLDER_ID = process.env.GDRIVE_FOLDER_ID;

function bufferToStream(buffer) {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

async function uploadFile(name, buffer, mimeType) {
  if (!FOLDER_ID) throw new Error('GDRIVE_FOLDER_ID env var not set.');
  const drive = getDrive();
  const res = await drive.files.create({
    requestBody: { name, parents: [FOLDER_ID] },
    media: { mimeType, body: bufferToStream(buffer) },
    fields: 'id',
  });
  return res.data.id;
}

async function updateFile(fileId, buffer, mimeType) {
  const drive = getDrive();
  await drive.files.update({ fileId, media: { mimeType, body: bufferToStream(buffer) } });
}

async function downloadFile(fileId) {
  const drive = getDrive();
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

async function deleteFile(fileId) {
  const drive = getDrive();
  await drive.files.delete({ fileId });
}

async function findFileByName(name) {
  if (!FOLDER_ID) throw new Error('GDRIVE_FOLDER_ID env var not set.');
  const drive = getDrive();
  const res = await drive.files.list({
    q: `'${FOLDER_ID}' in parents and name = '${name}' and trashed = false`,
    fields: 'files(id, name)',
    spaces: 'drive',
  });
  return (res.data.files && res.data.files[0]) || null;
}

module.exports = { uploadFile, updateFile, downloadFile, deleteFile, findFileByName };
