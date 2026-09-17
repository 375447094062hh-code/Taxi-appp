const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

app.use(express.json({ limit: "2mb" }));

// Telegram Mini App: всегда отдаём свежий HTML, чтобы старый профиль/режим не кэшировался.
app.use((req, res, next) => {
    if (req.path === "/" || req.path === "/index.html" || req.path.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
    }
    next();
});

const publicPath = path.join(__dirname, "public");

if (fs.existsSync(publicPath)) {
    app.use(express.static(publicPath));
}

app.use(express.static(__dirname));

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

const DATABASE_URL = process.env.DATABASE_URL || "";

const DRIVER_CHAT_IDS = (process.env.DRIVER_CHAT_IDS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

const MAX_NORMAL_ACTIVE_ORDERS = 2;
const FUTURE_ORDER_BLOCK_MINUTES = 15;

const ACTIVE_STATUSES = [
    "accepted",
    "arrived",
    "trip"
];

let pool = null;

if (DATABASE_URL) {
    pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    });
}

let telegramOffset = 0;
let telegramPolling = false;

const driverChats = new Map();

const sentOrderMessages = new Map();


// ============================================================
// HELPERS
// ============================================================

function now() {
    return new Date();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function makeId() {
    return crypto.randomUUID();
}

function normalizeTelegramId(value) {
    if (value === undefined || value === null) {
        return "";
    }

    return String(value);
}

function isDriverTelegramId(telegramId) {
    const id = normalizeTelegramId(telegramId);

    if (!id) {
        return false;
    }

    if (DRIVER_CHAT_IDS.length > 0) {
        return DRIVER_CHAT_IDS.includes(id);
    }

    return driverChats.has(Number(id)) ||
        driverChats.has(id);
}

function getDriverChat(telegramId) {
    const id = normalizeTelegramId(telegramId);

    return (
        driverChats.get(Number(id)) ||
        driverChats.get(id) ||
        null
    );
}


// ============================================================
// TELEGRAM API
// ============================================================

async function telegram(method, body = {}) {

    if (!BOT_TOKEN) {
        throw new Error(
            "TELEGRAM_BOT_TOKEN не задан в Render"
        );
    }

    const response = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        }
    );

    const data = await response.json();

    if (!data.ok) {
        throw new Error(
            data.description ||
            `Telegram API error: ${method}`
        );
    }

    return data.result;
}


async function sendTelegramMessage(
    chatId,
    text,
    extra = {}
) {
    return telegram(
        "sendMessage",
        {
            chat_id: chatId,
            text,
            ...extra
        }
    );
}


// ============================================================
// DATABASE
// ============================================================

async function initDatabase() {

    if (!pool) {
        console.error(
            "DATABASE_URL не задан. PostgreSQL отключён."
        );

        return;
    }

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
        );
    `);


    await pool.query(`
        CREATE TABLE IF NOT EXISTS passengers (
            telegram_id TEXT PRIMARY KEY,
            name TEXT,
            phone TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
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
        );
    `);


    // --------------------------------------------------------
    // MIGRATIONS
    // --------------------------------------------------------

    const migrations = [

        `ALTER TABLE drivers
         ADD COLUMN IF NOT EXISTS has_child_seat
         BOOLEAN NOT NULL DEFAULT FALSE`,

        `ALTER TABLE passengers
         ADD COLUMN IF NOT EXISTS name TEXT`,

        `ALTER TABLE passengers
         ADD COLUMN IF NOT EXISTS phone TEXT`,

        `ALTER TABLE passenger_orders
         ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ`,

        `ALTER TABLE passenger_orders
         ADD COLUMN IF NOT EXISTS is_immediate
         BOOLEAN NOT NULL DEFAULT TRUE`,

        `ALTER TABLE passenger_orders
         ADD COLUMN IF NOT EXISTS is_weekend
         BOOLEAN NOT NULL DEFAULT FALSE`,

        `ALTER TABLE passenger_orders
         ADD COLUMN IF NOT EXISTS child_seat
         BOOLEAN NOT NULL DEFAULT FALSE`,

        `ALTER TABLE passenger_orders
         ADD COLUMN IF NOT EXISTS driver_phone TEXT`,

        `ALTER TABLE passenger_orders
         ADD COLUMN IF NOT EXISTS driver_rating NUMERIC(3,2)`,

        `ALTER TABLE passenger_orders
         ADD COLUMN IF NOT EXISTS driver_photo_file_id TEXT`,

        `ALTER TABLE passenger_orders
         ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ`,

        `ALTER TABLE passenger_orders
         ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ`,

        `ALTER TABLE passenger_orders
         ADD COLUMN IF NOT EXISTS trip_started_at TIMESTAMPTZ`,

        `ALTER TABLE passenger_orders
         ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`
    ];


    for (const sql of migrations) {

        try {
            await pool.query(sql);
        } catch (error) {
            console.error(
                "Migration error:",
                error.message
            );
        }
    }


    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_orders_driver_status
        ON passenger_orders(driver_telegram_id, status);
    `);


    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_orders_passenger
        ON passenger_orders(telegram_user_id, created_at DESC);
    `);


    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_orders_status
        ON passenger_orders(status);
    `);


    console.log("PostgreSQL: база готова");
}


// ============================================================
// PASSENGER PROFILE
// ============================================================

async function getPassenger(telegramId) {

    if (!pool) {
        return null;
    }

    const result = await pool.query(
        `
        SELECT
            telegram_id AS "telegramId",
            name,
            phone
        FROM passengers
        WHERE telegram_id = $1
        `,
        [normalizeTelegramId(telegramId)]
    );

    return result.rows[0] || null;
}


async function savePassenger(
    telegramId,
    name,
    phone
) {

    if (!pool) {
        throw new Error(
            "PostgreSQL не подключён"
        );
    }

    const result = await pool.query(
        `
        INSERT INTO passengers
            (telegram_id, name, phone)
        VALUES
            ($1, $2, $3)
        ON CONFLICT (telegram_id)
        DO UPDATE SET
            name = EXCLUDED.name,
            phone = EXCLUDED.phone,
            updated_at = NOW()
        RETURNING
            telegram_id AS "telegramId",
            name,
            phone
        `,
        [
            normalizeTelegramId(telegramId),
            name || "",
            phone || ""
        ]
    );

    return result.rows[0];
}


// ============================================================
// DRIVER PROFILE
// ============================================================

async function getDriver(telegramId) {

    if (!pool) {
        return null;
    }

    const result = await pool.query(
        `
        SELECT
            telegram_id AS "telegramId",
            name,
            car,
            plate,
            phone,
            photo_file_id AS "photoFileId",
            rating,
            has_child_seat AS "hasChildSeat"
        FROM drivers
        WHERE telegram_id = $1
        `,
        [normalizeTelegramId(telegramId)]
    );

    return result.rows[0] || null;
}


async function saveDriver(
    telegramId,
    name,
    car,
    plate,
    phone,
    photoFileId,
    hasChildSeat
) {

    if (!pool) {
        throw new Error(
            "PostgreSQL не подключён"
        );
    }

    const result = await pool.query(
        `
        INSERT INTO drivers
        (
            telegram_id,
            name,
            car,
            plate,
            phone,
            photo_file_id,
            has_child_seat
        )
        VALUES
        ($1,$2,$3,$4,$5,$6,$7)

        ON CONFLICT (telegram_id)
        DO UPDATE SET

            name = EXCLUDED.name,
            car = EXCLUDED.car,
            plate = EXCLUDED.plate,
            phone = EXCLUDED.phone,
            photo_file_id = EXCLUDED.photo_file_id,
            has_child_seat = EXCLUDED.has_child_seat,
            updated_at = NOW()

        RETURNING *
        `,
        [
            normalizeTelegramId(telegramId),
            name || "",
            car || "",
            plate || "",
            phone || "",
            photoFileId || "",
            Boolean(hasChildSeat)
        ]
    );

    return result.rows[0];
}


// ============================================================
// SCHEDULE PARSER
// ============================================================

function parseScheduledAt(order) {

    if (!order) {
        return null;
    }


    if (order.scheduledAt) {

        const date =
            new Date(order.scheduledAt);

        if (!Number.isNaN(date.getTime())) {
            return date;
        }
    }


    const text =
        String(order.scheduled || "")
            .trim();


    if (!text) {
        return null;
    }


    // Сегодня 18:00
    let match =
        text.match(
            /^Сегодня\s+(\d{1,2}):(\d{2})$/i
        );

    if (match) {

        const [, h, m] = match;

        return makeMinskDate(
            new Date().toISOString().slice(0, 10),
            Number(h),
            Number(m)
        );
    }


    // Завтра 18:00
    match =
        text.match(
            /^Завтра\s+(\d{1,2}):(\d{2})$/i
        );

    if (match) {

        const tomorrow =
            new Date(
                Date.now() + 86400000
            );

        const date =
            tomorrow
                .toISOString()
                .slice(0, 10);

        return makeMinskDate(
            date,
            Number(match[1]),
            Number(match[2])
        );
    }


    // 17.09.2026 в 22:30
    match =
        text.match(
            /(\d{1,2})\.(\d{1,2})\.(\d{4}).*?(\d{1,2}):(\d{2})/
        );

    if (match) {

        const day = Number(match[1]);
        const month = Number(match[2]);
        const year = Number(match[3]);
        const hour = Number(match[4]);
        const minute = Number(match[5]);

        return makeMinskDateParts(
            year,
            month,
            day,
            hour,
            minute
        );
    }


    // YYYY-MM-DD ... HH:mm
    match =
        text.match(
            /(\d{4})-(\d{2})-(\d{2}).*?(\d{1,2}):(\d{2})/
        );

    if (match) {

        return makeMinskDateParts(
            Number(match[1]),
            Number(match[2]),
            Number(match[3]),
            Number(match[4]),
            Number(match[5])
        );
    }


    return null;
}


function makeMinskDate(
    isoDate,
    hour,
    minute
) {

    const [
        year,
        month,
        day
    ] =
        isoDate
            .split("-")
            .map(Number);

    return makeMinskDateParts(
        year,
        month,
        day,
        hour,
        minute
    );
}


function makeMinskDateParts(
    year,
    month,
    day,
    hour,
    minute
) {

    // Беларусь UTC+3
    const utc =
        Date.UTC(
            year,
            month - 1,
            day,
            hour,
            minute
        ) -
        (3 * 60 * 60 * 1000);

    return new Date(utc);
}


// ============================================================
// DRIVER AVAILABILITY
// ============================================================

async function checkDriverAvailability(
    driverTelegramId,
    newOrder,
    client = pool
) {

    const driverId =
        normalizeTelegramId(
            driverTelegramId
        );


    const result =
        await client.query(
            `
            SELECT *
            FROM passenger_orders
            WHERE driver_telegram_id = $1
              AND status = ANY($2::text[])
            ORDER BY created_at ASC
            `,
            [
                driverId,
                ACTIVE_STATUSES
            ]
        );


    const activeOrders =
        result.rows;


    const nowMs =
        Date.now();


    // --------------------------------------------------------
    // Блокировка из-за будущего заказа
    // --------------------------------------------------------

    for (const order of activeOrders) {

        const scheduled =
            order.scheduled_at
                ? new Date(order.scheduled_at)
                : parseScheduledAt({
                    scheduledAt:
                        order.scheduled_at,
                    scheduled:
                        order.scheduled
                });


        if (!scheduled) {
            continue;
        }


        const scheduledMs =
            scheduled.getTime();


        const blockFrom =
            scheduledMs -
            FUTURE_ORDER_BLOCK_MINUTES * 60 * 1000;


        // Уже наступил период блокировки
        if (nowMs >= blockFrom) {

            return {
                allowed: false,

                reason:
                    `Водитель занят будущим заказом #${shortOrderNumber(order.id)}. ` +
                    `Новые заказы запрещены за ${FUTURE_ORDER_BLOCK_MINUTES} минут до подачи.`,

                blockingOrder: order
            };
        }
    }


    // --------------------------------------------------------
    // Новый будущий заказ
    // --------------------------------------------------------

    const newScheduled =
        newOrder.isImmediate
            ? null
            : parseScheduledAt(newOrder);


    if (newScheduled) {

        const newScheduledMs =
            newScheduled.getTime();


        if (
            newScheduledMs <=
            nowMs
        ) {

            return {
                allowed: false,
                reason:
                    "Время будущего заказа уже прошло."
            };
        }
    }


    // --------------------------------------------------------
    // Новый обычный заказ
    // Максимум 2 активных обычных
    // --------------------------------------------------------

    if (newOrder.isImmediate) {

        let immediateCount = 0;


        for (const order of activeOrders) {

            const scheduled =
                order.scheduled_at
                    ? new Date(order.scheduled_at)
                    : parseScheduledAt({
                        scheduledAt:
                            order.scheduled_at,
                        scheduled:
                            order.scheduled
                    });


            if (!scheduled) {
                immediateCount++;
                continue;
            }


            const difference =
                scheduled.getTime() - nowMs;


            if (
                difference >
                FUTURE_ORDER_BLOCK_MINUTES * 60 * 1000
            ) {

                continue;
            }


            immediateCount++;
        }


        if (
            immediateCount >=
            MAX_NORMAL_ACTIVE_ORDERS
        ) {

            return {
                allowed: false,

                reason:
                    `У водителя уже ${MAX_NORMAL_ACTIVE_ORDERS} активных обычных заказа.`
            };
        }
    }


    return {
        allowed: true
    };
}


// ============================================================
// ORDER FORMAT
// ============================================================

function orderText(order) {

    const child =
        order.childSeat
            ? "\n👶 Детское кресло: нужно"
            : "";

    const weekend =
        order.isWeekend
            ? "\n📅 Выходной тариф: да"
            : "";


    return (
        "🚕 НОВЫЙ ЗАКАЗ\n\n" +

        `🆔 Заказ: #${shortOrderNumber(order.id)}\n` +

        `📍 Откуда: ${order.addressA || "-"}\n` +

        `🏁 Куда: ${order.addressB || "-"}\n` +

        `💰 Тариф: ${order.tariff || "-"}\n` +

        `🕐 Время: ${order.scheduled || "-"}\n` +

        `👤 Пассажир: ${order.passengerName || "-"}\n` +

        `📞 Телефон: ${order.passengerPhone || "-"}\n` +

        `${child}${weekend}`
    );
}


// ============================================================
// NOTIFY DRIVERS
// ============================================================

async function notifyDrivers(order) {

    if (!pool) {
        console.error(
            "notifyDrivers: PostgreSQL отсутствует"
        );

        return;
    }


    const result =
        await pool.query(
            `
            SELECT *
            FROM drivers
            `
        );


    const drivers =
        result.rows;


    if (!drivers.length) {

        console.log(
            "Нет водителей в PostgreSQL."
        );

        return;
    }


    for (const driver of drivers) {

        const driverTelegramId =
            normalizeTelegramId(
                driver.telegram_id
            );


        if (
            DRIVER_CHAT_IDS.length > 0 &&
            !DRIVER_CHAT_IDS.includes(
                driverTelegramId
            )
        ) {
            continue;
        }


        // Детское кресло
        if (
            order.childSeat &&
            !driver.has_child_seat
        ) {

            continue;
        }


        const availability =
            await checkDriverAvailability(
                driverTelegramId,
                order
            );


        if (!availability.allowed) {

            console.log(
                `Водитель ${driverTelegramId} пропущен:`,
                availability.reason
            );

            continue;
        }


        const keyboard = {

            inline_keyboard: [

                [
                    {
                        text:
                            "✅ ПРИНЯТЬ ЗАКАЗ",

                        callback_data:
                            `accept:${order.id}`
                    }
                ],

                [
                    {
                        text:
                            "❌ ОТКЛОНИТЬ",

                        callback_data:
                            `reject:${order.id}`
                    }
                ]

            ]
        };


        try {

            const message =
                await sendTelegramMessage(
                    driverTelegramId,
                    orderText(order),
                    {
                        reply_markup:
                            keyboard
                    }
                );


            if (
                !sentOrderMessages.has(
                    order.id
                )
            ) {

                sentOrderMessages.set(
                    order.id,
                    []
                );
            }


            sentOrderMessages
                .get(order.id)
                .push({
                    chatId:
                        driverTelegramId,

                    messageId:
                        message.message_id
                });


        } catch (error) {

            console.error(
                `Ошибка отправки водителю ${driverTelegramId}:`,
                error.message
            );
        }
    }
}


// ============================================================
// NOTIFY PASSENGER
// ============================================================

async function notifyPassengerAccepted(
    order
) {

    if (!order.telegramUserId) {
        return;
    }


    const text =

        "✅ ВОДИТЕЛЬ ПРИНЯЛ ВАШ ЗАКАЗ\n\n" +

        `👤 ${order.driverName || "Водитель"}\n` +

        `🚕 ${order.driverCar || "Автомобиль"}\n` +

        `🔢 ${order.driverNumber || "Номер уточняется"}\n` +

        `📞 ${order.driverPhone || "Телефон недоступен"}\n\n` +

        "🚗 Водитель едет к вам.";


    try {

        await sendTelegramMessage(
            order.telegramUserId,
            text
        );

    } catch (error) {

        console.error(
            "Ошибка сообщения пассажиру:",
            error.message
        );
    }
}


async function notifyPassenger(
    order,
    text
) {

    if (!order.telegram_user_id &&
        !order.telegramUserId) {
        return;
    }


    const telegramId =
        order.telegram_user_id ||
        order.telegramUserId;


    try {

        await sendTelegramMessage(
            telegramId,
            text
        );

    } catch (error) {

        console.error(
            "Ошибка уведомления пассажира:",
            error.message
        );
    }
}


// ============================================================
// CREATE ORDER
// ============================================================

app.post(
    "/api/send-order",
    async (req, res) => {

        const client =
            pool
                ? await pool.connect()
                : null;


        try {

            if (!pool) {

                return res.status(500).json({
                    success: false,
                    error:
                        "База данных не подключена. Проверьте DATABASE_URL в Render."
                });
            }


            const body =
                req.body || {};


            const telegramUserId =
                normalizeTelegramId(
                    body.telegramUserId
                );


            if (!telegramUserId) {

                return res.status(400).json({
                    success: false,
                    error:
                        "Не найден Telegram ID пассажира."
                });
            }


            const addressA =
                String(
                    body.addressA || ""
                ).trim();


            const addressB =
                String(
                    body.addressB || ""
                ).trim();


            if (!addressA) {

                return res.status(400).json({
                    success: false,
                    error:
                        "Не указан адрес подачи."
                });
            }


            if (!addressB) {

                return res.status(400).json({
                    success: false,
                    error:
                        "Не указан адрес назначения."
                });
            }


            const passenger =
                await getPassenger(
                    telegramUserId
                );


            const scheduledAt =
                body.isImmediate
                    ? null
                    : parseScheduledAt(body);


            if (
                !body.isImmediate &&
                !scheduledAt
            ) {

                return res.status(400).json({
                    success: false,
                    error:
                        "Не удалось определить дату и время заказа."
                });
            }


            const orderId =
                makeId();


            await client.query(
                "BEGIN"
            );


            await client.query(
                `
                INSERT INTO passenger_orders
                (
                    id,
                    telegram_user_id,
                    address_a,
                    address_b,
                    tariff,
                    scheduled,
                    scheduled_at,
                    is_immediate,
                    is_weekend,
                    child_seat,
                    status
                )
                VALUES
                (
                    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'searching'
                )
                `,
                [
                    orderId,

                    telegramUserId,

                    addressA,

                    addressB,

                    body.tariff ||
                        "Эконом",

                    body.scheduled ||
                        "Ближайшее время",

                    scheduledAt,

                    body.isImmediate !== false,

                    Boolean(
                        body.isWeekend
                    ),

                    Boolean(
                        body.childSeat
                    )
                ]
            );


            await client.query(
                "COMMIT"
            );


            const orderResult =
                await pool.query(
                    `
                    SELECT
                        po.*,

                        p.name AS passenger_name,
                        p.phone AS passenger_phone

                    FROM passenger_orders po

                    LEFT JOIN passengers p
                    ON p.telegram_id =
                       po.telegram_user_id

                    WHERE po.id = $1
                    `,
                    [orderId]
                );


            const dbOrder =
                orderResult.rows[0];


            const order = {

                id:
                    dbOrder.id,

                telegramUserId:
                    dbOrder.telegram_user_id,

                addressA:
                    dbOrder.address_a,

                addressB:
                    dbOrder.address_b,

                tariff:
                    dbOrder.tariff,

                scheduled:
                    dbOrder.scheduled,

                scheduledAt:
                    dbOrder.scheduled_at,

                isImmediate:
                    dbOrder.is_immediate,

                isWeekend:
                    dbOrder.is_weekend,

                childSeat:
                    dbOrder.child_seat,

                passengerName:
                    dbOrder.passenger_name || "",

                passengerPhone:
                    dbOrder.passenger_phone || "",

                status:
                    dbOrder.status
            };


            console.log(
                "================================="
            );

            console.log(
                "НОВЫЙ ЗАКАЗ:",
                order
            );

            console.log(
                "================================="
            );


            await notifyDrivers(order);


            return res.json({
                success: true,

                orderId:

                    order.id,

                order
            });


        } catch (error) {

            if (client) {

                try {
                    await client.query(
                        "ROLLBACK"
                    );
                } catch (_) {}
            }


            console.error(
                "ОШИБКА СОЗДАНИЯ ЗАКАЗА:",
                error
            );


            return res.status(500).json({

                success: false,

                error:
                    error.message ||
                    "Ошибка создания заказа"
            });


        } finally {

            if (client) {
                client.release();
            }
        }
    }
);


// ============================================================
// GET ORDER
// ============================================================

app.get(
    "/api/get-order",
    async (req, res) => {

        try {

            if (!pool) {

                return res.status(500).json({
                    success: false,
                    error:
                        "DATABASE_URL не подключён"
                });
            }


            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM passenger_orders
                    WHERE status = 'searching'
                    ORDER BY created_at DESC
                    LIMIT 1
                    `
                );


            if (!result.rows.length) {

                return res.json({
                    status: "none"
                });
            }


            return res.json(
                formatDbOrder(
                    result.rows[0]
                )
            );


        } catch (error) {

            console.error(
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    error.message
            });
        }
    }
);


// ============================================================
// PASSENGER ORDER STATUS
// ============================================================

app.get(
    "/api/order-status",
    async (req, res) => {

        res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.set("Pragma", "no-cache");
        res.set("Expires", "0");

        try {

            if (!pool) {

                return res.status(500).json({
                    success: false,
                    error:
                        "DATABASE_URL не подключён"
                });
            }


            const id =
                req.query.id
                    ? String(req.query.id)
                    : "";


            const telegramUserId =
                req.query.telegramUserId
                    ? String(
                        req.query.telegramUserId
                    )
                    : "";


            let result;


            if (id) {

                result =
                    await pool.query(
                        `
                        SELECT *
                        FROM passenger_orders
                        WHERE id = $1
                        LIMIT 1
                        `,
                        [id]
                    );

            } else if (telegramUserId) {

                result =
                    await pool.query(
                        `
                        SELECT *
                        FROM passenger_orders
                        WHERE telegram_user_id = $1
                        ORDER BY created_at DESC
                        LIMIT 1
                        `,
                        [telegramUserId]
                    );

            } else {

                return res.status(400).json({
                    success: false,
                    error:
                        "Не указан id заказа."
                });
            }


            if (!result.rows.length) {

                return res.json({
                    status: "none"
                });
            }


            return res.json(
                formatDbOrder(
                    result.rows[0]
                )
            );


        } catch (error) {

            console.error(
                "order-status:",
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    error.message
            });
        }
    }
);


// ============================================================
// FORMAT DB ORDER
// ============================================================

function shortOrderNumber(id) {
    return String(id || "").replace(/-/g, "").slice(-6).toUpperCase();
}

function formatDbOrder(row) {

    return {

        id:
            row.id,

        orderNumber:
            shortOrderNumber(row.id),

        telegramUserId:
            row.telegram_user_id,

        addressA:
            row.address_a,

        addressB:
            row.address_b,

        tariff:
            row.tariff,

        scheduled:
            row.scheduled,

        scheduledAt:
            row.scheduled_at,

        isImmediate:
            row.is_immediate,

        isWeekend:
            row.is_weekend,

        childSeat:
            row.child_seat,

        status:
            row.status,

        driverTelegramId:
            row.driver_telegram_id,

        driverName:
            row.driver_name,

        driverCar:
            row.driver_car,

        driverNumber:
            row.driver_number,

        driverPhone:
            row.driver_phone,

        driverRating:
            row.driver_rating,

        driverPhotoFileId:
            row.driver_photo_file_id,

        createdAt:
            row.created_at,

        acceptedAt:
            row.accepted_at,

        arrivedAt:
            row.arrived_at,

        tripStartedAt:
            row.trip_started_at,

        completedAt:
            row.completed_at
    };
}


// ============================================================
// ACCEPT ORDER
// ============================================================

async function acceptOrder(
    orderId,
    driverTelegramId
) {

    if (!pool) {

        return {
            success: false,
            statusCode: 500,
            error:
                "DATABASE_URL не подключён"
        };
    }


    const driverId =
        normalizeTelegramId(
            driverTelegramId
        );


    if (!isDriverTelegramId(driverId)) {

        return {
            success: false,
            statusCode: 403,
            error:
                "Вы не зарегистрированы как водитель."
        };
    }


    const client =
        await pool.connect();


    try {

        await client.query(
            "BEGIN"
        );


        // ----------------------------------------------------
        // Блокируем конкретного водителя
        // ----------------------------------------------------

        await client.query(
            `
            SELECT pg_advisory_xact_lock(
                hashtext($1)
            )
            `,
            [driverId]
        );


        // ----------------------------------------------------
        // Блокируем заказ
        // ----------------------------------------------------

        const orderResult =
            await client.query(
                `
                SELECT *
                FROM passenger_orders
                WHERE id = $1
                FOR UPDATE
                `,
                [String(orderId)]
            );


        if (!orderResult.rows.length) {

            await client.query(
                "ROLLBACK"
            );

            return {
                success: false,
                statusCode: 404,
                error:
                    "Заказ не найден."
            };
        }


        const row =
            orderResult.rows[0];


        if (
            row.status !== "searching"
        ) {

            await client.query(
                "ROLLBACK"
            );

            return {
                success: false,
                statusCode: 409,
                error:
                    "Заказ уже принят другим водителем."
            };
        }


        const driver =
            await getDriver(
                driverId
            );


        if (!driver) {

            await client.query(
                "ROLLBACK"
            );

            return {
                success: false,
                statusCode: 403,
                error:
                    "Профиль водителя не заполнен."
            };
        }


        if (
            row.child_seat &&
            !driver.hasChildSeat
        ) {

            await client.query(
                "ROLLBACK"
            );

            return {
                success: false,
                statusCode: 403,
                error:
                    "Для этого заказа требуется детское кресло."
            };
        }


        const order =
            formatDbOrder(row);


        const availability =
            await checkDriverAvailability(
                driverId,
                order,
                client
            );


        if (!availability.allowed) {

            await client.query(
                "ROLLBACK"
            );

            return {
                success: false,
                statusCode: 409,
                error:
                    availability.reason
            };
        }


        await client.query(
            `
            UPDATE passenger_orders
            SET

                status = 'accepted',

                driver_telegram_id = $1,

                driver_name = $2,

                driver_car = $3,

                driver_number = $4,

                driver_phone = $5,

                driver_rating = $6,

                driver_photo_file_id = $7,

                accepted_at = NOW()

            WHERE id = $8
            `,
            [

                driverId,

                driver.name,

                driver.car,

                driver.plate,

                driver.phone,

                driver.rating,

                driver.photoFileId,

                String(orderId)
            ]
        );


        await client.query(
            "COMMIT"
        );


        const updatedResult =
            await pool.query(
                `
                SELECT *
                FROM passenger_orders
                WHERE id = $1
                `,
                [String(orderId)]
            );


        const updatedOrder =
            formatDbOrder(
                updatedResult.rows[0]
            );


        await notifyPassengerAccepted(
            updatedOrder
        );


        // Убираем кнопки у остальных водителей
        await removeOrderButtons(
            String(orderId)
        );


        return {
            success: true,
            order: updatedOrder
        };


    } catch (error) {

        try {
            await client.query(
                "ROLLBACK"
            );
        } catch (_) {}


        console.error(
            "acceptOrder:",
            error
        );


        return {
            success: false,
            statusCode: 500,
            error:
                error.message
        };


    } finally {

        client.release();
    }
}


// ============================================================
// REMOVE TELEGRAM BUTTONS
// ============================================================

async function removeOrderButtons(
    orderId
) {

    const messages =
        sentOrderMessages.get(
            orderId
        ) || [];


    for (const item of messages) {

        try {

            await telegram(
                "editMessageReplyMarkup",
                {
                    chat_id:
                        item.chatId,

                    message_id:
                        item.messageId,

                    reply_markup:
                        {
                            inline_keyboard: []
                        }
                }
            );

        } catch (_) {}
    }


    sentOrderMessages.delete(
        orderId
    );
}


// ============================================================
// ACCEPT API
// ============================================================

app.post(
    "/api/accept-order",
    async (req, res) => {

        try {

            const result =
                await acceptOrder(
                    req.body?.orderId,
                    req.body?.telegramId
                );


            if (!result.success) {

                return res.status(
                    result.statusCode || 400
                ).json(result);
            }


            return res.json(
                result
            );


        } catch (error) {

            console.error(
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    error.message
            });
        }
    }
);


// ============================================================
// DRIVER ORDERS
// ============================================================

app.get(
    "/api/driver-orders",
    async (req, res) => {

        try {

            if (!pool) {

                return res.status(500).json({
                    success: false,
                    error:
                        "DATABASE_URL не подключён"
                });
            }


            const telegramId =
                normalizeTelegramId(
                    req.query.telegramId
                );


            if (
                !isDriverTelegramId(
                    telegramId
                )
            ) {

                return res.status(403).json({
                    success: false,
                    error:
                        "Нет доступа водителя."
                });
            }


            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM passenger_orders
                    WHERE driver_telegram_id = $1
                      AND status = ANY($2::text[])
                    ORDER BY
                        scheduled_at NULLS FIRST,
                        created_at ASC
                    `,
                    [
                        telegramId,
                        ACTIVE_STATUSES
                    ]
                );


            return res.json(
                result.rows.map(
                    formatDbOrder
                )
            );


        } catch (error) {

            console.error(
                "driver-orders:",
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    error.message
            });
        }
    }
);


// ============================================================
// USER ROLE API
// ============================================================

app.get(
    "/api/user-role",
    async (req, res) => {
        try {
            const telegramId = normalizeTelegramId(req.query.telegramId);
            if (!telegramId) {
                return res.status(400).json({ success: false, error: "Не указан Telegram ID." });
            }

            // Сначала проверяем PostgreSQL. Это надёжнее, чем
            // полагаться только на DRIVER_CHAT_IDS в Render.
            const driver = await getDriver(telegramId);

            if (driver || isDriverTelegramId(telegramId)) {
                return res.json({
                    success: true,
                    role: "driver",
                    driver: driver || null
                });
            }

            return res.json({
                success: true,
                role: "passenger"
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
);


// ============================================================
// DRIVER PROFILE API
// ============================================================

app.get(
    "/api/driver-profile",
    async (req, res) => {

        try {

            const telegramId =
                normalizeTelegramId(
                    req.query.telegramId
                );


            if (
                !isDriverTelegramId(
                    telegramId
                )
            ) {

                return res.status(403).json({
                    success: false,
                    error:
                        "Нет доступа."
                });
            }


            const driver =
                await getDriver(
                    telegramId
                );


            if (!driver) {

                return res.json({
                    exists: false
                });
            }


            return res.json({
                exists: true,
                driver
            });


        } catch (error) {

            return res.status(500).json({
                success: false,
                error:
                    error.message
            });
        }
    }
);


// ============================================================
// DRIVER ARRIVED
// ============================================================

app.post(
    "/api/driver-arrived",
    async (req, res) => {

        try {

            const telegramId =
                normalizeTelegramId(
                    req.body?.telegramId
                );

            const orderId =
                String(
                    req.body?.orderId || ""
                );


            if (
                !isDriverTelegramId(
                    telegramId
                )
            ) {

                return res.status(403).json({
                    success: false,
                    error:
                        "Нет доступа."
                });
            }


            const result =
                await pool.query(
                    `
                    UPDATE passenger_orders
                    SET
                        status = 'arrived',
                        arrived_at = NOW()
                    WHERE id = $1
                      AND driver_telegram_id = $2
                      AND status = 'accepted'
                    RETURNING *
                    `,
                    [
                        orderId,
                        telegramId
                    ]
                );


            if (!result.rows.length) {

                return res.status(404).json({
                    success: false,
                    error:
                        "Заказ не найден или статус уже изменён."
                });
            }


            const order =
                formatDbOrder(
                    result.rows[0]
                );


            await notifyPassenger(
                order,
                "🚕 ВОДИТЕЛЬ ПРИБЫЛ\n\nВаш водитель уже на месте."
            );


            return res.json({
                success: true,
                order
            });


        } catch (error) {

            console.error(
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    error.message
            });
        }
    }
);


// ============================================================
// START TRIP
// ============================================================

app.post(
    "/api/start-trip",
    async (req, res) => {

        try {

            const telegramId =
                normalizeTelegramId(
                    req.body?.telegramId
                );

            const orderId =
                String(
                    req.body?.orderId || ""
                );


            if (
                !isDriverTelegramId(
                    telegramId
                )
            ) {

                return res.status(403).json({
                    success: false,
                    error:
                        "Нет доступа."
                });
            }


            const result =
                await pool.query(
                    `
                    UPDATE passenger_orders
                    SET
                        status = 'trip',
                        trip_started_at = NOW()
                    WHERE id = $1
                      AND driver_telegram_id = $2
                      AND status = 'arrived'
                    RETURNING *
                    `,
                    [
                        orderId,
                        telegramId
                    ]
                );


            if (!result.rows.length) {

                return res.status(404).json({
                    success: false,
                    error:
                        "Заказ не найден."
                });
            }


            const order =
                formatDbOrder(
                    result.rows[0]
                );


            await notifyPassenger(
                order,
                "🛣️ ПОЕЗДКА НАЧАЛАСЬ\n\nЖелаем приятной поездки!"
            );


            return res.json({
                success: true,
                order
            });


        } catch (error) {

            return res.status(500).json({
                success: false,
                error:
                    error.message
            });
        }
    }
);


// ============================================================
// COMPLETE ORDER
// ============================================================

app.post(
    "/api/complete-order",
    async (req, res) => {

        try {

            const telegramId =
                normalizeTelegramId(
                    req.body?.telegramId
                );

            const orderId =
                String(
                    req.body?.orderId || ""
                );


            if (
                !isDriverTelegramId(
                    telegramId
                )
            ) {

                return res.status(403).json({
                    success: false,
                    error:
                        "Нет доступа."
                });
            }


            const result =
                await pool.query(
                    `
                    UPDATE passenger_orders
                    SET
                        status = 'completed',
                        completed_at = NOW()
                    WHERE id = $1
                      AND driver_telegram_id = $2
                      AND status IN ('accepted','arrived','trip')
                    RETURNING *
                    `,
                    [
                        orderId,
                        telegramId
                    ]
                );


            if (!result.rows.length) {

                return res.status(404).json({
                    success: false,
                    error:
                        "Заказ не найден."
                });
            }


            const order =
                formatDbOrder(
                    result.rows[0]
                );


            await notifyPassenger(
                order,
                "✅ ПОЕЗДКА ЗАВЕРШЕНА\n\nСпасибо, что воспользовались Такси Речица!"
            );


            return res.json({
                success: true,
                order
            });


        } catch (error) {

            console.error(
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    error.message
            });
        }
    }
);


// ============================================================
// PASSENGER PROFILE API
// ============================================================

app.get(
    "/api/passenger-profile",
    async (req, res) => {

        try {

            const telegramId =
                normalizeTelegramId(
                    req.query.telegramId
                );


            if (!telegramId) {

                return res.status(400).json({
                    success: false,
                    error:
                        "Не указан Telegram ID."
                });
            }


            const passenger =
                await getPassenger(
                    telegramId
                );


            if (!passenger) {

                return res.json({
                    exists: false,

                    profile: {
                        telegramId,
                        name: "",
                        phone: ""
                    }
                });
            }


            return res.json({
                exists: true,
                profile: passenger
            });


        } catch (error) {

            console.error(
                "passenger-profile:",
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    error.message
            });
        }
    }
);


app.post(
    "/api/passenger-profile",
    async (req, res) => {

        try {

            const telegramId =
                normalizeTelegramId(
                    req.body?.telegramId
                );


            const name =
                String(
                    req.body?.name || ""
                ).trim();


            const phone =
                String(
                    req.body?.phone || ""
                ).trim();


            if (!telegramId) {

                return res.status(400).json({
                    success: false,
                    error:
                        "Не найден Telegram ID."
                });
            }


            if (!name) {

                return res.status(400).json({
                    success: false,
                    error:
                        "Введите имя."
                });
            }


            if (!phone) {

                return res.status(400).json({
                    success: false,
                    error:
                        "Введите номер телефона."
                });
            }


            const profile =
                await savePassenger(
                    telegramId,
                    name,
                    phone
                );


            return res.json({
                success: true,
                profile
            });


        } catch (error) {

            console.error(
                "save passenger profile:",
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    error.message
            });
        }
    }
);


// ============================================================
// TELEGRAM DRIVER REGISTRATION
// ============================================================

const driverStates = new Map();


function getDriverState(id) {

    const key =
        normalizeTelegramId(id);

    return (
        driverStates.get(key) || {
            step: null
        }
    );
}


function setDriverState(
    id,
    state
) {

    driverStates.set(
        normalizeTelegramId(id),
        state
    );
}


function clearDriverState(id) {

    driverStates.delete(
        normalizeTelegramId(id)
    );
}


function childSeatKeyboard(
    edit = false
) {

    return {

        inline_keyboard: [

            [

                {
                    text:
                        "✅ Есть",

                    callback_data:
                        edit
                            ? "driver_seat_edit:yes"
                            : "driver_seat:yes"
                },

                {
                    text:
                        "❌ Нет",

                    callback_data:
                        edit
                            ? "driver_seat_edit:no"
                            : "driver_seat:no"
                }

            ]

        ]
    };
}


// ============================================================
// DRIVER BOT PROFILE
// ============================================================

async function startDriverProfile(
    chatId,
    edit = false
) {

    const driver =
        await getDriver(
            chatId
        );


    if (
        edit &&
        driver
    ) {

        setDriverState(
            chatId,
            {
                step:
                    "name",

                data: {
                    name:
                        driver.name || "",

                    car:
                        driver.car || "",

                    plate:
                        driver.plate || "",

                    phone:
                        driver.phone || "",

                    photoFileId:
                        driver.photoFileId || "",

                    hasChildSeat:
                        Boolean(
                            driver.hasChildSeat
                        )
                }
            }
        );


        await sendTelegramMessage(
            chatId,
            "✏️ Изменение профиля водителя.\n\nВведите ваше имя:"
        );

        return;
    }


    setDriverState(
        chatId,
        {
            step:
                "name",

            data: {}
        }
    );


    await sendTelegramMessage(
        chatId,
        "🚕 Заполнение профиля водителя\n\nВведите ваше имя:"
    );
}


// ============================================================
// DRIVER PROFILE DISPLAY
// ============================================================

async function sendDriverProfile(
    chatId
) {

    const driver =
        await getDriver(
            chatId
        );


    if (!driver) {

        await sendTelegramMessage(
            chatId,
            "👤 Профиль водителя ещё не заполнен.\n\nНажмите /editprofile для заполнения."
        );

        return;
    }


    const child =
        driver.hasChildSeat
            ? "✅ Есть"
            : "❌ Нет";


    const text =

        "👤 ПРОФИЛЬ ВОДИТЕЛЯ\n\n" +

        `Имя: ${driver.name || "-"}\n` +

        `🚕 Автомобиль: ${driver.car || "-"}\n` +

        `🔢 Номер: ${driver.plate || "-"}\n` +

        `📞 Телефон: ${driver.phone || "-"}\n` +

        `👶 Детское кресло: ${child}\n` +

        `⭐ Рейтинг: ${driver.rating || "5.00"}`;


    await sendTelegramMessage(
        chatId,
        text
    );
}


// ============================================================
// TELEGRAM UPDATE
// ============================================================

async function processTelegramUpdate(
    update
) {

    // --------------------------------------------------------
    // MESSAGE
    // --------------------------------------------------------

    if (update.message) {

        const message =
            update.message;

        const chatId =
            message.chat.id;

        const user =
            message.from || {};

        const text =
            message.text || "";


        // --------------------------------------------
        // /start
        // --------------------------------------------

        if (
            text.startsWith(
                "/start"
            )
        ) {

            const allowed =
                DRIVER_CHAT_IDS.length === 0 ||
                DRIVER_CHAT_IDS.includes(
                    String(user.id)
                );


            if (!allowed) {

                await sendTelegramMessage(
                    chatId,

                    "🚕 Такси Речица\n\n" +
                    "Вы можете пользоваться Mini App как пассажир.\n\n" +
                    "Откройте приложение через кнопку меню Telegram."
                );

                return;
            }


            driverChats.set(
                chatId,
                {
                    chatId,
                    telegramId:
                        user.id,
                    firstName:
                        user.first_name ||
                        "Водитель",
                    username:
                        user.username ||
                        ""
                }
            );


            const driver =
                await getDriver(
                    user.id
                );


            if (!driver) {

                await sendTelegramMessage(
                    chatId,

                    "🚕 Такси Речица\n\n" +
                    "Вы зарегистрированы как водитель.\n\n" +
                    "Профиль ещё не заполнен.\n" +
                    "Нажмите /profile"
                );

            } else {

                await sendTelegramMessage(
                    chatId,

                    "🚕 Такси Речица\n\n" +
                    `Здравствуйте, ${driver.name || user.first_name || "водитель"}!\n\n` +
                    "Вы готовы получать заказы.\n\n" +
                    "/profile — мой профиль\n" +
                    "/editprofile — изменить профиль\n" +
                    "/orders — активные заказы"
                );
            }


            return;
        }


        // --------------------------------------------
        // /profile
        // --------------------------------------------

        if (
            text === "/profile"
        ) {

            const allowed =
                DRIVER_CHAT_IDS.length === 0 ||
                DRIVER_CHAT_IDS.includes(
                    String(user.id)
                );


            if (!allowed) {

                await sendTelegramMessage(
                    chatId,

                    "👤 Это профиль пассажира.\n\n" +
                    "Для заполнения анкеты откройте Mini App и нажмите «Профиль»."
                );

                return;
            }


            await sendDriverProfile(
                chatId
            );

            return;
        }


        // --------------------------------------------
        // /editprofile
        // --------------------------------------------

        if (
            text === "/editprofile"
        ) {

            const allowed =
                DRIVER_CHAT_IDS.length === 0 ||
                DRIVER_CHAT_IDS.includes(
                    String(user.id)
                );


            if (!allowed) {

                await sendTelegramMessage(
                    chatId,
                    "Команда доступна только водителям."
                );

                return;
            }


            await startDriverProfile(
                chatId,
                true
            );

            return;
        }


        // --------------------------------------------
        // /orders
        // --------------------------------------------

        if (
            text === "/orders"
        ) {

            if (
                !isDriverTelegramId(
                    user.id
                )
            ) {

                await sendTelegramMessage(
                    chatId,
                    "Нет доступа водителя."
                );

                return;
            }


            if (!pool) {
                return;
            }


            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM passenger_orders
                    WHERE driver_telegram_id = $1
                      AND status = ANY($2::text[])
                    ORDER BY created_at ASC
                    `,
                    [
                        String(user.id),
                        ACTIVE_STATUSES
                    ]
                );


            if (!result.rows.length) {

                await sendTelegramMessage(
                    chatId,
                    "📋 Активных заказов нет."
                );

                return;
            }


            for (
                const row
                of result.rows
            ) {

                const order =
                    formatDbOrder(
                        row
                    );


                await sendTelegramMessage(
                    chatId,

                    "🚕 АКТИВНЫЙ ЗАКАЗ\n\n" +

                    `#${order.id}\n` +

                    `📍 ${order.addressA}\n` +

                    `🏁 ${order.addressB}\n` +

                    `🕐 ${order.scheduled}\n` +

                    `Статус: ${order.status}`
                );
            }


            return;
        }


        // --------------------------------------------
        // /skip
        // --------------------------------------------

        if (
            text === "/skip"
        ) {

            const state =
                getDriverState(
                    user.id
                );


            if (
                state.step ===
                "photo"
            ) {

                state.data.photoFileId =
                    "";


                state.step =
                    "childSeat";


                setDriverState(
                    user.id,
                    state
                );


                await sendTelegramMessage(
                    chatId,
                    "👶 Есть ли в автомобиле детское кресло?",
                    {
                        reply_markup:
                            childSeatKeyboard()
                    }
                );

            } else {

                await sendTelegramMessage(
                    chatId,
                    "Пропустить сейчас нельзя."
                );
            }


            return;
        }


        // --------------------------------------------
        // PHOTO
        // --------------------------------------------

        if (
            message.photo &&
            isDriverTelegramId(
                user.id
            )
        ) {

            const state =
                getDriverState(
                    user.id
                );


            if (
                state.step ===
                "photo"
            ) {

                const photos =
                    message.photo;

                const largest =
                    photos[
                        photos.length - 1
                    ];


                state.data.photoFileId =
                    largest.file_id;


                state.step =
                    "childSeat";


                setDriverState(
                    user.id,
                    state
                );


                await sendTelegramMessage(
                    chatId,
                    "👶 Есть ли в автомобиле детское кресло?",
                    {
                        reply_markup:
                            childSeatKeyboard()
                    }
                );
            }


            return;
        }


        // --------------------------------------------
        // PROFILE TEXT STEPS
        // --------------------------------------------

        if (
            isDriverTelegramId(
                user.id
            )
        ) {

            const state =
                getDriverState(
                    user.id
                );


            if (!state.step) {
                return;
            }


            if (
                state.step ===
                "name"
            ) {

                state.data.name =
                    text.trim();

                state.step =
                    "car";


                setDriverState(
                    user.id,
                    state
                );


                await sendTelegramMessage(
                    chatId,
                    "🚕 Введите марку и модель автомобиля:"
                );

                return;
            }


            if (
                state.step ===
                "car"
            ) {

                state.data.car =
                    text.trim();

                state.step =
                    "plate";


                setDriverState(
                    user.id,
                    state
                );


                await sendTelegramMessage(
                    chatId,
                    "🔢 Введите госномер автомобиля:"
                );

                return;
            }


            if (
                state.step ===
                "plate"
            ) {

                state.data.plate =
                    text.trim();

                state.step =
                    "phone";


                setDriverState(
                    user.id,
                    state
                );


                await sendTelegramMessage(
                    chatId,
                    "📞 Введите номер телефона:"
                );

                return;
            }


            if (
                state.step ===
                "phone"
            ) {

                state.data.phone =
                    text.trim();

                state.step =
                    "photo";


                setDriverState(
                    user.id,
                    state
                );


                await sendTelegramMessage(
                    chatId,

                    "📸 Отправьте фотографию автомобиля.\n\n" +
                    "Можно нажать /skip, если фотографию добавлять не хотите."
                );

                return;
            }
        }


        return;
    }


    // --------------------------------------------------------
    // CALLBACK
    // --------------------------------------------------------

    if (
        update.callback_query
    ) {

        const callback =
            update.callback_query;

        const chatId =
            callback.message?.chat?.id;

        const fromId =
            callback.from?.id;

        const data =
            callback.data || "";


        await telegram(
            "answerCallbackQuery",
            {
                callback_query_id:
                    callback.id
            }
        );


        // --------------------------------------------
        // DRIVER CHILD SEAT
        // --------------------------------------------

        if (
            data.startsWith(
                "driver_seat:"
            )
        ) {

            const value =
                data.split(":")[1] ===
                "yes";


            const state =
                getDriverState(
                    fromId
                );


            state.data.hasChildSeat =
                value;


            try {

                await saveDriver(
                    fromId,

                    state.data.name,

                    state.data.car,

                    state.data.plate,

                    state.data.phone,

                    state.data.photoFileId,

                    state.data.hasChildSeat
                );


                clearDriverState(
                    fromId
                );


                await sendTelegramMessage(
                    chatId,

                    "✅ Профиль водителя сохранён!\n\n" +

                    `👤 ${state.data.name}\n` +

                    `🚕 ${state.data.car}\n` +

                    `🔢 ${state.data.plate}\n` +

                    `📞 ${state.data.phone}\n` +

                    `👶 Детское кресло: ${
                        value
                            ? "есть"
                            : "нет"
                    }\n\n` +

                    "Теперь вы можете получать заказы."
                );


            } catch (error) {

                console.error(
                    error
                );

                await sendTelegramMessage(
                    chatId,

                    "❌ Не удалось сохранить профиль:\n" +
                    error.message
                );
            }


            return;
        }


        // --------------------------------------------
        // EDIT DRIVER CHILD SEAT
        // --------------------------------------------

        if (
            data.startsWith(
                "driver_seat_edit:"
            )
        ) {

            const value =
                data.split(":")[1] ===
                "yes";


            const driver =
                await getDriver(
                    fromId
                );


            if (!driver) {
                return;
            }


            await saveDriver(
                fromId,

                driver.name,

                driver.car,

                driver.plate,

                driver.phone,

                driver.photoFileId,

                value
            );


            await sendTelegramMessage(
                chatId,

                "✅ Детское кресло обновлено:\n\n" +
                (
                    value
                        ? "Есть"
                        : "Нет"
                )
            );


            return;
        }


        // --------------------------------------------
        // ACCEPT
        // --------------------------------------------

        if (
            data.startsWith(
                "accept:"
            )
        ) {

            const orderId =
                data.substring(
                    "accept:".length
                );


            const result =
                await acceptOrder(
                    orderId,
                    fromId
                );


            if (
                result.success
            ) {

                await sendTelegramMessage(
                    chatId,

                    "✅ ЗАКАЗ ПРИНЯТ!\n\n" +

                    `Заказ #${shortOrderNumber(result.order.id)}\n\n` +

                    "Откройте Mini App для управления поездкой."
                );

            } else {

                await sendTelegramMessage(
                    chatId,

                    `⚠️ ${result.error}`
                );
            }


            return;
        }


        // --------------------------------------------
        // REJECT
        // --------------------------------------------

        if (
            data.startsWith(
                "reject:"
            )
        ) {

            const orderId =
                data.substring(
                    "reject:".length
                );


            await sendTelegramMessage(
                chatId,

                `❌ Заказ #${shortOrderNumber(orderId)} отклонён.`
            );


            return;
        }
    }
}


// ============================================================
// TELEGRAM POLLING
// ============================================================

async function telegramPollingLoop() {

    if (telegramPolling) {
        return;
    }


    telegramPolling = true;


    if (!BOT_TOKEN) {

        console.error(
            "TELEGRAM_BOT_TOKEN не задан."
        );

        return;
    }


    try {

        await telegram(
            "deleteWebhook",
            {
                drop_pending_updates:
                    false
            }
        );


        const me =
            await telegram(
                "getMe"
            );


        console.log(
            `Telegram бот подключён: @${me.username}`
        );


    } catch (error) {

        console.error(
            "Telegram startup:",
            error.message
        );

        telegramPolling = false;

        return;
    }


    while (true) {

        try {

            const updates =
                await telegram(
                    "getUpdates",
                    {
                        offset:
                            telegramOffset,

                        timeout:
                            25,

                        allowed_updates:
                            [
                                "message",
                                "callback_query"
                            ]
                    }
                );


            for (
                const update
                of updates
            ) {

                telegramOffset =
                    update.update_id + 1;


                try {

                    await processTelegramUpdate(
                        update
                    );

                } catch (error) {

                    console.error(
                        "Telegram update:",
                        error
                    );
                }
            }


        } catch (error) {

            console.error(
                "Telegram polling:",
                error.message
            );


            await sleep(
                3000
            );
        }
    }
}


// ============================================================
// HEALTH
// ============================================================

app.get(
    "/health",
    async (req, res) => {

        let database =
            false;


        if (pool) {

            try {

                await pool.query(
                    "SELECT 1"
                );

                database = true;

            } catch (_) {}
        }


        res.json({

            ok: true,

            database,

            telegram:
                Boolean(
                    BOT_TOKEN
                ),

            time:
                new Date().toISOString()
        });
    }
);


// ============================================================
// MAIN PAGE
// ============================================================

app.get(
    "/",
    (req, res) => {

        const publicIndex =
            path.join(
                __dirname,
                "public",
                "index.html"
            );


        const rootIndex =
            path.join(
                __dirname,
                "index.html"
            );


        if (
            fs.existsSync(
                publicIndex
            )
        ) {

            return res.sendFile(
                publicIndex
            );
        }


        if (
            fs.existsSync(
                rootIndex
            )
        ) {

            return res.sendFile(
                rootIndex
            );
        }


        return res.status(404).send(
            "index.html не найден"
        );
    }
);


// ============================================================
// START
// ============================================================

async function start() {

    try {

        await initDatabase();

    } catch (error) {

        console.error(
            "Ошибка запуска PostgreSQL:",
            error
        );
    }


    app.listen(
        PORT,
        () => {

            console.log(
                "================================="
            );

            console.log(
                `Такси Речица запущено на порту ${PORT}`
            );

            console.log(
                `PostgreSQL: ${
                    pool
                        ? "подключён"
                        : "НЕ ПОДКЛЮЧЁН"
                }`
            );

            console.log(
                `Telegram: ${
                    BOT_TOKEN
                        ? "подключён"
                        : "НЕ ПОДКЛЮЧЁН"
                }`
            );

            console.log(
                "================================="
            );


            telegramPollingLoop();
        }
    );
}


start();
