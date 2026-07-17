// Minimal HTTP Basic Auth so random internet visitors can't upload to your
// pool or see/delete what's in it. Set ADMIN_USER and ADMIN_PASSWORD as
// environment variables on your host (Render: Environment tab). If either is
// missing, the whole /admin area is disabled (returns 503) rather than
// silently running unprotected.
function requireAdminAuth(req, res, next) {
  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASSWORD;

  if (!user || !pass) {
    return res
      .status(503)
      .send('Admin dashboard is disabled: set ADMIN_USER and ADMIN_PASSWORD env vars on your host to enable it.');
  }

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sepIdx = decoded.indexOf(':');
    const reqUser = decoded.slice(0, sepIdx);
    const reqPass = decoded.slice(sepIdx + 1);
    if (reqUser === user && reqPass === pass) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Subtitle Pool Admin"');
  return res.status(401).send('Authentication required.');
}

module.exports = { requireAdminAuth };
