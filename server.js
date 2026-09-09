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
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://js.stripe.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'https:'],
      frameSrc: ['https://js.stripe.com', 'https://checkout.stripe.com'],
      connectSrc: ["'self'", 'https://api.stripe.com'],
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

// Template globals
app.use((req, res, next) => {
  res.locals.h = h;
  res.locals.C = C;
  res.locals.path = req.path;
  res.locals.PUBLIC_URL = PUBLIC_URL;
  res.locals.canonical = PUBLIC_URL + req.originalUrl.split('?')[0];
  res.locals.title = 'Canada Careers';
  res.locals.metaDescription = 'Canada Careers is a Canadian job bank connecting employers and third-party consultants with professionals, new immigrants, Indigenous peoples, refugees and youth. Post a job for $9.99/month.';
  res.locals.ogImage = PUBLIC_URL + '/img/og.png';
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
mount('/', './routes/public');      // / /jobs /jobs/:slug /sitemap.xml /robots.txt  (LAST)

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
  app.listen(PORT, '127.0.0.1', () => console.log(`Canada Careers listening on http://127.0.0.1:${PORT} (${process.env.NODE_ENV || 'development'})`));
}
module.exports = app;
