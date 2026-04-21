const axios = require('axios');
const cron = require('node-cron');

require('dotenv').config();

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const PRIORITY_BASE_URL = process.env.PRIORITY_BASE_URL;
const PRIORITY_USERNAME = process.env.PRIORITY_USERNAME;
const PRIORITY_PAT = process.env.PRIORITY_PAT;

// ============================================
// STEP 1 - Get Shopify API Token
// ============================================
async function getShopifyToken() {
  const response = await axios.post(
    `https://${SHOPIFY_STORE}/admin/oauth/access_token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return response.data.access_token;
}


const fs = require('fs');

async function getPriorityProducts() {
  const response = await axios.get(
    `${PRIORITY_BASE_URL}/PART`,
    {
      auth: {
        username: PRIORITY_USERNAME,
        password: PRIORITY_PAT,
      },
      params: {
      //  '$filter': "WEBLEVEL ge '1'",
        '$filter': "PARTDES eq 'manaal'",
        '$select': 'PARTNAME,PARTDES,EPARTDES,BARCODE,FAMILYNAME,STATDES,TYPE,WEBLEVEL',
        '$expand': 'PARTTEXT_SUBFORM,PARTEXTFILE_SUBFORM,PARTTEXTLANG_SUBFORM',
        '$top': 5
      }
    }
  );
  console.log(JSON.stringify(response.data.value, null, 2));
  return response.data.value;
}


// ============================================
// STEP 3 - Check if product exists in Shopify
// ============================================
async function getShopifyProductBySKU(token, sku) {
  const response = await axios.get(
    `https://${SHOPIFY_STORE}/admin/api/2026-04/products.json?fields=id,variants&limit=250`,
    { headers: { 'X-Shopify-Access-Token': token } }
  );
  const products = response.data.products;
  for (const product of products) {
    for (const variant of product.variants) {
      if (variant.sku === sku) return product.id;
    }
  }
  return null;
}

// ============================================
// STEP 4 - Push Products to Shopify
// ============================================
//async function pushToShopify(token, products) {
//  const headers = {
//    'X-Shopify-Access-Token': token,
//    'Content-Type': 'application/json',
//  };
//
//  for (const item of products) {
//    const product = {
//      product: {
//        title: item.PARTDES,           // תאור מוצר
//        body_html: `
//          <p>${item.DETAILS || ''}</p>
//          <p>${item.PARTTEXT || ''}</p>
//          <p>${item.SPEC || ''}</p>
//        `,                             // תאור + מוצרים טקסט + מידות
//        product_type: item.FAMILYDES,  // תאור סוג פריט
//        tags: [item.FAMILY, item.FAMILYNAME].filter(Boolean).join(','), // משפחת מוצר
//        variants: [
//          {
//            sku: item.PARTNAME,        // מק"ט
//            barcode: item.BARCODE,     // ברקוד
//            price: item.VATPRICE || '0.00', // מחיר כולל מע"מ
//          },
//        ],
//        images: item.IMAGE ? [{ src: item.IMAGE }] : [], // תמונה
//      },
//    };
//
//    try {
//      const existingId = await getShopifyProductBySKU(token, item.PARTNAME);
//
//      if (existingId) {
//        await axios.put(
//          `https://${SHOPIFY_STORE}/admin/api/2026-04/products/${existingId}.json`,
//          product,
//          { headers }
//        );
//        console.log(`🔄 Updated: ${item.PARTDES}`);
//      } else {
//        await axios.post(
//          `https://${SHOPIFY_STORE}/admin/api/2026-04/products.json`,
//          product,
//          { headers }
//        );
//        console.log(`✅ Created: ${item.PARTDES}`);
//      }
//    } catch (err) {
//      console.error(`❌ Failed: ${item.PARTDES}`, err.response?.data);
//    }
//  }
//}


async function pushToShopify(token, products) {
  const headers = {
    'X-Shopify-Access-Token': token,
    'Content-Type': 'application/json',
  };

  for (const item of products) {
    // Extract text from PARTTEXT_SUBFORM
    const partText = item.PARTTEXT_SUBFORM?.TEXT || '';

    // Extract description from PARTTEXTLANG_SUBFORM
    const partTextLang = item.PARTTEXTLANG_SUBFORM?.TEXT || '';

    // Extract images from PARTEXTFILE_SUBFORM
    const images = (item.PARTEXTFILE_SUBFORM || [])
      .filter(f => f.EXTFILENAME && /\.(jpg|jpeg|png|gif|webp)/i.test(f.EXTFILENAME))
      .map(f => ({ src: f.EXTFILENAME }));

    const product = {
      product: {
        title: item.PARTDES,                    // תאור מוצר
        body_html: `
          <p>${partTextLang || ''}</p>
          <p>${partText || ''}</p>
        `,                                      // תאור + טקסט מוצר
        product_type: item.FAMILYNAME || '',    // משפחת מוצר
        tags: [item.FAMILYNAME].filter(Boolean).join(','),
        variants: [
          {
            sku: item.PARTNAME,                 // מק"ט
            barcode: item.BARCODE || '',        // ברקוד
            price: String(item.VATPRICE || '0.00'), // מחיר כולל מע"מ
          },
        ],
        images: images,                         // תמונות ממסמכים
      },
    };

    try {
      const existingId = await getShopifyProductBySKU(token, item.PARTNAME);

      if (existingId) {
        await axios.put(
          `https://${SHOPIFY_STORE}/admin/api/2026-04/products/${existingId}.json`,
          product,
          { headers }
        );
        console.log(`🔄 Updated: ${item.PARTDES}`);
      } else {
        await axios.post(
          `https://${SHOPIFY_STORE}/admin/api/2026-04/products.json`,
          product,
          { headers }
        );
        console.log(`✅ Created: ${item.PARTDES}`);
      }
    } catch (err) {
      console.error(`❌ Failed: ${item.PARTDES}`, err.response?.data);
    }
  }
}


// ============================================
// MAIN - Run the sync
// ============================================
async function main() {
  try {
    console.log('🔑 Getting Shopify token...');
    const token = await getShopifyToken();

    console.log('📦 Fetching online products from Priority...');
    const products = await getPriorityProducts();
    console.log(`Found ${products.length} online products in Priority`);

    console.log('🚀 Syncing products to Shopify...');
    await pushToShopify(token, products);

    console.log('✅ Sync complete!');
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

// ============================================
// CRON - Run every hour automatically
// ============================================
console.log('⏰ Scheduler started - syncing every hour...');
main();
cron.schedule('0 * * * *', () => {
  console.log(`🔄 Running scheduled sync at ${new Date().toLocaleString()}`);
  main();
});

