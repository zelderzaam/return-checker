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

app.post('/api/validate-order', async (req, res) => {
  const { orderNumber, emailOrZip } = req.body;

  if (!orderNumber || !emailOrZip) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    const response = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?name=%23${orderNumber}`,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );

    const orders = response.data.orders;
    if (orders.length === 0) {
      return res.json({ found: false });
    }

    const order = orders[0];
    const match =
      order.email?.toLowerCase() === emailOrZip.toLowerCase() ||
      order.shipping_address?.zip?.replace(/\s/g, '') === emailOrZip.replace(/\s/g, '');

    res.json({ found: match });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Error validating order' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
