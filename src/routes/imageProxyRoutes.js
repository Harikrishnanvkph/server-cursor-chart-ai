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
  // IPv4 check
  const v4parts = ip.split('.').map(Number);
  if (v4parts.length === 4 && v4parts.every(p => p >= 0 && p <= 255)) {
    return (
      v4parts[0] === 0 ||                                             // 0.0.0.0/8
      v4parts[0] === 10 ||                                            // 10.0.0.0/8
      v4parts[0] === 127 ||                                           // 127.0.0.0/8 (loopback)
      (v4parts[0] === 172 && v4parts[1] >= 16 && v4parts[1] <= 31) || // 172.16.0.0/12
      (v4parts[0] === 192 && v4parts[1] === 168) ||                   // 192.168.0.0/16
      (v4parts[0] === 169 && v4parts[1] === 254)                      // 169.254.0.0/16 (link-local + cloud metadata)
    );
  }

  // IPv6 check
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::' ||
      normalized.startsWith('fe80:') ||   // Link-local
      normalized.startsWith('fc00:') ||   // Unique local
      normalized.startsWith('fd00:')) {    // Unique local
    return true;
  }

  return false;
}

/**
 * Resolve a hostname to its IP and verify it doesn't point to a private network.
 * Blocks SSRF via IPv6, decimal IPs, DNS rebinding, 0.0.0.0, cloud metadata, etc.
 * Uses the OS DNS resolver (getaddrinfo) which handles all IP notation formats.
 */
async function validateNotPrivate(hostname) {
  // Strip IPv6 brackets if present
  const cleanHost = hostname.replace(/^\[|\]$/g, '');

  // Fast-path: obvious local hostnames
  const lower = cleanHost.toLowerCase();
  if (lower === 'localhost' || lower === '0.0.0.0' || lower === '::1') {
    throw new Error('Local network proxying disabled for security');
  }

  // Resolve hostname → IP via OS resolver (handles IPv4, IPv6, decimal IPs, hex IPs, etc.)
  try {
    const { address } = await dns.lookup(cleanHost);
    if (isPrivateIP(address)) {
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

router.get('/image', async (req, res) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    // Use configured frontend origin instead of wildcard to prevent open-proxy abuse
    const frontendOrigin = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.setHeader('Access-Control-Allow-Origin', frontendOrigin);
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

        // Security: Validate the hostname doesn't resolve to a private/internal IP
        // This catches: IPv6 loopback, 0.0.0.0, 172.16.x.x, decimal IPs, DNS rebinding,
        // cloud metadata (169.254.169.254), and all other private ranges
        await validateNotPrivate(parsedUrl.hostname);

        // CRITICAL FIX: Wikimedia Commons completely blocks server-side bot downloads of 
        // dynamic thumbnail URLs with an aggressive HTTP 429 and 403.
        // The only robust way to download Wikipedia/Wikimedia images from a Node.js backend 
        // without getting IP banned is to use the Special:FilePath API.
        let finalFetchUrl = imageUrl;
        let isWiki = false;
        if (parsedUrl.hostname.includes('wikimedia.org') || parsedUrl.hostname.includes('wikipedia.org')) {
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
            // (e.g. en.wikipedia.org or commons.wikimedia.org) to support local/fair-use uploads.
            // Decode the filename first to prevent double-encoding characters like %27 (single quotes)
            const targetWikiHost = parsedUrl.hostname.includes('upload.wikimedia.org') ? 'commons.wikimedia.org' : parsedUrl.hostname;
            
            // Critical fallback: always request a width from Special:FilePath to prevent Wikipedia from throwing 429 Too Many Requests
            const targetWidth = width ? parseInt(width, 10) : 500;
            finalFetchUrl = `https://${targetWikiHost}/wiki/Special:FilePath/${encodeURIComponent(decodeURIComponent(filename))}?width=${targetWidth}`;
            
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
        const response = await safeFetch(finalFetchUrl, {
            method: 'GET',
            headers: headers
        });

        if (!response.ok) {
            console.error(`[ImageProxy] Upstream rejected ${finalFetchUrl} with ${response.status}`);
            if (response.status === 404) {
                return res.status(404).json({ error: 'Image not found' });
            }
            throw new Error(`Upstream server responded with ${response.status} ${response.statusText}`);
        }

        // Read the image stream into a buffer for processing/caching
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const contentType = response.headers.get('content-type');
        const isSvg = contentType && contentType.includes('svg');
        const isGif = contentType && contentType.includes('gif');
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

        // Fallback or skip resizing: Forward original contentType and stream raw buffer
        if (contentType) {
            res.setHeader('Content-Type', contentType);
        }
        res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache raw image for 1 day
        res.send(buffer);

    } catch (error) {
        console.error('Image proxy error:', error);
        // Don't leak internal error details to client
        res.status(500).json({ error: 'Failed to proxy image' });
    }
});

export default router;
