const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const roots = [__dirname, path.resolve(__dirname, '..'), path.resolve(__dirname, '..', '..')];
const candidates = roots.flatMap(root => [
  path.join(root, 'outputs', 'climainsta-mvp.html'),
  path.join(root, 'climainsta-mvp.html')
]);
const notices = [];
const PORT = Number(process.env.PORT || 3000);

async function sendTelegramNotice(notice) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_TECHNICIANS_CHAT_ID;
  if (!token || !chatId) return { sent: false, reason: 'telegram_not_configured' };
  const text = [
    '🚨 NUEVO AVISO DE TRABAJO 🚨',
    `📍 Zona: ${notice.town}`,
    `🔧 Servicio: ${notice.service}`,
    `📝 Avería / Detalles: ${notice.details}`,
    '',
    'Elige el tiempo estimado para gestionar el aviso. Durante 30 segundos se compararán las respuestas.'
  ].join('\n');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, reply_markup: { inline_keyboard: [[
      { text: '15 min', callback_data: `eta:${notice.id}:15` },
      { text: '30 min', callback_data: `eta:${notice.id}:30` },
      { text: '45 min', callback_data: `eta:${notice.id}:45` },
      { text: '60 min', callback_data: `eta:${notice.id}:60` }
    ]] } })
  });
  const result = await response.json();
  return { sent: Boolean(result.ok), messageId: result.result?.message_id || null };
}

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function bodyOf(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/') {
    const file = candidates.find(fs.existsSync);
    if (!file) return reply(res, 404, { error: 'Interfaz no encontrada' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(file));
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return reply(res, 200, { ok: true, service: 'climainsta-mvp', telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN) });
  }
  if (req.method === 'GET' && url.pathname === '/api/notices') return reply(res, 200, { notices });
  if (req.method === 'POST' && url.pathname === '/api/notices') {
    try {
      const data = await bodyOf(req);
      const notice = { id: `CL-${Date.now().toString().slice(-6)}`, ...data, status: 'searching', createdAt: new Date().toISOString() };
      notices.push(notice);
      let telegram = { sent: false, reason: 'not_attempted' };
      try { telegram = await sendTelegramNotice(notice); } catch (error) { telegram = { sent: false, reason: 'telegram_error' }; console.error('[telegram]', error.message); }
      return reply(res, 201, { ok: true, notice, telegram });
    } catch { return reply(res, 400, { ok: false, error: 'JSON no válido' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/telegram/webhook') {
    try { const update = await bodyOf(req); console.log('[telegram webhook]', update.callback_query ? 'callback recibido' : 'actualización recibida'); return reply(res, 200, { ok: true }); }
    catch { return reply(res, 400, { ok: false, error: 'Actualización no válida' }); }
  }
  return reply(res, 404, { error: 'Ruta no encontrada' });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Climainsta MVP escuchando en el puerto ${PORT}`));
