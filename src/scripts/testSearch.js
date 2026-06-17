import '../env.js';
import { searchService } from '../search/searchService.js';

async function runTests() {
  console.log('🚀 Starting Search Integration Tests...\n');

  // Test Case 1: Pure Styling (should result in NO_SEARCH)
  console.log('--- Test Case 1: Pure Styling/Visual request ---');
  const request1 = 'Change the chart to a pie chart and make the colors green';
  console.log(`Prompt: "${request1}"`);
  try {
    const decision1 = await searchService.determineSearchQuery(request1, []);
    console.log(`Result: ${decision1}`);
    if (decision1 === 'NO_SEARCH') {
      console.log('✅ PASS: Correctly identified visual change and bypassed search.\n');
    } else {
      console.log('❌ FAIL: Expected NO_SEARCH but got something else.\n');
    }
  } catch (error) {
    console.error('Test Case 1 failed with error:', error);
  }

  // Test Case 2: Fact/Data Request (should generate a query)
  console.log('--- Test Case 2: Fact/Data request ---');
  const request2 = 'Add GDP of France in 2025 and 2026';
  console.log(`Prompt: "${request2}"`);
  let decision2 = '';
  try {
    decision2 = await searchService.determineSearchQuery(request2, []);
    console.log(`Result query: "${decision2}"`);
    if (decision2 !== 'NO_SEARCH') {
      console.log('✅ PASS: Correctly identified need for search and generated search keywords.\n');
    } else {
      console.log('❌ FAIL: Expected a search query but got NO_SEARCH.\n');
    }
  } catch (error) {
    console.error('Test Case 2 failed with error:', error);
  }

  // Test Case 3: Executing Search using Tavily
  if (decision2 && decision2 !== 'NO_SEARCH') {
    console.log('--- Test Case 3: Executing Tavily Search ---');
    console.log(`Searching for: "${decision2}"`);
    try {
      const results = await searchService.search(decision2);
      console.log('Formatted Results Output:');
      console.log('--------------------------------------------------');
      console.log(results);
      console.log('--------------------------------------------------');
      if (results && results.includes('[Result 1]')) {
        console.log('✅ PASS: Tavily search returned formatted results correctly.\n');
      } else {
        console.log('❌ FAIL: Tavily search output format unexpected.\n');
      }
    } catch (error) {
      console.error('Test Case 3 failed with error:', error);
    }
  }

  console.log('🎉 Tests completed.');
}

runTests();
