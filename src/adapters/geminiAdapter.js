import { GoogleGenerativeAI } from '@google/generative-ai';

const MODEL_MAP = {
    // Perplexity names → Gemini equivalents
    'sonar-pro': 'gemini-3.1-pro',
    'sonar-medium': 'gemini-3.5-flash-lite',
    'sonar': 'gemini-3.5-flash-lite',
    'mistral-7b': 'gemini-3.5-flash-lite',
    'codellama-34b': 'gemini-3.1-pro',
    'llama-2-70b': 'gemini-3.1-pro',
    // Intent-based names
    'modification': 'gemini-3.1-pro',
    // Legacy model redirects
    'gemini-2.5-flash': 'gemini-3.5-flash-lite',
    'gemini-2.5-pro': 'gemini-3.1-pro',
    'gemini-2.0-flash': 'gemini-3.5-flash-lite',
};

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

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

    async generateContent({ systemPrompt, userPrompt, model, webSearch, maxTokens }) {
        const modelName = MODEL_MAP[model] ?? model ?? DEFAULT_MODEL;

        if (webSearch) {
            // Directly call the REST API to ensure google_search tool works since local SDK version is outdated
            const apiKey = process.env.GEMINI_API_KEY;
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
            
            const promptWithJsonDirective = `${userPrompt}\n\nCRITICAL: Your response must be ONLY a valid JSON object wrapped in \`\`\`json ... \`\`\` markdown code block. Do NOT include any commentary outside the code block.`;
            
            const payload = {
                contents: [{
                    parts: [{ text: promptWithJsonDirective }]
                }],
                tools: [{ google_search: {} }],
                generationConfig: {
                    maxOutputTokens: maxTokens || 8192,
                    temperature: 0.2
                }
                // Note: responseMimeType: 'application/json' is intentionally omitted because Gemini API rejects search grounding tool when responseMimeType is set.
            };

            if (systemPrompt) {
                payload.systemInstruction = {
                    parts: [{ text: systemPrompt }]
                };
            }

            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 120000); // 120s timeout for large format generations

                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-goog-api-key': apiKey
                    },
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
                const candidate = result.candidates?.[0];
                const content = (candidate?.content?.parts || [])
                    .map(p => p.text || '')
                    .filter(Boolean)
                    .join('\n');

                if (!content?.trim()) {
                    throw new Error('Empty response from Gemini AI search grounding service');
                }

                const u = result.usageMetadata;
                const usage = u ? { sent: u.promptTokenCount || 0, received: u.candidatesTokenCount || 0, total: u.totalTokenCount || 0 } : null;

                return {
                    content,
                    tokensUsed: usage?.total || null,
                    usage,
                    rawResponse: result,
                    groundingMetadata: candidate?.groundingMetadata || null
                };
            } catch (error) {
                throw this.handleApiError(error);
            }
        }

        // Standard SDK call for non-search queries with JSON mode
        const genModel = this.genAI.getGenerativeModel({
            model: modelName,
            generationConfig: {
                responseMimeType: 'application/json',
                maxOutputTokens: maxTokens || 8192,
                temperature: 0.2
            }
        });
        const combinedPrompt = systemPrompt
            ? `${systemPrompt}\n\nUser request: ${userPrompt}`
            : userPrompt;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 120000); // 120s timeout for large format generations

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

                const u = result.response?.usageMetadata;
                const usage = u ? { sent: u.promptTokenCount || 0, received: u.candidatesTokenCount || 0, total: u.totalTokenCount || 0 } : null;

                return {
                    content,
                    tokensUsed: usage?.total || null,
                    usage,
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
            { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', description: 'Fast, low-cost & search grounded', cost_tier: 'standard' },
            { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', description: 'High capability workhorse', cost_tier: 'standard' },
            { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', description: 'Deep reasoning & complex modifications', cost_tier: 'premium' },
        ];
    }

    getAdditionalMetadata(response, model) {
        return { model_used: MODEL_MAP[model] ?? model ?? DEFAULT_MODEL };
    }

    enhanceError(error) {
        return new Error(`Gemini API error: ${error.message}`);
    }
}

export function createGeminiAdapter() {
    return new GeminiAdapter();
}
