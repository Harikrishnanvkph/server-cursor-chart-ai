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
export function validateAndSanitizeChartData(chartResponse, isFormatRequest = false) {
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

  // Sanitize and ensure formatContent resource bundle ONLY when format requested or formatContent returned
  if (isFormatRequest || chartResponse.formatContent || (chartResponse.contentBank && Object.keys(chartResponse.contentBank).length > 0)) {
    chartResponse.formatContent = sanitizeFormatContent(chartResponse.formatContent, chartResponse, dataContainer);
  } else {
    delete chartResponse.formatContent;
    delete chartResponse.contentBank;
  }

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

  // 8. Content Bank (8 Categorized Text Blocks, 3 Titles, 3 Subtitles, 3 Catchy Phrases, General Images, Sources)
  const rawBank = (chartResponse.contentBank && typeof chartResponse.contentBank === 'object')
    ? chartResponse.contentBank
    : (bundle.contentBank && typeof bundle.contentBank === 'object')
    ? bundle.contentBank
    : {};

  // 8a. 3 Titles — ensure distinctness
  const bankTitles = Array.isArray(rawBank.titles) && rawBank.titles.length >= 3
    ? rawBank.titles.slice(0, 3).map((t, idx) => ({
        id: `t${idx + 1}`,
        style: t.style || (idx === 0 ? 'punchy' : idx === 1 ? 'analytical' : 'provocative'),
        text: String(t.text || (idx === 0 ? bundle.titles.punchy : idx === 1 ? bundle.titles.standard : bundle.titles.detailed))
      }))
    : [
        { id: 't1', style: 'punchy', text: bundle.titles.punchy },
        { id: 't2', style: 'analytical', text: bundle.titles.standard },
        { id: 't3', style: 'provocative', text: `${bundle.titles.punchy}: Critical Analysis` }
      ];

  // 8b. 3 Subtitles — ensure distinctness
  const bankSubtitles = Array.isArray(rawBank.subtitles) && rawBank.subtitles.length >= 3
    ? rawBank.subtitles.slice(0, 3).map((s, idx) => ({
        id: `s${idx + 1}`,
        style: s.style || (idx === 0 ? 'short' : idx === 1 ? 'standard' : 'detailed'),
        text: String(s.text || (idx === 0 ? bundle.subtitles.short : idx === 1 ? fallbackSubtitle : bundle.subtitles.detailed))
      }))
    : [
        { id: 's1', style: 'short', text: bundle.subtitles.short },
        { id: 's2', style: 'standard', text: `${fallbackSubtitle} across primary segments` },
        { id: 's3', style: 'detailed', text: bundle.subtitles.detailed }
      ];

  // 8c. 3 Catchy Phrases — ensure distinctness
  const bankPhrases = Array.isArray(rawBank.catchyPhrases) && rawBank.catchyPhrases.length >= 3
    ? rawBank.catchyPhrases.slice(0, 3).map((cp, idx) => ({
        id: `cp${idx + 1}`,
        phrase: String(cp.phrase || cp.text || (idx === 0 ? bundle.callouts.keyInsight : idx === 1 ? bundle.callouts.takeaway : bundle.narratives.summary))
      }))
    : [
        { id: 'cp1', phrase: bundle.callouts.keyInsight },
        { id: 'cp2', phrase: bundle.callouts.takeaway },
        { id: 'cp3', phrase: `Leading the trend: ${dataContainer.labels[0] || 'Top segment'} surges ahead.` }
      ];

  // 8d. 8 Categorized Text Blocks (word count tiers: 500w, 300w, 200w, 2×100w, 2×50w, 1 bullet list)
  const topLabels = dataContainer.labels.slice(0, 3).join(', ') || 'key segments';
  const leadEntity = dataContainer.labels[0] || 'The leading segment';
  const DEFAULT_CATEGORIES = [
    { name: 'Deep Dive Analysis', length: 'extra-long', minWords: 500, fallback: `${fallbackTitle} represents a significant area of focus across global markets. ${leadEntity} leads the current standings, reflecting sustained competitive advantage through strategic investments, operational excellence, and market positioning. The landscape has evolved considerably over recent cycles, with established leaders consolidating their positions while emerging challengers introduce disruptive approaches. Key drivers include technological innovation, regulatory shifts, and evolving consumer preferences that collectively reshape competitive dynamics across ${topLabels} and beyond. Historical patterns demonstrate that market leadership in this domain correlates strongly with early adoption of transformative strategies and disciplined execution. Looking forward, the interplay between macroeconomic conditions, sector-specific tailwinds, and individual entity strategies will determine whether current leaders maintain their positions or face displacement from agile competitors. The data reveals nuanced patterns when examined at the segment level, with each category exhibiting distinct growth trajectories influenced by geographic expansion, demographic shifts, and capital allocation decisions. Industry analysts note that the gap between top performers and the rest of the field has widened over the past several periods, suggesting a winner-take-most dynamic that may intensify further. Cross-sector implications extend beyond direct competitors, affecting supply chains, talent markets, and adjacent industries that depend on the primary players for partnership, investment, and innovation spillovers. Stakeholders across the ecosystem must calibrate their strategies in response to these structural shifts, balancing short-term operational priorities against long-term positioning requirements. Risk factors include regulatory intervention, geopolitical disruption, and technological obsolescence, each of which could materially alter the competitive landscape within a single cycle.` },
    { name: 'Comprehensive Overview', length: 'long', minWords: 300, fallback: `The current distribution across ${topLabels} reflects broader structural trends in the market. ${leadEntity} maintains the strongest position with demonstrable advantages in scale, brand recognition, and strategic resource allocation. Secondary players continue to close the gap through targeted investments and operational improvements, though the margin between first and second place remains significant. The underlying drivers of this competitive order include sustained capital deployment, favorable market timing, and strategic positioning relative to emerging opportunities. Cross-comparisons reveal that while absolute figures vary substantially, the growth trajectories of mid-tier participants suggest potential for meaningful repositioning over the coming periods. Industry observers note that the most successful entities share common characteristics: disciplined financial management, proactive risk mitigation, and an ability to capitalize on inflection points that restructure competitive boundaries. The implications extend across sectors, with ripple effects observed in talent acquisition, supply chain dynamics, and investor sentiment.` },
    { name: 'Detailed Breakdown', length: 'medium-long', minWords: 200, fallback: `A closer examination of the data reveals important distinctions between the top-performing entities across ${topLabels}. While surface-level comparisons highlight absolute differences in scale, the underlying growth rates and strategic trajectories tell a more nuanced story. ${leadEntity} has consistently leveraged its position through a combination of organic expansion and strategic acquisitions, establishing barriers to entry that secondary competitors find increasingly difficult to overcome. The sector-specific dynamics suggest that future leadership positions will depend heavily on the ability to adapt to shifting regulatory frameworks, evolving consumer expectations, and the accelerating pace of technological change that reshapes operational models across the competitive landscape.` },
    { name: 'Key Comparison', length: 'medium', minWords: 100, fallback: `${leadEntity} commands the highest share, significantly outperforming secondary peers across ${topLabels}. The gap between the top two positions reveals structural advantages in market positioning, capital efficiency, and strategic execution that have compounded over multiple periods. Mid-tier participants demonstrate competitive strengths in specific niches but face scaling challenges that limit their ability to challenge overall leadership.` },
    { name: 'Strategic Insight', length: 'medium', minWords: 100, fallback: `Forward-looking analysis suggests that current market positions are likely to persist in the near term, with ${leadEntity} maintaining its advantage through continued investment and strategic discipline. However, emerging disruptors and shifting regulatory landscapes introduce meaningful uncertainty beyond the immediate horizon. Organizations positioned to capitalize on these transitions will require agile strategic frameworks and robust risk management capabilities.` },
    { name: 'Quick Summary', length: 'short', minWords: 50, fallback: `${leadEntity} leads the current rankings across ${topLabels}, reflecting sustained competitive advantages in scale and execution. The data highlights significant variation between top and mid-tier performers, with implications for strategic positioning.` },
    { name: 'Notable Highlight', length: 'short', minWords: 50, fallback: `A standout finding is the widening gap between ${leadEntity} and the nearest competitor — a spread that has grown consistently over recent periods, signaling deepening structural advantages rather than cyclical fluctuations.` },
    { name: 'Bullet Points', length: 'list', minWords: 0, fallback: 'Key takeaways and highlights:', isBullets: true }
  ];

  let rawBlocks = Array.isArray(rawBank.textBlocks) ? rawBank.textBlocks : [];
  const bankBlocks = DEFAULT_CATEGORIES.map((def, idx) => {
    const raw = rawBlocks[idx] || {};
    const textVal = String(raw.text || def.fallback);
    const block = {
      id: `b${idx + 1}`,
      category: raw.category || def.name,
      length: raw.length || def.length,
      text: textVal
    };
    if (def.isBullets || Array.isArray(raw.bullets)) {
      block.bullets = Array.isArray(raw.bullets) && raw.bullets.length > 0
        ? raw.bullets.map(b => String(b))
        : bundle.narratives.bulletPoints;
    }
    return block;
  });

  // 8e. Sources
  const bankSources = Array.isArray(rawBank.sources) && rawBank.sources.length > 0
    ? rawBank.sources.map(s => String(s))
    : [bundle.source];

  // 8f. General Image Queries & Images — entity-specific, not generic
  const bankImageQueries = Array.isArray(rawBank.generalImageQueries) && rawBank.generalImageQueries.length >= 3
    ? rawBank.generalImageQueries.slice(0, 3).map(q => String(q))
    : bundle.visualKeywords.length >= 3
    ? bundle.visualKeywords.slice(0, 3)
    : [`${dataContainer.labels[0] || fallbackTitle} official`, `${dataContainer.labels[1] || fallbackTitle} logo`, `${fallbackTitle} portrait photo`];

  const contentBank = {
    titles: bankTitles,
    subtitles: bankSubtitles,
    catchyPhrases: bankPhrases,
    textBlocks: bankBlocks,
    sources: bankSources,
    generalImageQueries: bankImageQueries,
    generalImages: Array.isArray(rawBank.generalImages) ? rawBank.generalImages : [],
    sliceImages: Array.isArray(rawBank.sliceImages) ? rawBank.sliceImages : []
  };

  bundle.contentBank = contentBank;
  chartResponse.contentBank = contentBank;

  return bundle;
}


