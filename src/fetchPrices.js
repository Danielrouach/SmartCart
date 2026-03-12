const axios = require('axios');
const xml2js = require('xml2js');
const zlib = require('zlib');
const https = require('https');
const { promisify } = require('util');
const { getDb } = require('./db');

const gunzip = promisify(zlib.gunzip);
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const CHAINS = {
  ramiLevy: { id: '7290058140886', name: 'רמי לוי', baseUrl: 'https://url.retail.publishedprices.co.il' },
  osherAd:  { id: '7290055700007', name: 'אושר עד',  baseUrl: 'https://url.retail.publishedprices.co.il' },
};

async function fetchFileList(chain) {
  const url = `${chain.baseUrl}/file/json/dir?CHAINID=${chain.id}&type=PriceFull`;
  const resp = await axios.get(url, { timeout: 30000, httpsAgent, headers: { 'User-Agent': 'SmartCart/1.0' } });
  return resp.data?.Files || [];
}

async function downloadAndParse(chain, filename) {
  const url = `${chain.baseUrl}/file/d/?fname=${filename}`;
  const resp = await axios.get(url, { timeout: 60000, responseType: 'arraybuffer', httpsAgent, headers: { 'User-Agent': 'SmartCart/1.0' } });
  let xmlBuffer = Buffer.from(resp.data);
  if (filename.endsWith('.gz')) xmlBuffer = await gunzip(xmlBuffer);
  const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: true });
  const parsed = await parser.parseStringPromise(xmlBuffer.toString('utf8'));
  const root = parsed?.Root || parsed?.root;
  const items = root?.Items?.Item || root?.Products?.Product || [];
  return Array.isArray(items) ? items : [items];
}

function normalizeItem(item, chainKey) {
  const barcode = (item.ItemCode || item.Barcode || '').toString().trim();
  if (!barcode || barcode.length < 4) return null;
  const price = parseFloat(item.ItemPrice || item.Price || '0');
  if (!price || price <= 0) return null;
  return { barcode, name: (item.ItemName || item.ProductDescription || '').trim(), price, unitQty: item.UnitQty || '', unitOfMeasure: item.UnitOfMeasure || '', manufacturerName: item.ManufacturerName || '', chain: chainKey };
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
    const resp = await axios.get(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`, { timeout: 8000 });
    const img = resp.data?.product?.image_front_small_url || resp.data?.product?.image_small_url || null;
    imageCache.set(barcode, img);
    return img;
  } catch { imageCache.set(barcode, null); return null; }
}

async function fetchAllPrices() {
  const db = getDb();
  console.log('🔄 Starting price fetch...');
  const startTime = Date.now();
  const allProducts = {};

  for (const [chainKey, chain] of Object.entries(CHAINS)) {
    console.log(`  📥 Fetching ${chain.name}...`);
    try {
      const files = await fetchFileList(chain);
      if (!files.length) { console.warn(`  ⚠️  No files for ${chain.name}`); continue; }
      const latestFile = files.filter(f => f.FileNm).sort((a, b) => b.FileNm > a.FileNm ? 1 : -1)[0];
      if (!latestFile) continue;
      console.log(`  📄 Parsing ${latestFile.FileNm}...`);
      const items = await downloadAndParse(chain, latestFile.FileNm);
      let count = 0;
      for (const item of items) {
        const norm = normalizeItem(item, chainKey);
        if (!norm) continue;
        if (!allProducts[norm.barcode]) {
          allProducts[norm.barcode] = { barcode: norm.barcode, name: norm.name, category: guessCategory(norm.name), unitQty: norm.unitQty, unitOfMeasure: norm.unitOfMeasure, manufacturerName: norm.manufacturerName, image: null, prices: {} };
        }
        allProducts[norm.barcode].prices[chainKey] = norm.price;
        count++;
      }
      console.log(`  ✅ ${chain.name}: ${count} products`);
    } catch (err) { console.error(`  ❌ Failed ${chain.name}:`, err.message); }
  }

  const productList = Object.values(allProducts);
  console.log(`📦 Total: ${productList.length} products`);
  console.log('🖼  Fetching images...');
  for (let i = 0; i < productList.length; i += 20) {
    await Promise.all(productList.slice(i, i + 20).map(async p => { if (!p.image) p.image = await fetchProductImage(p.barcode); }));
    if (i % 500 === 0) console.log(`  🖼  ${Math.min(i+20, productList.length)}/${productList.length}`);
    await new Promise(r => setTimeout(r, 100));
  }

  db.saveProducts(productList);
  db.saveMeta({ lastUpdate: new Date().toISOString(), productCount: productList.length, stores: Object.keys(CHAINS), nextUpdate: new Date(Date.now() + 2*60*60*1000).toISOString(), fetchDurationMs: Date.now()-startTime });
  console.log(`✅ Done! ${productList.length} products in ${((Date.now()-startTime)/1000).toFixed(1)}s`);
  return productList.length;
}

module.exports = { fetchAllPrices, fetchProductImage };
