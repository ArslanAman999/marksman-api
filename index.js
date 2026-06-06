const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ── Database Connection ──
const db = mysql.createPool({
  host:               process.env.DB_HOST,
  port:               process.env.DB_PORT,
  user:               process.env.DB_USER,
  password:           process.env.DB_PASSWORD,
  database:           process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
});

console.log('Database pool created successfully');

// ────────────────────────────────────────
// ROUTE 1: GET /shoes
// ────────────────────────────────────────
app.get('/shoes', (req, res) => {
  db.query('SELECT id, name, price, image, description, stock_quantity FROM shoes', (err, results) => {
    if (err) { res.status(500).json({ error: err.message }); return; }
    res.json(results);
  });
});

// ────────────────────────────────────────
// ROUTE 2: GET /orders/user/:user_id
// Must be defined BEFORE /orders/:id to avoid route conflict
// ────────────────────────────────────────
app.get('/orders/user/:user_id', (req, res) => {
  const user_id = req.params.user_id;
  db.query(
    `SELECT
      oh.id,
      oh.order_id,
      oh.total_items,
      oh.total_spent,
      oh.status,
      oh.created_at,
      GROUP_CONCAT(s.name SEPARATOR ', ') as item_names
    FROM order_history oh
    JOIN order_items oi ON oh.order_id = oi.order_id
    JOIN shoes s ON oi.shoe_id = s.id
    WHERE oh.user_id = ?
    GROUP BY oh.order_id
    ORDER BY oh.created_at DESC`,
    [user_id],
    (err, results) => {
      if (err) { res.status(500).json({ error: err.message }); return; }
      res.json(results);
    }
  );
});

// ────────────────────────────────────────
// ROUTE 3: POST /orders
// ────────────────────────────────────────
app.post('/orders', (req, res) => {
  const { user_id, items } = req.body;

  if (!user_id || !items || items.length === 0) {
    res.status(400).json({ error: 'user_id and items are required' });
    return;
  }

  // Step 1: Create order header
  db.query('INSERT INTO orders (user_id) VALUES (?)', [user_id], (err, orderResult) => {
    if (err) { res.status(500).json({ error: err.message }); return; }

    const order_id = orderResult.insertId;
    let totalRevenue = 0;
    let totalCost = 0;
    let itemsProcessed = 0;
    let hasError = false;

    // Step 2: Process each cart item
    items.forEach((item) => {
      const subtotal = item.unit_price * item.quantity;
      totalRevenue += subtotal;

      // Insert into order_items
      db.query(
        'INSERT INTO order_items (order_id, shoe_id, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?)',
        [order_id, item.shoe_id, item.quantity, item.unit_price, subtotal],
        (err) => {
          if (err && !hasError) { hasError = true; res.status(500).json({ error: err.message }); return; }

          // Step 3: Update shoe stock and sales stats
          db.query(
            `UPDATE shoes SET
              stock_quantity       = stock_quantity - ?,
              total_units_sold     = total_units_sold + ?,
              total_revenue_earned = total_revenue_earned + ?,
              sold_out_at          = CASE WHEN (stock_quantity - ?) <= 0 THEN NOW() ELSE sold_out_at END
            WHERE id = ?`,
            [item.quantity, item.quantity, subtotal, item.quantity, item.shoe_id],
            (err) => {
              if (err && !hasError) { hasError = true; res.status(500).json({ error: err.message }); return; }

              // Fetch cost_price for profit calculation
              db.query('SELECT cost_price FROM shoes WHERE id = ?', [item.shoe_id], (err, shoeResult) => {
                if (err && !hasError) { hasError = true; res.status(500).json({ error: err.message }); return; }
                totalCost += shoeResult[0].cost_price * item.quantity;
                itemsProcessed++;

                // Step 4: Once all items processed
                if (itemsProcessed === items.length && !hasError) {
                  const profit = totalRevenue - totalCost;

                  // Insert financials
                  db.query(
                    'INSERT INTO financials (order_id, total_revenue, total_cost, profit) VALUES (?, ?, ?, ?)',
                    [order_id, totalRevenue, totalCost, profit],
                    (err) => {
                      if (err) { res.status(500).json({ error: err.message }); return; }

                      // Insert order_history
                      db.query(
                        'INSERT INTO order_history (user_id, order_id, total_items, total_spent, status) VALUES (?, ?, ?, ?, ?)',
                        [user_id, order_id, items.length, totalRevenue, 'pending'],
                        (err) => {
                          if (err) { res.status(500).json({ error: err.message }); return; }

                          // Update user analytics
                          db.query(
                            'UPDATE users SET total_orders = total_orders + 1, total_spent = total_spent + ?, last_order_at = NOW() WHERE id = ?',
                            [totalRevenue, user_id],
                            (err) => {
                              if (err) { res.status(500).json({ error: err.message }); return; }

                              res.json({
                                message: 'Order placed successfully',
                                order_id,
                                total_revenue: totalRevenue,
                                total_cost: totalCost,
                                profit
                              });
                            }
                          );
                        }
                      );
                    }
                  );
                }
              });
            }
          );
        }
      );
    });
  });
});

// ────────────────────────────────────────
// ROUTE 4: DELETE /orders/:id
// ────────────────────────────────────────
app.delete('/orders/:id', (req, res) => {
  const order_id = req.params.id;

  // Step 1: Get order items to restore stock
  db.query('SELECT * FROM order_items WHERE order_id = ?', [order_id], (err, items) => {
    if (err) { res.status(500).json({ error: err.message }); return; }
    if (items.length === 0) { res.status(404).json({ error: 'Order not found' }); return; }

    let itemsProcessed = 0;

    // Step 2: Restore stock for each shoe
    items.forEach((item) => {
      db.query(
        `UPDATE shoes SET
          stock_quantity       = stock_quantity + ?,
          total_units_sold     = total_units_sold - ?,
          total_revenue_earned = total_revenue_earned - ?,
          sold_out_at          = NULL
        WHERE id = ?`,
        [item.quantity, item.quantity, item.subtotal, item.shoe_id],
        (err) => {
          if (err) { res.status(500).json({ error: err.message }); return; }
          itemsProcessed++;

          if (itemsProcessed === items.length) {

            // Step 3: Get order_history for user analytics reversal
            db.query('SELECT * FROM order_history WHERE order_id = ?', [order_id], (err, historyRows) => {
              if (err) { res.status(500).json({ error: err.message }); return; }
              const history = historyRows[0];

              // Step 4: Delete financials
              db.query('DELETE FROM financials WHERE order_id = ?', [order_id], (err) => {
                if (err) { res.status(500).json({ error: err.message }); return; }

                // Step 5: Delete order_items
                db.query('DELETE FROM order_items WHERE order_id = ?', [order_id], (err) => {
                  if (err) { res.status(500).json({ error: err.message }); return; }

                  // Step 6: Delete order_history
                  db.query('DELETE FROM order_history WHERE order_id = ?', [order_id], (err) => {
                    if (err) { res.status(500).json({ error: err.message }); return; }

                    // Step 7: Reverse user analytics
                    db.query(
                      'UPDATE users SET total_orders = total_orders - 1, total_spent = total_spent - ? WHERE id = ?',
                      [history.total_spent, history.user_id],
                      (err) => {
                        if (err) { res.status(500).json({ error: err.message }); return; }

                        // Step 8: Delete the order itself
                        db.query('DELETE FROM orders WHERE id = ?', [order_id], (err) => {
                          if (err) { res.status(500).json({ error: err.message }); return; }
                          res.json({ message: 'Order cancelled successfully', order_id });
                        });
                      }
                    );
                  });
                });
              });
            });
          }
        }
      );
    });
  });
});

// ── Start Server ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});