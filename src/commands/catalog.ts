import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerCatalogCommands(program: Command, getClient: () => MetaClient): void {
  const catalog = program.command('catalog').description('Product catalog management');

  catalog
    .command('list')
    .description('List product catalogs')
    .option('--business-id <id>', 'Business ID')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.businessId) {
        throw new Error('Business ID required. Use --business-id');
      }
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,product_count,vertical,da_display_settings',
      };

      const response = await client.request(`${opts.businessId}/owned_product_catalogs`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  catalog
    .command('get <catalogId>')
    .description('Get catalog details')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (catalogId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,product_count,vertical,da_display_settings,feed_count',
      };

      const response = await client.request(catalogId, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  catalog
    .command('products <catalogId>')
    .description('List products in a catalog')
    .option('--limit <n>', 'Maximum products', '25')
    .option('--all', 'Fetch all pages')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (catalogId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,description,price,currency,image_url,url,availability,brand,category',
        limit: opts.limit,
      };

      const endpoint = `${catalogId}/products`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params })
        : await client.request(endpoint, { params });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  catalog
    .command('product-sets <catalogId>')
    .description('List product sets in a catalog')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (catalogId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,filter,product_count',
      };

      const response = await client.request(`${catalogId}/product_sets`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  catalog
    .command('create')
    .description('Create a product catalog')
    .requiredOption('--business-id <id>', 'Business ID')
    .requiredOption('--name <name>', 'Catalog name')
    .option('--vertical <vertical>', 'Vertical (commerce, hotels, flights, destinations, home_listings)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const body: Record<string, string> = {
        name: opts.name,
      };
      if (opts.vertical) body.vertical = opts.vertical;

      const response = await client.request(`${opts.businessId}/owned_product_catalogs`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  catalog
    .command('get-product <productId>')
    .description('Get detailed info for a specific product')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (productId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,description,price,currency,image_url,url,availability,brand,category,sale_price,sale_price_start_date,sale_price_end_date,condition,retailer_id,custom_label_0,custom_label_1,custom_label_2',
      };

      const response = await client.request(productId, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  catalog
    .command('create-product')
    .description('Add a product to a catalog')
    .requiredOption('--catalog-id <id>', 'Catalog ID')
    .requiredOption('--retailer-id <id>', 'Unique product identifier (retailer_id/SKU)')
    .requiredOption('--name <name>', 'Product name')
    .requiredOption('--price <amount>', 'Price (e.g., "29.99 USD")')
    .requiredOption('--url <url>', 'Product page URL')
    .requiredOption('--image-url <url>', 'Product image URL')
    .option('--description <text>', 'Product description')
    .option('--brand <brand>', 'Product brand')
    .option('--category <category>', 'Product category')
    .option('--availability <status>', 'Availability: in stock, out of stock, preorder, available for order', 'in stock')
    .option('--condition <condition>', 'Condition: new, refurbished, used', 'new')
    .option('--sale-price <amount>', 'Sale price (e.g., "19.99 USD")')
    .option('--custom-label-0 <label>', 'Custom label 0')
    .option('--custom-label-1 <label>', 'Custom label 1')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();

      // Parse price into value and currency
      const priceParts = opts.price.split(' ');
      const priceValue = Math.round(parseFloat(priceParts[0]) * 100);
      const currency = priceParts[1] || 'USD';

      const body: Record<string, string> = {
        retailer_id: opts.retailerId,
        name: opts.name,
        price: String(priceValue),
        currency: currency,
        url: opts.url,
        image_url: opts.imageUrl,
        availability: opts.availability,
        condition: opts.condition,
      };

      if (opts.description) body.description = opts.description;
      if (opts.brand) body.brand = opts.brand;
      if (opts.category) body.category = opts.category;
      if (opts.salePrice) {
        const saleParts = opts.salePrice.split(' ');
        body.sale_price = String(Math.round(parseFloat(saleParts[0]) * 100));
        body.sale_price_currency = saleParts[1] || currency;
      }
      if (opts.customLabel_0) body.custom_label_0 = opts.customLabel_0;
      if (opts.customLabel_1) body.custom_label_1 = opts.customLabel_1;

      const response = await client.request(`${opts.catalogId}/products`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  catalog
    .command('update-product <productId>')
    .description('Update an existing product')
    .option('--name <name>', 'Product name')
    .option('--price <amount>', 'Price (e.g., "29.99 USD")')
    .option('--url <url>', 'Product page URL')
    .option('--image-url <url>', 'Product image URL')
    .option('--description <text>', 'Product description')
    .option('--availability <status>', 'Availability: in stock, out of stock, preorder')
    .option('--sale-price <amount>', 'Sale price (e.g., "19.99 USD")')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (productId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {};

      if (opts.name) body.name = opts.name;
      if (opts.url) body.url = opts.url;
      if (opts.imageUrl) body.image_url = opts.imageUrl;
      if (opts.description) body.description = opts.description;
      if (opts.availability) body.availability = opts.availability;
      if (opts.price) {
        const priceParts = opts.price.split(' ');
        body.price = String(Math.round(parseFloat(priceParts[0]) * 100));
        body.currency = priceParts[1] || 'USD';
      }
      if (opts.salePrice) {
        const saleParts = opts.salePrice.split(' ');
        body.sale_price = String(Math.round(parseFloat(saleParts[0]) * 100));
      }

      if (Object.keys(body).length === 0) {
        throw new Error('No update parameters provided');
      }

      const response = await client.request(productId, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  catalog
    .command('delete-product <productId>')
    .description('Delete a product from a catalog')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (productId: string, opts) => {
      const client = getClient();
      const response = await client.request(productId, { method: 'DELETE' });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  catalog
    .command('feeds <catalogId>')
    .description('List product feeds for a catalog')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (catalogId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,created_time,product_count,latest_upload,schedule',
      };

      const response = await client.request(`${catalogId}/product_feeds`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  catalog
    .command('create-feed')
    .description('Create a product feed for a catalog')
    .requiredOption('--catalog-id <id>', 'Catalog ID')
    .requiredOption('--name <name>', 'Feed name')
    .requiredOption('--feed-url <url>', 'URL to fetch product feed from')
    .option('--schedule <json>', 'Feed schedule as JSON (e.g., {"interval":"HOURLY"})')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const body: Record<string, string> = {
        name: opts.name,
        schedule: opts.schedule || JSON.stringify({ interval: 'DAILY', url: opts.feedUrl }),
      };

      const response = await client.request(`${opts.catalogId}/product_feeds`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  catalog
    .command('create-product-set')
    .description('Create a product set within a catalog')
    .requiredOption('--catalog-id <id>', 'Catalog ID')
    .requiredOption('--name <name>', 'Product set name')
    .option('--filter <json>', 'Product filter as JSON')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const body: Record<string, string> = {
        name: opts.name,
      };
      if (opts.filter) body.filter = opts.filter;

      const response = await client.request(`${opts.catalogId}/product_sets`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  catalog
    .command('upload-feed')
    .description('Upload or update a product feed for a catalog')
    .requiredOption('--catalog-id <id>', 'Catalog ID')
    .requiredOption('--name <name>', 'Feed name')
    .option('--feed-url <url>', 'URL to fetch product feed from')
    .option('--schedule <json>', 'Feed schedule as JSON (e.g., {"interval":"HOURLY"})')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const body: Record<string, string> = {
        name: opts.name,
      };
      if (opts.feedUrl) body.url = opts.feedUrl;
      if (opts.schedule) body.schedule = opts.schedule;

      const response = await client.request(`${opts.catalogId}/product_feeds`, {
        method: 'POST',
        body,
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  catalog
    .command('dynamic-template')
    .description('Create a dynamic ad template for product-based ads')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--name <name>', 'Template name')
    .requiredOption('--catalog-id <id>', 'Catalog ID')
    .requiredOption('--page-id <id>', 'Facebook Page ID')
    .option('--message <text>', 'Ad body text (use {{product.name}} for dynamic fields)')
    .option('--headline <text>', 'Headline template')
    .option('--description <text>', 'Description template')
    .option('--cta <type>', 'Call to action', 'SHOP_NOW')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();

      const templateData: Record<string, unknown> = {
        call_to_action: { type: opts.cta },
        multi_share_end_card: false,
      };
      if (opts.message) templateData.message = opts.message;
      if (opts.headline) templateData.name = opts.headline;
      if (opts.description) templateData.description = opts.description;

      const body: Record<string, string> = {
        name: opts.name,
        object_story_spec: JSON.stringify({
          page_id: opts.pageId,
          template_data: templateData,
        }),
      };

      const response = await client.request(`${opts.accountId}/adcreatives`, {
        method: 'POST',
        body,
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  catalog
    .command('collection-ad')
    .description('Create a collection ad with multiple products')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--campaign-id <id>', 'Campaign ID')
    .requiredOption('--adset-id <id>', 'Ad set ID')
    .requiredOption('--page-id <id>', 'Facebook Page ID')
    .requiredOption('--product-set-id <id>', 'Product set ID')
    .option('--name <name>', 'Ad name', 'Collection Ad')
    .option('--headline <text>', 'Collection headline')
    .option('--cta <type>', 'Call to action', 'SHOP_NOW')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();

      // Create collection creative
      const creativeBody: Record<string, string> = {
        name: `${opts.name} - Creative`,
        object_story_spec: JSON.stringify({
          page_id: opts.pageId,
          template_data: {
            product_set_id: opts.productSetId,
            call_to_action: { type: opts.cta },
            name: opts.headline || '',
          },
        }),
      };

      const creativeResponse = await client.request(`${opts.accountId}/adcreatives`, {
        method: 'POST',
        body: creativeBody,
      });
      const creativeId = (creativeResponse.data as Record<string, unknown>).id as string;

      // Create ad
      const adBody: Record<string, string> = {
        name: opts.name,
        adset_id: opts.adsetId,
        creative: JSON.stringify({ creative_id: creativeId }),
        status: 'PAUSED',
      };

      const adResponse = await client.request(`${opts.accountId}/ads`, {
        method: 'POST',
        body: adBody,
      });

      console.log(formatOutput({
        creative: creativeResponse.data,
        ad: adResponse.data,
      }, opts.output as OutputFormat));
    }));

  catalog
    .command('product-performance <catalogId>')
    .description('Get performance metrics for products in a catalog')
    .option('--date-start <date>', 'Start date (YYYY-MM-DD)')
    .option('--date-end <date>', 'End date (YYYY-MM-DD)')
    .option('--limit <n>', 'Max products', '25')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (catalogId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,price,currency,availability,image_url',
        limit: opts.limit,
      };

      // Get products
      const productsResponse = await client.request(`${catalogId}/products`, { params });

      // Get catalog-level insights if available
      const insightParams: Record<string, string> = {
        fields: 'id,name,product_count',
      };
      const catalogResponse = await client.request(catalogId, { params: insightParams });

      console.log(formatOutput({
        catalog: catalogResponse.data,
        products: productsResponse.data,
      }, opts.output as OutputFormat));
    }));
}