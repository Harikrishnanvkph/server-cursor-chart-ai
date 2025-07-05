import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from 'node:fs/promises'

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Initialize Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// In-memory conversation store (in production, use a database)
const conversationStore = new Map();

app.use(cors());
app.use(express.json());

// Helper function to generate chart data using Gemini
async function generateChartData(inputText) {
  try {
    // Get the generative model
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const text = await fs.readFile('./src/AI_Inform.txt', 'utf-8');

    const prompt = `${text} and User request: ${inputText}`;
    console.log(inputText)
    console.log(prompt)

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let responseText = response.text()
   
    // Clean the response text - remove markdown code blocks if present
    responseText = responseText.trim();
    
    // Remove ```json and ``` if they exist
    if (responseText.startsWith('```json')) {
      responseText = responseText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (responseText.startsWith('```')) {
      responseText = responseText.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    
    // Additional cleanup - remove any remaining backticks at start/end
    responseText = responseText.replace(/^`+|`+$/g, '').trim()
   
    // Parse the cleaned response text as JSON
    const chartData = JSON.parse(responseText);
    return chartData;
  } catch (error) {
    console.error('Error generating chart data:', error);
    throw error;
  }
}

// Helper function to modify existing chart
async function modifyChartData(inputText, currentChartState, messageHistory) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    
    const modificationInstructions = await fs.readFile('./src/AI_Modification_Inform.txt', 'utf-8');
    
    const contextPrompt = `
${modificationInstructions}

Current Chart State:
- Chart Type: ${currentChartState.chartType}
- Current Data: ${JSON.stringify(currentChartState.chartData, null, 2)}
- Current Config: ${JSON.stringify(currentChartState.chartConfig, null, 2)}

Recent conversation context (last 3 messages):
${messageHistory.slice(-3).map(msg => `${msg.role}: ${msg.content}`).join('\n')}

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
  "changes": ["list of specific changes made"]
}
`;

    // console.log('Modification prompt:', contextPrompt);

    const result = await model.generateContent(contextPrompt);
    const response = await result.response;
    let responseText = response.text().trim();
    
    // Clean the response text
    if (responseText.startsWith('```json')) {
      responseText = responseText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (responseText.startsWith('```')) {
      responseText = responseText.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    responseText = responseText.replace(/^`+|`+$/g, '').trim();
    
    const chartData = JSON.parse(responseText);
    return chartData;
  } catch (error) {
    console.error('Error modifying chart data:', error);
    throw error;
  }
}

// Endpoint to process chart request (new or modification)
app.post('/api/process-chart', async (req, res) => {
  try {
    const { input, conversationId, currentChartState, messageHistory } = req.body;
    
    if (!input) {
      return res.status(400).json({ error: 'Input text is required' });
    }

    let aiResponse;
    
    // Determine if this is a modification or new chart
    if (currentChartState && conversationId) {
      // console.log('Processing chart modification for conversation:', conversationId);
      aiResponse = await modifyChartData(input, currentChartState, messageHistory || []);
    } else {
      console.log('Processing new chart creation');
      aiResponse = await generateChartData(input);
    }

    // console.log('AI Response:', aiResponse);
    
    // Compose the correct format for the frontend
    const result = {
      chartType: aiResponse.chartType,
      chartData: aiResponse.chartData || aiResponse.data,
      chartConfig: aiResponse.chartConfig || aiResponse.options,
      user_message: aiResponse.user_message,
      action: aiResponse.action || 'create',
      changes: aiResponse.changes || [],
      suggestions: aiResponse.suggestions || []
    };
    
    res.json(result);
  } catch (error) {
    console.error('Error processing chart request:', error);
    res.status(500).json({ 
      error: 'Failed to process chart request',
      details: error.message 
    });
  }
});

// Endpoint to get conversation history
app.get('/api/conversation/:id', (req, res) => {
  const { id } = req.params;
  const conversation = conversationStore.get(id);
  
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  
  res.json(conversation);
});

// Endpoint to delete conversation
app.delete('/api/conversation/:id', (req, res) => {
  const { id } = req.params;
  const deleted = conversationStore.delete(id);
  
  if (!deleted) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  
  res.json({ message: 'Conversation deleted successfully' });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
}); 