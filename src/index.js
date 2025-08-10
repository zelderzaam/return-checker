require('dotenv').config();
const express = require('express');
const { shopifyApi, LATEST_API_VERSION, ApiVersion } = require('@shopify/shopify-api');

const app = express();
app.use(express.json());

const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SCOPES,
  HOST,
  PORT = 3000,
} = process.env;

['SHOPIFY_API_KEY','SHOPIFY_API_SECRET','SCOPES','HOST'].forEach(k => {
  if (!process.env[k]) {
    console.error(`❌ Missing env: ${k}`);
  }
});

const shopify = shopifyApi({
  apiKey: SHOPIFY_API_KEY,
  apiSecretKey: SHOPIFY_API_SECRET,
  scopes: (SCOPES || '').split(',').map(s => s.trim()).filter(Boolean),
  hostName: HOST.replace(/^https?:\/\//, ''),
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false,
});

const tokenStore = new Map();
function saveToken(shop, token) {
  tokenStore.set(shop, token);
}
function getToken(shop) {
  return tokenStore.get(shop);
}

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const normalize = (s) => (s || '').trim().toLowerCase();
const normalizeZip = (s) => (s || '').replace(/\s/g, '').trim().toLowerCase();
const cleanOrderNumber = (n) => (n || '').toString().replace(/^#/, '');

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
    const { session } = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });
    saveToken(session.shop, session.accessToken);
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

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    time: new Date().toISOString(),
    env: {
      apiKey: !!SHOPIFY_API_KEY,
      apiSecret: !!SHOPIFY_API_SECRET,
      host: HOST,
      scopes: SCOPES,
    },
    installedShops: Array.from(tokenStore.keys()),
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
    const accessToken = getToken(shop);
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
        }
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
    if (!order) {
      return res.json({ found: false, reason: 'order_not_found' });
    }
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
      order: { name: order.name, hasEmail: !!order.email, hasZip: !!order.shipping_address?.zip }
    });
  } catch (err) {
    console.error('validate-order error:', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({
    message: 'Shopify OAuth App (multi-store)',
    endpoints: {
      auth: 'GET /auth?shop=<shop>.myshopify.com',
      callback: 'GET /auth/callback',
      validate: 'POST /api/validate-order',
      health: 'GET /api/health'
    }
  });
});
app.listen(PORT, () => {
  console.log(`✅ Server listening on ${PORT}`);
  console.log(`🌐 Host: ${HOST}`);
});
