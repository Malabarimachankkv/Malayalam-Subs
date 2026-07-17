const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

// Backblaze B2's S3-compatible API — same client works unmodified against
// AWS S3, Cloudflare R2, or any other S3-compatible provider by just
// changing these four env vars, in case you ever want to switch again.
let client = null;
function getClient() {
  if (client) return client;
  const endpoint = process.env.B2_ENDPOINT;
  const region = process.env.B2_REGION;
  const keyId = process.env.B2_KEY_ID;
  const appKey = process.env.B2_APPLICATION_KEY;
  if (!endpoint || !region || !keyId || !appKey) {
    throw new Error('Missing B2_ENDPOINT / B2_REGION / B2_KEY_ID / B2_APPLICATION_KEY env vars (see README).');
  }
  client = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId: keyId, secretAccessKey: appKey },
  });
  return client;
}

const BUCKET = () => {
  const bucket = process.env.B2_BUCKET;
  if (!bucket) throw new Error('Missing B2_BUCKET env var (see README).');
  return bucket;
};

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Store a buffer under `key`. `metadata` (plain string key/values) travels
 * with the object and comes back on getObject — used to remember a
 * subtitle's original extension without needing a separate index lookup.
 */
async function putObject(key, buffer, contentType, metadata = {}) {
  await getClient().send(
    new PutObjectCommand({
      Bucket: BUCKET(),
      Key: key,
      Body: buffer,
      ContentType: contentType,
      Metadata: metadata,
    })
  );
}

/**
 * Returns { buffer, contentType, metadata } or null if the key doesn't exist.
 * Any other error (auth failure, network issue, etc.) is thrown, not swallowed.
 */
async function getObject(key) {
  try {
    const res = await getClient().send(new GetObjectCommand({ Bucket: BUCKET(), Key: key }));
    const buffer = await streamToBuffer(res.Body);
    return { buffer, contentType: res.ContentType, metadata: res.Metadata || {} };
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

async function deleteObject(key) {
  await getClient().send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: key }));
}

module.exports = { putObject, getObject, deleteObject };
