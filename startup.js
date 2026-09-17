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

        if (!scripts.length) return;

        const script = `\n${scripts.join("\n")}\n`;
        const marker = "</body>";

        if (html.includes(marker)) {
            html = html.replace(marker, script + marker);
            fs.writeFileSync(indexPath, html, "utf8");
            console.log("Карты, геолокация и автоподсказки подключены.");
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
        const columns = [
            ["passengers", "telegram_id"],
            ["drivers", "telegram_id"],
            ["passenger_orders", "id"],
            ["passenger_orders", "telegram_user_id"],
            ["passenger_orders", "driver_telegram_id"]
        ];

        for (const [table, column] of columns) {
            const result = await pool.query(
                `
                SELECT data_type
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = $1
                  AND column_name = $2
                `,
                [table, column]
            );

            if (!result.rows.length) continue;

            if (result.rows[0].data_type !== "text") {
                console.log(`Исправляем ${table}.${column}: ${result.rows[0].data_type} -> text`);
                await pool.query(
                    `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE TEXT USING ${column}::text`
                );
            }
        }

        const legacyColumn = await pool.query(`
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'passenger_orders'
              AND column_name = 'telegram_id'
        `);

        const currentColumn = await pool.query(`
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'passenger_orders'
              AND column_name = 'telegram_user_id'
        `);

        if (legacyColumn.rows.length && currentColumn.rows.length) {
            await pool.query(`
                UPDATE passenger_orders
                SET telegram_user_id = telegram_id
                WHERE (telegram_user_id IS NULL OR telegram_user_id = '')
                  AND telegram_id IS NOT NULL
            `);

            await pool.query(`
                ALTER TABLE passenger_orders
                ALTER COLUMN telegram_id DROP NOT NULL
            `);

            console.log("Старая колонка passenger_orders.telegram_id исправлена.");
        }

        const migrations = [
            `ALTER TABLE drivers ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION`,
            `ALTER TABLE drivers ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION`,
            `ALTER TABLE drivers ADD COLUMN IF NOT EXISTS location_accuracy DOUBLE PRECISION`,
            `ALTER TABLE drivers ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ`,
            `ALTER TABLE passenger_orders ADD COLUMN IF NOT EXISTS pickup_lat DOUBLE PRECISION`,
            `ALTER TABLE passenger_orders ADD COLUMN IF NOT EXISTS pickup_lng DOUBLE PRECISION`,
            `ALTER TABLE passenger_orders ADD COLUMN IF NOT EXISTS destination_lat DOUBLE PRECISION`,
            `ALTER TABLE passenger_orders ADD COLUMN IF NOT EXISTS destination_lng DOUBLE PRECISION`
        ];

        for (const sql of migrations) {
            try {
                await pool.query(sql);
            } catch (error) {
                console.error("Map migration error:", error.message);
            }
        }

        console.log("Миграция координат карт завершена.");
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

        app.post("/api/driver-location", async (req, res) => {
            try {
                if (!runtimePool) {
                    return res.status(500).json({
                        success: false,
                        error: "PostgreSQL не подключён"
                    });
                }

                const telegramId = normalizeId(req.body?.telegramId);
                const latitude = Number(req.body?.latitude);
                const longitude = Number(req.body?.longitude);
                const accuracy = req.body?.accuracy == null
                    ? null
                    : Number(req.body.accuracy);

                if (!driverAllowed(telegramId)) {
                    return res.status(403).json({
                        success: false,
                        error: "Нет доступа водителя."
                    });
                }

                if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                    return res.status(400).json({
                        success: false,
                        error: "Некорректные координаты."
                    });
                }

                await runtimePool.query(
                    `
                    UPDATE drivers
                    SET
                        latitude = $1,
                        longitude = $2,
                        location_accuracy = $3,
                        location_updated_at = NOW(),
                        updated_at = NOW()
                    WHERE telegram_id = $4
                    `,
                    [latitude, longitude, Number.isFinite(accuracy) ? accuracy : null, telegramId]
                );

                return res.json({
                    success: true,
                    latitude,
                    longitude,
                    updatedAt: new Date().toISOString()
                });
            } catch (error) {
                console.error("driver-location:", error);
                return res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        app.use((req, res, next) => {
            const originalJson = res.json.bind(res);

            res.json = function(data) {
                const finish = async () => {
                    try {
                        if (!runtimePool || !data) {
                            return originalJson(data);
                        }

                        const requestPath = req.path || "";

                        if (
                            requestPath === "/api/send-order" &&
                            req.method === "POST" &&
                            data.orderId
                        ) {
                            const body = req.body || {};
                            const values = [
                                body.pickupLat,
                                body.pickupLng,
                                body.destinationLat,
                                body.destinationLng
                            ].map(value => {
                                const number = Number(value);
                                return Number.isFinite(number) ? number : null;
                            });

                            await runtimePool.query(
                                `
                                UPDATE passenger_orders
                                SET
                                    pickup_lat = $1,
                                    pickup_lng = $2,
                                    destination_lat = $3,
                                    destination_lng = $4
                                WHERE id = $5
                                `,
                                [...values, String(data.orderId)]
                            );

                            data.pickupLatitude = values[0];
                            data.pickupLongitude = values[1];
                            data.destinationLatitude = values[2];
                            data.destinationLongitude = values[3];
                        }

                        if (requestPath === "/api/order-status" && data.id) {
                            const result = await runtimePool.query(
                                `
                                SELECT
                                    po.pickup_lat,
                                    po.pickup_lng,
                                    po.destination_lat,
                                    po.destination_lng,
                                    d.latitude AS driver_latitude,
                                    d.longitude AS driver_longitude,
                                    d.location_updated_at AS driver_location_updated_at
                                FROM passenger_orders po
                                LEFT JOIN drivers d
                                  ON d.telegram_id = po.driver_telegram_id
                                WHERE po.id = $1
                                LIMIT 1
                                `,
                                [String(data.id)]
                            );

                            if (result.rows.length) {
                                const row = result.rows[0];
                                data.pickupLatitude = row.pickup_lat;
                                data.pickupLongitude = row.pickup_lng;
                                data.destinationLatitude = row.destination_lat;
                                data.destinationLongitude = row.destination_lng;
                                data.driverLatitude = row.driver_latitude;
                                data.driverLongitude = row.driver_longitude;
                                data.driverLocationUpdatedAt = row.driver_location_updated_at;
                            }
                        }

                        if (requestPath === "/api/driver-orders" && Array.isArray(data)) {
                            const ids = data.map(item => String(item.id)).filter(Boolean);
                            if (ids.length) {
                                const result = await runtimePool.query(
                                    `
                                    SELECT
                                        id,
                                        pickup_lat,
                                        pickup_lng,
                                        destination_lat,
                                        destination_lng
                                    FROM passenger_orders
                                    WHERE id = ANY($1::text[])
                                    `,
                                    [ids]
                                );

                                const byId = new Map(result.rows.map(row => [String(row.id), row]));
                                data = data.map(item => {
                                    const row = byId.get(String(item.id));
                                    if (!row) return item;
                                    return {
                                        ...item,
                                        pickupLatitude: row.pickup_lat,
                                        pickupLongitude: row.pickup_lng,
                                        destinationLatitude: row.destination_lat,
                                        destinationLongitude: row.destination_lng
                                    };
                                });
                            }
                        }

                        if (requestPath === "/api/get-order" && data.id) {
                            const result = await runtimePool.query(
                                `
                                SELECT pickup_lat, pickup_lng, destination_lat, destination_lng
                                FROM passenger_orders
                                WHERE id = $1
                                LIMIT 1
                                `,
                                [String(data.id)]
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
        try {
            patchedExpress[key] = originalExpress[key];
        } catch (_) {}
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
