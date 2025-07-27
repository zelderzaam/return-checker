const express = require('express');
const app = express();
const PORT = 3000;

// CORS middleware to allow requests from any origin
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*"); // Allow all origins (for testing)
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204); // Handle preflight
  next();
});

app.use(express.json()); // Middleware to parse JSON body

// Dummy order numbers to simulate validation
const dummyOrders = ['1001', '1002', '1234', '5678'];

// Route for validating order number
app.post('/api/validate-order', (req, res) => {
  const { orderNumber } = req.body;

  if (!orderNumber) {
    return res.status(400).json({ error: "Missing orderNumber" });
  }

  if (dummyOrders.includes(orderNumber)) {
    res.json({ found: true });
  } else {
    res.json({ found: false });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
