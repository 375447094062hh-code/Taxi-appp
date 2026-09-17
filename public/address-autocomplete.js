(() => {
    const INPUT_IDS = ["addressA", "addressB"];
    const MIN_CHARS = 2;
    const DEBOUNCE_MS = 450;
    let activeBox = null;
    let debounceTimers = new Map();
    let requestControllers = new Map();

    function addStyles() {
        if (document.getElementById("address-autocomplete-styles")) return;

        const style = document.createElement("style");
        style.id = "address-autocomplete-styles";
        style.textContent = `
            .address-autocomplete-wrap {
                position: relative;
                width: 100%;
            }

            .address-suggestions {
                position: absolute;
                left: 0;
                right: 0;
                top: calc(100% + 6px);
                z-index: 1000;
                display: none;
                overflow: hidden;
                border-radius: 15px;
                background: #111a29;
                border: 1px solid #2a3850;
                box-shadow: 0 16px 38px rgba(0,0,0,.42);
            }

            .address-suggestions.show {
                display: block;
            }

            .address-suggestion {
                display: flex;
                align-items: flex-start;
                gap: 10px;
                width: 100%;
                padding: 12px 13px;
                border: 0;
                border-bottom: 1px solid #202d41;
                background: transparent;
                color: #fff;
                text-align: left;
                cursor: pointer;
            }

            .address-suggestion:last-child {
                border-bottom: 0;
            }

            .address-suggestion:active,
            .address-suggestion:hover {
                background: rgba(250,204,21,.08);
            }

            .address-suggestion-icon {
                width: 25px;
                height: 25px;
                flex: 0 0 25px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 8px;
                background: rgba(250,204,21,.10);
                color: #facc15;
                font-size: 13px;
            }

            .address-suggestion-text {
                min-width: 0;
                font-size: 12px;
                line-height: 1.35;
            }

            .address-suggestion-main {
                display: block;
                color: #fff;
                font-weight: 750;
            }

            .address-suggestion-detail {
                display: block;
                margin-top: 3px;
                color: #74829a;
                font-size: 10px;
            }

            .address-loading {
                padding: 12px 13px;
                color: #7f8ca3;
                font-size: 11px;
            }
        `;

        document.head.appendChild(style);
    }

    function normalizeText(value) {
        return String(value || "")
            .replace(/\\s+/g, " ")
            .trim();
    }

    function getDisplayAddress(item) {
        const address = item.address || {};
        const house = address.house_number ? `, ${address.house_number}` : "";
        const road = address.road || address.pedestrian || address.footway || "";
        const city = address.city || address.town || address.village || "";

        if (road) {
            return `${road}${house}${city ? `, ${city}` : ""}`;
        }

        return normalizeText(item.display_name).replace(/, Беларусь$/i, "");
    }

    function getDetail(item) {
        const address = item.address || {};
        const parts = [];

        const city = address.city || address.town || address.village || "";
        const district = address.suburb || address.neighbourhood || "";

        if (district && district !== city) parts.push(district);
        if (city) parts.push(city);

        return parts.join(", ");
    }

    function closeAll() {
        document.querySelectorAll(".address-suggestions").forEach(box => {
            box.classList.remove("show");
        });
        activeBox = null;
    }

    function createBox(input) {
        const parent = input.parentElement;
        const wrap = document.createElement("div");
        wrap.className = "address-autocomplete-wrap";

        parent.insertBefore(wrap, input);
        wrap.appendChild(input);

        const box = document.createElement("div");
        box.className = "address-suggestions";
        wrap.appendChild(box);

        return box;
    }

    function showLoading(box) {
        box.innerHTML = '<div class="address-loading">🔎 Ищем адреса...</div>';
        box.classList.add("show");
        activeBox = box;
    }

    function showResults(input, box, results) {
        box.innerHTML = "";

        const seen = new Set();

        results.forEach(item => {
            const address = normalizeText(getDisplayAddress(item));
            if (!address || seen.has(address.toLowerCase())) return;
            seen.add(address.toLowerCase());

            const button = document.createElement("button");
            button.type = "button";
            button.className = "address-suggestion";

            const icon = document.createElement("span");
            icon.className = "address-suggestion-icon";
            icon.textContent = "⌖";

            const text = document.createElement("span");
            text.className = "address-suggestion-text";

            const main = document.createElement("span");
            main.className = "address-suggestion-main";
            main.textContent = address;
            text.appendChild(main);

            const detail = getDetail(item);
            if (detail) {
                const detailEl = document.createElement("span");
                detailEl.className = "address-suggestion-detail";
                detailEl.textContent = detail;
                text.appendChild(detailEl);
            }

            button.appendChild(icon);
            button.appendChild(text);

            button.addEventListener("mousedown", event => {
                event.preventDefault();
            });

            button.addEventListener("click", () => {
                input.value = address;
                input.dispatchEvent(new Event("input", { bubbles: true }));
                box.classList.remove("show");
                activeBox = null;
            });

            box.appendChild(button);
        });

        if (!box.children.length) {
            box.innerHTML = '<div class="address-loading">Адрес не найден. Можно ввести его вручную.</div>';
        }

        box.classList.add("show");
        activeBox = box;
    }

    async function searchAddresses(input, box, value) {
        const query = normalizeText(value);

        if (query.length < MIN_CHARS) {
            box.classList.remove("show");
            return;
        }

        const oldController = requestControllers.get(input);
        if (oldController) oldController.abort();

        const controller = new AbortController();
        requestControllers.set(input, controller);

        showLoading(box);

        try {
            const url = new URL("https://nominatim.openstreetmap.org/search");
            url.searchParams.set("format", "jsonv2");
            url.searchParams.set("addressdetails", "1");
            url.searchParams.set("limit", "6");
            url.searchParams.set("countrycodes", "by");
            url.searchParams.set("accept-language", "ru");
            url.searchParams.set("q", `Речица, ${query}`);

            const response = await fetch(url.toString(), {
                signal: controller.signal,
                headers: {
                    "Accept": "application/json"
                }
            });

            if (!response.ok) throw new Error("Address search failed");

            const results = await response.json();
            showResults(input, box, Array.isArray(results) ? results : []);
        } catch (error) {
            if (error.name === "AbortError") return;

            console.error("ADDRESS SEARCH ERROR:", error);
            box.innerHTML = '<div class="address-loading">Не удалось загрузить подсказки. Адрес можно ввести вручную.</div>';
            box.classList.add("show");
        }
    }

    function setupInput(input) {
        if (!input || input.dataset.addressAutocomplete === "1") return;

        input.dataset.addressAutocomplete = "1";
        const box = createBox(input);

        input.addEventListener("input", () => {
            clearTimeout(debounceTimers.get(input));
            const value = input.value;

            debounceTimers.set(input, setTimeout(() => {
                searchAddresses(input, box, value);
            }, DEBOUNCE_MS));
        });

        input.addEventListener("focus", () => {
            if (normalizeText(input.value).length >= MIN_CHARS) {
                searchAddresses(input, box, input.value);
            }
        });

        input.addEventListener("keydown", event => {
            if (event.key === "Escape") {
                box.classList.remove("show");
            }
        });
    }

    function init() {
        addStyles();
        INPUT_IDS.forEach(id => setupInput(document.getElementById(id)));
    }

    document.addEventListener("click", event => {
        if (activeBox && !activeBox.parentElement.contains(event.target)) {
            closeAll();
        }
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
