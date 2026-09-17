(() => {
    const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    const LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    const NOMINATIM = "https://nominatim.openstreetmap.org";
    const ROUTER = "https://router.project-osrm.org/route/v1/driving";

    const state = {
        pickup: { lat: null, lng: null },
        destination: { lat: null, lng: null },
        activeField: "pickup",
        passengerMap: null,
        passengerMarkers: {},
        routeLayer: null,
        driverMap: null,
        driverMarker: null,
        driverWatchId: null,
        lastDriverSent: 0,
        geocodeTimers: {},
        trackingMap: null,
        trackingDriverMarker: null,
        trackingRoute: null,
        trackingTimer: null
    };

    function loadLeaflet() {
        return new Promise((resolve, reject) => {
            if (window.L) return resolve();
            const css = document.createElement("link");
            css.rel = "stylesheet";
            css.href = LEAFLET_CSS;
            document.head.appendChild(css);
            const script = document.createElement("script");
            script.src = LEAFLET_JS;
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    function addStyles() {
        if (document.getElementById("taxiMapsStyles")) return;
        const style = document.createElement("style");
        style.id = "taxiMapsStyles";
        style.textContent = `
            .taxi-map-card{margin-top:12px;padding:12px;border-radius:20px;background:#0d1421;border:1px solid #29364d;box-shadow:0 12px 35px rgba(0,0,0,.22)}
            .taxi-map-title{font-size:13px;font-weight:900;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between}
            .taxi-map-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:9px}
            .taxi-map-actions button{height:40px;border-radius:12px;background:#151f2f;border:1px solid #2a3850;color:#fff;font-size:11px;font-weight:850}
            .taxi-map-actions button.active{background:#facc15;color:#17120a;border-color:#facc15}
            .taxi-map-location{margin-top:8px;width:100%;height:42px;border-radius:12px;background:#facc15;color:#17120a;border:0;font-size:11px;font-weight:900}
            .taxi-map{width:100%;height:260px;border-radius:16px;overflow:hidden;background:#172033;box-shadow:inset 0 0 0 1px rgba(255,255,255,.04)}
            .taxi-map-note{margin-top:8px;color:#7f8da5;font-size:9px;line-height:1.45}
            .taxi-route-info{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:9px}
            .taxi-route-stat{background:#151f2f;border:1px solid #26354c;border-radius:12px;padding:9px;text-align:center}
            .taxi-route-stat b{display:block;font-size:15px;color:#fff}
            .taxi-route-stat span{font-size:9px;color:#8290a7}
            .taxi-map-legend{display:flex;gap:10px;margin-top:8px;font-size:9px;color:#8997ac}
            .taxi-map-legend span{display:flex;align-items:center;gap:4px}
            .taxi-dot{width:9px;height:9px;border-radius:50%;display:inline-block}
            .taxi-dot.a{background:#facc15}.taxi-dot.b{background:#22c55e}.taxi-dot.car{background:#ef4444}
            .driver-location-card{margin-bottom:12px}
            .driver-location-status{margin-top:7px;color:#718097;font-size:10px;text-align:center}
            .driver-location-status.ok{color:#6ee7a0}
            .driver-location-status.error{color:#fca5a5}
            .taxi-pin{width:36px;height:36px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;border:3px solid #fff;box-shadow:0 4px 14px rgba(0,0,0,.35)}
            .taxi-pin span{transform:rotate(45deg);font-size:16px}
            .taxi-pin.a{background:#facc15}.taxi-pin.b{background:#22c55e}.taxi-pin.car{background:#111827}
            .taxi-car-icon{font-size:17px;transform:rotate(45deg)}
            .leaflet-control-attribution{font-size:7px!important}
            .leaflet-control-zoom a{background:#101827!important;color:#fff!important;border-color:#2b3950!important}
        `;
        document.head.appendChild(style);
    }

    function pinIcon(type) {
        const emoji = type === "a" ? "A" : type === "b" ? "B" : "🚕";
        return L.divIcon({ className:"", html:`<div class="taxi-pin ${type}"><span>${emoji}</span></div>`, iconSize:[36,36], iconAnchor:[18,34], popupAnchor:[0,-30] });
    }

    function ensurePassengerMapUI() {
        const orderForm = document.getElementById("orderForm");
        if (!orderForm || document.getElementById("passengerMapCard")) return;
        const card = document.createElement("div");
        card.id = "passengerMapCard";
        card.className = "taxi-map-card";
        card.innerHTML = `
            <div class="taxi-map-title"><span>🗺 Маршрут поездки</span><span id="mapDistanceMini" style="color:#facc15">—</span></div>
            <div class="taxi-map-actions">
                <button id="mapPickupBtn" class="active" type="button">📍 Точка A · Откуда</button>
                <button id="mapDestinationBtn" type="button">🏁 Точка B · Куда</button>
            </div>
            <button id="mapLocateBtn" class="taxi-map-location" type="button">📍 Моё местоположение</button>
            <div id="passengerMap" class="taxi-map"></div>
            <div class="taxi-route-info">
                <div class="taxi-route-stat"><b id="routeDistance">—</b><span>расстояние</span></div>
                <div class="taxi-route-stat"><b id="routeDuration">—</b><span>примерное время</span></div>
            </div>
            <div class="taxi-map-legend"><span><i class="taxi-dot a"></i> Точка A</span><span><i class="taxi-dot b"></i> Точка B</span></div>
            <div class="taxi-map-note">Выберите A и B на карте или в полях адреса. Маршрут и километраж считаются автоматически.</div>
        `;
        orderForm.insertBefore(card, orderForm.firstChild);
        document.getElementById("mapPickupBtn").onclick = () => setActiveField("pickup");
        document.getElementById("mapDestinationBtn").onclick = () => setActiveField("destination");
        document.getElementById("mapLocateBtn").onclick = locatePassenger;
    }

    function ensureAcceptedMapUI() {
        const accepted = document.getElementById("acceptedCard");
        if (!accepted || document.getElementById("driverTrackingCard")) return;
        const card = document.createElement("div");
        card.id = "driverTrackingCard";
        card.className = "taxi-map-card";
        card.innerHTML = `<div class="taxi-map-title">🚕 Водитель на карте</div><div id="driverTrackingMap" class="taxi-map"></div><div id="driverTrackingNote" class="taxi-map-note">Получаем местоположение водителя…</div>`;
        accepted.appendChild(card);
    }

    function ensureDriverMapUI() {
        const screen = document.getElementById("driverScreen");
        const orders = document.getElementById("driverOrdersCard");
        if (!screen || !orders || document.getElementById("driverLocationCard")) return;
        const card = document.createElement("div");
        card.id = "driverLocationCard";
        card.className = "card driver-location-card";
        card.innerHTML = `<div class="card-title">📍 Моё местоположение</div><button id="driverLocationBtn" class="main-btn" type="button">Включить геолокацию</button><div id="driverLocationStatus" class="driver-location-status">Геолокация выключена</div><div id="driverMap" class="taxi-map" style="margin-top:10px"></div>`;
        screen.insertBefore(card, orders);
        document.getElementById("driverLocationBtn").onclick = startDriverLocation;
    }

    function setActiveField(field) {
        state.activeField = field;
        document.getElementById("mapPickupBtn")?.classList.toggle("active", field === "pickup");
        document.getElementById("mapDestinationBtn")?.classList.toggle("active", field === "destination");
        document.getElementById(field === "pickup" ? "addressA" : "addressB")?.focus();
    }

    async function reverseGeocode(lat, lng) {
        const url = `${NOMINATIM}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
        const response = await fetch(url, { headers:{Accept:"application/json"} });
        if (!response.ok) throw new Error("reverse geocode failed");
        const data = await response.json();
        return data.display_name || `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    }

    async function geocodeAddress(address) {
        const q = String(address || "").trim();
        if (!q) return null;
        const url = `${NOMINATIM}/search?format=jsonv2&limit=1&countrycodes=by&q=${encodeURIComponent(q)}`;
        const response = await fetch(url, { headers:{Accept:"application/json"} });
        if (!response.ok) return null;
        const data = await response.json();
        if (!data.length) return null;
        return { lat:Number(data[0].lat), lng:Number(data[0].lon), address:data[0].display_name };
    }

    function setPoint(field, lat, lng, address) {
        const target = field === "pickup" ? state.pickup : state.destination;
        target.lat = Number(lat); target.lng = Number(lng);
        const input = document.getElementById(field === "pickup" ? "addressA" : "addressB");
        if (input && address) input.value = address;
        if (!state.passengerMap) return;
        const key = field === "pickup" ? "pickup" : "destination";
        const type = field === "pickup" ? "a" : "b";
        if (!state.passengerMarkers[key]) state.passengerMarkers[key] = L.marker([lat,lng],{icon:pinIcon(type),draggable:true}).addTo(state.passengerMap);
        else state.passengerMarkers[key].setLatLng([lat,lng]);
        state.passengerMarkers[key].off("dragend").on("dragend", async e => {
            const p = e.target.getLatLng();
            try { const a = await reverseGeocode(p.lat,p.lng); setPoint(field,p.lat,p.lng,a); } catch(_) { setPoint(field,p.lat,p.lng,`${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`); }
        });
        state.passengerMarkers[key].bindPopup(field === "pickup" ? "📍 Точка A · Откуда" : "🏁 Точка B · Куда");
        updateRoute();
    }

    async function chooseMapPoint(lat,lng) {
        const field = state.activeField;
        try { setPoint(field,lat,lng,await reverseGeocode(lat,lng)); }
        catch(_) { setPoint(field,lat,lng,`${lat.toFixed(6)}, ${lng.toFixed(6)}`); }
    }

    function distanceKm(a,b) {
        const R=6371, p1=a.lat*Math.PI/180, p2=b.lat*Math.PI/180, dp=(b.lat-a.lat)*Math.PI/180, dl=(b.lng-a.lng)*Math.PI/180;
        const x=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
        return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
    }

    async function updateRoute() {
        const a=state.pickup,b=state.destination;
        if (!state.passengerMap || !Number.isFinite(a.lat)||!Number.isFinite(a.lng)||!Number.isFinite(b.lat)||!Number.isFinite(b.lng)) {
            setRouteStats(null,null); return;
        }
        const straight=distanceKm(a,b);
        setRouteStats(straight,null);
        try {
            const url=`${ROUTER}/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson&steps=false`;
            const response=await fetch(url);
            const data=await response.json();
            const route=data.routes?.[0];
            if (!route) throw new Error("route not found");
            const km=route.distance/1000, min=route.duration/60;
            setRouteStats(km,min);
            if (state.routeLayer) state.routeLayer.remove();
            state.routeLayer=L.geoJSON(route.geometry,{style:{color:"#facc15",weight:5,opacity:.9}}).addTo(state.passengerMap);
            state.passengerMap.fitBounds(state.routeLayer.getBounds(),{padding:[30,30],maxZoom:16});
        } catch(_) {
            if (state.routeLayer) state.routeLayer.remove();
            state.routeLayer=L.polyline([[a.lat,a.lng],[b.lat,b.lng]],{color:"#facc15",weight:4,dashArray:"10 8",opacity:.85}).addTo(state.passengerMap);
            state.passengerMap.fitBounds(state.routeLayer.getBounds(),{padding:[35,35],maxZoom:16});
        }
    }

    function setRouteStats(km,min) {
        const distance=km==null?"—":`${km.toFixed(1)} км`;
        const duration=min==null?"—":`${Math.max(1,Math.round(min))} мин`;
        document.getElementById("routeDistance")?.replaceChildren(distance);
        document.getElementById("routeDuration")?.replaceChildren(duration);
        document.getElementById("mapDistanceMini")?.replaceChildren(km==null?"—":`${km.toFixed(1)} км`);
        window.taxiRouteDistanceKm=km==null?null:Number(km);
    }

    function locatePassenger() {
        if (!navigator.geolocation) return window.toast?.("Геолокация не поддерживается телефоном.",true);
        const button=document.getElementById("mapLocateBtn"); if(button) button.textContent="⏳ Определяем…";
        navigator.geolocation.getCurrentPosition(async p=>{
            setActiveField("pickup"); await chooseMapPoint(p.coords.latitude,p.coords.longitude);
            if(button) button.textContent="📍 Моё местоположение";
            window.toast?.("Точка A определена по GPS.");
        },e=>{
            if(button) button.textContent="📍 Моё местоположение";
            window.toast?.(e.code===1?"Разрешите Telegram доступ к геолокации.":"Не удалось определить местоположение.",true);
        },{enableHighAccuracy:true,timeout:12000,maximumAge:10000});
    }

    function bindAddressGeocoding() {
        [["addressA","pickup"],["addressB","destination"]].forEach(([id,field])=>{
            const input=document.getElementById(id); if(!input||input.dataset.mapsBound) return;
            input.dataset.mapsBound="1";
            input.addEventListener("focus",()=>setActiveField(field));
            input.addEventListener("change",()=>geocodeAndSet(input,field));
            input.addEventListener("blur",()=>{clearTimeout(state.geocodeTimers[field]);state.geocodeTimers[field]=setTimeout(()=>geocodeAndSet(input,field),300);});
        });
    }

    async function geocodeAndSet(input,field) {
        const point=await geocodeAddress(input.value).catch(()=>null);
        if(point) setPoint(field,point.lat,point.lng,input.value);
    }

    function initPassengerMap() {
        const el=document.getElementById("passengerMap"); if(!el||!window.L||state.passengerMap) return;
        state.passengerMap=L.map(el,{zoomControl:true,scrollWheelZoom:true}).setView([52.79,27.55],13);
        L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",{maxZoom:20,attribution:"© OpenStreetMap © CARTO"}).addTo(state.passengerMap);
        state.passengerMap.on("click",e=>chooseMapPoint(e.latlng.lat,e.latlng.lng));
        const a=document.getElementById("addressA")?.value, b=document.getElementById("addressB")?.value;
        if(a) geocodeAddress(a).then(p=>p&&setPoint("pickup",p.lat,p.lng,a)).catch(()=>{});
        if(b) geocodeAddress(b).then(p=>p&&setPoint("destination",p.lat,p.lng,b)).catch(()=>{});
        setTimeout(()=>state.passengerMap.invalidateSize(),200);
    }

    function initDriverMap() {
        const el=document.getElementById("driverMap"); if(!el||!window.L||state.driverMap) return;
        state.driverMap=L.map(el,{zoomControl:true}).setView([52.79,27.55],13);
        L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",{maxZoom:20,attribution:"© OpenStreetMap © CARTO"}).addTo(state.driverMap);
        setTimeout(()=>state.driverMap.invalidateSize(),200);
    }

    function initTrackingMap() {
        const el=document.getElementById("driverTrackingMap"); if(!el||!window.L||state.trackingMap) return;
        state.trackingMap=L.map(el,{zoomControl:true}).setView([52.79,27.55],13);
        L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",{maxZoom:20,attribution:"© OpenStreetMap © CARTO"}).addTo(state.trackingMap);
        setTimeout(()=>state.trackingMap.invalidateSize(),200);
    }

    async function updatePassengerTracking(data) {
        if(!data||!data.driverLatitude||!data.driverLongitude) return;
        ensureAcceptedMapUI(); initTrackingMap(); if(!state.trackingMap) return;
        const lat=Number(data.driverLatitude),lng=Number(data.driverLongitude); if(!Number.isFinite(lat)||!Number.isFinite(lng)) return;
        if(!state.trackingDriverMarker) state.trackingDriverMarker=L.marker([lat,lng],{icon:pinIcon("car")}).addTo(state.trackingMap).bindPopup("🚕 Водитель");
        else state.trackingDriverMarker.setLatLng([lat,lng]);
        const points=[[lat,lng]];
        if(data.pickupLatitude&&data.pickupLongitude) points.push([Number(data.pickupLatitude),Number(data.pickupLongitude)]);
        state.trackingMap.fitBounds(points,{padding:[30,30],maxZoom:15});
        document.getElementById("driverTrackingNote")?.replaceChildren("Местоположение водителя обновляется автоматически.");
    }

    function setDriverStatus(text,type){const el=document.getElementById("driverLocationStatus");if(el){el.textContent=text;el.className=`driver-location-status ${type||""}`;}}

    function startDriverLocation() {
        if(!navigator.geolocation) return setDriverStatus("Геолокация не поддерживается.","error");
        if(state.driverWatchId!==null) return setDriverStatus("Геолокация уже включена.","ok");
        initDriverMap(); setDriverStatus("Получаем координаты…","");
        state.driverWatchId=navigator.geolocation.watchPosition(async p=>{
            const {latitude,longitude}=p.coords; initDriverMap();
            if(state.driverMap){if(!state.driverMarker)state.driverMarker=L.marker([latitude,longitude],{icon:pinIcon("car")}).addTo(state.driverMap);else state.driverMarker.setLatLng([latitude,longitude]);state.driverMap.setView([latitude,longitude],16);}
            if(Date.now()-state.lastDriverSent<8000)return; state.lastDriverSent=Date.now();
            try{await fetch("/api/driver-location",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({telegramId:window.telegramUserId||"",latitude,longitude,accuracy:p.coords.accuracy||null})});setDriverStatus(`Онлайн • ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`,"ok");}catch(_){setDriverStatus("Координаты получены, но не отправлены.","error");}
        },e=>setDriverStatus(e.code===1?"Разрешите доступ к геолокации.":"Ошибка геолокации.","error"),{enableHighAccuracy:true,timeout:15000,maximumAge:5000});
    }

    function patchSendOrderFetch() {
        if(window.__taxiMapFetchPatched)return; window.__taxiMapFetchPatched=true;
        const original=window.fetch;
        window.fetch=async function(input,init){
            try{
                const url=typeof input==="string"?input:(input?.url||"");
                if(url.includes("/api/send-order")&&init?.body&&typeof init.body==="string"){
                    const body=JSON.parse(init.body);
                    if(Number.isFinite(state.pickup.lat)){body.pickupLatitude=state.pickup.lat;body.pickupLongitude=state.pickup.lng;}
                    if(Number.isFinite(state.destination.lat)){body.destinationLatitude=state.destination.lat;body.destinationLongitude=state.destination.lng;}
                    if(window.taxiRouteDistanceKm)body.distanceKm=window.taxiRouteDistanceKm;
                    init={...init,body:JSON.stringify(body)};
                }
            }catch(_){}
            return original.apply(this,arguments);
        };
    }

    function observeAccepted(){
        const observer=new MutationObserver(()=>{if(document.getElementById("acceptedCard")){ensureAcceptedMapUI();initTrackingMap();}});
        observer.observe(document.body,{childList:true,subtree:true});
    }

    async function boot(){
        addStyles(); ensurePassengerMapUI(); ensureDriverMapUI(); bindAddressGeocoding(); patchSendOrderFetch();
        try{await loadLeaflet();}catch(_){return;}
        ensurePassengerMapUI(); initPassengerMap(); ensureDriverMapUI(); initDriverMap(); observeAccepted();
        window.addEventListener("resize",()=>{state.passengerMap?.invalidateSize();state.driverMap?.invalidateSize();state.trackingMap?.invalidateSize();});
    }

    function pollTracking(){
        if(state.trackingTimer)return;
        state.trackingTimer=setInterval(async()=>{
            const orderId=window.currentOrderId||window.activeOrderId;
            if(!orderId)return;
            try{const r=await fetch(`/api/order-status?orderId=${encodeURIComponent(orderId)}`);if(r.ok)await updatePassengerTracking(await r.json());}catch(_){}
        },8000);
    }

    window.addEventListener("load",()=>{setTimeout(boot,250);pollTracking();});
    if(document.readyState!=="loading")setTimeout(boot,250);
})();