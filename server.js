'use strict';
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');

const env = process.env;
for (const k of ['WA_TOKEN', 'WA_PHONE_ID', 'WA_VERIFY_TOKEN', 'WA_APP_SECRET', 'ADMIN_PASS']) {
  if (!env[k]) { console.error(`Falta la variable de entorno ${k}`); process.exit(1); }
}
const APP_TZ = env.APP_TZ || 'Europe/Madrid';
const ADMIN_USER = env.ADMIN_USER || 'admin';
const PORT = env.PORT || 3000;
const DB_FILE = env.DB_PATH ? env.DB_PATH.replace('.db', '.json') : './fichaje.json';

/* ---------- Base de datos en JSON local (Sin dependencias nativas) ---------- */
function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = { employees: {}, records: [], registering: {} };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { employees: {}, records: [], registering: {} };
  }
}

function saveDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const db = {
  getEmp(phone) {
    const d = loadDb();
    const emp = d.employees[phone];
    return (emp && emp.active) ? emp : null;
  },
  getAllEmp() {
    const d = loadDb();
    return Object.values(d.employees).sort((a, b) => a.name.localeCompare(b.name));
  },
  upsertEmp(phone, name) {
    const d = loadDb();
    d.employees[phone] = { phone, name, active: 1 };
    saveDb(d);
  },
  toggleEmp(phone) {
    const d = loadDb();
    if (d.employees[phone]) {
      d.employees[phone].active = 1 - d.employees[phone].active;
      saveDb(d);
    }
  },
  getLastRecord(phone) {
    const d = loadDb();
    const userRecs = d.records.filter(r => r.phone === phone);
    return userRecs.length ? userRecs[userRecs.length - 1] : null;
  },
  getSince(phone, isoDate) {
    const d = loadDb();
    return d.records.filter(r => r.phone === phone && r.ts >= isoDate);
  },
  getAllSince(isoDate) {
    const d = loadDb();
    return d.records
      .filter(r => r.ts >= isoDate)
      .map(r => ({ ...r, name: d.employees[r.phone]?.name || r.phone }))
      .reverse();
  },
  addRecord(phone, type, ts, source = 'whatsapp') {
    const d = loadDb();
    d.records.push({ id: Date.now(), phone, type, ts, source });
    saveDb(d);
  },
  setRegistering(phone) {
    const d = loadDb();
    d.registering[phone] = true;
    saveDb(d);
  },
  isRegistering(phone) {
    const d = loadDb();
    return !!d.registering[phone];
  },
  delRegistering(phone) {
    const d = loadDb();
    delete d.registering[phone];
    saveDb(d);
  }
};

/* ---------- Utilidades de fecha ---------- */
const LBL = { in: 'Entrada', pause: 'Pausa', resume: 'Vuelta de pausa', out: 'Salida' };
const localDate = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: APP_TZ });
const fmtTime = ts => new Date(ts).toLocaleTimeString('es-ES', { timeZone: APP_TZ, hour: '2-digit', minute: '2-digit' });
const fmtDur = ms => { const m = Math.floor(ms / 60000); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const hoursAgo = h => new Date(Date.now() - h * 3600e3).toISOString();

function todayRecords(phone) {
  const today = localDate(Date.now());
  return db.getSince(phone, hoursAgo(36)).filter(r => localDate(r.ts) === today);
}
function worked(recs) {
  let total = 0, start = null;
  for (const r of recs) {
    const t = Date.parse(r.ts);
    if (r.type === 'in' || r.type === 'resume') start = t;
    else if (start !== null) { total += t - start; start = null; }
  }
  if (start !== null) total += Date.now() - start;
  return total;
}
const stateOf = phone => (db.getLastRecord(phone) || { type: 'out' }).type;

/* ---------- Lógica de fichaje ---------- */
const ALLOWED = { in: ['out'], pause: ['in', 'resume'], resume: ['pause'], out: ['in', 'resume'] };
const WHY = {
  in: 'Ya tienes la jornada iniciada.',
  pause: 'Solo puedes pausar con la jornada en marcha.',
  resume: 'No estás en pausa.',
  out: 'No hay una jornada en marcha que cerrar.',
};

function clock(phone, type) {
  if (!ALLOWED[type].includes(stateOf(phone))) return { ok: false, msg: `⚠️ ${WHY[type]}` };
  const ts = new Date().toISOString();
  db.addRecord(phone, type, ts, 'whatsapp');
  let msg = `✅ ${LBL[type]} registrada a las ${fmtTime(ts)}.`;
  if (type === 'in') msg += '\n¡Buena jornada! ☀️';
  if (type === 'out') msg += `\nHoy has trabajado ${fmtDur(worked(todayRecords(phone)))}. ¡Buen descanso! 👋`;
  return { ok: true, msg };
}

function parseCommand(text) {
  const t = text.toLowerCase();
  if (/vuelv|reanud|retomo/.test(t)) return 'resume';
  if (/pausa|descanso|café|cafe|comer/.test(t)) return 'pause';
  if (/salida|salgo|me voy|fin de jornada/.test(t)) return 'out';
  if (/entrada|entro|empiezo|llego/.test(t)) return 'in';
  if (/hora|resumen|cuánto|cuanto/.test(t)) return 'hours';
  return 'menu';
}

/* ---------- WhatsApp Cloud API ---------- */
async function wa(body) {
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${env.WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
    });
    if (!r.ok) console.error('Error WhatsApp', r.status, await r.text());
  } catch (e) { console.error('Error de red con WhatsApp', e.message); }
}
const sendText = (to, text) => wa({ to, type: 'text', text: { body: text } });

function sendMenu(to, text) {
  const s = stateOf(to);
  const btns = s === 'out' ? [['in', 'Entrada']]
    : s === 'pause' ? [['resume', 'Vuelvo']]
    : [['pause', 'Pausa'], ['out', 'Salida']];
  btns.push(['hours', 'Mis horas']);
  return wa({
    to, type: 'interactive',
    interactive: {
      type: 'button', body: { text },
      action: { buttons: btns.map(([id, title]) => ({ type: 'reply', reply: { id, title } })) },
    },
  });
}

async function handleMessage(msg) {
  const from = msg.from;
  let emp = db.getEmp(from);

  if (!emp) {
    const isRegistering = db.isRegistering(from);
    const textBody = msg.type === 'text' ? (msg.text.body || '').trim() : '';

    if (!isRegistering) {
      db.setRegistering(from);
      return sendText(from, '👋 ¡Hola! Bienvenido al sistema de fichaje por WhatsApp.\n\nPara empezar, por favor **escribe tu Nombre y Apellidos** para dar de alta tu perfil automáticamente:');
    } else {
      if (textBody.length < 2) {
        return sendText(from, '⚠️ Por favor, escribe un nombre y apellidos válidos para continuar.');
      }
      db.upsertEmp(from, textBody);
      db.delRegistering(from);
      
      sendText(from, `✅ ¡Perfecto, ${textBody}! Ya estás registrado en el sistema.`);
      return sendMenu(from, '¿Qué deseas registrar ahora?');
    }
  }

  let cmd = 'menu';
  if (msg.type === 'text') cmd = parseCommand(msg.text.body || '');
  else if (msg.type === 'interactive' && msg.interactive.button_reply) cmd = msg.interactive.button_reply.id;

  if (cmd === 'hours') {
    const recs = todayRecords(from);
    return sendMenu(from, `⏱ Hoy llevas ${fmtDur(worked(recs))} trabajadas (${recs.length} registros).`);
  }
  if (ALLOWED[cmd]) {
    if (!ALLOWED[cmd].includes(stateOf(from))) return sendMenu(from, `⚠️ ${WHY[cmd]}`);
    return sendMenu(from, clock(from, cmd).msg);
  }
  return sendMenu(from, `Hola, ${emp.name.split(' ')[0]} 👋 ¿Qué quieres registrar?`);
}

/* ---------- App Express ---------- */
const app = express();
app.disable('x-powered-by');

app.get('/health', (_req, res) => res.send('ok'));

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === env.WA_VERIFY_TOKEN) {
    return res.type('text/plain').status(200).send(String(req.query['hub.challenge'] || ''));
  }
  res.sendStatus(403);
});

app.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const sig = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', env.WA_APP_SECRET).update(req.body).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);
  res.sendStatus(200);

  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); } catch { return; }
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      for (const msg of (change.value && change.value.messages) || []) {
        handleMessage(msg).catch(e => console.error('Error procesando mensaje', e));
      }
    }
  }
});

/* ---------- Panel de administración ---------- */
const safeEq = (a, b) => {
  const h = x => crypto.createHash('sha256').update(String(x)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
};
function auth(req, res, next) {
  const [type, val] = (req.get('authorization') || '').split(' ');
  if (type === 'Basic' && val) {
    const [u, ...p] = Buffer.from(val, 'base64').toString().split(':');
    if (safeEq(u, ADMIN_USER) && safeEq(p.join(':'), env.ADMIN_PASS)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="FichaChat"').sendStatus(401);
}
app.use('/admin', auth, express.urlencoded({ extended: false }));

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

app.get('/admin', (_req, res) => {
  const today = localDate(Date.now());
  const emps = db.getAllEmp();
  const log = db.getAllSince(hoursAgo(36)).filter(r => localDate(r.ts) === today);

  const summary = emps.map(e => {
    const recs = todayRecords(e.phone);
    const first = recs.find(r => r.type === 'in');
    const st = { in: 'Trabajando', resume: 'Trabajando', pause: 'En pausa', out: recs.length ? 'Jornada cerrada' : 'Sin fichar' }[stateOf(e.phone)];
    return `<tr>
      <td>${esc(e.name)}${e.active ? '' : ' <em>(baja)</em>'}</td>
      <td>+${esc(e.phone)}</td>
      <td><a href="https://wa.me/${esc(e.phone)}" target="_blank">Abrir chat 💬</a></td>
      <td>${st}</td>
      <td>${first ? fmtTime(first.ts) : '—'}</td>
      <td>${fmtDur(worked(recs))}</td>
      <td><form method="post" action="/admin/employees/${esc(e.phone)}/toggle"><button>${e.active ? 'Dar de baja' : 'Reactivar'}</button></form></td>
    </tr>`;
  }).join('') || '<tr><td colspan="7">Aún no hay empleados. Los trabajadores pueden escribir "Hola" al WhatsApp de la empresa para registrarse solos.</td></tr>';

  const rows = log.map(r => `<tr><td>${fmtTime(r.ts)}</td><td>${esc(r.name || r.phone)}</td><td>${LBL[r.type]}</td></tr>`).join('')
    || '<tr><td colspan="3">Sin registros hoy.</td></tr>';

  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>FichaChat · Admin</title>
<style>
:root{color-scheme:light dark;--bd:#8884}
body{font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:0 auto;padding:20px}
h1{font-size:22px}h2{font-size:17px;margin-top:28px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--bd)}
.w{overflow-x:auto}form.row{display:flex;gap:8px;flex-wrap:wrap}
input,button{font:inherit;padding:7px 10px;border:1px solid var(--bd);border-radius:8px}button{cursor:pointer}
.info-box{background:rgba(0,128,0,0.1);border-left:4px solid green;padding:12px;margin-bottom:20px;border-radius:4px;}
</style></head><body>
<h1>FichaChat · Panel de administración</h1>
<div class="info-box">
  💡 <b>¡Muy fácil para el empresario!</b> Tus empleados solo tienen que escribir <b>"Hola"</b> al número de WhatsApp de la empresa; el bot les pedirá su nombre y se registrarán solos al instante.
</div>
<h2>Equipo — hoy (${today})</h2>
<div class="w"><table><tr><th>Empleado</th><th>Teléfono</th><th>WhatsApp</th><th>Estado</th><th>Entrada</th><th>Horas</th><th></th></tr>${summary}</table></div>

<h2>Registros de hoy</h2>
<div class="w"><table><tr><th>Hora</th><th>Empleado</th><th>Registro</th></tr>${rows}</table></div>
<h2>Exportar a CSV</h2>
<form class="row" method="get" action="/admin/export.csv">
<input type="date" name="from" value="${today}" required><input type="date" name="to" value="${today}" required>
<button>Descargar</button></form>
</body></html>`);
});

app.post('/admin/employees/:phone/toggle', (req, res) => {
  db.toggleEmp(String(req.params.phone).replace(/\D/g, ''));
  res.redirect('/admin');
});

app.get('/admin/export.csv', (req, res) => {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const { from, to } = req.query;
  if (!re.test(from) || !re.test(to)) return res.status(400).send('Fechas no válidas');
  const since = hoursAgo(72);
  const cell = v => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = ['Fecha;Hora;Empleado;Teléfono;Registro;Origen'];
  db.getAllSince(since).reverse().forEach(r => {
    const d = localDate(r.ts);
    if (d >= from && d <= to) lines.push([d, fmtTime(r.ts), r.name || '', r.phone, LBL[r.type], r.source].map(cell).join(';'));
  });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="fichajes_${from}_${to}.csv"` });
  res.send('\ufeff' + lines.join('\r\n'));
});

app.listen(PORT, () => console.log(`FichaChat escuchando en el puerto ${PORT}`));