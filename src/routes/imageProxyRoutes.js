import express from 'express';
import fetch from 'node-fetch';
import sharp from 'sharp';
import dns from 'dns/promises';

const router = express.Router();

// =============================================
// SSRF PROTECTION HELPERS
// =============================================

/**
 * Check if an IP address belongs to a private/reserved range.
 * Covers: loopback, private (RFC 1918), link-local, cloud metadata,
 * IPv6 loopback, IPv6 unique-local, IPv6 link-local.
 */
function isPrivateIP(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const normalized = ip.toLowerCase().trim();

  // Handle IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice(7);
    if (mapped.includes('.')) {
      return isPrivateIP(mapped);
    }
    const hexParts = mapped.split(':');
    if (hexParts.length === 2) {
      const hi = parseInt(hexParts[0], 16);
      const lo = parseInt(hexParts[1], 16);
      if (!isNaN(hi) && !isNaN(lo)) {
        const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateIP(ipv4);
      }
    }
    return true;
  }

  // IPv4 check
  const v4parts = normalized.split('.').map(Number);
  if (v4parts.length === 4 && v4parts.every(p => Number.isInteger(p) && p >= 0 && p <= 255)) {
    return (
      v4parts[0] === 0 ||                                              // 0.0.0.0/8
      v4parts[0] === 10 ||                                             // 10.0.0.0/8
      v4parts[0] === 127 ||                                            // 127.0.0.0/8 (loopback)
      (v4parts[0] === 100 && v4parts[1] >= 64 && v4parts[1] <= 127) || // 100.64.0.0/10 (CGNAT)
      (v4parts[0] === 172 && v4parts[1] >= 16 && v4parts[1] <= 31) ||  // 172.16.0.0/12
      (v4parts[0] === 192 && v4parts[1] === 168) ||                    // 192.168.0.0/16
      (v4parts[0] === 169 && v4parts[1] === 254) ||                    // 169.254.0.0/16 (link-local + cloud metadata)
      (v4parts[0] === 198 && (v4parts[1] === 18 || v4parts[1] === 19)) || // 198.18.0.0/15
      v4parts[0] >= 224                                                // 224.0.0.0/4 multicast & reserved
    );
  }

  // IPv6 check
  if (normalized === '::1' || normalized === '::' ||
      normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb') ||  // fe80::/10 Link-local
      normalized.startsWith('fc') || normalized.startsWith('fd') ||    // fc00::/7 Unique local
      normalized.startsWith('ff')) {                                   // ff00::/8 Multicast
    return true;
  }

  return false;
}

/**
 * Resolve a hostname to all of its IPs and verify none point to a private network.
 */
async function validateNotPrivate(hostname) {
  // Strip IPv6 brackets if present
  const cleanHost = hostname.replace(/^\[|\]$/g, '');

  // Fast-path: obvious local hostnames or literal private IP
  const lower = cleanHost.toLowerCase();
  if (lower === 'localhost' || lower === '0.0.0.0' || lower === '::1' || isPrivateIP(lower)) {
    throw new Error('Local network proxying disabled for security');
  }

  // Resolve all hostname IPs via OS resolver
  try {
    const records = await dns.lookup(cleanHost, { all: true });
    if (!Array.isArray(records) || records.length === 0 || records.some(r => isPrivateIP(r.address))) {
      throw new Error('Local network proxying disabled for security');
    }
  } catch (err) {
    if (err.message.includes('Local network')) throw err;
    // DNS resolution failed — hostname doesn't exist
    throw new Error('Could not resolve image hostname');
  }
}

/**
 * Fetch a URL safely, validating each redirect hop against SSRF.
 * - Max 5 redirects
 * - Each redirect target's hostname is resolved and checked against private IP ranges
 * - Prevents redirect-based SSRF (e.g. attacker.com → 302 → http://169.254.169.254)
 */
async function safeFetch(url, options, maxRedirects = 5) {
  let currentUrl = url;

  for (let i = 0; i <= maxRedirects; i++) {
    const response = await fetch(currentUrl, { ...options, redirect: 'manual' });

    // Not a redirect — return the response
    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    // It's a redirect — validate the target before following
    const location = response.headers.get('location');
    if (!location) {
      throw new Error('Redirect without Location header');
    }

    // Resolve relative redirects against current URL
    const redirectUrl = new URL(location, currentUrl);

    // Only allow http/https redirects
    if (!['http:', 'https:'].includes(redirectUrl.protocol)) {
      throw new Error('Redirect to non-HTTP protocol blocked');
    }

    // Validate the redirect target is not a private IP
    await validateNotPrivate(redirectUrl.hostname);

    currentUrl = redirectUrl.toString();
  }

  throw new Error('Too many redirects');
}

// =============================================
// IMAGE PROXY ROUTE
// =============================================

router.options('/image', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    return res.sendStatus(204);
});

router.get('/image', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Vary', 'Origin, Accept-Encoding');
    const { url: imageUrl, width, quality, format } = req.query;

    if (!imageUrl) {
        return res.status(400).json({ error: 'Image URL is required' });
    }

    try {
        const parsedUrl = new URL(imageUrl);

        // Security: Only allow HTTP/HTTPS protocols
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return res.status(403).json({ error: 'Only HTTP/HTTPS URLs are allowed' });
        }

        // Reject Wikimedia Commons or web placeholder / dummy files (e.g. 'thumbnail.jpg', 'Name.jpg' with red text)
        const lowerImgUrl = imageUrl.toLowerCase();
        if (
            lowerImgUrl.includes('special:filepath/thumbnail.jpg') ||
            lowerImgUrl.includes('special:filepath/name.jpg') ||
            lowerImgUrl.includes('/5/5b/name.jpg') ||
            /(?:^|\/|[?&=_/-])(thumbnail|placeholder|no_image|no-image|image_needed|image-needed|missing_image|missing-image|avatar-default|blank_profile)\.(?:jpg|jpeg|png|svg|webp)(?:$|[?&#])/i.test(lowerImgUrl)
        ) {
            return res.status(404).json({ error: 'Placeholder image rejected' });
        }

        // Security: Validate the hostname doesn't resolve to a private/internal IP
        // This catches: IPv6 loopback, 0.0.0.0, 172.16.x.x, decimal IPs, DNS rebinding,
        // cloud metadata (169.254.169.254), and all other private ranges
        await validateNotPrivate(parsedUrl.hostname);

        // CRITICAL FIX: Wikimedia Commons completely blocks server-side bot downloads of 
        // dynamic thumbnail URLs with an aggressive HTTP 429 and 403.
        // The only robust way to download Wikipedia/Wikimedia images from a Node.js backend 
        // without getting IP banned is to use the Special:FilePath API.
        let finalFetchUrl = imageUrl;
        let fallbackWikiUrl = null;
        let isWiki = false;
        const lowerHost = parsedUrl.hostname.toLowerCase();
        if (
            lowerHost === 'wikimedia.org' ||
            lowerHost.endsWith('.wikimedia.org') ||
            lowerHost === 'wikipedia.org' ||
            lowerHost.endsWith('.wikipedia.org')
        ) {
            isWiki = true;
            // Extract the actual filename from the URL route
            const pathParts = parsedUrl.pathname.split('/');
            let filename = pathParts[pathParts.length - 1];

            // If it's a thumbnail (e.g. 320px-Blueberries.jpg), strip the scaling prefix
            if (parsedUrl.pathname.includes('/thumb/') && /^\d+px-/.test(filename)) {
                filename = filename.replace(/^\d+px-/, '');
            }

            // Handle SVGs: if original URL pathname contains '.svg/', the original file is .svg
            if (parsedUrl.pathname.toLowerCase().includes('.svg/')) {
                const match = parsedUrl.pathname.match(/^(.*\.svg)\//i);
                if (match) {
                    const svgPathParts = match[1].split('/');
                    filename = svgPathParts[svgPathParts.length - 1];
                }
            }

            // Route through the official file download API of the SPECIFIC wikipedia/wikimedia domain
            // (e.g. en.wikipedia.org for fair-use movie posters/logos or commons.wikimedia.org for Commons).
            let targetWikiHost = 'commons.wikimedia.org';
            const wikiLangMatch = parsedUrl.pathname.match(/^\/wikipedia\/([a-z]{2,10})\//i);
            if (wikiLangMatch && wikiLangMatch[1].toLowerCase() !== 'commons') {
                targetWikiHost = `${wikiLangMatch[1].toLowerCase()}.wikipedia.org`;
            } else if (parsedUrl.hostname.endsWith('.wikipedia.org')) {
                targetWikiHost = parsedUrl.hostname;
            }

            // Critical fallback: always request a width from Special:FilePath to prevent Wikipedia from throwing 429 Too Many Requests
            const targetWidth = width ? parseInt(width, 10) : 500;
            const encodedFile = encodeURIComponent(decodeURIComponent(filename));
            finalFetchUrl = `https://${targetWikiHost}/wiki/Special:FilePath/${encodedFile}?width=${targetWidth}`;

            // Prepare cross-domain Wiki fallback (e.g. if commons returns 404 for a fair-use file on en.wikipedia.org)
            const altWikiHost = targetWikiHost === 'commons.wikimedia.org' ? 'en.wikipedia.org' : 'commons.wikimedia.org';
            fallbackWikiUrl = `https://${altWikiHost}/wiki/Special:FilePath/${encodedFile}?width=${targetWidth}`;

            console.log(`[ImageProxy] Using Special:FilePath API on ${targetWikiHost} for: ${decodeURIComponent(filename)} with width ${targetWidth}`);
        }

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none'
        };

        if (isWiki) {
            headers['Referer'] = 'https://en.wikipedia.org/';
        } else {
            headers['Referer'] = `${parsedUrl.protocol}//${parsedUrl.hostname}/`;
        }

        // Use safeFetch to validate redirect targets against SSRF
        let response = await safeFetch(finalFetchUrl, {
            method: 'GET',
            headers: headers
        });

        // If Wikimedia Commons 404s on a fair-use file (or vice versa), automatically try the alternate Wiki host
        if (!response.ok && response.status === 404 && fallbackWikiUrl) {
            console.log(`[ImageProxy] Primary Wiki host 404'd, trying fallback: ${fallbackWikiUrl}`);
            response = await safeFetch(fallbackWikiUrl, {
                method: 'GET',
                headers: headers
            });
        }

        if (!response.ok) {
            console.error(`[ImageProxy] Upstream rejected ${finalFetchUrl} with ${response.status}`);
            if (response.status === 404) {
                return res.status(404).json({ error: 'Image not found' });
            }
            throw new Error(`Upstream server responded with ${response.status} ${response.statusText}`);
        }

        const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15MB ceiling
        const contentLengthHeader = parseInt(response.headers.get('content-length') || '0', 10);
        if (contentLengthHeader > MAX_IMAGE_BYTES) {
            return res.status(413).json({ error: 'Upstream image exceeds maximum allowed size' });
        }

        // Read the image stream into a buffer for processing/caching
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
            return res.status(413).json({ error: 'Upstream image exceeds maximum allowed size' });
        }
        const buffer = Buffer.from(arrayBuffer);

        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");

        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        const isSvg = contentType.includes('svg');
        const isGif = contentType.includes('gif');
        const shouldProcess = (width || quality || format) && !isSvg && !isGif;

        if (shouldProcess) {
            try {
                let pipeline = sharp(buffer);
                
                if (width) {
                    const parsedWidth = parseInt(width, 10);
                    if (!isNaN(parsedWidth) && parsedWidth > 0) {
                        pipeline = pipeline.resize(parsedWidth, null, { withoutEnlargement: true });
                    }
                }

                // Transcode to modern format (default webp)
                const targetFormat = format || 'webp';
                const parsedQuality = parseInt(quality, 10) || 80;

                if (targetFormat === 'png') {
                    pipeline = pipeline.png({ quality: parsedQuality });
                    res.setHeader('Content-Type', 'image/png');
                } else if (targetFormat === 'jpeg' || targetFormat === 'jpg') {
                    pipeline = pipeline.jpeg({ quality: parsedQuality });
                    res.setHeader('Content-Type', 'image/jpeg');
                } else {
                    pipeline = pipeline.webp({ quality: parsedQuality });
                    res.setHeader('Content-Type', 'image/webp');
                }

                res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                const outputBuffer = await pipeline.toBuffer();
                return res.send(outputBuffer);
            } catch (sharpError) {
                console.warn('[ImageProxy] Sharp processing failed, falling back to raw image:', sharpError);
            }
        }

        // Reject non-image upstream responses (e.g., text/html error pages)
        if (!contentType.startsWith('image/')) {
            return res.status(415).json({ error: 'Upstream resource is not a valid image' });
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache raw image for 1 day
        res.send(buffer);

    } catch (error) {
        console.error('Image proxy error:', error);
        // Don't leak internal error details to client
        res.status(500).json({ error: 'Failed to proxy image' });
    }
});

export default router;
