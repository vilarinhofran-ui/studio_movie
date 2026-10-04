const { lookup } = require("node:dns").promises;

const MAX_HTML_BYTES = 1_500_000;
const MAX_IMAGE_BYTES = 2_000_000;

function isPrivateAddress(address) {
  if (address.includes(":")) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    );
  }
  const [first, second] = address.split(".").map(Number);
  return (
    first === 10 ||
    first === 127 ||
    first === 0 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

async function assertPublicUrl(value) {
  const target = new URL(value);
  if (!/^https?:$/.test(target.protocol)) throw new Error("URL inválida");
  const hostname = target.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local"))
    throw new Error("Endereço não permitido");
  const addresses = await lookup(hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => isPrivateAddress(address))
  )
    throw new Error("Endereço não permitido");
  return target;
}

async function fetchPublic(value, accept) {
  let target = await assertPublicUrl(value);
  for (let redirects = 0; redirects < 4; redirects++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    let response;
    try {
      response = await fetch(target, {
        headers: {
          Accept: accept,
          "User-Agent": "StudioMovieIdentity/1.0",
        },
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirecionamento inválido");
      target = await assertPublicUrl(new URL(location, target).href);
      continue;
    }
    if (!response.ok) throw new Error("Site indisponível");
    return { response, url: target.href };
  }
  throw new Error("Muitos redirecionamentos");
}

function attr(tag, name) {
  const match = tag.match(
    new RegExp("\\b" + name + "\\s*=\\s*[\"']([^\"']+)[\"']", "i"),
  );
  return match ? match[1].trim() : "";
}

function logoUrlFrom(html, pageUrl) {
  const tags = [
    ...html.matchAll(
      /<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:logo|logo)["'][^>]*>/gi,
    ),
    ...html.matchAll(
      /<img\b[^>]*(?:alt|class|id)\s*=\s*["'][^"']*logo[^"']*["'][^>]*>/gi,
    ),
    ...html.matchAll(/<link\b[^>]*rel\s*=\s*["'][^"']*icon[^"']*["'][^>]*>/gi),
  ];
  for (const [tag] of tags) {
    const source =
      attr(tag, "content") || attr(tag, "src") || attr(tag, "href");
    if (!source || source.startsWith("data:")) continue;
    try {
      return new URL(source, pageUrl).href;
    } catch (error) {}
  }
  return new URL("/favicon.ico", pageUrl).href;
}

async function imageDataUrl(value) {
  try {
    const { response } = await fetchPublic(
      value,
      "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5",
    );
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) return "";
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return "";
    return (
      "data:" +
      contentType.split(";")[0] +
      ";base64," +
      bytes.toString("base64")
    );
  } catch (error) {
    return "";
  }
}

exports.handler = async (event) => {
  try {
    const input =
      event.queryStringParameters && event.queryStringParameters.url;
    if (!input) throw new Error("Informe uma URL");
    const { response, url } = await fetchPublic(
      input,
      "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
    );
    const contentType = response.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType))
      throw new Error("A URL não contém uma página HTML");
    const html = await response.text();
    if (!html || Buffer.byteLength(html) > MAX_HTML_BYTES)
      throw new Error("Página muito grande");
    const logoDataUrl = await imageDataUrl(logoUrlFrom(html, url));
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({ url, html, logoDataUrl }),
    };
  } catch (error) {
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({
        error: error.message || "Não foi possível ler a URL",
      }),
    };
  }
};
