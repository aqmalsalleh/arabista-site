/**
 * Arabista v2.43 — GitHub Pages → Apps Script public facade client.
 * Uses JSONP against the Anyone-anonymous /exec deployment because nested
 * Google HtmlService iframes cannot reliably receive parent postMessage.
 */
(function (global) {
  'use strict';

  var seq = 0;
  var bridgeUrl = '';
  var ready = false;

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

  function mount(url) {
    bridgeUrl = String(url || '').trim();
    if (!validExecUrl(bridgeUrl)) {
      return Promise.reject(new Error('bridge_url_invalid'));
    }
    return call('arabistaV243PublicFacadeCapabilities', null).then(function (caps) {
      if (!caps || caps.ok !== true) {
        throw new Error((caps && caps.reason) || 'facade_unavailable');
      }
      ready = true;
      return caps;
    });
  }

  function call(name, args) {
    if (!bridgeUrl) return Promise.reject(new Error('bridge_url_missing'));
    return new Promise(function (resolve, reject) {
      var cb = 'arabistaV243Cb_' + String(++seq) + '_' + Date.now();
      var settled = false;
      function finish(fn, value) {
        if (settled) return;
        settled = true;
        try { delete global[cb]; } catch (e) {}
        if (script && script.parentNode) script.parentNode.removeChild(script);
        fn(value);
      }
      global[cb] = function (result) { finish(resolve, result); };
      var script = document.createElement('script');
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
      }, 60000);
      document.head.appendChild(script);
    });
  }

  global.ArabistaV243Bridge = {
    mount: mount,
    call: call,
    isReady: function () { return ready; }
  };
})(window);
