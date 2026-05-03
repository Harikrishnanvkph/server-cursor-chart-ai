import { supabaseAdminClient } from '../supabase/client.js';

class ChartStylePresetService {

  // =============================================
  // PRESET RETRIEVAL
  // =============================================

  /**
   * Get all available presets (official + user's own)
   * @param {string|null} userId - User ID (null for unauthenticated - only official returned)
   * @returns {Promise<Array>} Array of chart style presets
   */
  async getPresets(userId = null) {
    try {
      let query = supabaseAdminClient
        .from('chart_style_presets')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: false });

      if (userId) {
        // Return official + public + user's own presets
        query = query.or(`is_official.eq.true,is_public.eq.true,user_id.eq.${userId}`);
      } else {
        // Unauthenticated: only official presets
        query = query.eq('is_official', true);
      }

      const { data, error } = await query;

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error fetching chart style presets:', error);
      throw error;
    }
  }

  /**
   * Get official presets only (for gallery display)
   * @returns {Promise<Array>} Array of official chart style presets
   */
  async getOfficialPresets() {
    try {
      const { data, error } = await supabaseAdminClient
        .from('chart_style_presets')
        .select('*')
        .eq('is_official', true)
        .order('sort_order', { ascending: true });

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error fetching official chart style presets:', error);
      throw error;
    }
  }

  /**
   * Get only the user's own custom presets (non-official)
   * @param {string} userId - User ID
   * @returns {Promise<Array>} Array of user's chart style presets
   */
  async getUserPresets(userId) {
    try {
      const { data, error } = await supabaseAdminClient
        .from('chart_style_presets')
        .select('*')
        .eq('user_id', userId)
        .eq('is_official', false)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error fetching user chart style presets:', error);
      throw error;
    }
  }

  /**
   * Get a specific preset by ID
   * @param {string} presetId - Preset ID
   * @param {string|null} userId - User ID for authorization
   * @returns {Promise<Object>} Chart style preset
   */
  async getPresetById(presetId, userId = null) {
    try {
      let query = supabaseAdminClient
        .from('chart_style_presets')
        .select('*')
        .eq('id', presetId);

      if (userId) {
        query = query.or(`is_official.eq.true,is_public.eq.true,user_id.eq.${userId}`);
      } else {
        query = query.eq('is_official', true);
      }

      const { data, error } = await query.single();

      if (error) throw error;
      if (!data) throw new Error('Chart style preset not found');

      return data;
    } catch (error) {
      console.error('Error fetching chart style preset:', error);
      throw error;
    }
  }

  // =============================================
  // PRESET MANAGEMENT (Admin/User)
  // =============================================

  /**
   * Create a new chart style preset
   * @param {string} userId - Creator's user ID
   * @param {Object} presetData - Preset data
   * @returns {Promise<Object>} Created preset
   */
  async createPreset(userId, presetData) {
    try {
      const {
        name,
        description,
        chartType,
        colorStrategy,
        configSnapshot,
        datasetStyle,
        dimensions,
        category,
        tags,
        thumbnailUrl,
        isOfficial,
        isPublic,
        sortOrder
      } = presetData;

      const { data, error } = await supabaseAdminClient
        .from('chart_style_presets')
        .insert({
          name,
          description: description || null,
          chart_type: chartType,
          color_strategy: colorStrategy,
          config_snapshot: configSnapshot || {},
          dataset_style: datasetStyle || {},
          dimensions: dimensions || null,
          category: category || 'minimal',
          tags: tags || [],
          thumbnail_url: thumbnailUrl || null,
          user_id: userId,
          is_official: isOfficial || false,
          is_public: isPublic || false,
          sort_order: sortOrder || 100
        })
        .select('*')
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error creating chart style preset:', error);
      throw error;
    }
  }

  /**
   * Update an existing chart style preset
   * @param {string} presetId - Preset ID
   * @param {string} userId - User ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Updated preset
   */
  async updatePreset(presetId, userId, updates) {
    try {
      // First check if user is admin
      const { data: profile } = await supabaseAdminClient
        .from('profiles')
        .select('is_admin')
        .eq('id', userId)
        .single();

      const isAdmin = profile?.is_admin === true;

      // Build update object (only include provided fields)
      const updateObj = { updated_at: new Date().toISOString() };
      if (updates.name !== undefined) updateObj.name = updates.name;
      if (updates.description !== undefined) updateObj.description = updates.description;
      if (updates.chartType !== undefined) updateObj.chart_type = updates.chartType;
      if (updates.colorStrategy !== undefined) updateObj.color_strategy = updates.colorStrategy;
      if (updates.configSnapshot !== undefined) updateObj.config_snapshot = updates.configSnapshot;
      if (updates.datasetStyle !== undefined) updateObj.dataset_style = updates.datasetStyle;
      if (updates.dimensions !== undefined) updateObj.dimensions = updates.dimensions;
      if (updates.category !== undefined) updateObj.category = updates.category;
      if (updates.tags !== undefined) updateObj.tags = updates.tags;
      if (updates.thumbnailUrl !== undefined) updateObj.thumbnail_url = updates.thumbnailUrl;
      if (updates.sortOrder !== undefined) updateObj.sort_order = updates.sortOrder;

      // Only admin can change official/public status
      if (isAdmin) {
        if (updates.isOfficial !== undefined) updateObj.is_official = updates.isOfficial;
        if (updates.isPublic !== undefined) updateObj.is_public = updates.isPublic;
      }

      let query = supabaseAdminClient
        .from('chart_style_presets')
        .update(updateObj)
        .eq('id', presetId);

      // Non-admin users can only update their own presets
      if (!isAdmin) {
        query = query.eq('user_id', userId);
      }

      const { data, error } = await query.select('*').single();

      if (error) throw error;
      if (!data) throw new Error('Preset not found or access denied');

      return data;
    } catch (error) {
      console.error('Error updating chart style preset:', error);
      throw error;
    }
  }

  /**
   * Delete a chart style preset
   * @param {string} presetId - Preset ID
   * @param {string} userId - User ID
   * @returns {Promise<void>}
   */
  async deletePreset(presetId, userId) {
    try {
      // Check admin status
      const { data: profile } = await supabaseAdminClient
        .from('profiles')
        .select('is_admin')
        .eq('id', userId)
        .single();

      const isAdmin = profile?.is_admin === true;

      let query = supabaseAdminClient
        .from('chart_style_presets')
        .delete()
        .eq('id', presetId);

      // Non-admin can only delete their own
      if (!isAdmin) {
        query = query.eq('user_id', userId);
      }

      const { error, count } = await query;

      if (error) throw error;
      // count may be 0 if preset not found or user doesn't own it
    } catch (error) {
      console.error('Error deleting chart style preset:', error);
      throw error;
    }
  }

  /**
   * Toggle official status of a preset (admin only)
   * @param {string} presetId - Preset ID
   * @param {boolean} isOfficial - New official status
   * @returns {Promise<Object>} Updated preset
   */
  async setPresetOfficial(presetId, isOfficial) {
    try {
      const { data, error } = await supabaseAdminClient
        .from('chart_style_presets')
        .update({
          is_official: isOfficial,
          updated_at: new Date().toISOString()
        })
        .eq('id', presetId)
        .select('*')
        .single();

      if (error) throw error;
      if (!data) throw new Error('Preset not found');

      return data;
    } catch (error) {
      console.error('Error updating preset official status:', error);
      throw error;
    }
  }
}

export default new ChartStylePresetService();
