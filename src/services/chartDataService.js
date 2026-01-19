import { supabaseAdminClient } from '../supabase/client.js';

class ChartDataService {

  // =============================================
  // CONVERSATION MANAGEMENT
  // =============================================

  async createConversation(userId, title, description = null) {
    try {
      // First, ensure user has a profile (fix for missing profiles)
      const { data: existingProfile, error: profileCheckError } = await supabaseAdminClient
        .from('profiles')
        .select('id')
        .eq('id', userId)
        .single();

      if (profileCheckError || !existingProfile) {
        console.log('Profile not found for user:', userId, '. Profile should have been created by middleware.');
        // NOTE: Profile should be created by middleware, but if it's still missing,
        // we'll attempt conversation creation anyway and let it fail with a clearer error
        console.warn('WARNING: User profile missing for user:', userId);
      }

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

        // Fetch snapshot metadata separately (optimized: fetch only is_template_mode, extract mode from minimal chart_data)
        if (directData && directData.length > 0) {
          const conversationIds = directData.map(c => c.id);

          // Fetch is_template_mode and only the datasets array from chart_data (much smaller than full chart_data)
          const { data: snapshotData } = await supabaseAdminClient
            .from('chart_snapshots')
            .select('conversation_id, is_template_mode, chart_data')
            .in('conversation_id', conversationIds)
            .eq('is_current', true);

          // Create a map for quick lookup
          const snapshotMap = new Map();
          (snapshotData || []).forEach(s => {
            snapshotMap.set(s.conversation_id, s);
          });

          // Transform to include mode info at top level
          // Extract chart_mode from datasets array (minimal processing)
          return directData.map(conv => {
            const snapshot = snapshotMap.get(conv.id);
            const chartData = snapshot?.chart_data;
            const chartMode = chartData?.datasets?.[0]?.mode || 'single';

            return {
              ...conv,
              is_template_mode: snapshot?.is_template_mode || false,
              chart_mode: chartMode
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
          chart_snapshots(*)
        `)
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
      const { data, error } = await supabaseAdminClient
        .from('conversations')
        .update({
          ...updates,
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

  async deleteConversation(conversationId, userId) {
    try {
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
      // Delete all conversations for the user
      // This will cascade delete related chart_snapshots and chat_messages due to foreign key constraints
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
  // CHAT MESSAGE MANAGEMENT
  // =============================================

  async addMessage(conversationId, role, content, chartSnapshotId = null, action = null, changes = null) {
    try {
      // Get next message order
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

      // Update conversation last activity
      await supabaseAdminClient
        .from('conversations')
        .update({
          last_activity: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', conversationId);

      return data;
    } catch (error) {
      console.error('Error adding message:', error);
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

