const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ── Database Connection ──
const db = mysql.createPool({
  host:                process.env.DB_HOST,
  port:                process.env.DB_PORT,
  user:                process.env.DB_USER,
  password:            process.env.DB_PASSWORD,
  database:            process.env.DB_NAME,
  waitForConnections:  true,
  connectionLimit:     10,
  queueLimit:          0,
});

console.log('Database pool created successfully');

// ────────────────────────────────────────
// ROUTE 1: GET /shoes
// Returns all shoes from the catalogue
// Flutter calls this to build the product grid
// Only returns fields the app needs to display
// ────────────────────────────────────────
app.get('/shoes', (req, res) => {
  const query = `
    SELECT id, name, price, image, description, stock_quantity
    FROM shoes
  `;
  db.query(query, (err, results) => {
    if (err) { res.status(500).json({ error: err.message }); return; }
    res.json(results);
  });
});

// ────────────────────────────────────────
// ROUTE 2: POST /orders
// Called when user checks out their cart
// Expects: { user_id, items: [{shoe_id, name, quantity, unit_price}] }
// Does 4 things in sequence:
//   1. Creates one row in orders table
//   2. Creates one row per item in order_items
//   3. Updates stock_quantity and sales stats in shoes
//   4. Creates one row in financials with profit calculation
// ────────────────────────────────────────
app.post('/orders', (req, res) => {
  const { user_id, items } = req.body;

  // Basic validation
  if (!user_id || !items || items.length === 0) {
    res.status(400).json({ error: 'user_id and items are required' });
    return;
  }

  // Step 1: Create the order header
  db.query(
    'INSERT INTO orders (user_id) VALUES (?)',
    [user_id],
    (err, orderResult) => {
      if (err) { res.status(500).json({ error: err.message }); return; }

      const order_id = orderResult.insertId;
      let totalRevenue = 0;
      let totalCost = 0;
      let itemsProcessed = 0;
      let hasError = false;

      // Step 2: Insert each cart item into order_items
      items.forEach((item) => {
        const subtotal = item.unit_price * item.quantity;
        totalRevenue += subtotal;

        // Insert into order_items
        db.query(
          'INSERT INTO order_items (order_id, shoe_id, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?)',
          [order_id, item.shoe_id, item.quantity, item.unit_price, subtotal],
          (err) => {
            if (err && !hasError) { hasError = true; res.status(500).json({ error: err.message }); return; }

            // Step 3: Update shoes table — decrement stock, increment sales stats
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

                // Fetch cost_price to calculate profit
                db.query(
                  'SELECT cost_price FROM shoes WHERE id = ?',
                  [item.shoe_id],
                  (err, shoeResult) => {
                    if (err && !hasError) { hasError = true; res.status(500).json({ error: err.message }); return; }
                    totalCost += shoeResult[0].cost_price * item.quantity;
                    itemsProcessed++;

                    // Step 4: Once all items processed, insert financials
                    if (itemsProcessed === items.length && !hasError) {
                      const profit = totalRevenue - totalCost;
                      db.query(
                        'INSERT INTO financials (order_id, total_revenue, total_cost, profit) VALUES (?, ?, ?, ?)',
                        [order_id, totalRevenue, totalCost, profit],
                        (err) => {
                          if (err) { res.status(500).json({ error: err.message }); return; }

                          // Update order status to completed
                          db.query('UPDATE orders SET status = ? WHERE id = ?', ['completed', order_id]);

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
                  }
                );
              }
            );
          }
        );
      });
    }
  );
});

// ────────────────────────────────────────
// ROUTE 3: DELETE /orders/:id
// Cancels an order by deleting it from the database
// Does 4 things in sequence:
//   1. Fetches order items to know what stock to restore
//   2. Restores stock_quantity and sales stats in shoes
//   3. Deletes order_items, financials rows
//   4. Deletes the order row itself
// ────────────────────────────────────────
app.delete('/orders/:id', (req, res) => {
  const order_id = req.params.id;

  // Step 1: Get all items in this order before deleting
  db.query(
    'SELECT * FROM order_items WHERE order_id = ?',
    [order_id],
    (err, items) => {
      if (err) { res.status(500).json({ error: err.message }); return; }
      if (items.length === 0) {
        res.status(404).json({ error: 'Order not found' });
        return;
      }

      let itemsProcessed = 0;

      // Step 2: Restore stock and sales stats for each shoe
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

            // Once all shoes restored, delete the order records
            if (itemsProcessed === items.length) {

              // Step 3a: Delete financials
              db.query(
                'DELETE FROM financials WHERE order_id = ?',
                [order_id],
                (err) => {
                  if (err) { res.status(500).json({ error: err.message }); return; }

                  // Step 3b: Delete order_items
                  db.query(
                    'DELETE FROM order_items WHERE order_id = ?',
                    [order_id],
                    (err) => {
                      if (err) { res.status(500).json({ error: err.message }); return; }

                      // Step 4: Delete the order itself
                      db.query(
                        'DELETE FROM orders WHERE id = ?',
                        [order_id],
                        (err) => {
                          if (err) { res.status(500).json({ error: err.message }); return; }

                          res.json({
                            message: 'Order cancelled successfully',
                            order_id: order_id
                          });
                        }
                      );
                    }
                  );
                }
              );
            }
          }
        );
      });
    }
  );
});

// ── Start Server ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});