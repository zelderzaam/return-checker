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

app.post('/api/validate-order', async (req, res) => {
  const { orderNumber, emailOrZip } = req.body;

  if (!orderNumber || !emailOrZip) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  // Validate environment variables
  if (!SHOPIFY_STORE || !SHOPIFY_ACCESS_TOKEN) {
    console.error('❌ Missing environment variables');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    // Clean the order number (remove # if present)
    const cleanedOrderNumber = cleanOrderNumber(orderNumber);
    console.log(`🔍 Searching for order: "${cleanedOrderNumber}" (original: "${orderNumber}")`);
    console.log(`🏪 Using store: ${SHOPIFY_STORE}`);

    let order = null;
    
    // Approach 1: Search with # prefix (most reliable for Shopify)
    console.log('🔍 Approach 1: Searching with # prefix...');
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

    // Approach 2: Search without # prefix (fallback)
    if (!order) {
      console.log('🔍 Approach 2: Searching without # prefix...');
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

    // Approach 3: Manual search through recent orders (last resort)
    if (!order) {
      console.log('🔍 Approach 3: Manual search through recent orders...');
      try {
        const response = await axios.get(
          `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?name=${encodeURIComponent(cleanedOrderNumber)}&status=any&fields=name,email,shipping_address`,
          {
            headers: {
              'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
              'Content-Type': 'application/json',
            },
          }
        );
        
        console.log(`📊 Searching through ${response.data.orders.length} recent orders`);
        
        // Look for order with matching name
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

    // If no order found after all attempts
    if (!order) {
      console.log('❌ Order not found after all search attempts');
      return res.json({ found: false });
    }

    console.log('✅ Order found:', {
      name: order.name,
      email: order.email,
      zip: order.shipping_address?.zip
    });

    // Validate email or ZIP
    console.log('🔍 Validating email/ZIP...');
    const orderEmail = order.email?.toLowerCase() || '';
    const orderZip = order.shipping_address?.zip?.replace(/\s/g, '') || '';
    const providedEmail = emailOrZip.toLowerCase();
    const providedZip = emailOrZip.replace(/\s/g, '');

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
      shopifyStore: '2s0gry-ap.myshopify.com' ? '✅ Set' : '❌ Missing',
      accessToken: SHOPIFY_ACCESS_TOKEN ? '✅ Set' : '❌ Missing'
    },
    config: {
      store: '2s0gry-ap.myshopify.com',
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
  console.log(`🏪 Connected to Shopify store: 2s0gry-ap.myshopify.com`);
  console.log(`🔑 Access token: ${SHOPIFY_ACCESS_TOKEN ? 'Configured' : 'Missing'}`);
});