import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { parseJsonInput } from '../json-input.js';
import { deriveMetrics, PERFORMANCE_FIELDS } from '../metrics.js';
import { insightsTimeParams } from '../time-range.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

/**
 * Parse a price like "29.99 USD", "29,99 EUR" or "1000 JPY" into Meta's
 * minor-unit amount (cents for USD, whole yen for JPY) and currency.
 */
export function parsePrice(input: string, defaultCurrency = 'USD'): { amount: number; currency: string } {
  const match = String(input).trim().match(/^([\d.,]+)\s*([A-Za-z]{3})?$/);
  if (!match) {
    throw new Error(`Invalid price "${input}". Expected e.g. "29.99 USD"`);
  }
  let num = match[1];
  if (num.includes(',') && num.includes('.')) {
    // "1,299.99": commas are thousands separators
    num = num.replace(/,/g, '');
  } else if (num.includes(',')) {
    // "29,99" is a decimal comma; "1,299" is a thousands separator
    num = /,\d{3}$/.test(num) ? num.replace(/,/g, '') : num.replace(',', '.');
  }
  if (!/^\d+(\.\d+)?$/.test(num)) {
    throw new Error(`Invalid price "${input}". Expected e.g. "29.99 USD"`);
  }
  const currency = (match[2] || defaultCurrency).toUpperCase();
  // Intl accepts any well-formed code, so check against the known list.
  const known = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('currency');
  if (known && !known.includes(currency)) {
    throw new Error(`Unknown currency "${currency}" in price "${input}"`);
  }
  let digits: number;
  try {
    digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    throw new Error(`Unknown currency "${currency}" in price "${input}"`);
  }
  return { amount: Math.round(Number(num) * 10 ** digits), currency };
}

/**
 * Sum ad-level insights rows (broken down by product_id) per product and join
 * them to catalog products. Meta's product_id breakdown value may carry the
 * retailer ID followed by the product name, so it's matched against both the
 * catalog's product ID and retailer_id.
 */
export function summarizeProductPerformance(
  rows: Array<Record<string, unknown>>,
  products: Array<Record<string, string>>,
  resultEvent: string,
): Array<Record<string, unknown>> {
  const byKey = new Map<string, Record<string, string>>();
  for (const p of products) {
    if (p.id) byKey.set(String(p.id), p);
    if (p.retailer_id) byKey.set(String(p.retailer_id), p);
  }
  const totals = new Map<string, { spend: number; impressions: number; clicks: number; results: number; revenue: number }>();
  for (const row of rows) {
    const key = String(row.product_id ?? '').split(',')[0].trim();
    if (!key) continue;
    const m = deriveMetrics(row, resultEvent);
    const t = totals.get(key) || { spend: 0, impressions: 0, clicks: 0, results: 0, revenue: 0 };
    t.spend += m.spend;
    t.impressions += m.impressions;
    t.clicks += m.clicks;
    t.results += m.results;
    t.revenue += m.revenue;
    totals.set(key, t);
  }
  return [...totals.entries()]
    .map(([key, t]) => {
      const product = byKey.get(key);
      return {
        product_id: key,
        name: product?.name ?? null,
        retailer_id: product?.retailer_id ?? null,
        spend: Number(t.spend.toFixed(2)),
        impressions: t.impressions,
        clicks: t.clicks,
        results: t.results,
        cost_per_result: t.results > 0 ? Number((t.spend / t.results).toFixed(2)) : null,
        revenue: Number(t.revenue.toFixed(2)),
        roas: t.spend > 0 && t.revenue > 0 ? Number((t.revenue / t.spend).toFixed(2)) : null,
      };
    })
    .sort((a, b) => b.spend - a.spend);
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
      const { amount: priceValue, currency } = parsePrice(opts.price);

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
        const sale = parsePrice(opts.salePrice, currency);
        body.sale_price = String(sale.amount);
        body.sale_price_currency = sale.currency;
      }
      // Commander camel-cases --custom-label-0 to customLabel0
      if (opts.customLabel0) body.custom_label_0 = opts.customLabel0;
      if (opts.customLabel1) body.custom_label_1 = opts.customLabel1;

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
      let currency: string | undefined;
      if (opts.price) {
        const price = parsePrice(opts.price);
        body.price = String(price.amount);
        body.currency = currency = price.currency;
      }
      if (opts.salePrice) {
        const sale = parsePrice(opts.salePrice, currency);
        body.sale_price = String(sale.amount);
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
    .description('Create a collection ad: a cover image or video that opens an Instant Experience (canvas) with your products. Build the Instant Experience first (Ads Manager, or a template there) and pass its ID')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--adset-id <id>', 'Ad set ID')
    .requiredOption('--page-id <id>', 'Facebook Page ID')
    .requiredOption('--canvas-id <id>', 'Instant Experience (canvas) ID the ad opens')
    .option('--image-hash <hash>', 'Cover image hash')
    .option('--video-id <id>', 'Cover video ID (instead of an image)')
    .option('--message <text>', 'Ad body text')
    .option('--headline <text>', 'Headline')
    .option('--collection-thumbnails <json>', 'collection_thumbnails: canvas element IDs and crops for the product tiles (JSON, @file or -)')
    .option('--name <name>', 'Ad name', 'Collection Ad')
    .option('--status <status>', 'Ad status', 'PAUSED')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      if (!!opts.imageHash === !!opts.videoId) throw new Error('Give exactly one of --image-hash or --video-id for the cover');
      const client = getClient();
      const canvasUrl = `https://fb.com/canvas_doc/${opts.canvasId}`;

      // Collection ads link the cover to the Instant Experience's canvas_doc URL.
      const storySpec: Record<string, unknown> = { page_id: opts.pageId };
      if (opts.imageHash) {
        storySpec.link_data = {
          link: canvasUrl,
          image_hash: opts.imageHash,
          ...(opts.message ? { message: opts.message } : {}),
          ...(opts.headline ? { name: opts.headline } : {}),
          ...(opts.collectionThumbnails ? { collection_thumbnails: parseJsonInput(opts.collectionThumbnails, '--collection-thumbnails') } : {}),
        };
      } else {
        storySpec.video_data = {
          video_id: opts.videoId,
          call_to_action: { type: 'LEARN_MORE', value: { link: canvasUrl } },
          ...(opts.message ? { message: opts.message } : {}),
          ...(opts.headline ? { title: opts.headline } : {}),
          ...(opts.collectionThumbnails ? { collection_thumbnails: parseJsonInput(opts.collectionThumbnails, '--collection-thumbnails') } : {}),
        };
      }

      const creativeResponse = await client.request(`${opts.accountId}/adcreatives`, {
        method: 'POST',
        body: { name: `${opts.name} - Creative`, object_story_spec: JSON.stringify(storySpec) },
      });
      const creativeId = (creativeResponse.data as Record<string, unknown>).id as string;

      const adResponse = await client.request(`${opts.accountId}/ads`, {
        method: 'POST',
        body: {
          name: opts.name,
          adset_id: opts.adsetId,
          creative: JSON.stringify({ creative_id: creativeId }),
          status: opts.status,
        },
      });

      console.log(formatOutput({
        creative: creativeResponse.data,
        ad: adResponse.data,
        canvas_url: canvasUrl,
      }, opts.output as OutputFormat));
    }));

  catalog
    .command('product-performance <catalogId>')
    .description('Per-product spend, results, revenue and ROAS for catalog ads (insights broken down by product_id), joined to catalog product names')
    .option('--object-id <id>', 'Ad account (act_XXX), campaign or ad set to report on', getDefaultAccountId())
    .option('--time-range <range>', 'Named range: today, yesterday, last_7d, last_30d, last_90d, this_month, last_month, maximum', 'last_30d')
    .option('--since <date>', 'Start date YYYY-MM-DD (with --until)')
    .option('--until <date>', 'End date YYYY-MM-DD (with --since)')
    .option('--result-event <event>', 'Conversion counted as a result (purchase, add_to_cart, ...)', 'purchase')
    .option('--limit <n>', 'Max products in the output', '25')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (catalogId: string, opts) => {
      if (!opts.objectId) throw new Error('--object-id required (ad account, campaign or ad set running catalog ads)');
      const client = getClient();
      const insights = await client.requestAllPages(`${opts.objectId}/insights`, {
        params: {
          level: 'ad',
          breakdowns: 'product_id',
          fields: PERFORMANCE_FIELDS,
          ...insightsTimeParams(opts.timeRange, opts.since, opts.until),
        },
      });
      const rows = ((insights.data as { data?: Array<Record<string, unknown>> }).data) || [];
      const products = await client.requestAllPages(`${catalogId}/products`, {
        params: { fields: 'id,retailer_id,name,price,availability', limit: '500' },
      });
      const productRows = ((products.data as { data?: Array<Record<string, string>> }).data) || [];
      const performance = summarizeProductPerformance(rows, productRows, opts.resultEvent);
      console.log(formatOutput(performance.slice(0, Number(opts.limit) || 25), opts.output as OutputFormat));
    }));

  catalog
    .command('diagnostics <catalogId>')
    .description('Catalog health: feed errors, missing attributes, event-source (pixel match) issues and policy problems')
    .option('--types <types>', 'Comma-separated: ATTRIBUTES_INVALID, ATTRIBUTES_MISSING, EVENT_SOURCE_ISSUES, IMAGE_QUALITY, POLICY_VIOLATION, ...')
    .option('--severities <list>', 'MUST_FIX and/or OPPORTUNITY')
    .option('--affected-channels <list>', 'e.g. da (dynamic ads), shops, ig_product_tagging')
    .option('--affected-entities <list>', 'product_item, product_catalog, product_set, product_event')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (catalogId: string, opts) => {
      const params: Record<string, string> = {};
      const list = (v?: string) => JSON.stringify(String(v).split(',').map(x => x.trim()).filter(Boolean));
      if (opts.types) params.types = list(opts.types.toUpperCase());
      if (opts.severities) params.severities = list(opts.severities.toUpperCase());
      if (opts.affectedChannels) params.affected_channels = list(opts.affectedChannels);
      if (opts.affectedEntities) params.affected_entities = list(opts.affectedEntities);
      const response = await getClient().request(`${catalogId}/diagnostics`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  // ── Catalog Batch API ─────────────────────────────────

  catalog
    .command('batch <catalogId>')
    .description('Bulk create/update/delete products via batch API (up to 30MB)')
    .requiredOption('--requests <json>', 'JSON array of batch requests: [{method, retailer_id, data: {...}}, ...]')
    .option('--allow-upsert', 'Allow updates alongside creation')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (catalogId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {
        requests: opts.requests,
      };
      if (opts.allowUpsert) body.allow_upsert = 'true';

      const response = await client.request(`${catalogId}/items_batch`, {
        method: 'POST',
        body,
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  catalog
    .command('batch-status <catalogId>')
    .description('Check status of a batch upload')
    .requiredOption('--handle <handle>', 'Batch handle from batch upload response')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (catalogId: string, opts) => {
      const client = getClient();
      const response = await client.request(`${catalogId}/check_batch_request_status`, {
        params: { handle: opts.handle },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}