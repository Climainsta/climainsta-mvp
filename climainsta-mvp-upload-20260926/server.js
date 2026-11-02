const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { google } = require('googleapis');
const Stripe = require('stripe');
const { Pool } = require('pg');

const roots = [__dirname, path.resolve(__dirname, '..'), path.resolve(__dirname, '..', '..')];
const candidates = roots.flatMap(root => [
  path.join(root, 'outputs', 'client.html'),
  path.join(root, 'client.html'),
  path.join(root, 'outputs', 'climainsta-mvp.html'),
  path.join(root, 'climainsta-mvp.html')
]);
const DATA_FILE = path.join(__dirname, 'climainsta-data.json');
let notices = [];
let technicians = [];
const technicianResponses = new Map();
try {
  if (fs.existsSync(DATA_FILE)) {
    const localData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    notices = localData.notices || [];
    technicians = localData.technicians || [];
  }
} catch (error) { console.error('[data] No se pudo cargar el almacenamiento local:', error.message); }
function persistData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify({ notices, technicians }, null, 2)); }
  catch (error) { console.error('[data] No se pudo guardar el aviso:', error.message); }
}
const databasePool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;
let databaseReady = Promise.resolve();
async function initializeDatabase() {
  if (!databasePool) return;
  await databasePool.query("CREATE TABLE IF NOT EXISTS climainsta_state (id INTEGER PRIMARY KEY, notices JSONB NOT NULL DEFAULT '[]')");
  await databasePool.query("CREATE TABLE IF NOT EXISTS climainsta_technicians (id TEXT PRIMARY KEY, data JSONB NOT NULL)");
  const result = await databasePool.query('SELECT notices FROM climainsta_state WHERE id = 1');
  if (result.rows[0]?.notices) notices = result.rows[0].notices;
  const technicianResult = await databasePool.query('SELECT data FROM climainsta_technicians ORDER BY data->>\'createdAt\' DESC');
  technicians = technicianResult.rows.map(row => row.data);
  console.log('[data] Base de datos Neon conectada');
}
async function persistDatabase() {
  if (!databasePool) return;
  await databasePool.query('INSERT INTO climainsta_state (id, notices) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET notices = EXCLUDED.notices', [JSON.stringify(notices)]);
  for (const technician of technicians) {
    await databasePool.query('INSERT INTO climainsta_technicians (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [technician.id, JSON.stringify(technician)]);
  }
}
function saveAllData() {
  persistData();
  persistDatabase().catch(error => console.error('[data] No se pudo guardar en Neon:', error.message));
}
databaseReady = initializeDatabase().catch(error => console.error('[data] No se pudo conectar a Neon:', error.message));
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
  const text = `Hola ${safeName},\n\nHemos encontrado un técnico para tu aviso de ${safeService} en ${safeTown}.\nTiempo estimado: ${winner.eta} minutos.\n\n${notice.paymentUrl ? `Paga y confirma aquí: ${notice.paymentUrl}` : 'En breve recibirás el enlace de pago para confirmar la reserva.'}\n\nLa tarifa de Climainsta cubre la gestión urgente del aviso, la localización y el envío del técnico y la primera inspección/diagnóstico inicial. Cualquier reparación, mantenimiento o pieza adicional será presupuestada y facturada directamente por el técnico o empresa colaboradora.\n\nClimainsta`;
  const html = `<!doctype html><html><body style="margin:0;background:#f3f8fa;font-family:Arial,sans-serif;color:#17324d"><div style="max-width:600px;margin:24px auto;background:#fff;border:1px solid #dce8ef;border-radius:16px;overflow:hidden"><div style="padding:22px;text-align:center;background:#fff"><img src="${logoUrl}" alt="Climainsta" style="width:280px;max-width:85%;height:auto"></div><div style="background:#087f8c;color:#fff;padding:24px 28px"><div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;opacity:.85">Aviso actualizado</div><h1 style="font-size:25px;margin:8px 0 0">¡Técnico encontrado!</h1></div><div style="padding:28px"><p>Hola ${safeName},</p><p>Hemos encontrado un técnico para tu aviso de <strong>${safeService}</strong> en <strong>${safeTown}</strong>.</p><div style="background:#eef8f7;border-radius:12px;padding:16px;margin:22px 0"><div style="font-size:12px;color:#688096">TIEMPO ESTIMADO DE LLEGADA</div><div style="font-size:26px;font-weight:700;color:#087f8c;margin-top:4px">${winner.eta} minutos</div></div>${paymentBlock}<p style="color:#526d80">La tarifa de Climainsta cubre únicamente la gestión urgente del aviso, la localización y el envío del técnico y la primera inspección/diagnóstico inicial. Cualquier reparación, mantenimiento o pieza adicional será presupuestada, contratada y facturada directamente por el técnico o empresa colaboradora.</p><div style="margin-top:26px;padding-top:18px;border-top:1px solid #dce8ef;font-size:12px;color:#688096">Aviso ${notice.id}<br>Climainsta · Tu técnico de clima, al instante.</div></div></div></body></html>`;
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

async function sendCustomerReceivedEmail(notice) {
  const gmail = gmailClient();
  if (!gmail || !notice.email) {
    console.error('[gmail] Confirmación inicial no configurada');
    return;
  }
  console.log('[gmail] Enviando confirmación inicial a', notice.email);
  const subject = `Climainsta · Hemos recibido tu aviso ${notice.id}`;
  const safeName = String(notice.name || '').replace(/[<>&]/g, '');
  const safeService = String(notice.service || '').replace(/[<>&]/g, '');
  const safeTown = String(notice.town || '').replace(/[<>&]/g, '');
  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://climainsta-mvp.onrender.com';
  const logoUrl = `${baseUrl}/LogoClimainsta2.png`;
  const text = `Hola ${safeName},\n\nHemos recibido tu aviso de ${safeService} en ${safeTown}. Estamos gestionando tu solicitud y buscando técnico.\n\nClimainsta`;
  const html = `<!doctype html><html><body style="margin:0;background:#f3f8fa;font-family:Arial,sans-serif;color:#17324d"><div style="max-width:600px;margin:24px auto;background:#fff;border:1px solid #dce8ef;border-radius:16px;overflow:hidden"><div style="padding:22px;text-align:center;background:#fff"><img src="${logoUrl}" alt="Climainsta" style="width:280px;max-width:85%;height:auto"></div><div style="background:#087f8c;color:#fff;padding:24px 28px"><div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;opacity:.85">Aviso recibido</div><h1 style="font-size:25px;margin:8px 0 0">Estamos gestionando tu solicitud</h1></div><div style="padding:28px"><p>Hola ${safeName},</p><p>Hemos recibido correctamente tu aviso de <strong>${safeService}</strong> en <strong>${safeTown}</strong>.</p><div style="background:#eef8f7;border-radius:12px;padding:16px;margin:22px 0;color:#087f8c;font-weight:700">Estamos buscando un técnico disponible para atenderte lo antes posible.</div><p style="color:#526d80">En cuanto encontremos un técnico, recibirás un segundo correo con el tiempo estimado y el enlace para confirmar y pagar la reserva.</p><div style="margin-top:26px;padding-top:18px;border-top:1px solid #dce8ef;font-size:12px;color:#688096">Aviso ${notice.id}<br>Climainsta · Tu técnico de clima, al instante.</div></div></div></body></html>`;
  const raw = [
    `From: ${process.env.GMAIL_USER}`,
    `To: ${notice.email}`,
    `Subject: ${encodeMimeWord(subject)}`,
    'Content-Type: multipart/alternative; boundary="climainsta_initial"',
    'MIME-Version: 1.0', '',
    '--climainsta_initial', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit', '', text,
    '--climainsta_initial', 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit', '', html,
    '--climainsta_initial--'
  ].join('\r\n');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodeMessage(raw) } });
  console.log('[gmail] Confirmación inicial enviada a', notice.email);
}

async function sendCustomerPaymentConfirmationEmail(notice) {
  const gmail = gmailClient();
  if (!gmail || !notice.email) {
    console.error('[gmail] Confirmación de pago no configurada');
    return;
  }
  const subject = `Climainsta · Pago confirmado para tu aviso ${notice.id}`;
  const safeName = String(notice.name || '').replace(/[<>&]/g, '');
  const safeService = String(notice.service || '').replace(/[<>&]/g, '');
  const safeTown = String(notice.town || '').replace(/[<>&]/g, '');
  const safeTechnician = String(notice.technician?.name || 'nuestro técnico asignado').replace(/[<>&]/g, '');
  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://climainsta-mvp.onrender.com';
  const logoUrl = `${baseUrl}/LogoClimainsta2.png`;
  const text = `Hola ${safeName},\n\nHemos confirmado el pago de tu aviso ${notice.id}. El técnico ${safeTechnician} ya ha recibido los datos completos y se pondrá en contacto contigo.\n\nServicio: ${safeService}\nZona: ${safeTown}\nTécnico asignado: ${safeTechnician}\n\nClimainsta`;
  const html = `<!doctype html><html><body style="margin:0;background:#f3f8fa;font-family:Arial,sans-serif;color:#17324d"><div style="max-width:600px;margin:24px auto;background:#fff;border:1px solid #dce8ef;border-radius:16px;overflow:hidden"><div style="padding:18px;text-align:center;background:#fff"><img src="${logoUrl}" alt="Climainsta" style="width:360px;max-width:95%;height:auto"></div><div style="background:#087f8c;color:#fff;padding:24px 28px"><div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;opacity:.85">Pago confirmado</div><h1 style="font-size:25px;margin:8px 0 0">¡Reserva confirmada!</h1></div><div style="padding:28px"><p>Hola ${safeName},</p><p>Hemos confirmado correctamente el pago de tu aviso.</p><div style="background:#eef8f7;border-radius:12px;padding:16px;margin:22px 0"><div style="font-size:12px;color:#688096">AVISO</div><div style="font-size:22px;font-weight:700;color:#087f8c;margin-top:4px">${notice.id}</div><div style="margin-top:10px">${safeService} · ${safeTown}</div></div><div style="background:#fff7e8;border-left:4px solid #f39a3d;border-radius:8px;padding:14px 16px;margin:20px 0"><div style="font-size:12px;color:#688096;text-transform:uppercase">Técnico asignado</div><div style="font-size:20px;font-weight:700;color:#17324d;margin-top:5px">${safeTechnician}</div></div><p style="color:#526d80">El técnico ya ha recibido los datos completos y se pondrá en contacto contigo para coordinar el servicio.</p><div style="margin-top:26px;padding-top:18px;border-top:1px solid #dce8ef;font-size:12px;color:#688096">Climainsta · Tu técnico de clima, al instante.</div></div></div></body></html>`;
  const raw = [
    `From: ${process.env.GMAIL_USER}`,
    `To: ${notice.email}`,
    `Subject: ${encodeMimeWord(subject)}`,
    'Content-Type: multipart/alternative; boundary="climainsta_payment"',
    'MIME-Version: 1.0', '',
    '--climainsta_payment', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit', '', text,
    '--climainsta_payment', 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit', '', html,
    '--climainsta_payment--'
  ].join('\r\n');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodeMessage(raw) } });
  console.log('[gmail] Confirmación de pago enviada a', notice.email);
}

async function sendCustomerSatisfactionEmail(notice) {
  const gmail = gmailClient();
  if (!gmail || !notice.email) {
    console.error('[gmail] Encuesta de satisfacción no configurada');
    return;
  }
  const subject = `Climainsta · ¿Qué tal ha sido tu servicio? ${notice.id}`;
  const safeName = String(notice.name || '').replace(/[<>&]/g, '');
  const safeService = String(notice.service || '').replace(/[<>&]/g, '');
  const safeTechnician = String(notice.technician?.name || 'el técnico').replace(/[<>&]/g, '');
  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://climainsta-mvp.onrender.com';
  const logoUrl = `${baseUrl}/LogoClimainsta2.png`;
  const googleReviewUrl = process.env.GOOGLE_REVIEW_URL || baseUrl;
  const stars = [1, 2, 3, 4, 5].map(rating => `<a href="${baseUrl}/valoracion?notice_id=${encodeURIComponent(notice.id)}&rating=${rating}" style="display:inline-block;font-size:28px;text-decoration:none;color:#f39a3d;margin:0 3px">★</a>`).join('');
  const text = `Hola ${safeName},\n\nEl trabajo de ${safeTechnician} para tu aviso ${notice.id} figura como terminado. Nos gustaría conocer tu experiencia: ${baseUrl}/valoracion?notice_id=${encodeURIComponent(notice.id)}\n\nGracias por confiar en Climainsta.`;
  const html = `<!doctype html><html><body style="margin:0;background:#f3f8fa;font-family:Arial,sans-serif;color:#17324d"><div style="max-width:600px;margin:24px auto;background:#fff;border:1px solid #dce8ef;border-radius:16px;overflow:hidden"><div style="padding:18px;text-align:center;background:#fff"><img src="${logoUrl}" alt="Climainsta" style="width:360px;max-width:95%;height:auto"></div><div style="background:#087f8c;color:#fff;padding:24px 28px"><div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;opacity:.85">Servicio finalizado</div><h1 style="font-size:25px;margin:8px 0 0">¿Qué tal ha ido?</h1></div><div style="padding:28px"><p>Hola ${safeName},</p><p>El técnico <strong>${safeTechnician}</strong> ha indicado que ha terminado el servicio de <strong>${safeService}</strong>.</p><p>Tu opinión nos ayuda a mejorar y a reconocer el trabajo de nuestros técnicos.</p><div style="text-align:center;margin:24px 0">${stars}</div><p style="text-align:center;margin:0 0 24px;color:#688096;font-size:13px">Selecciona una valoración de 1 a 5 estrellas</p><p style="text-align:center"><a href="${googleReviewUrl}" style="display:inline-block;background:#f39a3d;color:#fff;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:9px">Valorar en Google</a></p><div style="margin-top:26px;padding-top:18px;border-top:1px solid #dce8ef;font-size:12px;color:#688096">Aviso ${notice.id}<br>Climainsta · Tu técnico de clima, al instante.</div></div></div></body></html>`;
  const raw = [
    `From: ${process.env.GMAIL_USER}`,
    `To: ${notice.email}`,
    `Subject: ${encodeMimeWord(subject)}`,
    'Content-Type: multipart/alternative; boundary="climainsta_satisfaction"',
    'MIME-Version: 1.0', '',
    '--climainsta_satisfaction', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit', '', text,
    '--climainsta_satisfaction', 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit', '', html,
    '--climainsta_satisfaction--'
  ].join('\r\n');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodeMessage(raw) } });
  console.log('[gmail] Encuesta de satisfacción enviada a', notice.email);
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
    saveAllData();
    console.log('[selection] Sin respuestas para', noticeId);
    return;
  }
  responses.sort((a, b) => a.eta - b.eta || a.createdAt.localeCompare(b.createdAt));
  const winner = responses[0];
  notice.status = 'technician_selected';
  notice.technician = winner.technician;
  notice.eta = winner.eta;
  saveAllData();
  console.log('[selection] Técnico seleccionado:', noticeId, winner.eta, 'min');
  console.log('[gmail] Preparando email a:', notice.email || '(sin email)');
  (async()=>{
    notice.paymentUrl = await createStripeCheckout(notice);
    saveAllData();
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

function rawBodyOf(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function page(title, message) {
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="margin:0;background:#f3f8fa;font-family:Arial,sans-serif;color:#17324d"><main style="max-width:560px;margin:70px auto;background:#fff;border:1px solid #dce8ef;border-radius:18px;padding:36px;text-align:center"><h1 style="color:#087f8c">${title}</h1><p style="font-size:16px;line-height:1.6">${message}</p></main></body></html>`;
}

function adminAuthorized(req) {
  const configured = String(process.env.ADMIN_PANEL_TOKEN || '').trim();
  const provided = String(req.headers['x-admin-token'] || '').trim();
  return Boolean(configured && provided && provided === configured);
}

function buildAdminDashboard() {
  const statusCounts = notices.reduce((result, notice) => {
    result[notice.status || 'unknown'] = (result[notice.status || 'unknown'] || 0) + 1;
    return result;
  }, {});
  const technicianStats = new Map(technicians.map(technician => [String(technician.id), { ...technician, jobs: 0, paid: 0, completed: 0, totalEta: 0 }]));
  for (const notice of notices) {
    const technician = notice.technician;
    if (!technician?.id) continue;
    const key = String(technician.id);
    const current = technicianStats.get(key) || { id: technician.id, name: technician.name || 'Técnico', jobs: 0, paid: 0, completed: 0, totalEta: 0 };
    current.jobs += 1;
    if (notice.status === 'paid' || notice.status === 'completed') current.paid += 1;
    if (notice.status === 'completed') current.completed += 1;
    if (Number(notice.eta)) current.totalEta += Number(notice.eta);
    technicianStats.set(key, current);
  }
  const etaValues = notices.map(item => Number(item.eta)).filter(Boolean);
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalNotices: notices.length,
      searching: statusCounts.searching || 0,
      assigned: statusCounts.technician_selected || 0,
      paid: statusCounts.paid || 0,
      completed: statusCounts.completed || 0,
      noResponse: statusCounts.no_technician_response || 0,
      averageEta: etaValues.length ? Math.round(etaValues.reduce((a, b) => a + b, 0) / etaValues.length) : 0
    },
    technicians: [...technicianStats.values()].map(item => ({ ...item, averageEta: item.jobs ? Math.round(item.totalEta / item.jobs) : 0 })),
    notices: notices.map(notice => ({ ...notice, paymentUrl: undefined }))
  };
}

const server = http.createServer(async (req, res) => {
  await databaseReady;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/') {
    const file = candidates.find(fs.existsSync);
    if (!file) return reply(res, 404, { error: 'Interfaz no encontrada' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(file));
  }
  if (req.method === 'GET' && url.pathname === '/admin') {
    const adminFile = roots.map(root => path.join(root, 'admin.html')).find(fs.existsSync) || roots.map(root => path.join(root, 'outputs', 'admin.html')).find(fs.existsSync);
    if (!adminFile) return reply(res, 404, { error: 'Panel de administración no encontrado' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(adminFile));
  }
  if (req.method === 'GET' && url.pathname === '/LogoClimainsta2.png') {
    const logo = roots.map(root => path.join(root, 'LogoClimainsta2.png')).find(fs.existsSync);
    if (!logo) return reply(res, 404, { error: 'Logo no encontrado' });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
    return res.end(fs.readFileSync(logo));
  }
  if (req.method === 'GET' && url.pathname === '/valoracion') {
    const rating = Number(url.searchParams.get('rating'));
    const googleReviewUrl = process.env.GOOGLE_REVIEW_URL || '/';
    const message = rating === 5
      ? `<h1>¡Gracias por tu valoración!</h1><p>Nos alegra saber que has quedado satisfecho. Si quieres, puedes compartir tu experiencia en Google.</p><p><a href="${googleReviewUrl}" style="display:inline-block;background:#f39a3d;color:#fff;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:9px">Dejar reseña en Google</a></p>`
      : `<h1>Gracias por responder</h1><p>Tu valoración nos ayuda a mejorar el servicio de Climainsta.</p>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Valoración · Climainsta</title></head><body style="margin:0;background:#f3f8fa;font-family:Arial,sans-serif;color:#17324d"><main style="max-width:560px;margin:60px auto;padding:32px;background:#fff;border:1px solid #dce8ef;border-radius:16px;text-align:center"><img src="/LogoClimainsta2.png" alt="Climainsta" style="width:320px;max-width:90%;height:auto">${message}<p style="color:#688096;font-size:13px">Climainsta · Tu técnico de clima, al instante.</p></main></body></html>`);
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return reply(res, 200, { ok: true, service: 'climainsta-mvp', telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN) });
  }
  if (req.method === 'GET' && url.pathname === '/pago-confirmado') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page('Pago recibido', 'Hemos recibido tu pago. El técnico se pondrá en contacto contigo para coordinar el servicio.'));
  }
  if (req.method === 'GET' && url.pathname === '/pago-cancelado') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page('Pago no completado', 'No se ha confirmado ningún cargo. Puedes volver al enlace de pago cuando estés preparado.'));
  }
  if (req.method === 'GET' && url.pathname === '/api/notices') return reply(res, 200, { notices });
  if (req.method === 'GET' && url.pathname === '/api/admin/dashboard') {
    if (!adminAuthorized(req)) return reply(res, 401, { ok: false, error: 'No autorizado' });
    return reply(res, 200, { ok: true, dashboard: buildAdminDashboard() });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/technicians') {
    if (!adminAuthorized(req)) return reply(res, 401, { ok: false, error: 'No autorizado' });
    try {
      const data = await bodyOf(req);
      const technician = {
        id: `TEC-${Date.now().toString().slice(-6)}`,
        type: data.type === 'empresa' ? 'empresa' : 'autonomo',
        name: String(data.name || '').trim(),
        company: String(data.company || '').trim(),
        taxId: String(data.taxId || '').trim(),
        phone: String(data.phone || '').trim(),
        email: String(data.email || '').trim().toLowerCase(),
        towns: String(data.towns || '').trim(),
        services: String(data.services || '').trim(),
        telegramId: String(data.telegramId || '').trim(),
        active: data.active !== false,
        createdAt: new Date().toISOString()
      };
      if (!technician.name || !technician.phone || !technician.email) return reply(res, 400, { ok: false, error: 'Nombre, teléfono y email son obligatorios' });
      technicians.push(technician);
      saveAllData();
      return reply(res, 201, { ok: true, technician });
    } catch { return reply(res, 400, { ok: false, error: 'Datos no válidos' }); }
  }
  if (req.method === 'PATCH' && url.pathname.startsWith('/api/admin/technicians/')) {
    if (!adminAuthorized(req)) return reply(res, 401, { ok: false, error: 'No autorizado' });
    const technicianId = decodeURIComponent(url.pathname.split('/').pop());
    const technician = technicians.find(item => item.id === technicianId);
    if (!technician) return reply(res, 404, { ok: false, error: 'Técnico no encontrado' });
    try {
      const data = await bodyOf(req);
      for (const key of ['type', 'name', 'company', 'taxId', 'phone', 'email', 'towns', 'services', 'telegramId']) {
        if (data[key] !== undefined) technician[key] = String(data[key]).trim();
      }
      if (data.active !== undefined) technician.active = Boolean(data.active);
      saveAllData();
      return reply(res, 200, { ok: true, technician });
    } catch { return reply(res, 400, { ok: false, error: 'Datos no válidos' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/notices') {
    try {
      const data = await bodyOf(req);
      const notice = { id: `CL-${Date.now().toString().slice(-6)}`, ...data, status: 'searching', createdAt: new Date().toISOString() };
    notices.push(notice);
    saveAllData();
    try {
      await sendCustomerReceivedEmail(notice);
    } catch (error) {
      console.error('[gmail inicial]', error.message);
    }
      let telegram = { sent: false, reason: 'not_attempted' };
      try { telegram = await sendTelegramNotice(notice); } catch (error) { telegram = { sent: false, reason: 'telegram_error' }; console.error('[telegram]', error.message); }
      return reply(res, 201, { ok: true, notice, telegram });
    } catch { return reply(res, 400, { ok: false, error: 'JSON no válido' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/stripe/webhook') {
    try {
      const payload = await rawBodyOf(req);
      const signature = req.headers['stripe-signature'];
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!secret) return reply(res, 500, { ok: false, error: 'STRIPE_WEBHOOK_SECRET no configurado' });
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY.trim());
      const event = stripe.webhooks.constructEvent(payload, signature, secret);
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const notice = notices.find(item => item.id === session.metadata?.notice_id);
        if (notice) {
          notice.status = 'paid';
          notice.paidAt = new Date().toISOString();
          saveAllData();
          const destination = process.env.TELEGRAM_TECHNICIANS_CHAT_ID;
          const telegramResult = await telegramApi('sendMessage', { chat_id: destination, text: `💳 PAGO CONFIRMADO\nAviso: ${notice.id}\nCliente: ${notice.name}\nTeléfono: ${notice.phone}\nZona: ${notice.town}\nDirección: ${notice.address}\nServicio: ${notice.service}\nDetalles: ${notice.details}`, reply_markup: { inline_keyboard: [[{ text: '✅ Marcar trabajo terminado', callback_data: `finish:${notice.id}` }]] } });
          console.log('[telegram] Datos completos enviados al grupo:', telegramResult?.ok === true);
          await sendCustomerPaymentConfirmationEmail(notice);
          console.log('[stripe] Pago confirmado para', notice.id);
        }
      }
      return reply(res, 200, { received: true });
    } catch (error) {
      console.error('[stripe webhook]', error.message);
      return reply(res, 400, { ok: false, error: 'Webhook Stripe no válido' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/telegram/webhook') {
    try {
      const update = await bodyOf(req);
      const callback = update.callback_query;
      if (callback?.data?.startsWith('finish:')) {
        const [, noticeId] = callback.data.split(':');
        const notice = notices.find(item => item.id === noticeId);
        if (notice && notice.status === 'paid') {
          notice.status = 'completed';
          notice.completedAt = new Date().toISOString();
          saveAllData();
          await telegramApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Trabajo marcado como terminado' });
          await telegramApi('editMessageReplyMarkup', { chat_id: callback.message?.chat?.id, message_id: callback.message?.message_id, reply_markup: { inline_keyboard: [] } });
          try { await sendCustomerSatisfactionEmail(notice); } catch (error) { console.error('[gmail satisfacción]', error.message); }
          console.log('[completion] Trabajo terminado:', noticeId);
        } else {
          await telegramApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Este aviso no está pendiente de finalizar.' });
        }
      } else if (callback?.data?.startsWith('eta:')) {
        const [, noticeId, etaText] = callback.data.split(':');
        const eta = Number(etaText);
        const notice = notices.find(item => item.id === noticeId);
        console.log('[telegram webhook] Respuesta recibida para', noticeId, eta, 'min; aviso encontrado:', Boolean(notice));
        if (notice && notice.status === 'searching' && [15, 30, 45, 60].includes(eta)) {
          const responses = technicianResponses.get(noticeId) || [];
          if (!responses.some(item => item.technician.id === callback.from?.id)) {
            const responseRecord = { eta, createdAt: new Date().toISOString(), technician: {
              id: callback.from?.id, name: [callback.from?.first_name, callback.from?.last_name].filter(Boolean).join(' ') || 'Técnico'
            }};
            responses.push(responseRecord);
            notice.technicianResponses = responses;
            saveAllData();
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
