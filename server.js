const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

loadEnvFile(path.join(__dirname, ".env"));

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.post("/api/seo/opportunity", async (req, res) => {
  try {
    const keyword = String(req.body.keyword || "").trim();
    const market = String(req.body.market || "SE").trim().toUpperCase();

    if (!keyword) {
      return res.status(400).json({ error: "keyword is required" });
    }

    const serpData = await fetchSerpApiResults({ keyword, market, num: 10 });
    const topResults = normalizeOrganicResults(serpData).slice(0, 10);
    const paa = normalizePaa(serpData).slice(0, 10);
    const featuredSnippet = normalizeFeaturedSnippet(serpData);
    const adsCount = Array.isArray(serpData.ads_results) ? serpData.ads_results.length : 0;

    const scoreInput = summarizeSerpForScore(topResults, paa.length, featuredSnippet.exists, adsCount);
    const scoreOutput = calculateRuleBasedSeoOpportunity(scoreInput);

    const aiAnalysis = await generateSeoContentAnalysisWithOpenAI({
      keyword,
      market,
      topResults,
      peopleAlsoAsk: paa,
      featuredSnippet,
      adsCount,
    });

    const fallback = buildFallbackSeoContentOutput({ keyword, paa });
    const contentGaps = Array.isArray(aiAnalysis?.contentGaps) && aiAnalysis.contentGaps.length
      ? aiAnalysis.contentGaps.slice(0, 4)
      : fallback.contentGaps;
    const contentBrief = normalizeContentBrief(aiAnalysis?.contentBrief, fallback.contentBrief);

    return res.json({
      keyword,
      market,
      opportunityScore: scoreOutput.opportunityScore,
      scoreReasons: scoreOutput.reasons,
      featuredSnippet,
      peopleAlsoAskCount: paa.length,
      peopleAlsoAsk: paa,
      adsCount,
      topResults,
      contentGaps,
      contentBrief,
      serpSummary: {
        blogGuideCount: scoreInput.blogGuideCount,
        brandOrEcommerceCount: scoreInput.brandOrEcommerceCount,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unexpected server error" });
  }
});

app.post("/api/ads/intel", async (req, res) => {
  try {
    const keyword = String(req.body.keyword || "").trim();
    const market = String(req.body.market || "SE").trim().toUpperCase();

    if (!keyword) {
      return res.status(400).json({ error: "keyword is required" });
    }

    const adFetch = await fetchAdsWithFallback({ keyword, market });
    const normalizedAds = normalizeAdResults(adFetch.ads);
    const adsWithLandingType = normalizedAds.map((ad) => ({
      ...ad,
      landingType: classifyLandingType(ad.url),
    }));

    const totals = {
      adCount: adsWithLandingType.length,
      uniqueAdvertisers: countUniqueAdvertisers(adsWithLandingType),
    };

    const advertiserCounts = summarizeAdvertisers(adsWithLandingType);
    const ctaCounts = summarizeCtaWords(adsWithLandingType);
    const landingTypeDistribution = summarizeLandingTypes(adsWithLandingType);

    const fallbackInsights = generateRuleBasedAdInsights({
      advertiserCounts,
      ctaCounts,
      landingTypeDistribution,
    });

    const aiResponse = await generateAdIntelInsightsWithOpenAI({
      keyword,
      market,
      ads: adsWithLandingType.map((ad) => ({
        advertiser: ad.advertiser,
        domain: ad.domain,
        headline: ad.headline,
        headlines: ad.headlines,
        description: ad.description,
        landingType: ad.landingType,
      })),
    });

    const insights = normalizeAdInsights(aiResponse, fallbackInsights);

    return res.json({
      keyword,
      market,
      queryUsed: adFetch.queryUsed,
      marketUsed: adFetch.marketUsed,
      adsSource: adFetch.adsSource,
      attemptedQueries: adFetch.attemptedQueries,
      totals,
      advertisers: advertiserCounts,
      ctaCounts,
      landingTypeDistribution,
      ads: adsWithLandingType,
      insights,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unexpected server error" });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "portfolio-tools-api" });
});

app.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});

async function fetchSerpApiResults({ keyword, market, num }) {
  const apiKey = (process.env.SERPAPI_API_KEY || process.env.SERPAPI_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Missing SERPAPI_API_KEY (or SERPAPI_KEY) in .env");
  }

  const marketConfig = {
    SE: { gl: "se", hl: "sv", googleDomain: "google.se", location: "Stockholm,Stockholm,Sweden" },
    NO: { gl: "no", hl: "no", googleDomain: "google.no", location: "Oslo,Oslo,Norway" },
    DK: { gl: "dk", hl: "da", googleDomain: "google.dk", location: "Copenhagen,Capital Region of Denmark,Denmark" },
    US: { gl: "us", hl: "en", googleDomain: "google.com", location: "United States" },
  };
  const selectedMarket = marketConfig[market] || marketConfig.SE;

  const params = new URLSearchParams({
    engine: "google",
    q: keyword,
    gl: selectedMarket.gl,
    hl: selectedMarket.hl,
    google_domain: selectedMarket.googleDomain,
    location: selectedMarket.location,
    device: "desktop",
    no_cache: "true",
    safe: "off",
    num: String(num),
    api_key: apiKey,
  });

  const response = await fetch("https://serpapi.com/search.json?" + params.toString());
  if (!response.ok) {
    throw new Error("SERP API request failed with status " + response.status);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error("SERP API error: " + data.error);
  }

  return data;
}

async function fetchAdsWithFallback({ keyword, market }) {
  const plans = buildAdFetchPlans(keyword, market);
  const attemptedQueries = [];

  for (const plan of plans) {
    attemptedQueries.push(plan.market + ": " + plan.keyword);
    const serpData = await fetchSerpApiResults({ keyword: plan.keyword, market: plan.market, num: 20 });
    const extracted = extractAdsFromSerpData(serpData);
    if (extracted.ads.length) {
      return {
        ads: extracted.ads,
        adsSource: extracted.adsSource,
        queryUsed: plan.keyword,
        marketUsed: plan.market,
        attemptedQueries,
      };
    }
  }

  return {
    ads: [],
    adsSource: "none",
    queryUsed: keyword,
    marketUsed: market,
    attemptedQueries,
  };
}

function extractAdsFromSerpData(serpData) {
  const adCandidates = [
    { key: "ads_results", values: serpData.ads_results || [] },
    { key: "top_ads", values: serpData.top_ads || [] },
    { key: "bottom_ads", values: serpData.bottom_ads || [] },
    { key: "inline_ads", values: serpData.inline_ads || [] },
    { key: "ads", values: serpData.ads || [] },
  ];

  for (const candidate of adCandidates) {
    if (Array.isArray(candidate.values) && candidate.values.length) {
      return { ads: candidate.values.slice(0, 20), adsSource: candidate.key };
    }
  }

  const shoppingAds = [
    ...(serpData.shopping_results || []),
    ...(serpData.inline_shopping_results || []),
  ].slice(0, 12).map((item) => ({
    source: item.source || item.merchant || "Unknown advertiser",
    title: item.title || "",
    description: item.price ? "Pris: " + item.price : "",
    link: item.link || "",
    displayed_link: item.source || item.merchant || "",
  }));

  if (shoppingAds.length) {
    return { ads: shoppingAds, adsSource: "shopping_results_fallback" };
  }

  return { ads: [], adsSource: "none" };
}

function buildAdIntentKeyword(keyword, market) {
  const modifierByMarket = {
    SE: "pris",
    NO: "pris",
    DK: "pris",
    US: "price",
  };
  const modifier = modifierByMarket[market] || "price";
  const base = String(keyword || "").trim();
  if (!base) return base;
  if (base.toLowerCase().includes(modifier.toLowerCase())) return base;
  return base + " " + modifier;
}

function buildAdFetchPlans(keyword, market) {
  const plans = [];
  const base = String(keyword || "").trim();
  if (!base) return plans;

  const markets = market === "US" ? ["US"] : [market, "US"];
  const suffixByMarket = {
    SE: ["pris", "erbjudande", "boka demo", "gratis test"],
    NO: ["pris", "tilbud", "book demo", "gratis prøve"],
    DK: ["pris", "tilbud", "book demo", "gratis prøve"],
    US: ["price", "pricing", "demo", "free trial"],
  };

  for (const selectedMarket of markets) {
    plans.push({ keyword: base, market: selectedMarket });

    const suffixes = suffixByMarket[selectedMarket] || suffixByMarket.US;
    for (const suffix of suffixes) {
      const query = base.toLowerCase().includes(suffix.toLowerCase()) ? base : base + " " + suffix;
      plans.push({ keyword: query, market: selectedMarket });
    }
  }

  const unique = [];
  const seen = new Set();
  for (const plan of plans) {
    const key = plan.market + "|" + plan.keyword.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(plan);
    }
  }

  return unique.slice(0, 10);
}

function normalizePaa(serpData) {
  return (serpData.related_questions || []).map((item) => ({
    question: item.question || "",
    snippet: item.snippet || "",
  }));
}

function normalizeFeaturedSnippet(serpData) {
  const box = serpData.answer_box;
  if (!box) {
    return { exists: false, type: null };
  }

  return {
    exists: true,
    type: box.type || box.answer_type || "unknown",
  };
}

function summarizeSerpForScore(topResults, paaCount, hasFeaturedSnippet, adsCount) {
  const blogGuideCount = topResults.filter((item) => /\b(bästa|test|guide|recension)\b/i.test(item.title)).length;
  const brandOrEcommerceCount = topResults.filter(isBrandOrEcommerceResult).length;

  return {
    blogGuideCount,
    brandOrEcommerceCount,
    paaCount,
    hasFeaturedSnippet,
    adsCount,
  };
}

function isBrandOrEcommerceResult(result) {
  const domain = String(result.domain || "").toLowerCase();
  const link = String(result.link || "").toLowerCase();
  const title = String(result.title || "").toLowerCase();

  const knownBrandDomains = [
    "amazon.",
    "ikea.",
    "apple.",
    "samsung.",
    "elgiganten.",
    "mediamarkt.",
    "hm.",
    "adidas.",
    "nike.",
    "zalando.",
    "netonnet.",
    "xxl.",
    "apotea.",
  ];

  const brandMatch = knownBrandDomains.some((entry) => domain.includes(entry));
  const ecommerceMatch =
    link.includes("/shop") ||
    link.includes("/product") ||
    link.includes("/products") ||
    title.includes("köp") ||
    title.includes("pris");

  return brandMatch || ecommerceMatch;
}

function calculateRuleBasedSeoOpportunity(input) {
  let score = 50;
  const reasons = [];

  if (!input.hasFeaturedSnippet) {
    score += 10;
    reasons.push("Ingen featured snippet (+10)");
  }

  if (input.paaCount >= 4) {
    score += 10;
    reasons.push(input.paaCount + " PAA-frågor (+10)");
  }

  if (input.blogGuideCount >= 3) {
    score += 10;
    reasons.push(input.blogGuideCount + " blog/guide-resultat (+10)");
  }

  if (input.brandOrEcommerceCount >= 4) {
    score -= 15;
    reasons.push(input.brandOrEcommerceCount + " varumärken/e-commerce i topp 10 (-15)");
  }

  if (input.adsCount >= 3) {
    score -= 10;
    reasons.push(input.adsCount + " annonser (-10)");
  }

  return {
    opportunityScore: Math.max(0, Math.min(100, score)),
    reasons,
  };
}

async function generateSeoContentAnalysisWithOpenAI(payload) {
  const client = getOpenAIClient();
  if (!client) return null;

  const prompt = [
    "Du är en SEO-strateg.",
    "Du får ENDAST använda datan i input. Ingen extern kunskap.",
    "Returnera ENDAST giltig JSON med exakt detta schema:",
    "{",
    '  "contentGaps": ["..."],',
    '  "contentBrief": {',
    '    "h1": "...",',
    '    "h2": ["..."],',
    '    "faq": ["..."],',
    '    "cta": "..."',
    "  }",
    "}",
    "Krav:",
    "- contentGaps: 2 till 4 punkter",
    "- h2: 4 till 7 rubriker",
    "- faq: max 6 frågor (prioritera PAA)",
    "- cta: neutral",
    "- språk: svenska",
    "",
    "Input:",
    JSON.stringify(payload),
  ].join("\n");

  try {
    const response = await client.chat.completions.create({
      model: getOpenAIModel(),
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Returnera endast JSON." },
        { role: "user", content: prompt },
      ],
    });

    const content = response.choices?.[0]?.message?.content || "{}";
    return safeJsonParse(content);
  } catch (_error) {
    return null;
  }
}

function buildFallbackSeoContentOutput({ keyword, paa }) {
  const faq = paa.map((item) => item.question).filter(Boolean).slice(0, 6);

  return {
    contentGaps: [
      "Tydligare jämförelse mellan alternativ i toppresultaten",
      "Mer konkret struktur med steg och beslutskriterier",
      "Bättre täckning av vanliga frågor från PAA",
    ],
    contentBrief: {
      h1: keyword,
      h2: [
        "Vad betyder " + keyword + " i praktiken?",
        "Hur väljer du rätt alternativ?",
        "Vanliga misstag och hur du undviker dem",
        "Jämförelse av de vanligaste alternativen",
      ],
      faq,
      cta: "Läs vidare till nästa steg i din beslutsprocess.",
    },
  };
}

function normalizeContentBrief(candidate, fallback) {
  if (!candidate || typeof candidate !== "object") {
    return fallback;
  }

  const h1 = typeof candidate.h1 === "string" && candidate.h1.trim() ? candidate.h1.trim() : fallback.h1;
  const h2 = Array.isArray(candidate.h2) && candidate.h2.length
    ? candidate.h2.filter(Boolean).slice(0, 7)
    : fallback.h2;
  const faq = Array.isArray(candidate.faq) ? candidate.faq.filter(Boolean).slice(0, 6) : fallback.faq;
  const cta =
    typeof candidate.cta === "string" && candidate.cta.trim() ? candidate.cta.trim() : fallback.cta;

  return { h1, h2, faq, cta };
}

function calculateOpportunityScore(input) {
  let score = 45;

  if (input.intent === "commercial") score += 14;
  if (input.intent === "informational") score += 8;

  score += Math.min(input.relatedQuestionCount * 3, 18);
  if (input.hasFeaturedSnippet) score += 8;
  if (!input.hasTopAds) score += 8;
  if (input.organicCount >= 8) score += 6;

  return Math.max(1, Math.min(100, score));
}

function normalizeOrganicResults(serpData) {
  return (serpData.organic_results || []).map((item) => ({
    title: item.title || "",
    link: item.link || "",
    domain: extractDomain(item.link || ""),
    snippet: item.snippet || "",
  }));
}

function classifyTopResults(results) {
  const counts = {
    forum: 0,
    blogAffiliate: 0,
    brand: 0,
    ecommerce: 0,
    other: 0,
  };

  for (const result of results) {
    const type = classifyResultType(result);
    counts[type] += 1;
  }

  return counts;
}

function classifyResultType(result) {
  const domain = String(result.domain || "").toLowerCase();
  const title = String(result.title || "").toLowerCase();
  const link = String(result.link || "").toLowerCase();

  const isForum = domain.includes("reddit.com") || domain.includes("forum");
  if (isForum) return "forum";

  const isBlogAffiliate = /\b(bästa|test|recension)\b/i.test(title);
  if (isBlogAffiliate) return "blogAffiliate";

  const knownBrands = [
    "amazon.",
    "ikea.",
    "apple.",
    "samsung.",
    "elgiganten.",
    "mediamarkt.",
    "hm.",
    "adidas.",
    "nike.",
    "zalando.",
  ];
  if (knownBrands.some((brand) => domain.includes(brand))) return "brand";

  const isEcommerce = link.includes("shop") || link.includes("product");
  if (isEcommerce) return "ecommerce";

  return "other";
}

function detectSerpFormat(titles) {
  let yearCount = 0;
  let keywordPatternCount = 0;
  let listSignals = 0;
  let guideSignals = 0;

  for (const titleRaw of titles) {
    const title = String(titleRaw || "").toLowerCase();
    if (/\b20(2[0-9]|3[0-9])\b/.test(title)) {
      yearCount += 1;
    }

    const hasListSignal = /\b(bästa|top|test)\b/i.test(title);
    const hasGuideSignal = /\bguide\b/i.test(title);
    const hasPattern = hasListSignal || hasGuideSignal;

    if (hasPattern) keywordPatternCount += 1;
    if (hasListSignal) listSignals += 1;
    if (hasGuideSignal) guideSignals += 1;
  }

  let recommendedFormat = "mixed";
  if (listSignals > guideSignals && listSignals > 0) {
    recommendedFormat = "list";
  } else if (guideSignals > listSignals && guideSignals > 0) {
    recommendedFormat = "guide";
  }

  return {
    yearCount,
    keywordPatternCount,
    listSignals,
    guideSignals,
    recommendedFormat,
  };
}

function computeRuleBasedOpportunityScore(typeCounts, adsCount) {
  let score = 50;

  if (typeCounts.forum >= 1) score += 10;
  if (typeCounts.blogAffiliate >= 3) score += 10;
  if (typeCounts.brand > 3) score -= 15;
  if (adsCount > 3) score -= 10;

  return Math.max(0, Math.min(100, score));
}

function buildSeoRecommendation({ score, recommendedFormat, hasYearPattern }) {
  const yearTip = hasYearPattern
    ? "Använd uppdaterat årtal i titel/H1 eftersom årtal redan dominerar SERP."
    : "Årtal verkar inte dominera SERP, prioritera tydlig vinkel och konkret nytta.";

  if (score >= 65 && recommendedFormat === "list") {
    return "Bra möjlighet om du gör en topplista med uppdaterat årtal. " + yearTip;
  }

  if (score >= 65 && recommendedFormat === "guide") {
    return "Bra möjlighet om du gör en guide med tydliga steg och jämförelse. " + yearTip;
  }

  if (score >= 50) {
    return "Måttlig möjlighet. Välj format utifrån SERP-signaler och skapa starkare vinkel än nuvarande resultat. " + yearTip;
  }

  return "Låg möjlighet just nu. Testa mer nischat sökord eller differentiera med unik datavinkel/case. " + yearTip;
}

function normalizeAdResults(ads) {
  return (ads || []).map((ad, index) => {
    const headlineCandidates = [
      ad.title,
      ...(Array.isArray(ad.headlines) ? ad.headlines : []),
    ].filter(Boolean);

    const link = ad.link || ad.url || "";
    const domainFromLink = extractDomain(link);
    const advertiser =
      ad.source ||
      ad.displayed_link ||
      ad.domain ||
      domainFromLink ||
      "Okänd annonsör";

    return {
      advertiser,
      domain: domainFromLink || advertiser,
      headline: headlineCandidates[0] || "",
      headlines: headlineCandidates,
      description: ad.description || "",
      url: link,
      position: Number.isFinite(ad.position) ? ad.position : index + 1,
    };
  });
}

function countUniqueAdvertisers(ads) {
  return new Set(ads.map((ad) => ad.advertiser)).size;
}

function summarizeAdvertisers(ads) {
  const counts = new Map();
  for (const ad of ads) {
    counts.set(ad.advertiser, (counts.get(ad.advertiser) || 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([advertiser, count]) => ({ advertiser, count }))
    .sort((a, b) => b.count - a.count);
}

function summarizeCtaWords(ads) {
  const ctaTerms = ["demo", "gratis", "rabatt", "offert", "boka", "prova"];
  const corpus = ads
    .map((ad) => [ad.headline, ...(ad.headlines || []), ad.description].filter(Boolean).join(" "))
    .join(" \n")
    .toLowerCase();

  return ctaTerms
    .map((term) => ({ term, count: countOccurrences(corpus, term) }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count);
}

function countOccurrences(text, term) {
  if (!text || !term) return 0;
  const regex = new RegExp("\\b" + escapeRegExp(term) + "\\b", "gi");
  return (text.match(regex) || []).length;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function classifyLandingType(url) {
  const value = String(url || "").toLowerCase();
  if (value.includes("pricing") || value.includes("pris") || value.includes("priser")) {
    return "Pricing";
  }
  if (value.includes("demo") || value.includes("boka") || value.includes("meeting")) {
    return "Demo/Leadgen";
  }
  if (value.includes("signup") || value.includes("register")) {
    return "Signup";
  }
  if (value.includes("product") || value.includes("produkt") || /\/p\//.test(value)) {
    return "Produkt";
  }
  return "Generell";
}

function summarizeLandingTypes(ads) {
  const counts = new Map();
  for (const ad of ads) {
    counts.set(ad.landingType, (counts.get(ad.landingType) || 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

function generateRuleBasedAdInsights({ advertiserCounts, ctaCounts, landingTypeDistribution }) {
  const topAdvertiser = advertiserCounts[0];
  const topCta = ctaCounts[0];
  const topLandingType = landingTypeDistribution[0];

  const clusters = [];
  if (topCta) {
    clusters.push({
      name: "CTA-fokuserat budskap",
      examples: [topCta.term],
      summary: "Många annonser trycker på " + topCta.term + " i rubrik/beskrivning.",
    });
  }
  if (topLandingType) {
    clusters.push({
      name: "Landningsmönster",
      examples: [topLandingType.type],
      summary: "Vanligaste landningssida är " + topLandingType.type + ".",
    });
  }

  const marketSummary = [];
  if (topAdvertiser) {
    marketSummary.push(topAdvertiser.advertiser + " är mest aktiv med " + topAdvertiser.count + " annonser.");
  }
  if (topCta) {
    marketSummary.push("Vanligaste CTA-term är \"" + topCta.term + "\".");
  }
  if (topLandingType) {
    marketSummary.push("Flest annonser leder till landningssidor av typen " + topLandingType.type + ".");
  }

  const differentiationSuggestions = [
    "Testa en tydligare value proposition än marknadens standardbudskap.",
    "Differentiera med konkret bevis (kundcase/siffra) i rubrik eller beskrivning.",
    "Använd en landningssida med skarpare nästa steg än konkurrenterna.",
  ];

  return {
    source: "rule_based",
    copyClusters: clusters.slice(0, 5),
    marketSummary: marketSummary.slice(0, 6),
    differentiationSuggestions: differentiationSuggestions.slice(0, 3),
    abTestIdea: "A/B-testa CTA: \"Boka demo\" mot \"Prova gratis\" och jämför CTR + konvertering.",
  };
}

function extractRecurringMessages(ads) {
  if (!ads.length) return [];

  const buckets = {
    Rabatt: ["rabatt", "%", "spara", "kampanj", "deal"],
    "Gratis demo": ["gratis demo", "demo", "book demo"],
    "Gratis test": ["gratis test", "free trial", "prova gratis"],
    "Snabb setup": ["snabb", "kom igång", "på minuter", "direkt"],
    "Ingen bindningstid": ["ingen bindning", "utan bindning", "cancel anytime"],
  };

  const corpus = ads
    .map((ad) => (ad.title + " " + ad.description).toLowerCase())
    .join(" \n");

  const hits = [];
  for (const [label, terms] of Object.entries(buckets)) {
    const found = terms.some((term) => corpus.includes(term));
    if (found) hits.push(label);
  }

  return hits;
}

function buildPositioningRecommendation({ keyword, recurringMessages }) {
  const crowded = recurringMessages.join(", ") || "standardbudskap";

  return "För keywordet '" + keyword + "' är marknaden mättad på " + crowded + ". Positionera nästa annonsvåg på tydlig affärsnytta, konkret time-to-value och bevis i form av kundcase istället för generell rabattkommunikation.";
}

function uniqueAdvertisers(ads) {
  const seen = new Set();
  const result = [];

  for (const ad of ads) {
    const value = ad.advertiser || "Unknown advertiser";
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }

  return result;
}

function getOpenAIModel() {
  return process.env.OPENAI_MODEL || "gpt-4o-mini";
}

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

async function generateAdIntelInsightsWithOpenAI(payload) {
  const client = getOpenAIClient();
  if (!client) return null;

  const prompt = [
    "Du är specialist på paid search-analys.",
    "Använd ENDAST inputdatan. Ingen extern kunskap och inga påhitt.",
    "Returnera ENDAST giltig JSON med detta schema:",
    "{",
    '  "copyClusters": [',
    '    { "name": "...", "summary": "...", "examples": ["..."] }',
    "  ],",
    '  "marketSummary": ["..."],',
    '  "differentiationSuggestions": ["..."],',
    '  "abTestIdea": "..."',
    "}",
    "Regler:",
    "- 3 till 5 copyClusters",
    "- marketSummary: 3 till 6 bullets",
    "- differentiationSuggestions: 2 till 3 bullets",
    "- abTestIdea: 1 konkret idé",
    "- svenska, enkelt språk",
    "",
    "Input:",
    JSON.stringify(payload),
  ].join("\n");

  try {
    const response = await client.chat.completions.create({
      model: getOpenAIModel(),
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Returnera endast JSON." },
        { role: "user", content: prompt },
      ],
    });

    const content = response.choices?.[0]?.message?.content || "{}";
    return safeJsonParse(content);
  } catch (_error) {
    return null;
  }
}

function normalizeAdInsights(candidate, fallback) {
  if (!candidate || typeof candidate !== "object") {
    return fallback;
  }

  const copyClusters = Array.isArray(candidate.copyClusters)
    ? candidate.copyClusters
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          name: String(item.name || "").trim(),
          summary: String(item.summary || "").trim(),
          examples: Array.isArray(item.examples) ? item.examples.filter(Boolean).slice(0, 3) : [],
        }))
        .filter((item) => item.name)
        .slice(0, 5)
    : fallback.copyClusters;

  const marketSummary = Array.isArray(candidate.marketSummary)
    ? candidate.marketSummary.filter(Boolean).slice(0, 6)
    : fallback.marketSummary;

  const differentiationSuggestions = Array.isArray(candidate.differentiationSuggestions)
    ? candidate.differentiationSuggestions.filter(Boolean).slice(0, 3)
    : fallback.differentiationSuggestions;

  const abTestIdea =
    typeof candidate.abTestIdea === "string" && candidate.abTestIdea.trim()
      ? candidate.abTestIdea.trim()
      : fallback.abTestIdea;

  return {
    source: "openai",
    copyClusters: copyClusters.length ? copyClusters : fallback.copyClusters,
    marketSummary: marketSummary.length ? marketSummary : fallback.marketSummary,
    differentiationSuggestions: differentiationSuggestions.length
      ? differentiationSuggestions
      : fallback.differentiationSuggestions,
    abTestIdea,
  };
}

async function generateSeoInsightsWithOpenAI(payload) {
  const client = getOpenAIClient();
  if (!client) return null;

  const prompt = [
    "Du är en senior SEO- och growth-strateg.",
    "Analysera SERP-datan och returnera ENDAST giltig JSON.",
    "Schema:",
    "{",
    '  "gaps": ["..."],',
    '  "growthRecommendations": ["..."],',
    '  "brief": {',
    '    "suggestedTitle": "...",',
    '    "headings": ["..."],',
    '    "faqQuestions": ["..."],',
    '    "recommendedCTA": "..."',
    "  }",
    "}",
    "Håll svar kort, konkret och på svenska.",
    "",
    "Data:",
    JSON.stringify(payload),
  ].join("\n");

  try {
    const response = await client.chat.completions.create({
      model: getOpenAIModel(),
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Returnera endast JSON." },
        { role: "user", content: prompt },
      ],
    });

    const content = response.choices?.[0]?.message?.content || "{}";
    return safeJsonParse(content);
  } catch (_error) {
    return null;
  }
}

async function generateAdsInsightsWithOpenAI(payload) {
  const client = getOpenAIClient();
  if (!client) return null;

  const prompt = [
    "Du är specialist på paid search och konkurrentanalys.",
    "Analysera annonsmaterialet och returnera ENDAST giltig JSON.",
    "Schema:",
    "{",
    '  "messagingSummary": "...",',
    '  "recurringMessages": ["..."],',
    '  "valuePropositionClusters": ["..."],',
    '  "positioning": "..."',
    "}",
    "Håll svar kort, konkret och på svenska.",
    "",
    "Data:",
    JSON.stringify(payload),
  ].join("\n");

  try {
    const response = await client.chat.completions.create({
      model: getOpenAIModel(),
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Returnera endast JSON." },
        { role: "user", content: prompt },
      ],
    });

    const content = response.choices?.[0]?.message?.content || "{}";
    return safeJsonParse(content);
  } catch (_error) {
    return null;
  }
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function mergeBrief(baseBrief, aiBrief) {
  const merged = { ...baseBrief };

  if (typeof aiBrief.suggestedTitle === "string" && aiBrief.suggestedTitle.trim()) {
    merged.suggestedTitle = aiBrief.suggestedTitle.trim();
  }

  if (Array.isArray(aiBrief.headings) && aiBrief.headings.length) {
    merged.headings = aiBrief.headings.filter(Boolean).slice(0, 8);
  }

  if (Array.isArray(aiBrief.faqQuestions) && aiBrief.faqQuestions.length) {
    merged.faqQuestions = aiBrief.faqQuestions.filter(Boolean).slice(0, 8);
  }

  if (typeof aiBrief.recommendedCTA === "string" && aiBrief.recommendedCTA.trim()) {
    merged.recommendedCTA = aiBrief.recommendedCTA.trim();
  }

  return merged;
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_error) {
    return "";
  }
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    const raw = trimmed.slice(index + 1).trim();
    const value = raw.replace(/^['\"]|['\"]$/g, "");

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
