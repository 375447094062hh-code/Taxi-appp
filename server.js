const express = require('express');
const { Pool } = require('pg');

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

const pool = DATABASE_URL
    ? new Pool({
        connectionString: DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    })
    : null;

/*
==================================================
НАСТРОЙКИ
==================================================
*/

const MAX_NORMAL_ACTIVE_ORDERS = 2;
const FUTURE_ORDER_BLOCK_MINUTES = 15;
const FUTURE_ORDER_BLOCK_MS =
    FUTURE_ORDER_BLOCK_MINUTES * 60 * 1000;

const ACTIVE_STATUSES = [
    'accepted',
    'arrived',
    'trip'
];

/*
==================================================
 TELEGRAM
==================================================
*/

async function telegram(method, body = {}) {
    if (!BOT_TOKEN) {
        throw new Error(
            'TELEGRAM_BOT_TOKEN не задан в Render'
        );
    }

    const response = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
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
    return telegram('sendMessage', {
        chat_id: chatId,
        text,
        ...extra
    });
}

/*
==================================================
 ВОДИТЕЛИ, КОТОРЫЕ НАЖАЛИ /start
==================================================
*/

const driverChats = new Map();

/*
==================================================
 СООБЩЕНИЯ ЗАКАЗОВ
==================================================

Нужно, чтобы после принятия заказа
мы могли убрать кнопки у остальных водителей.
*/

const orderDriverMessages = new Map();

/*
==================================================
 DATABASE
==================================================
*/

async function initDatabase() {
    if (!pool) {
        console.error(
            'DATABASE_URL не задан. PostgreSQL отключён.'
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
            rating NUMERIC(3,2) DEFAULT 5.00,
            has_child_seat BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    await pool.query(`
        ALTER TABLE drivers
        ADD COLUMN IF NOT EXISTS has_child_seat
        BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS passenger_orders (
            id TEXT PRIMARY KEY,

            telegram_user_id TEXT,

            address_a TEXT,
            address_b TEXT,

            tariff TEXT,
            scheduled TEXT,

            scheduled_at TIMESTAMPTZ,

            is_immediate BOOLEAN DEFAULT TRUE,
            is_weekend BOOLEAN DEFAULT FALSE,
            child_seat BOOLEAN DEFAULT FALSE,

            status TEXT DEFAULT 'searching',

            driver_telegram_id TEXT,
            driver_name TEXT,
            driver_car TEXT,
            driver_number TEXT,
            driver_phone TEXT,
            driver_rating NUMERIC(3,2),
            driver_photo_file_id TEXT,

            created_at TIMESTAMPTZ DEFAULT NOW(),
            accepted_at TIMESTAMPTZ,
            arrived_at TIMESTAMPTZ,
            trip_started_at TIMESTAMPTZ,
            completed_at TIMESTAMPTZ
        )
    `);

    /*
    Если таблица была создана старой версией,
    добавляем недостающие поля.
    */

    const columns = [
        ['telegram_user_id', 'TEXT'],
        ['address_a', 'TEXT'],
        ['address_b', 'TEXT'],
        ['tariff', 'TEXT'],
        ['scheduled', 'TEXT'],
        ['scheduled_at', 'TIMESTAMPTZ'],
        ['is_immediate', 'BOOLEAN DEFAULT TRUE'],
        ['is_weekend', 'BOOLEAN DEFAULT FALSE'],
        ['child_seat', 'BOOLEAN DEFAULT FALSE'],
        ['status', "TEXT DEFAULT 'searching'"],
        ['driver_telegram_id', 'TEXT'],
        ['driver_name', 'TEXT'],
        ['driver_car', 'TEXT'],
        ['driver_number', 'TEXT'],
        ['driver_phone', 'TEXT'],
        ['driver_rating', 'NUMERIC(3,2)'],
        ['driver_photo_file_id', 'TEXT'],
        ['created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
        ['accepted_at', 'TIMESTAMPTZ'],
        ['arrived_at', 'TIMESTAMPTZ'],
        ['trip_started_at', 'TIMESTAMPTZ'],
        ['completed_at', 'TIMESTAMPTZ']
    ];

    for (const [name, type] of columns) {
        await pool.query(`
            ALTER TABLE passenger_orders
            ADD COLUMN IF NOT EXISTS ${name} ${type}
        `);
    }

    console.log('PostgreSQL: база готова');
}

/*
==================================================
 ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
==================================================
*/

function normalizeBoolean(value) {
    return (
        value === true ||
        value === 'true' ||
        value === 1 ||
        value === '1'
    );
}

function isNowOrder(order) {
    if (order.isImmediate === true) {
        return true;
    }

    if (order.is_immediate === true) {
        return true;
    }

    const scheduled = String(
        order.scheduled || ''
    ).trim().toLowerCase();

    if (!scheduled) {
        return true;
    }

    return (
        scheduled.includes('сейчас') ||
        scheduled.includes('ближайшее') ||
        scheduled.includes('now')
    );
}

/*
==================================================
 ПАРСИНГ ДАТЫ

Беларусь / Речица = UTC+3.
Если Mini App присылает:
17.09.2026 в 22:30
мы считаем это временем Речицы.
==================================================
*/

function parseMinskDate(
    year,
    month,
    day,
    hour,
    minute
) {
    const utc = Date.UTC(
        year,
        month - 1,
        day,
        hour,
        minute
    );

    /*
    Беларусь UTC+3
    */

    return new Date(
        utc - 3 * 60 * 60 * 1000
    );
}

function parseScheduledAt(order) {
    /*
    1. Если Mini App уже прислал scheduledAt
    */

    if (order.scheduledAt) {
        const value = order.scheduledAt;

        if (
            typeof value === 'number' ||
            /^\d+$/.test(String(value))
        ) {
            const numberValue =
                Number(value);

            const ms =
                numberValue < 100000000000
                    ? numberValue * 1000
                    : numberValue;

            const date = new Date(ms);

            if (!isNaN(date.getTime())) {
                return date;
            }
        }

        const stringValue =
            String(value).trim();

        /*
        ISO с timezone:
        2026-09-17T19:00:00.000Z
        */

        if (
            stringValue.endsWith('Z') ||
            /[+-]\d{2}:\d{2}$/.test(stringValue)
        ) {
            const date =
                new Date(stringValue);

            if (!isNaN(date.getTime())) {
                return date;
            }
        }

        /*
        ISO без timezone.
        Считаем его временем Речицы.
        */

        let match =
            stringValue.match(
                /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/
            );

        if (match) {
            return parseMinskDate(
                Number(match[1]),
                Number(match[2]),
                Number(match[3]),
                Number(match[4]),
                Number(match[5])
            );
        }
    }

    /*
    2. Если это заказ "Сейчас"
    */

    if (isNowOrder(order)) {
        return null;
    }

    const scheduled =
        String(
            order.scheduled || ''
        ).trim();

    if (!scheduled) {
        return null;
    }

    /*
    Формат:
    17.09.2026 в 22:30
    17.09.2026, 22:30
    17.09.2026 22:30
    */

    let match =
        scheduled.match(
            /(\d{1,2})\.(\d{1,2})\.(\d{4}).*?(\d{1,2}):(\d{2})/
        );

    if (match) {
        return parseMinskDate(
            Number(match[3]),
            Number(match[2]),
            Number(match[1]),
            Number(match[4]),
            Number(match[5])
        );
    }

    /*
    Формат:
    2026-09-17 22:30
    */

    match =
        scheduled.match(
            /(\d{4})-(\d{2})-(\d{2}).*?(\d{1,2}):(\d{2})/
        );

    if (match) {
        return parseMinskDate(
            Number(match[1]),
            Number(match[2]),
            Number(match[3]),
            Number(match[4]),
            Number(match[5])
        );
    }

    /*
    Сегодня 22:30
    Завтра 22:30
    */

    match =
        scheduled.match(
            /(сегодня|завтра).*?(\d{1,2}):(\d{2})/i
        );

    if (match) {
        const now =
            new Date();

        const minskNow =
            new Date(
                now.getTime() +
                3 * 60 * 60 * 1000
            );

        let year =
            minskNow.getUTCFullYear();

        let month =
            minskNow.getUTCMonth() + 1;

        let day =
            minskNow.getUTCDate();

        if (
            match[1].toLowerCase() ===
            'завтра'
        ) {
            const tomorrow =
                new Date(
                    Date.UTC(
                        year,
                        month - 1,
                        day + 1
                    )
                );

            year =
                tomorrow.getUTCFullYear();

            month =
                tomorrow.getUTCMonth() + 1;

            day =
                tomorrow.getUTCDate();
        }

        return parseMinskDate(
            year,
            month,
            day,
            Number(match[2]),
            Number(match[3])
        );
    }

    return null;
}

/*
==================================================
 ФОРМАТИРОВАНИЕ ДАТЫ
==================================================
*/

function formatMinskDate(date) {
    if (!date) {
        return 'Ближайшее время';
    }

    return new Intl.DateTimeFormat(
        'ru-RU',
        {
            timeZone: 'Europe/Minsk',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        }
    ).format(date);
}

/*
==================================================
 ЗАКАЗ → ОБЪЕКТ ДЛЯ MINI APP
==================================================
*/

function dbOrderToObject(row) {
    if (!row) {
        return null;
    }

    return {
        id: row.id,

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
            row.scheduled_at
                ? new Date(row.scheduled_at).toISOString()
                : null,

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
            row.created_at
                ? new Date(row.created_at).getTime()
                : null,

        acceptedAt:
            row.accepted_at
                ? new Date(row.accepted_at).getTime()
                : null,

        arrivedAt:
            row.arrived_at
                ? new Date(row.arrived_at).getTime()
                : null,

        tripStartedAt:
            row.trip_started_at
                ? new Date(row.trip_started_at).getTime()
                : null,

        completedAt:
            row.completed_at
                ? new Date(row.completed_at).getTime()
                : null
    };
}

/*
==================================================
 ПОЛУЧИТЬ ЗАКАЗ
==================================================
*/

async function getOrder(orderId) {
    const result =
        await pool.query(
            `
            SELECT *
            FROM passenger_orders
            WHERE id = $1
            LIMIT 1
            `,
            [String(orderId)]
        );

    return result.rows[0] || null;
}

/*
==================================================
 ПОСЛЕДНИЙ ЗАКАЗ ПАССАЖИРА
==================================================
*/

async function getLatestPassengerOrder(
    telegramUserId
) {
    const result =
        await pool.query(
            `
            SELECT *
            FROM passenger_orders
            WHERE telegram_user_id = $1
            ORDER BY created_at DESC
            LIMIT 1
            `,
            [String(telegramUserId)]
        );

    return result.rows[0] || null;
}

/*
==================================================
 ПРОФИЛЬ ВОДИТЕЛЯ
==================================================
*/

async function getDriverProfile(
    telegramId
) {
    if (!pool) {
        return null;
    }

    const result =
        await pool.query(
            `
            SELECT *
            FROM drivers
            WHERE telegram_id = $1
            LIMIT 1
            `,
            [String(telegramId)]
        );

    return result.rows[0] || null;
}

/*
==================================================
 ПРОВЕРКА ВОДИТЕЛЯ

Если DRIVER_CHAT_IDS задан —
используем его как список разрешённых водителей.

Если не задан —
разрешаем зарегистрированных в БД.
==================================================
*/

function isDriverTelegramId(
    telegramId
) {
    const configured =
        String(
            process.env.DRIVER_CHAT_IDS || ''
        )
            .split(',')
            .map(x => x.trim())
            .filter(Boolean);

    if (configured.length > 0) {
        return configured.includes(
            String(telegramId)
        );
    }

    return driverChats.has(
        Number(telegramId)
    );
}

/*
==================================================
 ТЕКУЩИЕ АКТИВНЫЕ ЗАКАЗЫ ВОДИТЕЛЯ
==================================================
*/

async function getActiveDriverOrders(
    driverTelegramId,
    client = pool
) {
    const result =
        await client.query(
            `
            SELECT *
            FROM passenger_orders
            WHERE driver_telegram_id = $1
              AND status = ANY($2::text[])
            ORDER BY
                CASE
                    WHEN is_immediate = TRUE THEN 0
                    ELSE 1
                END,
                scheduled_at ASC NULLS LAST,
                created_at ASC
            `,
            [
                String(driverTelegramId),
                ACTIVE_STATUSES
            ]
        );

    return result.rows;
}

/*
==================================================
 ГЛАВНАЯ ЛОГИКА ЗАНЯТОСТИ ВОДИТЕЛЯ
==================================================

ВОЗВРАЩАЕТ:

{
    blocked: true/false,
    reason: ...
}

Правила:

1. Если есть обычный активный заказ:
   максимум 2.

2. Если есть будущий заказ и до него
   осталось <= 15 минут:
   полный запрет новых заказов.

3. Если будущий заказ уже наступил,
   водитель также заблокирован,
   пока заказ не выполнен.

==================================================
*/

async function checkDriverAvailability(
    driverTelegramId,
    newOrder,
    client = pool
) {
    const activeOrders =
        await getActiveDriverOrders(
            driverTelegramId,
            client
        );

    const now =
        Date.now();

    const newOrderIsImmediate =
        newOrder.isImmediate;

    /*
    ==========================================
    1. Ищем будущий заказ, который уже
       вошёл в 15-минутную зону.
    ==========================================
    */

    for (const existing of activeOrders) {
        if (
            existing.is_immediate ||
            !existing.scheduled_at
        ) {
            continue;
        }

        const scheduledTime =
            new Date(
                existing.scheduled_at
            ).getTime();

        const timeLeft =
            scheduledTime - now;

        /*
        Заказ уже наступил
        */

        if (timeLeft <= 0) {
            return {
                blocked: true,
                reason:
                    'У водителя уже наступил заранее назначенный заказ.'
            };
        }

        /*
        Осталось 15 минут или меньше
        */

        if (
            timeLeft <=
            FUTURE_ORDER_BLOCK_MS
        ) {
            return {
                blocked: true,
                reason:
                    'До заранее назначенного заказа осталось 15 минут или меньше.'
            };
        }
    }

    /*
    ==========================================
    2. Если новый заказ обычный
       "Сейчас" — максимум 2 активных.
    ==========================================
    */

    if (newOrderIsImmediate) {
        const immediateOrders =
            activeOrders.filter(
                order =>
                    order.is_immediate ||
                    !order.scheduled_at
            );

        if (
            immediateOrders.length >=
            MAX_NORMAL_ACTIVE_ORDERS
        ) {
            return {
                blocked: true,
                reason:
                    'У водителя уже максимальное количество текущих заказов.'
            };
        }
    }

    /*
    ==========================================
    3. Если новый заказ будущий,
       его можно принять заранее.

       Но если водитель уже имеет
       два обычных заказа — не добавляем
       третий текущий заказ.

       Будущие заказы разрешены, пока
       не наступила 15-минутная зона.
    ==========================================
    */

    if (!newOrderIsImmediate) {
        /*
        Здесь специально НЕ запрещаем
        будущий заказ из-за наличия
        обычной поездки.

        Например:

        Сейчас 12:00
        текущая поездка есть
        будущий заказ на 18:00

        Такой заказ водитель может
        заранее принять.
        */

        return {
            blocked: false
        };
    }

    return {
        blocked: false
    };
}

/*
==================================================
 ПОДГОТОВКА ЗАКАЗА
==================================================
*/

function normalizeIncomingOrder(
    order
) {
    const telegramUserId =
        order.telegramUserId ||
        order.telegram_user_id ||
        order.passengerChatId ||
        null;

    const immediate =
        isNowOrder(order);

    const scheduledAt =
        parseScheduledAt(order);

    return {
        id:
            String(
                order.id ||
                Date.now().toString()
            ),

        telegramUserId:
            telegramUserId
                ? String(telegramUserId)
                : null,

        addressA:
            order.addressA ||
            order.address_a ||
            '',

        addressB:
            order.addressB ||
            order.address_b ||
            '',

        tariff:
            order.tariff ||
            '',

        scheduled:
            order.scheduled ||
            (immediate
                ? 'Ближайшее время'
                : ''),

        scheduledAt,

        isImmediate:
            immediate,

        isWeekend:
            normalizeBoolean(
                order.isWeekend
            ),

        childSeat:
            normalizeBoolean(
                order.childSeat ||
                order.child_seat
            )
    };
}

/*
==================================================
 СОХРАНИТЬ ЗАКАЗ
==================================================
*/

async function createOrder(order) {
    await pool.query(
        `
        INSERT INTO passenger_orders (
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

            status,

            created_at
        )
        VALUES (
            $1,
            $2,

            $3,
            $4,

            $5,
            $6,
            $7,

            $8,
            $9,
            $10,

            'searching',

            NOW()
        )
        ON CONFLICT (id)
        DO UPDATE SET
            telegram_user_id = EXCLUDED.telegram_user_id,
            address_a = EXCLUDED.address_a,
            address_b = EXCLUDED.address_b,
            tariff = EXCLUDED.tariff,
            scheduled = EXCLUDED.scheduled,
            scheduled_at = EXCLUDED.scheduled_at,
            is_immediate = EXCLUDED.is_immediate,
            is_weekend = EXCLUDED.is_weekend,
            child_seat = EXCLUDED.child_seat,
            status = 'searching'
        `,
        [
            order.id,
            order.telegramUserId,

            order.addressA,
            order.addressB,

            order.tariff,
            order.scheduled,
            order.scheduledAt,

            order.isImmediate,
            order.isWeekend,
            order.childSeat
        ]
    );

    return getOrder(order.id);
}

/*
==================================================
 ТЕКСТ ЗАКАЗА ДЛЯ ВОДИТЕЛЯ
==================================================
*/

function orderText(order) {
    const child =
        order.childSeat
            ? '\n👶 Детское кресло: нужно'
            : '';

    const weekend =
        order.isWeekend
            ? '\n📅 Выходной тариф: да'
            : '';

    let timeText =
        order.scheduled ||
        'Ближайшее время';

    if (
        !order.isImmediate &&
        order.scheduledAt
    ) {
        timeText =
            formatMinskDate(
                new Date(
                    order.scheduledAt
                )
            );
    }

    return (
        '🚕 НОВЫЙ ЗАКАЗ\n\n' +

        `🆔 Заказ: #${order.id}\n` +

        `📍 Откуда: ${
            order.addressA || '-'
        }\n` +

        `🏁 Куда: ${
            order.addressB || '-'
        }\n` +

        `💰 Тариф: ${
            order.tariff || '-'
        }\n` +

        `🕐 Время: ${timeText}` +

        child +
        weekend
    );
}

/*
==================================================
 ОТПРАВИТЬ ЗАКАЗ ВОДИТЕЛЯМ
==================================================
*/

async function notifyDrivers(
    order
) {
    if (!pool) {
        console.error(
            'Нет PostgreSQL — невозможно проверить водителей.'
        );

        return {
            sent: 0
        };
    }

    const result =
        await pool.query(
            `
            SELECT *
            FROM drivers
            ORDER BY created_at ASC
            `
        );

    const drivers =
        result.rows;

    if (
        drivers.length === 0
    ) {
        console.log(
            'В базе нет зарегистрированных водителей.'
        );

        return {
            sent: 0
        };
    }

    const keyboard = {
        inline_keyboard: [
            [
                {
                    text:
                        '✅ ПРИНЯТЬ ЗАКАЗ',
                    callback_data:
                        `accept:${order.id}`
                }
            ],
            [
                {
                    text:
                        '❌ ОТКЛОНИТЬ',
                    callback_data:
                        `reject:${order.id}`
                }
            ]
        ]
    };

    const messageRefs = [];

    let sent = 0;

    for (
        const driver of drivers
    ) {
        const driverTelegramId =
            String(
                driver.telegram_id
            );

        /*
        Проверяем список разрешённых
        */

        if (
            !isDriverTelegramId(
                driverTelegramId
            )
        ) {
            continue;
        }

        /*
        Детское кресло
        */

        if (
            order.childSeat &&
            !driver.has_child_seat
        ) {
            console.log(
                `Водитель ${driverTelegramId} пропущен: нет детского кресла`
            );

            continue;
        }

        /*
        ПРОВЕРКА ЗАНЯТОСТИ
        */

        const availability =
            await checkDriverAvailability(
                driverTelegramId,
                order
            );

        if (
            availability.blocked
        ) {
            console.log(
                `Водитель ${driverTelegramId} пропущен: ${availability.reason}`
            );

            continue;
        }

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

            messageRefs.push({
                chatId:
                    driverTelegramId,

                messageId:
                    message.message_id
            });

            sent++;

            console.log(
                `Заказ #${order.id} отправлен водителю ${driverTelegramId}`
            );
        } catch (error) {
            console.error(
                `Ошибка отправки водителю ${driverTelegramId}:`,
                error.message
            );
        }
    }

    orderDriverMessages.set(
        String(order.id),
        messageRefs
    );

    return {
        sent
    };
}

/*
==================================================
 УБРАТЬ КНОПКИ У ВСЕХ ВОДИТЕЛЕЙ
==================================================
*/

async function removeOrderButtons(
    orderId
) {
    const refs =
        orderDriverMessages.get(
            String(orderId)
        );

    if (!refs) {
        return;
    }

    for (
        const ref of refs
    ) {
        try {
            await telegram(
                'editMessageReplyMarkup',
                {
                    chat_id:
                        ref.chatId,

                    message_id:
                        ref.messageId,

                    reply_markup: {
                        inline_keyboard: []
                    }
                }
            );
        } catch (_) {}
    }

    orderDriverMessages.delete(
        String(orderId)
    );
}

/*
==================================================
 ПАССАЖИРУ — ВОДИТЕЛЬ ПРИНЯЛ
==================================================
*/

async function notifyPassengerAccepted(
    order
) {
    if (
        !order.telegramUserId
    ) {
        console.log(
            'У заказа нет telegramUserId.'
        );

        return;
    }

    const text =
        '✅ ВОДИТЕЛЬ ПРИНЯЛ ВАШ ЗАКАЗ\n\n' +

        `👤 ${
            order.driverName ||
            'Водитель'
        }\n` +

        `🚕 ${
            order.driverCar ||
            'Автомобиль уточняется'
        }\n` +

        `🔢 ${
            order.driverNumber ||
            'Номер уточняется'
        }\n\n` +

        (
            order.isImmediate
                ? '🚗 Водитель едет к вам.'
                : '📅 Заказ заранее забронирован за водителем.'
        );

    try {
        await sendTelegramMessage(
            order.telegramUserId,
            text
        );
    } catch (error) {
        console.error(
            'Ошибка сообщения пассажиру:',
            error.message
        );
    }

    /*
    Фото автомобиля/водителя
    */

    if (
        order.driverPhotoFileId
    ) {
        try {
            await telegram(
                'sendPhoto',
                {
                    chat_id:
                        order.telegramUserId,

                    photo:
                        order.driverPhotoFileId,

                    caption:
                        '🚕 Водитель вашего заказа'
                }
            );
        } catch (_) {}
    }
}

/*
==================================================
 АТОМАРНОЕ ПРИНЯТИЕ ЗАКАЗА
==================================================

Здесь самая важная защита.

Два водителя могут одновременно
нажать "Принять".

PostgreSQL гарантирует,
что заказ получит только один.
==================================================
*/

async function acceptOrder(
    orderId,
    driverTelegramId
) {
    if (!pool) {
        return {
            success: false,
            statusCode: 500,
            error:
                'База данных не подключена.'
        };
    }

    const client =
        await pool.connect();

    try {
        await client.query(
            'BEGIN'
        );

        /*
        Блокируем действия конкретного
        водителя, чтобы два заказа
        не были приняты одновременно.
        */

        await client.query(
            `
            SELECT pg_advisory_xact_lock(
                hashtext($1)
            )
            `,
            [
                String(
                    driverTelegramId
                )
            ]
        );

        /*
        Получаем заказ с блокировкой.
        */

        const orderResult =
            await client.query(
                `
                SELECT *
                FROM passenger_orders
                WHERE id = $1
                FOR UPDATE
                `,
                [
                    String(orderId)
                ]
            );

        if (
            orderResult.rows.length === 0
        ) {
            await client.query(
                'ROLLBACK'
            );

            return {
                success: false,
                statusCode: 404,
                error:
                    'Заказ не найден.'
            };
        }

        const row =
            orderResult.rows[0];

        /*
        Если уже принят —
        другой водитель не может забрать.
        */

        if (
            row.status !== 'searching'
        ) {
            await client.query(
                'ROLLBACK'
            );

            return {
                success: false,
                statusCode: 409,
                error:
                    'Заказ уже принят другим водителем.'
            };
        }

        /*
        Профиль водителя
        */

        const driverResult =
            await client.query(
                `
                SELECT *
                FROM drivers
                WHERE telegram_id = $1
                LIMIT 1
                `,
                [
                    String(
                        driverTelegramId
                    )
                ]
            );

        if (
            driverResult.rows.length === 0
        ) {
            await client.query(
                'ROLLBACK'
            );

            return {
                success: false,
                statusCode: 403,
                error:
                    'Профиль водителя не найден.'
            };
        }

        const driver =
            driverResult.rows[0];

        /*
        Детское кресло
        */

        if (
            row.child_seat &&
            !driver.has_child_seat
        ) {
            await client.query(
                'ROLLBACK'
            );

            return {
                success: false,
                statusCode: 409,
                error:
                    'Для этого заказа требуется детское кресло.'
            };
        }

        /*
        Формируем заказ для проверки.
        */

        const order =
            dbOrderToObject(row);

        /*
        САМАЯ ВАЖНАЯ ПРОВЕРКА
        ПРЯМО В МОМЕНТ НАЖАТИЯ "ПРИНЯТЬ".
        */

        const availability =
            await checkDriverAvailability(
                driverTelegramId,
                order,
                client
            );

        if (
            availability.blocked
        ) {
            await client.query(
                'ROLLBACK'
            );

            return {
                success: false,
                statusCode: 409,
                error:
                    'Сейчас этот заказ принять нельзя: ' +
                    availability.reason
            };
        }

        /*
        Записываем водителя.
        */

        const updateResult =
            await client.query(
                `
                UPDATE passenger_orders

                SET
                    status = 'accepted',

                    driver_telegram_id = $2,
                    driver_name = $3,
                    driver_car = $4,
                    driver_number = $5,
                    driver_phone = $6,
                    driver_rating = $7,
                    driver_photo_file_id = $8,

                    accepted_at = NOW()

                WHERE id = $1
                  AND status = 'searching'

                RETURNING *
                `,
                [
                    String(orderId),

                    String(
                        driver.telegram_id
                    ),

                    driver.name ||
                    'Водитель',

                    driver.car ||
                    'Автомобиль',

                    driver.plate ||
                    '',

                    driver.phone ||
                    '',

                    driver.rating ||
                    5,

                    driver.photo_file_id ||
                    null
                ]
            );

        /*
        За это время другой водитель
        уже мог принять заказ.
        */

        if (
            updateResult.rows.length === 0
        ) {
            await client.query(
                'ROLLBACK'
            );

            return {
                success: false,
                statusCode: 409,
                error:
                    'Заказ уже принят другим водителем.'
            };
        }

        await client.query(
            'COMMIT'
        );

        const acceptedOrder =
            dbOrderToObject(
                updateResult.rows[0]
            );

        console.log(
            '================================='
        );

        console.log(
            'ЗАКАЗ ПРИНЯТ'
        );

        console.log(
            `Заказ: #${acceptedOrder.id}`
        );

        console.log(
            `Водитель: ${driver.name}`
        );

        console.log(
            `Telegram ID: ${driverTelegramId}`
        );

        console.log(
            `Сейчас: ${acceptedOrder.isImmediate}`
        );

        console.log(
            `Время: ${acceptedOrder.scheduled || '-'}`
        );

        console.log(
            '================================='
        );

        /*
        Уведомляем пассажира.
        */

        await notifyPassengerAccepted(
            acceptedOrder
        );

        /*
        Убираем кнопки у других водителей.
        */

        await removeOrderButtons(
            acceptedOrder.id
        );

        return {
            success: true,
            order:
                acceptedOrder
        };

    } catch (error) {
        try {
            await client.query(
                'ROLLBACK'
            );
        } catch (_) {}

        console.error(
            'Ошибка принятия заказа:',
            error
        );

        return {
            success: false,
            statusCode: 500,
            error:
                'Ошибка принятия заказа.'
        };

    } finally {
        client.release();
    }
}

/*
==================================================
 ОТКЛОНЕНИЕ
==================================================
*/

async function rejectOrder(
    orderId,
    driverTelegramId
) {
    /*
    Сам заказ не отменяем.

    Другие водители всё ещё должны
    иметь возможность его принять.
    */

    return {
        success: true
    };
}

/*
==================================================
 API: СОЗДАНИЕ ЗАКАЗА
==================================================
*/

app.post(
    '/api/send-order',
    async (req, res) => {
        try {
            if (!pool) {
                return res.status(500).json({
                    success: false,
                    error:
                        'PostgreSQL не подключён.'
                });
            }

            const order =
                normalizeIncomingOrder(
                    req.body || {}
                );

            /*
            Для будущего заказа обязательно
            должна быть дата.
            */

            if (
                !order.isImmediate &&
                !order.scheduledAt
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Не удалось определить дату и время заказа.'
                });
            }

            /*
            Будущий заказ не должен быть
            в прошлом.
            */

            if (
                !order.isImmediate &&
                order.scheduledAt
            ) {
                if (
                    order.scheduledAt.getTime() <=
                    Date.now()
                ) {
                    return res.status(400).json({
                        success: false,
                        error:
                            'Дата и время заказа уже прошли.'
                    });
                }
            }

            const saved =
                await createOrder(
                    order
                );

            const orderObject =
                dbOrderToObject(
                    saved
                );

            console.log(
                '================================='
            );

            console.log(
                'НОВЫЙ ЗАКАЗ'
            );

            console.log(
                orderObject
            );

            console.log(
                '================================='
            );

            const notifyResult =
                await notifyDrivers(
                    orderObject
                );

            /*
            Если никто не получил заказ.
            */

            if (
                notifyResult.sent === 0
            ) {
                await pool.query(
                    `
                    UPDATE passenger_orders
                    SET status = 'no_drivers'
                    WHERE id = $1
                    `,
                    [order.id]
                );

                if (
                    order.telegramUserId
                ) {
                    try {
                        await sendTelegramMessage(
                            order.telegramUserId,
                            order.childSeat
                                ? '⚠️ Сейчас нет свободного водителя с детским креслом для вашего заказа.'
                                : '⚠️ Сейчас нет свободного водителя для вашего заказа.'
                        );
                    } catch (_) {}
                }

                return res.json({
                    success: true,
                    order: {
                        ...orderObject,
                        status:
                            'no_drivers'
                    },
                    driversFound: 0
                });
            }

            res.json({
                success: true,
                order: orderObject,
                driversFound:
                    notifyResult.sent
            });

        } catch (error) {
            console.error(
                'Ошибка создания заказа:',
                error
            );

            res.status(500).json({
                success: false,
                error:
                    'Ошибка создания заказа.'
            });
        }
    }
);

/*
==================================================
 API: ПОЛУЧИТЬ ЗАКАЗ
==================================================

Поддерживает:

/api/get-order?id=123

И старый вариант без id.
==================================================
*/

app.get(
    '/api/get-order',
    async (req, res) => {
        try {
            if (!pool) {
                return res.json({
                    status: 'none'
                });
            }

            let row = null;

            if (req.query.id) {
                row =
                    await getOrder(
                        req.query.id
                    );
            } else {
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

                row =
                    result.rows[0] ||
                    null;
            }

            if (!row) {
                return res.json({
                    status: 'none'
                });
            }

            res.json(
                dbOrderToObject(row)
            );

        } catch (error) {
            console.error(
                'get-order:',
                error
            );

            res.status(500).json({
                status: 'none'
            });
        }
    }
);

/*
==================================================
 API: СТАТУС ЗАКАЗА
==================================================
*/

app.get(
    '/api/order-status',
    async (req, res) => {
        try {
            if (!pool) {
                return res.json({
                    status: 'none'
                });
            }

            let row = null;

            /*
            Если Mini App передал id —
            возвращаем именно его.
            */

            if (req.query.id) {
                row =
                    await getOrder(
                        req.query.id
                    );
            }

            /*
            Если id нет, используем
            telegramUserId.
            */

            if (
                !row &&
                req.query.telegramUserId
            ) {
                row =
                    await getLatestPassengerOrder(
                        req.query.telegramUserId
                    );
            }

            /*
            Обратная совместимость:
            последний заказ вообще.
            */

            if (!row) {
                const result =
                    await pool.query(
                        `
                        SELECT *
                        FROM passenger_orders
                        ORDER BY created_at DESC
                        LIMIT 1
                        `
                    );

                row =
                    result.rows[0] ||
                    null;
            }

            if (!row) {
                return res.json({
                    status: 'none'
                });
            }

            res.json(
                dbOrderToObject(row)
            );

        } catch (error) {
            console.error(
                'order-status:',
                error
            );

            res.status(500).json({
                status: 'none'
            });
        }
    }
);

/*
==================================================
 API: ПРИНЯТЬ ЗАКАЗ ИЗ MINI APP
==================================================
*/

app.post(
    '/api/accept-order',
    async (req, res) => {
        try {
            const driverTelegramId =
                req.body?.telegramId ||
                req.body?.driverTelegramId ||
                req.body?.chatId;

            if (
                !driverTelegramId
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Не указан Telegram ID водителя.'
                });
            }

            if (
                !isDriverTelegramId(
                    driverTelegramId
                )
            ) {
                return res.status(403).json({
                    success: false,
                    error:
                        'У вас нет прав водителя.'
                });
            }

            const result =
                await acceptOrder(
                    req.body?.orderId,
                    driverTelegramId
                );

            if (
                !result.success
            ) {
                return res.status(
                    result.statusCode || 400
                ).json(result);
            }

            res.json(result);

        } catch (error) {
            console.error(
                'accept-order:',
                error
            );

            res.status(500).json({
                success: false,
                error:
                    'Ошибка принятия заказа.'
            });
        }
    }
);

/*
==================================================
 ПОЛУЧИТЬ АКТИВНЫЕ ЗАКАЗЫ ВОДИТЕЛЯ
==================================================
*/

app.get(
    '/api/driver-orders',
    async (req, res) => {
        try {
            const driverTelegramId =
                req.query.telegramId ||
                req.query.driverTelegramId;

            if (
                !driverTelegramId
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Не указан Telegram ID водителя.'
                });
            }

            if (
                !isDriverTelegramId(
                    driverTelegramId
                )
            ) {
                return res.status(403).json({
                    success: false,
                    error:
                        'Нет доступа.'
                });
            }

            const rows =
                await getActiveDriverOrders(
                    driverTelegramId
                );

            res.json({
                success: true,

                orders:
                    rows.map(
                        dbOrderToObject
                    )
            });

        } catch (error) {
            console.error(
                'driver-orders:',
                error
            );

            res.status(500).json({
                success: false,
                error:
                    'Ошибка получения заказов.'
            });
        }
    }
);

/*
==================================================
 НАЙТИ ЗАКАЗ ВОДИТЕЛЯ
==================================================
*/

async function resolveDriverOrder(
    driverTelegramId,
    orderId
) {
    if (orderId) {
        const result =
            await pool.query(
                `
                SELECT *
                FROM passenger_orders
                WHERE id = $1
                  AND driver_telegram_id = $2
                LIMIT 1
                `,
                [
                    String(orderId),
                    String(
                        driverTelegramId
                    )
                ]
            );

        return result.rows[0] || null;
    }

    const result =
        await pool.query(
            `
            SELECT *
            FROM passenger_orders
            WHERE driver_telegram_id = $1
              AND status = ANY($2::text[])
            ORDER BY
                CASE
                    WHEN is_immediate = TRUE
                    THEN 0
                    ELSE 1
                END,
                scheduled_at ASC NULLS LAST,
                created_at ASC
            LIMIT 1
            `,
            [
                String(
                    driverTelegramId
                ),
                ACTIVE_STATUSES
            ]
        );

    return result.rows[0] || null;
}

/*
==================================================
 ВОДИТЕЛЬ ПРИЕХАЛ
==================================================
*/

app.post(
    '/api/driver-arrived',
    async (req, res) => {
        try {
            const driverTelegramId =
                req.body?.telegramId ||
                req.body?.driverTelegramId;

            const orderId =
                req.body?.orderId;

            if (
                !driverTelegramId
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Не указан водитель.'
                });
            }

            const row =
                await resolveDriverOrder(
                    driverTelegramId,
                    orderId
                );

            if (!row) {
                return res.status(404).json({
                    success: false,
                    error:
                        'Активный заказ не найден.'
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
                    RETURNING *
                    `,
                    [row.id]
                );

            const order =
                dbOrderToObject(
                    result.rows[0]
                );

            res.json({
                success: true,
                order
            });

        } catch (error) {
            console.error(
                'driver-arrived:',
                error
            );

            res.status(500).json({
                success: false,
                error:
                    'Ошибка.'
            });
        }
    }
);

/*
==================================================
 НАЧАЛО ПОЕЗДКИ
==================================================
*/

app.post(
    '/api/start-trip',
    async (req, res) => {
        try {
            const driverTelegramId =
                req.body?.telegramId ||
                req.body?.driverTelegramId;

            const orderId =
                req.body?.orderId;

            if (
                !driverTelegramId
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Не указан водитель.'
                });
            }

            const row =
                await resolveDriverOrder(
                    driverTelegramId,
                    orderId
                );

            if (!row) {
                return res.status(404).json({
                    success: false,
                    error:
                        'Активный заказ не найден.'
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
                    RETURNING *
                    `,
                    [row.id]
                );

            const order =
                dbOrderToObject(
                    result.rows[0]
                );

            res.json({
                success: true,
                order
            });

        } catch (error) {
            console.error(
                'start-trip:',
                error
            );

            res.status(500).json({
                success: false,
                error:
                    'Ошибка.'
            });
        }
    }
);

/*
==================================================
 ЗАВЕРШЕНИЕ ЗАКАЗА
==================================================
*/

app.post(
    '/api/complete-order',
    async (req, res) => {
        try {
            const driverTelegramId =
                req.body?.telegramId ||
                req.body?.driverTelegramId;

            const orderId =
                req.body?.orderId;

            if (
                !driverTelegramId
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Не указан водитель.'
                });
            }

            const row =
                await resolveDriverOrder(
                    driverTelegramId,
                    orderId
                );

            if (!row) {
                return res.status(404).json({
                    success: false,
                    error:
                        'Активный заказ не найден.'
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
                    RETURNING *
                    `,
                    [row.id]
                );

            const order =
                dbOrderToObject(
                    result.rows[0]
                );

            /*
            После завершения водитель
            автоматически освобождается.
            */

            console.log(
                `Заказ #${order.id} завершён. Водитель ${driverTelegramId} снова свободен.`
            );

            /*
            Уведомляем пассажира.
            */

            if (
                order.telegramUserId
            ) {
                try {
                    await sendTelegramMessage(
                        order.telegramUserId,
                        '✅ Поездка завершена. Спасибо, что воспользовались «Такси Речица»!'
                    );
                } catch (_) {}
            }

            res.json({
                success: true,
                order
            });

        } catch (error) {
            console.error(
                'complete-order:',
                error
            );

            res.status(500).json({
                success: false,
                error:
                    'Ошибка завершения заказа.'
            });
        }
    }
);

/*
==================================================
 ПРОФИЛЬ ВОДИТЕЛЯ
==================================================
*/

async function saveDriverProfile(
    profile
) {
    await pool.query(
        `
        INSERT INTO drivers (
            telegram_id,
            name,
            car,
            plate,
            phone,
            photo_file_id,
            has_child_seat,
            updated_at
        )
        VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            NOW()
        )

        ON CONFLICT (telegram_id)
        DO UPDATE SET
            name = EXCLUDED.name,
            car = EXCLUDED.car,
            plate = EXCLUDED.plate,
            phone = EXCLUDED.phone,
            photo_file_id =
                EXCLUDED.photo_file_id,
            has_child_seat =
                EXCLUDED.has_child_seat,
            updated_at = NOW()
        `,
        [
            String(
                profile.telegramId
            ),

            profile.name ||
            '',

            profile.car ||
            '',

            profile.plate ||
            '',

            profile.phone ||
            '',

            profile.photoFileId ||
            null,

            Boolean(
                profile.hasChildSeat
            )
        ]
    );
}

function driverProfileText(
    profile
) {
    if (!profile) {
        return (
            '👤 Профиль водителя не заполнен.'
        );
    }

    return (
        '🚕 ПРОФИЛЬ ВОДИТЕЛЯ\n\n' +

        `👤 Имя: ${
            profile.name || '-'
        }\n` +

        `🚗 Авто: ${
            profile.car || '-'
        }\n` +

        `🔢 Номер: ${
            profile.plate || '-'
        }\n` +

        `📞 Телефон: ${
            profile.phone || '-'
        }\n` +

        `👶 Детское кресло: ${
            profile.has_child_seat
                ? '✅ Есть'
                : '❌ Нет'
        }\n` +

        `⭐ Рейтинг: ${
            profile.rating || '5.00'
        }`
    );
}

/*
==================================================
 СЕССИИ ЗАПОЛНЕНИЯ ПРОФИЛЯ
==================================================
*/

const driverSessions =
    new Map();

function childSeatKeyboard(
    edit = false
) {
    return {
        inline_keyboard: [
            [
                {
                    text:
                        '✅ Есть',

                    callback_data:
                        edit
                            ? 'driver_seat_edit:yes'
                            : 'driver_seat:yes'
                },
                {
                    text:
                        '❌ Нет',

                    callback_data:
                        edit
                            ? 'driver_seat_edit:no'
                            : 'driver_seat:no'
                }
            ]
        ]
    };
}

/*
==================================================
 /PROFILE
==================================================
*/

async function showDriverProfile(
    chatId
) {
    const profile =
        await getDriverProfile(
            chatId
        );

    if (!profile) {
        await sendTelegramMessage(
            chatId,
            '👤 Профиль ещё не заполнен.\n\n' +
            'Используйте /editprofile'
        );

        return;
    }

    await sendTelegramMessage(
        chatId,
        driverProfileText(profile),
        {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text:
                                '✏️ Изменить профиль',

                            callback_data:
                                'editprofile'
                        }
                    ]
                ]
            }
        }
    );
}

/*
==================================================
 НАЧАТЬ ЗАПОЛНЕНИЕ ПРОФИЛЯ
==================================================
*/

async function startDriverProfile(
    chatId
) {
    driverSessions.set(
        chatId,
        {
            step: 'name',
            data: {}
        }
    );

    await sendTelegramMessage(
        chatId,
        '👤 Давайте заполним профиль водителя.\n\n' +
        'Введите ваше имя:'
    );
}

/*
==================================================
 ОБРАБОТКА СООБЩЕНИЙ ВОДИТЕЛЯ
==================================================
*/

async function processDriverMessage(
    message
) {
    const chatId =
        message.chat.id;

    const session =
        driverSessions.get(
            chatId
        );

    if (!session) {
        return false;
    }

    const text =
        message.text || '';

    /*
    Имя
    */

    if (
        session.step === 'name'
    ) {
        session.data.name =
            text.trim();

        session.step =
            'car';

        await sendTelegramMessage(
            chatId,
            '🚗 Напишите марку и модель автомобиля:\n\n' +
            'Например: Toyota Corolla'
        );

        return true;
    }

    /*
    Автомобиль
    */

    if (
        session.step === 'car'
    ) {
        session.data.car =
            text.trim();

        session.step =
            'plate';

        await sendTelegramMessage(
            chatId,
            '🔢 Напишите государственный номер автомобиля:\n\n' +
            'Например: 1234 AB-4'
        );

        return true;
    }

    /*
    Номер
    */

    if (
        session.step === 'plate'
    ) {
        session.data.plate =
            text.trim();

        session.step =
            'phone';

        await sendTelegramMessage(
            chatId,
            '📞 Напишите ваш номер телефона:'
        );

        return true;
    }

    /*
    Телефон
    */

    if (
        session.step === 'phone'
    ) {
        session.data.phone =
            text.trim();

        session.step =
            'childSeat';

        await sendTelegramMessage(
            chatId,
            '👶 Есть ли у вас детское кресло?',
            {
                reply_markup:
                    childSeatKeyboard(
                        false
                    )
            }
        );

        return true;
    }

    return false;
}

/*
==================================================
 TELEGRAM CALLBACK
==================================================
*/

async function processCallback(
    callback
) {
    const chatId =
        callback.message?.chat?.id;

    const data =
        callback.data || '';

    await telegram(
        'answerCallbackQuery',
        {
            callback_query_id:
                callback.id
        }
    );

    /*
    ==========================================
    ПРИНЯТИЕ
    ==========================================
    */

    if (
        data.startsWith(
            'accept:'
        )
    ) {
        const orderId =
            data.substring(
                'accept:'.length
            );

        if (
            !isDriverTelegramId(
                chatId
            )
        ) {
            await sendTelegramMessage(
                chatId,
                '⛔ У вас нет прав водителя.'
            );

            return;
        }

        const result =
            await acceptOrder(
                orderId,
                chatId
            );

        if (
            result.success
        ) {
            await sendTelegramMessage(
                chatId,
                '✅ Заказ принят!\n\n' +
                `Заказ #${result.order.id}\n\n` +
                (
                    result.order.isImmediate
                        ? '🚗 Это текущий заказ.'
                        : '📅 Это заранее назначенный заказ.'
                ) +
                '\n\n' +
                'Откройте Mini App для управления поездкой.'
            );
        } else {
            await sendTelegramMessage(
                chatId,
                `⚠️ ${result.error}`
            );
        }

        return;
    }

    /*
    ==========================================
    ОТКЛОНЕНИЕ
    ==========================================
    */

    if (
        data.startsWith(
            'reject:'
        )
    ) {
        const orderId =
            data.substring(
                'reject:'.length
            );

        if (
            isDriverTelegramId(
                chatId
            )
        ) {
            await rejectOrder(
                orderId,
                chatId
            );

            /*
            Убираем кнопки только
            у этого водителя.
            */

            try {
                await telegram(
                    'editMessageReplyMarkup',
                    {
                        chat_id:
                            chatId,

                        message_id:
                            callback.message
                                ?.message_id,

                        reply_markup: {
                            inline_keyboard: []
                        }
                    }
                );
            } catch (_) {}

            await sendTelegramMessage(
                chatId,
                `❌ Заказ #${orderId} отклонён.`
            );
        }

        return;
    }

    /*
    ==========================================
    РЕДАКТИРОВАНИЕ ПРОФИЛЯ
    ==========================================
    */

    if (
        data === 'editprofile'
    ) {
        if (
            !isDriverTelegramId(
                chatId
            )
        ) {
            return;
        }

        await startDriverProfile(
            chatId
        );

        return;
    }

    /*
    ==========================================
    ДЕТСКОЕ КРЕСЛО — НОВЫЙ ПРОФИЛЬ
    ==========================================
    */

    if (
        data === 'driver_seat:yes' ||
        data === 'driver_seat:no'
    ) {
        const session =
            driverSessions.get(
                chatId
            );

        if (!session) {
            return;
        }

        session.data.hasChildSeat =
            data.endsWith(':yes');

        session.step =
            'photo';

        await sendTelegramMessage(
            chatId,
            '📸 Отправьте фотографию автомобиля.\n\n' +
            'Если не хотите добавлять фото — напишите /skip'
        );

        return;
    }

    /*
    ==========================================
    ДЕТСКОЕ КРЕСЛО — РЕДАКТИРОВАНИЕ
    ==========================================
    */

    if (
        data === 'driver_seat_edit:yes' ||
        data === 'driver_seat_edit:no'
    ) {
        const session =
            driverSessions.get(
                chatId
            );

        if (!session) {
            return;
        }

        session.data.hasChildSeat =
            data.endsWith(':yes');

        session.step =
            'photo';

        await sendTelegramMessage(
            chatId,
            '📸 Отправьте новую фотографию автомобиля.\n\n' +
            'Или напишите /skip, чтобы оставить старую.'
        );

        return;
    }
}

/*
==================================================
 TELEGRAM MESSAGE
==================================================
*/

async function processTelegramMessage(
    message
) {
    const chatId =
        message.chat.id;

    const text =
        message.text || '';

    const user =
        message.from || {};

    /*
    ==========================================
    ВОДИТЕЛЬ
    ==========================================
    */

    if (
        isDriverTelegramId(
            chatId
        )
    ) {
        driverChats.set(
            chatId,
            {
                chatId,

                telegramId:
                    user.id,

                firstName:
                    user.first_name ||
                    'Водитель',

                username:
                    user.username ||
                    ''
            }
        );
    }

    /*
    /start
    */

    if (
        text.startsWith('/start')
    ) {
        if (
            isDriverTelegramId(
                chatId
            )
        ) {
            await sendTelegramMessage(
                chatId,
                '🚕 Такси Речица\n\n' +
                'Вы зарегистрированы как водитель.\n\n' +
                'Команды:\n' +
                '/profile — мой профиль\n' +
                '/editprofile — изменить профиль\n' +
                '/orders — мои активные заказы\n\n' +
                'Когда появится подходящий заказ, он придёт сюда.'
            );
        } else {
            await sendTelegramMessage(
                chatId,
                '🚕 Такси Речица\n\n' +
                'Для заказа такси откройте Mini App.'
            );
        }

        return;
    }

    /*
    /profile
    */

    if (
        text === '/profile'
    ) {
        if (
            isDriverTelegramId(
                chatId
            )
        ) {
            await showDriverProfile(
                chatId
            );
        }

        return;
    }

    /*
    /editprofile
    */

    if (
        text === '/editprofile'
    ) {
        if (
            isDriverTelegramId(
                chatId
            )
        ) {
            await startDriverProfile(
                chatId
            );
        }

        return;
    }

    /*
    /orders
    */

    if (
        text === '/orders'
    ) {
        if (
            isDriverTelegramId(
                chatId
            )
        ) {
            const rows =
                await getActiveDriverOrders(
                    chatId
                );

            if (
                rows.length === 0
            ) {
                await sendTelegramMessage(
                    chatId,
                    '🚕 Активных заказов нет.'
                );

                return;
            }

            let messageText =
                '🚕 ВАШИ АКТИВНЫЕ ЗАКАЗЫ\n\n';

            for (
                const row of rows
            ) {
                const order =
                    dbOrderToObject(
                        row
                    );

                messageText +=
                    `#${order.id}\n` +

                    `📍 ${
                        order.addressA
                    } → ${
                        order.addressB
                    }\n` +

                    `🕐 ${
                        order.scheduled ||
                        'Ближайшее время'
                    }\n` +

                    `📌 ${
                        order.isImmediate
                            ? 'Текущий заказ'
                            : 'Предварительный заказ'
                    }\n\n`;
            }

            await sendTelegramMessage(
                chatId,
                messageText
            );
        }

        return;
    }

    /*
    /skip
    */

    if (
        text === '/skip'
    ) {
        const session =
            driverSessions.get(
                chatId
            );

        if (
            session &&
            session.step === 'photo'
        ) {
            const oldProfile =
                await getDriverProfile(
                    chatId
                );

            session.data.photoFileId =
                oldProfile?.photo_file_id ||
                null;

            await saveDriverProfile({
                telegramId:
                    chatId,

                name:
                    session.data.name,

                car:
                    session.data.car,

                plate:
                    session.data.plate,

                phone:
                    session.data.phone,

                photoFileId:
                    session.data.photoFileId,

                hasChildSeat:
                    session.data.hasChildSeat
            });

            driverSessions.delete(
                chatId
            );

            await sendTelegramMessage(
                chatId,
                '✅ Профиль сохранён!\n\n' +
                driverProfileText(
                    await getDriverProfile(
                        chatId
                    )
                )
            );
        }

        return;
    }

    /*
    Если сейчас заполняем профиль —
    передаём сообщение туда.
    */

    if (
        isDriverTelegramId(
            chatId
        )
    ) {
        const handled =
            await processDriverMessage(
                message
            );

        if (handled) {
            return;
        }
    }
}

/*
==================================================
 ФОТО ВОДИТЕЛЯ
==================================================
*/

async function processPhoto(
    message
) {
    const chatId =
        message.chat.id;

    const session =
        driverSessions.get(
            chatId
        );

    if (!session) {
        return false;
    }

    if (
        session.step !== 'photo'
    ) {
        return false;
    }

    if (
        !message.photo ||
        message.photo.length === 0
    ) {
        return false;
    }

    const photo =
        message.photo[
            message.photo.length - 1
        ];

    session.data.photoFileId =
        photo.file_id;

    await saveDriverProfile({
        telegramId:
            chatId,

        name:
            session.data.name,

        car:
            session.data.car,

        plate:
            session.data.plate,

        phone:
            session.data.phone,

        photoFileId:
            session.data.photoFileId,

        hasChildSeat:
            session.data.hasChildSeat
    });

    driverSessions.delete(
        chatId
    );

    const profile =
        await getDriverProfile(
            chatId
        );

    await sendTelegramMessage(
        chatId,
        '✅ Профиль водителя сохранён!\n\n' +
        driverProfileText(profile)
    );

    return true;
}

/*
==================================================
 TELEGRAM UPDATE
==================================================
*/

let telegramOffset = 0;
let telegramPolling = false;

async function processTelegramUpdate(
    update
) {
    try {
        if (
            update.message
        ) {
            const handledPhoto =
                await processPhoto(
                    update.message
                );

            if (
                handledPhoto
            ) {
                return;
            }

            await processTelegramMessage(
                update.message
            );
        }

        if (
            update.callback_query
        ) {
            await processCallback(
                update.callback_query
            );
        }
    } catch (error) {
        console.error(
            'Ошибка Telegram update:',
            error
        );
    }
}

/*
==================================================
 TELEGRAM POLLING
==================================================
*/

async function telegramPollingLoop() {
    if (
        telegramPolling
    ) {
        return;
    }

    telegramPolling =
        true;

    if (!BOT_TOKEN) {
        console.error(
            'TELEGRAM_BOT_TOKEN не задан.'
        );

        telegramPolling =
            false;

        return;
    }

    try {
        await telegram(
            'deleteWebhook',
            {
                drop_pending_updates:
                    false
            }
        );

        const me =
            await telegram(
                'getMe'
            );

        console.log(
            `Telegram бот подключён: @${me.username}`
        );

    } catch (error) {
        console.error(
            'Не удалось подключить Telegram:',
            error.message
        );

        telegramPolling =
            false;

        return;
    }

    while (true) {
        try {
            const updates =
                await telegram(
                    'getUpdates',
                    {
                        offset:
                            telegramOffset,

                        timeout:
                            25,

                        allowed_updates: [
                            'message',
                            'callback_query'
                        ]
                    }
                );

            for (
                const update of updates
            ) {
                telegramOffset =
                    update.update_id + 1;

                await processTelegramUpdate(
                    update
                );
            }

        } catch (error) {
            console.error(
                'Telegram polling:',
                error.message
            );

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        3000
                    )
            );
        }
    }
}

/*
==================================================
 HEALTH
==================================================
*/

app.get(
    '/health',
    async (req, res) => {
        let database =
            false;

        if (pool) {
            try {
                await pool.query(
                    'SELECT 1'
                );

                database =
                    true;
            } catch (_) {}
        }

        res.json({
            ok: true,

            telegram:
                Boolean(BOT_TOKEN),

            database,

            rules: {
                maxNormalActiveOrders:
                    MAX_NORMAL_ACTIVE_ORDERS,

                futureOrderBlockMinutes:
                    FUTURE_ORDER_BLOCK_MINUTES
            }
        });
    }
);

/*
==================================================
 ГЛАВНАЯ
==================================================
*/

app.get(
    '/',
    (req, res) => {
        res.sendFile(
            __dirname +
            '/public/index.html'
        );
    }
);

/*
==================================================
 ЗАПУСК
==================================================
*/

async function startServer() {
    try {
        await initDatabase();

        app.listen(
            PORT,
            () => {
                console.log(
                    '================================='
                );

                console.log(
                    `🚕 Такси Речица запущено`
                );

                console.log(
                    `Порт: ${PORT}`
                );

                console.log(
                    `Максимум обычных заказов: ${MAX_NORMAL_ACTIVE_ORDERS}`
                );

                console.log(
                    `Блокировка перед предварительным заказом: ${FUTURE_ORDER_BLOCK_MINUTES} минут`
                );

                console.log(
                    '================================='
                );

                telegramPollingLoop();
            }
        );

    } catch (error) {
        console.error(
            'Ошибка запуска сервера:',
            error
        );

        process.exit(1);
    }
}

startServer();
