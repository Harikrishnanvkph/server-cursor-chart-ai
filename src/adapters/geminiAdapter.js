import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

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
        this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    }

    async generateContent({ systemPrompt, userPrompt, model }) {
        const modelName = MODEL_MAP[model] ?? model ?? DEFAULT_MODEL;
        const genModel = this.genAI.getGenerativeModel({ model: modelName });

        const combinedPrompt = systemPrompt
            ? `${systemPrompt}\n\nUser request: ${userPrompt}`
            : userPrompt;

        try {
            const result = await genModel.generateContent(combinedPrompt);
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
        } catch (error) {
            if (error.status === 401 || error.message?.includes('API key')) {
                throw new Error('Invalid Gemini API key');
            } else if (error.status === 429) {
                throw new Error('Gemini API rate limit exceeded. Please try again in a moment.');
            } else if (error.status >= 500) {
                throw new Error('Gemini API server error. Please try again later.');
            } else if (error.message?.includes('SAFETY')) {
                throw new Error('Gemini blocked the request due to safety concerns.');
            }
            throw error;
        }
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
