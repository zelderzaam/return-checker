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

// Helper to clean order number
function cleanOrderNumber(orderNumber) {
  return orderNumber?.toString().replace(/^#/, '') || '';
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

  const cleanedOrderNumber = cleanOrderNumber(orderNumber);
  console.log(`🔍 Searching for order: "${cleanedOrderNumber}"`);
  console.log(`🏪 Using store: ${SHOPIFY_STORE}`);

  let order = null;

  // --- Approach 1: Search with # prefix ---
  try {
    console.log('🔍 Approach 1: Searching with # prefix...');
    const response = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?name=${encodeURIComponent('#' + cleanedOrderNumber)}&status=any`,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );
    if (response.data.orders.length > 0) {
      order = response.data.orders[0];
      console.log('✅ Order found via approach 1');
      console.log('🧾 Full order data:', JSON.stringify(order, null, 2));
    }
  } catch (err) {
    console.log('⚠️ Approach 1 failed:', err.response?.data || err.message);
  }

  // --- Approach 2: Without # prefix ---
  if (!order) {
    try {
      console.log('🔍 Approach 2: Searching without # prefix...');
      const response = await axios.get(
        `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?name=${encodeURIComponent(cleanedOrderNumber)}&status=any`,
        {
          headers: {
            'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            'Content-Type': 'application/json',
          },
        }
      );
      if (response.data.orders.length > 0) {
        order = response.data.orders[0];
        console.log('✅ Order found via approach 2');
        console.log('🧾 Full order data:', JSON.stringify(order, null, 2));
      }
    } catch (err) {
      console.log('⚠️ Approach 2 failed:', err.response?.data || err.message);
    }
  }

  // --- Approach 3: Fallback scan of recent orders ---
  if (!order) {
    try {
      console.log('🔍 Approach 3: Scanning recent orders...');
      const response = await axios.get(
        `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?limit=250&status=any&fields=name,email,shipping_address`,
        {
          headers: {
            'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            'Content-Type': 'application/json',
          },
        }
      );
      order = response.data.orders.find(o => {
        const orderName = o.name || '';
        const cleanName = orderName.replace(/^#/, '');
        return cleanName === cleanedOrderNumber || orderName === '#' + cleanedOrderNumber;
      });
      if (order) {
        console.log('✅ Order found via approach 3');
        console.log('🧾 Full order data:', JSON.stringify(order, null, 2));
      }
    } catch (err) {
      console.log('⚠️ Approach 3 failed:', err.response?.data || err.message);
    }
  }

  // --- Final validation ---
  if (!order) {
    console.log('❌ Order not found after all attempts');
    return res.json({ found: false });
  }

  // Extract and normalize for comparison
  const orderEmail = order.email?.toLowerCase() || '';
  const orderZip = order.shipping_address?.zip?.replace(/\s/g, '').toLowerCase() || '';
  const providedEmail = emailOrZip.toLowerCase();
  const providedZip = emailOrZip.replace(/\s/g, '').toLowerCase();

  const emailMatch = orderEmail === providedEmail;
  const zipMatch = orderZip === providedZip;

  console.log('📧 Email comparison:', orderEmail, '===', providedEmail, '→', emailMatch);
  console.log('📮 ZIP comparison:', orderZip, '===', providedZip, '→', zipMatch);
  console.log('🧾 Full order object:\n', JSON.stringify(order, null, 2));

  const match = emailMatch || zipMatch;

  if (match) {
    console.log('✅ Validation successful');
  } else {
    console.log('❌ Validation failed - no email or ZIP match');
  }

  res.json({ found: match });
});

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: {
      store: SHOPIFY_STORE || '❌ Missing',
      token: SHOPIFY_ACCESS_TOKEN ? '✅ Set' : '❌ Missing'
    }
  });
});

// Root
app.get('/', (req, res) => {
  res.json({
    message: 'Shopify Return API',
    endpoints: {
      validate: 'POST /api/validate-order',
      health: 'GET /api/health'
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`🏪 Connected to: ${SHOPIFY_STORE}`);
});
