// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');

const app = express();

// Middleware
app.use(cors());         // allows Flutter to call this API
app.use(express.json()); // allows API to read JSON data sent from Flutter

// --- DATABASE CONNECTION ---
const db = mysql.createConnection({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
db.connect((err) => {
  if (err) {
    console.log('Database connection failed:', err.message);
    return;
  }
  console.log('Connected to MySQL database successfully');
});

// --- ROUTES ---

// Route 1: GET all shoes
// Flutter calls this to load the product list
app.get('/shoes', (req, res) => {
  const query = 'SELECT * FROM shoes';
  db.query(query, (err, results) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(results); // sends shoes list as JSON to Flutter
  });
});

// Route 2: POST a new order
// Flutter calls this when user checks out
app.post('/orders', (req, res) => {
  const { shoe_name, shoe_price, quantity, total_price } = req.body;
  const query = 'INSERT INTO orders (shoe_name, shoe_price, quantity, total_price) VALUES (?, ?, ?, ?)';
  db.query(query, [shoe_name, shoe_price, quantity, total_price], (err, results) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ message: 'Order placed successfully', orderId: results.insertId });
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});