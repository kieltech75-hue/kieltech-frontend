const { get, all, run } = require('./db');
const { registerUser, loginUser, getUserById, verifyToken } = require('./auth');
const { sendEmail } = require('./mail');

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}

async function getAuthUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return null;
  try {
    const payload = verifyToken(token);
    return getUserById(payload.id);
  } catch {
    return null;
  }
}

async function handleRoutes(req, res) {
  const { method, url } = req;

  if (method === 'GET' && url === '/api/health') {
    return sendJson(res, 200, { status: 'ok', service: 'KielTech API', database: process.env.DATABASE_URL ? 'postgres' : 'sqlite' });
  }

  if (method === 'POST' && url === '/api/auth/signup') {
    try {
      const body = await parseBody(req);
      if (!body.name || !body.email || !body.password) {
        return sendJson(res, 400, { error: 'Missing signup fields' });
      }
      const user = await registerUser(body);
      return sendJson(res, 201, { message: 'Account created', user });
    } catch (error) {
      return sendJson(res, 400, { error: error.message || 'Signup failed' });
    }
  }

  if (method === 'POST' && url === '/api/auth/login') {
    try {
      const body = await parseBody(req);
      const result = await loginUser(body);
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, 401, { error: error.message || 'Login failed' });
    }
  }

  if (method === 'GET' && url === '/api/auth/me') {
    const user = await getAuthUser(req);
    if (!user) return sendJson(res, 401, { error: 'Authentication required' });
    return sendJson(res, 200, { user });
  }

  if (method === 'GET' && url === '/api/downloads') {
    const rows = await all("SELECT * FROM downloads WHERE status != 'rejected' ORDER BY id");
    return sendJson(res, 200, { downloads: rows });
  }

  if (method === 'POST' && url.startsWith('/api/downloads/')) {
    const id = Number(url.split('/').pop());
    if (!id) return sendJson(res, 400, { error: 'Invalid download id' });
    const row = await get('SELECT * FROM downloads WHERE id = ?', [id]);
    if (!row) return sendJson(res, 404, { error: 'Download not found' });
    await run('UPDATE downloads SET downloads_count = downloads_count + 1 WHERE id = ?', [id]);
    return sendJson(res, 200, { message: 'Download recorded', download: { ...row, downloads_count: row.downloads_count + 1 } });
  }

  if (method === 'GET' && url === '/api/ratings') {
    const rows = await all("SELECT * FROM ratings WHERE status = 'approved' ORDER BY id");
    return sendJson(res, 200, { ratings: rows });
  }

  if (method === 'POST' && url === '/api/ratings') {
    try {
      const body = await parseBody(req);
      const user = await getAuthUser(req);
      if (!user) return sendJson(res, 401, { error: 'Authentication required' });
      if (!body.item_id || !body.rating) return sendJson(res, 400, { error: 'Missing rating data' });
      const existing = await get('SELECT id FROM ratings WHERE item_id = ? AND user_id = ?', [body.item_id, user.id]);
      if (existing) {
        await run('UPDATE ratings SET rating = ?, status = ? WHERE id = ?', [body.rating, 'pending', existing.id]);
        return sendJson(res, 200, { message: 'Rating updated and sent for moderation' });
      }
      await run('INSERT INTO ratings (item_id, user_id, rating, status) VALUES (?, ?, ?, ?)', [body.item_id, user.id, body.rating, 'pending']);
      return sendJson(res, 201, { message: 'Rating saved and pending moderation' });
    } catch (error) {
      return sendJson(res, 400, { error: error.message || 'Rating failed' });
    }
  }

  if (method === 'GET' && url === '/api/admin/stats') {
    const user = await getAuthUser(req);
    if (!user?.is_admin) return sendJson(res, 403, { error: 'Admin access required' });

    const pendingDownloads = await get("SELECT COUNT(*) as count FROM downloads WHERE status = 'pending'");
    const pendingRatings = await get("SELECT COUNT(*) as count FROM ratings WHERE status = 'pending'");
    const approvedDownloads = await get("SELECT COUNT(*) as count FROM downloads WHERE status = 'approved'");
    const approvedRatings = await get("SELECT COUNT(*) as count FROM ratings WHERE status = 'approved'");

    return sendJson(res, 200, {
      stats: {
        pendingDownloads: pendingDownloads.count,
        pendingRatings: pendingRatings.count,
        approvedDownloads: approvedDownloads.count,
        approvedRatings: approvedRatings.count
      }
    });
  }

  if (method === 'GET' && url === '/api/admin/moderation') {
    const user = await getAuthUser(req);
    if (!user?.is_admin) return sendJson(res, 403, { error: 'Admin access required' });

    const pendingDownloads = await all("SELECT * FROM downloads WHERE status = 'pending' ORDER BY id");
    const pendingRatings = await all("SELECT * FROM ratings WHERE status = 'pending' ORDER BY id");

    return sendJson(res, 200, { downloads: pendingDownloads, ratings: pendingRatings });
  }

  if (method === 'POST' && url.startsWith('/api/admin/moderation/downloads/')) {
    const user = await getAuthUser(req);
    if (!user?.is_admin) return sendJson(res, 403, { error: 'Admin access required' });

    const id = Number(url.split('/').pop());
    const body = await parseBody(req);
    const action = body.action === 'reject' ? 'rejected' : 'approved';
    await run('UPDATE downloads SET status = ? WHERE id = ?', [action, id]);
    return sendJson(res, 200, { message: `Download ${action}` });
  }

  if (method === 'POST' && url.startsWith('/api/admin/moderation/ratings/')) {
    const user = await getAuthUser(req);
    if (!user?.is_admin) return sendJson(res, 403, { error: 'Admin access required' });

    const id = Number(url.split('/').pop());
    const body = await parseBody(req);
    const action = body.action === 'reject' ? 'rejected' : 'approved';
    await run('UPDATE ratings SET status = ? WHERE id = ?', [action, id]);
    return sendJson(res, 200, { message: `Rating ${action}` });
  }

  if (method === 'POST' && url === '/api/ai/chat') {
    try {
      const body = await parseBody(req);
      const reply = `Thanks for asking: "${body.prompt || ''}". KielTech can help you turn this idea into a polished product experience.`;
      return sendJson(res, 200, { reply });
    } catch (error) {
      return sendJson(res, 400, { error: error.message || 'Invalid request' });
    }
  }

  if (method === 'POST' && url === '/api/contact') {
    try {
      const body = await parseBody(req);
      await sendEmail({
        to: process.env.EMAIL_TO || 'kieltech75@gmail.com',
        subject: 'New KielTech contact request',
        text: `Name: ${body.name || 'Unknown'}\nEmail: ${body.email || 'Unknown'}\nMessage: ${body.message || ''}`
      });
      return sendJson(res, 200, { message: `Thanks ${body.name || 'there'}! Your message has been received by KielTech.` });
    } catch (error) {
      return sendJson(res, 400, { error: error.message || 'Invalid request' });
    }
  }

  return sendJson(res, 404, { error: 'Not found' });
}

module.exports = { handleRoutes };
