/**
 * fetchPrices.js
 *
 * ישראל מחייבת רשתות מזון לפרסם מחירים לפי "חוק המזון" (2015).
 * כל רשת מפרסמת קבצי XML עם כל המוצרים שלה.
 *
 * Sources used:
 *  - Rami Levy:  https://url.retail.publishedprices.co.il/file/d/ (XML GZ files)
 *  - Osher Ad:   https://url.retail.publishedprices.co.il/file/d/ (XML GZ files)
 *  - Images:     Open Food Facts API  https://world.openfoodfacts.org/api/v0/product/{barcode}.json
 *
 * The "published prices" portal (publishedprices.co.il) aggregates all chains.
 * Each chain uploads fresh XML every few hours.
 */

const axios = require('axios');
const xml2js = require('xml2js');
const zlib = require('zlib');
const { promisify } = require('util');
const { getDb } = require('./db');

const gunzip = promisify(zlib.gunzip);

// Chain IDs on publishedprices.co.il
const CHAINS = {
  ramiLevy: {
    id: '7290058140886',
    name: 'רמי לוי',
    nameEn: 'Rami Levy',
    color: '#2e7d32',
    // Base URL for the open prices portal
    baseUrl: 'https://url.retail.publishedprices.co.il',
  },
  osherAd: {
    id: '7290055700007',
    name: 'אושר עד',
    nameEn: 'Osher Ad',
    color: '#1565c0',
    baseUrl: 'https://url.retail.publishedprices.co.il',
  },
};

// Fetch list of available price files for a chain
async function fetchFileList(chain) {
  const url = `${chain.baseUrl}/file/json/dir?CHAINID=${chain.id}&type=PriceFull`;
  const resp = await axios.get(url, {
    timeout: 30000,
    headers: { 'User-Agent': 'SalChacham/1.0 (price comparison app)' },
  });
  // Returns array of { FileNm, STOREID, ... }
  return resp.data?.Files || [];
}

// Download and parse a single price XML file
async function downloadAndParse(chain, filename) {
  const url = `${chain.baseUrl}/file/d/?fname=${filename}`;
  const resp = await axios.get(url, {
    timeout: 60000,
    responseType: 'arraybuffer',
    headers: { 'User-Agent': 'SalChacham/1.0' },
  });

  let xmlBuffer = Buffer.from(resp.data);

  // Decompress if gzipped
  if (filename.endsWith('.gz')) {
    xmlBuffer = await gunzip(xmlBuffer);
  }

  const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: true });
  const parsed = await parser.parseStringPromise(xmlBuffer.toString('utf8'));

  // Structure varies slightly between chains — normalize
  const root = parsed?.Root || parsed?.root;
  const items = root?.Items?.Item || root?.Products?.Product || [];
  return Array.isArray(items) ? items : [items];
}

// Normalize a raw XML item into our product schema
function normalizeItem(item, chainKey, storeId) {
  const barcode = (item.ItemCode || item.Barcode || '').toString().trim();
  if (!barcode || barcode.length < 4) return null;

  const price = parseFloat(item.ItemPrice || item.Price || '0');
  if (!price || price <= 0) return null;

  return {
    barcode,
    name: (item.ItemName || item.ProductDescription || '').trim(),
    unitQty: item.UnitQty || '',
    unitOfMeasure: item.UnitOfMeasure || '',
    quantity: item.Quantity || '1',
    price,
    priceByMeasure: parseFloat(item.UnitOfMeasurePrice || '0') || null,
    manufacturerName: item.ManufacturerName || '',
    manufacturerItemDescription: item.ManufacturerItemDescription || '',
    chain: chainKey,
    storeId: storeId || 'all',
    updatedAt: new Date().toISOString(),
  };
}

// Guess category from item name
function guessCategory(name) {
  const n = name.toLowerCase();
  if (/חלב|גבינ|יוגורט|שמנת|קוטג|חמאה|מוצרי חלב/.test(n)) return 'חלב ומוצרי חלב';
  if (/לחם|פית|לחמני|בגט|חלה|מאפ/.test(n)) return 'לחם ומאפים';
  if (/ביצ/.test(n)) return 'ביצים';
  if (/עוף|חזה|שוקיים|כנפיים/.test(n)) return 'עוף';
  if (/בשר|כבש|טלה|אנטריקוט|פילה|קצביה/.test(n)) return 'בשר';
  if (/דג|טונה|סרדין|סלמון|קרפיון/.test(n)) return 'דגים ופירות ים';
  if (/אורז|פסטה|ספגטי|פנה|פרפרות|קוסקוס/.test(n)) return 'דגנים ופסטה';
  if (/קמח|סוכר|שמרים/.test(n)) return 'סוכר וקמח';
  if (/שמן|מרגרינ/.test(n)) return 'שמנים';
  if (/תבלין|מלח|פלפל|פפריקה|כורכום|קינמון/.test(n)) return 'תבלינים';
  if (/שימור|עגבני|גזר|תירס|אפונה|שעועית|חומוס|טבעול/.test(n)) return 'שימורים';
  if (/מים|קולה|ספרייט|פנטה|מיץ|נקטר|רד בול|אנרג/.test(n)) return 'שתייה';
  if (/בירה|יין|וודקה|ויסקי|אלכוהול/.test(n)) return 'אלכוהול';
  if (/קפה|נספרס|תה|קקאו/.test(n)) return 'קפה ותה';
  if (/ביסלי|במבה|חטיף|פופקורן|קריספי|דוריטוס/.test(n)) return 'חטיפים';
  if (/שוקולד|ממתק|סוכרי|מסטיק|ורפל|קינדר/.test(n)) return 'ממתקים';
  if (/עוגה|עוגי|קרקר|ביסקויט|וופל/.test(n)) return 'עוגיות ובישקויטים';
  if (/גלידה|ארטיק|שוקו/.test(n)) return 'גלידות';
  if (/עגבני|מלפפון|גזר|פלפל|חסה|תרד|כרוב|בצל|שום|תפוח אדמה/.test(n)) return 'ירקות';
  if (/תפוח|בננ|תפוז|לימון|ענב|אבוקדו|מנגו|אבטיח/.test(n)) return 'פירות';
  if (/אבקת כביסה|ארגל|סבון|נוזל|מרכך|נייר|טואלט|מגבת/.test(n)) return 'ניקיון וטיפוח';
  if (/שמפו|סבון גוף|קרם|אפטרשייב|דאודור/.test(n)) return 'טיפוח אישי';
  if (/חיתול|פמפר|טטרה|מוצץ|פורמולה/.test(n)) return 'תינוקות';
  if (/כלב|חתול|דג זהב|מזון לחיות/.test(n)) return 'מזון לחיות';
  return 'כללי';
}

// Fetch product image from Open Food Facts (free, no API key needed)
const imageCache = new Map();
async function fetchProductImage(barcode) {
  if (imageCache.has(barcode)) return imageCache.get(barcode);

  try {
    const url = `https://world.openfoodfacts.org/api/v0/product/${barcode}.json`;
    const resp = await axios.get(url, { timeout: 8000 });
    const img =
      resp.data?.product?.image_front_small_url ||
      resp.data?.product?.image_small_url ||
      resp.data?.product?.image_url ||
      null;
    imageCache.set(barcode, img);
    return img;
  } catch {
    imageCache.set(barcode, null);
    return null;
  }
}

// Main fetch function — called on startup and every 2 hours
async function fetchAllPrices() {
  const db = getDb();
  console.log('🔄 Starting price fetch from publishedprices.co.il...');
  const startTime = Date.now();

  const allProducts = {}; // barcode → product record

  for (const [chainKey, chain] of Object.entries(CHAINS)) {
    console.log(`  📥 Fetching ${chain.name}...`);
    try {
      const files = await fetchFileList(chain);

      if (!files.length) {
        console.warn(`  ⚠️  No files found for ${chain.name}`);
        continue;
      }

      // Grab the most recent file (or first branch file)
      // Files are named like PriceFull7290058140886-001-202401101200.xml.gz
      const latestFile = files
        .filter(f => f.FileNm)
        .sort((a, b) => (b.FileNm > a.FileNm ? 1 : -1))[0];

      if (!latestFile) continue;

      console.log(`  📄 Parsing ${latestFile.FileNm}...`);
      const items = await downloadAndParse(chain, latestFile.FileNm);

      let count = 0;
      for (const item of items) {
        const normalized = normalizeItem(item, chainKey, latestFile.STOREID);
        if (!normalized) continue;

        const { barcode } = normalized;
        if (!allProducts[barcode]) {
          allProducts[barcode] = {
            barcode,
            name: normalized.name,
            category: guessCategory(normalized.name),
            unitQty: normalized.unitQty,
            unitOfMeasure: normalized.unitOfMeasure,
            manufacturerName: normalized.manufacturerName,
            image: null, // populated async below
            prices: {},
          };
        }
        allProducts[barcode].prices[chainKey] = normalized.price;
        count++;
      }
      console.log(`  ✅ ${chain.name}: ${count} products loaded`);
    } catch (err) {
      console.error(`  ❌ Failed to fetch ${chain.name}:`, err.message);
    }
  }

  const productList = Object.values(allProducts);
  console.log(`📦 Total unique products: ${productList.length}`);

  // Fetch images in batches (don't hammer Open Food Facts)
  console.log('🖼  Fetching product images from Open Food Facts...');
  const BATCH = 20;
  for (let i = 0; i < productList.length; i += BATCH) {
    const batch = productList.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async p => {
        if (!p.image) {
          p.image = await fetchProductImage(p.barcode);
        }
      })
    );
    if (i % 200 === 0) console.log(`  🖼  Images: ${Math.min(i + BATCH, productList.length)}/${productList.length}`);
    // Small delay to be polite to Open Food Facts
    await new Promise(r => setTimeout(r, 100));
  }

  // Save to DB
  db.saveProducts(productList);
  db.saveMeta({
    lastUpdate: new Date().toISOString(),
    productCount: productList.length,
    stores: Object.keys(CHAINS),
    nextUpdate: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    fetchDurationMs: Date.now() - startTime,
  });

  console.log(`✅ Done! ${productList.length} products saved in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  return productList.length;
}

module.exports = { fetchAllPrices, fetchProductImage };
