# 🛒 סל חכם — Backend Server

השוואת מחירים בין רמי לוי ואושר עד, עם נתונים חיים מהמחירון הממשלתי.

---

## ⚡ הרצה מקומית (5 דקות)

```bash
# 1. כניסה לתיקייה
cd sal-chacham-server

# 2. התקנת תלויות
npm install

# 3. הגדרת משתני סביבה
cp .env.example .env

# 4. הפעלה
npm start
```

האפליקציה תרוץ על http://localhost:3001

בפעם הראשונה, השרת יוריד אוטומטית את כל המחירים (~5-10 דקות).
לאחר מכן המחירים נשמרים ב-`/data/` ומתעדכנים כל שעתיים.

---

## 📡 מקורות הנתונים

### מחירים — publishedprices.co.il
על פי **חוק המזון (2015)**, כל רשת מזון בישראל מחויבת לפרסם מחירים בזמן אמת.
הנתונים זמינים דרך הפורטל הממשלתי:

| רשת | Chain ID |
|-----|----------|
| רמי לוי | 7290058140886 |
| אושר עד | 7290055700007 |

הקבצים הם XML מכווצים (GZ) עם כל המוצרים בכל סניף.

### תמונות — Open Food Facts
[world.openfoodfacts.org](https://world.openfoodfacts.org) — מאגר פתוח וחינמי.
ה-API: `https://world.openfoodfacts.org/api/v0/product/{barcode}.json`

---

## 🔌 API Endpoints

| Method | Path | תיאור |
|--------|------|-------|
| GET | `/api/products?q=חלב&limit=20` | חיפוש מוצרים |
| GET | `/api/product/:barcode` | מוצר לפי ברקוד |
| GET | `/api/cart/compare?barcodes=x,y&region=tel-aviv` | השוואת סל |
| GET | `/api/categories` | כל הקטגוריות |
| GET | `/api/status` | סטטוס + זמן עדכון אחרון |
| POST | `/api/refresh` | עדכון ידני (דורש X-Refresh-Secret header) |

---

## 🚀 פריסה ל-Render.com (חינמי)

### שלב 1 — העלה ל-GitHub
```bash
cd sal-chacham-server
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_USERNAME/sal-chacham.git
git push -u origin main
```

### שלב 2 — צור Web Service ב-Render
1. לך ל-[render.com](https://render.com) → New → **Web Service**
2. חבר את ה-GitHub repo
3. הגדרות:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free

### שלב 3 — הגדר Environment Variables
ב-Render → Environment → Add:
```
NODE_ENV=production
REFRESH_SECRET=בחר-סיסמא-חזקה
PORT=10000
```

### שלב 4 — Persistent Disk (חשוב!)
ב-Render → Disks → Add Disk:
- **Mount Path:** `/opt/render/project/src/data`
- **Size:** 1 GB (מספיק)

זה שומר את הנתונים בין restarts.

### שלב 5 — Deploy
לחץ **Deploy** — השרת יעלה ב-~2 דקות.
URL סופי: `https://sal-chacham.onrender.com`

---

## 🐳 Docker (אופציונלי)

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3001
CMD ["npm", "start"]
```

```bash
docker build -t sal-chacham .
docker run -p 3001:3001 -v $(pwd)/data:/app/data sal-chacham
```

---

## 📁 מבנה הפרויקט

```
sal-chacham-server/
├── src/
│   ├── server.js        # Express app + cron scheduler
│   ├── fetchPrices.js   # מוריד XML מהמחירון הממשלתי
│   └── db.js            # אחסון + Fuse.js search
├── public/
│   └── index.html       # Frontend (React)
├── data/                # נוצר אוטומטית
│   ├── products.json    # כל המוצרים + מחירים
│   └── meta.json        # מטדטה + זמן עדכון
├── .env.example
├── .gitignore
└── package.json
```

---

## 🔄 לוח זמנים לעדכונים

| אירוע | תיאור |
|-------|-------|
| הפעלת שרת | בדיקה אם הנתונים ישנים מ-2 שעות → אם כן, מוריד מחדש |
| כל שעתיים | `cron('0 */2 * * *')` — עדכון אוטומטי |
| POST /api/refresh | ידני, מוגן בסיסמא |

---

## 🛡️ אבטחה

- אין מפתחות API חיצוניים — publishedprices.co.il ו-OpenFoodFacts הם פתוחים
- ה-`REFRESH_SECRET` מגן על endpoint הרענון הידני
- CORS מוגדר — בפרודקשן מומלץ להגביל ל-origin שלך
- נתוני המשתמשים **לא נשמרים** — הסל נשמר רק בדפדפן (React state)
