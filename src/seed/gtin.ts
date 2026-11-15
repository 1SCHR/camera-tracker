// GTIN check-digit validation (UPC-A is a 12-digit GTIN, EAN-13 is 13 digits).
//
// Why this matters: the matcher trusts barcodes more than anything else, so a
// single mistyped digit would quietly attach listings to the wrong product.
// The last digit of every GTIN is calculated from the others, which lets us
// catch most typos before they reach the database.

const VALID_LENGTHS = [8, 12, 13, 14];

export function isValidGtin(code: string): boolean {
  if (!/^\d+$/.test(code)) {
    return false;
  }
  if (!VALID_LENGTHS.includes(code.length)) {
    return false;
  }

  const digits = code.split('').map(Number);
  const givenCheckDigit = digits.pop();
  if (givenCheckDigit === undefined) {
    return false;
  }

  return givenCheckDigit === calculateCheckDigit(digits);
}

// GS1's rule: starting from the digit just left of the check digit and moving
// left, multiply digits alternately by 3 and 1, add them up, and the check
// digit is whatever brings the total up to the next multiple of 10.
export function calculateCheckDigit(dataDigits: number[]): number {
  let total = 0;
  const fromRight = [...dataDigits].reverse();

  fromRight.forEach((digit, index) => {
    const weight = index % 2 === 0 ? 3 : 1;
    total += digit * weight;
  });

  return (10 - (total % 10)) % 10;
}
