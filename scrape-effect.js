/**
 * scrape-effects.js
 * Generic scrapers for TextPro / PhotoOxy / Ephoto (no mumaker)
 *
 * Usage examples at bottom.
 */

const fetch = require("node-fetch"); // if Node <18, install node-fetch@2
const FormData = require("form-data");
const cheerio = require("cheerio");
const { URL } = require("url");

/**
 * Resolve relative link to absolute
 */
function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch (e) {
    return relative;
  }
}

/**
 * Parse HTML and find the first meaningful form (POST) for generation.
 * Returns { action, method, hiddenInputs: {name: value}, textFieldNames: [names], files: [] }
 */
function parseForm(html, baseUrl) {
  const $ = cheerio.load(html);
  // Prefer forms with input[name*='token'] or input[name*='text'] etc.
  const forms = $("form").toArray();

  let chosen = null;
  for (const f of forms) {
    const form = $(f);
    const inputs = form.find("input, textarea, select").toArray();
    // pick form that contains any "token" or "text" or "submit" inputs
    const names = inputs.map(i => $(i).attr("name")).filter(Boolean).map(n => n.toLowerCase());
    if (names.some(n => n.includes("token") || n.includes("text") || n.includes("captcha") || n.includes("submit"))) {
      chosen = form;
      break;
    }
  }
  // fallback to first form
  if (!chosen && forms.length) chosen = $(forms[0]);
  if (!chosen) return null;

  const action = chosen.attr("action") || baseUrl;
  const method = (chosen.attr("method") || "GET").toUpperCase();

  const hiddenInputs = {};
  const textFieldNames = []; // names of inputs for textual inputs
  const fileInputs = [];

  chosen.find("input, textarea, select").each((i, el) => {
    const name = $(el).attr("name");
    if (!name) return;
    const type = ($(el).attr("type") || "").toLowerCase();
    if (type === "hidden" || type === "submit") {
      // capture default hidden values
      hiddenInputs[name] = $(el).attr("value") || "";
    } else if (type === "file") {
      fileInputs.push(name);
    } else {
      // heuristics: names containing "text" or "word" or "name" or array style like text[] 
      if (/text/i.test(name) || /word/i.test(name) || /name/i.test(name) || name.includes("[]")) {
        textFieldNames.push(name);
      }
      // capture default value if present
      if ($(el).attr("value")) hiddenInputs[name] = $(el).attr("value");
    }
  });

  // If no explicit textFieldNames found, we'll fall back to 'text[]'
  if (textFieldNames.length === 0) {
    textFieldNames.push("text[]");
  }

  return {
    action: resolveUrl(baseUrl, action),
    method,
    hiddenInputs,
    textFieldNames,
    fileInputs
  };
}

/**
 * Submit the parsed form using form-data; textParts can be string or array.
 * Returns { status, bodyText, finalUrl, response } - response is node-fetch Response
 */
async function submitForm(parsed, textParts, headers = {}) {
  const form = new FormData();

  // append hidden inputs
  for (const k of Object.keys(parsed.hiddenInputs)) {
    form.append(k, parsed.hiddenInputs[k]);
  }

  // normalize textParts into array
  let texts = textParts;
  if (typeof texts === "string") texts = [texts];
  if (!Array.isArray(texts)) texts = [String(texts)];

  // fill text fields: try to match number of fields
  const names = parsed.textFieldNames;
  // If only one name and it ends with [] then append all texts as that name
  if (names.length === 1 && names[0].endsWith("[]")) {
    const name = names[0];
    for (const t of texts) form.append(name, t);
  } else {
    // otherwise assign texts to names in order; if more texts than names, repeat last name as array style
    for (let i = 0; i < texts.length; i++) {
      const name = names[Math.min(i, names.length - 1)];
      form.append(name, texts[i]);
    }
  }

  // other file inputs not supported in this generic script (most sites don't need uploaded files)
  // set headers and submit as POST (method default POST)
  const opts = {
    method: parsed.method || "POST",
    headers: {
      ...headers,
      ...form.getHeaders()
    },
    body: form,
    redirect: "manual" // we'll follow redirects manually to capture final location
  };

  // send request
  let res = await fetch(parsed.action, opts);

  // If redirect (location header), follow it (some sites respond with 302 redirect to result)
  if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
    const loc = resolveUrl(parsed.action, res.headers.get("location"));
    // follow once (some flows might redirect multiple times)
    res = await fetch(loc, { headers, redirect: "follow" });
  } else {
    // Some sites return HTML with link to image; we need to read body text
    // follow any subsequent redirects
    if (res.status >= 300 && res.status < 400) {
      // attempt follow
      const loc = res.headers.get("location");
      if (loc) {
        const r2 = resolveUrl(parsed.action, loc);
        res = await fetch(r2, { headers, redirect: "follow" });
      }
    }
  }

  const bodyText = await res.text();
  const finalUrl = res.url;

  return { status: res.status, bodyText, finalUrl, response: res };
}

/**
 * Extract image URL from HTML response (generic search)
 */
function extractImageFromHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  // try common patterns: meta og:image, img with result class, a[href*='.png']
  const og = $('meta[property="og:image"]').attr('content') || $('meta[name="og:image"]').attr('content');
  if (og) return resolveUrl(baseUrl, og);

  // look for <img id="image-result"> or similar
  const imgSelectors = [
    'img#image-output',
    'img#image',
    'img.result-img',
    'div.thumbnail img',
    'img'
  ];
  for (const sel of imgSelectors) {
    const el = $(sel).first();
    if (el && el.attr && el.attr('src')) {
      return resolveUrl(baseUrl, el.attr('src'));
    }
  }

  // look for links to image files
  const anchors = $('a').toArray();
  for (const a of anchors) {
    const href = $(a).attr('href');
    if (href && /\.(png|jpe?g|gif|webp)(\?.*)?$/.test(href)) {
      return resolveUrl(baseUrl, href);
    }
  }

  // fallback: search any url-like in the HTML that ends with image ext
  const match = html.match(/https?:\/\/[^"' >]+?\.(?:png|jpe?g|gif|webp)(?:\?[^"' >]+)?/i);
  if (match) return match[0];

  return null;
}

/**
 * Generic runner: fetch page, parse form, submit, extract image
 */
async function generateFromPage(pageUrl, texts, opts = {}) {
  const headers = {
    "User-Agent": opts.userAgent || "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36"
  };

  // fetch the page
  const pageRes = await fetch(pageUrl, { headers });
  if (!pageRes.ok) throw new Error(`Failed to fetch page: ${pageRes.status} ${pageRes.statusText}`);
  const html = await pageRes.text();

  const parsed = parseForm(html, pageUrl);
  if (!parsed) throw new Error("No suitable form found on page (site layout may have changed).");

  // If the parsed action is same domain, some sites require a 'token' which is in hidden inputs already
  const submitResult = await submitForm(parsed, texts, headers);

  // try extract image from response
  let image = extractImageFromHtml(submitResult.bodyText, submitResult.finalUrl);
  if (!image) {
    // Sometimes the server returns JSON pointing to image
    try {
      const json = JSON.parse(submitResult.bodyText || "{}");
      if (json && (json.url || json.image || json.result)) {
        image = json.url || json.image || json.result;
      }
    } catch (e) {
      // ignore
    }
  }

  if (!image) {
    // as last resort, check finalUrl if it directly ends with an image
    if (/\.(png|jpe?g|gif|webp)(\?.*)?$/.test(submitResult.finalUrl)) {
      image = submitResult.finalUrl;
    }
  }

  if (!image) {
    // return whole body for debugging
    throw new Error("Unable to find result image. Response body saved for debugging.");
  }

  return image;
}

/**
 * Public helper functions
 */
async function generateTextPro(url, texts) {
  return generateFromPage(url, texts);
}

async function generatePhotoOxy(url, texts) {
  return generateFromPage(url, texts);
}

async function generateEphoto(url, texts) {
  return generateFromPage(url, texts);
}

/**
 * Exports
 */
module.exports = {
  generateTextPro,
  generatePhotoOxy,
  generateEphoto,
  // lower-levels
  parseForm,
  submitForm,
  extractImageFromHtml
};

/* -------------------------
   Quick CLI test usage:
   node scrape-effects.js textpro "https://textpro.me/shadow-text-effect-in-the-sky-394.html" "Mahiru"
   node scrape-effects.js graffiti "https://textpro.me/create-a-graffiti-text-effect-178.html" "Mahiru|Bot"
-------------------------*/
if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    if (argv.length < 3) {
      console.log("Usage: node scrape-effects.js <service> <url> <text>");
      console.log("service: textpro|photooxy|ephoto");
      process.exit(1);
    }
    const [service, url, text] = argv;
    try {
      let out;
      if (service === "textpro") out = await generateTextPro(url, text);
      else if (service === "photooxy") out = await generatePhotoOxy(url, text);
      else if (service === "ephoto") out = await generateEphoto(url, text);
      else throw new Error("Unknown service");
      console.log("RESULT:", out);
    } catch (e) {
      console.error("ERROR:", e);
      process.exit(2);
    }
  })();
}
