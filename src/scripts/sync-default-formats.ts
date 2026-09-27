import '../env.js';
import { supabaseAdminClient } from '../supabase/client.js';
import { defaultFormats } from '../../../cursor_ai/lib/format-defaults.js';

async function syncFormats() {
  console.log(`Starting format sync: ${defaultFormats.length} default formats defined in code.`);

  // 1. Fetch current official formats in DB
  const { data: dbFormats, error: fetchErr } = await supabaseAdminClient
    .from('format_blueprints')
    .select('id, name, is_official')
    .eq('is_official', true);

  if (fetchErr) {
    console.error('Error fetching official formats from DB:', fetchErr);
    process.exit(1);
  }

  console.log(`Found ${dbFormats?.length || 0} existing official formats in DB.`);
  const dbFormatMap = new Map((dbFormats || []).map(f => [f.name.toLowerCase().trim(), f]));

  let updatedCount = 0;
  let insertedCount = 0;

  for (let i = 0; i < defaultFormats.length; i++) {
    const f = defaultFormats[i];
    const key = f.name.toLowerCase().trim();
    const existing = dbFormatMap.get(key);

    const payload = {
      name: f.name,
      description: f.description || null,
      category: f.category || 'infographic',
      skeleton: f,
      dimensions: f.dimensions,
      tags: f.tags || [],
      thumbnail_url: f.thumbnailUrl || null,
      is_official: true,
      is_public: true,
      sort_order: f.sortOrder ?? i,
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      // Update existing record
      const { error: updateErr } = await supabaseAdminClient
        .from('format_blueprints')
        .update(payload)
        .eq('id', existing.id);

      if (updateErr) {
        console.error(`Failed to update format "${f.name}":`, updateErr);
      } else {
        console.log(` Updated: "${f.name}" (ID: ${existing.id})`);
        updatedCount++;
      }
    } else {
      // Insert new record
      const { data: newRow, error: insertErr } = await supabaseAdminClient
        .from('format_blueprints')
        .insert({
          ...payload,
          user_id: '7c4b06d4-c393-4db1-805d-189804ab8b33',
        })
        .select('id, name')
        .single();

      if (insertErr) {
        console.error(`Failed to insert format "${f.name}":`, insertErr);
      } else {
        console.log(` Inserted new: "${f.name}" (ID: ${newRow?.id})`);
        insertedCount++;
      }
    }
  }

  console.log(`\nSync complete! Updated: ${updatedCount}, Inserted: ${insertedCount}, Total: ${defaultFormats.length}`);
  process.exit(0);
}

syncFormats().catch(err => {
  console.error('Fatal sync error:', err);
  process.exit(1);
});
