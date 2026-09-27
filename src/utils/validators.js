import { z } from 'zod'

export const signUpSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/^(?=.*[A-Za-z])(?=.*\d).+$/, 'Password must include a letter and a number'),
  fullName: z.string().trim().min(1, 'Full name is required').max(120),
})

export const signInSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
})

/**
 * Coerce any value to a finite number
 * Handles numeric strings, strips currency symbols ('$', '€', '£', '%', ','), and handles scientific notation
 */
function coerceToFiniteNumber(val) {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val;
  }
  if (typeof val === 'string') {
    // Strip common currency symbols, commas, and percentage signs
    const cleaned = val.replace(/[$€£¥₹%,\s]/g, '').trim();
    const parsed = parseFloat(cleaned);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0; // Fallback to 0 if completely non-numeric to prevent Canvas rendering crash
}

/**
 * Validate and sanitize chart data returned by an AI service
 * Ensures array lengths match, numbers are finite, and types are safe
 * @param {Object} chartResponse - The raw parsed JSON from AI
 * @returns {Object} - The sanitized chart response
 */
export function validateAndSanitizeChartData(chartResponse) {
  if (!chartResponse || typeof chartResponse !== 'object') {
    throw new Error('AI response is not a valid object');
  }

  // Ensure chartType exists
  if (!chartResponse.chartType || typeof chartResponse.chartType !== 'string') {
    chartResponse.chartType = 'bar';
  }

  // Resolve target data container (support both chartData and data)
  const dataContainer = chartResponse.chartData || chartResponse.data;
  if (!dataContainer || typeof dataContainer !== 'object') {
    throw new Error('AI response missing chart data container');
  }

  // 1. Ensure labels is an array of strings
  let labels = Array.isArray(dataContainer.labels) ? dataContainer.labels : [];
  labels = labels.map(l => String(l ?? ''));
  if (labels.length === 0) {
    labels = ['Item 1'];
  }
  dataContainer.labels = labels;

  // 2. Ensure datasets is a non-empty array
  if (!Array.isArray(dataContainer.datasets) || dataContainer.datasets.length === 0) {
    dataContainer.datasets = [{
      label: chartResponse.title || 'Dataset 1',
      data: Array(labels.length).fill(0)
    }];
  }

  // 3. Sanitize each dataset
  dataContainer.datasets.forEach((ds, dsIndex) => {
    if (!ds || typeof ds !== 'object') {
      dataContainer.datasets[dsIndex] = { label: `Series ${dsIndex + 1}`, data: Array(labels.length).fill(0) };
      return;
    }

    if (!ds.label) {
      ds.label = `Series ${dsIndex + 1}`;
    }

    // Coerce data to finite numbers
    let rawData = Array.isArray(ds.data) ? ds.data : [];
    let numericData = rawData.map(v => coerceToFiniteNumber(v));

    // Pad or trim data array to match labels length
    if (numericData.length < labels.length) {
      while (numericData.length < labels.length) {
        numericData.push(0);
      }
    } else if (numericData.length > labels.length) {
      numericData = numericData.slice(0, labels.length);
    }
    ds.data = numericData;

    // Pad or trim colors if present
    if (Array.isArray(ds.backgroundColor) && ds.backgroundColor.length > 0) {
      const fallbackColor = ds.backgroundColor[0] || 'rgba(54, 162, 235, 0.7)';
      while (ds.backgroundColor.length < labels.length) {
        ds.backgroundColor.push(fallbackColor);
      }
      if (ds.backgroundColor.length > labels.length) {
        ds.backgroundColor = ds.backgroundColor.slice(0, labels.length);
      }
    }

    if (Array.isArray(ds.borderColor) && ds.borderColor.length > 0) {
      const fallbackBorder = ds.borderColor[0] || 'rgba(54, 162, 235, 1)';
      while (ds.borderColor.length < labels.length) {
        ds.borderColor.push(fallbackBorder);
      }
      if (ds.borderColor.length > labels.length) {
        ds.borderColor = ds.borderColor.slice(0, labels.length);
      }
    }
  });

  // Ensure both data and chartData point to the sanitized container for full compatibility
  chartResponse.data = dataContainer;
  chartResponse.chartData = dataContainer;

  // Sanitize and ensure formatContent resource bundle
  chartResponse.formatContent = sanitizeFormatContent(chartResponse.formatContent, chartResponse, dataContainer);

  return chartResponse;
}

/**
 * Sanitize and normalize formatContent resource bundle
 * Guarantees a valid, crash-proof tiered bundle for frontend layout engines
 */
function sanitizeFormatContent(rawBundle, chartResponse, dataContainer) {
  const fallbackTitle = chartResponse.title || 'Data Insights';
  const fallbackSubtitle = chartResponse.subtitle || 'Analysis Overview';
  const bundle = (rawBundle && typeof rawBundle === 'object') ? { ...rawBundle } : {};

  // 1. Titles
  const rawTitles = bundle.titles && typeof bundle.titles === 'object' ? bundle.titles : {};
  bundle.titles = {
    punchy: String(rawTitles.punchy || fallbackTitle).substring(0, 45),
    standard: String(rawTitles.standard || bundle.title || fallbackTitle).substring(0, 80),
    detailed: String(rawTitles.detailed || rawTitles.standard || fallbackTitle).substring(0, 130)
  };

  // 2. Subtitles
  const rawSubs = bundle.subtitles && typeof bundle.subtitles === 'object' ? bundle.subtitles : {};
  bundle.subtitles = {
    short: String(rawSubs.short || bundle.subtitle || fallbackSubtitle).substring(0, 70),
    detailed: String(rawSubs.detailed || rawSubs.short || fallbackSubtitle).substring(0, 150)
  };

  // 3. Narratives
  const rawNarratives = bundle.narratives && typeof bundle.narratives === 'object' ? bundle.narratives : {};
  const bulletPoints = Array.isArray(rawNarratives.bulletPoints) && rawNarratives.bulletPoints.length > 0
    ? rawNarratives.bulletPoints.map(b => String(b))
    : [`Key metric reported: ${dataContainer.labels[0] || 'Primary'}`, `Secondary comparison across categories`];

  bundle.narratives = {
    summary: String(rawNarratives.summary || bundle.body || `Overview of ${fallbackTitle} showing key variations across categories.`),
    editorial: String(rawNarratives.editorial || bundle.body || rawNarratives.summary || `The distribution demonstrates significant trends across ${dataContainer.labels.length} categories, highlighting core drivers and comparative metrics.`),
    bulletPoints: bulletPoints
  };

  // 4. Stats
  let stats = Array.isArray(bundle.stats) ? bundle.stats : [];
  stats = stats
    .filter(s => s && typeof s === 'object')
    .map((s, idx) => ({
      value: String(s.value ?? ''),
      label: String(s.label ?? `Metric ${idx + 1}`),
      trend: ['up', 'down', 'flat'].includes(s.trend) ? s.trend : 'flat',
      priority: typeof s.priority === 'number' ? s.priority : idx + 1
    }));

  if (stats.length === 0) {
    const firstDs = dataContainer.datasets[0];
    const dataArr = firstDs?.data || [];
    if (dataArr.length > 0) {
      const maxVal = Math.max(...dataArr);
      const maxIdx = dataArr.indexOf(maxVal);
      stats.push({
        value: String(maxVal),
        label: dataContainer.labels[maxIdx] || 'Top Value',
        trend: 'up',
        priority: 1
      });
    }
  }
  bundle.stats = stats;

  // 5. Callouts
  const rawCallouts = bundle.callouts && typeof bundle.callouts === 'object' ? bundle.callouts : {};
  bundle.callouts = {
    keyInsight: String(rawCallouts.keyInsight || bundle.callout || 'Notable variation observed across primary indicators.'),
    takeaway: String(rawCallouts.takeaway || 'Strategic focus recommended for high-performing segments.')
  };

  // 6. Source & Visual Keywords
  bundle.source = String(bundle.source || chartResponse.grounding?.sources?.[0] || 'Verified Data Report');
  bundle.visualKeywords = Array.isArray(bundle.visualKeywords)
    ? bundle.visualKeywords.map(k => String(k))
    : Array.isArray(bundle.keywords) ? bundle.keywords.map(k => String(k)) : [fallbackTitle];

  // 7. Backward compatibility fields
  bundle.title = bundle.titles.standard;
  bundle.subtitle = bundle.subtitles.short;
  bundle.body = bundle.narratives.editorial || bundle.narratives.summary;
  bundle.callout = bundle.callouts.keyInsight;

  return bundle;
}


