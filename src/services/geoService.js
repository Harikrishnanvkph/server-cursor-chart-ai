/**
 * Geo-Location Service
 * Detects the user's location based on incoming request headers or fallback heuristics.
 */

// Common headers provided by reverse proxies / cloud platforms (Vercel, Cloudflare, AWS CloudFront, etc.)
const COUNTRY_HEADER_KEYS = [
  'x-vercel-ip-country',
  'cf-ipcountry',
  'x-country-code',
  'cloudfront-viewer-country',
  'x-appengine-country',
  'fastly-client-ip-country'
];

/**
 * Detect country code from HTTP request
 * @param {import('express').Request} req
 * @returns {string} 2-letter uppercase ISO country code (e.g. 'IN', 'US') or 'GLOBAL'
 */
export function detectCountryFromRequest(req) {
  if (!req) return 'GLOBAL';

  // 1. Check direct query/header override if provided by client
  const clientHint = req.headers['x-client-country'] || req.query?.country;
  if (clientHint && typeof clientHint === 'string' && clientHint.length === 2) {
    return clientHint.toUpperCase();
  }

  // 2. Check cloud / proxy headers
  for (const headerKey of COUNTRY_HEADER_KEYS) {
    const value = req.headers[headerKey];
    if (value && typeof value === 'string' && value.length === 2 && value !== 'XX' && value !== 'T1') {
      return value.toUpperCase();
    }
  }

  // 3. Check Accept-Language header for regional clues (e.g., en-IN, hi, ta, te, kn, mr, bn)
  const acceptLanguage = req.headers['accept-language'];
  if (acceptLanguage && typeof acceptLanguage === 'string') {
    const upperLang = acceptLanguage.toUpperCase();
    if (upperLang.includes('-IN') || upperLang.includes('HI') || upperLang.includes('TA') || upperLang.includes('TE')) {
      return 'IN';
    }
  }

  // Default fallback
  return 'GLOBAL';
}

/**
 * Resolves location info and recommended gateway
 * @param {string} countryCode
 */
export function resolveLocationContext(countryCode) {
  const normalizedCountry = (countryCode || 'GLOBAL').toUpperCase();
  const isIndia = normalizedCountry === 'IN';

  return {
    countryCode: isIndia ? 'IN' : normalizedCountry,
    isIndia,
    recommendedGateway: isIndia ? 'razorpay' : 'dodo',
    currency: isIndia ? 'INR' : 'USD',
    currencySymbol: isIndia ? '₹' : '$',
  };
}
