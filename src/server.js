require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const cron = require('node-cron');
const path = require('path');
const { fetchAllPrices } = require('./fetchPrices');
const { getDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── API Routes ──────────────────────────────────────────────

// GET /api/products?q=חלב&limit=20
// Full-text search across all products from both stores
app.get('/api/products', (req, res) => {
  const { q = '', limit = 30, category } = req.query;
  const db = getDb();
  const results = db.searchProducts(q, { limit: parseInt(limit), category });
  res.json({ ok: true, results, total: results.length });
});

// GET /api/product/:barcode
// Full product detail with prices from both stores + image
app.get('/api/product/:barcode', (req, res) => {
  const db = getDb();
  const product = db.getProduct(req.params.barcode);
  if (!product) return res.status(404).json({ ok: false, error: 'Product not found' });
  res.json({ ok: true, product });
});

// GET /api/cart/compare?barcodes=xxx,yyy,zzz&region=tel-aviv
// Compare total price for a list of barcodes across stores
app.get('/api/cart/compare', (req, res) => {
  const { barcodes = '', region = 'tel-aviv' } = req.query;
  const db = getDb();
  const list = barcodes.split(',').map(b => b.trim()).filter(Boolean);
  const comparison = db.compareCart(list, region);
  res.json({ ok: true, comparison });
});

// GET /api/categories
app.get('/api/categories', (req, res) => {
  const db = getDb();
  res.json({ ok: true, categories: db.getCategories() });
});

// GET /api/status
app.get('/api/status', (req, res) => {
  const db = getDb();
  const meta = db.getMeta();
  res.json({
    ok: true,
    lastUpdate: meta.lastUpdate,
    productCount: meta.productCount,
    stores: meta.stores,
    nextUpdate: meta.nextUpdate,
  });
});

// POST /api/refresh  (manual trigger, protected)
app.post('/api/refresh', async (req, res) => {
  const secret = req.headers['x-refresh-secret'];
  if (secret !== process.env.REFRESH_SECRET && process.env.NODE_ENV === 'production') {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  res.json({ ok: true, message: 'Refresh started, check /api/status' });
  fetchAllPrices().catch(console.error);
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── Startup ─────────────────────────────────────────────────

async function start() {
  console.log('🛒 סל חכם Server starting...');

  // Initial data load
  const db = getDb();
  const meta = db.getMeta();

  if (!meta.lastUpdate || Date.now() - new Date(meta.lastUpdate).getTime() > 2 * 60 * 60 * 1000) {
    console.log('📦 No fresh data found — fetching prices now...');
    await fetchAllPrices().catch(e => console.error('Initial fetch failed:', e.message));
  } else {
    console.log(`✅ Using cached data from ${meta.lastUpdate} (${meta.productCount} products)`);
  }

  // Schedule refresh every 2 hours
  cron.schedule('0 */2 * * *', async () => {
    console.log('⏰ Scheduled price refresh starting...');
    await fetchAllPrices().catch(e => console.error('Scheduled fetch failed:', e.message));
  });

  app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
    console.log(`📊 API ready at http://localhost:${PORT}/api/status`);
  });
}

start();
