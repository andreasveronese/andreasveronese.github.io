/**
 * Content script kör inne på webbplatsen
 * och kan läsa DOM + scripts för att hitta signaler.
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "SCAN_PAGE") return;

  try {
    const data = scanPage();
    sendResponse({ ok: true, data });
  } catch (e) {
    sendResponse({ ok: false, error: e?.message || String(e) });
  }
  return true; // vi svarar synkront här, men ok att ha
});

function scanPage() {
  const tech = detectTech();
  const seo = getSeoBasics();
  const growth = getGrowthSignals();
  return { tech, seo, growth };
}

// ----------------------
// TECH DETECTION
// ----------------------
function detectTech() {
  const found = new Set();

  const html = document.documentElement.outerHTML;
  const scripts = Array.from(document.scripts).map(s => (s.src || "") + " " + (s.textContent || "")).join("\n");

  // CMS/platform
  if (html.includes("cdn.shopify.com") || window.Shopify) found.add("Shopify");
  if (html.includes("wp-content/") || html.includes("wp-json") || html.includes("WordPress")) found.add("WordPress");
  if (html.includes("webflow.js") || document.documentElement.dataset.wfPage) found.add("Webflow");

  // Tracking/ads
  if (scripts.includes("googletagmanager.com/gtm.js?id=GTM-")) found.add("Google Tag Manager");
  if (scripts.includes("gtag/js?id=G-") || scripts.includes("G-")) found.add("Google Analytics (GA4)");
  if (scripts.includes("fbevents.js") || scripts.includes("fbq(")) found.add("Meta Pixel");
  if (scripts.includes("hotjar") || scripts.includes("hj(")) found.add("Hotjar");

  // CRM/Email
  if (scripts.toLowerCase().includes("klaviyo") || scripts.includes("learnq")) found.add("Klaviyo");
  if (scripts.toLowerCase().includes("hubspot")) found.add("HubSpot");

  return Array.from(found);
}

// ----------------------
// SEO BASICS
// ----------------------
function getSeoBasics() {
  const title = document.title || "";
  const desc = getMeta("description");
  const canonical = document.querySelector('link[rel="canonical"]')?.href || "";
  const h1Count = document.querySelectorAll("h1").length;
  const ldJsonCount = document.querySelectorAll('script[type="application/ld+json"]').length;

  return {
    title,
    metaDescription: desc,
    canonical,
    h1Count,
    hasStructuredData: ldJsonCount > 0,
    ldJsonBlocks: ldJsonCount
  };
}

function getMeta(name) {
  return document.querySelector(`meta[name="${name}"]`)?.content || "";
}

// ----------------------
// GROWTH SIGNALS
// ----------------------
function getGrowthSignals() {
  const ctaKeywords = [
    "buy", "add to cart", "start", "book", "get started", "request demo", "demo",
    "sign up", "subscribe", "try", "free trial", "contact sales"
  ];

  const leadMagnetKeywords = ["download", "guide", "ebook", "checklist", "template", "report"];

  // CTA: leta knappar/länkar med CTA-ord
  const clickable = Array.from(document.querySelectorAll("a, button, input[type='submit']"));
  const ctas = clickable
    .map(el => (el.innerText || el.value || "").trim().toLowerCase())
    .filter(text => text && ctaKeywords.some(k => text.includes(k)));

  // Sticky/fixed CTA: grov heuristik
  const stickyCandidates = clickable.filter(el => {
    const style = window.getComputedStyle(el);
    return style.position === "fixed" || style.position === "sticky";
  });

  // Lead magnet: sök ord i texten (grov)
  const bodyText = document.body?.innerText?.toLowerCase() || "";
  const hasLeadMagnet = leadMagnetKeywords.some(k => bodyText.includes(k));

  // Cookie banner: grov (letar efter ord)
  const hasCookieBanner = bodyText.includes("cookie") && (bodyText.includes("consent") || bodyText.includes("accept"));

  return {
    ctaCount: ctas.length,
    sampleCtas: Array.from(new Set(ctas)).slice(0, 8),
    hasStickyCta: stickyCandidates.length > 0,
    stickyCtaCount: stickyCandidates.length,
    hasLeadMagnet,
    hasCookieBanner
  };
}
