import { GoogleGenerativeAI } from '@google/generative-ai';
import { OpenAI } from 'openai';
import { createTavilyProvider } from './tavilyProvider.js';
import { createBraveProvider } from './braveProvider.js';

// Provider Registry
const PROVIDERS = {
  tavily: createTavilyProvider,
  brave: createBraveProvider,
  // Future providers like exa can be mapped here:
  // exa: createExaProvider
};

class SearchService {
  constructor() {
    this._activeProvider = null;
    this._genAI = null;
    this._openai = null;
  }

  get activeProvider() {
    if (!this._activeProvider) {
      const providerName = process.env.SEARCH_PROVIDER || 'tavily';
      const creator = PROVIDERS[providerName];
      if (!creator) {
        throw new Error(`Unknown search provider: ${providerName}`);
      }
      this._activeProvider = creator();
    }
    return this._activeProvider;
  }

  get genAI() {
    if (!this._genAI && process.env.GEMINI_API_KEY) {
      this._genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    }
    return this._genAI;
  }

  get openai() {
    if (!this._openai && process.env.DEEPSEEK_API_KEY) {
      this._openai = new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: 'https://api.deepseek.com/v1'
      });
    }
    return this._openai;
  }

  async search(query) {
    console.log(`🔍 Web search query via ${this.activeProvider.name}: "${query}"`);
    return await this.activeProvider.search(query);
  }

  /**
   * Search using a specific provider by name (overrides the default)
   * @param {string} query - The search query string
   * @param {string} providerName - Provider key ('tavily' | 'brave')
   * @returns {Promise<string>} - Formatted search results
   */
  async searchWithProvider(query, providerName) {
    const creator = PROVIDERS[providerName];
    if (!creator) {
      console.warn(`⚠️ Unknown search provider '${providerName}', falling back to default`);
      return this.search(query);
    }
    const provider = creator();
    console.log(`🔍 Web search query via ${provider.name}: "${query}"`);
    return await provider.search(query);
  }

  /**
   * Evaluates if a search is needed, and returns either a search query or "NO_SEARCH"
   * @param {string} serviceName - The service being used ('deepseek' or 'gemini')
   * @returns {Promise<string>} - The search query or "NO_SEARCH"
   */
  async determineSearchQuery(inputText, messageHistory = [], serviceName = 'deepseek') {
    const currentYear = new Date().getFullYear();
    const systemPrompt = `You are a search query optimizer for a chart generation AI. The current year is ${currentYear}. Your task is to analyze the user request and recent history, then decide if we need to search the web for new factual data, statistics, or real-world information.

Rules:
1. If the request is purely visual, formatting-related, or structural (e.g., changing colors, changing chart type like bar to pie, sorting data, updating text titles, styling, or requesting simple explanations of existing data), output exactly: NO_SEARCH
2. If the request requires looking up facts, figures, rankings, stock prices, or statistics from the web, output ONLY the search keywords (no punctuation, no explanation, no quotes).
   DEFAULT TO LATEST: Users naturally expect the freshest, most current data as of today. Unless the user explicitly asked for a past historical year (e.g. "in 2020"), ALWAYS include specific entity names, metrics, and "${currentYear} latest" or "real time" to retrieve current figures.
3. If the user explicitly requests images, photos, logos, or flags of specific entities, ensure the generated search query includes the names of the entities followed by "official photo" or "logo" or "flag" (e.g. "Virat Kohli official photo") to help the search provider locate valid image URLs.

Examples:
- Request: "Make the bars blue" -> NO_SEARCH
- Request: "Change the chart to a line chart" -> NO_SEARCH
- Request: "Top 5 billionaires" -> top 5 billionaires net worth ${currentYear} latest real time
- Request: "Top tech companies by market cap" -> top tech companies market cap ${currentYear} latest
- Request: "Add GDP of Germany" -> Germany GDP ${currentYear} latest
- Request: "Compare revenue of Apple and Microsoft in 2021" -> Apple Microsoft revenue 2021
- Request: "Compare revenue of Apple and Microsoft" -> Apple Microsoft revenue ${currentYear} latest
- Request: "Sort the data ascending" -> NO_SEARCH
- Request: "Show Virat Kohli, Steve Smith, Joe Root with pictures" -> Virat Kohli Steve Smith Joe Root official photo`;

    const recentHistoryText = messageHistory.slice(-3).map(m => `${m.role}: ${m.content}`).join('\n');
    const userContent = `CONVERSATION HISTORY:\n${recentHistoryText}\n\nUSER REQUEST: ${inputText}\n\nDecision:`;

    // 1. Try to use DeepSeek if requested and available
    if (serviceName === 'deepseek' && process.env.DEEPSEEK_API_KEY) {
      try {
        const response = await this.openai.chat.completions.create({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
          ],
          max_tokens: 60,
          temperature: 0.1
        }, {
          signal: AbortSignal.timeout(10000)
        });
        const decision = response.choices[0]?.message?.content?.trim();
        if (decision) {
          console.log(`🤖 Search Query Generator (DeepSeek) Decision: "${decision}"`);
          return decision;
        }
      } catch (error) {
        console.error('Error in DeepSeek search query determination:', error);
      }
    }

    // 2. Fallback to Gemini if available
    if (process.env.GEMINI_API_KEY) {
      try {
        const model = this.genAI.getGenerativeModel({ model: 'gemini-3.5-flash-lite' });
        const result = await model.generateContent(`${systemPrompt}\n\n${userContent}`);
        const decision = result.response.text().trim();
        console.log(`🤖 Search Query Generator (Gemini) Decision: "${decision}"`);
        return decision;
      } catch (error) {
        console.error('Error in Gemini search query determination:', error);
      }
    }

    console.warn('⚠️ No active API key found for search query generator. Defaulting to direct search.');
    return inputText;
  }
}

export const searchService = new SearchService();
