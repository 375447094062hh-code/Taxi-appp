(() => {
    const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    const LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    const NOMINATIM = "https://nominatim.openstreetmap.org";

    const state = {
        pickup: { lat: null, lng: null },
        destination: { lat: null, lng: null },
        activeField: "pickup",
        passengerMap: null,
        passengerMarkers: {},
        driverMap: null,
        driverMarker: null,
        driverWatchId: null,
        lastDriverSent: 0,
        geocodeTimers: {}
    };

    function loadLeaflet() {
        return new Promise((resolve, reject) => {
            if (window.L) {
                resolve();
                return;
            }

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

    function esc(value) {
        return String(value ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }

    function addStyles() {
        if (document.getElementById("taxiMapsStyles")) return;

        const style = document.createElement("style");
        style.id = "taxiMapsStyles";
        style.textContent = `
            .taxi-map-card{margin-top:12px;padding:12px;border-radius:18px;background:#0d1421;border:1px solid #243044}
            .taxi-map-title{font-size:12px;font-weight:900;margin-bottom:9px}
            .taxi-map-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:9px}
            .taxi-map-actions button{height:40px;border-radius:12px;background:#151f2f;border:1px solid #2a3850;color:#fff;font-size:10px;font-weight:850}
            .taxi-map-actions button.active{background:#facc15;color:#17120a;border-color:#facc15}
            .taxi-map-location{margin-top:8px;width:100%;height:42px;border-radius:12px;background:#facc15;color:#17120a;font-size:11px;font-weight:900}
            .taxi-map{width:100%;height:230px;border-radius:15px;overflow:hidden;background:#172033}
            .taxi-map-note{margin-top:7px;color:#718097;font-size:9px;line-height:1.4}
            .driver-location-card{margin-bottom:12px}
            .driver-location-status{margin-top:7px;color:#718097;font-size:10px;text-align:center}
            .driver-location-status.ok{color:#6ee7a0}
            .driver-location-status.error{color:#fca5a5}
            .leaflet-control-attribution{font-size:7px!important}
        `;
        document.head.appendChild(style);
    }

    function ensurePassengerMapUI() {
        const orderForm = document.getElementById("orderForm");
        if (!orderForm || document.getElementById("passengerMapCard")) return;

        const card = document.createElement("div");
        card.id = "passengerMapCard";
        card.className = "taxi-map-card";
        card.innerHTML = `
            <div class="taxi-map-title">🗺 Карта маршрута</div>
            <div class="taxi-map-actions">
                <button id="mapPickupBtn" class="active" type="button">📍 Откуда</button>
                <button id="mapDestinationBtn" type="button">🏁 Куда</button>
            </div>
            <button id="mapLocateBtn" class="taxi-map-location" type="button">📍 Определить моё местоположение</button>
            <div id="passengerMap" class="taxi-map"></div>
            <div class="taxi-map-note">Нажмите на карту, чтобы выбрать точку. Адрес автоматически определится.</div>
        `;

        const timeField = orderForm.querySelector(".field:nth-of-type(3)");
        if (timeField) orderForm.insertBefore(card, timeField);
        else orderForm.appendChild(card);

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
        card.innerHTML = `
            <div class="taxi-map-title">🚕 Водитель на карте</div>
            <div id="driverTrackingMap" class="taxi-map"></div>
            <div id="driverTrackingNote" class="taxi-map-note">Получаем местоположение водителя…</div>
        `;
        accepted.appendChild(card);
    }

    function ensureDriverMapUI() {
        const screen = document.getElementById("driverScreen");
        const orders = document.getElementById("driverOrdersCard");
        if (!screen || !orders || document.getElementById("driverLocationCard")) return;

        const card = document.createElement("div");
        card.id = "driverLocationCard";
        card.className = "card driver-location-card";
        card.innerHTML = `
            <div class="card-title">📍 Моё местоположение</div>
            <button id="driverLocationBtn" class="main-btn" type="button">Включить геолокацию</button>
            <div id="driverLocationStatus" class="driver-location-status">Геолокация выключена</div>
            <div id="driverMap" class="taxi-map" style="margin-top:10px"></div>
        `;
        screen.insertBefore(card, orders);
        document.getElementById("driverLocationBtn").onclick = startDriverLocation;
    }

    function setActiveField(field) {
        state.activeField = field;
        document.getElementById("mapPickupBtn")?.classList.toggle("active", field === "pickup");
        document.getElementById("mapDestinationBtn")?.classList.toggle("active", field === "destination");
        const input = document.getElementById(field === "pickup" ? "addressA" : "addressB");
        input?.focus();
    }

    async function reverseGeocode(lat, lng) {
        const url = `${NOMINATIM}/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=18&addressdetails=1`;
        const response = await fetch(url, { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error("Не удалось определить адрес");
        const data = await response.json();
        return data.display_name || `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    }

    async function geocodeAddress(address) {
        const query = String(address || "").trim();
        if (!query) return null;
        const url = `${NOMINATIM}/search?format=jsonv2&limit=1&countrycodes=by&addressdetails=1&q=${encodeURIComponent(query)}`;
        const response = await fetch(url, { headers: { Accept: "application/json" } });
        if (!response.ok) return null;
        const data = await response.json();
        if (!data.length) return null;
        return { lat: Number(data[0].lat), lng: Number(data[0].lon), address: data[0].display_name };
    }

    function setPoint(field, lat, lng, address) {
        const target = field === "pickup" ? state.pickup : state.destination;
        target.lat = Number(lat);
        target.lng = Number(lng);

        const input = document.getElementById(field === "pickup" ? "addressA" : "addressB");
        if (input && address) input.value = address;

        if (state.passengerMap) {
            const markerKey = field === "pickup" ? "pickup" : "destination";
            if (state.passengerMarkers[markerKey]) {
                state.passengerMarkers[markerKey].setLatLng([lat, lng]);
            } else {
                const label = field === "pickup" ? "📍 Откуда" : "🏁 Куда";
                state.passengerMarkers[markerKey] = L.marker([lat, lng]).addTo(state.passengerMap).bindPopup(label);
            }
            state.passengerMap.setView([lat, lng], 16);
        }
    }

    async function chooseMapPoint(lat, lng) {
        const field = state.activeField;
        try {
            const address = await reverseGeocode(lat, lng);
            setPoint(field, lat, lng, address);
        } catch (error) {
            setPoint(field, lat, lng, `${lat.toFixed(6)}, ${lng.toFixed(6)}`);
            window.toast?.("Точка выбрана, но адрес определить не удалось.", true);
        }
    }

    async function locatePassenger() {
        if (!navigator.geolocation) {
            window.toast?.("Геолокация не поддерживается телефоном.", true);
            return;
        }

        const button = document.getElementById("mapLocateBtn");
        if (button) button.textContent = "⏳ Определяем…";

        navigator.geolocation.getCurrentPosition(async position => {
            const { latitude, longitude } = position.coords;
            setActiveField("pickup");
            await chooseMapPoint(latitude, longitude);
            if (button) button.textContent = "📍 Моё местоположение";
            window.toast?.("Место подачи определено по GPS.");
        }, error => {
            if (button) button.textContent = "📍 Определить моё местоположение";
            const message = error.code === 1 ? "Разрешите Telegram доступ к геолокации." : "Не удалось определить местоположение.";
            window.toast?.(message, true);
        }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 10000 });
    }

    function bindAddressGeocoding() {
        [
            ["addressA", "pickup"],
            ["addressB", "destination"]
        ].forEach(([id, field]) => {
            const input = document.getElementById(id);
            if (!input || input.dataset.mapsBound) return;
            input.dataset.mapsBound = "1";
            input.addEventListener("focus", () => setActiveField(field));
            input.addEventListener("blur", () => {
                clearTimeout(state.geocodeTimers[field]);
                state.geocodeTimers[field] = setTimeout(async () => {
                    const value = input.value.trim();
                    if (!value) return;
                    try {
                        const point = await geocodeAddress(value);
                        if (point) setPoint(field, point.lat, point.lng, value);
                    } catch (_) {}
                }, 250);
            });
        });
    }

    function initPassengerMap() {
        const mapEl = document.getElementById("passengerMap");
        if (!mapEl || !window.L || state.passengerMap) return;
        state.passengerMap = L.map(mapEl, { zoomControl: true }).setView([52.79, 27.55], 13);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: "© OpenStreetMap"
        }).addTo(state.passengerMap);
        state.passengerMap.on("click", event => chooseMapPoint(event.latlng.lat, event.latlng.lng));
    }

    function initDriverMap() {
        const mapEl = document.getElementById("driverMap");
        if (!mapEl || !window.L || state.driverMap) return;
        state.driverMap = L.map(mapEl, { zoomControl: true }).setView([52.79, 27.55], 13);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: "© OpenStreetMap"
        }).addTo(state.driverMap);
    }

    function initTrackingMap() {
        const mapEl = document.getElementById("driverTrackingMap");
        if (!mapEl || !window.L || state.trackingMap) return;
        state.trackingMap = L.map(mapEl, { zoomControl: true }).setView([52.79, 27.55], 13);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: "© OpenStreetMap"
        }).addTo(state.trackingMap);
    }

    async function updatePassengerTracking(data) {
        if (!data || !data.driverLatitude || !data.driverLongitude) return;
        ensureAcceptedMapUI();
        initTrackingMap();
        if (!state.trackingMap) return;

        const lat = Number(data.driverLatitude);
        const lng = Number(data.driverLongitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

        if (!state.passengerMarkers.driver) {
            state.passengerMarkers.driver = L.marker([lat, lng]).addTo(state.trackingMap).bindPopup("🚕 Водитель");
        } else {
            state.passengerMarkers.driver.setLatLng([lat, lng]);
        }

        const points = [[lat, lng]];
        if (data.pickupLatitude && data.pickupLongitude) points.push([Number(data.pickupLatitude), Number(data.pickupLongitude)]);
        state.trackingMap.fitBounds(points, { padding: [25, 25], maxZoom: 15 });
        const note = document.getElementById("driverTrackingNote");
        if (note) note.textContent = "Местоположение водителя обновляется автоматически.";
    }

    function startDriverLocation() {
        if (!navigator.geolocation) {
            setDriverStatus("Геолокация не поддерживается.", "error");
            return;
        }
        if (state.driverWatchId !== null) {
            setDriverStatus("Геолокация уже включена.", "ok");
            return;
        }

        initDriverMap();
        setDriverStatus("Получаем координаты…", "");

        state.driverWatchId = navigator.geolocation.watchPosition(async position => {
            const { latitude, longitude } = position.coords;
            initDriverMap();
            if (state.driverMap) {
                if (!state.driverMarker) {
                    state.driverMarker = L.marker([latitude, longitude]).addTo(state.driverMap).bindPopup("📍 Я здесь");
                } else {
                    state.driverMarker.setLatLng([latitude, longitude]);
                }
                state.driverMap.setView([latitude, longitude], 16);
            }

            const now = Date.now();
            if (now - state.lastDriverSent < 8000) return;
            state.lastDriverSent = now;

            try {
                await fetch("/api/driver-location", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        telegramId: window.telegramUserId || "",
                        latitude,
                        longitude,
                        accuracy: position.coords.accuracy || null
                    })
                });
                setDriverStatus(`Онлайн • ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`, "ok");
            } catch (_) {
                setDriverStatus("Координаты получены, но не отправлены на сервер.", "error");
            }
        }, error => {
            const message = error.code === 1 ? "Разрешите геолокацию для Telegram." : "Не удалось получить координаты.";
            setDriverStatus(message, "error");
        }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });

        const button = document.getElementById("driverLocationBtn");
        if (button) button.textContent = "📍 Геолокация включена";
    }

    function setDriverStatus(text, type) {
        const el = document.getElementById("driverLocationStatus");
        if (!el) return;
        el.textContent = text;
        el.classList.toggle("ok", type === "ok");
        el.classList.toggle("error", type === "error");
    }

    function hookOrderRequest() {
        if (window.__taxiMapsFetchHooked) return;
        window.__taxiMapsFetchHooked = true;
        const nativeFetch = window.fetch.bind(window);

        window.fetch = async function(input, init = {}) {
            const url = typeof input === "string" ? input : input?.url || "";
            if (url.includes("/api/send-order") && init && typeof init.body === "string") {
                try {
                    const body = JSON.parse(init.body);
                    body.pickupLat = state.pickup.lat;
                    body.pickupLng = state.pickup.lng;
                    body.destinationLat = state.destination.lat;
                    body.destinationLng = state.destination.lng;
                    init = { ...init, body: JSON.stringify(body) };
                } catch (_) {}
            }
            return nativeFetch(input, init);
        };
    }

    function hookOrderStatus() {
        if (window.__taxiMapsStatusHooked) return;
        window.__taxiMapsStatusHooked = true;
        const nativeFetch = window.fetch.bind(window);
        window.fetch = async function(input, init) {
            const response = await nativeFetch(input, init);
            const url = typeof input === "string" ? input : input?.url || "";
            if (url.includes("/api/order-status")) {
                try {
                    const clone = response.clone();
                    const data = await clone.json();
                    if (data && data.driverLatitude && data.driverLongitude) {
                        setTimeout(() => updatePassengerTracking(data), 0);
                    }
                } catch (_) {}
            }
            return response;
        };
    }

    function setup() {
        addStyles();
        ensurePassengerMapUI();
        ensureAcceptedMapUI();
        ensureDriverMapUI();
        bindAddressGeocoding();
        hookOrderRequest();
        hookOrderStatus();

        loadLeaflet().then(() => {
            initPassengerMap();
            initDriverMap();
            initTrackingMap();
        }).catch(() => {
            window.toast?.("Не удалось загрузить карту. Проверьте интернет.", true);
        });

        const driverScreen = document.getElementById("driverScreen");
        if (driverScreen && !driverScreen.classList.contains("hidden")) {
            setTimeout(startDriverLocation, 700);
        }

        const originalDetectDriver = window.detectDriver;
        if (typeof originalDetectDriver === "function" && !window.__taxiMapsDriverHooked) {
            window.__taxiMapsDriverHooked = true;
            window.detectDriver = async function(...args) {
                const result = await originalDetectDriver.apply(this, args);
                ensureDriverMapUI();
                setTimeout(() => {
                    loadLeaflet().then(() => {
                        initDriverMap();
                        startDriverLocation();
                    });
                }, 500);
                return result;
            };
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", setup);
    } else {
        setup();
    }
})();
