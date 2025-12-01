import fs from 'node:fs/promises';

/**
 * Generic Chart Processing Engine
 * Handles common operations while delegating service-specific logic to adapters
 */
export class ChartProcessor {
  constructor(adapter) {
    this.adapter = adapter;
    this.aiContextCache = null;
    this.modificationContextCache = null;
  }

  /**
   * Generate new chart data
   * @param {string} inputText - User's chart request
   * @param {string} model - Model to use
   * @param {Object} templateStructure - Template structure metadata for generating template text content
   * @returns {Promise<Object>} - Generated chart configuration
   */
  async generateChart(inputText, model, templateStructure = null) {
    try {
      // Get AI context (with caching)
      const aiContext = await this.getAIContext();
      
      // Construct prompts
      const systemPrompt = this.buildSystemPrompt(aiContext, templateStructure);
      const userPrompt = this.buildUserPrompt(inputText, templateStructure);
      
      // Make service-specific API call
      const response = await this.adapter.generateContent({
        systemPrompt,
        userPrompt,
        model,
        maxTokens: 4000,  // Increased to 4000 for complex charts
        temperature: 0.2,
        topP: 0.85
      });
      
      // Process response
      const cleanedResponse = this.cleanResponse(response.content);
      const chartData = this.parseJSON(cleanedResponse, this.adapter.serviceName);
      
      // Validate required fields in chart data
      if (!chartData.chartType) {
        throw new Error('AI response missing chartType field');
      }
      
      if (!chartData.data && !chartData.chartData) {
        throw new Error('AI response missing chart data');
      }
      
      // Ensure user_message exists
      if (!chartData.user_message) {
        chartData.user_message = `Chart generated successfully using ${this.adapter.serviceName}`;
      }
      
      // Add metadata
      chartData._metadata = this.buildMetadata(response, model);
      
      return chartData;
      
    } catch (error) {
      console.error(`Error generating chart with ${this.adapter.serviceName}:`, error);
      throw this.enhanceError(error);
    }
  }

  /**
   * Modify existing chart data
   * @param {string} inputText - User's modification request
   * @param {Object} currentChartState - Current chart state
   * @param {Array} messageHistory - Conversation history
   * @param {string} model - Model to use
   * @param {Object} templateStructure - Template structure metadata for generating template text content
   * @returns {Promise<Object>} - Modified chart configuration
   */
  async modifyChart(inputText, currentChartState, messageHistory = [], model, templateStructure = null) {
    try {
      // Get modification context (with caching)
      const modificationContext = await this.getModificationContext();
      
      // Build modification prompt
      const contextPrompt = this.buildModificationPrompt(
        modificationContext, 
        currentChartState, 
        messageHistory, 
        inputText,
        templateStructure
      );
      
      // Make service-specific API call with higher tokens for modifications
      const response = await this.adapter.generateContent({
        userPrompt: contextPrompt,
        model,
        maxTokens: 5000,  // Increased to 5000 for complex chart modifications with history
        temperature: 0.2
      });
      
      // Process response
      const cleanedResponse = this.cleanResponse(response.content);
      const chartData = this.parseJSON(cleanedResponse, this.adapter.serviceName);
      
      // Add metadata
      chartData._metadata = this.buildMetadata(response, model);
      
      return chartData;
      
    } catch (error) {
      console.error(`Error modifying chart with ${this.adapter.serviceName}:`, error);
      throw this.enhanceError(error);
    }
  }

  /**
   * Validate service API key
   * @returns {Promise<boolean>} - Whether the API key is valid
   */
  async validateApiKey() {
    try {
      return await this.adapter.validateApiKey();
    } catch (error) {
      console.error(`Error validating ${this.adapter.serviceName} API key:`, error);
      return false;
    }
  }

  // ========== PRIVATE HELPER METHODS ==========

  /**
   * Get AI context with caching
   * @returns {Promise<string>} - AI context content
   */
  async getAIContext() {
    if (!this.aiContextCache) {
      this.aiContextCache = await fs.readFile('./src/AI_Inform.txt', 'utf-8');
    }
    return this.aiContextCache;
  }

  /**
   * Get modification context with caching
   * @returns {Promise<string>} - Modification context content
   */
  async getModificationContext() {
    if (!this.modificationContextCache) {
      this.modificationContextCache = await fs.readFile('./src/AI_Modification_Inform.txt', 'utf-8');
    }
    return this.modificationContextCache;
  }

  /**
   * Build system prompt for chart generation
   * @param {string} aiContext - AI context from file
   * @param {Object} templateStructure - Template structure metadata
   * @returns {string} - System prompt
   */
  buildSystemPrompt(aiContext, templateStructure = null) {
    let prompt = `${aiContext}

You are an expert chart data generator. Always respond with valid JSON that follows Chart.js format. 
Focus on creating accurate, well-structured data that can be immediately used to render charts.
Include proper labels, datasets, colors, and configuration options.`;

    if (templateStructure) {
      // Check if any sections require HTML
      const hasHtmlSections = templateStructure.sections?.some(s => s.contentType === 'html');
      
      prompt += `

IMPORTANT: The user has selected a template layout. You MUST also generate relevant text content for each template text area based on the chart topic.
The response must include a "templateContent" object with content for each area type (title, heading, custom, main).`;

      if (hasHtmlSections) {
        prompt += `

Some sections require HTML formatted content. For those sections, generate well-structured HTML with semantic tags like <p>, <strong>, <em>, <ul>, <li>, <h3>, <h4>, etc.

CRITICAL JSON FORMATTING RULE FOR HTML:
- All HTML content MUST be on a SINGLE LINE within the JSON string
- Do NOT include actual newlines inside HTML strings - they break JSON parsing
- Use inline HTML: "<h3>Title</h3><p>Content here</p><ul><li>Item</li></ul>"
- NEVER format HTML with line breaks inside the JSON string value`;
      }
    }

    return prompt;
  }

  /**
   * Build user prompt for chart generation
   * @param {string} inputText - User's request
   * @param {Object} templateStructure - Template structure metadata (includes contentType for each section)
   * @returns {string} - User prompt
   */
  buildUserPrompt(inputText, templateStructure = null) {
    let prompt = `User request: ${inputText}

Please generate chart data in valid JSON format.`;

    if (templateStructure) {
      // Group sections by content type for clearer instructions
      const textSections = templateStructure.sections.filter(s => s.type !== 'chart' && s.contentType !== 'html');
      const htmlSections = templateStructure.sections.filter(s => s.type !== 'chart' && s.contentType === 'html');
      
      // Build sections info with notes for enhanced guidance
      const sectionsInfo = templateStructure.sections
        .filter(s => s.type !== 'chart')
        .map(s => {
          const formatType = s.contentType === 'html' ? 'HTML formatted' : 'plain text';
          let info = `- ${s.name} (${s.type}): Generate ${formatType} content`;
          // Include the note if provided by user for more specific guidance
          if (s.note && s.note.trim()) {
            info += `\n  → USER NOTE: "${s.note}"`;
          }
          return info;
        })
        .join('\n');
      
      // Collect sections with notes for special emphasis
      const sectionsWithNotes = templateStructure.sections.filter(s => s.type !== 'chart' && s.note && s.note.trim());

      prompt += `

Template Structure:
- Dimensions: ${templateStructure.width}px × ${templateStructure.height}px
- Chart Area: ${templateStructure.chartArea.width}px × ${templateStructure.chartArea.height}px
- Text Sections to populate:
${sectionsInfo}

Your response MUST include a "templateContent" object with content for each section type.`;

      // Add emphasis on user notes if any exist
      if (sectionsWithNotes.length > 0) {
        prompt += `

IMPORTANT - User-Specified Instructions:
The user has provided specific notes for some sections. Please follow these instructions carefully:`;
        sectionsWithNotes.forEach(s => {
          prompt += `
- ${s.name}: ${s.note}`;
        });
      }

      // Add format-specific instructions
      if (htmlSections.length > 0) {
        const htmlTypes = [...new Set(htmlSections.map(s => s.type))];
        prompt += `

HTML FORMAT REQUIRED for these sections: ${htmlTypes.join(', ')}
For HTML sections, generate well-structured HTML with appropriate tags like <p>, <strong>, <em>, <ul>, <li>, <h3>, <h4>, <br>, etc.
Make the HTML visually appealing with proper semantic markup.

CRITICAL: When including HTML in JSON strings, you MUST:
1. Keep HTML on a SINGLE LINE (no actual newlines inside the string)
2. Use \\n for line breaks if needed
3. Escape all double quotes inside HTML as \\"

CORRECT example in JSON:
"main": "<h3>Key Insights</h3><ul><li><strong>Trend:</strong> Growth</li></ul><p>Details here.</p>"

WRONG (will break JSON):
"main": "<h3>Key Insights</h3>
<ul>
  <li>Item</li>
</ul>"`;
      }

      if (textSections.length > 0) {
        const textTypes = [...new Set(textSections.map(s => s.type))];
        prompt += `

PLAIN TEXT FORMAT for these sections: ${textTypes.join(', ')}
For plain text sections, generate clean, readable text without HTML tags.`;
      }

      prompt += `

Response format for templateContent:
{
  "title": "A concise, descriptive title for the chart",
  "heading": "A brief subtitle or heading that provides context",
  "custom": "Additional context or custom information (if applicable)",
  "main": "A comprehensive explanation or analysis related to the chart data"
}

Generate contextually relevant content for each section based on the chart topic and data, using the specified format (HTML or plain text) for each.`;
    }

    return prompt;
  }

  /**
   * Build modification prompt
   * @param {string} modificationContext - Modification instructions
   * @param {Object} currentChartState - Current chart state
   * @param {Array} messageHistory - Conversation history
   * @param {string} inputText - User's modification request
   * @param {Object} templateStructure - Template structure metadata
   * @returns {string} - Modification prompt
   */
  buildModificationPrompt(modificationContext, currentChartState, messageHistory, inputText, templateStructure = null) {
    // Limit history to last 2 messages to reduce token usage
    const recentHistory = messageHistory.slice(-2).map(msg => {
      // Truncate long messages to first 150 characters
      const content = msg.content?.length > 150 ? msg.content.substring(0, 150) + '...' : msg.content;
      return `${msg.role}: ${content}`;
    }).join('\n');

    // Create a compact summary of chart state (remove formatting, reduce token usage by ~70%)
    const compactData = JSON.stringify(currentChartState.chartData);
    const compactConfig = JSON.stringify(currentChartState.chartConfig);

    let prompt = `${modificationContext}

Current Chart State:
- Chart Type: ${currentChartState.chartType}
- Current Data: ${compactData}
- Current Config: ${compactConfig}

Recent conversation context (last 2 messages):
${recentHistory}

User's modification request: ${inputText}

Respond with ONLY a JSON object containing the modified chart configuration.
Keep all existing data and settings unless specifically requested to change.

Response format:
{
  "action": "modify",
  "chartType": "same or new type",
  "chartData": { /* modified data */ },
  "chartConfig": { /* modified config */ },
  "user_message": "Explanation of changes made",
  "changes": ["list of specific changes made"]`;

    if (templateStructure) {
      prompt += ',\n  "templateContent": { /* updated text for template areas if template is active */ }';
    }

    prompt += `\n}`;

    if (templateStructure) {
      // Collect sections with notes for guidance
      const sectionsWithNotes = templateStructure.sections.filter(s => s.type !== 'chart' && s.note && s.note.trim());
      
      prompt += `\n\nNote: If a template is active, also update the "templateContent" object with relevant text for each template area based on the chart modifications.`;
      
      // Include user notes for template sections if any exist
      if (sectionsWithNotes.length > 0) {
        prompt += `\n\nUser-specified instructions for template content:`;
        sectionsWithNotes.forEach(s => {
          const formatType = s.contentType === 'html' ? 'HTML' : 'plain text';
          prompt += `\n- ${s.name} (${formatType}): ${s.note}`;
        });
      }
    }

    return prompt;
  }

  /**
   * Clean response text by removing markdown formatting
   * @param {string} responseText - Raw response text
   * @returns {string} - Cleaned response text
   */
  cleanResponse(responseText) {
    if (!responseText) {
      throw new Error('Empty response from AI service');
    }

    let cleaned = responseText.trim();
    
    // Check if response is just a fallback message (not JSON)
    if (cleaned.includes("I apologize, but I couldn't generate") || 
        cleaned.includes("Please try rephrasing your request")) {
      throw new Error('AI service could not generate chart data - please try rephrasing your request');
    }
    
    // Remove ```json and ``` if they exist
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    
    // Additional cleanup - remove any remaining backticks at start/end
    cleaned = cleaned.replace(/^`+|`+$/g, '').trim();
    
    return cleaned;
  }

  /**
   * Parse JSON with enhanced error handling and auto-repair
   * @param {string} jsonText - JSON text to parse
   * @param {string} serviceName - Service name for error context
   * @returns {Object} - Parsed JSON object
   */
  parseJSON(jsonText, serviceName) {
    try {
      return JSON.parse(jsonText);
    } catch (parseError) {
      console.error(`JSON Parse Error from ${serviceName}:`, parseError.message);
      console.error('Raw response length:', jsonText.length);
      console.error('Raw response preview:', jsonText.substring(0, 500) + (jsonText.length > 500 ? '...' : ''));
      
      // Try to repair common JSON issues
      let repairedJson = this.attemptJSONRepair(jsonText);
      if (repairedJson) {
        try {
          console.log('Attempting to parse repaired JSON...');
          console.log('Repaired JSON preview:', repairedJson.substring(0, 300) + (repairedJson.length > 300 ? '...' : ''));
          return JSON.parse(repairedJson);
        } catch (repairError) {
          console.error('Repaired JSON still invalid:', repairError.message);
        }
      }
      
      // If all repair attempts fail, provide a more helpful error message
      let errorDetails = parseError.message;
      if (jsonText.length === 0) {
        errorDetails = 'Response was empty';
      } else if (!jsonText.trim().startsWith('{')) {
        errorDetails = 'Response does not appear to be JSON (missing opening brace)';
      } else if (!jsonText.trim().endsWith('}')) {
        errorDetails = 'Response appears to be truncated (missing closing brace)';
      }
      
      throw new Error(`Failed to parse ${serviceName} response as valid JSON: ${errorDetails}`);
    }
  }

  /**
   * Attempt to repair common JSON issues
   * @param {string} jsonText - Malformed JSON text
   * @returns {string|null} - Repaired JSON or null if can't repair
   */
  attemptJSONRepair(jsonText) {
    try {
      let repaired = jsonText.trim();
      
      // FIRST: Fix HTML content issues - newlines and unescaped characters inside strings
      repaired = this.fixHTMLInJSON(repaired);
      
      // Try parsing after HTML fix
      try {
        JSON.parse(repaired);
        console.log('JSON fixed by HTML content repair');
        return repaired;
      } catch (e) {
        // Continue with other repair attempts
      }
      
      // Find the last complete object by looking for the last complete closing brace
      let braceCount = 0;
      let lastValidIndex = -1;
      let inString = false;
      let escapeNext = false;
      
      for (let i = 0; i < repaired.length; i++) {
        const char = repaired[i];
        
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        
        if (char === '\\') {
          escapeNext = true;
          continue;
        }
        
        if (char === '"') {
          inString = !inString;
          continue;
        }
        
        if (!inString) {
          if (char === '{') {
            braceCount++;
          } else if (char === '}') {
            braceCount--;
            if (braceCount === 0) {
              lastValidIndex = i;
            }
          }
        }
      }
      
      if (lastValidIndex > 0 && lastValidIndex < repaired.length - 1) {
        // Truncate to the last valid closing brace
        repaired = repaired.substring(0, lastValidIndex + 1);
        console.log('Truncated JSON to last valid closing brace');
        return repaired;
      }
      
      // Handle the specific case from the error where arrays are incomplete
      // Look for patterns like: "rgba(54, 162, 235, 1)",\n"rgba(255, 99, 132, 1)",\n
      // and try to close them properly
      if (repaired.includes('borderColor') && repaired.includes('rgba(')) {
        // Find the last complete rgba value
        const rgbaMatches = [...repaired.matchAll(/"rgba\([^"]+\)"/g)];
        if (rgbaMatches.length > 0) {
          const lastMatch = rgbaMatches[rgbaMatches.length - 1];
          const lastMatchEnd = lastMatch.index + lastMatch[0].length;
          
          // Check if there's incomplete content after the last rgba
          const afterLastRgba = repaired.substring(lastMatchEnd);
          if (afterLastRgba.trim() && !afterLastRgba.includes(']')) {
            // Close the array and complete the JSON structure
            repaired = repaired.substring(0, lastMatchEnd) + '\n        ]\n      }\n    ]\n  }\n}';
            console.log('Attempted to close incomplete rgba array');
            return repaired;
          }
        }
      }
      
      // Try to fix unterminated strings
      if (inString) {
        // Find the last opening quote without a closing quote
        let quoteCount = 0;
        let lastOpenQuoteIndex = -1;
        
        for (let i = 0; i < repaired.length; i++) {
          if (repaired[i] === '"' && (i === 0 || repaired[i-1] !== '\\')) {
            quoteCount++;
            if (quoteCount % 2 === 1) {
              lastOpenQuoteIndex = i;
            }
          }
        }
        
        if (lastOpenQuoteIndex > -1) {
          // Close the unterminated string and try to complete the structure
          repaired = repaired.substring(0, lastOpenQuoteIndex + 1) + '"]}}';
          console.log('Attempted to close unterminated string');
          return repaired;
        }
      }
      
      // Try to close unclosed arrays and objects
      let arrayCount = 0;
      let objectCount = 0;
      inString = false;
      escapeNext = false;
      
      for (let i = 0; i < repaired.length; i++) {
        const char = repaired[i];
        
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        
        if (char === '\\') {
          escapeNext = true;
          continue;
        }
        
        if (char === '"') {
          inString = !inString;
          continue;
        }
        
        if (!inString) {
          if (char === '[') arrayCount++;
          else if (char === ']') arrayCount--;
          else if (char === '{') objectCount++;
          else if (char === '}') objectCount--;
        }
      }
      
      // Add missing closing brackets
      while (arrayCount > 0) {
        repaired += ']';
        arrayCount--;
      }
      while (objectCount > 0) {
        repaired += '}';
        objectCount--;
      }
      
      if (arrayCount < 0 || objectCount < 0) {
        console.log('Could not repair JSON: too many closing brackets');
        return null;
      }
      
      console.log('Attempted to close unclosed brackets');
      return repaired;
      
    } catch (error) {
      console.error('Error during JSON repair attempt:', error);
      return null;
    }
  }

  /**
   * Fix HTML content inside JSON strings
   * Handles common issues like unescaped newlines and quotes in HTML content
   * @param {string} jsonText - JSON text potentially containing HTML with issues
   * @returns {string} - Fixed JSON text
   */
  fixHTMLInJSON(jsonText) {
    let result = jsonText;
    
    // Find all string values in JSON (simplified approach)
    // This regex finds strings that look like they contain HTML tags
    const htmlStringPattern = /"([^"]*<[^>]+>[^"]*)"/g;
    
    // More robust approach: process the JSON character by character
    // to properly escape newlines and tabs within string values
    let inString = false;
    let escapeNext = false;
    let fixed = '';
    
    for (let i = 0; i < result.length; i++) {
      const char = result[i];
      const nextChar = result[i + 1];
      
      if (escapeNext) {
        escapeNext = false;
        fixed += char;
        continue;
      }
      
      if (char === '\\') {
        escapeNext = true;
        fixed += char;
        continue;
      }
      
      if (char === '"') {
        inString = !inString;
        fixed += char;
        continue;
      }
      
      if (inString) {
        // Inside a string, escape problematic characters
        if (char === '\n') {
          fixed += '\\n';
          continue;
        }
        if (char === '\r') {
          fixed += '\\r';
          continue;
        }
        if (char === '\t') {
          fixed += '\\t';
          continue;
        }
      }
      
      fixed += char;
    }
    
    // If we ended up inside a string, something is still wrong
    // but at least we tried to fix the newline issues
    if (fixed !== result) {
      console.log('Fixed newlines/tabs in JSON strings');
    }
    
    return fixed;
  }

  /**
   * Build metadata object
   * @param {Object} response - API response
   * @param {string} model - Model used
   * @returns {Object} - Metadata object
   */
  buildMetadata(response, model) {
    const baseMetadata = {
      service: this.adapter.serviceName,
      model: model,
      timestamp: new Date().toISOString(),
      tokens_used: response.tokensUsed || null
    };

    // Add service-specific metadata
    return { ...baseMetadata, ...this.adapter.getAdditionalMetadata(response, model) };
  }

  /**
   * Enhance errors with service-specific context
   * @param {Error} error - Original error
   * @returns {Error} - Enhanced error
   */
  enhanceError(error) {
    // Check for common error patterns
    if (error.message?.includes('JSON')) {
      return new Error(`Failed to parse ${this.adapter.serviceName} response as valid JSON`);
    }
    
    // Delegate to adapter for service-specific error handling
    return this.adapter.enhanceError(error);
  }

  /**
   * Clear all caches (useful for testing or memory management)
   */
  clearCache() {
    this.aiContextCache = null;
    this.modificationContextCache = null;
  }
}

/**
 * Factory function to create chart processor with adapter
 * @param {Object} adapter - Service-specific adapter
 * @returns {ChartProcessor} - Configured chart processor
 */
export function createChartProcessor(adapter) {
  return new ChartProcessor(adapter);
} 