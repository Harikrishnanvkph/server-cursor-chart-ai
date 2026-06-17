import '../env.js';
import { generateChartDataWithDeepSeek } from '../services/deepseekService.js';

async function runDeepseekTest() {
  console.log('🤖 Starting DeepSeek + Tavily Search Grounding Test...\n');

  const prompt = 'Create a bar chart of the top 3 French companies by revenue in 2025';
  console.log(`Prompt: "${prompt}"`);
  console.log('Sending request to DeepSeek Service with webSearch = true...\n');

  try {
    const result = await generateChartDataWithDeepSeek(prompt, 'deepseek-chat', null, null, true);
    
    console.log('🎉 API Request Successful!');
    console.log('================= RESULT =================');
    console.log(JSON.stringify(result, null, 2));
    console.log('==========================================\n');
    
    if (result && (result.chartData || result.data)) {
      console.log('✅ PASS: Successfully generated chart with datasets and labels.');
      console.log(`Service used: ${result._metadata?.service}`);
      console.log(`Model used: ${result._metadata?.model_used}`);
      console.log(`Tokens used: ${result._metadata?.tokens_used}`);
    } else {
      console.log('❌ FAIL: Result format is missing chartData.');
    }
  } catch (error) {
    console.error('❌ Test failed with error:', error);
  }
}

runDeepseekTest();
