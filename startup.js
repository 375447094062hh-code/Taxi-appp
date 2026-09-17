const expressModule = require("express");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const DATABASE_URL = process.env.DATABASE_URL || "";
const DRIVER_CHAT_IDS = (process.env.DRIVER_CHAT_IDS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

const runtimePool = DATABASE_URL
    ? new Pool({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    })
    : null;

function injectClientScripts() {
    try {
        const indexPath = path.join(__dirname, "public", "index.html");
        if (!fs.existsSync(indexPath)) return;

        let html = fs.readFileSync(indexPath, "utf8");
        const scripts = [];

        if (!html.includes("/address-autocomplete.js")) {
            scripts.push('<script src="/address-autocomplete.js"></script>');
        }
        if (!html.includes("/maps.js")) {
            scripts.push('<script src="/maps.js"></script>');
        }
        if (!html.includes("/driver-vehicles.js")) {
            scripts.push('<script src="/driver-vehicles.js"></script>');
        }

        if (!scripts.length) return;

        const script = `\n${scripts.join("\n")}\n`;
        const marker = "</body>";

        if (html.includes(marker)) {
            html = html.replace(marker, script + marker);
            fs.writeFileSync(indexPath, html, "utf8");
            console.log("Карты, автоподсказки и каталог автомобилей подключены.");
        }
    } catch (error) {
        console.error("Ошибка подключения клиентских скриптов:", error.message);
    }
}

async function migrate() {
    if (!DATABASE_URL) {
        console.log("DATABASE_URL не задан — пропускаем миграцию.");
        return;
    }

    const pool = runtimePool;

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS drivers (
                telegram_id TEXT PRIMARY KEY,
                name TEXT,
                car TEXT,
                plate TEXT,
                phone TEXT,
                photo_file_id TEXT,
                rating NUMERIC(3,2) NOT NULL DEFAULT 5.00,
                has_child_seat BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS passengers (
                telegram_id TEXT PRIMARY KEY,
                name TEXT,
                phone TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS passenger_orders (
                id TEXT PRIMARY KEY,
                telegram_user_id TEXT NOT NULL,
                address_a TEXT,
                address_b TEXT,
                tariff TEXT,
                scheduled TEXT,
                scheduled_at TIMESTAMPTZ,
                is_immediate BOOLEAN NOT NULL DEFAULT TRUE,
                is_weekend BOOLEAN NOT NULL DEFAULT FALSE,
                child_seat BOOLEAN NOT NULL DEFAULT FALSE,
                status TEXT NOT NULL DEFAULT 'searching',
                driver_telegram_id TEXT,
                driver_name TEXT,
                driver_car TEXT,
                driver_number TEXT,
                driver_phone TEXT,
                driver_rating NUMERIC(3,2),
                driver_photo_file_id TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                accepted_at TIMESTAMPTZ,
                arrived_at TIMESTAMPTZ,
                trip_started_at TIMESTAMPTZ,
                completed_at TIMESTAMPTZ
            )
        `);

        const columns = [
            ["passengers", "telegram_id"],
            ["drivers", "telegram_id"],
            ["passenger_orders", "id"],
            ["passenger_orders", "telegram_user_id"],
            ["passenger_orders", "driver_telegram_id"]
        ];

        for (const [table, column] of columns) {
            const result = await pool.query(
                `SELECT data_type FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
                [table, column]
            );

            if (!result.rows.length) continue;

            if (result.rows[0].data_type !== "text") {
                await pool.query(
                    `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE TEXT USING ${column}::text`
                );
            }
        }

        const legacyColumn = await pool.query(`
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'passenger_orders' AND column_name = 'telegram_id'
        `);
        const currentColumn = await pool.query(`
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'passenger_orders' AND column_name = 'telegram_user_id'
        `);

        if (legacyColumn.rows.length && currentColumn.rows.length) {
            await pool.query(`
                UPDATE passenger_orders SET telegram_user_id = telegram_id
                WHERE (telegram_user_id IS NULL OR telegram_user_id = '') AND telegram_id IS NOT NULL
            `);
            await pool.query(`ALTER TABLE passenger_orders ALTER COLUMN telegram_id DROP NOT NULL`);
        }

        const migrations = [
            `ALTER TABLE passenger_orders ADD COLUMN IF NOT EXISTS pickup_lat DOUBLE PRECISION`,
            `ALTER TABLE passenger_orders ADD COLUMN IF NOT EXISTS pickup_lng DOUBLE PRECISION`,
            `ALTER TABLE passenger_orders ADD COLUMN IF NOT EXISTS destination_lat DOUBLE PRECISION`,
            `ALTER TABLE passenger_orders ADD COLUMN IF NOT EXISTS destination_lng DOUBLE PRECISION`
        ];

        for (const sql of migrations) {
            try { await pool.query(sql); } catch (error) { console.error("Map migration error:", error.message); }
        }

        console.log("Миграция координат маршрута завершена.");
    } catch (error) {
        console.error("Ошибка миграции:", error.message);
        throw error;
    }
}

function normalizeId(value) {
    return value === undefined || value === null ? "" : String(value);
}

function driverAllowed(id) {
    const normalized = normalizeId(id);
    if (!normalized) return false;
    return DRIVER_CHAT_IDS.length === 0 || DRIVER_CHAT_IDS.includes(normalized);
}

function installExpressHooks() {
    const originalExpress = expressModule;

    function patchedExpress(...args) {
        const app = originalExpress(...args);

        if (app.__taxiMapsHooksInstalled) return app;
        app.__taxiMapsHooksInstalled = true;

        app.use(originalExpress.json({ limit: "2mb" }));

        app.get("/api/maps-config", (req, res) => {
            res.json({
                provider: "yandex",
                apiKey: process.env.YANDEX_MAPS_API_KEY || ""
            });
        });

        app.post("/api/driver-location", async (req, res) => {
            try {
                if (!runtimePool) return res.status(500).json({ success: false, error: "PostgreSQL не подключён" });
                const telegramId = normalizeId(req.body?.telegramId);
                const latitude = Number(req.body?.latitude);
                const longitude = Number(req.body?.longitude);
                const accuracy = req.body?.accuracy == null ? null : Number(req.body.accuracy);
                if (!driverAllowed(telegramId)) return res.status(403).json({ success: false, error: "Нет доступа водителя." });
                if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return res.status(400).json({ success: false, error: "Некорректные координаты." });
                return res.json({ success: true, latitude, longitude, accuracy, updatedAt: new Date().toISOString() });
            } catch (error) {
                return res.status(500).json({ success: false, error: error.message });
            }
        });

        app.use((req, res, next) => {
            const originalJson = res.json.bind(res);

            res.json = function(data) {
                const finish = async () => {
                    try {
                        if (!runtimePool || !data) return originalJson(data);
                        const requestPath = req.path || "";

                        if (requestPath === "/api/passenger-profile" && data.profile) {
                            data.name = data.profile.name || "";
                            data.phone = data.profile.phone || "";
                            data.telegramId = data.profile.telegramId || data.telegramId || "";
                        }

                        if (requestPath === "/api/send-order" && req.method === "POST" && data.orderId) {
                            const body = req.body || {};
                            const values = [body.pickupLat, body.pickupLng, body.destinationLat, body.destinationLng].map(value => {
                                const number = Number(value);
                                return Number.isFinite(number) ? number : null;
                            });

                            await runtimePool.query(
                                `UPDATE passenger_orders
                                 SET pickup_lat = $1, pickup_lng = $2, destination_lat = $3, destination_lng = $4
                                 WHERE id = $5`,
                                [...values, String(data.orderId)]
                            );

                            data.pickupLatitude = values[0];
                            data.pickupLongitude = values[1];
                            data.destinationLatitude = values[2];
                            data.destinationLongitude = values[3];
                        }

                        if (requestPath === "/api/order-status" && data.id) {
                            const result = await runtimePool.query(
                                `SELECT pickup_lat, pickup_lng, destination_lat, destination_lng,
                                        d.phone AS driver_db_phone
                                 FROM passenger_orders po
                                 LEFT JOIN drivers d ON d.telegram_id = po.driver_telegram_id
                                 WHERE po.id = $1 LIMIT 1`,
                                [String(data.id)]
                            );

                            if (result.rows.length) {
                                const row = result.rows[0];
                                data.pickupLatitude = row.pickup_lat;
                                data.pickupLongitude = row.pickup_lng;
                                data.destinationLatitude = row.destination_lat;
                                data.destinationLongitude = row.destination_lng;
                                if (!data.driverPhone && row.driver_db_phone) data.driverPhone = row.driver_db_phone;
                            }
                        }

                        if (requestPath === "/api/driver-orders" && Array.isArray(data)) {
                            const ids = data.map(item => String(item.id)).filter(Boolean);
                            if (ids.length) {
                                const result = await runtimePool.query(
                                    `SELECT id, pickup_lat, pickup_lng, destination_lat, destination_lng
                                     FROM passenger_orders WHERE id = ANY($1::text[])`, [ids]
                                );
                                const byId = new Map(result.rows.map(row => [String(row.id), row]));
                                data = data.map(item => {
                                    const row = byId.get(String(item.id));
                                    return row ? { ...item,
                                        pickupLatitude: row.pickup_lat,
                                        pickupLongitude: row.pickup_lng,
                                        destinationLatitude: row.destination_lat,
                                        destinationLongitude: row.destination_lng
                                    } : item;
                                });
                            }
                        }

                        if (requestPath === "/api/get-order" && data.id) {
                            const result = await runtimePool.query(
                                `SELECT pickup_lat, pickup_lng, destination_lat, destination_lng
                                 FROM passenger_orders WHERE id = $1 LIMIT 1`, [String(data.id)]
                            );
                            if (result.rows.length) {
                                const row = result.rows[0];
                                data.pickupLatitude = row.pickup_lat;
                                data.pickupLongitude = row.pickup_lng;
                                data.destinationLatitude = row.destination_lat;
                                data.destinationLongitude = row.destination_lng;
                            }
                        }
                    } catch (error) {
                        console.error("Map response enrichment:", error.message);
                    }
                    return originalJson(data);
                };
                return finish();
            };
            next();
        });

        return app;
    }

    Object.setPrototypeOf(patchedExpress, originalExpress);
    for (const key of Object.keys(originalExpress)) {
        try { patchedExpress[key] = originalExpress[key]; } catch (_) {}
    }
    require.cache[require.resolve("express")].exports = patchedExpress;
}

injectClientScripts();

migrate()
    .then(() => {
        installExpressHooks();
        require("./server.js");
    })
    .catch((error) => {
        console.error("Ошибка запуска миграции PostgreSQL:", error);
        process.exit(1);
    });
