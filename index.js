const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

// Example dummy orders
const dummyOrders = [
  { orderNumber: '1001', emailOrZip: 'example@mail.com' },
  { orderNumber: '1002', emailOrZip: '1011AB' },
];

app.post('/api/validate-order', (req, res) => {
  const { orderNumber, emailOrZip } = req.body;

  if (!orderNumber || !emailOrZip) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const found = dummyOrders.find(order =>
    order.orderNumber === orderNumber && order.emailOrZip.toLowerCase() === emailOrZip.toLowerCase()
  );

  if (found) {
    res.json({ found: true });
  } else {
    res.json({ found: false });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
