const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

// Helper function to clean order number
function cleanOrderNumber(orderNumber) {
  if (!orderNumber) return '';
  return orderNumber.toString().replace(/^#/, '');
}

// Normalization helpers
function normalize(str) {
  return (str || '').trim().toLowerCase();
}

function normalizeZip(str) {
  return (str || '').replace(/\s/g, '').trim().toLowerCase();
}

app.post('/api/validate-order', async (req, res) => {
  const { orderNumber, emailOrZip } = req.body;

  if (!orderNumber || !emailOrZip) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  if (!SHOPIFY_STORE || !SHOPIFY_ACCESS_TOKEN) {
    console.error('❌ Missing environment variables');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    const cleanedOrderNumber = cleanOrderNumber(orderNumber);
    console.log(`🔍 Searching for order: "${cleanedOrderNumber}" (original: "${orderNumber}")`);
    console.log(`🏪 Using store: ${SHOPIFY_STORE}`);

    let order = null;

    // Approach 1: Search with # prefix
    try {
      const response = await axios.get(
        `https://2s0gry-ap.myshopify.com/admin/api/2024-01/orders.json?name=${encodeURIComponent('#' + cleanedOrderNumber)}&status=any`,
        {
          headers: {
            'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            'Content-Type': 'application/json',
          },
        }
      );
      console.log(`📊 Found ${response.data.orders.length} orders with approach 1`);
      if (response.data.orders.length > 0) {
        order = response.data.orders[0];
        console.log('✅ Order found via approach 1');
      }
    } catch (err) {
      console.log('⚠️ Approach 1 failed:', err.response?.data || err.message);
    }

    // Approach 2: Search without # prefix
    if (!order) {
      try {
        const response = await axios.get(
          `https://2s0gry-ap.myshopify.com/admin/api/2024-01/orders.json?name=${encodeURIComponent(cleanedOrderNumber)}&status=any`,
          {
            headers: {
              'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
              'Content-Type': 'application/json',
            },
          }
        );
        console.log(`📊 Found ${response.data.orders.length} orders with approach 2`);
        if (response.data.orders.length > 0) {
          order = response.data.orders[0];
          console.log('✅ Order found via approach 2');
        }
      } catch (err) {
        console.log('⚠️ Approach 2 failed:', err.response?.data || err.message);
      }
    }

    // Approach 3: Manual search through recent orders
    if (!order) {
      try {
        const response = await axios.get(
          `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?limit=250&status=any`,
          {
            headers: {
              'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
              'Content-Type': 'application/json',
            },
          }
        );
        console.log(`📊 Searching through ${response.data.orders.length} recent orders`);

        order = response.data.orders.find(o => {
          const orderName = o.name || '';
          const cleanOrderName = orderName.replace(/^#/, '');
          return cleanOrderName === cleanedOrderNumber || orderName === '#' + cleanedOrderNumber;
        });

        if (order) {
          console.log('✅ Order found via approach 3');
        }
      } catch (err) {
        console.log('⚠️ Approach 3 failed:', err.response?.data || err.message);
      }
    }

    if (!order) {
      console.log('❌ Order not found after all search attempts');
      return res.json({ found: false });
    }

    console.log('✅ Order found:', {
      name: order.name,
      email: order.email,
      zip: order.shipping_address?.zip
    });

    // Normalize input
    const orderEmail = normalize(order.email);
    const orderZip = normalizeZip(order.shipping_address?.zip);
    const providedEmail = normalize(emailOrZip);
    const providedZip = normalizeZip(emailOrZip);

    const emailMatch = orderEmail === providedEmail;
    const zipMatch = orderZip === providedZip;

    console.log('📧 Email comparison:', orderEmail, '===', providedEmail, '→', emailMatch);
    console.log('📮 ZIP comparison:', orderZip, '===', providedZip, '→', zipMatch);
    console.log('🔍 Raw order object:', JSON.stringify(order, null, 2));

    const match = emailMatch || zipMatch;

    if (match) {
      console.log('✅ Validation successful');
    } else {
      console.log('❌ Validation failed - no email or ZIP match');
    }

    res.json({ found: match });

  } catch (err) {
    console.error('🔴 Unexpected error:', err);
    console.error('🔴 Error details:', err.response?.data);
    console.error('🔴 Error status:', err.response?.status);
    console.error('🔴 Error headers:', err.response?.headers);
    res.status(500).json({ error: 'Error validating order' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: {
      shopifyStore: SHOPIFY_STORE ? '✅ Set' : '❌ Missing',
      accessToken: SHOPIFY_ACCESS_TOKEN ? '✅ Set' : '❌ Missing'
    },
    config: {
      store: SHOPIFY_STORE,
      tokenPrefix: SHOPIFY_ACCESS_TOKEN ? SHOPIFY_ACCESS_TOKEN.substring(0, 10) + '...' : 'Not set'
    }
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Shopify Return Form API Server',
    status: 'running',
    endpoints: {
      validate: 'POST /api/validate-order',
      health: 'GET /api/health'
    }
  });
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`🏪 Connected to Shopify store: ${SHOPIFY_STORE}`);
  console.log(`🔑 Access token: ${SHOPIFY_ACCESS_TOKEN ? 'Configured' : 'Missing'}`);
});
