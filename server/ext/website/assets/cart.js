// The store's cart, in this browser only (localStorage). It keeps product
// ids, sizes and how many — never prices: the server prices every line
// (POST …/store/quote) and again at checkout (POST …/store/checkout).
(function () {
  'use strict';
  var KEY = 'site-cart-v1';
  var base = document.body.getAttribute('data-base') || '';

  function read() {
    try { var v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function write(items) {
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) { /* storage blocked */ }
    badge();
  }
  function count() { return read().reduce(function (a, i) { return a + (Number(i.qty) || 0); }, 0); }
  function badge() {
    var n = count();
    document.querySelectorAll('.cart-n').forEach(function (el) { el.textContent = n > 0 ? String(n) : ''; });
    document.querySelectorAll('.cart-link').forEach(function (el) { el.setAttribute('aria-label', 'Cart' + (n ? ', ' + n + ' item' + (n === 1 ? '' : 's') : '')); });
  }
  function money(c) {
    return '$' + (c / 100).toLocaleString('en-CA', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; });
  }
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; }); });
  }

  // ── Product page: gallery + add to cart ──
  var main = document.querySelector('.gallery-main img');
  document.querySelectorAll('.thumbs button').forEach(function (b) {
    b.addEventListener('click', function () {
      if (main) { main.src = b.getAttribute('data-src'); }
      document.querySelectorAll('.thumbs button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    });
  });
  var buy = document.getElementById('buy');
  if (buy) {
    buy.addEventListener('submit', function (e) {
      e.preventDefault();
      var size = buy.querySelector('input[name=variant]:checked');
      var hasSizes = !!buy.querySelector('input[name=variant]');
      var msg = buy.querySelector('.added');
      if (hasSizes && !size) { msg.textContent = 'Pick a size first.'; msg.style.color = 'var(--bad)'; return; }
      var qty = Math.max(1, Math.min(20, parseInt(buy.querySelector('[name=qty]').value, 10) || 1));
      var items = read();
      var id = buy.getAttribute('data-product');
      var variant = size ? size.value : '';
      var hit = items.filter(function (i) { return i.product_id === id && (i.variant || '') === variant; })[0];
      if (hit) hit.qty = Math.min(20, (Number(hit.qty) || 0) + qty); else items.push({ product_id: id, variant: variant, qty: qty });
      write(items);
      msg.style.color = '';
      msg.innerHTML = 'Added to your cart · <a href="' + base + '/cart">View cart</a>';
    });
  }

  // ── Cart page ──
  var cart = document.getElementById('cart');
  function renderCart() {
    var items = read();
    var open = cart.getAttribute('data-open') === '1';
    if (!items.length) {
      cart.innerHTML = '<p class="empty">Your cart is empty.</p><a class="btn btn-accent" href="' + base + '/store">Shop the store</a>';
      return;
    }
    post(base + '/store/quote', { items: items }).then(function (q) {
      if (q._status !== 200) { cart.innerHTML = '<p class="cart-err">The cart couldn’t load — try again.</p>'; return; }
      var probs = {};
      (q.problems || []).forEach(function (p) { probs[p.product_id + '|' + (p.variant || '')] = p.error; });
      // Lines the store no longer sells drop out of the cart.
      var keep = items.filter(function (i) {
        return q.lines.some(function (l) { return l.product_id === i.product_id && l.variant === (i.variant || ''); });
      });
      if (keep.length !== items.length) write(keep);
      var ways = q.ways || [];
      var chosen = cart.getAttribute('data-way') || (ways[0] && ways[0].code) || '';
      var way = ways.filter(function (w) { return w.code === chosen; })[0] || ways[0];
      var shipping = way ? way.cents : 0;
      var html = '<ul class="cart-lines">' + q.lines.map(function (l, n) {
        var err = probs[l.product_id + '|' + l.variant];
        return '<li class="cart-line">' +
          (l.image ? '<img src="/media/' + esc(l.image) + '" alt="" loading="lazy">' : '<span class="ph"></span>') +
          '<div><h3><a href="' + base + '/store/' + esc(l.slug) + '">' + esc(l.name) + '</a></h3>' +
          '<div class="meta">' + (l.variant ? esc(l.variant) + ' · ' : '') + money(l.unit_cents) + ' each</div>' +
          (err ? '<div class="err">' + esc(err) + '</div>' : '') +
          '<div class="q"><button type="button" data-n="' + n + '" data-d="-1" aria-label="One less">−</button><span aria-live="polite">' + l.qty +
          '</span><button type="button" data-n="' + n + '" data-d="1" aria-label="One more">+</button><button type="button" class="rm" data-n="' + n + '" data-d="x">Remove</button></div></div>' +
          '<div class="price">' + money(l.line_cents) + '</div></li>';
      }).join('') + '</ul>';
      if (ways.length > 1) {
        html += '<fieldset class="ways"><legend class="opt-label">How do you want it?</legend>' + ways.map(function (w) {
          return '<label><input type="radio" name="way" value="' + w.code + '"' + (way && w.code === way.code ? ' checked' : '') + '><span>' + esc(w.label) +
            '<small>' + esc(w.note) + '</small></span></label>';
        }).join('') + '</fieldset>';
      } else if (way) {
        html += '<p class="meta">' + esc(way.label) + ' · ' + esc(way.note) + '</p>';
      }
      html += '<div class="totals"><div><span>Items</span><span>' + money(q.subtotal_cents) + '</span></div>' +
        (shipping ? '<div><span>Shipping</span><span>' + money(shipping) + '</span></div>' : '') +
        '<div class="grand"><span>Total</span><span>' + money(q.subtotal_cents + shipping) + '</span></div></div>';
      if (!open) html += '<p class="notice">Online store opens soon.</p>';
      else if (q.problems && q.problems.length) html += '<p class="cart-err">Change the lines marked above to check out.</p>';
      else html += '<button type="button" class="btn btn-accent" id="checkout" style="width:100%">Check out</button><p class="meta" style="margin-top:10px">Secure card payment by Stripe.</p><p class="cart-err" id="co-err" role="alert"></p>';
      cart.innerHTML = html;
      cart.querySelectorAll('.q button').forEach(function (b) {
        b.addEventListener('click', function () {
          var l = q.lines[Number(b.getAttribute('data-n'))];
          var list = read();
          var it = list.filter(function (i) { return i.product_id === l.product_id && (i.variant || '') === l.variant; })[0];
          if (!it) return;
          var d = b.getAttribute('data-d');
          if (d === 'x') list = list.filter(function (i) { return i !== it; });
          else { it.qty = Math.max(0, Math.min(20, (Number(it.qty) || 0) + Number(d))); if (!it.qty) list = list.filter(function (i) { return i !== it; }); }
          write(list);
          renderCart();
        });
      });
      cart.querySelectorAll('input[name=way]').forEach(function (r) {
        r.addEventListener('change', function () { cart.setAttribute('data-way', r.value); renderCart(); });
      });
      var go = document.getElementById('checkout');
      if (go) go.addEventListener('click', function () {
        go.disabled = true; go.textContent = 'Opening checkout…';
        post(base + '/store/checkout', { items: read(), fulfilment: way ? way.code : 'ship' }).then(function (r) {
          if (r.url) { window.location.href = r.url; return; }
          go.disabled = false; go.textContent = 'Check out';
          document.getElementById('co-err').textContent = r.error || 'Checkout didn’t open — try again.';
        }, function () {
          go.disabled = false; go.textContent = 'Check out';
          document.getElementById('co-err').textContent = 'No answer — check your connection and try again.';
        });
      });
    });
  }
  if (cart) renderCart();

  // ── Thank-you page: the order is placed, so the cart empties ──
  if (document.querySelector('[data-clear-cart]')) write([]);
  badge();
})();
