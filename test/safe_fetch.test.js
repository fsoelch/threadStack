'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dns = require('node:dns');

const {
  safeFetchPage,
  assertUrlAllowed,
  isBlockedAddress,
  SafeFetchError,
} = require('../lib/safe-fetch');

// Startet einen kurzlebigen Test-HTTP-Server auf 127.0.0.1 und liefert
// { url, close }. Der Handler bekommt (req,res).
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}: ${err.message}`);
    return true;
  });
}

test('isBlockedAddress: Blockliste', async (t) => {
  await t.test('IPv4 private/loopback/link-local Bereiche werden geblockt', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.5', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1']) {
      assert.equal(isBlockedAddress(ip, 4), true, ip);
    }
  });

  await t.test('öffentliche IPv4-Adresse wird nicht geblockt', () => {
    assert.equal(isBlockedAddress('8.8.8.8', 4), false);
    assert.equal(isBlockedAddress('1.1.1.1', 4), false);
  });

  await t.test('IPv6 loopback/unique-local/link-local werden geblockt', () => {
    for (const ip of ['::1', 'fc00::1', 'fd12:3456:789a::1', 'fe80::1']) {
      assert.equal(isBlockedAddress(ip, 6), true, ip);
    }
  });

  await t.test('öffentliche IPv6-Adresse wird nicht geblockt', () => {
    assert.equal(isBlockedAddress('2606:4700:4700::1111', 6), false);
  });

  await t.test('IPv4-mapped IPv6 wird vor der Prüfung entmappt (mixed notation)', () => {
    assert.equal(isBlockedAddress('::ffff:127.0.0.1', 6), true);
    assert.equal(isBlockedAddress('::ffff:10.0.0.1', 6), true);
    assert.equal(isBlockedAddress('::ffff:8.8.8.8', 6), false);
  });

  await t.test('IPv4-mapped IPv6 wird vor der Prüfung entmappt (hex notation, wie von URL geliefert)', () => {
    // ::ffff:127.0.0.1 in reiner Hex-Form
    assert.equal(isBlockedAddress('::ffff:7f00:1', 6), true);
    // ::ffff:8.8.8.8 in reiner Hex-Form
    assert.equal(isBlockedAddress('::ffff:808:808', 6), false);
  });
});

test('assertUrlAllowed: URL-Validierung', async (t) => {
  await t.test('http/https werden akzeptiert', () => {
    const u = assertUrlAllowed('https://example.com/page');
    assert.equal(u.protocol, 'https:');
  });

  for (const scheme of ['file:///etc/passwd', 'ftp://example.com/x', 'data:text/html,hi', 'javascript:alert(1)']) {
    await t.test(`Schema wird abgelehnt: ${scheme}`, () => {
      assert.throws(() => assertUrlAllowed(scheme), (err) => {
        assert.equal(err.code, 'invalid_url');
        return true;
      });
    });
  }

  await t.test('URL mit Userinfo wird abgelehnt', () => {
    assert.throws(() => assertUrlAllowed('http://user:pass@example.com/'), (err) => {
      assert.equal(err.code, 'invalid_url');
      return true;
    });
  });

  await t.test('Port 8080 wird abgelehnt', () => {
    assert.throws(() => assertUrlAllowed('http://example.com:8080/'), (err) => {
      assert.equal(err.code, 'invalid_url');
      return true;
    });
  });

  await t.test('Port 443 auf https wird akzeptiert', () => {
    assert.doesNotThrow(() => assertUrlAllowed('https://example.com:443/'));
  });

  await t.test('Literale IPv4-Loopback-Adresse wird abgelehnt', () => {
    assert.throws(() => assertUrlAllowed('http://127.0.0.1/'), (err) => {
      assert.equal(err.code, 'blocked_target');
      return true;
    });
  });

  await t.test('Literale IPv6-Loopback-Adresse wird abgelehnt', () => {
    assert.throws(() => assertUrlAllowed('http://[::1]/'), (err) => {
      assert.equal(err.code, 'blocked_target');
      return true;
    });
  });

  await t.test('Literale private IPv4-Adresse wird abgelehnt (10.x)', () => {
    assert.throws(() => assertUrlAllowed('http://10.0.0.5/'), (err) => {
      assert.equal(err.code, 'blocked_target');
      return true;
    });
  });

  await t.test('Literale private IPv4-Adresse wird abgelehnt (172.16-31.x)', () => {
    assert.throws(() => assertUrlAllowed('http://172.20.1.1/'), (err) => {
      assert.equal(err.code, 'blocked_target');
      return true;
    });
  });

  await t.test('Literale private IPv4-Adresse wird abgelehnt (192.168.x)', () => {
    assert.throws(() => assertUrlAllowed('http://192.168.1.1/'), (err) => {
      assert.equal(err.code, 'blocked_target');
      return true;
    });
  });

  await t.test('Link-Local inkl. Cloud-Metadaten-Adresse wird abgelehnt', () => {
    assert.throws(() => assertUrlAllowed('http://169.254.169.254/'), (err) => {
      assert.equal(err.code, 'blocked_target');
      return true;
    });
  });

  await t.test('IPv4-mapped IPv6-Literal wird abgelehnt', () => {
    assert.throws(() => assertUrlAllowed('http://[::ffff:127.0.0.1]/'), (err) => {
      assert.equal(err.code, 'blocked_target');
      return true;
    });
  });

  await t.test('Ungültige URL wirft invalid_url', () => {
    assert.throws(() => assertUrlAllowed('not a url'), (err) => {
      assert.equal(err.code, 'invalid_url');
      return true;
    });
  });
});

test('safeFetchPage: Erfolgsfälle gegen lokalen Test-Server (allowLoopbackForTest)', async (t) => {
  await t.test('einfacher HTML-Abruf liefert body/status/contentType', async () => {
    const { url, close } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><p>Hallo Welt</p></body></html>');
    });
    try {
      const result = await safeFetchPage(url, { allowLoopbackForTest: true });
      assert.equal(result.status, 200);
      assert.equal(result.contentType, 'text/html');
      assert.equal(result.charset, 'utf-8');
      assert.ok(result.body.includes('Hallo Welt'));
      assert.equal(result.truncated, false);
      assert.equal(result.finalUrl, `${url}/`);
    } finally {
      await close();
    }
  });

  await t.test('Redirects innerhalb des Limits werden verfolgt', async () => {
    const { url, close } = await startServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/target' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><p>Ziel erreicht</p></body></html>');
    });
    try {
      const result = await safeFetchPage(`${url}/start`, { allowLoopbackForTest: true });
      assert.equal(result.status, 200);
      assert.ok(result.body.includes('Ziel erreicht'));
      assert.ok(result.finalUrl.endsWith('/target'));
    } finally {
      await close();
    }
  });

  await t.test('ohne allowLoopbackForTest wird 127.0.0.1 weiterhin geblockt', () => {
    // Isolierter Nachweis der IP-Blockade unabhängig vom Port (Standardport,
    // damit ausschließlich das Loopback-Blocking geprüft wird, nicht die
    // separate Port-Beschränkung): allowLoopbackForTest wirkt sich nur bei
    // explizitem `true` aus.
    assert.throws(() => assertUrlAllowed('http://127.0.0.1/'), (err) => {
      assert.equal(err.code, 'blocked_target');
      return true;
    });
  });
});

test('safeFetchPage: Redirect auf blockierte Adresse wird abgelehnt, auch wenn Start-URL erlaubt war', async (t) => {
  // Die Start-URL zeigt auf den lokalen Test-Server (127.0.0.1, nur dank
  // allowLoopbackForTest erreichbar). Der Server antwortet mit einem
  // Redirect auf eine private Adresse (10.0.0.5), die von der
  // allowLoopbackForTest-Ausnahme NICHT erfasst ist (diese gilt laut Vertrag
  // ausschließlich für exakt 127.0.0.1/::1) - der zweite Hop muss also
  // unabhängig vom ersten erneut vollständig validiert und hier abgelehnt
  // werden.
  const { url, close } = await startServer((req, res) => {
    res.writeHead(302, { Location: 'http://10.0.0.5/evil' });
    res.end();
  });
  try {
    await expectCode(safeFetchPage(`${url}/start`, { allowLoopbackForTest: true }), 'blocked_target');
  } finally {
    await close();
  }
});

test('safeFetchPage: DNS-Rebinding wird verhindert', async (t) => {
  await t.test('Hostname löst auf private IP auf -> blocked_target', async () => {
    const dnsLookupMock = t.mock.method(dns, 'lookup', (hostname, options, cb) => {
      if (typeof options === 'function') { cb = options; }
      cb(null, [{ address: '10.1.2.3', family: 4 }]);
    });
    try {
      await expectCode(safeFetchPage('http://rebind.example.invalid/'), 'blocked_target');
    } finally {
      dnsLookupMock.mock.restore();
    }
  });

  await t.test('eine von mehreren Adressen ist blockiert -> gesamte Auflösung wird abgelehnt', async () => {
    const dnsLookupMock = t.mock.method(dns, 'lookup', (hostname, options, cb) => {
      if (typeof options === 'function') { cb = options; }
      cb(null, [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    });
    try {
      await expectCode(safeFetchPage('http://mixed.example.invalid/'), 'blocked_target');
    } finally {
      dnsLookupMock.mock.restore();
    }
  });
});

test('safeFetchPage: Timeout', async () => {
  const { url, close } = await startServer((req, res) => {
    // Antwortet absichtlich nicht.
  });
  try {
    await expectCode(safeFetchPage(url, { allowLoopbackForTest: true, timeoutMs: 200 }), 'fetch_timeout');
  } finally {
    await close();
  }
});

test('safeFetchPage: zu große Antwort wird abgebrochen (too_large)', async () => {
  let destroyed = false;
  const { url, close } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    req.on('close', () => { destroyed = true; });
    // Schreibt weit mehr als das Limit in wiederholten Chunks.
    const chunk = Buffer.alloc(64 * 1024, 'a');
    const interval = setInterval(() => {
      if (res.destroyed) { clearInterval(interval); return; }
      res.write(chunk);
    }, 5);
    res.on('close', () => clearInterval(interval));
  });
  try {
    await expectCode(safeFetchPage(url, { allowLoopbackForTest: true, maxBytes: 100 * 1024 }), 'too_large');
  } finally {
    await close();
  }
});

test('safeFetchPage: nicht unterstützter Content-Type wird abgelehnt', async () => {
  const { url, close } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
  try {
    await expectCode(safeFetchPage(url, { allowLoopbackForTest: true }), 'unsupported_content_type');
  } finally {
    await close();
  }
});

test('safeFetchPage: mehr als maxRedirects Hops wird abgelehnt', async () => {
  const { url, close } = await startServer((req, res) => {
    const n = Number((req.url || '/0').slice(1)) || 0;
    res.writeHead(302, { Location: `/${n + 1}` });
    res.end();
  });
  try {
    await expectCode(safeFetchPage(`${url}/0`, { allowLoopbackForTest: true, maxRedirects: 2 }), 'too_many_redirects');
  } finally {
    await close();
  }
});

test('safeFetchPage: HTTP-Fehlerstatus wird als fetch_http_error gemeldet', async () => {
  const { url, close } = await startServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end('server error');
  });
  try {
    await assert.rejects(safeFetchPage(url, { allowLoopbackForTest: true }), (err) => {
      assert.equal(err.code, 'fetch_http_error');
      assert.equal(err.status, 500);
      return true;
    });
  } finally {
    await close();
  }
});

test('SafeFetchError: exportiert und trägt code/status', () => {
  const err = new SafeFetchError('fetch_http_error', 'x', 503);
  assert.equal(err.code, 'fetch_http_error');
  assert.equal(err.status, 503);
  assert.ok(err instanceof Error);
});

// ── Nachbesserung nach Security Review: IPv6-Uebersetzungspraefixe ──────
test('isBlockedAddress: IPv4-kompatible IPv6 (::a.b.c.d) wird geblockt', () => {
  assert.equal(isBlockedAddress('::7f00:1', 6), true); // ::127.0.0.1
});
test('isBlockedAddress: IPv4-translated (::ffff:0:a.b.c.d) wird geblockt', () => {
  assert.equal(isBlockedAddress('::ffff:0:7f00:1', 6), true);
});
test('isBlockedAddress: NAT64 (64:ff9b::/96) wird komplett geblockt', () => {
  // net.BlockList kann nur den IPv6-Prefix pruefen, nicht die darin
  // eingebettete IPv4-Adresse semantisch entpacken - der gesamte NAT64-
  // Bereich wird deshalb bewusst pauschal geblockt (Over-Blocking als
  // sichere Seite), auch wenn einzelne eingebettete Adressen oeffentlich
  // waeren.
  assert.equal(isBlockedAddress('64:ff9b::7f00:1', 6), true); // eingebettet: 127.0.0.1
  assert.equal(isBlockedAddress('64:ff9b::0808:0808', 6), true); // eingebettet: 8.8.8.8 - dennoch geblockt (ganzer Bereich)
});
test('isBlockedAddress: 6to4 (2002::/16) wird geblockt', () => {
  assert.equal(isBlockedAddress('2002:7f00:1::', 6), true);
});
test('isBlockedAddress: 6to4-Relay-Anycast (192.88.99.0/24) wird geblockt', () => {
  assert.equal(isBlockedAddress('192.88.99.5', 4), true);
});
test('isBlockedAddress: vollstaendig ausgeschriebene IPv4-mapped-Form wird erkannt', () => {
  assert.equal(isBlockedAddress('0:0:0:0:0:ffff:127.0.0.1', 6), true);
});
test('isBlockedAddress: oeffentliche Adressen bleiben unberuehrt', () => {
  assert.equal(isBlockedAddress('8.8.8.8', 4), false);
  assert.equal(isBlockedAddress('2001:4860:4860::8888', 6), false);
});

test('isBlockedAddress: weitere gueltige Zwischenformen von IPv4-mapped IPv6 werden erkannt', () => {
  // Regression aus dem zweiten Security-Re-Review: nur die komprimierte
  // ("::ffff:...") und die voll ausgeschriebene Form wurden zunaechst
  // erkannt, nicht beliebige weitere gueltige Textvarianten derselben Adresse.
  assert.equal(isBlockedAddress('::0:ffff:7f00:1', 6), true);
  assert.equal(isBlockedAddress('0::ffff:127.0.0.1', 6), true);
  assert.equal(isBlockedAddress('0:0::ffff:127.0.0.1', 6), true);
});
