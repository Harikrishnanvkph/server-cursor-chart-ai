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

  return chartResponse;
}


