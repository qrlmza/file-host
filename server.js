// server.js
// Partage de fichiers avec accueil + sections /games et /docs (Express 5 / Node 22)

'use strict';

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
  '/docs' : path.join(ROOT, 'docs'),
};

// Buckets "jeux" (mode + chemin physique)
const GAMES_BUCKETS = [
  { slug: 'solo',  dir: path.join(ROOT, 'games', 'solo'),  mode: 'solo' },
  { slug: 'multi', dir: path.join(ROOT, 'games',  'multi'), mode: 'coop' },
];

// On pointe /games vers ROOT mais on filtrera ensuite
SECTIONS['/games'] = path.join(ROOT, 'games');

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
    users: { root: process.env.SERVER_PASS || 'change-me' }, // à changer en prod
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

function fmtDateFR(d) {
  const fmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
  return fmt.format(d);
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
  let decoded = '/';
  try {
    decoded = decodeURIComponent(sectionRelPath || '/');
  } catch {
    return null;
  }
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

// helper: rel (p.ex. "/solo/Jeu.zip") autorisé seulement si dans solo|multi
function isAllowedGamesRel(rel) {
  const clean = (rel || '/').replace(/\/+$/, ''); // retire slash fin
  return (
    clean === '/' ||
    clean === '' ||
    clean === '/solo' || clean.startsWith('/solo/') ||
    clean === '/multi' || clean.startsWith('/multi/')
  );
}

// Déterminer le "mode" attendu si on est dans /games/solo|/games/multi
function inferModeFromRel(rel) {
  if (!rel) return null;
  if (rel === '/solo' || rel.startsWith('/solo/')) return 'solo';
  if (rel === '/multi' || rel.startsWith('/multi/')) return 'coop';
  return null;
}

// --------- Page d'accueil ---------
app.get('/', (_req, res) => {
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
</style>
</head>
<body>
  <div class="wrap">
    <h1>🗂️ Partage de fichiers</h1>
    <div class="buttons">
      <a class="btn" href="/games/">
        🎮 Jeux (/games)
      </a>
      <a class="btn" href="/docs/">
        📄 Docs (/docs)
      </a>
    </div>
  </div>
</body>
</html>`);
});

// --------- Téléchargement direct (dans une section uniquement) ---------
app.use(async (req, res, next) => {
  const sectionKey = matchSection(req.path);
  if (!sectionKey) return next();

  try {
    const sectionRoot = SECTIONS[sectionKey];
    const rel = req.path.slice(sectionKey.length) || '/';

    // Sécurité: sous /games on n'autorise QUE /solo/... et /multi/...
    if (sectionKey === '/games' && !isAllowedGamesRel(rel)) {
      return next(); // laisser l'index gérer (affichera la page /games ou 404)
    }

    const abs = resolvePathSafe(sectionRoot, rel);
    if (!abs) return res.status(400).send('Chemin invalide');

    let st;
    try {
      st = await fs.lstat(abs);
    } catch {
      return next();
    }

    if (st.isDirectory()) return next();

    setDownloadHeaders(res, abs);
    res.sendFile(abs, { dotfiles: 'deny' }, (err) => { if (err) next(err); });
  } catch (e) {
    next(e);
  }
});

// --------- Index HTML de section ---------
app.use(async (req, res, next) => {
  const sectionKey = matchSection(req.path);
  if (!sectionKey) return next();

  try {
    const sectionRoot = SECTIONS[sectionKey];
    const rel = req.path.slice(sectionKey.length) || '/';

    // Cas spécial: /games (racine) -> vue agrégée solo + multi
    if (sectionKey === '/games' && (rel === '/' || rel === '')) {
      // Construit une "rows" virtuelle depuis les deux dossiers
      const rows = [];
      for (const b of GAMES_BUCKETS) {
        let list = [];
        try {
          list = await fs.readdir(b.dir, { withFileTypes: true });
        } catch {
          continue; // si un des dossiers n'existe pas, on ignore
        }
        for (const e of list) {
          if (!e.isFile()) continue; // on liste uniquement des fichiers ici
          const full = path.join(b.dir, e.name);
          let s;
          try {
            s = await fs.lstat(full);
          } catch { continue; }
          rows.push({
            name: e.name,
            href: `/games/${b.slug}/${encodeURIComponent(e.name)}`,
            isDir: false,
            size: s.size,
            mtime: s.mtime,
            mode: b.mode, // "solo" ou "coop"
          });
        }
      }

      rows.sort((a, b) => a.name.localeCompare(b.name, 'fr'));

      const crumbs = ['<a href="/">Accueil</a>', '<a href="/games/">games</a>'];

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.removeHeader('Content-Disposition');

      return res.send(renderTableHtml({
        title: '/games',
        heading: '⚡ games →',
        breadcrumbsHtml: crumbs.join(' &raquo; '),
        rows,
        showMode: true,
      }));
    }

    // ---- Comportement standard (liste d'un dossier existant) ----
    // Si on est sous /games, interdire l'exploration d'autres sous-dossiers que solo/multi
    if (sectionKey === '/games' && !isAllowedGamesRel(rel)) {
      return res.status(404).send('Introuvable');
    }

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
      let s;
      try {
        s = await fs.lstat(full);
      } catch {
        continue;
      }
      const isDir = e.isDirectory();
      const name = e.name + (isDir ? '/' : '');
      const base = req.path.endsWith('/') ? req.path : req.path + '/';
      const href = base + encodeURIComponent(e.name) + (isDir ? '/' : '');

      // Détermine le mode si on est dans /games/solo ou /games/multi
      const mode = sectionKey === '/games' ? inferModeFromRel(rel) : null;

      rows.push({
        name,
        href,
        isDir,
        size: isDir ? null : s.size,
        mtime: s.mtime,
        mode: isDir ? null : mode, // on n’affiche que sur les fichiers
      });
    }

    rows.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'fr'));

    // Fil d’Ariane
    const decoded = safeDecodePath(req.path || '/');
    const parts = decoded.split('/').filter(Boolean);
    const crumbs = ['<a href="/">Accueil</a>'];
    let acc = '';
    for (const p of parts) {
      acc += '/' + p;
      crumbs.push(`<a href="${acc}/">${escapeHtml(p)}</a>`);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.removeHeader('Content-Disposition');

    return res.send(renderTableHtml({
      title: decoded,
      heading: `⚡ ${escapeHtml(parts[0] || '')} →`,
      breadcrumbsHtml: crumbs.join(' &raquo; '),
      rows,
      showMode: true, // on affiche la colonne, badge seulement si r.mode défini
      parentLinkHtml: (decoded !== `/${parts[0]}/` && decoded !== `/${parts[0]}`)
        ? `<tr><td class="name"><a href="../" class="label">../</a></td><td class="mode"></td><td></td><td></td></tr>` : '',
    }));
  } catch (e) {
    next(e);
  }
});

// --------- Erreurs ---------
app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).send('Erreur interne. Consulte la console du serveur.');
});

// --------- Démarrage ---------
app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
  console.log(`Dossiers servis:`);
  console.log(`  Jeux (solo):  ${path.join(ROOT, 'games', 'solo')}`);
  console.log(`  Jeux (multi): ${path.join(ROOT, 'games', 'multi')}`);
  console.log(`  Docs:         ${SECTIONS['/docs']}`);
});

// Sécurité process
process.on('uncaughtException', (e) => console.error('UncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('UnhandledRejection:', e));

// --------- Helpers HTML ---------
function renderTableHtml({
  title,
  heading,
  breadcrumbsHtml,
  rows,
  showMode = true,
  parentLinkHtml = '',
}) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu; margin:24px; line-height:1.35; background-color:#1C1C1C; color:#fefefe;}
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
  th.mode, td.mode, th.size, th.date, td.size, td.date { white-space:nowrap; text-align:right; }
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
  /* Badges */
  .badge{display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:700; letter-spacing:.2px;}
  .badge.coop{background:#dd3a4560; color:#fefefe; border: solid 1px #DD3A44; padding-left: 10px; padding-right: 10px; padding-top: 2px; padding-bottom: 4px;}
  .badge.solo{background:#dd3a4560; color:#fefefe; border: solid 1px #DD3A44; padding-left: 10px; padding-right: 10px; padding-top: 2px; padding-bottom: 4px;}
</style>
</head>
<body>
  <header>
    <h1 style="color:#fefefe;">${heading}</h1>
    <nav style="color:#fefefe;">${breadcrumbsHtml}</nav>
  </header>

  <table>
    <thead>
      <tr style="color:#fefefe;">
        <th>Nom</th>
        ${showMode ? '<th class="mode">Mode</th>' : ''}
        <th class="size">Taille</th>
        <th class="date">Modifié</th>
      </tr>
    </thead>
    <tbody>
      ${parentLinkHtml}
      ${rows.map(r => `
        <tr style="color:#fefefe;">
          <td class="name">
            ${r.isDir ? '' : `
              <a class="dl-btn" href="${r.href}" title="Télécharger ${escapeHtml(stripSlash(r.name))}" aria-label="Télécharger ${escapeHtml(stripSlash(r.name))}">
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 3a1 1 0 0 1 1 1v9.586l2.293-2.293a1 1 0 1 1 1.414 1.414l-4.007 4.007a1.25 1.25 0 0 1-1.4.245 1.25 1.25 0 0 1-.245-.245L7.05 12.707a1 1 0 1 1 1.414-1.414L10.757 13.586V4a1 1 0 0 1 1-1ZM5 19a1 1 0 1 0 0 2h14a1 1 0 1 0 0-2H5Z"/>
                </svg>
              </a>`}
            ${r.isDir
              ? `<a href="${r.href}" class="label">📁 ${escapeHtml(stripSlash(r.name))}</a>`
              : `<span class="label">📦 ${escapeHtml(r.name)}</span>`}
          </td>
          ${showMode ? `<td class="mode">${r.mode ? `<span class="badge ${r.mode}">${r.mode}</span>` : ''}</td>` : ''}
          <td class="size">${r.isDir ? '' : formatSizeFR(r.size)}</td>
          <td class="date">${fmtDateFR(r.mtime)}</td>
        </tr>`).join('')}
    </tbody>
  </table>
</body>
</html>`;
}

function safeDecodePath(p) {
  try { return decodeURIComponent(p); } catch { return p; }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function stripSlash(name) {
  return name.endsWith('/') ? name.slice(0, -1) : name;
}
async function dirExists(p) {
  try { const s = await fs.lstat(p); return s.isDirectory(); }
  catch { return false; }
}