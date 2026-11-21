import express from 'express';
import fetch from 'node-fetch';
import dns from 'dns/promises';
import http from 'http';
import https from 'https';
import net from 'net';
import rateLimit from 'express-rate-limit';

// Lazy-load native sharp only when an image needs resizing/transcoding (cuts serverless cold starts)
let _sharpInstance = null;
async function getSharp() {
  if (!_sharpInstance) {
    _sharpInstance = (await import('sharp')).default;
  }
  return _sharpInstance;
}

const router = express.Router();

const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15MB ceiling
const MAX_SHARP_PIXELS = 40_000_000; // 40MP decompression-bomb ceiling
const FETCH_TIMEOUT_MS = 10_000;

class ProxyHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const imageProxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many image proxy requests. Please slow down.' }
});

// =============================================
// SSRF PROTECTION HELPERS
// =============================================

function normalizeIPv6(ip) {
  const withoutZone = ip.split('%')[0].toLowerCase().trim();
  if (!withoutZone.includes(':')) return null;

  const [headStr, tailStr] = withoutZone.split('::');
  if (withoutZone.split('::').length > 2) return null;

  const parseSide = (side) => {
    if (!side) return [];
    const tokens = side.split(':');
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.includes('.') && i === tokens.length - 1) {
        const octets = tok.split('.').map(Number);
        if (octets.length !== 4 || octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) {
          return null;
        }
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else if (/^[0-9a-f]{1,4}$/.test(tok)) {
        out.push(parseInt(tok, 16));
      } else {
        return null;
      }
    }
    return out;
  };

  const head = parseSide(headStr);
  const tail = tailStr !== undefined ? parseSide(tailStr) : [];
  if (!head || !tail) return null;

  if (tailStr === undefined) {
    return head.length === 8 ? head : null;
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array(missing).fill(0), ...tail];
}

/**
 * Check if an IP address belongs to a private/reserved/tunneled range.
 * Covers: loopback, RFC1918, CGNAT, link-local, cloud metadata, multicast,
 * IPv4-mapped/IPv4-compatible IPv6, 6to4 (2002::/16), Teredo (2001::/32),
 * NAT64 (64:ff9b::/96), doc prefix (2001:db8::/32), ULA, link-local IPv6.
 */
export function isPrivateIP(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const normalized = ip.split('%')[0].toLowerCase().trim();

  // Check IPv4
  if (net.isIPv4(normalized)) {
    const v4parts = normalized.split('.').map(Number);
    return (
      v4parts[0] === 0 ||                                                 // 0.0.0.0/8
      v4parts[0] === 10 ||                                                // 10.0.0.0/8
      v4parts[0] === 127 ||                                               // 127.0.0.0/8 (loopback)
      (v4parts[0] === 100 && v4parts[1] >= 64 && v4parts[1] <= 127) ||    // 100.64.0.0/10 (CGNAT)
      (v4parts[0] === 172 && v4parts[1] >= 16 && v4parts[1] <= 31) ||     // 172.16.0.0/12
      (v4parts[0] === 192 && v4parts[1] === 168) ||                       // 192.168.0.0/16
      (v4parts[0] === 169 && v4parts[1] === 254) ||                       // 169.254.0.0/16 (link-local + cloud metadata)
      (v4parts[0] === 192 && v4parts[1] === 0 && (v4parts[2] === 0 || v4parts[2] === 2)) || // 192.0.0.0/24 & TEST-NET-1
      (v4parts[0] === 198 && (v4parts[1] === 18 || v4parts[1] === 19)) || // 198.18.0.0/15
      (v4parts[0] === 198 && v4parts[1] === 51 && v4parts[2] === 100) ||  // TEST-NET-2
      (v4parts[0] === 203 && v4parts[1] === 0 && v4parts[2] === 113) ||   // TEST-NET-3
      v4parts[0] >= 224                                                   // 224.0.0.0/4 multicast & reserved
    );
  }

  // Check IPv6 via exact 16-bit hextet expansion
  const hextets = normalizeIPv6(normalized);
  if (!hextets) return true;

  const isFirstFiveZero = hextets.slice(0, 5).every(h => h === 0);
  // Unspecified (::), loopback (::1), IPv4-compatible (::a.b.c.d), IPv4-mapped (::ffff:a.b.c.d)
  if (isFirstFiveZero && (hextets[5] === 0 || hextets[5] === 0xffff)) {
    if (hextets[5] === 0 && hextets[6] === 0 && (hextets[7] === 0 || hextets[7] === 1)) {
      return true;
    }
    const embeddedV4 = `${(hextets[6] >> 8) & 0xff}.${hextets[6] & 0xff}.${(hextets[7] >> 8) & 0xff}.${hextets[7] & 0xff}`;
    return isPrivateIP(embeddedV4);
  }

  // IPv4-translated (::ffff:0:a.b.c.d)
  if (hextets[0] === 0 && hextets[1] === 0 && hextets[2] === 0 && hextets[3] === 0 && hextets[4] === 0xffff && hextets[5] === 0) {
    const embeddedV4 = `${(hextets[6] >> 8) & 0xff}.${hextets[6] & 0xff}.${(hextets[7] >> 8) & 0xff}.${hextets[7] & 0xff}`;
    return isPrivateIP(embeddedV4);
  }

  // 6to4 (2002::/16) -> check embedded IPv4 in hextets 1..2
  if (hextets[0] === 0x2002) {
    const embeddedV4 = `${(hextets[1] >> 8) & 0xff}.${hextets[1] & 0xff}.${(hextets[2] >> 8) & 0xff}.${hextets[2] & 0xff}`;
    return isPrivateIP(embeddedV4);
  }

  // Teredo (2001::/32)
  if (hextets[0] === 0x2001 && hextets[1] === 0x0000) return true;

  // Documentation prefix (2001:db8::/32)
  if (hextets[0] === 0x2001 && hextets[1] === 0x0db8) return true;

  // NAT64 well-known prefix (64:ff9b::/96) and local-use (64:ff9b:1::/48)
  if (hextets[0] === 0x0064 && (hextets[1] === 0xff9b)) return true;

  // Discard-only (100::/64)
  if (hextets[0] === 0x0100 && hextets[1] === 0 && hextets[2] === 0 && hextets[3] === 0) return true;

  // Unique local fc00::/7
  if ((hextets[0] & 0xfe00) === 0xfc00) return true;

  // Link-local fe80::/10
  if ((hextets[0] & 0xffc0) === 0xfe80) return true;

  // Multicast ff00::/8
  if ((hextets[0] & 0xff00) === 0xff00) return true;

  return false;
}

/**
 * Resolve a hostname to all of its IPs, verify NONE are private,
 * and return the pinned public { address, family } to eliminate DNS rebinding TOCTOU.
 */
async function validateNotPrivate(hostname) {
  const cleanHost = hostname.replace(/^\[|\]$/g, '');
  const lower = cleanHost.toLowerCase();
  if (lower === 'localhost' || lower === '0.0.0.0' || lower === '::1') {
    throw new ProxyHttpError(403, 'Local network proxying disabled for security');
  }

  // Literal IP fast-path
  if (net.isIP(cleanHost)) {
    if (isPrivateIP(cleanHost)) {
      throw new ProxyHttpError(403, 'Local network proxying disabled for security');
    }
    return { address: cleanHost, family: net.isIPv6(cleanHost) ? 6 : 4 };
  }

  try {
    const records = await dns.lookup(cleanHost, { all: true });
    if (!Array.isArray(records) || records.length === 0 || records.some(r => isPrivateIP(r.address))) {
      throw new ProxyHttpError(403, 'Local network proxying disabled for security');
    }
    const chosen = records[0];
    return {
      address: chosen.address,
      family: chosen.family || (net.isIPv6(chosen.address) ? 6 : 4)
    };
  } catch (err) {
    if (err instanceof ProxyHttpError) throw err;
    throw new ProxyHttpError(400, 'Could not resolve image hostname');
  }
}

function createPinnedAgent(protocol, pinned) {
  const AgentCtor = protocol === 'https:' ? https.Agent : http.Agent;
  return new AgentCtor({
    keepAlive: false,
    lookup: (hostname, opts, cb) => {
      if (typeof opts === 'function') {
        return opts(null, pinned.address, pinned.family);
      }
      if (opts && opts.all) {
        return cb(null, [{ address: pinned.address, family: pinned.family }]);
      }
      return cb(null, pinned.address, pinned.family);
    }
  });
}

/**
 * Fetch a URL safely with DNS-pinned per-hop Agents, strict timeout, and SSRF validation.
 */
async function safeFetch(url, options, maxRedirects = 5) {
  let currentUrl = url;

  for (let i = 0; i <= maxRedirects; i++) {
    const parsed = new URL(currentUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new ProxyHttpError(403, 'Only HTTP/HTTPS URLs are allowed');
    }

    const pinned = await validateNotPrivate(parsed.hostname);
    const agent = createPinnedAgent(parsed.protocol, pinned);
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(currentUrl, {
        ...options,
        agent,
        redirect: 'manual',
        signal: timeoutController.signal
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new ProxyHttpError(504, 'Upstream image request timed out');
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    // Drain unused redirect body to release socket before following next hop
    try { response.body?.destroy(); } catch {}

    const location = response.headers.get('location');
    if (!location) {
      throw new ProxyHttpError(502, 'Redirect without Location header');
    }

    const redirectUrl = new URL(location, currentUrl);
    if (!['http:', 'https:'].includes(redirectUrl.protocol)) {
      throw new ProxyHttpError(403, 'Redirect to non-HTTP protocol blocked');
    }

    currentUrl = redirectUrl.toString();
  }

  throw new ProxyHttpError(508, 'Too many redirects');
}

async function readStreamWithLimit(bodyStream, maxBytes) {
  if (!bodyStream) return Buffer.alloc(0);
  const chunks = [];
  let totalBytes = 0;

  try {
    for await (const chunk of bodyStream) {
      const bufChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bufChunk.length;
      if (totalBytes > maxBytes) {
        try { bodyStream.destroy(); } catch {}
        throw new ProxyHttpError(413, 'Upstream image exceeds maximum allowed size');
      }
      chunks.push(bufChunk);
    }
  } catch (err) {
    try { bodyStream.destroy(); } catch {}
    if (err instanceof ProxyHttpError) throw err;
    throw new ProxyHttpError(502, 'Failed reading upstream image stream');
  }

  return Buffer.concat(chunks, totalBytes);
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

router.get('/image', imageProxyLimiter, async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Vary', 'Origin, Accept-Encoding');
    const { url: imageUrl, width, quality, format } = req.query;

    if (!imageUrl || typeof imageUrl !== 'string') {
        return res.status(400).json({ error: 'Image URL is required' });
    }

    try {
        let parsedUrl;
        try {
            parsedUrl = new URL(imageUrl);
        } catch {
            return res.status(400).json({ error: 'Invalid image URL' });
        }

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

        // Clamp requested width (16..2048) and quality (20..95) upfront
        const rawParsedWidth = width !== undefined ? parseInt(String(width), 10) : NaN;
        const clampedWidth = Number.isFinite(rawParsedWidth) && rawParsedWidth > 0
            ? Math.min(2048, Math.max(16, rawParsedWidth))
            : null;
        const rawParsedQuality = quality !== undefined ? parseInt(String(quality), 10) : NaN;
        const clampedQuality = Number.isFinite(rawParsedQuality)
            ? Math.min(95, Math.max(20, rawParsedQuality))
            : 80;

        // Validate hostname doesn't resolve to private/internal IP upfront
        await validateNotPrivate(parsedUrl.hostname);

        // Route Wikimedia/Wikipedia images via Special:FilePath API to avoid dynamic-thumb 429s
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
            const pathParts = parsedUrl.pathname.split('/');
            let filename = pathParts[pathParts.length - 1];

            if (parsedUrl.pathname.includes('/thumb/') && /^\d+px-/.test(filename)) {
                filename = filename.replace(/^\d+px-/, '');
            }

            if (parsedUrl.pathname.toLowerCase().includes('.svg/')) {
                const match = parsedUrl.pathname.match(/^(.*\.svg)\//i);
                if (match) {
                    const svgPathParts = match[1].split('/');
                    filename = svgPathParts[svgPathParts.length - 1];
                }
            }

            let decodedFilename;
            try {
                decodedFilename = decodeURIComponent(filename);
            } catch {
                return res.status(400).json({ error: 'Malformed image filename encoding' });
            }

            let targetWikiHost = 'commons.wikimedia.org';
            const wikiLangMatch = parsedUrl.pathname.match(/^\/wikipedia\/([a-z]{2,10})\//i);
            if (wikiLangMatch && wikiLangMatch[1].toLowerCase() !== 'commons') {
                targetWikiHost = `${wikiLangMatch[1].toLowerCase()}.wikipedia.org`;
            } else if (parsedUrl.hostname.endsWith('.wikipedia.org')) {
                targetWikiHost = parsedUrl.hostname;
            }

            const targetWidth = clampedWidth || 500;
            const encodedFile = encodeURIComponent(decodedFilename);
            finalFetchUrl = `https://${targetWikiHost}/wiki/Special:FilePath/${encodedFile}?width=${targetWidth}`;

            const altWikiHost = targetWikiHost === 'commons.wikimedia.org' ? 'en.wikipedia.org' : 'commons.wikimedia.org';
            fallbackWikiUrl = `https://${altWikiHost}/wiki/Special:FilePath/${encodedFile}?width=${targetWidth}`;
        }

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Referer': isWiki ? 'https://en.wikipedia.org/' : `${parsedUrl.protocol}//${parsedUrl.hostname}/`
        };

        let response = await safeFetch(finalFetchUrl, {
            method: 'GET',
            headers
        });

        if (!response.ok && response.status === 404 && fallbackWikiUrl) {
            try { response.body?.destroy(); } catch {}
            response = await safeFetch(fallbackWikiUrl, {
                method: 'GET',
                headers
            });
        }

        if (!response.ok) {
            try { response.body?.destroy(); } catch {}
            console.error(`[ImageProxy] Upstream rejected ${finalFetchUrl} with ${response.status}`);
            if (response.status === 404) {
                return res.status(404).json({ error: 'Image not found' });
            }
            return res.status(502).json({ error: 'Upstream image server error' });
        }

        // Enforce Content-Type BEFORE buffering the response body into memory
        const rawContentType = (response.headers.get('content-type') || '').toLowerCase();
        const contentType = rawContentType.split(';')[0].trim();
        if (!contentType.startsWith('image/')) {
            try { response.body?.destroy(); } catch {}
            return res.status(415).json({ error: 'Upstream resource is not a valid image' });
        }

        const contentLengthHeader = parseInt(response.headers.get('content-length') || '0', 10);
        if (Number.isFinite(contentLengthHeader) && contentLengthHeader > MAX_IMAGE_BYTES) {
            try { response.body?.destroy(); } catch {}
            return res.status(413).json({ error: 'Upstream image exceeds maximum allowed size' });
        }

        // Stream upstream body with strict byte cap (prevents chunked OOM)
        const buffer = await readStreamWithLimit(response.body, MAX_IMAGE_BYTES);

        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");

        const isSvg = contentType.includes('svg');
        const isGif = contentType.includes('gif');
        const shouldProcess = (clampedWidth !== null || quality !== undefined || format !== undefined) && !isSvg && !isGif;

        if (shouldProcess) {
            try {
                const sharp = await getSharp();
                let pipeline = sharp(buffer, { limitInputPixels: MAX_SHARP_PIXELS });

                if (clampedWidth !== null) {
                    pipeline = pipeline.resize(clampedWidth, null, { withoutEnlargement: true });
                }

                const targetFormat = String(format || 'webp').toLowerCase();
                if (targetFormat === 'png') {
                    pipeline = pipeline.png({ quality: clampedQuality });
                    res.setHeader('Content-Type', 'image/png');
                } else if (targetFormat === 'jpeg' || targetFormat === 'jpg') {
                    pipeline = pipeline.jpeg({ quality: clampedQuality });
                    res.setHeader('Content-Type', 'image/jpeg');
                } else {
                    pipeline = pipeline.webp({ quality: clampedQuality });
                    res.setHeader('Content-Type', 'image/webp');
                }

                res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                const outputBuffer = await pipeline.toBuffer();
                return res.send(outputBuffer);
            } catch (sharpError) {
                if (/Input image exceeds pixel limit/i.test(String(sharpError?.message || ''))) {
                    return res.status(413).json({ error: 'Image dimensions exceed processing limit' });
                }
                console.warn('[ImageProxy] Sharp processing failed, falling back to raw image:', sharpError);
            }
        }

        res.setHeader('Content-Type', rawContentType || contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(buffer);

    } catch (error) {
        if (error instanceof ProxyHttpError) {
            return res.status(error.status).json({ error: error.message });
        }
        console.error('Image proxy error:', error);
        res.status(500).json({ error: 'Failed to proxy image' });
    }
});

export default router;
