// Checks a seed file and turns it into clean data for the database.
//
// It collects EVERY problem instead of stopping at the first, so one run shows
// everything that needs fixing. If there is any problem, nothing is returned
// and the loader writes nothing.
//
// The rules come from CLAUDE.md ("Seed data") and docs/terms-sheet.md.

import { isValidGtin } from './gtin.ts';
import type {
  CleanMsrp,
  CleanProduct,
  CleanSeed,
  CleanVariant,
  ProductStatus,
  ProductType,
  ValidationResult,
} from './types.ts';

// Hosts whose row in docs/terms-sheet.md says "allowed". Keep the two in sync:
// add a host here only after its terms-sheet row says allowed.
export const ALLOWED_SOURCE_HOSTS = [
  'www.fujifilm-x.com',
  'www.fujifilm.com',
  'newsroom-us.fujifilm.com',
];

// Never allowed, whatever the list above says (the US store's terms forbid it).
const FORBIDDEN_HOSTS = ['shopusa.fujifilm-x.com'];

// The terms decision for www.fujifilm.com only covers its US pages.
const PATH_LIMITS: Record<string, string | undefined> = {
  'www.fujifilm.com': '/us/',
};

const PRODUCT_TYPES: ProductType[] = ['body', 'lens', 'compact', 'accessory'];
const PRODUCT_STATUSES: ProductStatus[] = ['current', 'discontinued'];
const GTIN_SOURCE_TYPES = ['manufacturer', 'gs1', 'box', 'retailer'];

// The only kit labels allowed, so they can't drift ("Body Only", "body", "Kit"...).
// Each fixed label belongs to exactly one product type.
const FIXED_KIT_LABEL: Record<string, string | undefined> = {
  body: 'Body only',
  lens: 'Lens only',
  compact: 'Camera only',
};
// "with " + a lens name: single spaces only, no leading or trailing space.
const WITH_LENS_LABEL = /^with \S+( \S+)*$/;

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface ValidateOptions {
  // Tests pass their own list so the fake fixture can use example URLs.
  allowedHosts?: string[];
}

// Shared state for one validation run.
interface Context {
  errors: string[];
  sources: Record<string, string>;
  allowedHosts: string[];
}

export function validateSeed(raw: unknown, options: ValidateOptions = {}): ValidationResult {
  const ctx: Context = {
    errors: [],
    sources: {},
    allowedHosts: options.allowedHosts ?? ALLOWED_SOURCE_HOSTS,
  };

  if (!isRecord(raw)) {
    return { ok: false, errors: ['The seed file must be a JSON object.'] };
  }

  ctx.sources = readSourceKeys(ctx, raw.sources);
  const brand = readBrand(ctx, raw.brand);

  const products: CleanProduct[] = [];
  if (!Array.isArray(raw.products)) {
    ctx.errors.push('products: must be a list.');
  } else {
    raw.products.forEach((rawProduct, index) => {
      const product = readProduct(ctx, rawProduct, `products[${index}]`);
      if (product) {
        products.push(product);
      }
    });
  }

  checkDuplicates(ctx, products);

  if (ctx.errors.length > 0 || brand === null) {
    return { ok: false, errors: ctx.errors };
  }
  return { ok: true, seed: { brand, products } };
}

// ---------------------------------------------------------------------------
// Top-level parts
// ---------------------------------------------------------------------------

// "sources" lets long URLs be written once and referred to by a short key.
function readSourceKeys(ctx: Context, raw: unknown): Record<string, string> {
  if (raw === undefined) {
    return {};
  }
  if (!isRecord(raw)) {
    ctx.errors.push('sources: must be an object of key -> URL.');
    return {};
  }
  const sources: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      ctx.errors.push(`sources.${key}: must be a URL string.`);
    } else {
      sources[key] = value;
    }
  }
  return sources;
}

function readBrand(ctx: Context, raw: unknown): { name: string; slug: string } | null {
  if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.slug !== 'string') {
    ctx.errors.push('brand: must be { "name": ..., "slug": ... }.');
    return null;
  }
  if (!SLUG_PATTERN.test(raw.slug)) {
    ctx.errors.push(`brand.slug: "${raw.slug}" must be lowercase letters, digits and single hyphens.`);
  }
  return { name: raw.name, slug: raw.slug };
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

function readProduct(ctx: Context, raw: unknown, path: string): CleanProduct | null {
  if (!isRecord(raw)) {
    ctx.errors.push(`${path}: must be an object.`);
    return null;
  }

  const slug = typeof raw.slug === 'string' ? raw.slug : '';
  if (!SLUG_PATTERN.test(slug)) {
    ctx.errors.push(`${path}.slug: "${slug}" must be lowercase letters, digits and single hyphens.`);
  }
  // From here on, error messages name the product, which is easier to find.
  const where = slug || path;

  const modelName = readFact(ctx, raw.model_name, `${where}.model_name`, { required: true });
  const type = readChoice(ctx, raw.type, `${where}.type`, PRODUCT_TYPES);
  const status = readChoice(ctx, raw.status, `${where}.status`, PRODUCT_STATUSES);
  const mount = readMount(ctx, raw.mount, `${where}.mount`, type);
  const announcedOn = readFact(ctx, raw.announced_on, `${where}.announced_on`, { required: false });
  if (announcedOn !== null && !isValidDate(announcedOn)) {
    ctx.errors.push(`${where}.announced_on: "${announcedOn}" must be a real date as YYYY-MM-DD.`);
  }

  const variants = type === null ? [] : readVariants(ctx, raw.variants, where, type);

  if (modelName === null || type === null || status === null) {
    return null;
  }
  return { slug, modelName, type, mount, announcedOn, status, variants };
}

// Bodies and lenses must have a known mount. Compacts and accessories may say
// null ("doesn't apply"), because a fixed-lens camera has no mount.
function readMount(ctx: Context, raw: unknown, path: string, type: ProductType | null): string | null {
  const mountRequired = type === 'body' || type === 'lens';
  if (raw === null && mountRequired) {
    ctx.errors.push(`${path}: a ${type} must have a mount.`);
    return null;
  }
  if (raw === null) {
    return null;
  }
  return readFact(ctx, raw, path, { required: mountRequired });
}

function readChoice<T extends string>(ctx: Context, raw: unknown, path: string, allowed: T[]): T | null {
  const value = readFact(ctx, raw, path, { required: true });
  if (value === null) {
    return null;
  }
  if (!(allowed as string[]).includes(value)) {
    ctx.errors.push(`${path}: "${value}" must be one of ${allowed.join(', ')}.`);
    return null;
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

function readVariants(ctx: Context, raw: unknown, where: string, type: ProductType): CleanVariant[] {
  // "unknown" means no allowed source lists any variant yet: load none.
  if (raw === 'unknown') {
    return [];
  }
  if (!Array.isArray(raw)) {
    ctx.errors.push(`${where}.variants: must be a list, or "unknown".`);
    return [];
  }

  const variants: CleanVariant[] = [];
  raw.forEach((rawVariant, index) => {
    const variant = readVariant(ctx, rawVariant, `${where}.variants[${index}]`, type);
    if (variant) {
      variants.push(variant);
    }
  });
  return variants;
}

function readVariant(ctx: Context, raw: unknown, path: string, type: ProductType): CleanVariant | null {
  if (!isRecord(raw)) {
    ctx.errors.push(`${path}: must be an object.`);
    return null;
  }

  const kitContents = readFact(ctx, raw.kit_contents, `${path}.kit_contents`, { required: true });
  if (kitContents !== null) {
    checkKitLabel(ctx, kitContents, type, `${path}.kit_contents`);
  }

  // Color may be null ("doesn't apply", e.g. sold in one color) or unknown.
  const color = raw.color === null ? null : readFact(ctx, raw.color, `${path}.color`, { required: false });

  if (typeof raw.is_bundle !== 'boolean') {
    ctx.errors.push(`${path}.is_bundle: must be true or false.`);
  }
  const isBundle = raw.is_bundle === true;

  const gtin = readGtin(ctx, raw.gtin, `${path}.gtin`);
  const mpn = readFact(ctx, raw.mpn, `${path}.mpn`, { required: false });
  const msrp = readMsrpList(ctx, raw.msrp, `${path}.msrp`);

  if (kitContents === null) {
    return null;
  }
  return { kitContents, color, isBundle, gtin, mpn, msrp };
}

function checkKitLabel(ctx: Context, kit: string, type: ProductType, path: string): void {
  const fixedLabels = Object.values(FIXED_KIT_LABEL);
  const isFixedLabel = fixedLabels.includes(kit);
  const isWithLens = WITH_LENS_LABEL.test(kit);

  if (!isFixedLabel && !isWithLens) {
    ctx.errors.push(
      `${path}: "${kit}" must be exactly "Body only", "Lens only", "Camera only" or "with <lens name>".`,
    );
    return;
  }
  if (isFixedLabel && FIXED_KIT_LABEL[type] !== kit) {
    ctx.errors.push(`${path}: "${kit}" doesn't fit a ${type}.`);
  }
  if (isWithLens && type !== 'body') {
    ctx.errors.push(`${path}: only bodies come in "with <lens>" kits, not a ${type}.`);
  }
}

// ---------------------------------------------------------------------------
// GTIN and MSRP
// ---------------------------------------------------------------------------

function readGtin(ctx: Context, raw: unknown, path: string): string | null {
  if (!isRecord(raw) || typeof raw.value !== 'string') {
    ctx.errors.push(`${path}: must be { "value": ... } (use "unknown" if not known).`);
    return null;
  }
  if (raw.value === 'unknown') {
    return null;
  }
  if (!isValidGtin(raw.value)) {
    ctx.errors.push(`${path}: "${raw.value}" fails the GTIN check digit (or has the wrong length).`);
  }

  const sourceType = raw.source_type;
  if (typeof sourceType !== 'string' || !GTIN_SOURCE_TYPES.includes(sourceType)) {
    ctx.errors.push(`${path}.source_type: must be one of ${GTIN_SOURCE_TYPES.join(', ')}.`);
    return null;
  }

  if (sourceType === 'retailer') {
    checkRetailerGtinSources(ctx, raw.sources, `${path}.sources`);
  } else if (sourceType === 'box') {
    // A box has no URL; record who read it and when instead.
    if (typeof raw.read_by !== 'string' || raw.read_by === '') {
      ctx.errors.push(`${path}.read_by: a box GTIN needs the name of who read it.`);
    }
    if (typeof raw.read_on !== 'string' || !isValidDate(raw.read_on)) {
      ctx.errors.push(`${path}.read_on: a box GTIN needs the date it was read (YYYY-MM-DD).`);
    }
  } else {
    checkSource(ctx, raw.source, `${path}.source`);
  }
  return raw.value;
}

// CLAUDE.md: a retailer GTIN needs two independent retailers showing the same number.
function checkRetailerGtinSources(ctx: Context, raw: unknown, path: string): void {
  if (!Array.isArray(raw) || raw.length < 2) {
    ctx.errors.push(`${path}: a retailer GTIN needs at least two retailer URLs.`);
    return;
  }
  const hosts = new Set<string>();
  raw.forEach((source, index) => {
    const url = checkSource(ctx, source, `${path}[${index}]`);
    if (url) {
      hosts.add(new URL(url).host);
    }
  });
  if (hosts.size < 2) {
    ctx.errors.push(`${path}: the two retailers must be different sites.`);
  }
}

function readMsrpList(ctx: Context, raw: unknown, path: string): CleanMsrp[] {
  if (!Array.isArray(raw)) {
    ctx.errors.push(`${path}: must be a list (it can be empty).`);
    return [];
  }
  const rows: CleanMsrp[] = [];
  raw.forEach((rawRow, index) => {
    const row = readMsrp(ctx, rawRow, `${path}[${index}]`);
    if (row) {
      rows.push(row);
    }
  });
  return rows;
}

function readMsrp(ctx: Context, raw: unknown, path: string): CleanMsrp | null {
  if (!isRecord(raw)) {
    ctx.errors.push(`${path}: must be an object.`);
    return null;
  }
  // An MSRP row whose price is unknown is just a placeholder; skip it.
  if (raw.price === 'unknown') {
    return null;
  }

  const errorsBefore = ctx.errors.length;
  const region = typeof raw.region === 'string' ? raw.region : '';
  const currency = typeof raw.currency === 'string' ? raw.currency : '';
  const asOf = typeof raw.as_of === 'string' ? raw.as_of : '';

  if (!/^[A-Z]{2}$/.test(region)) {
    ctx.errors.push(`${path}.region: "${region}" must be a two-letter code like "US".`);
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    ctx.errors.push(`${path}.currency: "${currency}" must be a three-letter code like "USD".`);
  }
  if (!isValidDate(asOf)) {
    ctx.errors.push(`${path}.as_of: "${asOf}" must be a real date as YYYY-MM-DD.`);
  }
  const priceCents = priceTextToCents(raw.price);
  if (priceCents === null) {
    ctx.errors.push(`${path}.price: must be text like "1399.95" (two decimal places, above zero).`);
  }
  const sourceUrl = checkSource(ctx, raw.source, `${path}.source`);

  if (ctx.errors.length > errorsBefore || priceCents === null || sourceUrl === null) {
    return null;
  }
  return { region, priceCents, currency, asOf, sourceUrl };
}

// Prices are written as text ("1399.95") and converted digit by digit, so no
// decimal rounding can creep in.
export function priceTextToCents(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^\d+\.\d{2}$/.test(raw)) {
    return null;
  }
  const [dollars, cents] = raw.split('.');
  const total = Number(dollars) * 100 + Number(cents);
  return total > 0 ? total : null;
}

// ---------------------------------------------------------------------------
// Facts and sources
// ---------------------------------------------------------------------------

// A fact is { "value": ..., "source": ... } or { "value": "unknown" }.
// Returns the value, or null when it's unknown.
function readFact(ctx: Context, raw: unknown, path: string, rules: { required: boolean }): string | null {
  if (!isRecord(raw) || typeof raw.value !== 'string') {
    ctx.errors.push(`${path}: must be { "value": ..., "source": ... } or { "value": "unknown" }.`);
    return null;
  }
  if (raw.value === 'unknown') {
    if (rules.required) {
      ctx.errors.push(`${path}: is required, but is unknown.`);
    }
    return null;
  }
  if (raw.value === '' || raw.value.trim() !== raw.value) {
    ctx.errors.push(`${path}: "${raw.value}" is empty or has extra spaces at the ends.`);
  }
  checkSource(ctx, raw.source, `${path}.source`);
  return raw.value;
}

// Every known value needs a source on an allowed host. A source can be a URL,
// a URL followed by a note in brackets, or a key from the "sources" section.
// Returns the bare URL, or null if the source isn't acceptable.
function checkSource(ctx: Context, raw: unknown, path: string): string | null {
  if (typeof raw !== 'string' || raw === '') {
    ctx.errors.push(`${path}: every known value needs a source.`);
    return null;
  }

  const resolved = ctx.sources[raw] ?? raw;
  const urlText = resolved.split(' ')[0] ?? '';
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    ctx.errors.push(`${path}: "${raw}" is not a URL or a key in "sources".`);
    return null;
  }

  if (FORBIDDEN_HOSTS.includes(url.host)) {
    ctx.errors.push(`${path}: ${url.host} must never be used (see docs/terms-sheet.md).`);
    return null;
  }
  if (url.protocol !== 'https:') {
    ctx.errors.push(`${path}: must be an https:// URL.`);
  }
  if (!ctx.allowedHosts.includes(url.host)) {
    ctx.errors.push(`${path}: ${url.host} has no "allowed" row in docs/terms-sheet.md.`);
    return null;
  }
  const requiredPathStart = PATH_LIMITS[url.host];
  if (requiredPathStart && !url.pathname.startsWith(requiredPathStart)) {
    ctx.errors.push(`${path}: only ${url.host}${requiredPathStart}... pages are allowed.`);
    return null;
  }
  return urlText;
}

// ---------------------------------------------------------------------------
// Duplicates across the whole file
// ---------------------------------------------------------------------------

function checkDuplicates(ctx: Context, products: CleanProduct[]): void {
  const slugs = new Set<string>();
  const modelNames = new Set<string>();
  const gtins = new Set<string>();

  for (const product of products) {
    if (slugs.has(product.slug)) {
      ctx.errors.push(`${product.slug}: this slug is used more than once.`);
    }
    slugs.add(product.slug);

    if (modelNames.has(product.modelName)) {
      ctx.errors.push(`${product.slug}: model name "${product.modelName}" is used more than once.`);
    }
    modelNames.add(product.modelName);

    // Unknown and "doesn't apply" colors are both stored as empty, so they
    // count as the same color here, just as they do in the database.
    const variantKeys = new Set<string>();
    for (const variant of product.variants) {
      const key = `${variant.kitContents} / ${variant.color ?? '(no color)'}`;
      if (variantKeys.has(key)) {
        ctx.errors.push(`${product.slug}: two variants are both "${key}".`);
      }
      variantKeys.add(key);

      if (variant.gtin !== null) {
        if (gtins.has(variant.gtin)) {
          ctx.errors.push(`${product.slug}: GTIN ${variant.gtin} is used by more than one variant.`);
        }
        gtins.add(variant.gtin);
      }

      const msrpKeys = new Set<string>();
      for (const row of variant.msrp) {
        const msrpKey = `${row.region} ${row.asOf}`;
        if (msrpKeys.has(msrpKey)) {
          ctx.errors.push(`${product.slug} (${key}): two MSRP rows for ${msrpKey}.`);
        }
        msrpKeys.add(msrpKey);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// True for real calendar dates only (rejects 2024-02-30).
function isValidDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false;
  }
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}
