# Chart Generator Server

This is the backend server for the Chart Generator application. It processes text input and generates structured chart data using Google's Gemini AI model.

Auth additions:
- Supabase-backed auth routes at `/auth/*`
- HTTP-only cookies for session tokens (SameSite=Lax)
- Helmet, CORS, cookie-parser, rate limiting on auth

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory with the following variables:
```
PORT=3001
GEMINI_API_KEY=your_google_gemini_api_key_here
PERPLEXITY_API_KEY=your_perplexity_api_key_here    # Optional: For Perplexity AI support
OPENROUTER_API_KEY=your_openrouter_api_key_here    # Optional: For OpenRouter AI support
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
APP_ORIGIN=http://localhost:3000
SERVER_PUBLIC_URL=http://localhost:3001
```

3. Start the server:
```bash
# Development mode with auto-reload
npm run dev

# Production mode
npm start
```

## API Endpoints

### POST /api/process-chart

Processes text input and returns chart data.

**Request Body:**
```json
{
  "input": "Create a bar chart comparing the top 5 countries by smartphone usage in 2025"
}
```

**Response:**
```json
{
  "chartType": "bar",
  "data": {
    "labels": ["China", "India", "United States", "Indonesia", "Brazil"],
    "datasets": [{
      "label": "Smartphone Users (millions)",
      "data": [850, 750, 300, 250, 200],
      "backgroundColor": ["#FF6384", "#36A2EB", "#FFCE56", "#4BC0C0", "#9966FF"],
      "borderColor": ["#FF6384", "#36A2EB", "#FFCE56", "#4BC0C0", "#9966FF"]
    }]
  },
  "options": {
    "responsive": true,
    "plugins": {
      "title": {
        "display": true,
        "text": "Top 5 Countries by Smartphone Usage (2025)"
      }
    }
  }
}
```

## Supported Chart Types

- Bar
- Line
- Pie
- Doughnut
- Scatter
- Bubble

## Error Handling

The server returns appropriate HTTP status codes and error messages:

- 400: Bad Request (missing or invalid input)
- 500: Internal Server Error (processing error)

## Health Check

You can check if the server is running by making a GET request to:
```
GET http://localhost:3001/health
```

Response:
```json
{
  "status": "ok",
  "timestamp": "2024-03-14T12:00:00.000Z"
}
``` 