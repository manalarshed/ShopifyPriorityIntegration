const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

require('dotenv').config();

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const PRIORITY_BASE_URL = process.env.PRIORITY_BASE_URL;
const PRIORITY_USERNAME = process.env.PRIORITY_USERNAME;
const PRIORITY_PAT = process.env.PRIORITY_PAT;


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

async function getPriorityProducts() {

  const response = await axios.get(
    `${PRIORITY_BASE_URL}/LOGPART`,{
      auth: {
        username: PRIORITY_USERNAME,
        password: PRIORITY_PAT,
      },
      params: {
        '$filter': "SHOWINWEB eq 'Y'",
        '$select': 'PARTNAME, PARTDES, VATPRICE, FAMILYDES, ITMT_PARTTYPECODE, ITMT_PARTTYPEDES, ITMT_BALANCE, SPEC1, EXTFILENAME',
        '$expand': 'PARTTEXT_SUBFORM,PARTEXTFILE_SUBFORM'
       }
    }
  );

  console.log(JSON.stringify(response.data.value, null, 2));
  return response.data.value;
}

async function getShopifyProductBySKU(token, sku) {
  try {
    let page_info = null;
    do {
      const params = { limit: 250, fields: 'id,variants' };
      if (page_info) params.page_info = page_info;

      const res = await axios.get(
        `https://${process.env.SHOPIFY_STORE}/admin/api/2026-04/products.json`,
        { headers: { 'X-Shopify-Access-Token': token }, params }
      );

      for (const product of res.data.products) {
        for (const variant of product.variants) {
          if (variant.sku === sku) return { productId: product.id, variantId: variant.id };
        }
      }

      // Check for next page
      const linkHeader = res.headers['link'] || '';
      const nextMatch = linkHeader.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
      page_info = nextMatch ? nextMatch[1] : null;

    } while (page_info);

    return null;
  } catch (err) {
    console.error('❌ Error finding product by SKU:', err.message);
    return null;
  }
}

async function uploadBase64ImageToShopify(token, base64String, filename, productId) {
  try {
    // Remove data URI prefix if present (e.g. "data:image/jpeg;base64,")
    const base64Data = base64String.replace(/^data:image\/\w+;base64,/, '');

    // Convert base64 to buffer
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // Save temporarily to disk
    const tempPath = path.join('/tmp', filename);
    fs.writeFileSync(tempPath, imageBuffer);

    // Upload to Shopify using multipart form
    const form = new FormData();
    form.append('file', fs.createReadStream(tempPath), {
      filename: filename,
      contentType: 'image/jpeg',
    });

    const response = await axios.post(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2026-04/products/${productId}/images.json`,
      {
        image: {
          attachment: base64Data,  // Shopify accepts base64 directly!
          filename: filename,
        }
      },
      {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
        }
      }
    );

    console.log(`   🖼️ Image uploaded: ${response.data.image.src}`);

    // Cleanup temp file
    fs.unlinkSync(tempPath);

    return response.data.image.src;

  } catch (err) {
    console.error('   ❌ Image upload failed:', err.response?.data || err.message);
    return null;
  }
}

async function pushToShopify(token, products) {
  const headers = {
    'X-Shopify-Access-Token': token,
    'Content-Type': 'application/json',
  };

  console.log(`\n🚀 Syncing ${products.length} products to Shopify...\n`);

  for (const item of products) {
    console.log(`📦 Processing: ${item.PARTDES} (SKU: ${item.PARTNAME})`);
    console.log(`   💰 Price: ${item.VATPRICE}`);
    console.log(`   📁 Family: ${item.FAMILYDES}`);
    console.log(`   📦 Balance: ${item.ITMT_BALANCE}`);
    console.log(`   🌐 ShowInWeb: ${item.SHOWINWEB}`);
    console.log(`   📝 Description: ${item.PARTTEXT_SUBFORM?.TEXT || 'none'}`);

    const productPayload = {
      product: {
        title: item.PARTDES || '',
        // ✅ Insert description from PARTTEXT_SUBFORM
        body_html: (() => {
          const description = item.PARTTEXT_SUBFORM?.TEXT ? `<p>${item.PARTTEXT_SUBFORM.TEXT}</p>` : '';
          const dimensions = item.SPEC1 ? `<p>מידות מוצר: ${item.SPEC1}</p>` : '';
          return `${description}${dimensions}`;
        })(),

        product_type: item.FAMILYDES || item.ITMT_PARTTYPEDES || '',
        tags: [item.FAMILYDES, item.ITMT_PARTTYPEDES].filter(Boolean).join(','),
        variants: [
          {
            sku: item.PARTNAME,
            barcode: item.PARTNAME || '',  // ✅ Barcode = SKU
            price: item.VATPRICE ? String(item.VATPRICE) : '0.00',
            inventory_quantity: item.ITMT_BALANCE ? parseInt(item.ITMT_BALANCE) : 0,
            // ✅ Track inventory if balance > 0
            inventory_management: item.ITMT_BALANCE && parseInt(item.ITMT_BALANCE) > 0 ? 'shopify' : null,
            inventory_policy: 'deny', // stop selling when out of stock
          }
        ],// ✅ Add SPEC1 as metafield
         metafields: item.SPEC1 ? [
           {
             namespace: 'custom',
             key: 'package_size',
             value: item.SPEC1,
             type: 'single_line_text_field',
           }
         ] : [],
      }
    };

    let productId = null;

    try {
      const existing = await getShopifyProductBySKU(token, item.PARTNAME);

      if (existing) {
        // UPDATE
        const res = await axios.put(
          `https://${process.env.SHOPIFY_STORE}/admin/api/2026-04/products/${existing.productId}.json`,
          productPayload,
          { headers }
        );
        productId = res.data.product.id;
        console.log(`   🔄 Updated: ${item.PARTDES} (${productId})`);
      } else {
        // CREATE
        const res = await axios.post(
          `https://${process.env.SHOPIFY_STORE}/admin/api/2026-04/products.json`,
          productPayload,
          { headers }
        );
        productId = res.data.product.id;
        console.log(`   ✅ Created: ${item.PARTDES} (${productId})`);
      }

    } catch (err) {
      console.error(`   ❌ Failed: ${item.PARTDES}`);
      console.error('   Status:', err.response?.status);
      console.error('   Error:', JSON.stringify(err.response?.data, null, 2));
    }

    if (productId) {
      // ✅ Get existing images already uploaded to Shopify
      let existingImageFilenames = [];
      try {
        const imgRes = await axios.get(
          `https://${process.env.SHOPIFY_STORE}/admin/api/2026-04/products/${productId}/images.json`,
          { headers }
        );
        // Extract filenames from Shopify image URLs
        existingImageFilenames = imgRes.data.images.map(img => {
          const parts = img.src.split('/');
          // Remove query params from filename
          return parts[parts.length - 1].split('?')[0];
        });
        console.log(`   🖼️ Existing images: ${existingImageFilenames.join(', ') || 'none'}`);
      } catch (err) {
        console.error('   ⚠️ Could not fetch existing images:', err.message);
      }

      // ✅ Upload main image — skip if already exists
      if (item.EXTFILENAME) {
        const mainFilename = `${item.PARTNAME}.jpg`;
        if (existingImageFilenames.includes(mainFilename)) {
          console.log(`   ⏭️ Main image already exists, skipping: ${mainFilename}`);
        } else {
          console.log(`   🖼️ Uploading main image: ${mainFilename}`);
          await uploadBase64ImageToShopify(token, item.EXTFILENAME, mainFilename, productId);
        }
      } else {
        console.log(`   ⚠️ No main image found`);
      }

      // ✅ Upload additional images — skip if already exists
      const additionalImages = item.PARTEXTFILE_SUBFORM || [];
      if (additionalImages.length > 0) {
        console.log(`   🖼️ Processing ${additionalImages.length} additional images...`);
        for (let i = 0; i < additionalImages.length; i++) {
          const file = additionalImages[i];
          if (file.EXTFILENAME) {
            const ext = file.SUFFIX || 'jpg';
            const filename = `${item.PARTNAME}_${file.EXTFILEDES}.${ext}`;
            if (existingImageFilenames.includes(filename)) {
              console.log(`   ⏭️ Image already exists, skipping: ${filename}`);
            } else {
              console.log(`   🖼️ Uploading additional image ${i + 1}: ${filename}`);
              await uploadBase64ImageToShopify(token, file.EXTFILENAME, filename, productId);
              await new Promise(r => setTimeout(r, 300));
            }
          }
        }
      } else {
        console.log(`   ⚠️ No additional images found`);
      }
    }

    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n✅ Sync complete!');
}

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
cron.schedule('*/5 * * * *', () => {
  console.log(`🔄 Running scheduled sync at ${new Date().toLocaleString()}`);
  main();
});

