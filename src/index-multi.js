// index-multi.js (Multi-store Shopify OAuth app)
require('dotenv').config();
require('@shopify/shopify-api/adapters/node');

const express = require('express');
const crypto = require('crypto');
const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
const Redis = require('ioredis');

const app = express();
app.set('trust proxy', true); // so req.ip works behind Render/Cloudflare

const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SCOPES,
  HOST,
  PORT = 3000,
  REDIS_URL,
  ALLOWED_ORIGINS = "",
  RATE_IP_MAX_PER_MIN = "60",
  RATE_ID_MAX_PER_HOUR = "30",
} = process.env;

// Log missing (don’t crash)
['SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET', 'SCOPES', 'HOST'].forEach(k => {
  if (!process.env[k]) console.error(`❌ Missing env: ${k}`);
});

// ---------- Body parser (keep raw for webhooks) ----------
app.use(express.json({
  verify: (req, res, buf) => {
    if (req.originalUrl.startsWith('/webhooks/')) req.rawBody = buf;
  }
}));

// ---------- Token Store (Redis if available; memory fallback) ----------
let redis;
let store;
if (REDIS_URL) {
  redis = new Redis(REDIS_URL, { lazyConnect: true });
  redis.on('error', (e) => console.error('Redis error:', e));

  store = {
    async saveToken(shop, token) {
      await redis.set(`shop:token:${shop}`, token);
      await redis.sadd('shops', shop);
    },
    async getToken(shop) {
      return redis.get(`shop:token:${shop}`);
    },
    async deleteToken(shop) {
      await redis.del(`shop:token:${shop}`);
      await redis.srem('shops', shop);
    },
    async listShops() {
      return redis.smembers('shops');
    },
  };
  console.log('🔗 Token store: Redis');
} else {
  const mem = new Map();
  const shops = new Set();
  store = {
    async saveToken(shop, token) { mem.set(shop, token); shops.add(shop); },
    async getToken(shop) { return mem.get(shop); },
    async deleteToken(shop) { mem.delete(shop); shops.delete(shop); },
    async listShops() { return Array.from(shops); },
  };
  console.log('💾 Token store: In-memory (set REDIS_URL to persist)');
}

// ---------- Shopify SDK ----------
const hostName = (HOST || process.env.RENDER_EXTERNAL_URL || '')
  .replace(/^https?:\/\//, '')
  .replace(/\/$/, '');

const shopify = shopifyApi({
  apiKey: SHOPIFY_API_KEY,
  apiSecretKey: SHOPIFY_API_SECRET,
  scopes: (SCOPES || '').split(',').map(s => s.trim()).filter(Boolean),
  hostName,
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false,
});

// ---------- CORS (allow-list) ----------
const ORIGINS = ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- Helpers ----------
const normalize     = (s) => (s || '').trim().toLowerCase();
const normalizeZip  = (s) => (s || '').replace(/\s/g, '').trim().toLowerCase();
const cleanOrderNum = (n) => (n || '').toString().replace(/^#/, '');

// ---------- Rate limiting (Redis or memory) ----------
const memRl = new Map();
function makeLimiter({ name, windowSec, max, keyFn }) {
  return async (req, res, next) => {
    try {
      const keyPart = await keyFn(req);
      if (!keyPart) return next();
      const k = `rl:${name}:${keyPart}`;

      if (redis) {
        const count = await redis.incr(k);
        if (count === 1) await redis.expire(k, windowSec);
        if (count > max) {
          const ttl = await redis.ttl(k);
          return res.status(429).json({ error: 'rate_limited', retryAfterSec: Math.max(ttl, 1) });
        }
      } else {
        const now = Date.now();
        const item = memRl.get(k) || { count: 0, resetAt: now + windowSec * 1000 };
        if (now > item.resetAt) { item.count = 0; item.resetAt = now + windowSec * 1000; }
        item.count++;
        memRl.set(k, item);
        if (item.count > max) {
          return res.status(429).json({ error: 'rate_limited', retryAfterSec: Math.ceil((item.resetAt - now) / 1000) });
        }
      }
      next();
    } catch (e) {
      console.warn('rate limit error:', e.message);
      next(); // fail-open
    }
  };
}

const rateByIP = makeLimiter({
  name: 'ip1m',
  windowSec: 60,
  max: parseInt(RATE_IP_MAX_PER_MIN, 10),
  keyFn: (req) => req.ip
});

const rateById = makeLimiter({
  name: 'id1h',
  windowSec: 3600,
  max: parseInt(RATE_ID_MAX_PER_HOUR, 10),
  keyFn: (req) => {
    const b = req.body || {};
    return `${b.shop || ''}:${cleanOrderNum(b.orderNumber || '')}:${normalize(b.emailOrZip || '')}`;
  }
});

// ---------- OAuth ----------
app.get('/auth', async (req, res) => {
  try {
    const shop = (req.query.shop || '').toString();
    if (!shop || !shop.endsWith('.myshopify.com')) {
      return res.status(400).send('Missing or invalid ?shop=my-store.myshopify.com');
    }
    await shopify.auth.begin({
      shop,
      callbackPath: '/auth/callback',
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });
  } catch (e) {
    console.error('Auth begin error:', e);
    res.status(500).send('Auth begin failed');
  }
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { session } = await shopify.auth.callback({ rawRequest: req, rawResponse: res });
    await store.saveToken(session.shop, session.accessToken);
    console.log(`✅ Installed on ${session.shop}. Token saved.`);

    // Register uninstall webhook (extra logs)
    try {
      const webhookUrl = `${HOST.replace(/\/$/, '')}/webhooks/app-uninstalled`;
      console.log('Registering uninstall webhook at:', webhookUrl);

      const r = await fetch(`https://${session.shop}/admin/api/${LATEST_API_VERSION}/webhooks.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': session.accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ webhook: { topic: 'app/uninstalled', address: webhookUrl, format: 'json' } }),
      });

      const t = await r.text();
      if (!r.ok) {
        console.warn('Webhook register failed:', r.status, t);
      } else {
        console.log('✅ app/uninstalled webhook registered for', session.shop, '->', webhookUrl);
      }
    } catch (e) {
      console.warn('Webhook register error:', e.message);
    }

    res.redirect(`/installed?shop=${encodeURIComponent(session.shop)}`);
  } catch (e) {
    console.error('Auth callback error:', e.response?.data || e.message);
    res.status(500).send('Auth callback failed');
  }
});

app.get('/installed', (req, res) => {
  const shop = req.query.shop;
  res.send(`✅ Installed on ${shop}. Token saved. You can now use the API.`);
});

// ---------- Webhooks ----------
app.post('/webhooks/app-uninstalled', async (req, res) => {
  try {
    const shopHdr = req.get('X-Shopify-Shop-Domain') || '';
    const topic   = req.get('X-Shopify-Topic') || '';
    console.log('↘️  Received webhook:', topic, 'from', shopHdr);

    const hmac = req.get('X-Shopify-Hmac-Sha256') || '';
    const raw  = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(raw).digest('base64');

    const a = Buffer.from(digest);
    const b = Buffer.from(hmac);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      console.warn('⚠️ Invalid webhook HMAC');
      return res.sendStatus(401);
    }

    const shop = shopHdr.toString();
    if (shop) {
      await store.deleteToken(shop);
      console.log('🧹 Token deleted for', shop);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('Uninstall webhook error:', e);
    res.sendStatus(200); // still 200 to avoid Shopify retries
  }
});

// List webhooks for a shop (debug)
app.get('/api/debug/webhooks', async (req, res) => {
  try {
    const shop = (req.query.shop || '').toString();
    if (!shop) return res.status(400).json({ error: 'missing shop' });
    const token = await store.getToken(shop);
    if (!token) return res.status(401).json({ error: 'no token saved for this shop' });

    const r = await fetch(`https://${shop}/admin/api/${LATEST_API_VERSION}/webhooks.json`, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- API ----------
app.get('/api/health', async (req, res) => {
  let installedShops = [];
  try { installedShops = await store.listShops(); } catch {}
  res.json({
    status: 'healthy',
    time: new Date().toISOString(),
    env: {
      apiKey: !!SHOPIFY_API_KEY,
      apiSecret: !!SHOPIFY_API_SECRET,
      host: HOST,
      scopes: SCOPES,
      redis: !!REDIS_URL,
      allowedOrigins: ORIGINS,
      rateIpMaxPerMin: parseInt(RATE_IP_MAX_PER_MIN, 10),
      rateIdMaxPerHour: parseInt(RATE_ID_MAX_PER_HOUR, 10),
    },
    installedShops,
  });
});

app.post('/api/validate-order', rateByIP, rateById, async (req, res) => {
  try {
    const { shop, orderNumber, emailOrZip } = req.body || {};
    if (!shop || !shop.endsWith('.myshopify.com')) {
      return res.status(400).json({ error: 'Missing/invalid "shop" (e.g. crossar.myshopify.com)' });
    }
    if (!orderNumber || !emailOrZip) {
      return res.status(400).json({ error: 'Missing fields: orderNumber, emailOrZip' });
    }

    const accessToken = await store.getToken(shop);
    if (!accessToken) {
      return res.status(401).json({ error: `Shop ${shop} not authorized. Visit ${HOST}/auth?shop=${shop}` });
    }

    const cleaned = cleanOrderNum(orderNumber);
    let order = null;

    // include line_items + id so we can build the selection UI
    const doSearch = async (name) => {
      const url = `https://${shop}/admin/api/${LATEST_API_VERSION}/orders.json?` +
                  `name=${encodeURIComponent(name)}&status=any&` +
                  `fields=name,email,shipping_address,line_items,id`;
      const resp = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
      });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Shopify ${resp.status} ${resp.statusText}: ${txt}`);
      }
      return resp.json();
    };

    try {
      const data = await doSearch('#' + cleaned);
      if (data.orders?.length) order = data.orders[0];
    } catch (e) { console.log('Name search (#) failed:', e.message); }

    if (!order) {
      try {
        const data = await doSearch(cleaned);
        if (data.orders?.length) order = data.orders[0];
      } catch (e) { console.log('Name search (no #) failed:', e.message); }
    }

    if (!order) return res.json({ found: false, reason: 'order_not_found' });

    const orderEmail = normalize(order.email);
    const orderZip   = normalizeZip(order.shipping_address?.zip);
    const emailIn    = normalize(emailOrZip);
    const zipIn      = normalizeZip(emailOrZip);

    const emailMatch = orderEmail && orderEmail === emailIn;
    const zipMatch   = orderZip && orderZip === zipIn;

    // minimal items payload for the UI
    const items = Array.isArray(order.line_items) ? order.line_items.map(li => ({
      id: li.id,
      productId: li.product_id,
      variantId: li.variant_id,
      title: li.title,
      variantTitle: li.variant_title || '',
      sku: li.sku || '',
      quantity: li.quantity
    })) : [];

    res.json({
      found: !!(emailMatch || zipMatch),
      emailMatch,
      zipMatch,
      order: { id: order.id, name: order.name, hasEmail: !!order.email, hasZip: !!order.shipping_address?.zip },
      items
    });
  } catch (err) {
    console.error('validate-order error:', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------- Root ----------
app.get('/', (req, res) => {
  const shop = (req.query.shop || '').toString();
  if (shop && shop.endsWith('.myshopify.com')) {
    return res.redirect(`/auth?shop=${encodeURIComponent(shop)}`);
  }
  res.json({
    message: 'Shopify OAuth App (multi-store)',
    endpoints: {
      auth: 'GET /auth?shop=<shop>.myshopify.com',
      callback: 'GET /auth/callback',
      validate: 'POST /api/validate-order',
      health: 'GET /api/health',
    },
  });
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on ${PORT}`);
  console.log(`🌐 Host: ${HOST}`);
});
