import '../env.js';
import { supabaseAdminClient } from '../supabase/client.js';

function extractImageUrls(obj, found = []) {
  if (!obj) return found;

  if (typeof obj === 'string') {
    // Look for format-assets public urls or paths
    const marker = '/format-assets/';
    const idx = obj.indexOf(marker);
    if (idx !== -1) {
      let url = obj;
      // If it's a relative path, resolve it or extract the path
      let path = obj.substring(idx + marker.length);
      // Strip query parameters
      const qIdx = path.indexOf('?');
      if (qIdx !== -1) path = path.substring(0, qIdx);
      const hIdx = path.indexOf('#');
      if (hIdx !== -1) path = path.substring(0, hIdx);

      // Verify it starts with presets/
      if (path.startsWith('presets/')) {
        const filename = path.split('/').pop();
        // Construct the standard public URL if it's not already one
        const supabaseUrl = process.env.SUPABASE_URL || 'https://gucycejpglknqvdnysao.supabase.co';
        const fullUrl = url.startsWith('http') 
          ? url.split('?')[0]
          : `${supabaseUrl}/storage/v1/object/public/format-assets/${path}`;
        
        found.push({
          path,
          url: fullUrl,
          filename
        });
      }
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      extractImageUrls(item, found);
    }
  } else if (typeof obj === 'object') {
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        extractImageUrls(obj[key], found);
      }
    }
  }
  return found;
}

async function seed() {
  console.log('🏁 Starting legacy image seeding script...');

  try {
    const recordsToInsert = [];

    // 1. Scan Chart Snapshots
    console.log('Scanning chart snapshots...');
    const { data: snapshots, error: snapsError } = await supabaseAdminClient
      .from('chart_snapshots')
      .select('chart_config, template_structure, conversations(user_id)')
      .eq('is_current', true);

    if (snapsError) throw snapsError;

    (snapshots || []).forEach(snap => {
      const userId = snap.conversations?.user_id;
      if (!userId) return;

      const foundImages = [];
      extractImageUrls(snap.chart_config, foundImages);
      extractImageUrls(snap.template_structure, foundImages);

      foundImages.forEach(img => {
        recordsToInsert.push({
          user_id: userId,
          image_path: img.path,
          image_url: img.url,
          filename: img.filename
        });
      });
    });

    // 2. Scan User Templates
    console.log('Scanning user templates...');
    const { data: templates, error: templatesError } = await supabaseAdminClient
      .from('user_templates')
      .select('user_id, template_structure')
      .not('user_id', 'is', null);

    if (templatesError) throw templatesError;

    (templates || []).forEach(tpl => {
      const userId = tpl.user_id;
      const foundImages = [];
      extractImageUrls(tpl.template_structure, foundImages);

      foundImages.forEach(img => {
        recordsToInsert.push({
          user_id: userId,
          image_path: img.path,
          image_url: img.url,
          filename: img.filename
        });
      });
    });

    // 3. Scan User Formats
    console.log('Scanning custom format blueprints...');
    const { data: formats, error: formatsError } = await supabaseAdminClient
      .from('format_blueprints')
      .select('user_id, skeleton, thumbnail_url')
      .not('user_id', 'is', null);

    if (formatsError) throw formatsError;

    (formats || []).forEach(fmt => {
      const userId = fmt.user_id;
      const foundImages = [];
      extractImageUrls(fmt.skeleton, foundImages);
      extractImageUrls(fmt.thumbnail_url, foundImages);

      foundImages.forEach(img => {
        recordsToInsert.push({
          user_id: userId,
          image_path: img.path,
          image_url: img.url,
          filename: img.filename
        });
      });
    });

    // Remove duplicates by image_path
    const uniqueRecordsMap = new Map();
    recordsToInsert.forEach(rec => {
      uniqueRecordsMap.set(rec.image_path, rec);
    });
    const uniqueRecords = Array.from(uniqueRecordsMap.values());

    console.log(`Found ${uniqueRecords.length} unique legacy images to seed.`);

    if (uniqueRecords.length > 0) {
      const { data, error: insertError } = await supabaseAdminClient
        .from('user_uploaded_images')
        .upsert(uniqueRecords, { onConflict: 'image_path' })
        .select();

      if (insertError) throw insertError;
      console.log(`✅ Successfully seeded ${data.length} images into user_uploaded_images!`);
    } else {
      console.log('No legacy images found to seed.');
    }

    console.log('🎉 Seeding complete!');
  } catch (err) {
    console.error('❌ Error during seeding:', err);
    process.exit(1);
  }
}

seed();
