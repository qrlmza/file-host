// server.js
// Partage de fichiers avec index HTML + tailles lisibles (Express 5 / Node 22)

const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const basicAuth = require('express-basic-auth');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs').promises;

const app = express();

// --------- Config ---------
const PORT = process.env.PORT || 3000;
const ROOT = path.resolve(__dirname, 'files'); // dossier racine
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
if (TRUST_PROXY) app.set('trust proxy', 1);

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
    users: { root: 'motdepassefort' }, // change-moi
    challenge: true,
    realm: 'RAR-Share',
  })
);

// --------- Utils ---------
// Format FR en Ko / Mo / Go (base 1024)
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

// Résolution cross-platform + anti-traversal
function resolvePathSafe(root, urlPath) {
  const decoded = decodeURIComponent(urlPath || '/');
  const abs = path.resolve(root, '.' + decoded);
  const rootNorm = root.endsWith(path.sep) ? root : root + path.sep;
  if (!abs.startsWith(rootNorm) && abs !== root) return null;
  return abs;
}

// Force le téléchargement d’un fichier
function setDownloadHeaders(res, filePath) {
  const filename = path.basename(filePath);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
}

// --------- Fichiers (téléchargement direct) ---------
// Si la cible est un fichier -> sendFile, sinon on laisse passer à l’index
app.use(async (req, res, next) => {
  try {
    const abs = resolvePathSafe(ROOT, req.path);
    if (!abs) return res.status(400).send('Chemin invalide');

    let st;
    try {
      st = await fs.lstat(abs);
    } catch {
      return next(); // inexistants -> l’index gèrera 404
    }

    if (st.isDirectory()) return next();

    // C’est un fichier: répondre avec téléchargement
    setDownloadHeaders(res, abs);
    res.sendFile(abs, { dotfiles: 'deny' }, (err) => {
      if (err) next(err);
    });
  } catch (e) {
    next(e);
  }
});

// --------- Index HTML des répertoires ---------
// NOTE: pas de motif ('*' ou '/*') — on utilise app.use sans chemin pour éviter path-to-regexp
app.use(async (req, res, next) => {
  // Ne traiter que GET/HEAD pour l’index
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  try {
    const abs = resolvePathSafe(ROOT, req.path);
    if (!abs) return res.status(400).send('Chemin invalide');

    let st;
    try {
      st = await fs.lstat(abs);
    } catch {
      return res.status(404).send('Introuvable');
    }
    if (!st.isDirectory()) return next(); // fallback, normalement jamais atteint

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
    const parts = decoded.split('/').filter(Boolean);
    const crumbs = ['<a href="/">/</a>'];
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
<title>Index ${decoded || '/'}</title>
<style>
  :root { color-scheme: light dark; }
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu; margin:24px; line-height:1.35; background-color: #1C1C1C;}
  header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:12px;flex-wrap:wrap;}
  table{border-collapse:collapse; width:100%;}
  th,td{padding:8px 10px; border-bottom:1px solid #f1f1f1;}
  th{background:#800020; text-align:left;}
  /* Aligner entêtes et cellules des colonnes "Taille" et "Modifié" */
  th.size, th.date { text-align:right; white-space:nowrap; }
  td.size, td.date { white-space:nowrap; text-align:right; }
  /* Chiffres tabulaires pour un alignement plus net des nombres et heures */
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
    <h1 style="color: #fefefe;">⚡ files →</h1>
    <nav>${crumbs.join(' &raquo; ')}</nav>
  </header>

  <table>
    <thead>
      <tr style="color: #fefefe;">
        <th>Nom</th>
        <th class="size">Taille</th>
        <th class="date">Modifié</th>
      </tr>
    </thead>
    <tbody>
      ${decoded !== '/' && decoded !== '' ? `<tr><td><a href="../">../</a></td><td></td><td></td></tr>` : ''}
      ${rows.map(r => `
        <tr style="color: #fefefe;">
          <td><a href="${r.href}">📦 ${r.name}</a></td>
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
  console.log(`Dossier servi: ${ROOT}`);
});

process.on('uncaughtException', (e) => console.error('UncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('UnhandledRejection:', e));
