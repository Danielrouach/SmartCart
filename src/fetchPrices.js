const axios = require('axios');
const xml2js = require('xml2js');
const zlib = require('zlib');
const https = require('https');
const { promisify } = require('util');
const { getDb } = require('./db');

const gunzip = promisify(zlib.gunzip);

// גישה ישירה ל-IP עם עקיפת SSL
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  servername: 'url.retail.publishedprices.co.il',
});

const BASE = 'https://194.90.26.22';
const HOST_HEADER = 'url.retail.publishedprices.co.il';

const CHAINS = {
  ramiLevy: { id: '7290058140886', name: 'רמי לוי' },
  osherAd:  { id: '7290055700007', name: 'אושר עד'  },
};

async function fetchFileList(chain) {
  const url = `${BASE}/file/json/dir?CHAINID=${chain.id}&type=PriceFull`;
  const resp = await axios.get(url, {
    timeout: 30000,
    httpsAgent,
    headers: { 'Host': HOST_HEADER, 'User-Agent': 'SmartCart/1.0' },
  });
  return resp.data?.Files || [];
}

async function downloadAndParse(filename) {
  const url = `${BASE}/file/d/?fname=${filename}`;
  const resp = await axios.get(url, {
    timeout: 120000,
    responseType: 'arraybuffer',
    httpsAgent,
    headers: { 'Host': HOST_HEADER, 'User-Agent': 'SmartCart/1.0' },
  });

  let xmlBuffer = Buffer.from(resp.data);
  if (filename.endsWith('.gz')) {
    try { xmlBuffer = await gunzip(xmlBuffer); } catch {}
  }

  const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: true });
  const parsed = await parser.parseStringPromise(xmlBuffer.toString('utf8'));
  const root = parsed?.Root || parsed?.root || parsed?.Prices;
  const items = root?.Items?.Item || root?.Products?.Product || [];
  return Array.isArray(items) ? items : [items];
}

function normalizeItem(item, chainKey) {
  const barcode = (item.ItemCode || item.Barcode || '').toString().trim();
  if (!barcode || barcode.length < 4) return null;
  const price = parseFloat(item.ItemPrice || item.Price || '0');
  if (!price || price <= 0) return null;
  return {
    barcode,
    name: (item.ItemName || item.ProductDescription || '').trim(),
    price,
    unitQty: item.UnitQty || '',
    unitOfMeasure: item.UnitOfMeasure || '',
    manufacturerName: item.ManufacturerName || '',
    chain: chainKey,
  };
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
  } catch { imageCache.set(barcode, null); return null; }
}

async function fetchAllPrices() {
  const db = getDb();
  console.log('🔄 Starting price fetch via direct IP...');
  const startTime = Date.now();
  const allProducts = {};

  for (const [chainKey, chain] of Object.entries(CHAINS)) {
    console.log(`  📥 Fetching ${chain.name}...`);
    try {
      const files = await fetchFileList(chain);
      if (!files.length) { console.warn(`  ⚠️  No files for ${chain.name}`); continue; }

      const latestFile = files
        .filter(f => f.FileNm)
        .sort((a, b) => b.FileNm > a.FileNm ? 1 : -1)[0];
      if (!latestFile) continue;

      console.log(`  📄 Parsing ${latestFile.FileNm}...`);
      const items = await downloadAndParse(latestFile.FileNm);
      let count = 0;

      for (const item of items) {
        const norm = normalizeItem(item, chainKey);
        if (!norm) continue;
        if (!allProducts[norm.barcode]) {
          allProducts[norm.barcode] = {
            barcode: norm.barcode,
            name: norm.name,
            category: guessCategory(norm.name),
            unitQty: norm.unitQty,
            unitOfMeasure: norm.unitOfMeasure,
            manufacturerName: norm.manufacturerName,
            image: null,
            prices: {},
          };
        }
        allProducts[norm.barcode].prices[chainKey] = norm.price;
        count++;
      }
      console.log(`  ✅ ${chain.name}: ${count} products`);
    } catch (err) {
      console.error(`  ❌ ${chain.name} failed:`, err.message);
    }
  }

  const productList = Object.values(allProducts);
  console.log(`📦 Total: ${productList.length} unique products`);

  console.log('🖼  Fetching images...');
  for (let i = 0; i < productList.length; i += 20) {
    await Promise.all(
      productList.slice(i, i + 20).map(async p => {
        if (!p.image) p.image = await fetchProductImage(p.barcode);
      })
    );
    if (i % 500 === 0) console.log(`  🖼  ${Math.min(i+20, productList.length)}/${productList.length}`);
    await new Promise(r => setTimeout(r, 150));
  }

  db.saveProducts(productList);
  db.saveMeta({
    lastUpdate: new Date().toISOString(),
    productCount: productList.length,
    stores: Object.keys(CHAINS),
    nextUpdate: new Date(Date.now() + 2*60*60*1000).toISOString(),
    fetchDurationMs: Date.now() - startTime,
  });

  console.log(`✅ Done! ${productList.length} products in ${((Date.now()-startTime)/1000).toFixed(1)}s`);
  return productList.length;
}

module.exports = { fetchAllPrices, fetchProductImage };
