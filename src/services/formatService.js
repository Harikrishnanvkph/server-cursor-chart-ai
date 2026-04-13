import { supabaseAdminClient } from '../supabase/client.js';

class FormatService {

  // =============================================
  // FORMAT RETRIEVAL
  // =============================================

  /**
   * Get all available formats (official + user's own)
   * @param {string|null} userId - User ID (null for unauthenticated - only official returned)
   * @returns {Promise<Array>} Array of format blueprints
   */
  async getFormats(userId = null) {
    try {
      let query = supabaseAdminClient
        .from('format_blueprints')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: false });

      if (userId) {
        // Return official + public + user's own formats
        query = query.or(`is_official.eq.true,is_public.eq.true,user_id.eq.${userId}`);
      } else {
        // Unauthenticated: only official formats
        query = query.eq('is_official', true);
      }

      const { data, error } = await query;

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error fetching formats:', error);
      throw error;
    }
  }

  /**
   * Get official formats only (for gallery display)
   * @returns {Promise<Array>} Array of official format blueprints
   */
  async getOfficialFormats() {
    try {
      const { data, error } = await supabaseAdminClient
        .from('format_blueprints')
        .select('*')
        .eq('is_official', true)
        .order('sort_order', { ascending: true });

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error fetching official formats:', error);
      throw error;
    }
  }

  /**
   * Get a specific format by ID
   * @param {string} formatId - Format blueprint ID
   * @param {string|null} userId - User ID for authorization
   * @returns {Promise<Object>} Format blueprint
   */
  async getFormatById(formatId, userId = null) {
    try {
      let query = supabaseAdminClient
        .from('format_blueprints')
        .select('*')
        .eq('id', formatId);

      if (userId) {
        query = query.or(`is_official.eq.true,is_public.eq.true,user_id.eq.${userId}`);
      } else {
        query = query.eq('is_official', true);
      }

      const { data, error } = await query.single();

      if (error) throw error;
      if (!data) throw new Error('Format not found');

      return data;
    } catch (error) {
      console.error('Error fetching format:', error);
      throw error;
    }
  }

  // =============================================
  // FORMAT MANAGEMENT (Admin/User)
  // =============================================

  /**
   * Create a new format blueprint
   * @param {string} userId - Creator's user ID
   * @param {Object} formatData - Format data
   * @returns {Promise<Object>} Created format
   */
  async createFormat(userId, formatData) {
    try {
      const { name, description, category, skeleton, dimensions, tags, thumbnailUrl, isOfficial, isPublic, sortOrder } = formatData;

      const { data, error } = await supabaseAdminClient
        .from('format_blueprints')
        .insert({
          name,
          description: description || null,
          category: category || 'infographic',
          skeleton,
          dimensions,
          tags: tags || [],
          thumbnail_url: thumbnailUrl || null,
          user_id: userId,
          is_official: isOfficial || false,
          is_public: isPublic || false,
          sort_order: sortOrder || 0
        })
        .select('*')
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error creating format:', error);
      throw error;
    }
  }

  /**
   * Update an existing format blueprint
   * @param {string} formatId - Format ID
   * @param {string} userId - User ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Updated format
   */
  async updateFormat(formatId, userId, updates) {
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
      if (updates.category !== undefined) updateObj.category = updates.category;
      if (updates.skeleton !== undefined) updateObj.skeleton = updates.skeleton;
      if (updates.dimensions !== undefined) updateObj.dimensions = updates.dimensions;
      if (updates.tags !== undefined) updateObj.tags = updates.tags;
      if (updates.thumbnailUrl !== undefined) updateObj.thumbnail_url = updates.thumbnailUrl;
      if (updates.sortOrder !== undefined) updateObj.sort_order = updates.sortOrder;
      // Only admin can change official/public status
      if (isAdmin) {
        if (updates.isOfficial !== undefined) updateObj.is_official = updates.isOfficial;
        if (updates.isPublic !== undefined) updateObj.is_public = updates.isPublic;
      }

      let query = supabaseAdminClient
        .from('format_blueprints')
        .update(updateObj)
        .eq('id', formatId);

      // Non-admin users can only update their own formats
      if (!isAdmin) {
        query = query.eq('user_id', userId);
      }

      const { data, error } = await query.select('*').single();

      if (error) throw error;
      if (!data) throw new Error('Format not found or access denied');

      return data;
    } catch (error) {
      console.error('Error updating format:', error);
      throw error;
    }
  }

  /**
   * Delete a format blueprint
   * @param {string} formatId - Format ID
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Deletion result
   */
  async deleteFormat(formatId, userId) {
    try {
      // Check if user is admin
      const { data: profile } = await supabaseAdminClient
        .from('profiles')
        .select('is_admin')
        .eq('id', userId)
        .single();

      const isAdmin = profile?.is_admin === true;

      let query = supabaseAdminClient
        .from('format_blueprints')
        .delete()
        .eq('id', formatId);

      // Non-admin can only delete own formats
      if (!isAdmin) {
        query = query.eq('user_id', userId);
      }

      const { data, error } = await query.select();

      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error('Format not found or access denied');
      }

      return { success: true, deleted: data[0] };
    } catch (error) {
      console.error('Error deleting format:', error);
      throw error;
    }
  }

  /**
   * Toggle official status of a format (admin only)
   * @param {string} formatId - Format ID
   * @param {boolean} isOfficial - New official status
   * @returns {Promise<Object>} Updated format
   */
  async setFormatOfficial(formatId, isOfficial) {
    try {
      const { data, error } = await supabaseAdminClient
        .from('format_blueprints')
        .update({
          is_official: isOfficial,
          updated_at: new Date().toISOString()
        })
        .eq('id', formatId)
        .select('*')
        .single();

      if (error) throw error;
      if (!data) throw new Error('Format not found');

      return data;
    } catch (error) {
      console.error('Error updating format official status:', error);
      throw error;
    }
  }

  /**
   * Bulk insert formats (for seeding defaults)
   * @param {string} userId - Admin user ID
   * @param {Array} formats - Array of format data objects
   * @returns {Promise<Array>} Created formats
   */
  async bulkCreateFormats(userId, formats) {
    try {
      const rows = formats.map(f => ({
        name: f.name,
        description: f.description || null,
        category: f.category || 'infographic',
        skeleton: f.skeleton,
        dimensions: f.dimensions,
        tags: f.tags || [],
        thumbnail_url: f.thumbnailUrl || null,
        user_id: userId,
        is_official: f.isOfficial || false,
        is_public: f.isPublic || false,
        sort_order: f.sortOrder || 0
      }));

      const { data, error } = await supabaseAdminClient
        .from('format_blueprints')
        .insert(rows)
        .select('*');

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error bulk creating formats:', error);
      throw error;
    }
  }
}

export default new FormatService();
