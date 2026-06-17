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
  async search(query) {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      throw new Error('Tavily API key is not configured. Set TAVILY_API_KEY in .env');
    }

    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          api_key: apiKey,
          query: query,
          max_results: 5,
          search_depth: 'basic',
          include_answer: false
        })
      });

      if (!response.ok) {
        throw new Error(`Tavily API responded with status ${response.status}`);
      }

      const data = await response.json();
      
      if (!data.results || data.results.length === 0) {
        return 'No search results found.';
      }

      // Format results into a clear, concise text block for the LLM
      const formattedResults = data.results
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

      return formattedResults;
    } catch (error) {
      console.error('Tavily search provider error:', error);
      throw new Error(`Tavily search failed: ${error.message}`);
    }
  }
}

export function createTavilyProvider() {
  return new TavilyProvider();
}
