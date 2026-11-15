import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSeed, priceTextToCents, ALLOWED_SOURCE_HOSTS } from '../../src/seed/validate.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const TEST_HOSTS = { allowedHosts: ['seed.example'] };

// A fresh copy of the fake seed, so each test can break it in its own way.
function fakeSeed(): any {
  return JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'fake-seed.json'), 'utf8'));
}

// Validates a broken seed and returns its error list (failing if it passed).
function errorsFor(seed: unknown): string[] {
  const result = validateSeed(seed, TEST_HOSTS);
  if (result.ok) {
    throw new Error('Expected the seed to be refused, but it passed.');
  }
  return result.errors;
}

describe('valid seeds', () => {
  it('accepts the fake seed and cleans it up', () => {
    const result = validateSeed(fakeSeed(), TEST_HOSTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [body, lens, compact] = result.seed.products;
    expect(body?.variants).toHaveLength(2);
    expect(body?.variants[0]?.msrp[0]?.priceCents).toBe(99995);
    expect(body?.variants[0]?.msrp[0]?.sourceUrl).toBe('https://seed.example/news/tb-1-launch');
    expect(body?.variants[1]?.color).toBeNull(); // unknown color becomes empty
    expect(lens?.variants[0]?.color).toBeNull(); // "doesn't apply" also becomes empty
    expect(compact?.mount).toBeNull();
    expect(compact?.variants).toEqual([]); // "variants": "unknown" loads none
  });

  it('accepts the real Fujifilm seed with the real allowed-host list', () => {
    const real = JSON.parse(readFileSync(join(ROOT, 'seed', 'fujifilm.json'), 'utf8'));
    const result = validateSeed(real);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });
});

describe('the validator refuses bad seeds', () => {
  it('lists every problem, not just the first', () => {
    const seed = fakeSeed();
    seed.products[0].status = { value: 'unknown' };
    seed.products[1].model_name = { value: 'unknown' };
    expect(errorsFor(seed)).toHaveLength(2);
  });

  it('refuses unknown required fields', () => {
    const seed = fakeSeed();
    seed.products[0].type = { value: 'unknown' };
    expect(errorsFor(seed).join('\n')).toContain('testbrand-tb-1.type: is required, but is unknown');
  });

  it('refuses a body or lens without a known mount', () => {
    const seed = fakeSeed();
    seed.products[0].mount = { value: 'unknown' };
    seed.products[1].mount = null;
    const errors = errorsFor(seed).join('\n');
    expect(errors).toContain('testbrand-tb-1.mount: is required, but is unknown');
    expect(errors).toContain('testbrand-tb-18mm-f2.mount: a lens must have a mount');
  });

  it('refuses null where a field always applies', () => {
    const seed = fakeSeed();
    seed.products[0].status = null;
    expect(errorsFor(seed).join('\n')).toContain('testbrand-tb-1.status: must be');
  });

  it('refuses a known value with no source', () => {
    const seed = fakeSeed();
    delete seed.products[0].model_name.source;
    expect(errorsFor(seed).join('\n')).toContain('model_name.source: every known value needs a source');
  });

  it('refuses sources on hosts without an allowed terms-sheet row', () => {
    const seed = fakeSeed();
    seed.products[0].status.source = 'https://other.example/page';
    expect(errorsFor(seed).join('\n')).toContain('other.example has no "allowed" row');
  });

  it('never accepts the Fujifilm US store, even if it were in the allowed list', () => {
    const seed = fakeSeed();
    seed.products[0].status.source = 'https://shopusa.fujifilm-x.com/x-t5/';
    const result = validateSeed(seed, { allowedHosts: ['seed.example', 'shopusa.fujifilm-x.com'] });
    expect(result.ok ? [] : result.errors.join('\n')).toContain('must never be used');
  });

  it('only allows the US pages of www.fujifilm.com', () => {
    const seed = fakeSeed();
    seed.products[0].status.source = 'https://www.fujifilm.com/uk/en/products';
    const result = validateSeed(seed, { allowedHosts: ['seed.example', ...ALLOWED_SOURCE_HOSTS] });
    expect(result.ok ? [] : result.errors.join('\n')).toContain('only www.fujifilm.com/us/... pages are allowed');
  });

  it('refuses a source key that is not in "sources"', () => {
    const seed = fakeSeed();
    seed.products[0].announced_on.source = 'pr_missing';
    expect(errorsFor(seed).join('\n')).toContain('"pr_missing" is not a URL or a key in "sources"');
  });

  it('only accepts the four kit-label forms', () => {
    for (const badLabel of ['Body Only', 'body only', 'Kit', 'with  TB 18mm F2', 'with TB 18mm F2 ', 'With TB 18mm F2']) {
      const seed = fakeSeed();
      seed.products[0].variants[0].kit_contents.value = badLabel;
      expect(errorsFor(seed).join('\n')).toContain(`"${badLabel}" must be exactly`);
    }
  });

  it('refuses a fixed kit label on the wrong product type', () => {
    const seed = fakeSeed();
    seed.products[0].variants[0].kit_contents.value = 'Lens only';
    seed.products[1].variants[0].kit_contents.value = 'with TB 50mm F2';
    const errors = errorsFor(seed).join('\n');
    expect(errors).toContain('"Lens only" doesn\'t fit a body');
    expect(errors).toContain('only bodies come in "with <lens>" kits, not a lens');
  });

  it('refuses badly written prices and dates', () => {
    const seed = fakeSeed();
    seed.products[0].variants[0].msrp[0].price = '999.9';
    seed.products[0].variants[1].msrp[0].as_of = '2025-02-30';
    const errors = errorsFor(seed).join('\n');
    expect(errors).toContain('msrp[0].price: must be text like "1399.95"');
    expect(errors).toContain('"2025-02-30" must be a real date');
  });

  it('refuses a GTIN that fails its check digit', () => {
    const seed = fakeSeed();
    seed.products[0].variants[0].gtin.value = '012345678904';
    expect(errorsFor(seed).join('\n')).toContain('fails the GTIN check digit');
  });

  it('requires two different retailer sites for a retailer GTIN', () => {
    const seed = fakeSeed();
    seed.products[0].variants[0].gtin = {
      value: '012345678905',
      source_type: 'retailer',
      sources: ['https://seed.example/shop-a/tb-1', 'https://seed.example/shop-b/tb-1'],
    };
    expect(errorsFor(seed).join('\n')).toContain('the two retailers must be different sites');
  });

  it('requires who and when for a GTIN read off a box', () => {
    const seed = fakeSeed();
    seed.products[0].variants[0].gtin = { value: '012345678905', source_type: 'box' };
    const errors = errorsFor(seed).join('\n');
    expect(errors).toContain('read_by');
    expect(errors).toContain('read_on');
  });

  it('refuses duplicate slugs, variants and MSRP dates', () => {
    const seed = fakeSeed();
    seed.products[1].slug = 'testbrand-tb-1';
    seed.products[0].variants[1] = structuredClone(seed.products[0].variants[0]);
    seed.products[0].variants[1].gtin = { value: 'unknown' };
    seed.products[0].variants[0].msrp.push(structuredClone(seed.products[0].variants[0].msrp[0]));
    const errors = errorsFor(seed).join('\n');
    expect(errors).toContain('this slug is used more than once');
    expect(errors).toContain('two variants are both "Body only / Black"');
    expect(errors).toContain('two MSRP rows for US 2025-03-10');
  });
});

describe('price text to cents', () => {
  it('converts digit by digit, with no rounding', () => {
    expect(priceTextToCents('1399.95')).toBe(139995);
    expect(priceTextToCents('0.10')).toBe(10);
    expect(priceTextToCents('4995.95')).toBe(499595);
  });

  it('refuses anything that is not plain dollars and two-digit cents', () => {
    for (const bad of ['1,399.95', '$1399.95', '1399.9', '1399', '0.00', 1399.95]) {
      expect(priceTextToCents(bad)).toBeNull();
    }
  });
});
