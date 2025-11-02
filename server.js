// server.js
// Partage de fichiers avec accueil + sections /games et /docs (Express 5 / Node 22)

const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const basicAuth = require('express-basic-auth');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs').promises;
require('dotenv').config({ quiet: true });

const app = express();

// --------- Config ---------
const PORT = process.env.PORT || 3000;
const ROOT = path.resolve(__dirname, 'files');     // racine physique
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
if (TRUST_PROXY) app.set('trust proxy', 1);

// Sections logiques → sous-dossiers
const SECTIONS = {
  '/games': path.join(ROOT, 'games'),
  '/docs' : path.join(ROOT, 'docs'),
};

// --------- Middlewares de base ---------
app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
app.use(compression());
app.use(morgan('combined'));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);
app.use(
  basicAuth({
    users: { root: process.env.SERVER_PASS }, // change-moi
    challenge: true,
    realm: 'RAR-Share',
  })
);

// --------- Utils ---------
function formatSizeFR(bytes) {
  const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
  const UNITS = [
    { unit: 'Go', value: 1024 ** 3 },
    { unit: 'Mo', value: 1024 ** 2 },
    { unit: 'Ko', value: 1024 },
  ];
  for (const { unit, value } of UNITS) {
    if (bytes >= value) {
      const n = bytes / value;
      return `${(n >= 10 ? nf0 : nf1).format(n)} ${unit}`;
    }
  }
  return `${new Intl.NumberFormat('fr-FR').format(bytes)} o`;
}

// Trouver la section (/games ou /docs) et la racine physique associée
function matchSection(urlPath) {
  for (const key of Object.keys(SECTIONS)) {
    if (urlPath === key || urlPath.startsWith(key + '/') || urlPath.startsWith(key + '%2F')) {
      return key;
    }
  }
  return null;
}

// Résolution sécurisée relative à la section
function resolvePathSafe(sectionRoot, sectionRelPath) {
  const decoded = decodeURIComponent(sectionRelPath || '/');
  const abs = path.resolve(sectionRoot, '.' + decoded);
  const rootNorm = sectionRoot.endsWith(path.sep) ? sectionRoot : sectionRoot + path.sep;
  if (!abs.startsWith(rootNorm) && abs !== sectionRoot) return null;
  return abs;
}

// Force le téléchargement d’un fichier
function setDownloadHeaders(res, filePath) {
  const filename = path.basename(filePath);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
}

// --------- Page d'accueil ---------
app.get('/', async (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.removeHeader('Content-Disposition');
  res.send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Accueil</title>
<style>
  :root { color-scheme: light dark; }
  body{margin:0; font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu; background:#1C1C1C; color:#fefefe; min-height:100svh; display:grid; place-items:center;}
  .wrap{display:flex; flex-direction:column; align-items:center; gap:24px; padding:24px;}
  h1{margin:0; font-size:28px;}
  .buttons{display:flex; gap:16px; flex-wrap:wrap; justify-content:center;}
  .btn{
    display:inline-flex; align-items:center; gap:10px; justify-content:center;
    padding:14px 22px; border-radius:10px; border:1px solid #fefefe33;
    color:#fefefe; text-decoration:none; font-weight:600; letter-spacing:.2px;
    background:#2a2a2a;
  }
  .btn:hover{ background:#353535; border-color:#ffffff66; }
  .btn svg{width:20px; height:20px;}
  footer{opacity:.7; font-size:12px;}
</style>
</head>
<body>
  <main class="wrap">
    <h1>📂 Partage de fichiers</h1>
    <div class="buttons">
      <a class="btn" href="/games/" title="Jeux">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 7h12a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3h-2l-2 2h-4l-2-2H6a3 3 0 0 1-3-3v-4a3 3 0 0 1 3-3Zm2 3H7v2H5v2h2v2h2v-2h2v-2H8v-2Zm9.5 1.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/></svg>
        Jeux
      </a>
      <a class="btn" href="/docs/" title="Documents">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 2h7l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7 1v4h4l-4-4Z"/></svg>
        Documents
      </a>
    </div>
    <footer>Choisis une section pour parcourir et télécharger.</footer>
  </main>
</body>
</html>`);
});

// --------- Téléchargement direct (dans une section uniquement) ---------
app.use(async (req, res, next) => {
  const sectionKey = matchSection(req.path);
  if (!sectionKey) return next(); // pas une section -> laisser passer (accueil, etc.)
  try {
    const sectionRoot = SECTIONS[sectionKey];
    const rel = req.path.slice(sectionKey.length) || '/';
    const abs = resolvePathSafe(sectionRoot, rel);
    if (!abs) return res.status(400).send('Chemin invalide');

    let st;
    try {
      st = await fs.lstat(abs);
    } catch {
      return next(); // l’index de section gèrera 404
    }

    if (st.isDirectory()) return next();

    setDownloadHeaders(res, abs);
    res.sendFile(abs, { dotfiles: 'deny' }, (err) => { if (err) next(err); });
  } catch (e) {
    next(e);
  }
});

// --------- Index HTML de section (/games, /docs, sous-dossiers) ---------
app.use(async (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  const sectionKey = matchSection(req.path);
  if (!sectionKey) return next(); // autre chose -> pas notre index

  try {
    const sectionRoot = SECTIONS[sectionKey];
    const rel = req.path.slice(sectionKey.length) || '/';
    const abs = resolvePathSafe(sectionRoot, rel);
    if (!abs) return res.status(400).send('Chemin invalide');

    let st;
    try {
      st = await fs.lstat(abs);
    } catch {
      return res.status(404).send('Introuvable');
    }
    if (!st.isDirectory()) return next();

    const list = await fs.readdir(abs, { withFileTypes: true });

    const rows = [];
    for (const e of list) {
      const full = path.join(abs, e.name);
      const s = await fs.lstat(full);
      const isDir = e.isDirectory();
      const name = e.name + (isDir ? '/' : '');
      const base = req.path.endsWith('/') ? req.path : req.path + '/';
      const href = base + encodeURIComponent(e.name) + (isDir ? '/' : '');
      rows.push({ name, href, isDir, size: isDir ? null : s.size, mtime: s.mtime });
    }

    rows.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'fr'));

    const decoded = decodeURIComponent(req.path || '/');

    // Fil d’Ariane: Accueil → Section → sous-dossiers
    const parts = decoded.split('/').filter(Boolean);
    const crumbs = ['<a href="/">Accueil</a>'];
    let acc = '';
    for (const p of parts) {
      acc += `/${encodeURIComponent(p)}`;
      crumbs.push(`<a href="${acc}/">${p}</a>`);
    }

    const fmtDate = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.removeHeader('Content-Disposition');

    res.send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${decoded || '/'}</title>
<style>
  :root { color-scheme: light dark; }
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu; margin:24px; line-height:1.35; background-color:#1C1C1C;}
  header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:12px;flex-wrap:wrap;}
  table{border-collapse:collapse; width:100%;}
  th,td{padding:8px 10px; border-bottom:1px solid #f1f1f1;}
  th{background:#800020; text-align:left;}
  td.name{display:flex; align-items:center; gap:10px; min-width:0;}
  td.name .label{display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;}
  .dl-btn{
    display:inline-flex; align-items:center; justify-content:center;
    width:28px; height:28px; border-radius:6px;
    border:1px solid #e5e5e5; background:#f1f1f1; color:#1C1C1C;
    text-decoration:none; flex:0 0 auto;
  }
  .dl-btn:hover{ background:#ffeef1; border-color:#ffb8c1; }
  .dl-btn svg{ width:16px; height:16px; }
  th.size, th.date { text-align:right; white-space:nowrap; }
  td.size, td.date { white-space:nowrap; text-align:right; }
  th.size, th.date, td.size, td.date {
    font-variant-numeric: tabular-nums;
    -webkit-font-feature-settings: "tnum" 1;
            font-feature-settings: "tnum" 1;
  }
  a{color:#DD3A44; text-decoration:none;}
  a:hover{text-decoration:underline;}
  @media (prefers-color-scheme: dark) {
    th,td{border-bottom:1px solid #fefefe;}
    th{background:#1d1d1d;}
  }
</style>
</head>
<body>
  <header>
    <h1 style="color:#fefefe;">⚡ ${parts[0] || ''} →</h1>
    <nav style="color:#fefefe;">${crumbs.join(' &raquo; ')}</nav>
  </header>

  <table>
    <thead>
      <tr style="color:#fefefe;">
        <th>Nom</th>
        <th class="size">Taille</th>
        <th class="date">Modifié</th>
      </tr>
    </thead>
    <tbody>
      ${decoded !== `/${parts[0]}/` && decoded !== `/${parts[0]}` ? `<tr><td class="name"><a href="../" class="label">../</a></td><td></td><td></td></tr>` : ''}
      ${rows.map(r => `
        <tr style="color:#fefefe;">
          <td class="name">
            ${r.isDir ? '' : `
              <a class="dl-btn" href="${r.href}" title="Télécharger ${r.name}" aria-label="Télécharger ${r.name}">
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 3a1 1 0 0 1 1 1v9.586l2.293-2.293a1 1 0 1 1 1.414 1.414l-4.007 4.007a1.25 1.25 0 0 1-1.4.245 1.25 1.25 0 0 1-.245-.245L7.05 12.707a1 1 0 1 1 1.414-1.414L10.757 13.586V4a1 1 0 0 1 1-1ZM5 19a1 1 0 1 0 0 2h14a1 1 0 1 0 0-2H5Z"/>
                </svg>
              </a>`}
            ${r.isDir
              ? `<a href="${r.href}" class="label">📁 ${r.name}</a>`
              : `<span class="label">📦 ${r.name}</span>`}
          </td>
          <td class="size">${r.isDir ? '' : formatSizeFR(r.size)}</td>
          <td class="date">${fmtDate.format(r.mtime)}</td>
        </tr>`).join('')}
    </tbody>
  </table>
</body>
</html>`);
  } catch (e) {
    next(e);
  }
});

// --------- Erreurs ---------
app.use((err, req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).send('Erreur interne. Consulte la console du serveur.');
});

// --------- Démarrage ---------
app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
  console.log(`Dossiers servis:`);
  console.log(`  Jeux: ${SECTIONS['/games']}`);
  console.log(`  Docs: ${SECTIONS['/docs']}`);
});

// Sécurité process
process.on('uncaughtException', (e) => console.error('UncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('UnhandledRejection:', e));
