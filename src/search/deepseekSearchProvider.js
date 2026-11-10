/**
 * DeepSeek Search Provider
 * Calls DeepSeek's native Search API (`https://api.deepseek.com/v1/tools/search`)
 * and returns formatted results for the LLM
 */
export class DeepSeekSearchProvider {
  constructor() {
    this.name = 'deepseek';
  }

  /**
   * Perform search via DeepSeek native search tool endpoint
   * @param {string} query - The search query string
   * @returns {Promise<string>} - Formatted search results
   */
  async search(query) {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error('DeepSeek API key is not configured. Set DEEPSEEK_API_KEY in .env');
    }

    try {
      // DeepSeek search API query limit is 128 characters
      const cleanQuery = query && query.length > 128 ? query.substring(0, 128) : (query || '');

      const response = await fetch('https://api.deepseek.com/v1/tools/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          query: cleanQuery,
          count: 8
        })
      });

      if (!response.ok) {
        throw new Error(`DeepSeek Search API responded with status ${response.status}`);
      }

      const data = await response.json();
      const results = data.results || [];
      if (!results.length) {
        return 'No search results found.';
      }

      const formattedResults = results
        .map((item, index) => {
          const title = item.title || 'Untitled';
          const url = item.url || 'No URL';
          const date = item.date ? ` (${item.date.split('T')[0]})` : '';
          const source = item.site_name ? ` [${item.site_name}]` : '';
          const content = item.summary || item.snippet || '';

          return `[Result ${index + 1}]${source}${date}
Title: ${title}
URL: ${url}
Content: ${content}`;
        })
        .join('\n\n');

      return `=== VERIFIED DEEPSEEK WEB SEARCH RESULTS ===\n\n${formattedResults}`;
    } catch (error) {
      console.error('DeepSeek search provider error:', error);
      throw new Error(`DeepSeek search failed: ${error.message}`);
    }
  }
}

export function createDeepSeekSearchProvider() {
  return new DeepSeekSearchProvider();
}
