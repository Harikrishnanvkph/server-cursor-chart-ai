import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fetch from 'node-fetch';
import { searchService } from '../search/searchService.js';

// Resolve paths relative to THIS file, not the working directory.
// This fixes "ENOENT" errors on Vercel/serverless where cwd differs from local dev.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, '..');

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
  async generateChart(inputText, model, templateStructure = null, formatStructure = null, webSearch = false) {
    try {
      // Get AI context (with caching)
      const aiContext = await this.getAIContext();

      let searchResults = null;
      if (webSearch && !this.adapter.hasNativeSearch) {
        let searchQuery = inputText;
        try {
          const queryDecision = await searchService.determineSearchQuery(inputText, [], this.adapter.serviceName);
          if (queryDecision && queryDecision !== 'NO_SEARCH') {
            searchQuery = queryDecision;
          }
        } catch (queryErr) {
          console.warn('⚠️ [WebSearch] Query optimizer error, falling back to user input:', queryErr.message);
        }

        // Ensure search query stays within Tavily API limit (350 chars)
        if (searchQuery.length > 350) {
          searchQuery = searchQuery.substring(0, 350);
        }

        try {
          searchResults = await searchService.search(searchQuery);
        } catch (searchError) {
          console.error('❌ [WebSearch] Tavily search failed:', searchError.message);
        }
      }

      // Construct prompts
      const systemPrompt = this.buildSystemPrompt(aiContext, templateStructure, formatStructure, searchResults);
      const userPrompt = this.buildUserPrompt(inputText, templateStructure);

      // Make service-specific API call
      const response = await this.adapter.generateContent({
        systemPrompt,
        userPrompt,
        model,
        maxTokens: 2500,  // Tuned: typical chart JSON is 500-1500 tokens
        temperature: 0.2,
        topP: 0.85,
        webSearch
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

      // Automatically resolve country flags or famous people photos programmatically
      try {
        await this.resolvePointImages(chartData, inputText);
      } catch (err) {
        console.error('Error resolving point images in generateChart:', err);
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
  async modifyChart(inputText, currentChartState, messageHistory = [], model, templateStructure = null, formatStructure = null, webSearch = false) {
    try {
      // Get modification context (with caching)
      const modificationContext = await this.getModificationContext();

      let searchResults = null;
      if (webSearch && !this.adapter.hasNativeSearch) {
        let searchQuery = inputText;
        try {
          const queryDecision = await searchService.determineSearchQuery(inputText, messageHistory, this.adapter.serviceName);
          if (queryDecision && queryDecision !== 'NO_SEARCH') {
            searchQuery = queryDecision;
          }
        } catch (queryErr) {
          console.warn('⚠️ [WebSearch] Query optimizer error, falling back to user input:', queryErr.message);
        }

        // Ensure search query stays within Tavily API limit (350 chars)
        if (searchQuery.length > 350) {
          searchQuery = searchQuery.substring(0, 350);
        }

        try {
          searchResults = await searchService.search(searchQuery);
        } catch (searchError) {
          console.error('❌ [WebSearch] Tavily search failed:', searchError.message);
        }
      }

      // Build modification prompt
      const contextPrompt = this.buildModificationPrompt(
        modificationContext,
        currentChartState,
        messageHistory,
        inputText,
        templateStructure,
        formatStructure,
        searchResults
      );

      // Make service-specific API call with higher tokens for modifications
      const response = await this.adapter.generateContent({
        userPrompt: contextPrompt,
        model,
        maxTokens: 3500,  // Tuned: modifications rarely exceed 2000 tokens
        temperature: 0.2,
        webSearch
      });

      // Process response
      const cleanedResponse = this.cleanResponse(response.content);
      const chartData = this.parseJSON(cleanedResponse, this.adapter.serviceName);

      // Automatically resolve country flags or famous people photos programmatically
      try {
        await this.resolvePointImages(chartData, inputText);
      } catch (err) {
        console.error('Error resolving point images in modifyChart:', err);
      }

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
      this.aiContextCache = await fs.readFile(path.join(SRC_DIR, 'AI_Inform.txt'), 'utf-8');
    }
    return this.aiContextCache;
  }

  /**
   * Get modification context with caching
   * @returns {Promise<string>} - Modification context content
   */
  async getModificationContext() {
    if (!this.modificationContextCache) {
      this.modificationContextCache = await fs.readFile(path.join(SRC_DIR, 'AI_Modification_Inform.txt'), 'utf-8');
    }
    return this.modificationContextCache;
  }

  /**
   * Build system prompt for chart generation
   * @param {string} aiContext - AI context from file
   * @param {Object} templateStructure - Template structure metadata
   * @returns {string} - System prompt
   */
  buildSystemPrompt(aiContext, templateStructure = null, formatStructure = null, searchResults = null) {
    const currentYear = new Date().getFullYear();
    let prompt = `${aiContext}

CURRENT YEAR / TIME CONTEXT: ${currentYear} (Today's date context: Year ${currentYear})
CRITICAL: When generating data for real-time or current requests, reflect real-world facts for ${currentYear} (or up to ${currentYear}). Do NOT restrict data to past years like 2024 or 2025 unless explicitly asked by the user.

You are an expert chart data generator. Always respond with valid JSON.
Focus on creating accurate, well-structured data with meaningful titles and axis labels.
Do NOT include "options" or "chartConfig" — the frontend handles all chart configuration automatically.`;

    if (searchResults) {
      prompt += `

=== LIVE WEB SEARCH GROUNDING DATA ===
The following real-time search results were retrieved from the web for this specific query.
YOU MUST:
1. Extract exact numerical data, figures, statistics, and dates directly from these search results.
2. Maintain realistic values and proper units (e.g. $, %, millions, billions, kg, etc.) in titles and axis labels.
3. Do NOT make up or hallucinate numbers when real figures are present in the search results below.
4. If image links are provided under "[Search Results Image Links (Direct Image URLs)]", prioritize these exact URLs for logos, icons, or entity photos.

Search Results:
${searchResults}
======================================`;
    }

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

    // F4: Reinforce pointImages instructions when user mentions image-related keywords
    const imageKeywords = /\b(image|icon|picture|logo|photo|emoji|avatar|flag)\b/i;
    if (imageKeywords.test(inputText)) {
      prompt += `\n\nIMPORTANT: The user wants images on data points. You MUST include "pointImages" (array of working image URLs), "pointImageConfig" (array of config objects), and "pointImageSearchQueries" (array of specific search terms for each label to help the backend search engine find correct images, e.g., "Blast 2026 Tamil movie" instead of just "Blast") in each dataset. All arrays must match labels length.`;
    }

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
  buildModificationPrompt(modificationContext, currentChartState, messageHistory, inputText, templateStructure = null, formatStructure = null, searchResults = null) {
    // Increased from 2→5 messages and 150→300 chars for better AI context
    const recentHistory = messageHistory.slice(-5).map(msg => {
      // Truncate long messages to first 300 characters
      const content = msg.content?.length > 300 ? msg.content.substring(0, 300) + '...' : msg.content;
      return `${msg.role}: ${content}`;
    }).join('\n');

    // Build human-readable chart summary for AI to understand context
    const chartSummary = this.buildChartSummary(currentChartState);

    // F1: Slim chart data — strip colors, styling, pointImages to save ~1,000-2,500 tokens
    // The LLM rarely needs exact RGBA values or image URLs for modifications
    const slimData = this.slimChartData(currentChartState.chartData);
    const slimConfig = this.slimChartConfig(currentChartState.chartConfig);

    const currentYear = new Date().getFullYear();
    let prompt = `${modificationContext}

CURRENT YEAR / TIME CONTEXT: ${currentYear} (Today's date context: Year ${currentYear})`;

    if (searchResults) {
      prompt += `

=== LIVE WEB SEARCH GROUNDING DATA ===
The following real-time search results are retrieved from the web regarding the user's request.
You MUST use these facts, figures, and data points to modify the chart accurately with real data.
Do NOT make up or hallucinate numbers if they are present in these search results.
If the search results contain any image links under "[Search Results Image Links (Direct Image URLs)]", you MUST use these exact URLs if the user requests images, icons, or flags on data points or within the text, instead of fabricating fake image links.

Search Results:
${searchResults}
======================================`;
    }

    prompt += `

CURRENT CHART SUMMARY:
${chartSummary}

CURRENT CHART STATE:
- Chart Type: ${currentChartState.chartType}
- Data: ${JSON.stringify(slimData)}
- Config: ${JSON.stringify(slimConfig)}

CONVERSATION HISTORY (last 5 messages):
${recentHistory}

USER'S CURRENT REQUEST: ${inputText}`;

    if (templateStructure) {
      prompt += ',\n  "templateContent": { /* updated text/HTML for template areas */ }';
    } else if (formatStructure) {
      prompt += ',\n  "formatContent": { /* updated text for format zones */ }';
    }

    prompt += `\n
  }`;

    if (templateStructure) {
      // List available template text areas
      const textAreas = templateStructure.sections.filter(s => s.type !== 'chart');

      prompt += `\n\n === TEMPLATE IS ACTIVE === `;
      prompt += `\nAvailable text areas you can modify: `;
      textAreas.forEach(s => {
        const formatType = s.contentType === 'html' ? 'HTML' : 'plain text';
        prompt += `\n - "${s.type}"(${s.name}): expects ${formatType} `;
      });

      // Collect sections with notes for guidance
      const sectionsWithNotes = textAreas.filter(s => s.note && s.note.trim());
      if (sectionsWithNotes.length > 0) {
        prompt += `\n\nUser instructions for specific areas: `;
        sectionsWithNotes.forEach(s => {
          prompt += `\n - ${s.name}: "${s.note}"`;
        });
      }

      prompt += `\n\nREMEMBER: "main text area" = templateContent.main, NOT pointImages!`;
    } else if (formatStructure) {
      prompt += `\n\n === FORMAT IS ACTIVE === `;
      prompt += `\nAvailable format content zones you can modify inside the "formatContent" object:`;
      formatStructure.zones.forEach(z => {
        if (z.type !== 'chart') {
          prompt += `\n - "${z.role || z.type}" (max ${z.maxCharacters} chars)`;
          if (z.adminMessage) prompt += ` - admin instruction: "${z.adminMessage}"`;
          if (z.userNote) prompt += ` - user note: "${z.userNote}"`;
        }
      });
      prompt += `\n\nEnsure you update formatContent zones to align with the changes.`;
    } else {
      prompt += `\n\nNOTE: No template or format is active. Text areas/zones are not available in chart-only mode.`;
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

    // Remove ```json and``` if they exist
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
          if (repaired[i] === '"' && (i === 0 || repaired[i - 1] !== '\\')) {
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
   * Build human-readable chart summary for AI understanding
   * @param {Object} chartState - Current chart state
   * @returns {string} - Human-readable summary
   */
  buildChartSummary(chartState) {
    if (!chartState || !chartState.chartData) {
      return "No chart currently exists.";
    }

    const { chartType, chartData, chartConfig } = chartState;
    const datasets = chartData.datasets || [];
    const labels = chartData.labels || [];

    let summary = `Current chart is a ${chartType} chart`;

    if (labels.length > 0) {
      summary += ` with ${labels.length} data points`;
      if (labels.length <= 5) {
        summary += ` (labels: ${labels.join(', ')})`;
      } else {
        summary += ` (labels: ${labels.slice(0, 3).join(', ')}... and ${labels.length - 3} more)`;
      }
    }

    if (datasets.length > 0) {
      summary += `. It has ${datasets.length} dataset(s): `;
      summary += datasets.map(ds => `"${ds.label || 'Untitled'}"`).join(', ');
    }

    // Add title if present
    const title = chartConfig?.plugins?.title?.text;
    if (title) {
      summary += `. Chart title: "${title}"`;
    }

    return summary;
  }

  /**
   * Clear all caches (useful for testing or memory management)
   */
  clearCache() {
    this.aiContextCache = null;
    this.modificationContextCache = null;
  }

  /**
   * F1: Create a slim version of chart data for the modification prompt.
   * Includes colors so AI can preserve them when not asked to change them.
   * Strips other styling (borderWidth, tension, fill, etc.) to save tokens.
   */
  slimChartData(chartData) {
    if (!chartData) return {};
    return {
      labels: chartData.labels,
      datasets: (chartData.datasets || []).map(ds => {
        const slim = { label: ds.label, data: ds.data };
        // Include colors so AI preserves them exactly when not asked to change
        if (ds.backgroundColor) slim.backgroundColor = ds.backgroundColor;
        if (ds.borderColor) slim.borderColor = ds.borderColor;
        if (ds.mode) slim.mode = ds.mode;
        if (ds.stack) slim.stack = ds.stack;
        // Preserve pointImages so LLM doesn't drop them during modifications
        if (ds.pointImages) slim.pointImages = ds.pointImages;
        if (ds.pointImageSearchQueries) slim.pointImageSearchQueries = ds.pointImageSearchQueries;
        if (ds.pointImageConfig) slim.pointImageConfig = ds.pointImageConfig;
        return slim;
      })
    };
  }

  /**
   * F1: Create a slim version of chart config — preserves Chart.js nesting structure
   * so the AI returns changes in the correct format for deep-merge.
   */
  slimChartConfig(chartConfig) {
    if (!chartConfig) return {};
    const slim = {};

    // Preserve plugins structure so AI can target plugins.title.display, etc.
    if (chartConfig.plugins) {
      slim.plugins = {};
      if (chartConfig.plugins.title) {
        slim.plugins.title = {
          display: chartConfig.plugins.title.display,
          text: chartConfig.plugins.title.text || ''
        };
      }
      if (chartConfig.plugins.subtitle) {
        slim.plugins.subtitle = {
          display: chartConfig.plugins.subtitle.display,
          text: chartConfig.plugins.subtitle.text || ''
        };
      }
      if (chartConfig.plugins.legend) {
        slim.plugins.legend = {
          display: chartConfig.plugins.legend.display,
          position: chartConfig.plugins.legend.position
        };
      }
      if (chartConfig.plugins.datalabels) {
        slim.plugins.datalabels = {
          display: chartConfig.plugins.datalabels.display
        };
      }
      if (chartConfig.plugins.customLabelsConfig) {
        slim.plugins.customLabelsConfig = {
          display: chartConfig.plugins.customLabelsConfig.display
        };
      }
    }

    // Preserve visualSettings so AI can sync with frontend toggles
    if (chartConfig.visualSettings) {
      slim.visualSettings = { ...chartConfig.visualSettings };
    }

    // Preserve scales structure
    if (chartConfig.scales) {
      slim.scales = {};
      for (const [axis, cfg] of Object.entries(chartConfig.scales)) {
        slim.scales[axis] = {};
        if (cfg.title) {
          slim.scales[axis].title = {
            display: cfg.title.display,
            text: cfg.title.text || ''
          };
        }
        if (cfg.beginAtZero !== undefined) slim.scales[axis].beginAtZero = cfg.beginAtZero;
      }
    }

    return slim;
  }

  /**
   * Automatically resolve country flags or famous people photos programmatically
   * based on data labels and user request prompt context.
   */
  async resolvePointImages(chartData, userPrompt) {
    if (!chartData) return;

    // Resolve target data container
    let chartDataContainer = chartData.chartData || chartData.data;
    if (!chartDataContainer || !chartDataContainer.datasets || !Array.isArray(chartDataContainer.datasets)) {
      return;
    }

    const datasets = chartDataContainer.datasets;
    const labels = chartDataContainer.labels || [];
    if (!labels.length) return;

    const promptLower = (userPrompt || "").toLowerCase();
    const wantsFlags = /\b(flag|flags|country flag|country flags)\b/i.test(promptLower);
    const wantsImages = /\b(image|images|icon|icons|picture|pictures|photo|photos|avatar|avatars|portrait|portraits|profile|profiles|flag|flags|logo|logos|brand|brands|emblem|emblems|symbol|symbols)\b/i.test(promptLower);

    // Check if the LLM already returned pointImages
    const hasPointImages = datasets.some(ds => ds.pointImages && Array.isArray(ds.pointImages));

    // If no image/flag is requested, and the LLM didn't return any pointImages, do nothing
    if (!wantsFlags && !wantsImages && !hasPointImages) {
      return;
    }

    const fetchPromises = [];

    datasets.forEach(ds => {
      // Ensure pointImages array exists and matches the labels length
      if (!ds.pointImages || !Array.isArray(ds.pointImages)) {
        ds.pointImages = Array(labels.length).fill(null);
      } else {
        // Pad array if too short
        while (ds.pointImages.length < labels.length) {
          ds.pointImages.push(null);
        }
      }

      // Ensure pointImageConfig exists and matches labels length
      if (!ds.pointImageConfig || !Array.isArray(ds.pointImageConfig)) {
        ds.pointImageConfig = Array(labels.length).fill(null).map(() => ({
          type: "circle",
          size: 24,
          position: "center",
          arrow: false
        }));
      } else {
        while (ds.pointImageConfig.length < labels.length) {
          ds.pointImageConfig.push({
            type: "circle",
            size: 24,
            position: "center",
            arrow: false
          });
        }
      }

      labels.forEach((label, idx) => {
        const cleanLabel = String(label).trim();
        const currentImg = ds.pointImages[idx];

        // Helper to check if a string is a valid HTTP/S URL
        const isUrl = (url) => typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
        const isWikipediaUrl = (url) => typeof url === 'string' && (url.includes('wikipedia.org') || url.includes('wikimedia.org'));
        
        const isDuplicate = currentImg && ds.pointImages.filter(img => img === currentImg).length > 2;
        const isWiki = isWikipediaUrl(currentImg);

        // 1. Resolve flag if user explicitly asked for flags OR if label is a country and wantsFlags is true
        const countryCode = getCountryCode(cleanLabel);
        if (countryCode && (wantsFlags || (wantsImages && !isUrl(currentImg)))) {
          ds.pointImages[idx] = `https://flagcdn.com/w80/${countryCode}.png`;
          return;
        }

        // 2. Resolve famous person profile image if wantsImages is true and we don't have a valid Wikipedia URL
        // or if the URL returned was a duplicate/composite, or if it's currently empty/null/non-URL
        if (wantsImages && (!currentImg || isDuplicate || !isUrl(currentImg) || !isWiki)) {
          // Use LLM-generated search query if available, otherwise default to label
          const refinedLabel = (ds.pointImageSearchQueries && ds.pointImageSearchQueries[idx])
            ? String(ds.pointImageSearchQueries[idx]).trim()
            : cleanLabel;

          // Push promise to resolve the image via our robust famous person resolver
          const promise = resolveFamousPersonImage(refinedLabel).then(resolvedUrl => {
            if (resolvedUrl) {
              ds.pointImages[idx] = resolvedUrl;
            } else {
              ds.pointImages[idx] = null;
            }
          });
          fetchPromises.push(promise);
        }
      });
    });

    if (fetchPromises.length > 0) {
      await Promise.all(fetchPromises);
    }

    // Final pass: normalize all Wikimedia/Wikipedia image URLs to official Special:FilePath format
    // This prevents the "Error: Use thumbnail sizes listed on https://w.wiki/GHai" error from upload.wikimedia.org
    datasets.forEach(ds => {
      if (ds.pointImages && Array.isArray(ds.pointImages)) {
        ds.pointImages = ds.pointImages.map(img => normalizeWikimediaUrl(img));
      }
    });
  }
}

function normalizeWikimediaUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (!url.includes('wikimedia.org') && !url.includes('wikipedia.org')) return url;

  try {
    const parsed = new URL(url);
    const path = parsed.pathname;

    let filename = path.substring(path.lastIndexOf('/') + 1);

    // Strip thumbnail scaling prefix if present (e.g. 220px-Shiv_Nadar_2015.jpg -> Shiv_Nadar_2015.jpg)
    if (/^\d+px-/.test(filename)) {
      filename = filename.replace(/^\d+px-/, '');
    }

    // Handle SVG conversions (e.g., .../foo.svg/220px-foo.svg.png -> foo.svg)
    if (path.toLowerCase().includes('.svg/')) {
      const match = path.match(/^(.*\.svg)\//i);
      if (match) {
        const parts = match[1].split('/');
        filename = parts[parts.length - 1];
      }
    }

    if (filename) {
      const cleanFilename = decodeURIComponent(filename);
      const host = parsed.hostname.includes('upload.wikimedia.org') ? 'commons.wikimedia.org' : parsed.hostname;
      return `https://${host}/wiki/Special:FilePath/${encodeURIComponent(cleanFilename)}?width=500`;
    }
  } catch (e) {
    // If URL parsing fails, return original
  }
  return url;
}

async function fetchWikiImage(label) {
  try {
    // 1. Search Wikipedia for the closest page and retrieve its pageimage/thumbnail
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(label)}&gsrlimit=1&prop=pageimages&format=json&pithumbsize=500`;
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Antigravity/1.0 (Google DeepMind Team)' }
    });
    
    if (res.ok) {
      const data = await res.json();
      if (data.query && data.query.pages) {
        const pageId = Object.keys(data.query.pages)[0];
        const page = data.query.pages[pageId];
        if (page.thumbnail && page.thumbnail.source) {
          return normalizeWikimediaUrl(page.thumbnail.source);
        }
      }
    }

    // 2. Direct title match fallback (following redirects)
    const directUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(label)}&prop=pageimages&format=json&pithumbsize=500&redirects=1`;
    const directRes = await fetch(directUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Antigravity/1.0 (Google DeepMind Team)' }
    });
    
    if (directRes.ok) {
      const directData = await directRes.json();
      if (directData.query && directData.query.pages) {
        const pageId = Object.keys(directData.query.pages)[0];
        const page = directData.query.pages[pageId];
        if (page && page.thumbnail && page.thumbnail.source) {
          return normalizeWikimediaUrl(page.thumbnail.source);
        }
      }
    }

    // 3. MediaWiki REST API Summary fallback
    const restUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(label)}`;
    const restRes = await fetch(restUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Antigravity/1.0 (Google DeepMind Team)' }
    });
    if (restRes.ok) {
      const restData = await restRes.json();
      if (restData.thumbnail && restData.thumbnail.source) {
        return normalizeWikimediaUrl(restData.thumbnail.source);
      }
      if (restData.originalimage && restData.originalimage.source) {
        return normalizeWikimediaUrl(restData.originalimage.source);
      }
    }

    return null;
  } catch (e) {
    console.error(`[WikiResolver] Error resolving image for "${label}":`, e.message);
    return null;
  }
}

async function resolveFamousPersonImage(cleanLabel) {
  // 1. Try Wikipedia PageImages API first (cleanest, handles naming redirects)
  let wikiUrl = await fetchWikiImage(cleanLabel);
  if (wikiUrl) return wikiUrl;

  // 2. Try Tavily Live Web Search Fallback (excluding Wikipedia/Wikimedia redirects)
  let webUrl = await fetchTavilyImageFallback(cleanLabel);
  if (webUrl) return webUrl;

  // 3. Manual Wikipedia File check fallback
  const cleanPersonName = cleanLabel.replace(/\s+(&|and)?\s*[Ff]amily\s*$/i, '').trim();
  const formattedName = cleanPersonName
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('_');

  // Try checking .jpg existence
  const jpgFilename = `${formattedName}.jpg`;
  if (await checkWikipediaFile(jpgFilename)) {
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${jpgFilename}`;
  }

  // Try checking .png existence
  const pngFilename = `${formattedName}.png`;
  if (await checkWikipediaFile(pngFilename)) {
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${pngFilename}`;
  }

  // Try checking .jpeg existence
  const jpegFilename = `${formattedName}.jpeg`;
  if (await checkWikipediaFile(jpegFilename)) {
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${jpegFilename}`;
  }

  return null;
}

async function checkWikipediaFile(name) {
  const url = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=500`;
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none'
      },
      timeout: 2000
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function validateImageUrl(url, timeoutMs = 2500) {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) return false;

  // Trusted fast paths
  if (url.includes('wikimedia.org') || url.includes('wikipedia.org') || url.includes('flagcdn.com')) {
    return true;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('image/') || contentType.includes('octet-stream')) {
        return true;
      }
    }
    return false;
  } catch (e) {
    return false;
  }
}

async function fetchTavilyImageFallback(label) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return null;

  try {
    let query = label;
    if (!/\b(movie|film|song|music|game|book|novel|logo|brand|flag)\b/i.test(label)) {
      const isCompany = /\b(inc|corp|co|limited|ltd|plc|gmbh|sa|group|company|corporation|brands|industries|apple|google|microsoft|amazon|meta|tesla|nvidia|samsung)\b/i.test(label);
      query = label + (isCompany ? " logo png" : " face profile photo");
    }

    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: query,
        max_results: 5,
        search_depth: 'basic',
        include_images: true
      })
    });

    if (response.ok) {
      const data = await response.json();
      if (data.images && data.images.length > 0) {
        for (const imgItem of data.images) {
          const rawUrl = typeof imgItem === 'string' ? imgItem : (imgItem.url || imgItem);
          if (typeof rawUrl === 'string' && rawUrl.startsWith('http')) {
            if (!rawUrl.includes('wikipedia.org') && !rawUrl.includes('wikimedia.org')) {
              const isValid = await validateImageUrl(rawUrl);
              if (isValid) {
                return rawUrl;
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.error(`[WikiResolver] Tavily fallback failed for "${label}":`, e.message);
  }
  return null;
}

const COUNTRY_MAP = {
  'united states': 'us', 'usa': 'us', 'united states of america': 'us', 'america': 'us',
  'united kingdom': 'gb', 'uk': 'gb', 'great britain': 'gb', 'england': 'gb', 'scotland': 'gb',
  'canada': 'ca',
  'germany': 'de', 'deutschland': 'de',
  'france': 'fr',
  'italy': 'it', 'italia': 'it',
  'japan': 'jp',
  'china': 'cn',
  'india': 'in',
  'brazil': 'br', 'brasil': 'br',
  'russia': 'ru', 'russian federation': 'ru',
  'australia': 'au',
  'spain': 'es', 'espana': 'es', 'españa': 'es',
  'mexico': 'mx', 'méxico': 'mx',
  'south korea': 'kr', 'korea': 'kr', 'republic of korea': 'kr',
  'netherlands': 'nl', 'holland': 'nl',
  'switzerland': 'ch',
  'turkey': 'tr', 'türkiye': 'tr', 'turkiye': 'tr',
  'saudi arabia': 'sa',
  'sweden': 'se',
  'poland': 'pl',
  'belgium': 'be',
  'norway': 'no',
  'austria': 'at',
  'denmark': 'dk',
  'finland': 'fi',
  'singapore': 'sg',
  'new zealand': 'nz',
  'ireland': 'ie',
  'south africa': 'za',
  'egypt': 'eg',
  'united arab emirates': 'ae', 'uae': 'ae',
  'argentina': 'ar',
  'chile': 'cl',
  'colombia': 'co',
  'peru': 'pe', 'perú': 'pe',
  'venezuela': 've',
  'indonesia': 'id',
  'malaysia': 'my',
  'philippines': 'ph',
  'thailand': 'th',
  'vietnam': 'vn',
  'pakistan': 'pk',
  'bangladesh': 'bd',
  'nigeria': 'ng',
  'kenya': 'ke',
  'morocco': 'ma',
  'ukraine': 'ua',
  'greece': 'gr',
  'portugal': 'pt',
  'hong kong': 'hk',
  'taiwan': 'tw',
  'czech republic': 'cz',
  'romania': 'ro',
  'hungary': 'hu',
  'israel': 'il'
};

function getCountryCode(name) {
  if (!name) return null;
  return COUNTRY_MAP[name.toLowerCase().trim()] || null;
}

/**
 * Factory function to create chart processor with adapter
 * @param {Object} adapter - Service-specific adapter
 * @returns {ChartProcessor} - Configured chart processor
 */
export function createChartProcessor(adapter) {
  return new ChartProcessor(adapter);
} 