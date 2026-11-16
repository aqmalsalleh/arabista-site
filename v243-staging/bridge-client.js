/**
 * Arabista v2.43 — GitHub Pages → Apps Script public bridge client.
 * Loads a hidden HtmlService iframe and relays RPC via postMessage.
 * No Google sign-in, no URL paste, no credentials in the browser.
 */
(function (global) {
  'use strict';

  var pending = Object.create(null);
  var seq = 0;
  var ready = false;
  var readyWaiters = [];
  var iframe = null;
  var bridgeOrigin = 'https://n-script.googleusercontent.com'; // tightened after first message
  var bridgeUrl = '';

  function whenReady() {
    if (ready) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error('bridge_ready_timeout'));
      }, 20000);
      readyWaiters.push(function () {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function onMessage(event) {
    var data = event.data;
    if (!data || data.channel !== 'arabista-v243') return;
    if (data.type === 'bridge-ready') {
      ready = true;
      bridgeOrigin = event.origin;
      var waiters = readyWaiters.splice(0);
      for (var i = 0; i < waiters.length; i += 1) waiters[i]();
      return;
    }
    if (data.type !== 'rpc-result') return;
    var entry = pending[data.id];
    if (!entry) return;
    delete pending[data.id];
    if (data.ok) entry.resolve(data.result);
    else entry.reject(new Error(data.error || 'rpc_failed'));
  }

  function mount(url) {
    bridgeUrl = String(url || '').trim();
    if (!bridgeUrl) return Promise.reject(new Error('bridge_url_missing'));
    if (iframe) return whenReady();
    window.addEventListener('message', onMessage);
    iframe = document.createElement('iframe');
    iframe.id = 'arabistaV243BridgeFrame';
    iframe.title = 'Arabista secure staging bridge';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.referrerPolicy = 'no-referrer';
    iframe.style.cssText = 'position:fixed;width:1px;height:1px;left:-9999px;top:0;opacity:0;border:0;pointer-events:none;';
    iframe.src = bridgeUrl;
    document.body.appendChild(iframe);
    return whenReady();
  }

  function call(name, args) {
    return whenReady().then(function () {
      return new Promise(function (resolve, reject) {
        var id = 'rpc_' + String(++seq) + '_' + Date.now();
        pending[id] = { resolve: resolve, reject: reject };
        try {
          iframe.contentWindow.postMessage({
            channel: 'arabista-v243',
            type: 'rpc',
            id: id,
            name: name,
            args: args === undefined ? null : args
          }, '*');
        } catch (err) {
          delete pending[id];
          reject(err);
        }
        setTimeout(function () {
          if (!pending[id]) return;
          delete pending[id];
          reject(new Error('rpc_timeout'));
        }, 60000);
      });
    });
  }

  global.ArabistaV243Bridge = {
    mount: mount,
    call: call,
    isReady: function () { return ready; }
  };
})(window);
