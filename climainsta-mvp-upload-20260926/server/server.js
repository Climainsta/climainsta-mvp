const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC_FILE = path.join(ROOT, 'outputs', 'climainsta-mvp.html');
const PORT = Number(process.env.PORT || 3000);
const notices = [];

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1_000_000) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function connectionStatus() {
  return {
    database: { status: 'demo', label: 'Base de datos local' },
    telegram: { status: process.env.TELEGRAM_BOT_TOKEN ? 'configured' : 'pending', label: 'Telegram' },
    stripe: { status: process.env.STRIPE_SECRET_KEY ? 'configured' : 'pending', label: 'Stripe' },
    email: { status: process.env.MAIL_FROM ? 'configured' : 'pending', label: 'Correo' }
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/') {
    if (!fs.existsSync(PUBLIC_FILE)) return json(res, 404, { error: 'Prototipo no encontrado' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(PUBLIC_FILE));
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'climainsta-mvp', connections: connectionStatus() });
  }

  if (req.method === 'GET' && url.pathname === '/api/notices') {
    return json(res, 200, { notices });
  }

  if (req.method === 'POST' && url.pathname === '/api/notices') {
    try {
      const body = await readBody(req);
      const notice = {
        id: `CL-${Date.now().toString().slice(-6)}`,
        name: body.name || '', phone: body.phone || '', email: body.email || '',
        town: body.town || '', service: body.service || '', details: body.details || '',
        price: body.price || '69 €', status: 'searching', createdAt: new Date().toISOString()
      };
      notices.push(notice);
      return json(res, 201, { ok: true, notice });
    } catch {
      return json(res, 400, { ok: false, error: 'JSON no válido' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/telegram/webhook') {
    try {
      const update = await readBody(req);
      console.log('[telegram webhook]', update.callback_query ? 'callback recibido' : 'actualización recibida');
      return json(res, 200, { ok: true });
    } catch {
      return json(res, 400, { ok: false, error: 'Actualización no válida' });
    }
  }

  return json(res, 404, { error: 'Ruta no encontrada' });
});

server.listen(PORT, () => console.log(`Climainsta MVP escuchando en http://localhost:${PORT}`));
