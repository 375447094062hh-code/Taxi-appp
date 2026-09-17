(() => {
    // Быстрая карта для Telegram Mini App.
    // Карта загружается лениво, тайлы — лёгкие, маршрут строится только после выбора A и B.
    const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    const LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    const NOMINATIM = "https://nominatim.openstreetmap.org";
    const ROUTER = "https://router.project-osrm.org/route/v1/driving";

    const state = {
        leafletPromise: null,
        map: null,
        trackingMap: null,
        driverMap: null,
        pickup: { lat: null, lng: null },
        destination: { lat: null, lng: null },
        activeField: "pickup",
        markers: {},
        route: null,
        trackingDriver: null,
        driverMarker: null,
        driverWatchId: null,
        lastDriverSent: 0,
        geocodeTimers: {},
        routeTimer: null,
        initialized: false
    };

    function loadLeaflet() {
        if (window.L) return Promise.resolve();
        if (state.leafletPromise) return state.leafletPromise;

        state.leafletPromise = new Promise((resolve, reject) => {
            if (!document.querySelector('link[data-taxi-leaflet]')) {
                const css = document.createElement("link");
                css.rel = "stylesheet";
                css.href = LEAFLET_CSS;
                css.dataset.taxiLeaflet = "1";
                document.head.appendChild(css);
            }
            const script = document.createElement("script");
            script.src = LEAFLET_JS;
            script.async = true;
            script.onload = resolve;
            script.onerror = () => reject(new Error("Leaflet load failed"));
            document.head.appendChild(script);
        });
        return state.leafletPromise;
    }

    function addStyles() {
        if (document.getElementById("taxiMapsStyles")) return;
        const style = document.createElement("style");
        style.id = "taxiMapsStyles";
        style.textContent = `
            .taxi-map-card{margin-top:12px;padding:12px;border-radius:20px;background:#0d1421;border:1px solid #29364d;box-shadow:0 10px 28px rgba(0,0,0,.2)}
            .taxi-map-title{font-size:13px;font-weight:900;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center}
            .taxi-map-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
            .taxi-map-actions button{height:40px;border-radius:12px;background:#151f2f;border:1px solid #2a3850;color:#fff;font-size:11px;font-weight:850}
            .taxi-map-actions button.active{background:#facc15;color:#17120a;border-color:#facc15}
            .taxi-map-location{width:100%;height:42px;border:0;border-radius:12px;background:#facc15;color:#17120a;font-size:11px;font-weight:900;margin-bottom:8px}
            .taxi-map{width:100%;height:245px;border-radius:16px;overflow:hidden;background:#111827}
            .taxi-map-loading{height:100%;display:flex;align-items:center;justify-content:center;color:#8b98aa;font-size:11px}
            .taxi-route-info{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
            .taxi-route-stat{background:#151f2f;border:1px solid #26354c;border-radius:12px;padding:8px;text-align:center}
            .taxi-route-stat b{display:block;font-size:15px;color:#fff}.taxi-route-stat span{font-size:9px;color:#8290a7}
            .taxi-map-note{margin-top:7px;color:#7f8da5;font-size:9px;line-height:1.4}
            .taxi-pin{width:34px;height:34px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;border:3px solid #fff;box-shadow:0 4px 12px rgba(0,0,0,.35);font-weight:950}
            .taxi-pin span{transform:rotate(45deg);font-size:14px}.taxi-pin.a{background:#facc15;color:#111}.taxi-pin.b{background:#22c55e;color:#fff}.taxi-pin.car{background:#111827;color:#fff}
            .leaflet-control-attribution{font-size:7px!important}.leaflet-control-zoom a{background:#101827!important;color:#fff!important;border-color:#2b3950!important}
            @media(max-width:430px){.taxi-map{height:220px}}
        `;
        document.head.appendChild(style);
    }

    function icon(type) {
        const text = type === "a" ? "A" : type === "b" ? "B" : "🚕";
        return L.divIcon({ className:"", html:`<div class="taxi-pin ${type}"><span>${text}</span></div>`, iconSize:[34,34], iconAnchor:[17,32] });
    }

    function ensurePassengerUI() {
        const form = document.getElementById("orderForm");
        if (!form || document.getElementById("passengerMapCard")) return;
        const card = document.createElement("div");
        card.id = "passengerMapCard";
        card.className = "taxi-map-card";
        card.innerHTML = `
            <div class="taxi-map-title"><span>🗺 Маршрут</span><span id="mapDistanceMini" style="color:#facc15">—</span></div>
            <div class="taxi-map-actions"><button id="mapPickupBtn" class="active" type="button">📍 Точка A · Откуда</button><button id="mapDestinationBtn" type="button">🏁 Точка B · Куда</button></div>
            <button id="mapLocateBtn" class="taxi-map-location" type="button">📍 Моё местоположение</button>
            <div id="passengerMap" class="taxi-map"><div class="taxi-map-loading">Нажмите «Откуда» или «Куда» — карта загрузится</div></div>
            <div class="taxi-route-info"><div class="taxi-route-stat"><b id="routeDistance">—</b><span>расстояние</span></div><div class="taxi-route-stat"><b id="routeDuration">—</b><span>примерное время</span></div></div>
            <div class="taxi-map-note">Точки A и B можно выбрать на карте или через адрес. Километраж рассчитывается автоматически.</div>`;
        form.insertBefore(card, form.firstChild);
        document.getElementById("mapPickupBtn").onclick = () => { setActiveField("pickup"); initPassengerMap(); };
        document.getElementById("mapDestinationBtn").onclick = () => { setActiveField("destination"); initPassengerMap(); };
        document.getElementById("mapLocateBtn").onclick = locatePassenger;
    }

    function setActiveField(field) {
        state.activeField = field;
        document.getElementById("mapPickupBtn")?.classList.toggle("active", field === "pickup");
        document.getElementById("mapDestinationBtn")?.classList.toggle("active", field === "destination");
        document.getElementById(field === "pickup" ? "addressA" : "addressB")?.focus();
    }

    function initPassengerMap() {
        const el = document.getElementById("passengerMap");
        if (!el || state.map) return loadLeaflet().then(() => {
            if (state.map || !document.getElementById("passengerMap")) return;
            el.innerHTML = "";
            state.map = L.map(el, { zoomControl:true, preferCanvas:true, attributionControl:true }).setView([52.79,27.55], 13);
            // Carto dark tiles are lighter and faster for this UI than a full heavy map layer.
            L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
                maxZoom:19,
                subdomains:"abcd",
                updateWhenIdle:true,
                keepBuffer:1,
                attribution:"© OpenStreetMap © CARTO"
            }).addTo(state.map);
            state.map.on("click", e => chooseMapPoint(e.latlng.lat,e.latlng.lng));
            setTimeout(() => state.map?.invalidateSize(), 100);
        }).catch(() => {
            el.innerHTML = '<div class="taxi-map-loading">Не удалось загрузить карту. Можно продолжить через адреса.</div>';
        });
    }

    function distanceKm(a,b) {
        const R=6371, p1=a.lat*Math.PI/180, p2=b.lat*Math.PI/180, dp=(b.lat-a.lat)*Math.PI/180, dl=(b.lng-a.lng)*Math.PI/180;
        const x=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
        return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
    }

    function setStats(km,min) {
        const d=km==null?"—":`${Number(km).toFixed(1)} км`;
        document.getElementById("routeDistance")?.replaceChildren(d);
        document.getElementById("mapDistanceMini")?.replaceChildren(d);
        document.getElementById("routeDuration")?.replaceChildren(min==null?"—":`${Math.max(1,Math.round(min))} мин`);
        window.taxiRouteDistanceKm=km==null?null:Number(km);
    }

    function setPoint(field,lat,lng,address) {
        const target=field==="pickup"?state.pickup:state.destination;
        target.lat=Number(lat); target.lng=Number(lng);
        const input=document.getElementById(field==="pickup"?"addressA":"addressB");
        if(input&&address) input.value=address;
        if(!state.map) { initPassengerMap(); return; }
        const key=field==="pickup"?"pickup":"destination", type=field==="pickup"?"a":"b";
        if(!state.markers[key]) state.markers[key]=L.marker([lat,lng],{icon:icon(type),draggable:true}).addTo(state.map);
        else state.markers[key].setLatLng([lat,lng]);
        state.markers[key].off("dragend").on("dragend",e=>{const p=e.target.getLatLng(); setPoint(field,p.lat,p.lng,`${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`); reverseGeocode(p.lat,p.lng).then(a=>{if(a)setPoint(field,p.lat,p.lng,a)}).catch(()=>{});});
        state.markers[key].bindPopup(field==="pickup"?"📍 Точка A · Откуда":"🏁 Точка B · Куда");
        state.map.setView([lat,lng],16,{animate:true});
        scheduleRoute();
    }

    async function reverseGeocode(lat,lng) {
        const url=`${NOMINATIM}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
        const r=await fetch(url,{headers:{Accept:"application/json"}}); if(!r.ok) return null;
        const d=await r.json(); return d.display_name||null;
    }

    async function geocodeAddress(address) {
        const q=String(address||"").trim(); if(!q)return null;
        const url=`${NOMINATIM}/search?format=jsonv2&limit=1&countrycodes=by&q=${encodeURIComponent(q)}`;
        const r=await fetch(url,{headers:{Accept:"application/json"}}); if(!r.ok)return null;
        const d=await r.json(); if(!d.length)return null;
        return {lat:Number(d[0].lat),lng:Number(d[0].lon),address:d[0].display_name};
    }

    function scheduleRoute() {
        clearTimeout(state.routeTimer);
        state.routeTimer=setTimeout(updateRoute,500);
    }

    async function updateRoute() {
        const a=state.pickup,b=state.destination;
        if(!Number.isFinite(a.lat)||!Number.isFinite(b.lat)) return;
        const straight=distanceKm(a,b); setStats(straight,null);
        if(!state.map)return;
        try {
            const r=await fetch(`${ROUTER}/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson&steps=false`);
            const data=await r.json(), route=data.routes?.[0]; if(!route)throw new Error();
            setStats(route.distance/1000,route.duration/60);
            if(state.route)state.route.remove();
            state.route=L.geoJSON(route.geometry,{style:{color:"#facc15",weight:5,opacity:.9}}).addTo(state.map);
            state.map.fitBounds(state.route.getBounds(),{padding:[30,30],maxZoom:16});
        }catch(_){
            if(state.route)state.route.remove();
            state.route=L.polyline([[a.lat,a.lng],[b.lat,b.lng]],{color:"#facc15",weight:4,dashArray:"8 8"}).addTo(state.map);
            state.map.fitBounds(state.route.getBounds(),{padding:[30,30],maxZoom:16});
        }
    }

    async function chooseMapPoint(lat,lng) {
        const field=state.activeField;
        let address=`${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        try { address=await reverseGeocode(lat,lng)||address; } catch(_) {}
        setPoint(field,lat,lng,address);
    }

    async function locatePassenger() {
        if(!navigator.geolocation)return window.toast?.("Геолокация не поддерживается телефоном.",true);
        const btn=document.getElementById("mapLocateBtn"); if(btn)btn.textContent="⏳ Определяем…";
        navigator.geolocation.getCurrentPosition(async p=>{setActiveField("pickup"); await chooseMapPoint(p.coords.latitude,p.coords.longitude); if(btn)btn.textContent="📍 Моё местоположение";},()=>{if(btn)btn.textContent="📍 Моё местоположение";window.toast?.("Не удалось определить местоположение.",true);},{enableHighAccuracy:false,timeout:8000,maximumAge:30000});
    }

    function bindAddresses() {
        [["addressA","pickup"],["addressB","destination"]].forEach(([id,field])=>{
            const input=document.getElementById(id); if(!input||input.dataset.mapsBound)return;
            input.dataset.mapsBound="1";
            input.addEventListener("focus",()=>{setActiveField(field);initPassengerMap();});
            input.addEventListener("change",()=>{clearTimeout(state.geocodeTimers[field]);state.geocodeTimers[field]=setTimeout(async()=>{const p=await geocodeAddress(input.value).catch(()=>null);if(p)setPoint(field,p.lat,p.lng,input.value);},150);});
        });
    }

    function ensureTrackingUI() {
        const accepted=document.getElementById("acceptedCard");
        if(!accepted||document.getElementById("driverTrackingCard"))return;
        const card=document.createElement("div"); card.id="driverTrackingCard";card.className="taxi-map-card";
        card.innerHTML='<div class="taxi-map-title">🚕 Водитель на карте</div><div id="driverTrackingMap" class="taxi-map"><div class="taxi-map-loading">Загрузка…</div></div><div id="driverTrackingNote" class="taxi-map-note">Местоположение водителя обновляется автоматически.</div>';
        accepted.appendChild(card);
    }

    function initTrackingMap() {
        const el=document.getElementById("driverTrackingMap"); if(!el||state.trackingMap)return;
        loadLeaflet().then(()=>{if(state.trackingMap)return;el.innerHTML="";state.trackingMap=L.map(el,{zoomControl:true,preferCanvas:true}).setView([52.79,27.55],13);L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",{maxZoom:19,subdomains:"abcd",updateWhenIdle:true,keepBuffer:1,attribution:"© OpenStreetMap © CARTO"}).addTo(state.trackingMap);});
    }

    function updatePassengerTracking(data) {
        if(!data||!Number.isFinite(Number(data.driverLatitude)))return;
        ensureTrackingUI(); initTrackingMap();
        setTimeout(()=>{
            if(!state.trackingMap)return;
            const lat=Number(data.driverLatitude),lng=Number(data.driverLongitude);
            if(!state.trackingDriver)state.trackingDriver=L.marker([lat,lng],{icon:icon("car")}).addTo(state.trackingMap);else state.trackingDriver.setLatLng([lat,lng]);
            state.trackingMap.setView([lat,lng],15,{animate:true});
        },300);
    }

    function ensureDriverUI() {
        const screen=document.getElementById("driverScreen"),orders=document.getElementById("driverOrdersCard");
        if(!screen||!orders||document.getElementById("driverLocationCard"))return;
        const card=document.createElement("div");card.id="driverLocationCard";card.className="card driver-location-card";
        card.innerHTML='<div class="card-title">📍 Моё местоположение</div><button id="driverLocationBtn" class="main-btn" type="button">Включить геолокацию</button><div id="driverLocationStatus" class="driver-location-status">Геолокация выключена</div><div id="driverMap" class="taxi-map" style="margin-top:10px"><div class="taxi-map-loading">Карта появится после включения GPS</div></div>';
        screen.insertBefore(card,orders);document.getElementById("driverLocationBtn").onclick=startDriverLocation;
    }

    function startDriverLocation() {
        if(!navigator.geolocation)return setDriverStatus("Геолокация не поддерживается.","error");
        if(state.driverWatchId!==null)return setDriverStatus("Геолокация уже включена.","ok");
        loadLeaflet().then(()=>initDriverMap()).catch(()=>{});
        state.driverWatchId=navigator.geolocation.watchPosition(async p=>{
            const lat=p.coords.latitude,lng=p.coords.longitude;
            initDriverMap();
            if(state.driverMap){if(!state.driverMarker)state.driverMarker=L.marker([lat,lng],{icon:icon("car")}).addTo(state.driverMap);else state.driverMarker.setLatLng([lat,lng]);state.driverMap.setView([lat,lng],16);}
            const now=Date.now();if(now-state.lastDriverSent<10000)return;state.lastDriverSent=now;
            try{await fetch("/api/driver-location",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({telegramId:window.telegramUserId||"",latitude:lat,longitude:lng,accuracy:p.coords.accuracy||null})});setDriverStatus("Онлайн • GPS обновляется","ok");}catch(_){setDriverStatus("GPS работает, но сервер недоступен.","error");}
        },e=>setDriverStatus(e.code===1?"Разрешите доступ к геолокации.":"Ошибка GPS.","error"),{enableHighAccuracy:false,timeout:10000,maximumAge:10000});
    }

    function initDriverMap() {
        const el=document.getElementById("driverMap");if(!el||state.driverMap)return;
        loadLeaflet().then(()=>{if(state.driverMap)return;el.innerHTML="";state.driverMap=L.map(el,{zoomControl:true,preferCanvas:true}).setView([52.79,27.55],13);L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",{maxZoom:19,subdomains:"abcd",updateWhenIdle:true,keepBuffer:1,attribution:"© OpenStreetMap © CARTO"}).addTo(state.driverMap);});
    }

    function setDriverStatus(text,type){const el=document.getElementById("driverLocationStatus");if(!el)return;el.textContent=text;el.className="driver-location-status"+(type?` ${type}`:"");}

    function observeApp() {
        const observer=new MutationObserver(()=>{ensurePassengerUI();ensureDriverUI();bindAddresses();});
        observer.observe(document.body,{childList:true,subtree:true});
        ensurePassengerUI();ensureDriverUI();bindAddresses();
    }

    function boot() {
        addStyles(); observeApp();
        // ВАЖНО: Leaflet и тайлы НЕ грузим при открытии Mini App.
        // Они загрузятся только когда пользователь реально открывает карту/адрес.
        window.taxiMapsReady=true;
    }

    // Доступ для существующего приложения.
    window.taxiMapSetPoint=setPoint;
    window.taxiMapUpdateTracking=updatePassengerTracking;
    window.taxiMapInit=initPassengerMap;

    if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot,{once:true});else boot();
})();