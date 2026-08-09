'use strict';
// SSRF-sicherer HTTP(S)-Abruf einer beliebigen, vom Nutzer eingegebenen URL
// (z. B. beim Einfügen eines Links in den Editor für die optionale
// KI-Zusammenfassung). Verantwortlich NUR für den Netzwerk-Teil: URL-
// Validierung, DNS-Rebinding-sicherer Verbindungsaufbau, Redirect-Handling,
// Größen-/Content-Type-Limits. Die Textextraktion aus dem gelieferten HTML
// übernimmt lib/html-extract.js.
//
// Sicherheitsdesign in Kürze:
//  - Nur http(s), keine Userinfo, nur Port 80/443/leer.
//  - Literale IP-Hosts werden direkt gegen die Blockliste geprüft.
//  - Hostnamen werden über einen eigenen `lookup`-Hook aufgelöst (statt der
//    Standard-DNS-Auflösung von http(s).request), der ALLE zurückgegebenen
//    Adressen prüft und dem Socket exakt eine geprüfte Adresse übergibt.
//    Damit gibt es keine zweite, ungeprüfte Auflösung zwischen Prüfung und
//    Verbindungsaufbau (DNS-Rebinding-Schutz).
//  - Redirects werden manuell verfolgt; jeder Hop durchläuft dieselbe
//    Validierung wie die Start-URL.
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

const USER_AGENT = 'ThreadStack-LinkSummary/1.0';
const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml'];

class SafeFetchError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.name = 'SafeFetchError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

// --- Blocklisten (net.BlockList, Node-Bordmittel) --------------------------
// IPv4-Bereiche: 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8,
// 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15,
// 224.0.0.0/4, 240.0.0.0/4.
const BLOCKED_V4_SUBNETS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

// IPv6-Bereiche: ::/128, ::1/128, fc00::/7, fe80::/10, ff00::/8.
const BLOCKED_V6_SUBNETS = [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

const v4BlockList = new net.BlockList();
for (const [addr, prefix] of BLOCKED_V4_SUBNETS) v4BlockList.addSubnet(addr, prefix, 'ipv4');

const v6BlockList = new net.BlockList();
for (const [addr, prefix] of BLOCKED_V6_SUBNETS) v6BlockList.addSubnet(addr, prefix, 'ipv6');

// Entfernt umschließende eckige Klammern von IPv6-Literalen, wie sie in
// `new URL(...).hostname` auftreten (z. B. "[::1]" -> "::1").
function stripBrackets(hostname) {
  const s = String(hostname || '');
  if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1);
  return s;
}

// Wandelt eine IPv4-mapped IPv6-Adresse (sowohl gemischte Notation
// "::ffff:127.0.0.1" als auch reine Hex-Notation "::ffff:7f00:1", wie sie
// z. B. von der WHATWG-URL-Normalisierung erzeugt wird) in die äquivalente
// IPv4-Dotted-Quad-Adresse um. Liefert null, wenn die Adresse keine
// IPv4-mapped IPv6-Adresse ist.
function unmapIPv4MappedIPv6(address) {
  const a = String(address || '').toLowerCase();
  let m = a.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (m) return m[1];
  m = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) {
    const hi = parseInt(m[1], 16);
    const lo = parseInt(m[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

/**
 * Prüft, ob eine IP-Adresse gegen die SSRF-Blockliste (loopback, private
 * Netze, link-local, multicast/reserviert - siehe oben) verstößt.
 * `family` ist 4/6 (wie von dns.lookup geliefert) oder 'ipv4'/'ipv6'.
 *
 * `allowLoopbackForTest` ist ein NICHT Teil des öffentlichen Vertrags
 * dokumentierter, rein interner dritter Parameter (siehe Abschlussbericht):
 * er wird ausschließlich von lib/safe-fetch.js selbst (safeFetchPage) mit
 * dem gleichnamigen Funktionsparameter durchgereicht, um exakt 127.0.0.1 und
 * ::1 für lokale Test-Server von der Blockade auszunehmen. Aufrufer, die nur
 * `isBlockedAddress(ip, family)` aufrufen, erhalten unverändert das
 * dokumentierte Verhalten (Loopback ist immer geblockt).
 */
function isBlockedAddress(ip, family, allowLoopbackForTest = false) {
  let addr = stripBrackets(ip);
  let fam = family === 6 || family === '6' || family === 'ipv6' || net.isIPv6(addr) ? 6 : 4;

  if (fam === 6) {
    const unmapped = unmapIPv4MappedIPv6(addr);
    if (unmapped) {
      addr = unmapped;
      fam = 4;
    }
  }

  if (allowLoopbackForTest && (addr === '127.0.0.1' || addr === '::1')) {
    return false;
  }

  if (fam === 4) {
    if (!net.isIPv4(addr)) return true; // unparsbar -> sicherheitshalber blocken
    return v4BlockList.check(addr, 'ipv4');
  }
  if (!net.isIPv6(addr)) return true;
  return v6BlockList.check(addr, 'ipv6');
}

/**
 * Validiert eine vom Nutzer stammende URL gegen die SSRF-Policy und liefert
 * das geparste URL-Objekt zurück (oder wirft SafeFetchError).
 *
 * `opts.allowLoopbackForTest` ist wie bei isBlockedAddress ein interner,
 * nicht im öffentlichen Vertrag dokumentierter zweiter Parameter (siehe
 * Abschlussbericht) - ausschließlich für den Eigenaufruf aus safeFetchPage.
 * `assertUrlAllowed(rawUrl)` (ein Argument) verhält sich exakt wie
 * spezifiziert.
 */
function assertUrlAllowed(rawUrl, opts = {}) {
  const allowLoopbackForTest = !!opts.allowLoopbackForTest;

  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new SafeFetchError('invalid_url', 'Die URL konnte nicht geparst werden.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeFetchError('invalid_url', 'Nur http(s)-URLs sind erlaubt.');
  }
  if (url.username || url.password) {
    throw new SafeFetchError('invalid_url', 'URLs mit Zugangsdaten sind nicht erlaubt.');
  }

  const hostname = stripBrackets(url.hostname);
  const ipFamily = net.isIP(hostname);

  // Für den lokalen Unit-Test-Server (nur exakt 127.0.0.1/::1 mit
  // allowLoopbackForTest) wird auch die Port-Beschränkung ausgesetzt, da ein
  // Test-http.Server systembedingt auf einem beliebigen freien Port lauscht
  // (Port 80 erfordert Root-Rechte). Siehe Hinweis zu allowLoopbackForTest
  // oben bei isBlockedAddress; gleicher, nicht im öffentlichen Vertrag
  // dokumentierter Testpfad.
  const isExemptedLoopbackLiteral = allowLoopbackForTest
    && ipFamily
    && (hostname === '127.0.0.1' || hostname === '::1');

  if (!isExemptedLoopbackLiteral && url.port !== '' && url.port !== '80' && url.port !== '443') {
    throw new SafeFetchError('invalid_url', 'Nur Port 80, 443 oder der Standardport sind erlaubt.');
  }

  if (ipFamily) {
    if (isBlockedAddress(hostname, ipFamily, allowLoopbackForTest)) {
      throw new SafeFetchError('blocked_target', 'Zieladresse ist nicht erlaubt.');
    }
  }

  return url;
}

// Baut den `lookup`-Hook für http(s).request: löst den Hostnamen über
// dns.lookup auf, prüft JEDE zurückgegebene Adresse gegen die Blockliste und
// gibt genau eine geprüfte Adresse an Node weiter. Wird für Hostnamen
// (nicht literale IPs - dafür ruft Node den Hook gar nicht erst auf)
// verwendet, sowohl für die Start-URL als auch für jeden Redirect-Hop.
function makeLookup(allowLoopbackForTest) {
  return function lookup(hostname, options, callback) {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) {
        callback(err);
        return;
      }
      const list = Array.isArray(addresses) ? addresses : [addresses];
      if (!list.length) {
        callback(new SafeFetchError('fetch_failed', 'DNS-Auflösung lieferte keine Adresse.'));
        return;
      }
      for (const { address, family } of list) {
        if (isBlockedAddress(address, family, allowLoopbackForTest)) {
          callback(new SafeFetchError('blocked_target', 'Zieladresse ist nicht erlaubt.'));
          return;
        }
      }
      const chosen = list[0];
      callback(null, chosen.address, chosen.family);
    });
  };
}

function parseContentType(headerValue) {
  const raw = String(headerValue || '');
  const mainType = raw.split(';')[0].trim().toLowerCase();
  const charsetMatch = raw.match(/charset\s*=\s*"?([^;"]+)"?/i);
  return { mainType, charset: charsetMatch ? charsetMatch[1].trim() : '' };
}

// Führt genau einen HTTP-Hop aus und löst mit entweder
// `{ type: 'redirect', location }` oder `{ type: 'body', status, contentType,
// charset, body, truncated }` auf (oder verwirft mit SafeFetchError).
function performHop(url, { maxBytes, remainingMs, allowLoopbackForTest, signal }) {
  return new Promise((resolve, reject) => {
    if (remainingMs <= 0) {
      reject(new SafeFetchError('fetch_timeout', 'Zeitüberschreitung beim Seitenabruf.'));
      return;
    }

    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;
    let timedOut = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    const req = transport.request(
      {
        hostname: stripBrackets(url.hostname),
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        lookup: makeLookup(allowLoopbackForTest),
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'de,en;q=0.8',
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;

        if (status >= 300 && status < 400 && location) {
          res.resume(); // Redirect-Body verwerfen, nicht weiter lesen
          finish(resolve, { type: 'redirect', location });
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          finish(reject, new SafeFetchError('fetch_http_error', `Unerwarteter HTTP-Status ${status}.`, status));
          return;
        }

        const { mainType, charset } = parseContentType(res.headers['content-type']);
        if (!ALLOWED_CONTENT_TYPES.includes(mainType)) {
          res.destroy();
          finish(reject, new SafeFetchError('unsupported_content_type', `Nicht unterstützter Content-Type: ${mainType || '(leer)'}.`));
          return;
        }

        const chunks = [];
        let total = 0;
        let overflowed = false;

        res.on('data', (chunk) => {
          if (overflowed) return;
          total += chunk.length;
          if (total > maxBytes) {
            overflowed = true;
            res.destroy();
            finish(reject, new SafeFetchError('too_large', `Antwort überschreitet das Limit von ${maxBytes} Bytes.`));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          if (overflowed) return;
          finish(resolve, {
            type: 'body',
            status,
            contentType: mainType,
            charset,
            body: Buffer.concat(chunks),
            truncated: false,
          });
        });

        res.on('error', () => {
          if (overflowed) return;
          finish(reject, new SafeFetchError('fetch_failed', 'Fehler beim Lesen der Antwort.'));
        });
      },
    );

    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
    }, remainingMs);

    req.on('error', (err) => {
      // Fehler aus dem eigenen `lookup`-Hook (z. B. blocked_target) werden
      // unverändert durchgereicht statt in ein generisches fetch_failed
      // übersetzt zu werden.
      if (err instanceof SafeFetchError) {
        finish(reject, err);
        return;
      }
      finish(reject, timedOut
        ? new SafeFetchError('fetch_timeout', 'Zeitüberschreitung beim Seitenabruf.')
        : new SafeFetchError('fetch_failed', 'Der Seitenabruf ist fehlgeschlagen.'));
    });

    if (signal) {
      if (signal.aborted) {
        req.destroy();
        finish(reject, new SafeFetchError('fetch_failed', 'Der Seitenabruf wurde abgebrochen.'));
      } else {
        const onAbort = () => req.destroy();
        signal.addEventListener('abort', onAbort, { once: true });
        req.on('close', () => signal.removeEventListener('abort', onAbort));
      }
    }

    req.end();
  });
}

/**
 * Ruft eine externe Seite SSRF-sicher ab (siehe Moduldoku oben) und liefert
 * Statuscode, Content-Type/Charset und den Response-Body als Buffer.
 * Wirft SafeFetchError bei jedem Fehlerfall (siehe Codes in der Moduldoku).
 */
async function safeFetchPage(rawUrl, options = {}) {
  const {
    signal,
    timeoutMs = 10000,
    maxBytes = 2 * 1024 * 1024,
    maxRedirects = 3,
    allowLoopbackForTest = false,
  } = options;

  const deadline = Date.now() + timeoutMs;
  let currentUrl = assertUrlAllowed(rawUrl, { allowLoopbackForTest });
  let redirectCount = 0;

  for (;;) {
    const remainingMs = deadline - Date.now();
    const hop = await performHop(currentUrl, { maxBytes, remainingMs, allowLoopbackForTest, signal });

    if (hop.type === 'redirect') {
      if (redirectCount >= maxRedirects) {
        throw new SafeFetchError('too_many_redirects', 'Zu viele Weiterleitungen.');
      }
      redirectCount += 1;
      let nextUrl;
      try {
        nextUrl = new URL(hop.location, currentUrl);
      } catch {
        throw new SafeFetchError('invalid_url', 'Ungültige Weiterleitungs-URL.');
      }
      currentUrl = assertUrlAllowed(nextUrl.href, { allowLoopbackForTest });
      continue;
    }

    return {
      finalUrl: currentUrl.href,
      status: hop.status,
      contentType: hop.contentType,
      charset: hop.charset,
      body: hop.body,
      truncated: hop.truncated,
    };
  }
}

module.exports = {
  safeFetchPage,
  assertUrlAllowed,
  isBlockedAddress,
  SafeFetchError,
};
