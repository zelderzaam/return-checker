// index-multi.js (Multi-store Shopify OAuth app)
require('dotenv').config();
require('@shopify/shopify-api/adapters/node');

const express = require('express');
const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
const Redis = require('ioredis');

const app = express();
app.use(express.json());

const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SCOPES,
  HOST,
  PORT = 3000,
  REDIS_URL, // <— add this in Render env
} = process.env;

// Fail fast if env is missing
['SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET', 'SCOPES', 'HOST'].forEach((k) => {
  if (!process.env[k]) console.error(`❌ Missing env: ${k}`);
});

// ---------- Token Store (Redis if available; memory fallback) ----------
let store;
if (REDIS_URL) {
  const redis = new Redis(REDIS_URL, {
    // Using internal redis:// on Render (no TLS). If you ever use rediss://, TLS is automatic.
    lazyConnect: true,
  });
  redis.on('error', (e) => console.error('Redis error:', e));

  store = {
    async saveToken(shop, token) {
      await redis.set(`shop:token:${shop}`, token);
      await redis.sadd('shops', shop);
    },
    async getToken(shop) {
      return redis.get(`shop:token:${shop}`);
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
    async saveToken(shop, token) {
      mem.set(shop, token);
      shops.add(shop);
    },
    async getToken(shop) {
      return mem.get(shop);
    },
    async listShops() {
      return Array.from(shops);
    },
  };
  console.log('💾 Token store: In-memory (set REDIS_URL to persist)');
}

// Shopify SDK init
const hostName = (HOST || process.env.RENDER_EXTERNAL_URL || '')
  .replace(/^https?:\/\//, '')
  .replace(/\/$/, '');

const shopify = shopifyApi({
  apiKey: SHOPIFY_API_KEY,
  apiSecretKey: SHOPIFY_API_SECRET,
  scopes: (SCOPES || '').split(',').map((s) => s.trim()).filter(Boolean),
  hostName,
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false,
});

// CORS (simple)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Helpers
const normalize = (s) => (s || '').trim().toLowerCase();
const normalizeZip = (s) => (s || '').replace(/\s/g, '').trim().toLowerCase();
const cleanOrderNumber = (n) => (n || '').toString().replace(/^#/, '');

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
      isOnline: false, // offline token
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
    const { session } = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });
    await store.saveToken(session.shop, session.accessToken); // <— now async
    console.log(`✅ Installed on ${session.shop}. Token saved.`);
    res.redirect(`/installed?shop=${encodeURIComponent(session.shop)}`);
  } catch (e) {
    console.error('Auth callback error:', e.response?.data || e.message);
    res.status(500).send('Auth callback failed');
  }
});

app.get('/installed', (req, res) => {
  const shop = req.query.shop;
  res.send(`App installed on ${shop}. You can now use the API. ✅`);
});

// ---------- API ----------
app.get('/api/health', async (req, res) => {
  let installedShops = [];
  try {
    installedShops = await store.listShops();
  } catch (e) {
    console.warn('listShops failed:', e.message);
  }
  res.json({
    status: 'healthy',
    time: new Date().toISOString(),
    env: {
      apiKey: !!SHOPIFY_API_KEY,
      apiSecret: !!SHOPIFY_API_SECRET,
      host: HOST,
      scopes: SCOPES,
      redis: !!REDIS_URL,
    },
    installedShops,
  });
});

app.post('/api/validate-order', async (req, res) => {
  try {
    const { shop, orderNumber, emailOrZip } = req.body || {};
    if (!shop || !shop.endsWith('.myshopify.com')) {
      return res.status(400).json({ error: 'Missing/invalid "shop" (e.g. crossar.myshopify.com)' });
    }
    if (!orderNumber || !emailOrZip) {
      return res.status(400).json({ error: 'Missing fields: orderNumber, emailOrZip' });
    }

    const accessToken = await store.getToken(shop); // <— now async
    if (!accessToken) {
      return res.status(401).json({ error: `Shop ${shop} not authorized. Visit ${HOST}/auth?shop=${shop}` });
    }

    const cleaned = cleanOrderNumber(orderNumber);
    let order = null;

    const doSearch = async (name) => {
      const url = `https://${shop}/admin/api/${LATEST_API_VERSION}/orders.json?name=${encodeURIComponent(name)}&status=any&fields=name,email,shipping_address`;
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
    } catch (e) {
      console.log('Name search (#) failed:', e.message);
    }
    if (!order) {
      try {
        const data = await doSearch(cleaned);
        if (data.orders?.length) order = data.orders[0];
      } catch (e) {
        console.log('Name search (no #) failed:', e.message);
      }
    }

    if (!order) return res.json({ found: false, reason: 'order_not_found' });

    const orderEmail = normalize(order.email);
    const orderZip = normalizeZip(order.shipping_address?.zip);
    const emailIn = normalize(emailOrZip);
    const zipIn = normalizeZip(emailOrZip);

    const emailMatch = orderEmail && orderEmail === emailIn;
    const zipMatch = orderZip && orderZip === zipIn;

    res.json({
      found: !!(emailMatch || zipMatch),
      emailMatch,
      zipMatch,
      order: { name: order.name, hasEmail: !!order.email, hasZip: !!order.shipping_address?.zip },
    });
  } catch (err) {
    console.error('validate-order error:', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------- Root ----------
// If Shopify opens App URL with ?shop=..., kick off OAuth. Otherwise show info.
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
