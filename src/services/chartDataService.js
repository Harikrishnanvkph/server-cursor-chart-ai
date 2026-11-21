import { supabaseAdminClient } from '../supabase/client.js';
import { randomUUID } from 'node:crypto';

class ChartDataService {

  // =============================================
  // CONVERSATION MANAGEMENT
  // =============================================

  async createConversation(userId, title, description = null) {
    try {
      const { data, error } = await supabaseAdminClient
        .from('conversations')
        .insert({
          user_id: userId,
          title,
          description,
          is_active: true
        })
        .select('*')
        .single();

      if (error) {
        console.error('Error creating conversation:', error);
        throw error;
      }

      // Create initial assistant message
      await this.addMessage(data.id, 'assistant',
        'Hi! Describe the chart you want to create, or ask me to modify an existing chart.',
        null, null, null);

      return data;
    } catch (error) {
      console.error('Error creating conversation:', error);
      throw error;
    }
  }

  async getUserConversations(userId, limit = 50) {
    try {
      const { data, error } = await supabaseAdminClient
        .rpc('get_user_conversations', {
          user_uuid: userId,
          limit_count: limit
        });

      if (error) {
        console.error('RPC error, trying direct query:', error);
        // Fallback to direct query if RPC doesn't exist
        // First, get conversations without join to avoid excluding those without snapshots
        const { data: directData, error: directError } = await supabaseAdminClient
          .from('conversations')
          .select('*')
          .eq('user_id', userId)
          .eq('is_active', true)
          .order('updated_at', { ascending: false })
          .limit(limit);

        if (directError) {
          console.error('Direct query also failed:', directError);
          throw directError;
        }

        // Fetch snapshot metadata separately — extract only mode via JSON path, NOT the full chart_data blob
        if (directData && directData.length > 0) {
          const conversationIds = directData.map(c => c.id);

          // Use Postgres JSON path to extract datasets[0].mode server-side (~10 bytes vs 5KB-2MB per row)
          const { data: snapshotData } = await supabaseAdminClient
            .from('chart_snapshots')
            .select('conversation_id, is_template_mode, chart_type, mode:chart_data->datasets->0->mode, width_config:chart_config->width, height_config:chart_config->height, width_temp_dim:template_structure->dimensions->width, height_temp_dim:template_structure->dimensions->height, width_temp:template_structure->width, height_temp:template_structure->height')
            .in('conversation_id', conversationIds)
            .eq('is_current', true);

          // Create a map for quick lookup
          const snapshotMap = new Map();
          (snapshotData || []).forEach(s => {
            snapshotMap.set(s.conversation_id, s);
          });

          // Transform to include mode info and dimensions at top level
          return directData.map(conv => {
            const snapshot = snapshotMap.get(conv.id);
            const rawWidth = snapshot?.width_temp_dim || snapshot?.width_temp || snapshot?.width_config || null;
            const rawHeight = snapshot?.height_temp_dim || snapshot?.height_temp || snapshot?.height_config || null;
            
            return {
              ...conv,
              is_template_mode: snapshot?.is_template_mode || false,
              chart_mode: snapshot?.mode || 'single',
              current_chart_type: snapshot?.chart_type || null,
              width: rawWidth ? String(rawWidth) : null,
              height: rawHeight ? String(rawHeight) : null
            };
          });
        }

        return directData || [];
      }

      // RPC now returns is_template_mode and chart_mode directly - no second query needed!
      // The RPC function extracts chart_mode from JSONB in the database, avoiding large data transfer
      return data || [];
    } catch (error) {
      console.error('Error fetching conversations:', error);
      console.error('Error details:', {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint
      });
      throw error;
    }
  }

  async getConversationById(conversationId, userId) {
    try {
      const { data, error } = await supabaseAdminClient
        .from('conversations')
        .select(`
          *,
          chat_messages(*),
          chart_snapshots!left(*)
        `)
        .eq('chart_snapshots.is_current', true)
        .eq('id', conversationId)
        .eq('user_id', userId)
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error fetching conversation:', error);
      throw error;
    }
  }

  async updateConversation(conversationId, userId, updates) {
    try {
      const safeUpdates = {};
      if (updates && typeof updates === 'object') {
        if (typeof updates.title === 'string') safeUpdates.title = updates.title;
        if (updates.description !== undefined) safeUpdates.description = updates.description;
        if (updates.project_id !== undefined) safeUpdates.project_id = updates.project_id;
      }

      const { data, error } = await supabaseAdminClient
        .from('conversations')
        .update({
          ...safeUpdates,
          updated_at: new Date().toISOString()
        })
        .eq('id', conversationId)
        .eq('user_id', userId)
        .select('*')
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error updating conversation:', error);
      throw error;
    }
  }

  async _cleanupOrphanedStorageAssets(snapshots, userId) {
    if (!snapshots || snapshots.length === 0 || !userId) return;

    const paths = [];
    const bucketUrlPart = '/format-assets/';
    const userPrefix = `presets/${userId}/`;

    const checkShapes = (shapes) => {
      if (!Array.isArray(shapes)) return;
      for (const shape of shapes) {
        if (shape?.type === 'deco-image' && shape.imageUrl && shape.imageUrl.includes(bucketUrlPart)) {
          const idx = shape.imageUrl.indexOf(bucketUrlPart);
          if (idx !== -1) {
            const rawSubPath = shape.imageUrl.substring(idx + bucketUrlPart.length).split('?')[0];
            if (rawSubPath && rawSubPath.startsWith(userPrefix) && !paths.includes(rawSubPath)) {
              paths.push(rawSubPath);
            }
          }
        }
      }
    };

    for (const snap of snapshots) {
      if (snap.chart_config?.decorationShapes) {
        checkShapes(snap.chart_config.decorationShapes);
      }
      if (snap.template_structure?.decorations) {
        checkShapes(snap.template_structure.decorations);
      }
    }

    if (paths.length === 0) return;

    try {
      const { error: storageError } = await supabaseAdminClient.storage
        .from('format-assets')
        .remove(paths);
      if (storageError) {
        console.error('[StorageCleanup] Failed to delete orphaned files:', storageError);
      } else {
        console.log('[StorageCleanup] Deleted orphaned files from storage:', paths);
      }
    } catch (err) {
      console.error('[StorageCleanup] Error during storage cleanup:', err);
    }

    try {
      const { error: dbImgError } = await supabaseAdminClient
        .from('user_uploaded_images')
        .delete()
        .eq('user_id', userId)
        .in('image_path', paths);
      if (dbImgError) {
        console.error('[StorageCleanup] Failed to remove tracking rows:', dbImgError);
      }
    } catch (err) {
      console.error('[StorageCleanup] Error cleaning tracking rows:', err);
    }
  }

  async deleteConversation(conversationId, userId) {
    try {
      // 0. Verify conversation ownership before reading snapshots or deleting storage assets
      const { data: ownedConv, error: ownErr } = await supabaseAdminClient
        .from('conversations')
        .select('id')
        .eq('id', conversationId)
        .eq('user_id', userId)
        .maybeSingle();

      if (ownErr) throw ownErr;
      if (!ownedConv) {
        throw new Error('Conversation not found or access denied');
      }

      // 1. Fetch all snapshots for this conversation before deletion
      const { data: snapshots } = await supabaseAdminClient
        .from('chart_snapshots')
        .select('chart_config, template_structure')
        .eq('conversation_id', conversationId);

      // 2. Delete owned storage assets & tracking rows cleanly before DB deletion
      await this._cleanupOrphanedStorageAssets(snapshots, userId);

      // 3. Delete the conversation (will cascade delete snapshots/messages)
      const { error } = await supabaseAdminClient
        .from('conversations')
        .delete()
        .eq('id', conversationId)
        .eq('user_id', userId);

      if (error) throw error;
      return { success: true };
    } catch (error) {
      console.error('Error deleting conversation:', error);
      throw error;
    }
  }

  async deleteAllConversations(userId) {
    try {
      // 1. Fetch all snapshots for all user's conversations
      const { data: snapshots } = await supabaseAdminClient
        .from('chart_snapshots')
        .select('chart_config, template_structure, conversations!inner(user_id)')
        .eq('conversations.user_id', userId);

      // 2. Delete strictly user-owned storage assets & tracking rows cleanly
      await this._cleanupOrphanedStorageAssets(snapshots, userId);

      // 3. Delete all conversations for the user (will cascade delete snapshots/messages)
      const { error } = await supabaseAdminClient
        .from('conversations')
        .delete()
        .eq('user_id', userId);

      if (error) throw error;
      return { success: true };
    } catch (error) {
      console.error('Error deleting all conversations:', error);
      throw error;
    }
  }

  // =============================================
  // CHART SNAPSHOT MANAGEMENT
  // =============================================

  async saveChartSnapshot(conversationId, chartType, chartData, chartConfig, templateStructure = null, templateContent = null, snapshotId = null) {
    try {
      // Always pass all parameters including snapshot_id_val (even if null)
      // This avoids function overload ambiguity
      const { data, error } = await supabaseAdminClient
        .rpc('save_chart_snapshot', {
          conv_id: conversationId,
          chart_type_val: chartType,
          chart_data_val: chartData,
          chart_config_val: chartConfig,
          version_val: null,
          template_structure_val: templateStructure,
          template_content_val: templateContent,
          snapshot_id_val: snapshotId // Always pass, even if null
        });

      if (error) {
        console.error('Error saving chart snapshot:', error);
        throw error;
      }

      return data;
    } catch (error) {
      console.error('Error saving chart snapshot:', error);
      throw error;
    }
  }

  async getCurrentChartSnapshot(conversationId) {
    try {
      const { data, error } = await supabaseAdminClient
        .from('chart_snapshots')
        .select('*')
        .eq('conversation_id', conversationId)
        .eq('is_current', true)
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data;
    } catch (error) {
      console.error('Error fetching chart snapshot:', error);
      throw error;
    }
  }

  async getBatchCurrentSnapshots(userId, conversationIds = []) {
    try {
      const uniqueIds = [...new Set((conversationIds || []).filter((id) => typeof id === 'string' && id.trim()))];
      if (uniqueIds.length === 0) return {};

      // 1. Verify ownership for all requested conversations in a single query
      const { data: ownedConvs, error: convError } = await supabaseAdminClient
        .from('conversations')
        .select('id')
        .in('id', uniqueIds)
        .eq('user_id', userId)
        .eq('is_active', true);

      if (convError) throw convError;
      const ownedIds = (ownedConvs || []).map((c) => c.id);
      if (ownedIds.length === 0) return {};

      // 2. Fetch current snapshots for all owned conversations in a single query
      const { data: snapshots, error: snapError } = await supabaseAdminClient
        .from('chart_snapshots')
        .select('*')
        .in('conversation_id', ownedIds)
        .eq('is_current', true);

      if (snapError) throw snapError;
      if (!snapshots || snapshots.length === 0) return {};

      // 3. Collect referenced format IDs that still need their blueprint skeleton
      const formatIdsToFetch = new Set();
      snapshots.forEach((snap) => {
        const formatData = snap.chart_config?.formatData;
        const formatId = formatData?.formatId;
        const hasEmbeddedSkeleton = Boolean(formatData?.formatSnapshot?.skeleton);
        const hasZones = Boolean(snap.template_structure && !snap.template_structure.isFormatReference && snap.template_structure.zones);
        if (formatId && !hasEmbeddedSkeleton && !hasZones) {
          formatIdsToFetch.add(formatId);
        }
      });

      const formatSkeletonMap = new Map();
      if (formatIdsToFetch.size > 0) {
        const { data: formats, error: fmtError } = await supabaseAdminClient
          .from('format_blueprints')
          .select('id, skeleton')
          .in('id', Array.from(formatIdsToFetch))
          .or(`is_official.eq.true,is_public.eq.true,user_id.eq.${userId}`);

        if (!fmtError && formats) {
          formats.forEach((fmt) => {
            if (fmt.skeleton) {
              formatSkeletonMap.set(fmt.id, fmt.skeleton);
            }
          });
        }
      }

      // 4. Key snapshots by conversation_id and attach pre-resolved format skeletons
      const result = {};
      snapshots.forEach((snap) => {
        const formatId = snap.chart_config?.formatData?.formatId;
        const resolvedSkeleton = formatId ? formatSkeletonMap.get(formatId) : null;
        result[snap.conversation_id] = resolvedSkeleton
          ? { ...snap, template_structure: resolvedSkeleton }
          : snap;
      });

      return result;
    } catch (error) {
      console.error('Error fetching batch chart snapshots:', error);
      throw error;
    }
  }

  async getChartHistory(conversationId, limit = 10) {
    try {
      const { data, error } = await supabaseAdminClient
        .from('chart_snapshots')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error fetching chart history:', error);
      throw error;
    }
  }

  // =============================================
  // CHART SHARING MANAGEMENT
  // =============================================

  async generateShareLink(snapshotId, userId) {
    try {
      // First, verify the snapshot exists and belongs to a conversation owned by the user
      const { data: snapshot, error: snapshotError } = await supabaseAdminClient
        .from('chart_snapshots')
        .select(`
          id,
          share_id,
          conversations!inner(user_id)
        `)
        .eq('id', snapshotId)
        .eq('conversations.user_id', userId)
        .single();

      if (snapshotError) throw snapshotError;
      if (!snapshot) throw new Error('Snapshot not found or unauthorized');

      // If it already has a share_id, just return it instead of creating a new one
      if (snapshot.share_id) {
        return { share_id: snapshot.share_id };
      }

      // Generate a new share_id and save it
      const newShareId = randomUUID();
      const { data: updatedSnapshot, error: updateError } = await supabaseAdminClient
        .from('chart_snapshots')
        .update({ share_id: newShareId })
        .eq('id', snapshotId)
        .select('share_id')
        .single();

      if (updateError) throw updateError;
      return { share_id: updatedSnapshot.share_id };
    } catch (error) {
      console.error('Error generating share link:', error);
      throw error;
    }
  }

  async generateShareLinkForConversation(conversationId, userId) {
    try {
      // Verify conversation ownership and locate its current snapshot
      const { data: conversation, error: convError } = await supabaseAdminClient
        .from('conversations')
        .select('id')
        .eq('id', conversationId)
        .eq('user_id', userId)
        .maybeSingle();

      if (convError) throw convError;
      if (!conversation) {
        throw new Error('Conversation not found or unauthorized');
      }

      const { data: currentSnapshot, error: snapError } = await supabaseAdminClient
        .from('chart_snapshots')
        .select('id, share_id')
        .eq('conversation_id', conversationId)
        .eq('is_current', true)
        .maybeSingle();

      if (snapError) throw snapError;

      // Fall back to latest snapshot if is_current is missing
      let targetSnapshot = currentSnapshot;
      if (!targetSnapshot) {
        const { data: latestSnapshot, error: latestErr } = await supabaseAdminClient
          .from('chart_snapshots')
          .select('id, share_id')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (latestErr) throw latestErr;
        targetSnapshot = latestSnapshot;
      }

      if (!targetSnapshot) {
        throw new Error('Snapshot not found for conversation');
      }

      if (targetSnapshot.share_id) {
        return { share_id: targetSnapshot.share_id };
      }

      return await this.generateShareLink(targetSnapshot.id, userId);
    } catch (error) {
      console.error('Error generating share link for conversation:', error);
      throw error;
    }
  }

  async getSharedChart(shareId) {
    try {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!shareId || !uuidRegex.test(String(shareId).trim())) {
        throw new Error('Shared chart not found');
      }

      // Query the snapshot explicitly by share_id (plus conversation owner to scope format access). No user auth required.
      const { data, error } = await supabaseAdminClient
        .from('chart_snapshots')
        .select('chart_data, chart_config, chart_type, created_at, template_structure, template_content, conversations(user_id)')
        .eq('share_id', String(shareId).trim())
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      if (!data) throw new Error('Shared chart not found');

      const ownerId = data.conversations?.user_id || null;
      delete data.conversations;

      // Resolve format blueprint skeleton server-side when template_structure lacks zones,
      // strictly restricted to official, public, or owner-owned blueprints.
      const formatData = data.chart_config?.formatData;
      if (formatData?.formatId && !data.template_structure?.zones) {
        if (formatData.formatSnapshot?.skeleton?.zones) {
          data.template_structure = formatData.formatSnapshot.skeleton;
        } else {
          const visibilityFilter = ownerId
            ? `is_official.eq.true,is_public.eq.true,user_id.eq.${ownerId}`
            : 'is_official.eq.true,is_public.eq.true';
          const { data: fmt, error: fmtError } = await supabaseAdminClient
            .from('format_blueprints')
            .select('skeleton')
            .eq('id', formatData.formatId)
            .or(visibilityFilter)
            .maybeSingle();

          if (!fmtError && fmt?.skeleton) {
            data.template_structure = fmt.skeleton;
          }
        }
      }

      return data;
    } catch (error) {
      console.error('Error fetching shared chart:', error);
      throw error;
    }
  }

  // =============================================
  // CHAT MESSAGE MANAGEMENT
  // =============================================

  async addMessage(conversationId, role, content, chartSnapshotId = null, action = null, changes = null) {
    try {
      // Single RPC call: computes MAX(message_order)+1 and inserts atomically
      // Replaces previous pattern of COUNT query + INSERT (2 round-trips → 1)
      // Requires Supabase function: add_chat_message (see implementation_plan.md for SQL)
      const { data, error } = await supabaseAdminClient.rpc('add_chat_message', {
        p_conversation_id: conversationId,
        p_role: role,
        p_content: content,
        p_chart_snapshot_id: chartSnapshotId,
        p_action: action,
        p_changes: changes ? JSON.stringify(changes) : null
      });

      if (error) {
        // Fallback: if RPC doesn't exist yet, use the original two-query approach
        console.warn('add_chat_message RPC not found, falling back to direct insert:', error.message);
        return await this._addMessageFallback(conversationId, role, content, chartSnapshotId, action, changes);
      }

      return data;
    } catch (error) {
      console.error('Error adding message:', error);
      throw error;
    }
  }

  // Fallback for when the Supabase RPC hasn't been created yet
  async _addMessageFallback(conversationId, role, content, chartSnapshotId = null, action = null, changes = null) {
    const { count } = await supabaseAdminClient
      .from('chat_messages')
      .select('*', { count: 'exact', head: true })
      .eq('conversation_id', conversationId);

    const messageOrder = (count || 0) + 1;

    const { data, error } = await supabaseAdminClient
      .from('chat_messages')
      .insert({
        conversation_id: conversationId,
        chart_snapshot_id: chartSnapshotId,
        role,
        content,
        action,
        changes,
        message_order: messageOrder
      })
      .select('*')
      .single();

    if (error) throw error;

    await supabaseAdminClient
      .from('conversations')
      .update({
        last_activity: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', conversationId);

    return data;
  }

  async addMessagesBatch(conversationId, messages = []) {
    try {
      if (!Array.isArray(messages) || messages.length === 0) {
        return [];
      }

      // Compute starting message_order in a single lightweight query
      const { data: latest, error: orderErr } = await supabaseAdminClient
        .from('chat_messages')
        .select('message_order')
        .eq('conversation_id', conversationId)
        .order('message_order', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (orderErr) throw orderErr;

      const startOrder = (latest?.message_order || 0) + 1;
      const rows = messages.map((m, idx) => ({
        conversation_id: conversationId,
        chart_snapshot_id: m.chartSnapshotId || null,
        role: m.role,
        content: m.content,
        action: m.action || null,
        changes: m.changes ?? null,
        message_order: startOrder + idx
      }));

      const { data, error } = await supabaseAdminClient
        .from('chat_messages')
        .insert(rows)
        .select('*');

      if (error) throw error;

      // Update conversation activity timestamps once for the entire batch
      const nowIso = new Date().toISOString();
      await supabaseAdminClient
        .from('conversations')
        .update({
          last_activity: nowIso,
          updated_at: nowIso
        })
        .eq('id', conversationId);

      return data || [];
    } catch (error) {
      console.error('Error batch adding messages:', error);
      throw error;
    }
  }

  async getConversationMessages(conversationId, limit = 100) {
    try {
      // Fetch messages without join - chart snapshot data is fetched separately
      // The join fails because Supabase schema cache doesn't recognize the relationship
      const { data, error } = await supabaseAdminClient
        .from('chat_messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(limit);

      if (error) {
        throw error;
      }

      return data || [];
    } catch (error) {
      console.error('Error fetching messages:', error.message);
      throw error;
    }
  }

  // =============================================
  // USER PREFERENCES
  // =============================================

  async getUserPreferences(userId) {
    try {
      const { data, error } = await supabaseAdminClient
        .from('user_preferences')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data || { chart_defaults: {}, ui_preferences: {} };
    } catch (error) {
      console.error('Error fetching user preferences:', error);
      throw error;
    }
  }

  async updateUserPreferences(userId, preferences) {
    try {
      const { data, error } = await supabaseAdminClient
        .from('user_preferences')
        .upsert({
          user_id: userId,
          chart_defaults: preferences.chartDefaults || {},
          ui_preferences: preferences.uiPreferences || {},
          updated_at: new Date().toISOString()
        })
        .select('*')
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error updating user preferences:', error);
      throw error;
    }
  }

  // =============================================
  // PROJECT MANAGEMENT
  // =============================================

  async createProject(userId, name, description = null) {
    try {
      const { data, error } = await supabaseAdminClient
        .from('projects')
        .insert({
          user_id: userId,
          name,
          description
        })
        .select('*')
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error creating project:', error);
      throw error;
    }
  }

  async getUserProjects(userId) {
    try {
      const { data, error } = await supabaseAdminClient
        .from('projects')
        .select(`
          *,
          conversations(count)
        `)
        .eq('user_id', userId)
        .order('updated_at', { ascending: false });

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error fetching projects:', error);
      throw error;
    }
  }
}

export default new ChartDataService();

