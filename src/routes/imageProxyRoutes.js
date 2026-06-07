import express from 'express';
import fetch from 'node-fetch';
import sharp from 'sharp';

const router = express.Router();

router.get('/image', async (req, res) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    const { url: imageUrl, width, quality, format } = req.query;

    if (!imageUrl) {
        return res.status(400).json({ error: 'Image URL is required' });
    }

    try {
        const parsedUrl = new URL(imageUrl);

        // Security: Prevent SSRF by blocking local network domains and IPs
        const isLocal = !parsedUrl.hostname.includes('.') || 
                       parsedUrl.hostname === 'localhost' || 
                       parsedUrl.hostname.startsWith('127.') || 
                       parsedUrl.hostname.startsWith('192.168.') || 
                       parsedUrl.hostname.startsWith('10.');
                       
        if (isLocal) {
            return res.status(403).json({ error: 'Local network proxying disabled for security' });
        }

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

            // Route through the official file download API which doesn't aggressively 429/403
            // Decode the filename first to prevent double-encoding characters like %27 (single quotes)
            finalFetchUrl = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(decodeURIComponent(filename))}`;
            console.log(`[ImageProxy] Using Special:FilePath API for: ${decodeURIComponent(filename)}`);
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

        const response = await fetch(finalFetchUrl, {
            method: 'GET',
            headers: headers
        });

        if (!response.ok) {
            console.error(`Upstream rejected ${finalFetchUrl} with ${response.status}`);
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
        res.status(500).json({ error: 'Failed to proxy image', details: error.message });
    }
});

export default router;
