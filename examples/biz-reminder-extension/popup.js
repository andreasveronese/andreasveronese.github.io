const scanBtn = document.getElementById("scanBtn");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

const techEl = document.getElementById("tech");
const seoEl = document.getElementById("seo");
const growthEl = document.getElementById("growth");

const scoreBox = document.getElementById("scoreBox");
const scoreHint = document.getElementById("scoreHint");
const recsEl = document.getElementById("recs");

function setStatus(t) {
  statusEl.textContent = t;
}

function renderTags(list) {
  techEl.innerHTML = "";
  if (!list || list.length === 0) {
    techEl.innerHTML = `<span class="tag">No clear signals detected</span>`;
    return;
  }
  list.forEach((item) => {
    const span = document.createElement("span");
    span.className = "tag";
    span.textContent = item;
    techEl.appendChild(span);
  });
}

// ---------- SCAN FUNCTION (runs inside the tab) ----------
function scanPageInTab() {
  const found = new Set();

  const html = document.documentElement?.outerHTML || "";
  const scripts = Array.from(document.scripts)
    .map(s => (s.src || "") + " " + (s.textContent || ""))
    .join("\n");

  // Platform/CMS
  if (html.includes("cdn.shopify.com") || window.Shopify) found.add("Shopify");
  if (html.includes("wp-content/") || html.includes("wp-json")) found.add("WordPress");
  if (html.includes("webflow.js") || document.documentElement?.dataset?.wfPage) found.add("Webflow");

  // Tracking
  if (scripts.includes("googletagmanager.com/gtm.js?id=GTM-")) found.add("Google Tag Manager");
  if (scripts.includes("gtag/js?id=G-") || scripts.includes("G-")) found.add("Google Analytics (GA4)");
  if (scripts.includes("fbevents.js") || scripts.includes("fbq(")) found.add("Meta Pixel");
  if (scripts.toLowerCase().includes("hotjar") || scripts.includes("hj(")) found.add("Hotjar");
  if (scripts.toLowerCase().includes("klaviyo") || scripts.includes("learnq")) found.add("Klaviyo");
  if (scripts.toLowerCase().includes("hubspot")) found.add("HubSpot");

  // SEO basics
  const title = document.title || "";
  const metaDesc = document.querySelector('meta[name="description"]')?.content || "";
  const canonical = document.querySelector('link[rel="canonical"]')?.href || "";
  const h1Count = document.querySelectorAll("h1").length;
  const ldJsonCount = document.querySelectorAll('script[type="application/ld+json"]').length;

  const seo = {
    title,
    metaDescription: metaDesc,
    canonical,
    h1Count,
    hasStructuredData: ldJsonCount > 0,
    ldJsonBlocks: ldJsonCount
  };

  // Growth signals
  const ctaKeywords = [
    "buy","add to cart","start","book","get started","request demo","demo",
    "sign up","subscribe","try","free trial","contact sales","contact","get a quote"
  ];
  const leadMagnetKeywords = ["download","guide","ebook","checklist","template","report","newsletter"];

  const clickable = Array.from(document.querySelectorAll("a, button, input[type='submit']"));
  const ctas = clickable
    .map(el => (el.innerText || el.value || "").trim().toLowerCase())
    .filter(text => text && ctaKeywords.some(k => text.includes(k)));

  const stickyCandidates = clickable.filter(el => {
    const style = window.getComputedStyle(el);
    return style.position === "fixed" || style.position === "sticky";
  });

  const bodyText = document.body?.innerText?.toLowerCase() || "";
  const hasLeadMagnet = leadMagnetKeywords.some(k => bodyText.includes(k));
  const hasCookieBanner = bodyText.includes("cookie") && (
    bodyText.includes("consent") || bodyText.includes("accept") || bodyText.includes("preferences")
  );

  const growth = {
    ctaCount: ctas.length,
    sampleCtas: Array.from(new Set(ctas)).slice(0, 8),
    hasStickyCta: stickyCandidates.length > 0,
    stickyCtaCount: stickyCandidates.length,
    hasLeadMagnet,
    hasCookieBanner
  };

  return { tech: Array.from(found), seo, growth, page: { url: location.href } };
}

// ---------- UI RENDER HELPERS ----------
function pill(status, text) {
  const cls = status === "ok" ? "ok" : status === "warn" ? "warn" : "bad";
  return `<span class="pill ${cls}">${text}</span>`;
}

function kpiRow(label, valueHtml) {
  return `
    <div class="kpi">
      <div class="label">${label}</div>
      <div class="value">${valueHtml}</div>
    </div>
  `;
}

function renderSeo(seo) {
  const titleOk = Boolean(seo.title);
  const descOk = Boolean(seo.metaDescription);
  const canonicalOk = Boolean(seo.canonical);
  const h1Ok = seo.h1Count === 1;
  const schemaOk = Boolean(seo.hasStructuredData);

  seoEl.innerHTML = [
    kpiRow("Title", titleOk ? pill("ok", "Present") : pill("bad", "Missing")),
    kpiRow("Meta description", descOk ? pill("ok", "Present") : pill("warn", "Missing")),
    kpiRow("H1 tags", h1Ok ? pill("ok", "1 (Good)") : pill("warn", `${seo.h1Count} (Should be 1)`)),
    kpiRow("Canonical", canonicalOk ? pill("ok", "Present") : pill("warn", "Missing")),
    kpiRow("Structured data (JSON-LD)", schemaOk ? pill("ok", `Found (${seo.ldJsonBlocks})`) : pill("warn", "Not found"))
  ].join("");

  // Extra: visa title som text under (mer mänskligt)
  if (seo.title) {
    seoEl.innerHTML += `<div class="muted" style="margin-top:8px;">Title: <code>${escapeHtml(seo.title)}</code></div>`;
  }
  if (seo.canonical) {
    seoEl.innerHTML += `<div class="muted" style="margin-top:6px;">Canonical: <code>${escapeHtml(seo.canonical)}</code></div>`;
  }
}

function renderGrowth(growth) {
  const ctaOk = growth.ctaCount > 0;
  const cookieOk = growth.hasCookieBanner;
  const leadOk = growth.hasLeadMagnet;
  const stickyOk = growth.hasStickyCta;

  growthEl.innerHTML = [
    kpiRow("CTA detected", ctaOk ? pill("ok", `${growth.ctaCount}`) : pill("warn", "None")),
    kpiRow("Sticky CTA", stickyOk ? pill("ok", "Yes") : pill("warn", "No")),
    kpiRow("Lead magnet", leadOk ? pill("ok", "Yes") : pill("warn", "No")),
    kpiRow("Cookie banner", cookieOk ? pill("ok", "Yes") : pill("warn", "No"))
  ].join("");

  if (growth.sampleCtas?.length) {
    growthEl.innerHTML += `<div class="muted" style="margin-top:8px;">Sample CTAs: <code>${escapeHtml(growth.sampleCtas.join(", "))}</code></div>`;
  }
}

function computeScoreAndRecs(seo, growth) {
  // Start from 100 and subtract penalties
  let score = 100;
  const recs = [];

  // SEO scoring
  if (!seo.title) { score -= 15; recs.push("Add a clear page title (SEO + trust)."); }
  if (!seo.metaDescription) { score -= 10; recs.push("Add a meta description to improve CTR in search results."); }
  if (seo.h1Count !== 1) { score -= 10; recs.push("Fix heading structure: aim for exactly 1 H1 on the page."); }
  if (!seo.canonical) { score -= 8; recs.push("Add a canonical tag to prevent duplicate-content issues."); }
  if (!seo.hasStructuredData) { score -= 10; recs.push("Add JSON-LD structured data (schema.org) for richer search results."); }

  // Growth scoring
  if (growth.ctaCount === 0) { score -= 15; recs.push("Make the primary CTA clearer (button text + placement above the fold)."); }
  if (!growth.hasStickyCta) { score -= 5; recs.push("Consider a sticky CTA on mobile to reduce friction."); }
  if (!growth.hasLeadMagnet) { score -= 8; recs.push("Add a lead magnet (guide/checklist/newsletter) to capture demand."); }
  if (!growth.hasCookieBanner) { score -= 6; recs.push("Implement a cookie consent banner (compliance + tracking control)."); }

  // Clamp score between 0 and 100
  score = Math.max(0, Math.min(100, score));

  // Return top 3 recommendations (most important first)
  return { score, recs: recs.slice(0, 3) };
}

function renderScore(score) {
  scoreBox.textContent = String(score);

  scoreBox.classList.remove("good","warn","bad");
  if (score >= 80) {
    scoreBox.classList.add("good");
    scoreHint.textContent = "Healthy baseline";
  } else if (score >= 55) {
    scoreBox.classList.add("warn");
    scoreHint.textContent = "Good, but improvements found";
  } else {
    scoreBox.classList.add("bad");
    scoreHint.textContent = "High opportunity for quick wins";
  }
}

function renderRecs(list) {
  recsEl.innerHTML = "";
  if (!list || list.length === 0) {
    recsEl.innerHTML = `<li>No major issues detected.</li>`;
    return;
  }
  list.forEach((r) => {
    const li = document.createElement("li");
    li.textContent = r;
    recsEl.appendChild(li);
  });
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------- MAIN CLICK ----------
scanBtn.addEventListener("click", async () => {
  try {
    setStatus("Scanning...");
    resultsEl.style.display = "none";

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || "";

    // Block restricted pages
    if (url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.includes("chrome.google.com/webstore")) {
      setStatus("Chrome does not allow scanning this type of page.");
      return;
    }

    // Inject scan function
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scanPageInTab
    });

    // Render UI
    renderTags(result.tech);
    renderSeo(result.seo);
    renderGrowth(result.growth);

    const { score, recs } = computeScoreAndRecs(result.seo, result.growth);
    renderScore(score);
    renderRecs(recs);

    resultsEl.style.display = "block";
    setStatus("Done ✅");
  } catch (e) {
    setStatus("Could not scan this page. Refresh the page and try again.");
  }
});
