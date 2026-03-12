/**
 * db.js — In-memory store with JSON persistence + Fuse.js fuzzy search
 *
 * Stores everything in /data/products.json so the server can restart
 * without re-fetching. File is replaced atomically every 2 hours.
 */

const fs = require('fs');
const path = require('path');
const Fuse = require('fuse.js');

const DATA_FILE = path.join(__dirname, '../data/products.json');
const META_FILE = path.join(__dirname, '../data/meta.json');

// Regional price multipliers (same logic as before)
const REGIONAL_MULTIPLIERS = {
  ramiLevy: {
    'tel-aviv': 1.00, 'jerusalem': 0.97, 'haifa': 0.98,
    'beer-sheva': 0.95, 'rishon': 0.99, 'petah-tikva': 0.99,
    'netanya': 1.01, 'ashdod': 0.97, 'rehovot': 1.00, 'holon': 0.99,
  },
  osherAd: {
    'tel-aviv': 1.02, 'jerusalem': 0.98, 'haifa': 0.99,
    'beer-sheva': 0.96, 'rishon': 1.00, 'petah-tikva': 1.00,
    'netanya': 1.02, 'ashdod': 0.98, 'rehovot': 1.01, 'holon': 1.00,
  },
};

class Database {
  constructor() {
    this.products = {}; // barcode → product
    this.meta = {};
    this.fuse = null;
    this._load();
  }

  _load() {
    // Load products
    if (fs.existsSync(DATA_FILE)) {
      try {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        const list = JSON.parse(raw);
        this.products = {};
        for (const p of list) this.products[p.barcode] = p;
        this._buildIndex();
        console.log(`💾 Loaded ${list.length} products from disk`);
      } catch (e) {
        console.warn('Could not load products from disk:', e.message);
      }
    }
    // Load meta
    if (fs.existsSync(META_FILE)) {
      try {
        this.meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
      } catch {}
    }
  }

  _buildIndex() {
    const list = Object.values(this.products);
    this.fuse = new Fuse(list, {
      keys: [
        { name: 'name', weight: 0.6 },
        { name: 'barcode', weight: 0.3 },
        { name: 'category', weight: 0.1 },
        { name: 'manufacturerName', weight: 0.1 },
      ],
      threshold: 0.4,         // 0=exact, 1=match anything
      includeScore: true,
      minMatchCharLength: 2,
      useExtendedSearch: true, // allows !term, 'exact, ^start
    });
  }

  saveProducts(list) {
    this.products = {};
    for (const p of list) this.products[p.barcode] = p;
    this._buildIndex();
    // Ensure data dir exists
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    // Write atomically (temp file then rename)
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
    console.log(`💾 Saved ${list.length} products to disk`);
  }

  saveMeta(meta) {
    this.meta = meta;
    fs.mkdirSync(path.dirname(META_FILE), { recursive: true });
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf8');
  }

  getMeta() { return this.meta; }

  getProduct(barcode) {
    return this.products[barcode] || null;
  }

  getCategories() {
    const cats = new Set(Object.values(this.products).map(p => p.category));
    return Array.from(cats).sort();
  }

  searchProducts(query, { limit = 30, category } = {}) {
    let list;

    if (!query || query.trim().length === 0) {
      list = Object.values(this.products);
    } else {
      // If it looks like a barcode (all digits), do exact lookup
      if (/^\d{4,}$/.test(query.trim())) {
        const exact = this.products[query.trim()];
        list = exact ? [exact] : [];
        // Also try barcode prefix
        if (!list.length) {
          list = Object.values(this.products).filter(p => p.barcode.startsWith(query.trim()));
        }
      } else {
        // Fuzzy text search
        const results = this.fuse ? this.fuse.search(query) : [];
        list = results.map(r => r.item);
      }
    }

    // Filter by category
    if (category && category !== 'הכל') {
      list = list.filter(p => p.category === category);
    }

    // Slice
    return list.slice(0, limit).map(p => this._enrichProduct(p));
  }

  _enrichProduct(p) {
    return {
      ...p,
      availability: this._getAvailability(p),
    };
  }

  _getAvailability(p) {
    const inRami = p.prices?.ramiLevy != null;
    const inOsher = p.prices?.osherAd != null;
    if (inRami && inOsher) return 'both';
    if (inRami) return 'ramiOnly';
    if (inOsher) return 'osherOnly';
    return 'none';
  }

  compareCart(barcodes, region = 'tel-aviv') {
    const items = [];
    let ramiTotal = 0;
    let osherTotal = 0;

    for (const barcode of barcodes) {
      const p = this.products[barcode];
      if (!p) continue;

      const ramiBase = p.prices?.ramiLevy;
      const osherBase = p.prices?.osherAd;
      const ramiMult = REGIONAL_MULTIPLIERS.ramiLevy[region] ?? 1;
      const osherMult = REGIONAL_MULTIPLIERS.osherAd[region] ?? 1;

      const ramiPrice = ramiBase ? +(ramiBase * ramiMult).toFixed(2) : null;
      const osherPrice = osherBase ? +(osherBase * osherMult).toFixed(2) : null;

      items.push({
        barcode,
        name: p.name,
        image: p.image,
        category: p.category,
        ramiPrice,
        osherPrice,
        availability: this._getAvailability(p),
      });

      if (ramiPrice) ramiTotal += ramiPrice;
      if (osherPrice) osherTotal += osherPrice;
    }

    const winner = ramiTotal > 0 && osherTotal > 0
      ? (ramiTotal <= osherTotal ? 'ramiLevy' : 'osherAd')
      : ramiTotal > 0 ? 'ramiLevy' : 'osherAd';

    return {
      items,
      totals: {
        ramiLevy: +ramiTotal.toFixed(2),
        osherAd: +osherTotal.toFixed(2),
      },
      winner,
      saving: +Math.abs(ramiTotal - osherTotal).toFixed(2),
      region,
    };
  }
}

let instance = null;
function getDb() {
  if (!instance) instance = new Database();
  return instance;
}

module.exports = { getDb };
