(() => {
  // Бесплатная карта без API-ключа: MapLibre + OpenFreeMap.
  // Только карта пассажира A -> B. Мониторинга водителя здесь нет.
  const S = {
    p: null,
    m: null,
    routeLayer: null,
    a: { lat: null, lng: null },
    b: { lat: null, lng: null },
    f: 'pickup',
    markers: {},
    t: {}
  };

  function css() {
    if (document.getElementById('freeTaxiMapCss')) return;
    const s = document.createElement('style');
    s.id = 'freeTaxiMapCss';
    s.textContent = `
      .taxi-map-card{margin-top:12px;padding:12px;border-radius:20px;background:#0d1421;border:1px solid #29364d}
      .taxi-map-title{font-size:13px;font-weight:900;margin-bottom:10px;display:flex;justify-content:space-between}
      .taxi-map-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
      .taxi-map-actions button{height:40px;border-radius:12px;background:#151f2f;border:1px solid #2a3850;color:#fff;font-size:11px;font-weight:850}
      .taxi-map-actions button.active{background:#facc15;color:#17120a}
      .taxi-map-location{width:100%;height:42px;border:0;border-radius:12px;background:#facc15;color:#17120a;font-size:11px;font-weight:900;margin-bottom:8px}
      .taxi-map{width:100%;height:245px;border-radius:16px;overflow:hidden;background:#111827}
      .taxi-map-loading{height:100%;display:flex;align-items:center;justify-content:center;color:#8b98aa;font-size:11px;text-align:center;padding:15px}
      .taxi-route-info{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
      .taxi-route-stat{background:#151f2f;border:1px solid #26354c;border-radius:12px;padding:8px;text-align:center}
      .taxi-route-stat b{display:block;font-size:15px}.taxi-route-stat span{font-size:9px;color:#8290a7}
      .taxi-price-box{margin-top:8px;padding:11px;border-radius:13px;background:rgba(250,204,21,.08);border:1px solid rgba(250,204,21,.2);display:flex;justify-content:space-between;align-items:center}
      .taxi-price-box span{font-size:10px;color:#9aa7b9}.taxi-price-box strong{font-size:18px;color:#facc15}
      .taxi-map-error{padding:18px;color:#ff9b9b;font-size:11px;text-align:center;line-height:1.5}
      .taxi-map .maplibregl-ctrl-group{background:#151f2f;border:1px solid #2a3850}.taxi-map .maplibregl-ctrl button{filter:invert(1)}
      @media(max-width:430px){.taxi-map{height:220px}}
    `;
    document.head.appendChild(s);
  }

  function ui() {
    const f = document.getElementById('orderForm');
    if (!f || document.getElementById('passengerMapCard')) return;
    const c = document.createElement('div');
    c.id = 'passengerMapCard';
    c.className = 'taxi-map-card';
    c.innerHTML = `
      <div class="taxi-map-title"><span>🗺 Маршрут</span><span id="mapDistanceMini" style="color:#facc15">—</span></div>
      <div class="taxi-map-actions">
        <button id="mapPickupBtn" class="active" type="button">📍 Точка A · Откуда</button>
        <button id="mapDestinationBtn" type="button">🏁 Точка B · Куда</button>
      </div>
      <button id="mapLocateBtn" class="taxi-map-location" type="button">📍 Моё местоположение</button>
      <div id="passengerMap" class="taxi-map"><div class="taxi-map-loading">Загрузка карты…</div></div>
      <div class="taxi-route-info">
        <div class="taxi-route-stat"><b id="routeDistance">—</b><span>расстояние</span></div>
        <div class="taxi-route-stat"><b id="routeDuration">—</b><span>примерное время</span></div>
      </div>
      <div class="taxi-price-box"><span>3 BYN + 1 BYN / км</span><strong id="routePrice">—</strong></div>
    `;
    f.insertBefore(c, f.firstChild);
    document.getElementById('mapPickupBtn').onclick = () => { S.f = 'pickup'; act(); };
    document.getElementById('mapDestinationBtn').onclick = () => { S.f = 'destination'; act(); };
    document.getElementById('mapLocateBtn').onclick = locate;
  }

  function act() {
    document.getElementById('mapPickupBtn')?.classList.toggle('active', S.f === 'pickup');
    document.getElementById('mapDestinationBtn')?.classList.toggle('active', S.f === 'destination');
    init();
  }

  function load() {
    if (window.maplibregl) return Promise.resolve();
    if (S.p) return S.p;
    S.p = new Promise((resolve, reject) => {
      if (!document.querySelector('link[data-maplibre]')) {
        const l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css'; l.dataset.maplibre = '1';
        document.head.appendChild(l);
      }
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js';
      s.onload = resolve; s.onerror = () => reject(new Error('Не удалось загрузить MapLibre'));
      document.head.appendChild(s);
    });
    return S.p;
  }

  function stats(km, min) {
    const d = km == null ? '—' : Number(km).toFixed(1) + ' км';
    document.getElementById('routeDistance')?.replaceChildren(d);
    document.getElementById('mapDistanceMini')?.replaceChildren(d);
    document.getElementById('routeDuration')?.replaceChildren(min == null ? '—' : Math.max(1, Math.round(min)) + ' мин');
    let price = null;
    if (km != null) price = 3 + Math.ceil(Number(km) * 10) / 10;
    document.getElementById('routePrice')?.replaceChildren(price == null ? '—' : price.toFixed(1) + ' BYN');
    window.taxiRouteDistanceKm = km == null ? null : Number(km);
    window.taxiRoutePrice = price;
  }

  function popupHtml(letter, address) {
    return `<b>${letter}</b>${address ? '<br><span style="font-size:11px">' + String(address).replace(/[<>]/g, '') + '</span>' : ''}`;
  }

  async function reverse(lat, lng, field) {
    try {
      const u = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=18&addressdetails=1`;
      const r = await fetch(u, { headers: { 'Accept': 'application/json' } });
      if (!r.ok) return '';
      const x = await r.json();
      const a = x.display_name || '';
      const i = document.getElementById(field === 'pickup' ? 'addressA' : 'addressB');
      if (i && a) i.value = a;
      return a;
    } catch (_) { return ''; }
  }

  async function geo(q) {
    if (!q || q.trim().length < 3) return null;
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=by&viewbox=30.1,52.5,30.7,52.1&bounded=0&q=${encodeURIComponent(q)}`;
      const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!r.ok) return null;
      const rows = await r.json();
      if (!rows.length) return null;
      return { lat: Number(rows[0].lat), lng: Number(rows[0].lon) };
    } catch (_) { return null; }
  }

  function marker(field, lat, lng, address) {
    if (!S.m) return;
    const color = field === 'pickup' ? '#facc15' : '#22c55e';
    const el = document.createElement('div');
    el.style.cssText = `width:22px;height:22px;border-radius:50%;background:${color};border:4px solid #fff;box-shadow:0 2px 10px #0008;cursor:grab`;
    el.title = field === 'pickup' ? 'Точка A' : 'Точка B';
    el.dataset.taxiMarker = field;
    el.onclick = e => e.stopPropagation();
    if (S.markers[field]) S.markers[field].remove();
    const m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([lng, lat]).setPopup(new maplibregl.Popup({ offset: 14 }).setHTML(popupHtml(field === 'pickup' ? 'A' : 'B', address))).addTo(S.m);
    m.on('dragend', async () => {
      const p = m.getLngLat();
      const o = field === 'pickup' ? S.a : S.b;
      o.lat = p.lat; o.lng = p.lng;
      const a = await reverse(p.lat, p.lng, field);
      m.setPopup(new maplibregl.Popup({ offset: 14 }).setHTML(popupHtml(field === 'pickup' ? 'A' : 'B', a))).addTo(S.m);
      route();
    });
    S.markers[field] = m;
  }

  async function point(field, lat, lng, address) {
    const o = field === 'pickup' ? S.a : S.b;
    o.lat = Number(lat); o.lng = Number(lng);
    let a = address || '';
    if (!a) a = await reverse(o.lat, o.lng, field);
    if (S.m) {
      marker(field, o.lat, o.lng, a);
      S.m.flyTo({ center: [o.lng, o.lat], zoom: 15, speed: 1.2 });
      route();
    }
  }

  async function route() {
    clearTimeout(S.t.r);
    S.t.r = setTimeout(async () => {
      if (S.a.lat == null || S.b.lat == null || !S.m) return;
      try {
        const url = `https://router.project-osrm.org/route/v1/driving/${S.a.lng},${S.a.lat};${S.b.lng},${S.b.lat}?overview=full&geometries=geojson&steps=false`;
        const r = await fetch(url);
        if (!r.ok) throw new Error('Маршрут недоступен');
        const data = await r.json();
        const x = data.routes?.[0];
        if (!x) throw new Error('Маршрут не найден');
        if (S.m.getSource('taxi-route')) S.m.removeLayer('taxi-route');
        if (S.m.getSource('taxi-route')) S.m.removeSource('taxi-route');
        S.m.addSource('taxi-route', { type: 'geojson', data: { type: 'Feature', geometry: x.geometry, properties: {} } });
        S.m.addLayer({ id: 'taxi-route', type: 'line', source: 'taxi-route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#facc15', 'line-width': 5, 'line-opacity': 0.9 } });
        const b = new maplibregl.LngLatBounds();
        x.geometry.coordinates.forEach(c => b.extend(c));
        S.m.fitBounds(b, { padding: 45, maxZoom: 16, duration: 500 });
        stats(x.distance / 1000, x.duration / 60);
      } catch (e) {
        console.error(e); stats(null, null);
      }
    }, 200);
  }

  async function choose(c) {
    await point(S.f, c[1], c[0]);
  }

  function init() {
    const e = document.getElementById('passengerMap');
    if (!e || S.m) return;
    e.innerHTML = '<div class="taxi-map-loading">Загрузка карты…</div>';
    load().then(() => {
      e.innerHTML = '';
      S.m = new maplibregl.Map({
        container: 'passengerMap',
        style: 'https://tiles.openfreemap.org/styles/liberty',
        center: [30.39, 52.36],
        zoom: 13,
        attributionControl: true
      });
      S.m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      S.m.on('click', x => choose([x.lngLat.lng, x.lngLat.lat]));
      S.m.on('load', () => {
        if (S.a.lat != null) point('pickup', S.a.lat, S.a.lng);
        if (S.b.lat != null) point('destination', S.b.lat, S.b.lng);
      });
    }).catch(err => {
      e.innerHTML = `<div class="taxi-map-error">🗺 Карта не загрузилась.<br><br>${err.message}</div>`;
    });
  }

  function locate() {
    if (!navigator.geolocation) return;
    const b = document.getElementById('mapLocateBtn');
    if (b) b.textContent = '⏳ Определяем…';
    navigator.geolocation.getCurrentPosition(async p => {
      S.f = 'pickup'; act();
      await new Promise(r => setTimeout(r, 100));
      await point('pickup', p.coords.latitude, p.coords.longitude);
      if (b) b.textContent = '📍 Моё местоположение';
    }, () => {
      if (b) b.textContent = '📍 Не удалось определить';
      setTimeout(() => { if (b) b.textContent = '📍 Моё местоположение'; }, 1800);
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  }

  function bind() {
    [['addressA', 'pickup'], ['addressB', 'destination']].forEach(([id, f]) => {
      const i = document.getElementById(id);
      if (!i || i.dataset.freeMapBound) return;
      i.dataset.freeMapBound = '1';
      i.addEventListener('focus', () => { S.f = f; act(); });
      i.addEventListener('change', () => {
        clearTimeout(S.t[f]);
        S.t[f] = setTimeout(async () => {
          const p = await geo(i.value);
          if (p) point(f, p.lat, p.lng, i.value);
        }, 150);
      });
      i.addEventListener('blur', () => {
        clearTimeout(S.t[f]);
        S.t[f] = setTimeout(async () => {
          const p = await geo(i.value);
          if (p) point(f, p.lat, p.lng, i.value);
        }, 100);
      });
    });
  }

  function boot() { css(); ui(); bind(); init(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  new MutationObserver(() => { ui(); bind(); }).observe(document.body, { childList: true, subtree: true });
})();
