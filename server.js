'use strict';
require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const expressLayouts = require('express-ejs-layouts');
const db = require('./lib/db');
const auth = require('./lib/auth');
const h = require('./lib/helpers');
const C = require('./lib/constants');

const app = express();
const PORT = Number(process.env.PORT || 3900);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const isProd = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');
app.set('layout extractScripts', false);

app.use(helmet({
  // Browsers send `Origin: null` on non-GET requests under `no-referrer`, which would trip sameOriginGuard on every form.
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://js.stripe.com', 'https://maps.googleapis.com', 'https://maps.gstatic.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      workerSrc: ["'self'", 'blob:'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'https:'],
      frameSrc: ['https://js.stripe.com', 'https://checkout.stripe.com'],
      connectSrc: ["'self'", 'https://api.stripe.com', 'https://maps.googleapis.com', 'https://*.tile.openstreetmap.org'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Stripe webhook must see the raw body — mounted BEFORE the json/urlencoded parsers.
app.use('/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: isProd ? '1d' : 0 }));

app.use(session({
  store: new PgStore({ pool: db.pool, tableName: 'session', createTableIfMissing: false }),
  name: 'cc_session',
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 30 * 24 * 3600 * 1000 },
}));
app.use(auth.flashMiddleware);
app.use(auth.loadUser);
app.use(auth.sameOriginGuard);

// Template globals (site settings come from the admin panel; 5 s cache in lib/settings)
const settings = require('./lib/settings');
app.use(async (req, res, next) => {
  try { res.locals.site = await settings.getMany(['site_name', 'contact_phone', 'contact_address', 'support_name', 'public_url']); } catch (e) { res.locals.site = { site_name: 'Youth Futures Canada' }; }
  res.locals.h = h;
  res.locals.C = C;
  res.locals.path = req.path;
  const pub = (res.locals.site && res.locals.site.public_url) || PUBLIC_URL;
  res.locals.PUBLIC_URL = pub;
  res.locals.canonical = pub + req.originalUrl.split('?')[0];
  res.locals.title = 'Youth Futures Canada';
  res.locals.metaDescription = 'Youth Futures Canada is a Canadian job bank connecting employers and third-party consultants with young talent everywhere — students, graduates, young professionals and skilled workers. Post a job from $9.99/month + GST (consultants) or $14.99/month + GST (employers).';
  res.locals.ogImage = pub + '/img/og.png';
  res.locals.jsonLd = [];
  res.locals.extraCss = [];
  res.locals.extraJs = [];
  res.locals.bodyClass = '';
  res.locals.noindex = false;
  next();
});

// ----------------------------------------------------------------- routers
// ORDER MATTERS: specific routers before the public catch-all router.
const mount = (p, file) => { try { app.use(p, require(file)); } catch (e) { if (e.code === 'MODULE_NOT_FOUND' && e.message.includes(file.replace('./', ''))) console.warn(`[server] ${file} not present yet, skipping`); else throw e; } };
mount('/', './routes/auth');        // /login /signup /logout /forgot /reset
mount('/', './routes/seeker');      // /jobseeker/* and /jobs/:slug/apply  (must precede public)
mount('/', './routes/portal');      // /employer/* and /consultant/*
mount('/', './routes/billing');     // /billing/*
mount('/', './routes/about');       // /about
mount('/', './routes/contact');     // /contact
mount('/', './routes/admin');       // /admin/*
mount('/', './routes/jobs-search'); // /jobs list, /api/jobs/geo, /jobs/id/:publicId (must precede public)
mount('/', './routes/public');      // / /jobs/:slug /sitemap.xml /robots.txt  (LAST)

app.get('/healthz', async (req, res) => {
  try { await db.query('SELECT 1'); res.json({ ok: true }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 404 + error handlers
app.use((req, res) => res.status(404).render('error', { title: 'Page not found', code: 404, message: 'We could not find that page.', noindex: true }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[error]', req.method, req.originalUrl, err);
  if (res.headersSent) return;
  const code = err.status || 500;
  res.status(code).render('error', { title: 'Something went wrong', code, message: isProd ? 'Something went wrong on our side. Please try again.' : err.message, noindex: true });
});

if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => console.log(`Youth Futures Canada listening on http://127.0.0.1:${PORT} (${process.env.NODE_ENV || 'development'})`));
}
module.exports = app;
