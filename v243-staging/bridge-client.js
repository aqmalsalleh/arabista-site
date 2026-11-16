/**
 * Arabista v2.43 — GitHub Pages → Apps Script public facade client.
 * Uses JSONP against the Anyone-anonymous /exec deployment because nested
 * Google HtmlService iframes cannot reliably receive parent postMessage.
 *
 * Mount validates the facade URL and becomes callable without waiting for a
 * capabilities round-trip. Capabilities refresh runs asynchronously.
 */
(function (global) {
  'use strict';

  var seq = 0;
  var bridgeUrl = '';
  var ready = false;
  var lastCapabilities = null;
  var READ_TIMEOUT_MS = 20000;
  var WRITE_TIMEOUT_MS = 60000;

  function validExecUrl(url) {
    try {
      var u = new URL(url);
      return u.origin === 'https://script.google.com'
        && /^\/macros\/s\/[A-Za-z0-9_-]+\/exec\/?$/.test(u.pathname)
        && !u.username && !u.password;
    } catch (e) {
      return false;
    }
  }

  function defaultTimeoutFor(name) {
    name = String(name || '');
    if (/PrepareSandbox|CheckoutExecute|CreatePayment|Reconcile|Remint|Settle/i.test(name)) {
      return WRITE_TIMEOUT_MS;
    }
    return READ_TIMEOUT_MS;
  }

  function mount(url) {
    bridgeUrl = String(url || '').trim();
    if (!validExecUrl(bridgeUrl)) {
      ready = false;
      return Promise.reject(new Error('bridge_url_invalid'));
    }
    ready = true;
    // Non-blocking diagnostics — must not gate UI or Discover/Shop reads.
    call('arabistaV243PublicFacadeCapabilities', null, { timeoutMs: 15000 })
      .then(function (caps) { lastCapabilities = caps; })
      .catch(function () { /* keep transport usable */ });
    return Promise.resolve({
      ok: true,
      mounted: true,
      capabilities_pending: true,
      facade_url_host: 'script.google.com'
    });
  }

  function call(name, args, opts) {
    opts = opts || {};
    if (!bridgeUrl || !ready) return Promise.reject(new Error('bridge_not_ready'));
    var timeoutMs = opts.timeoutMs != null ? Number(opts.timeoutMs) : defaultTimeoutFor(name);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) timeoutMs = READ_TIMEOUT_MS;
    return new Promise(function (resolve, reject) {
      var cb = 'arabistaV243Cb_' + String(++seq) + '_' + Date.now();
      var settled = false;
      var script = document.createElement('script');
      function finish(fn, value) {
        if (settled) return;
        settled = true;
        try { delete global[cb]; } catch (e) {}
        if (script && script.parentNode) script.parentNode.removeChild(script);
        fn(value);
      }
      global[cb] = function (result) { finish(resolve, result); };
      var params = new URLSearchParams();
      params.set('format', 'jsonp');
      params.set('rpc', String(name || ''));
      params.set('callback', cb);
      if (args !== undefined) params.set('args', JSON.stringify(args === undefined ? null : args));
      script.src = bridgeUrl + (bridgeUrl.indexOf('?') >= 0 ? '&' : '?') + params.toString();
      script.async = true;
      script.onerror = function () { finish(reject, new Error('jsonp_transport_failed')); };
      setTimeout(function () {
        finish(reject, new Error('rpc_timeout'));
      }, timeoutMs);
      document.head.appendChild(script);
    });
  }

  global.ArabistaV243Bridge = {
    mount: mount,
    call: call,
    isReady: function () { return ready === true && !!bridgeUrl; },
    getCapabilities: function () { return lastCapabilities; },
    validExecUrl: validExecUrl
  };
})(window);
