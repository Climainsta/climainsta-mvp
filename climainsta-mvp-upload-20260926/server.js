const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { google } = require('googleapis');
const Stripe = require('stripe');

const roots = [__dirname, path.resolve(__dirname, '..'), path.resolve(__dirname, '..', '..')];
const candidates = roots.flatMap(root => [
  path.join(root, 'outputs', 'climainsta-mvp.html'),
  path.join(root, 'climainsta-mvp.html')
]);
const DATA_FILE = path.join(__dirname, 'climainsta-data.json');
let notices = [];
const technicianResponses = new Map();
try {
  if (fs.existsSync(DATA_FILE)) notices = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).notices || [];
} catch (error) { console.error('[data] No se pudo cargar el almacenamiento local:', error.message); }
function persistData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify({ notices }, null, 2)); }
  catch (error) { console.error('[data] No se pudo guardar el aviso:', error.message); }
}
const PORT = Number(process.env.PORT || 3000);

function gmailClient() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) return null;
  const oauth2 = new google.auth.OAuth2(GMAIL_CLIENT_ID.trim(), GMAIL_CLIENT_SECRET.trim());
  oauth2.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN.trim() });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

function encodeMessage(message) {
  return Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeMimeWord(value) {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

async function sendCustomerAssignmentEmail(notice, winner) {
  const gmail = gmailClient();
  if (!gmail || !notice.email) {
    console.error('[gmail] Gmail API no configurada o el aviso no tiene email de cliente');
    return { sent: false, reason: 'gmail_api_not_configured' };
  }
  const subject = `Climainsta · Técnico encontrado para tu aviso ${notice.id}`;
  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://climainsta-mvp.onrender.com';
  const logoUrl = `${baseUrl}/LogoClimainsta2.png`;
  const safeName = String(notice.name || '').replace(/[<>&]/g, '');
  const safeService = String(notice.service || '').replace(/[<>&]/g, '');
  const safeTown = String(notice.town || '').replace(/[<>&]/g, '');
  const paymentBlock = notice.paymentUrl ? `<p style="text-align:center;margin:28px 0"><a href="${notice.paymentUrl}" style="display:inline-block;background:#f39a3d;color:#fff;text-decoration:none;font-weight:700;padding:14px 24px;border-radius:9px">Pagar y confirmar reserva</a></p><p style="text-align:center;font-size:12px;color:#688096">Dispones de 7 minutos para confirmar el aviso.</p>` : '<p style="color:#a9681f">El enlace de pago se generará cuando Stripe esté configurado.</p>';
  const text = `Hola ${safeName},\n\nHemos encontrado un técnico para tu aviso de ${safeService} en ${safeTown}.\nTiempo estimado: ${winner.eta} minutos.\n\n${notice.paymentUrl ? `Paga y confirma aquí: ${notice.paymentUrl}` : 'En breve recibirás el enlace de pago para confirmar la reserva.'}\n\nClimainsta`;
  const html = `<!doctype html><html><body style="margin:0;background:#f3f8fa;font-family:Arial,sans-serif;color:#17324d"><div style="max-width:600px;margin:24px auto;background:#fff;border:1px solid #dce8ef;border-radius:16px;overflow:hidden"><div style="padding:22px;text-align:center;background:#fff"><img src="${logoUrl}" alt="Climainsta" style="width:280px;max-width:85%;height:auto"></div><div style="background:#087f8c;color:#fff;padding:24px 28px"><div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;opacity:.85">Aviso actualizado</div><h1 style="font-size:25px;margin:8px 0 0">¡Técnico encontrado!</h1></div><div style="padding:28px"><p>Hola ${safeName},</p><p>Hemos encontrado un técnico para tu aviso de <strong>${safeService}</strong> en <strong>${safeTown}</strong>.</p><div style="background:#eef8f7;border-radius:12px;padding:16px;margin:22px 0"><div style="font-size:12px;color:#688096">TIEMPO ESTIMADO DE LLEGADA</div><div style="font-size:26px;font-weight:700;color:#087f8c;margin-top:4px">${winner.eta} minutos</div></div>${paymentBlock}<p style="color:#526d80">La tarifa cubre la gestión urgente, el desplazamiento y el diagnóstico inicial; cualquier reparación o pieza adicional se presupuestará aparte por el técnico.</p><div style="margin-top:26px;padding-top:18px;border-top:1px solid #dce8ef;font-size:12px;color:#688096">Aviso ${notice.id}<br>Climainsta · Tu técnico de clima, al instante.</div></div></div></body></html>`;
  const raw = [
    `From: ${process.env.GMAIL_USER}`,
    `To: ${notice.email}`,
    `Subject: ${encodeMimeWord(subject)}`,
    'Content-Type: multipart/alternative; boundary="climainsta_boundary"',
    'MIME-Version: 1.0', '',
    '--climainsta_boundary', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit', '', text,
    '--climainsta_boundary', 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit', '', html,
    '--climainsta_boundary--'
  ].join('\r\n');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodeMessage(raw) } });
  console.log('[gmail] Email enviado a', notice.email);
  return { sent: true };
}

async function createStripeCheckout(notice) {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.log('[stripe] STRIPE_SECRET_KEY no configurada');
    return null;
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY.trim());
  const amount = String(notice.price || '').includes('75') ? 7500 : 6900;
  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://climainsta-mvp.onrender.com';
  const session = await stripe.checkout.sessions.create({
    mode: 'payment', customer_email: notice.email,
    line_items: [{ price_data: { currency: 'eur', product_data: { name: `Aviso Climainsta · ${notice.service}` }, unit_amount: amount }, quantity: 1 }],
    metadata: { notice_id: notice.id },
    success_url: `${baseUrl}/pago-confirmado?notice_id=${notice.id}`,
    cancel_url: `${baseUrl}/pago-cancelado?notice_id=${notice.id}`
  });
  console.log('[stripe] Checkout creado para', notice.id);
  return session.url;
}

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

async function telegramApi(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  });
  return response.json();
}

function closeTechnicianWindow(noticeId) {
  const notice = notices.find(item => item.id === noticeId);
  const responses = technicianResponses.get(noticeId) || [];
  if (!notice) { console.error('[selection] Aviso no encontrado:', noticeId); return; }
  if (notice.status !== 'searching') { console.log('[selection] Aviso ya procesado:', noticeId, notice.status); return; }
  if (!responses.length) {
    notice.status = 'no_technician_response';
    persistData();
    console.log('[selection] Sin respuestas para', noticeId);
    return;
  }
  responses.sort((a, b) => a.eta - b.eta || a.createdAt.localeCompare(b.createdAt));
  const winner = responses[0];
  notice.status = 'technician_selected';
  notice.technician = winner.technician;
  notice.eta = winner.eta;
  persistData();
  console.log('[selection] Técnico seleccionado:', noticeId, winner.eta, 'min');
  console.log('[gmail] Preparando email a:', notice.email || '(sin email)');
  (async()=>{
    notice.paymentUrl = await createStripeCheckout(notice);
    persistData();
    await sendCustomerAssignmentEmail(notice, winner);
  })()
    .then(result => { notice.customerEmail = result; })
    .catch(error => { notice.customerEmail = { sent: false, reason: 'gmail_error' }; console.error('[gmail]', error.message); });
  telegramApi('sendMessage', {
    chat_id: process.env.TELEGRAM_TECHNICIANS_CHAT_ID,
    text: `✅ Técnico seleccionado para ${notice.id}\nTiempo estimado: ${winner.eta} min\nEl cliente puede continuar con el pago.`
  }).catch(error => console.error('[telegram selection]', error.message));
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
  if (req.method === 'GET' && url.pathname === '/LogoClimainsta2.png') {
    const logo = roots.map(root => path.join(root, 'LogoClimainsta2.png')).find(fs.existsSync);
    if (!logo) return reply(res, 404, { error: 'Logo no encontrado' });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
    return res.end(fs.readFileSync(logo));
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
      persistData();
      let telegram = { sent: false, reason: 'not_attempted' };
      try { telegram = await sendTelegramNotice(notice); } catch (error) { telegram = { sent: false, reason: 'telegram_error' }; console.error('[telegram]', error.message); }
      return reply(res, 201, { ok: true, notice, telegram });
    } catch { return reply(res, 400, { ok: false, error: 'JSON no válido' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/telegram/webhook') {
    try {
      const update = await bodyOf(req);
      const callback = update.callback_query;
      if (callback?.data?.startsWith('eta:')) {
        const [, noticeId, etaText] = callback.data.split(':');
        const eta = Number(etaText);
        const notice = notices.find(item => item.id === noticeId);
        console.log('[telegram webhook] Respuesta recibida para', noticeId, eta, 'min; aviso encontrado:', Boolean(notice));
        if (notice && notice.status === 'searching' && [15, 30, 45, 60].includes(eta)) {
          const responses = technicianResponses.get(noticeId) || [];
          if (!responses.some(item => item.technician.id === callback.from?.id)) {
            responses.push({ eta, createdAt: new Date().toISOString(), technician: {
              id: callback.from?.id, name: [callback.from?.first_name, callback.from?.last_name].filter(Boolean).join(' ') || 'Técnico'
            }});
            technicianResponses.set(noticeId, responses);
            setTimeout(() => closeTechnicianWindow(noticeId), 30000);
          }
          await telegramApi('answerCallbackQuery', { callback_query_id: callback.id, text: `Respuesta registrada: ${eta} minutos` });
        } else {
          await telegramApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Este aviso ya no está disponible.' });
        }
      }
      console.log('[telegram webhook]', callback ? 'callback recibido' : 'actualización recibida');
      return reply(res, 200, { ok: true });
    }
    catch { return reply(res, 400, { ok: false, error: 'Actualización no válida' }); }
  }
  return reply(res, 404, { error: 'Ruta no encontrada' });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Climainsta MVP escuchando en el puerto ${PORT}`));
