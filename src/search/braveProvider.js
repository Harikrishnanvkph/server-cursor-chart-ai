/**
 * Brave Search Provider
 * Calls the Brave Web Search API and returns formatted results
 * matching the same interface as TavilyProvider
 */
export class BraveProvider {
  constructor() {
    this.name = 'brave';
  }

  /**
   * Perform search
   * @param {string} query - The search query string
   * @returns {Promise<string>} - Formatted search results
   */
  async search(query) {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      throw new Error('Brave Search API key is not configured. Set BRAVE_SEARCH_API_KEY in .env');
    }

    try {
      const params = new URLSearchParams({
        q: query,
        count: '8',
        text_decorations: 'false',
        search_lang: 'en',
        extra_snippets: 'true'
      });

      const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey
        }
      });

      if (!response.ok) {
        throw new Error(`Brave Search API responded with status ${response.status}`);
      }

      const data = await response.json();

      const webResults = data.web?.results || [];
      const infobox = data.infobox;

      if (webResults.length === 0 && !infobox) {
        return 'No search results found.';
      }

      // Build an answer summary from the infobox if available (similar to Tavily's answer)
      let answerSection = '';
      if (infobox) {
        const infoDesc = infobox.long_desc || infobox.description || '';
        if (infoDesc) {
          answerSection = `=== VERIFIED SEARCH RESEARCH SUMMARY ===\n${infoDesc}\n========================================\n\n`;
        }
      }

      // Also check for FAQ results — these often contain concise factual answers
      const faqResults = data.faq?.results || [];
      if (faqResults.length > 0) {
        const faqSection = faqResults
          .slice(0, 3)
          .map(faq => `Q: ${faq.question}\nA: ${faq.answer}`)
          .join('\n\n');
        if (!answerSection) {
          answerSection = `=== SEARCH FAQ DATA ===\n${faqSection}\n========================\n\n`;
        } else {
          answerSection += `\n=== SEARCH FAQ DATA ===\n${faqSection}\n========================\n\n`;
        }
      }

      // Format web results — include extra_snippets for richer content
      const formattedResults = webResults
        .map((result, index) => {
          const title = result.title || 'Untitled';
          const url = result.url || 'No URL';
          const description = result.description || '';

          // extra_snippets contain the actual page content with real data (numbers, tables, facts)
          // This is critical — without these, the LLM only sees short meta descriptions
          const extraSnippets = result.extra_snippets || [];
          const allContent = [description, ...extraSnippets].filter(Boolean).join('\n');

          return `[Result ${index + 1}]
Title: ${title}
URL: ${url}
Content: ${allContent}`;
        })
        .join('\n\n');

      // Collect image results if available
      let imageSection = '';
      const imageResults = data.images?.results || [];
      if (imageResults.length > 0) {
        imageSection = '\n\n[Search Results Image Links (Direct Image URLs)]\n' +
          imageResults.slice(0, 6).map(img => `- ${img.thumbnail?.src || img.url || ''}`).join('\n');
      }

      return answerSection + formattedResults + imageSection;
    } catch (error) {
      console.error('Brave search provider error:', error);
      throw new Error(`Brave search failed: ${error.message}`);
    }
  }
}

export function createBraveProvider() {
  return new BraveProvider();
}
