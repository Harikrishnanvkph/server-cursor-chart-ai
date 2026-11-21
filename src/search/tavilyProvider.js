import { combineAbortSignals } from '../utils/abortUtils.js';

/**
 * Tavily Search Provider
 * Calls the Tavily Search API and returns formatted results
 */
export class TavilyProvider {
  constructor() {
    this.name = 'tavily';
  }

  /**
   * Perform search
   * @param {string} query - The search query string
   * @returns {Promise<string>} - Formatted search results
   */
  async search(query, options = {}) {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      throw new Error('Tavily API key is not configured. Set TAVILY_API_KEY in .env');
    }

    const { signal, cleanup } = combineAbortSignals(options?.signal, 15000);
    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          api_key: apiKey,
          query: query,
          max_results: 6,
          search_depth: 'advanced',
          include_answer: true,
          include_images: true
        }),
        signal
      });

      if (!response.ok) {
        throw new Error(`Tavily API responded with status ${response.status}`);
      }

      const data = await response.json();
      
      if ((!data.results || data.results.length === 0) && !data.answer) {
        return 'No search results found.';
      }

      let answerSection = '';
      if (data.answer) {
        answerSection = `=== VERIFIED SEARCH RESEARCH SUMMARY ===\n${data.answer}\n========================================\n\n`;
      }

      // Format results into a clear, concise text block for the LLM
      const formattedResults = (data.results || [])
        .map((result, index) => {
          const title = result.title || 'Untitled';
          const url = result.url || 'No URL';
          const content = result.content || '';
          return `[Result ${index + 1}]
Title: ${title}
URL: ${url}
Snippet: ${content}`;
        })
        .join('\n\n');

      let imageSection = '';
      if (data.images && data.images.length > 0) {
        imageSection = '\n\n[Search Results Image Links (Direct Image URLs)]\n' + 
          data.images.map(img => typeof img === 'string' ? `- ${img}` : `- ${img.url || img}`).join('\n');
      }

      return answerSection + formattedResults + imageSection;
    } catch (error) {
      if (options?.signal?.aborted) {
        const abortErr = new Error('Search cancelled');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      console.error('Tavily search provider error:', error);
      throw new Error(`Tavily search failed: ${error.message}`);
    } finally {
      cleanup();
    }
  }
}

export function createTavilyProvider() {
  return new TavilyProvider();
}
