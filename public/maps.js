(() => {
  const S = { map:null, a:null, b:null, ma:null, mb:null, route:null, field:'pickup', timer:null, leaflet:null };

  function css(){
    if(document.getElementById('taxiOldMapCss')) return;
    const s=document.createElement('style'); s.id='taxiOldMapCss';
    s.textContent=`
      .taxi-map-card{margin-top:12px;padding:12px;border-radius:20px;background:#0d1421;border:1px solid #29364d}
      .taxi-map-title{font-size:13px;font-weight:900;margin-bottom:10px;display:flex;justify-content:space-between}
      .taxi-map-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
      .taxi-map-actions button,.taxi-map-location{height:40px;border-radius:12px;background:#151f2f;border:1px solid #2a3850;color:#fff;font-size:11px;font-weight:850}
      .taxi-map-actions button.active{background:#facc15;color:#17120a}
      .taxi-map-location{width:100%;margin-bottom:8px}
      .taxi-map{width:100%;height:245px;border-radius:16px;overflow:hidden;background:#0b1118}
      .taxi-map-loading{height:100%;display:flex;align-items:center;justify-content:center;color:#8b98aa;font-size:11px}
      .taxi-route-info{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
      .taxi-route-stat{background:#151f2f;border:1px solid #26354c;border-radius:12px;padding:8px;text-align:center}
      .taxi-route-stat b{display:block;font-size:15px}.taxi-route-stat span{font-size:9px;color:#8290a7}
      .taxi-price-box{margin-top:8px;padding:11px;border-radius:13px;background:rgba(250,204,21,.08);border:1px solid rgba(250,204,21,.2);display:flex;justify-content:space-between}
      .taxi-price-box span{font-size:10px;color:#9aa7b9}.taxi-price-box strong{font-size:18px;color:#facc15}
      .taxi-map-dark .leaflet-tile{filter:brightness(.58) saturate(.75) contrast(1.05)}
      .taxi-map-dark .leaflet-control-zoom,.taxi-map-dark .leaflet-control-attribution{background:#151f2f;color:#9aa7b9;border-color:#2a3850}
      .taxi-map-dark .leaflet-control-zoom a{background:#151f2f;color:#fff;border-color:#2a3850}
      .taxi-map-dark .leaflet-control-attribution a{color:#facc15}
      @media(max-width:430px){.taxi-map{height:220px}}
    `; document.head.appendChild(s);
  }

  function loadLeaflet(){
    if(window.L) return Promise.resolve();
    if(S.leaflet) return S.leaflet;
    S.leaflet=new Promise((ok,no)=>{
      if(!document.querySelector('link[data-taxi-leaflet]')){
        const l=document.createElement('link');l.rel='stylesheet';l.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';l.dataset.taxiLeaflet='1';document.head.appendChild(l);
      }
      const x=document.createElement('script');x.src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';x.onload=ok;x.onerror=()=>no(Error('Leaflet не загрузился'));document.head.appendChild(x);
    });
    return S.leaflet;
  }

  function ui(){
    const f=document.getElementById('orderForm'); if(!f||document.getElementById('passengerMapCard')) return;
    const c=document.createElement('div');c.id='passengerMapCard';c.className='taxi-map-card';
    c.innerHTML=`<div class="taxi-map-title"><span>🗺 Карта маршрута</span><span id="mapDistanceMini" style="color:#facc15">—</span></div>
      <div class="taxi-map-actions"><button id="mapPickupBtn" class="active" type="button">📍 A · Откуда</button><button id="mapDestinationBtn" type="button">🏁 B · Куда</button></div>
      <button id="mapLocateBtn" class="taxi-map-location" type="button">📍 Моё местоположение</button>
      <div id="passengerMap" class="taxi-map taxi-map-dark"><div class="taxi-map-loading">Загрузка карты…</div></div>
      <div class="taxi-route-info"><div class="taxi-route-stat"><b id="routeDistance">—</b><span>расстояние</span></div><div class="taxi-route-stat"><b id="routeDuration">—</b><span>примерное время</span></div></div>
      <div class="taxi-price-box"><span>3 BYN + 1 BYN / км</span><strong id="routePrice">—</strong></div>`;
    f.insertBefore(c,f.firstChild);
    document.getElementById('mapPickupBtn').onclick=()=>{S.field='pickup';active()};
    document.getElementById('mapDestinationBtn').onclick=()=>{S.field='destination';active()};
    document.getElementById('mapLocateBtn').onclick=locate;
  }

  function active(){
    document.getElementById('mapPickupBtn')?.classList.toggle('active',S.field==='pickup');
    document.getElementById('mapDestinationBtn')?.classList.toggle('active',S.field==='destination');
  }

  function stats(km,min){
    const d=km==null?'—':Number(km).toFixed(1)+' км';
    document.getElementById('routeDistance')?.replaceChildren(d);document.getElementById('mapDistanceMini')?.replaceChildren(d);
    document.getElementById('routeDuration')?.replaceChildren(min==null?'—':Math.max(1,Math.round(min))+' мин');
    const price=km==null?null:3+Math.ceil(Number(km)*10)/10;
    document.getElementById('routePrice')?.replaceChildren(price==null?'—':price.toFixed(1)+' BYN');
    window.taxiRouteDistanceKm=km==null?null:Number(km);window.taxiRoutePrice=price;
  }

  function reverse(lat,lng,type){
    return fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat='+lat+'&lon='+lng+'&zoom=18&addressdetails=1',{headers:{Accept:'application/json'}})
      .then(r=>r.json()).then(x=>{const a=x.display_name||'';const i=document.getElementById(type==='pickup'?'addressA':'addressB');if(i&&a)i.value=a;return a}).catch(()=>null);
  }

  function geocode(q){
    if(!q||q.trim().length<3)return Promise.resolve(null);
    return fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=by&q='+encodeURIComponent(q),{headers:{Accept:'application/json'}})
      .then(r=>r.json()).then(a=>a[0]?{lat:+a[0].lat,lng:+a[0].lon}:null).catch(()=>null);
  }

  function setPoint(type,lat,lng,address){
    const p={lat:+lat,lng:+lng}; if(type==='pickup')S.a=p; else S.b=p;
    const input=document.getElementById(type==='pickup'?'addressA':'addressB'); if(input&&address)input.value=address;
    if(!S.map){init();return;}
    const marker=type==='pickup'?S.ma:S.mb;
    if(marker) marker.setLatLng([p.lat,p.lng]);
    else{
      const m=L.marker([p.lat,p.lng],{draggable:true}).addTo(S.map);
      m.bindTooltip(type==='pickup'?'A':'B',{permanent:true,direction:'top',offset:[0,-8]});
      m.on('dragend',()=>{const q=m.getLatLng();if(type==='pickup')S.a={lat:q.lat,lng:q.lng};else S.b={lat:q.lat,lng:q.lng};reverse(q.lat,q.lng,type);route()});
      if(type==='pickup')S.ma=m;else S.mb=m;
    }
    S.map.flyTo([p.lat,p.lng],15,{duration:.25}); route();
  }

  function route(){
    clearTimeout(S.timer);S.timer=setTimeout(()=>{
      if(!S.a||!S.b||!S.map)return;
      const u='https://router.project-osrm.org/route/v1/driving/'+S.a.lng+','+S.a.lat+';'+S.b.lng+','+S.b.lat+'?overview=full&geometries=geojson&steps=false';
      fetch(u).then(r=>r.json()).then(x=>{const z=x.routes?.[0];if(!z)return;stats(z.distance/1000,z.duration/60);if(S.route)S.map.removeLayer(S.route);S.route=L.geoJSON(z.geometry,{style:{color:'#facc15',weight:5,opacity:.9}}).addTo(S.map);S.map.fitBounds(S.route.getBounds(),{padding:[35,35],maxZoom:16})}).catch(()=>stats(null,null));
    },250);
  }

  function choose(e){setPoint(S.field,e.latlng.lat,e.latlng.lng);reverse(e.latlng.lat,e.latlng.lng,S.field)}

  function init(){
    const e=document.getElementById('passengerMap');if(!e||S.map)return;
    loadLeaflet().then(()=>{
      e.innerHTML='';
      S.map=L.map('passengerMap',{zoomControl:true,attributionControl:true}).setView([52.36,30.39],13);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(S.map);
      S.map.on('click',choose);
      if(S.a)setPoint('pickup',S.a.lat,S.a.lng);if(S.b)setPoint('destination',S.b.lat,S.b.lng);
    }).catch(()=>{e.innerHTML='<div class="taxi-map-loading">Не удалось загрузить карту. Проверьте интернет.</div>'});
  }

  function locate(){
    if(!navigator.geolocation)return;const b=document.getElementById('mapLocateBtn');if(b)b.textContent='⏳ Определяем…';
    navigator.geolocation.getCurrentPosition(p=>{S.field='pickup';active();setPoint('pickup',p.coords.latitude,p.coords.longitude);reverse(p.coords.latitude,p.coords.longitude,'pickup');if(b)b.textContent='📍 Моё местоположение'},()=>{if(b)b.textContent='📍 Не удалось определить';setTimeout(()=>{if(b)b.textContent='📍 Моё местоположение'},1800)},{enableHighAccuracy:true,timeout:10000,maximumAge:30000});
  }

  function bind(){
    [['addressA','pickup'],['addressB','destination']].forEach(([id,f])=>{const i=document.getElementById(id);if(!i||i.dataset.oldMapBound)return;i.dataset.oldMapBound='1';i.addEventListener('focus',()=>{S.field=f;active()});['change','blur'].forEach(ev=>i.addEventListener(ev,()=>setTimeout(()=>geocode(i.value).then(p=>p&&setPoint(f,p.lat,p.lng,i.value)),100)))});
  }

  function boot(){css();ui();bind();init()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
  new MutationObserver(()=>{ui();bind()}).observe(document.body,{childList:true,subtree:true});
})();