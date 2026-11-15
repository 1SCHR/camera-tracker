// Shapes used by the seed loader.
//
// The seed file on disk is loose JSON with sources and notes for humans.
// The validator turns it into these "clean" shapes, which hold only what the
// database stores. "unknown" and "doesn't apply" both become null here.

export type ProductType = 'body' | 'lens' | 'compact' | 'accessory';
export type ProductStatus = 'current' | 'discontinued';

export interface CleanMsrp {
  region: string;       // e.g. 'US'
  priceCents: number;   // whole cents, e.g. 139995 for $1,399.95
  currency: string;     // e.g. 'USD'
  asOf: string;         // 'YYYY-MM-DD'
  sourceUrl: string;
}

export interface CleanVariant {
  kitContents: string;  // 'Body only', 'Lens only', 'Camera only' or 'with <lens name>'
  color: string | null;
  isBundle: boolean;
  gtin: string | null;
  mpn: string | null;
  msrp: CleanMsrp[];
}

export interface CleanProduct {
  slug: string;
  modelName: string;
  type: ProductType;
  mount: string | null;
  announcedOn: string | null;
  status: ProductStatus;
  variants: CleanVariant[];
}

export interface CleanSeed {
  brand: { name: string; slug: string };
  products: CleanProduct[];
}

export type ValidationResult =
  | { ok: true; seed: CleanSeed }
  | { ok: false; errors: string[] };
