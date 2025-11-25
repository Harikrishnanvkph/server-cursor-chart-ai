import { supabaseAdminClient } from '../supabase/client.js';

class TemplateService {
  
  // =============================================
  // TEMPLATE MANAGEMENT (Blueprint Templates)
  // =============================================
  
  /**
   * Get all templates for a user (including public templates)
   * @param {string} userId - User ID
   * @param {boolean} includePublic - Include public templates from other users
   * @returns {Promise<Array>} Array of templates
   */
  async getUserTemplates(userId, includePublic = true) {
    try {
      const { data, error } = await supabaseAdminClient
        .rpc('get_user_templates', {
          user_uuid: userId,
          include_public: includePublic
        });
      
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error fetching user templates:', error);
      throw error;
    }
  }
  
  /**
   * Get a specific template by ID
   * @param {string} templateId - Template ID
   * @param {string} userId - User ID (for authorization check)
   * @returns {Promise<Object>} Template object
   */
  async getTemplateById(templateId, userId) {
    try {
      const { data, error } = await supabaseAdminClient
        .from('user_templates')
        .select('*')
        .eq('id', templateId)
        .or(`user_id.eq.${userId},is_public.eq.true`)
        .single();
      
      if (error) throw error;
      if (!data) {
        throw new Error('Template not found');
      }
      
      return data;
    } catch (error) {
      console.error('Error fetching template:', error);
      throw error;
    }
  }
  
  /**
   * Create a new template blueprint
   * @param {string} userId - User ID
   * @param {string} name - Template name
   * @param {string} description - Template description
   * @param {Object} templateStructure - Complete TemplateLayout structure
   * @returns {Promise<Object>} Created template
   */
  async createTemplate(userId, name, description, templateStructure) {
    try {
      if (!supabaseAdminClient) {
        throw new Error('Supabase admin client not initialized');
      }
      
      const { data, error } = await supabaseAdminClient
        .rpc('upsert_user_template', {
          user_uuid: userId,
          template_name: name,
          template_description: description || null,
          template_structure_json: templateStructure,
          template_id: null // Create new
        });
      
      if (error) throw error;
      if (!data) {
        throw new Error('RPC function returned no data');
      }
      
      // Fetch the created template to return full object
      const { data: template, error: fetchError } = await supabaseAdminClient
        .from('user_templates')
        .select('*')
        .eq('id', data)
        .single();
      
      if (fetchError) throw fetchError;
      return template;
    } catch (error) {
      console.error('Error creating template:', error);
      throw error;
    }
  }
  
  /**
   * Update an existing template blueprint
   * @param {string} templateId - Template ID
   * @param {string} userId - User ID
   * @param {Object} updates - Update object with name, description, and/or templateStructure
   * @returns {Promise<Object>} Updated template
   */
  async updateTemplate(templateId, userId, updates) {
    try {
      const { name, description, templateStructure } = updates;
      
      if (!name && !description && !templateStructure) {
        throw new Error('At least one field must be provided for update');
      }
      
      const { data, error } = await supabaseAdminClient
        .rpc('upsert_user_template', {
          user_uuid: userId,
          template_name: name,
          template_description: description || null,
          template_structure_json: templateStructure,
          template_id: templateId // Update existing
        });
      
      if (error) throw error;
      if (!data) {
        throw new Error('Template not found or access denied');
      }
      
      // Fetch the updated template
      const { data: template, error: fetchError } = await supabaseAdminClient
        .from('user_templates')
        .select('*')
        .eq('id', templateId)
        .single();
      
      if (fetchError) throw fetchError;
      return template;
    } catch (error) {
      console.error('Error updating template:', error);
      throw error;
    }
  }
  
  /**
   * Delete a template blueprint
   * @param {string} templateId - Template ID
   * @param {string} userId - User ID
   * @returns {Promise<void>}
   */
  async deleteTemplate(templateId, userId) {
    try {
      // First check if template exists and user owns it
      const { data: existingTemplate, error: fetchError } = await supabaseAdminClient
        .from('user_templates')
        .select('id, user_id, name')
        .eq('id', templateId)
        .single();
      
      if (fetchError && fetchError.code !== 'PGRST116') { // PGRST116 = not found
        throw fetchError;
      }
      
      if (!existingTemplate) {
        throw new Error('Template not found');
      }
      
      if (existingTemplate.user_id !== userId) {
        throw new Error('Unauthorized: You do not own this template');
      }
      
      // Delete the template
      const { data, error } = await supabaseAdminClient
        .from('user_templates')
        .delete()
        .eq('id', templateId)
        .eq('user_id', userId)
        .select();
      
      if (error) {
        throw error;
      }
      
      return data;
    } catch (error) {
      console.error('Error deleting template:', error);
      throw error;
    }
  }
  
  /**
   * Set template visibility (public/private)
   * @param {string} templateId - Template ID
   * @param {string} userId - User ID
   * @param {boolean} isPublic - Whether template should be public
   * @returns {Promise<Object>} Updated template
   */
  async setTemplateVisibility(templateId, userId, isPublic) {
    try {
      const { data, error } = await supabaseAdminClient
        .from('user_templates')
        .update({ is_public: isPublic })
        .eq('id', templateId)
        .eq('user_id', userId)
        .select()
        .single();
      
      if (error) throw error;
      if (!data) {
        throw new Error('Template not found or access denied');
      }
      
      return data;
    } catch (error) {
      console.error('Error updating template visibility:', error);
      throw error;
    }
  }
}

export default new TemplateService();

