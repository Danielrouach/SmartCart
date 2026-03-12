const axios = require('axios');
const xml2js = require('xml2js');
const zlib = require('zlib');
const https = require('https');
const { promisify } = require('util');
const { getDb } = require('./db');

const gunzip = promisify(zlib.gunzip);
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// פורטל המחירים הממשלתי - כתובות ישירות יותר אמינות מ-Render
const CHAINS = {
  ramiLevy: {
    name: 'רמי לוי',
    // API ישיר של רמי לוי
    listUrl: 'https://www.rami-levy.co.il/api/sitemap/prices',
    fallbackUrl: 'http://prices.rami-levy.co.il/PriceFull7290058140886.gz',
  },
  osherAd: {
    name: 'אושר עד',
    listUrl: 'https://osheradapi.com/prices',
    fallbackUrl: 'http://prices.osher-ad.co.il/PriceFull7290055700007.gz',
  },
};

// API אחיד דרך Open-Prices שמאגד את כל הרשתות
const OPEN_PRICES_API = 'https://api.open-prices.co.il/api/v1';

async function fetchViaOpenPrices(chainId, chainKey) {
  console.log(`  🌐 Trying Open-Prices API for chain ${chainId}...`);
  let page = 1;
  const allItems = [];

  while (true) {
    const url = `${OPEN_PRICES_API}/prices/?chain_id=${chainId}&page=${page}&page_size=500`;
    const resp = await axios.get(url, {
      timeout: 30000,
      httpsAgent,
      headers: { 'User-Agent': 'SmartCart/1.0', 'Accept': 'application/json' }
    });

    const items = resp.data?.results || [];
    if (!items.length) break;

    for (const item of items) {
      if (item.product_code && item.price) {
        allItems.push({
          barcode: item.product_code.toString(),
          name: item.product_name || item.product_description || '',
          price: parseFloat(item.price),
          chain: chainKey,
        });
      }
    }

    if (!resp.data?.next) break;
    page++;

    // עצור אחרי 100 עמודים (50,000 מוצרים) למניעת לולאה אינסופית
    if (page > 100) break;
    await new Promise(r => setTimeout(r, 200));
  }

  return allItems;
}

async function fetchViaDirectXML(url, chainKey) {
  console.log(`  📥 Trying direct XML: ${url}`);
  const resp = await axios.get(url, {
    timeout: 120000,
    responseType: 'arraybuffer',
    httpsAgent,
    headers: { 'User-Agent': 'SmartCart/1.0' }
  });

  let xmlBuffer = Buffer.from(resp.data);
  if (url.endsWith('.gz') || resp.headers['content-encoding'] === 'gzip') {
    try { xmlBuffer = await gunzip(xmlBuffer); } catch {}
  }

  const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: true });
  const parsed = await parser.parseStringPromise(xmlBuffer.toString('utf8'));
  const root = parsed?.Root || parsed?.root || parsed?.Prices;
  const items = root?.Items?.Item || root?.Products?.Product || root?.Item || [];
  const list = Array.isArray(items) ? items : [items];

  return list
    .map(item => ({
      barcode: (item.ItemCode || item.Barcode || '').toString().trim(),
      name: (item.ItemName || item.ProductDescription || '').trim(),
      price: parseFloat(item.ItemPrice || item.Price || '0'),
      chain: chainKey,
    }))
    .filter(i => i.barcode.length >= 4 && i.price > 0);
}

function guessCategory(name) {
  const n = name.toLowerCase();
  if (/חלב|גבינ|יוגורט|שמנת|קוטג|חמאה/.test(n)) return 'חלב ומוצרי חלב';
  if (/לחם|פית|לחמני|בגט|חלה|מאפ/.test(n)) return 'לחם ומאפים';
  if (/ביצ/.test(n)) return 'ביצים';
  if (/עוף|חזה|שוקיים|כנפיים/.test(n)) return 'עוף';
  if (/בשר|כבש|טלה|אנטריקוט/.test(n)) return 'בשר';
  if (/דג|טונה|סרדין|סלמון/.test(n)) return 'דגים';
  if (/אורז|פסטה|ספגטי|פנה|קוסקוס/.test(n)) return 'דגנים ופסטה';
  if (/קמח|סוכר|שמרים/.test(n)) return 'סוכר וקמח';
  if (/שמן|מרגרינ/.test(n)) return 'שמנים';
  if (/תבלין|מלח|פלפל|פפריקה/.test(n)) return 'תבלינים';
  if (/שימור|עגבני|גזר|תירס|אפונה|שעועית|חומוס/.test(n)) return 'שימורים';
  if (/מים|קולה|ספרייט|פנטה|מיץ|נקטר|אנרג/.test(n)) return 'שתייה';
  if (/בירה|יין|וודקה|ויסקי/.test(n)) return 'אלכוהול';
  if (/קפה|נספרס|תה|קקאו/.test(n)) return 'קפה ותה';
  if (/ביסלי|במבה|חטיף|פופקורן/.test(n)) return 'חטיפים';
  if (/שוקולד|ממתק|קינדר/.test(n)) return 'ממתקים';
  if (/עוגה|עוגי|קרקר|ביסקויט/.test(n)) return 'עוגיות';
  if (/גלידה|ארטיק/.test(n)) return 'גלידות';
  if (/עגבני|מלפפון|פלפל|חסה|תרד|בצל|שום/.test(n)) return 'ירקות';
  if (/תפוח|בננ|תפוז|לימון|ענב|אבוקדו/.test(n)) return 'פירות';
  if (/אבקת כביסה|ארגל|סבון|נוזל|מרכך|נייר|טואלט/.test(n)) return 'ניקיון';
  if (/שמפו|קרם|דאודור/.test(n)) return 'טיפוח';
  if (/חיתול|פמפר|פורמולה/.test(n)) return 'תינוקות';
  return 'כללי';
}

const imageCache = new Map();
async function fetchProductImage(barcode) {
  if (imageCache.has(barcode)) return imageCache.get(barcode);
  try {
    const resp = await axios.get(
      `https://world.openfoodfacts.org/api/v0/product/${barcode}.json`,
      { timeout: 8000 }
    );
    const img = resp.data?.product?.image_front_small_url ||
                resp.data?.product?.image_small_url || null;
    imageCache.set(barcode, img);
    return img;
  } catch {
    imageCache.set(barcode, null);
    return null;
  }
}

async function fetchChain(chainKey, chainConfig, chainId) {
  // נסה Open-Prices API קודם, אחר כך XML ישיר
  try {
    const items = await fetchViaOpenPrices(chainId, chainKey);
    if (items.length > 100) {
      console.log(`  ✅ ${chainConfig.name}: ${items.length} products via Open-Prices`);
      return items;
    }
  } catch (e) {
    console.log(`  ⚠️  Open-Prices failed: ${e.message}`);
  }

  // Fallback: XML ישיר
  try {
    const items = await fetchViaDirectXML(chainConfig.fallbackUrl, chainKey);
    console.log(`  ✅ ${chainConfig.name}: ${items.length} products via direct XML`);
    return items;
  } catch (e) {
    console.error(`  ❌ ${chainConfig.name} all methods failed: ${e.message}`);
    return [];
  }
}

async function fetchAllPrices() {
  const db = getDb();
  console.log('🔄 Starting price fetch...');
  const startTime = Date.now();
  const allProducts = {};

  const chainIds = {
    ramiLevy: '7290058140886',
    osherAd: '7290055700007',
  };

  for (const [chainKey, chainConfig] of Object.entries(CHAINS)) {
    console.log(`  📥 Fetching ${chainConfig.name}...`);
    const items = await fetchChain(chainKey, chainConfig, chainIds[chainKey]);

    for (const item of items) {
      if (!item.barcode || !item.name || !item.price) continue;
      if (!allProducts[item.barcode]) {
        allProducts[item.barcode] = {
          barcode: item.barcode,
          name: item.name,
          category: guessCategory(item.name),
          image: null,
          prices: {},
        };
      }
      allProducts[item.barcode].prices[chainKey] = item.price;
    }
  }

  const productList = Object.values(allProducts);
  console.log(`📦 Total: ${productList.length} unique products`);

  // תמונות — רק למוצרים שנמצאים בשני הסופרים (עדיפות גבוהה)
  console.log('🖼  Fetching images...');
  for (let i = 0; i < productList.length; i += 20) {
    await Promise.all(
      productList.slice(i, i + 20).map(async p => {
        if (!p.image) p.image = await fetchProductImage(p.barcode);
      })
    );
    if (i % 500 === 0) {
      console.log(`  🖼  ${Math.min(i + 20, productList.length)}/${productList.length}`);
    }
    await new Promise(r => setTimeout(r, 150));
  }

  db.saveProducts(productList);
  db.saveMeta({
    lastUpdate: new Date().toISOString(),
    productCount: productList.length,
    stores: Object.keys(CHAINS),
    nextUpdate: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    fetchDurationMs: Date.now() - startTime,
  });

  console.log(`✅ Done! ${productList.length} products in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  return productList.length;
}

module.exports = { fetchAllPrices, fetchProductImage };
