import { GoogleGenerativeAI } from '@google/generative-ai';

const MODEL_MAP = {
    // Perplexity names → Gemini equivalents
    'sonar-pro': 'gemini-2.5-pro',
    'sonar-medium': 'gemini-2.5-flash',
    'sonar': 'gemini-2.5-flash',
    'mistral-7b': 'gemini-2.5-flash',
    'codellama-34b': 'gemini-2.5-pro',
    'llama-2-70b': 'gemini-2.5-pro',
    // Intent-based names
    'modification': 'gemini-2.5-pro',
};

const DEFAULT_MODEL = 'gemini-2.5-flash';

/**
 * Gemini Adapter
 * Dedicated adapter that uses GEMINI_API_KEY.
 * Accepts any model name (including Perplexity names) and maps them to valid Gemini models.
 */
export class GeminiAdapter {
    constructor() {
        this.serviceName = 'gemini';
        this.hasNativeSearch = true;
        this._genAI = null; // lazy-initialized on first use
    }

    // Lazy getter — defers instantiation until env vars are loaded
    get genAI() {
        if (!this._genAI) {
            this._genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        }
        return this._genAI;
    }

    async generateContent({ systemPrompt, userPrompt, model, webSearch }) {
        const modelName = MODEL_MAP[model] ?? model ?? DEFAULT_MODEL;

        if (webSearch) {
            // Directly call the REST API to ensure google_search tool works since local SDK version is outdated
            const apiKey = process.env.GEMINI_API_KEY;
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
            
            const payload = {
                contents: [{
                    parts: [{ text: userPrompt }]
                }],
                tools: [{ google_search: {} }]
            };

            if (systemPrompt) {
                payload.systemInstruction = {
                    parts: [{ text: systemPrompt }]
                };
            }

            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 60000);

                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    let errorMessage = `Gemini API returned error ${response.status}`;
                    try {
                        const errJson = await response.json();
                        if (errJson.error && errJson.error.message) {
                            errorMessage = errJson.error.message;
                        }
                    } catch {
                        try {
                            const errText = await response.text();
                            if (errText) errorMessage = errText;
                        } catch {}
                    }
                    throw new Error(errorMessage);
                }

                const result = await response.json();
                const content = result.candidates?.[0]?.content?.parts?.[0]?.text;

                if (!content?.trim()) {
                    throw new Error('Empty response from Gemini AI search grounding service');
                }

                return {
                    content,
                    tokensUsed: result.usageMetadata ? (result.usageMetadata.promptTokenCount || 0) + (result.usageMetadata.candidatesTokenCount || 0) : null,
                    rawResponse: result,
                };
            } catch (error) {
                throw this.handleApiError(error);
            }
        }

        // Standard SDK call for non-search queries
        const genModel = this.genAI.getGenerativeModel({ model: modelName });
        const combinedPrompt = systemPrompt
            ? `${systemPrompt}\n\nUser request: ${userPrompt}`
            : userPrompt;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 60000);

            try {
                const result = await genModel.generateContent(combinedPrompt, {
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                const response = await result.response;
                const content = response.text();

                if (!content?.trim()) {
                    throw new Error('Empty response from Gemini AI service');
                }

                return {
                    content,
                    tokensUsed: this._extractTokenUsage(result),
                    rawResponse: result,
                };
            } catch (innerError) {
                clearTimeout(timeoutId);
                throw innerError;
            }
        } catch (error) {
            throw this.handleApiError(error);
        }
    }

    handleApiError(error) {
        if (error.name === 'AbortError') {
            return new Error('Gemini API request timed out after 60 seconds.');
        }
        const msg = error.message || '';
        if (error.status === 401 || msg.includes('API key') || msg.includes('API_KEY_INVALID')) {
            return new Error('Invalid Gemini API key');
        }
        if (error.status === 429 || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('credits are depleted') || msg.includes('rate limit')) {
            return new Error('Gemini API rate limit or credit quota exceeded. Please check your billing/credits.');
        }
        if (error.status >= 500 || msg.includes('server error')) {
            return new Error('Gemini API server error. Please try again later.');
        }
        if (msg.includes('SAFETY')) {
            return new Error('Gemini blocked the request due to safety concerns.');
        }
        return error;
    }

    async validateApiKey() {
        try {
            if (!process.env.GEMINI_API_KEY) return false;
            const model = this.genAI.getGenerativeModel({ model: DEFAULT_MODEL });
            const result = await model.generateContent('Test connection');
            return !!result.response.text();
        } catch {
            return false;
        }
    }

    getAvailableModels() {
        return [
            { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Fast — best for new charts', cost_tier: 'standard' },
            { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Most capable — best for modifications', cost_tier: 'premium' },
            { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', description: 'Balanced speed and quality', cost_tier: 'standard' },
        ];
    }

    getAdditionalMetadata(response, model) {
        return { model_used: MODEL_MAP[model] ?? model ?? DEFAULT_MODEL };
    }

    enhanceError(error) {
        return new Error(`Gemini API error: ${error.message}`);
    }

    _extractTokenUsage(result) {
        try {
            const u = result.response?.usageMetadata;
            return u ? (u.promptTokenCount || 0) + (u.candidatesTokenCount || 0) : null;
        } catch {
            return null;
        }
    }
}

export function createGeminiAdapter() {
    return new GeminiAdapter();
}
