import fetch from 'node-fetch';

const serverUrl = 'http://localhost:5000/api/data/upload-image';

// 1. Small SVG image (under 1KB)
const svgBase64 = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCI+PGNpcmNsZSBjeD0iNSIgY3k9IjUiIHI9IjQiIGZpbGw9InJlZCIvPjwvc3ZnPg==';

// 2. Small PNG image (1x1 transparent pixel, under 1KB)
const smallPngBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// 3. Simulated "large" PNG image (10x10 red square, size ~1.5KB, but we want to test compression. Wait, to trigger our >150KB rule, we can generate a larger buffer or mock the metadata, or just generate a 2000x2000 image).
// Let's generate a 2100x2100 pixel canvas image using sharp and convert it to base64, so it triggers both the >150KB and >2000px rules!
import sharp from 'sharp';

async function runTests() {
  console.log('--- STARTING VERIFICATION TESTS ---');
  
  let cookie = '';
  try {
    console.log('Signing in as guest to obtain auth cookie...');
    const authRes = await fetch('http://localhost:5000/auth/guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const authHeaders = authRes.headers.get('set-cookie');
    if (authHeaders) {
      cookie = authHeaders.split(';')[0];
      console.log('Obtained Auth Cookie:', cookie);
    } else {
      console.warn('No Set-Cookie header found in guest signin response!');
    }
  } catch (authErr) {
    console.error('Guest signin failed:', authErr);
    return;
  }
  
  // A. Test SVG (should upload as-is)
  console.log('\nTesting SVG Upload (Expected: svg extension, raw upload)...');
  try {
    const res = await fetch(serverUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Cookie': cookie
      },
      body: JSON.stringify({ base64Data: svgBase64, filename: 'test-vector.svg' })
    });
    const data = await res.json();
    console.log('Result:', data);
  } catch (err) {
    console.error('SVG Test Error:', err);
  }

  // B. Test Small PNG (should upload as-is)
  console.log('\nTesting Small PNG Upload (Expected: png extension, raw upload)...');
  try {
    const res = await fetch(serverUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Cookie': cookie
      },
      body: JSON.stringify({ base64Data: smallPngBase64, filename: 'test-small.png' })
    });
    const data = await res.json();
    console.log('Result:', data);
  } catch (err) {
    console.error('Small PNG Test Error:', err);
  }

  // C. Test Large Image (2100x1000 red JPEG)
  console.log('\nTesting Large Image Upload (Expected: webp extension, compressed and resized)...');
  try {
    // Generate a 2100x1000 red image
    const largeBuffer = await sharp({
      create: {
        width: 2100,
        height: 1000,
        channels: 3,
        background: { r: 255, g: 0, b: 0 }
      }
    })
    .jpeg()
    .toBuffer();
    
    const largeBase64 = `data:image/jpeg;base64,${largeBuffer.toString('base64')}`;
    console.log(`Generated large image. Base64 length: ${largeBase64.length} chars, Buffer size: ${(largeBuffer.length / 1024).toFixed(1)}KB`);

    const res = await fetch(serverUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Cookie': cookie
      },
      body: JSON.stringify({ base64Data: largeBase64, filename: 'test-large.jpg' })
    });
    const data = await res.json();
    console.log('Result:', data);

    // Let's download the returned publicUrl and inspect its dimensions!
    if (data.publicUrl) {
      console.log('Downloading uploaded file to check dimensions...');
      const downloadRes = await fetch(data.publicUrl);
      const downloadBuffer = await downloadRes.arrayBuffer();
      const metadata = await sharp(Buffer.from(downloadBuffer)).metadata();
      console.log(`Uploaded Image Properties: Format: ${metadata.format}, Width: ${metadata.width}, Height: ${metadata.height}, Size: ${(downloadBuffer.byteLength / 1024).toFixed(1)}KB`);
    }
  } catch (err) {
    console.error('Large JPEG Test Error:', err);
  }
}

runTests();
