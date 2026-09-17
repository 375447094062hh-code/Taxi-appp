const express = require('express');
const { Pool } = require('pg');

const app = express();

app.use(express.json());
app.use(express.static('public'));

let currentOrder = null;

// =====================================================
// TELEGRAM
// =====================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;

// =====================================================
// ВОДИТЕЛИ
// =====================================================

const DRIVER_CHAT_IDS = (process.env.DRIVER_CHAT_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

function isDriver(chatId) {
    return DRIVER_CHAT_IDS.includes(String(chatId));
}

// =====================================================
// POSTGRESQL
// =====================================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

pool.on('error', error => {
    console.error('PostgreSQL error:', error);
});

// =====================================================
// СЕССИИ
// =====================================================

const passengerSessions = new Map();
const driverSessions = new Map();
const editSessions = new Map();

// =====================================================
// TELEGRAM API
// =====================================================

async function telegram(method, data) {
    if (!TELEGRAM_BOT_TOKEN) {
        console.error('TELEGRAM_BOT_TOKEN не найден');
        return null;
    }

    try {
        const response = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            }
        );

        const result = await response.json();

        if (!result.ok) {
            console.error('Ошибка Telegram:', result);
        }

        return result;

    } catch (error) {
        console.error('Ошибка Telegram:', error);
        return null;
    }
}

// =====================================================
// КОМАНДЫ TELEGRAM
// =====================================================

async function setTelegramCommands() {

    const commands = [
        {
            command: 'start',
            description: '🚕 Запуск и главное меню'
        },
        {
            command: 'profile',
            description: '👤 Моя анкета'
        },
        {
            command: 'myprofile',
            description: '📋 Мой профиль'
        },
        {
            command: 'myorders',
            description: '📋 Мои заказы'
        },
        {
            command: 'help',
            description: '❓ Помощь'
        },
        {
            command: 'cancel',
            description: '❌ Отменить действие'
        }
    ];

    const result = await telegram(
        'setMyCommands',
        {
            commands
        }
    );

    console.log('Пассажирские команды установлены:', result);
}

// =====================================================
// КОМАНДЫ ВОДИТЕЛЯ
// =====================================================

async function setDriverCommands() {

    const commands = [
        {
            command: 'start',
            description: '🚕 Запуск'
        },
        {
            command: 'driver',
            description: '👨‍✈️ Режим водителя'
        },
        {
            command: 'profile',
            description: '👤 Анкета водителя'
        },
        {
            command: 'myprofile',
            description: '📋 Мой профиль'
        },
        {
            command: 'editprofile',
            description: '✏️ Изменить профиль'
        },
        {
            command: 'cancel',
            description: '❌ Отменить действие'
        }
    ];

    for (const driverId of DRIVER_CHAT_IDS) {

        const result = await telegram(
            'setMyCommands',
            {
                scope: {
                    type: 'chat',
                    chat_id: driverId
                },
                commands
            }
        );

        console.log(
            `Команды водителя ${driverId}:`,
            result
        );
    }
}

// =====================================================
// DATABASE
// =====================================================

async function initDatabase() {

    try {

        await pool.query(`
            CREATE TABLE IF NOT EXISTS drivers (
                telegram_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                car TEXT,
                plate TEXT,
                phone TEXT,
                photo_file_id TEXT,
                rating NUMERIC(3,2) DEFAULT 5.00,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS passengers (
                telegram_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                phone TEXT,
                comment TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS passenger_orders (
                id SERIAL PRIMARY KEY,
                telegram_id TEXT NOT NULL,
                order_id TEXT,
                status TEXT,
                address_from TEXT,
                address_to TEXT,
                tariff TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        console.log('✅ Таблица drivers готова');
        console.log('✅ Таблица passengers готова');
        console.log('✅ Таблица passenger_orders готова');

    } catch (error) {

        console.error(
            '❌ Ошибка создания таблиц:',
            error
        );
    }
}

// =====================================================
// DRIVER PROFILE
// =====================================================

async function getDriverProfile(chatId) {

    const result = await pool.query(
        `
        SELECT *
        FROM drivers
        WHERE telegram_id = $1
        `,
        [String(chatId)]
    );

    return result.rows[0] || null;
}

async function saveDriverProfile(chatId, data) {

    const result = await pool.query(
        `
        INSERT INTO drivers
        (
            telegram_id,
            name,
            car,
            plate,
            phone,
            photo_file_id
        )
        VALUES ($1, $2, $3, $4, $5, $6)

        ON CONFLICT (telegram_id)
        DO UPDATE SET
            name = EXCLUDED.name,
            car = EXCLUDED.car,
            plate = EXCLUDED.plate,
            phone = EXCLUDED.phone,
            photo_file_id = EXCLUDED.photo_file_id,
            updated_at = NOW()

        RETURNING *
        `,
        [
            String(chatId),
            data.name,
            data.car,
            data.plate,
            data.phone,
            data.photo_file_id || null
        ]
    );

    return result.rows[0];
}

async function updateDriverField(
    chatId,
    field,
    value
) {

    const allowed = {
        name: 'name',
        car: 'car',
        plate: 'plate',
        phone: 'phone',
        photo: 'photo_file_id'
    };

    const column = allowed[field];

    if (!column) {
        return null;
    }

    const result = await pool.query(
        `
        UPDATE drivers
        SET ${column} = $1,
            updated_at = NOW()
        WHERE telegram_id = $2
        RETURNING *
        `,
        [
            value,
            String(chatId)
        ]
    );

    return result.rows[0] || null;
}

// =====================================================
// PASSENGER PROFILE
// =====================================================

async function getPassengerProfile(chatId) {

    const result = await pool.query(
        `
        SELECT *
        FROM passengers
        WHERE telegram_id = $1
        `,
        [String(chatId)]
    );

    return result.rows[0] || null;
}

async function savePassengerProfile(
    chatId,
    data
) {

    const result = await pool.query(
        `
        INSERT INTO passengers
        (
            telegram_id,
            name,
            phone,
            comment
        )
        VALUES ($1, $2, $3, $4)

        ON CONFLICT (telegram_id)
        DO UPDATE SET
            name = EXCLUDED.name,
            phone = EXCLUDED.phone,
            comment = EXCLUDED.comment,
            updated_at = NOW()

        RETURNING *
        `,
        [
            String(chatId),
            data.name,
            data.phone,
            data.comment || ''
        ]
    );

    return result.rows[0];
}

async function updatePassengerField(
    chatId,
    field,
    value
) {

    const allowed = {
        name: 'name',
        phone: 'phone',
        comment: 'comment'
    };

    const column = allowed[field];

    if (!column) {
        return null;
    }

    const result = await pool.query(
        `
        UPDATE passengers
        SET ${column} = $1,
            updated_at = NOW()
        WHERE telegram_id = $2
        RETURNING *
        `,
        [
            value,
            String(chatId)
        ]
    );

    return result.rows[0] || null;
}

// =====================================================
// DRIVER PROFILE TEXT
// =====================================================

function driverProfileText(profile) {

    return (
        '👨‍✈️ ПРОФИЛЬ ВОДИТЕЛЯ\n\n' +

        `👤 Имя: ${profile.name || '-'}\n` +
        `🚕 Автомобиль: ${profile.car || '-'}\n` +
        `🔢 Госномер: ${profile.plate || '-'}\n` +
        `📞 Телефон: ${profile.phone || '-'}\n` +
        `⭐ Рейтинг: ${profile.rating || '5.00'}\n\n` +

        'Выберите, что хотите изменить.'
    );
}

// =====================================================
// PASSENGER PROFILE TEXT
// =====================================================

function passengerProfileText(profile) {

    return (
        '👤 МОЯ АНКЕТА\n\n' +

        `👤 Имя: ${profile.name || '-'}\n` +
        `📞 Телефон: ${profile.phone || '-'}\n` +
        `💬 Комментарий: ${profile.comment || '-'}\n\n` +

        'Ваши данные используются для заказа такси.'
    );
}

// =====================================================
// DRIVER KEYBOARD
// =====================================================

function driverProfileKeyboard() {

    return {
        inline_keyboard: [

            [
                {
                    text: '🚕 Автомобиль',
                    callback_data: 'driver_edit:car'
                },
                {
                    text: '🔢 Госномер',
                    callback_data: 'driver_edit:plate'
                }
            ],

            [
                {
                    text: '📞 Телефон',
                    callback_data: 'driver_edit:phone'
                },
                {
                    text: '👤 Имя',
                    callback_data: 'driver_edit:name'
                }
            ],

            [
                {
                    text: '📷 Фото',
                    callback_data: 'driver_edit:photo'
                }
            ]

        ]
    };
}

// =====================================================
// PASSENGER KEYBOARD
// =====================================================

function passengerProfileKeyboard() {

    return {
        inline_keyboard: [

            [
                {
                    text: '👤 Изменить имя',
                    callback_data: 'passenger_edit:name'
                }
            ],

            [
                {
                    text: '📞 Изменить телефон',
                    callback_data: 'passenger_edit:phone'
                }
            ],

            [
                {
                    text: '💬 Изменить комментарий',
                    callback_data: 'passenger_edit:comment'
                }
            ]

        ]
    };
}

// =====================================================
// SHOW DRIVER PROFILE
// =====================================================

async function sendDriverProfile(chatId) {

    const profile =
        await getDriverProfile(chatId);

    if (!profile) {

        await telegram(
            'sendMessage',
            {
                chat_id: chatId,

                text:
                    '❌ Профиль водителя ещё не создан.\n\n' +
                    'Используйте /profile'
            }
        );

        return;
    }

    if (profile.photo_file_id) {

        await telegram(
            'sendPhoto',
            {
                chat_id: chatId,

                photo:
                    profile.photo_file_id,

                caption:
                    driverProfileText(profile),

                reply_markup:
                    driverProfileKeyboard()
            }
        );

    } else {

        await telegram(
            'sendMessage',
            {
                chat_id: chatId,

                text:
                    driverProfileText(profile),

                reply_markup:
                    driverProfileKeyboard()
            }
        );
    }
}

// =====================================================
// SHOW PASSENGER PROFILE
// =====================================================

async function sendPassengerProfile(chatId) {

    const profile =
        await getPassengerProfile(chatId);

    if (!profile) {

        await telegram(
            'sendMessage',
            {
                chat_id: chatId,

                text:
                    '❌ Анкета ещё не заполнена.\n\n' +
                    'Используйте /profile'
            }
        );

        return;
    }

    await telegram(
        'sendMessage',
        {
            chat_id: chatId,

            text:
                passengerProfileText(profile),

            reply_markup:
                passengerProfileKeyboard()
        }
    );
}

// =====================================================
// WEBHOOK
// =====================================================

async function setupTelegramWebhook() {

    if (!TELEGRAM_BOT_TOKEN) {
        return;
    }

    if (!RENDER_URL) {
        return;
    }

    const result =
        await telegram(
            'setWebhook',
            {
                url:
                    `${RENDER_URL}/telegram/webhook`
            }
        );

    console.log(
        'Telegram webhook:',
        result
    );
}

// =====================================================
// TELEGRAM WEBHOOK
// =====================================================

app.post(
    '/telegram/webhook',
    async (req, res) => {

        try {

            const update =
                req.body;

            // =================================================
            // MESSAGE
            // =================================================

            if (update.message) {

                const message =
                    update.message;

                const chatId =
                    message.chat.id;

                const text =
                    message.text || '';

                const driver =
                    isDriver(chatId);

                console.log(
                    'Telegram:',
                    chatId,
                    driver
                        ? 'ВОДИТЕЛЬ'
                        : 'ПАССАЖИР',
                    text
                );

                // =================================================
                // CANCEL
                // =================================================

                if (text === '/cancel') {

                    passengerSessions.delete(
                        String(chatId)
                    );

                    driverSessions.delete(
                        String(chatId)
                    );

                    editSessions.delete(
                        String(chatId)
                    );

                    await telegram(
                        'sendMessage',
                        {
                            chat_id: chatId,

                            text:
                                '❌ Действие отменено.'
                        }
                    );

                    return res.sendStatus(200);
                }

                // =================================================
                // DRIVER PROFILE SESSION
                // =================================================

                if (
                    driver &&
                    driverSessions.has(
                        String(chatId)
                    )
                ) {

                    const session =
                        driverSessions.get(
                            String(chatId)
                        );

                    if (
                        session.step === 'name'
                    ) {

                        session.name =
                            text.trim();

                        session.step =
                            'car';

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '🚕 Введите марку и модель автомобиля.\n\n' +
                                    'Например:\n' +
                                    'Toyota Corolla'
                            }
                        );

                        return res.sendStatus(200);
                    }

                    if (
                        session.step === 'car'
                    ) {

                        session.car =
                            text.trim();

                        session.step =
                            'plate';

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '🔢 Введите госномер.'
                            }
                        );

                        return res.sendStatus(200);
                    }

                    if (
                        session.step === 'plate'
                    ) {

                        session.plate =
                            text.trim();

                        session.step =
                            'phone';

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '📞 Введите номер телефона.'
                            }
                        );

                        return res.sendStatus(200);
                    }

                    if (
                        session.step === 'phone'
                    ) {

                        session.phone =
                            text.trim();

                        session.step =
                            'photo';

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '📷 Отправьте фотографию автомобиля.\n\n' +
                                    'Или напишите /skip'
                            }
                        );

                        return res.sendStatus(200);
                    }

                    if (
                        session.step === 'photo'
                    ) {

                        if (
                            text === '/skip'
                        ) {

                            const profile =
                                await saveDriverProfile(
                                    chatId,
                                    session
                                );

                            driverSessions.delete(
                                String(chatId)
                            );

                            await telegram(
                                'sendMessage',
                                {
                                    chat_id: chatId,

                                    text:
                                        '✅ Профиль водителя сохранён!\n\n' +
                                        driverProfileText(profile),

                                    reply_markup:
                                        driverProfileKeyboard()
                                }
                            );

                            return res.sendStatus(200);
                        }

                        if (
                            message.photo &&
                            message.photo.length
                        ) {

                            const photo =
                                message.photo[
                                    message.photo.length - 1
                                ];

                            session.photo_file_id =
                                photo.file_id;

                            const profile =
                                await saveDriverProfile(
                                    chatId,
                                    session
                                );

                            driverSessions.delete(
                                String(chatId)
                            );

                            await telegram(
                                'sendMessage',
                                {
                                    chat_id: chatId,

                                    text:
                                        '✅ Профиль водителя сохранён!\n\n' +
                                        driverProfileText(profile),

                                    reply_markup:
                                        driverProfileKeyboard()
                                }
                            );

                            return res.sendStatus(200);
                        }

                        return res.sendStatus(200);
                    }
                }

                // =================================================
                // PASSENGER PROFILE SESSION
                // =================================================

                if (
                    !driver &&
                    passengerSessions.has(
                        String(chatId)
                    )
                ) {

                    const session =
                        passengerSessions.get(
                            String(chatId)
                        );

                    if (
                        session.step === 'name'
                    ) {

                        session.name =
                            text.trim();

                        session.step =
                            'phone';

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '📞 Введите ваш номер телефона.'
                            }
                        );

                        return res.sendStatus(200);
                    }

                    if (
                        session.step === 'phone'
                    ) {

                        session.phone =
                            text.trim();

                        session.step =
                            'comment';

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '💬 Есть ли комментарий для водителя?\n\n' +
                                    'Если нет — напишите /skip'
                            }
                        );

                        return res.sendStatus(200);
                    }

                    if (
                        session.step === 'comment'
                    ) {

                        session.comment =
                            text === '/skip'
                                ? ''
                                : text.trim();

                        const profile =
                            await savePassengerProfile(
                                chatId,
                                session
                            );

                        passengerSessions.delete(
                            String(chatId)
                        );

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '✅ Анкета пассажира сохранена!\n\n' +
                                    passengerProfileText(profile),

                                reply_markup:
                                    passengerProfileKeyboard()
                            }
                        );

                        return res.sendStatus(200);
                    }
                }

                // =================================================
                // EDIT SESSION
                // =================================================

                if (
                    editSessions.has(
                        String(chatId)
                    )
                ) {

                    const session =
                        editSessions.get(
                            String(chatId)
                        );

                    // ---------------------------------------------
                    // DRIVER
                    // ---------------------------------------------

                    if (
                        session.role === 'driver'
                    ) {

                        if (
                            session.field === 'photo'
                        ) {

                            if (
                                message.photo &&
                                message.photo.length
                            ) {

                                const photo =
                                    message.photo[
                                        message.photo.length - 1
                                    ];

                                await updateDriverField(
                                    chatId,
                                    'photo',
                                    photo.file_id
                                );

                                editSessions.delete(
                                    String(chatId)
                                );

                                await telegram(
                                    'sendMessage',
                                    {
                                        chat_id: chatId,

                                        text:
                                            '✅ Фото автомобиля изменено.'
                                    }
                                );

                                await sendDriverProfile(
                                    chatId
                                );

                                return res.sendStatus(200);
                            }

                            return res.sendStatus(200);
                        }

                        await updateDriverField(
                            chatId,
                            session.field,
                            text.trim()
                        );

                        editSessions.delete(
                            String(chatId)
                        );

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '✅ Данные водителя изменены.'
                            }
                        );

                        await sendDriverProfile(
                            chatId
                        );

                        return res.sendStatus(200);
                    }

                    // ---------------------------------------------
                    // PASSENGER
                    // ---------------------------------------------

                    if (
                        session.role === 'passenger'
                    ) {

                        await updatePassengerField(
                            chatId,
                            session.field,
                            text.trim()
                        );

                        editSessions.delete(
                            String(chatId)
                        );

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '✅ Данные анкеты изменены.'
                            }
                        );

                        await sendPassengerProfile(
                            chatId
                        );

                        return res.sendStatus(200);
                    }
                }

                // =================================================
                // START
                // =================================================

                if (
                    text === '/start'
                ) {

                    if (driver) {

                        const profile =
                            await getDriverProfile(
                                chatId
                            );

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '🚕 ТАКСИ РЕЧИЦА\n\n' +

                                    '👨‍✈️ Вы зарегистрированы как водитель.\n\n' +

                                    (
                                        profile
                                            ? `👤 ${profile.name}\n🚕 ${profile.car}\n🔢 ${profile.plate}\n\n`
                                            : '⚠️ Профиль ещё не заполнен.\n\n'
                                    ) +

                                    'Выберите действие:\n\n' +

                                    '/driver — режим водителя\n' +
                                    '/profile — анкета водителя\n' +
                                    '/myprofile — мой профиль\n' +
                                    '/editprofile — изменить профиль'
                            }
                        );

                    } else {

                        const profile =
                            await getPassengerProfile(
                                chatId
                            );

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '🚕 ДОБРО ПОЖАЛОВАТЬ В ТАКСИ РЕЧИЦА!\n\n' +

                                    '👤 Вы пассажир.\n\n' +

                                    (
                                        profile
                                            ? `Здравствуйте, ${profile.name}!`
                                            : 'Заполните анкету, чтобы ваши данные были сохранены.'
                                    ) +

                                    '\n\n' +

                                    '/profile — моя анкета\n' +
                                    '/myprofile — мой профиль\n' +
                                    '/myorders — мои заказы\n' +
                                    '/help — помощь'
                            }
                        );
                    }

                    return res.sendStatus(200);
                }

                // =================================================
                // DRIVER
                // =================================================

                if (
                    text === '/driver'
                ) {

                    if (!driver) {

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '❌ Доступ запрещён.\n\n' +
                                    'Этот раздел доступен только зарегистрированным водителям.'
                            }
                        );

                        return res.sendStatus(200);
                    }

                    await telegram(
                        'sendMessage',
                        {
                            chat_id: chatId,

                            text:
                                '👨‍✈️ РЕЖИМ ВОДИТЕЛЯ\n\n' +

                                '🟢 Вы в режиме водителя.\n\n' +

                                '📋 Команды:\n' +
                                '/profile — анкета\n' +
                                '/myprofile — мой профиль\n' +
                                '/editprofile — изменить профиль\n\n' +

                                '🚕 Новые заказы будут приходить сюда.'
                        }
                    );

                    return res.sendStatus(200);
                }

                // =================================================
                // PROFILE
                // =================================================

                if (
                    text === '/profile'
                ) {

                    if (driver) {

                        driverSessions.set(
                            String(chatId),
                            {
                                step: 'name',
                                name: '',
                                car: '',
                                plate: '',
                                phone: '',
                                photo_file_id: null
                            }
                        );

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '👨‍✈️ АНКЕТА ВОДИТЕЛЯ\n\n' +
                                    '👤 Введите ваше имя.\n\n' +
                                    'Для отмены:\n/cancel'
                            }
                        );

                    } else {

                        passengerSessions.set(
                            String(chatId),
                            {
                                step: 'name',
                                name: '',
                                phone: '',
                                comment: ''
                            }
                        );

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '👤 АНКЕТА ПАССАЖИРА\n\n' +
                                    'Введите ваше имя.\n\n' +
                                    'Для отмены:\n/cancel'
                            }
                        );
                    }

                    return res.sendStatus(200);
                }

                // =================================================
                // MY PROFILE
                // =================================================

                if (
                    text === '/myprofile'
                ) {

                    if (driver) {

                        await sendDriverProfile(
                            chatId
                        );

                    } else {

                        await sendPassengerProfile(
                            chatId
                        );
                    }

                    return res.sendStatus(200);
                }

                // =================================================
                // EDIT PROFILE
                // =================================================

                if (
                    text === '/editprofile'
                ) {

                    if (driver) {

                        await sendDriverProfile(
                            chatId
                        );

                    } else {

                        await sendPassengerProfile(
                            chatId
                        );
                    }

                    return res.sendStatus(200);
                }

                // =================================================
                // MY ORDERS
                // =================================================

                if (
                    text === '/myorders'
                ) {

                    if (driver) {

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '👨‍✈️ История заказов водителя будет добавлена следующим этапом.'
                            }
                        );

                    } else {

                        const result =
                            await pool.query(
                                `
                                SELECT *
                                FROM passenger_orders
                                WHERE telegram_id = $1
                                ORDER BY created_at DESC
                                LIMIT 10
                                `,
                                [String(chatId)]
                            );

                        if (
                            result.rows.length === 0
                        ) {

                            await telegram(
                                'sendMessage',
                                {
                                    chat_id: chatId,

                                    text:
                                        '📋 У вас пока нет заказов.'
                                }
                            );

                        } else {

                            let textOrders =
                                '📋 МОИ ПОСЛЕДНИЕ ЗАКАЗЫ\n\n';

                            for (
                                const order
                                of result.rows
                            ) {

                                textOrders +=
                                    `🚕 Заказ #${order.order_id || '-'}\n` +
                                    `📍 ${order.address_from || '-'} → ${order.address_to || '-'}\n` +
                                    `💰 ${order.tariff || '-'}\n` +
                                    `📌 ${order.status || '-'}\n\n`;
                            }

                            await telegram(
                                'sendMessage',
                                {
                                    chat_id: chatId,

                                    text:
                                        textOrders
                                }
                            );
                        }
                    }

                    return res.sendStatus(200);
                }

                // =================================================
                // HELP
                // =================================================

                if (
                    text === '/help'
                ) {

                    if (driver) {

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '❓ ПОМОЩЬ ВОДИТЕЛЮ\n\n' +

                                    '/start — главное меню\n' +
                                    '/driver — режим водителя\n' +
                                    '/profile — анкета водителя\n' +
                                    '/myprofile — мой профиль\n' +
                                    '/editprofile — изменить данные\n' +
                                    '/cancel — отменить действие'
                            }
                        );

                    } else {

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '❓ ПОМОЩЬ ПАССАЖИРУ\n\n' +

                                    '/start — главное меню\n' +
                                    '/profile — анкета\n' +
                                    '/myprofile — мой профиль\n' +
                                    '/myorders — мои заказы\n' +
                                    '/cancel — отменить действие'
                            }
                        );
                    }

                    return res.sendStatus(200);
                }
            }

            // =================================================
            // CALLBACK
            // =================================================

            if (
                update.callback_query
            ) {

                const callback =
                    update.callback_query;

                const data =
                    callback.data;

                const chatId =
                    callback.message.chat.id;

                // =================================================
                // DRIVER EDIT
                // =================================================

                if (
                    data.startsWith(
                        'driver_edit:'
                    )
                ) {

                    if (!isDriver(chatId)) {

                        await telegram(
                            'answerCallbackQuery',
                            {
                                callback_query_id:
                                    callback.id,

                                text:
                                    '❌ Доступ запрещён.'
                            }
                        );

                        return res.sendStatus(200);
                    }

                    const field =
                        data.split(':')[1];

                    editSessions.set(
                        String(chatId),
                        {
                            role: 'driver',
                            field
                        }
                    );

                    const names = {
                        name: '👤 новое имя',
                        car: '🚕 новый автомобиль',
                        plate: '🔢 новый госномер',
                        phone: '📞 новый номер телефона',
                        photo: '📷 новую фотографию автомобиля'
                    };

                    await telegram(
                        'answerCallbackQuery',
                        {
                            callback_query_id:
                                callback.id
                        }
                    );

                    await telegram(
                        'sendMessage',
                        {
                            chat_id: chatId,

                            text:
                                `Введите ${names[field]}.\n\n` +
                                'Для отмены:\n/cancel'
                        }
                    );

                    return res.sendStatus(200);
                }

                // =================================================
                // PASSENGER EDIT
                // =================================================

                if (
                    data.startsWith(
                        'passenger_edit:'
                    )
                ) {

                    if (isDriver(chatId)) {

                        await telegram(
                            'answerCallbackQuery',
                            {
                                callback_query_id:
                                    callback.id,

                                text:
                                    '❌ Эта анкета предназначена для пассажиров.'
                            }
                        );

                        return res.sendStatus(200);
                    }

                    const field =
                        data.split(':')[1];

                    editSessions.set(
                        String(chatId),
                        {
                            role: 'passenger',
                            field
                        }
                    );

                    const names = {
                        name: '👤 новое имя',
                        phone: '📞 новый номер телефона',
                        comment: '💬 новый комментарий'
                    };

                    await telegram(
                        'answerCallbackQuery',
                        {
                            callback_query_id:
                                callback.id
                        }
                    );

                    await telegram(
                        'sendMessage',
                        {
                            chat_id: chatId,

                            text:
                                `Введите ${names[field]}.\n\n` +
                                'Для отмены:\n/cancel'
                        }
                    );

                    return res.sendStatus(200);
                }

                // =================================================
                // ACCEPT ORDER
                // =================================================

                if (
                    data.startsWith(
                        'accept_order:'
                    )
                ) {

                    if (!isDriver(chatId)) {

                        await telegram(
                            'answerCallbackQuery',
                            {
                                callback_query_id:
                                    callback.id,

                                text:
                                    '❌ Только водитель может принять заказ.'
                            }
                        );

                        return res.sendStatus(200);
                    }

                    if (!currentOrder) {

                        await telegram(
                            'answerCallbackQuery',
                            {
                                callback_query_id:
                                    callback.id,

                                text:
                                    'Заказ уже недоступен.'
                            }
                        );

                        return res.sendStatus(200);
                    }

                    if (
                        currentOrder.status !==
                        'searching'
                    ) {

                        await telegram(
                            'answerCallbackQuery',
                            {
                                callback_query_id:
                                    callback.id,

                                text:
                                    'Этот заказ уже принят.'
                            }
                        );

                        return res.sendStatus(200);
                    }

                    const orderId =
                        data.split(':')[1];

                    if (
                        String(currentOrder.id) !==
                        String(orderId)
                    ) {

                        await telegram(
                            'answerCallbackQuery',
                            {
                                callback_query_id:
                                    callback.id,

                                text:
                                    'Этот заказ уже недоступен.'
                            }
                        );

                        return res.sendStatus(200);
                    }

                    const profile =
                        await getDriverProfile(
                            chatId
                        );

                    if (!profile) {

                        await telegram(
                            'answerCallbackQuery',
                            {
                                callback_query_id:
                                    callback.id,

                                text:
                                    'Сначала заполните анкету.'
                            }
                        );

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '⚠️ Нельзя принять заказ без анкеты водителя.\n\n' +
                                    'Используйте /profile'
                            }
                        );

                        return res.sendStatus(200);
                    }

                    currentOrder.status =
                        'accepted';

                    currentOrder.driverChatId =
                        chatId;

                    currentOrder.driverName =
                        profile.name;

                    currentOrder.driverCar =
                        profile.car;

                    currentOrder.driverNumber =
                        profile.plate;

                    currentOrder.driverPhone =
                        profile.phone;

                    currentOrder.driverRating =
                        profile.rating;

                    currentOrder.driverPhoto =
                        profile.photo_file_id;

                    currentOrder.acceptedAt =
                        Date.now();

                    await telegram(
                        'answerCallbackQuery',
                        {
                            callback_query_id:
                                callback.id,

                            text:
                                '✅ Заказ принят!'
                        }
                    );

                    await telegram(
                        'editMessageReplyMarkup',
                        {
                            chat_id: chatId,

                            message_id:
                                callback.message.message_id,

                            reply_markup: {
                                inline_keyboard: []
                            }
                        }
                    );

                    await telegram(
                        'sendMessage',
                        {
                            chat_id: chatId,

                            text:
                                '✅ ЗАКАЗ ПРИНЯТ\n\n' +

                                `🚕 Заказ #${currentOrder.id}\n\n` +

                                `📍 Откуда:\n${currentOrder.addressA || '-'}\n\n` +

                                `📍 Куда:\n${currentOrder.addressB || '-'}\n\n` +

                                `🚕 ${profile.car}\n` +
                                `👤 ${profile.name}\n` +
                                `🔢 ${profile.plate}\n` +
                                `📞 ${profile.phone || '-'}\n\n` +

                                'Пассажир получил данные водителя.'
                        }
                    );

                    // ---------------------------------------------
                    // ПАССАЖИРУ
                    // ---------------------------------------------

                    if (
                        currentOrder.passengerChatId
                    ) {

                        const passengerText =
                            '✅ ВОДИТЕЛЬ ПРИНЯЛ ВАШ ЗАКАЗ\n\n' +

                            `🚕 ${profile.car}\n` +
                            `👤 ${profile.name}\n` +
                            `🔢 ${profile.plate}\n` +
                            `📞 ${profile.phone || '-'}\n` +
                            `⭐ Рейтинг: ${profile.rating || '5.00'}\n\n` +

                            '🚗 Водитель едет к вам.';

                        if (
                            profile.photo_file_id
                        ) {

                            await telegram(
                                'sendPhoto',
                                {
                                    chat_id:
                                        currentOrder.passengerChatId,

                                    photo:
                                        profile.photo_file_id,

                                    caption:
                                        passengerText
                                }
                            );

                        } else {

                            await telegram(
                                'sendMessage',
                                {
                                    chat_id:
                                        currentOrder.passengerChatId,

                                    text:
                                        passengerText
                                }
                            );
                        }
                    }

                    // ---------------------------------------------
                    // ОСТАЛЬНЫМ ВОДИТЕЛЯМ
                    // ---------------------------------------------

                    for (
                        const otherDriverId
                        of DRIVER_CHAT_IDS
                    ) {

                        if (
                            String(otherDriverId) ===
                            String(chatId)
                        ) {
                            continue;
                        }

                        await telegram(
                            'sendMessage',
                            {
                                chat_id:
                                    otherDriverId,

                                text:
                                    'ℹ️ ЗАКАЗ УЖЕ ПРИНЯТ\n\n' +

                                    `Заказ #${currentOrder.id} ` +
                                    'уже забрал другой водитель.'
                            }
                        );
                    }

                    return res.sendStatus(200);
                }

                // =================================================
                // REJECT
                // =================================================

                if (
                    data.startsWith(
                        'reject_order:'
                    )
                ) {

                    if (!isDriver(chatId)) {
                        return res.sendStatus(200);
                    }

                    await telegram(
                        'answerCallbackQuery',
                        {
                            callback_query_id:
                                callback.id,

                            text:
                                'Заказ отклонён'
                        }
                    );

                    await telegram(
                        'editMessageText',
                        {
                            chat_id: chatId,

                            message_id:
                                callback.message.message_id,

                            text:
                                '❌ Вы отклонили заказ.'
                        }
                    );

                    return res.sendStatus(200);
                }
            }

            res.sendStatus(200);

        } catch (error) {

            console.error(
                'Ошибка webhook:',
                error
            );

            res.sendStatus(200);
        }
    }
);

// =====================================================
// СОЗДАНИЕ ЗАКАЗА
// =====================================================

app.post(
    '/api/send-order',
    async (req, res) => {

        try {

            const order =
                req.body || {};

            currentOrder = {
                ...order,

                status:
                    'searching',

                createdAt:
                    Date.now()
            };

            // ---------------------------------------------
            // СОХРАНЯЕМ ЗАКАЗ ПАССАЖИРА
            // ---------------------------------------------

            if (
                currentOrder.passengerChatId
            ) {

                await pool.query(
                    `
                    INSERT INTO passenger_orders
                    (
                        telegram_id,
                        order_id,
                        status,
                        address_from,
                        address_to,
                        tariff
                    )
                    VALUES
                    (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6
                    )
                    `,
                    [
                        String(
                            currentOrder.passengerChatId
                        ),
                        String(
                            currentOrder.id || ''
                        ),
                        'searching',
                        currentOrder.addressA || '',
                        currentOrder.addressB || '',
                        currentOrder.tariff || ''
                    ]
                );
            }

            // ---------------------------------------------
            // ОТПРАВЛЯЕМ ВОДИТЕЛЯМ
            // ---------------------------------------------

            for (
                const driverId
                of DRIVER_CHAT_IDS
            ) {

                await telegram(
                    'sendMessage',
                    {
                        chat_id:
                            driverId,

                        text:
                            '🚕 НОВЫЙ ЗАКАЗ\n\n' +

                            `🔢 Заказ #${currentOrder.id || '-'}\n\n` +

                            `📍 ОТКУДА:\n${currentOrder.addressA || '-'}\n\n` +

                            `📍 КУДА:\n${currentOrder.addressB || '-'}\n\n` +

                            `💰 Тариф: ${currentOrder.tariff || '-'}\n` +

                            `🕐 Время: ${currentOrder.scheduled || 'Сейчас'}\n\n` +

                            (
                                currentOrder.childSeat
                                    ? '👶 Детское кресло\n'
                                    : ''
                            ) +

                            '\nПримите заказ:',

                        reply_markup: {

                            inline_keyboard: [

                                [
                                    {
                                        text:
                                            '✅ ПРИНЯТЬ ЗАКАЗ',

                                        callback_data:
                                            `accept_order:${currentOrder.id}`
                                    }
                                ],

                                [
                                    {
                                        text:
                                            '❌ ОТКЛОНИТЬ',

                                        callback_data:
                                            `reject_order:${currentOrder.id}`
                                    }
                                ]

                            ]
                        }
                    }
                );
            }

            res.json(
                {
                    success:
                        true,

                    order:
                        currentOrder
                }
            );

        } catch (error) {

            console.error(
                'Ошибка создания заказа:',
                error
            );

            res.status(500).json(
                {
                    success:
                        false,

                    error:
                        'Ошибка создания заказа'
                }
            );
        }
    }
);

// =====================================================
// GET ORDER
// =====================================================

app.get(
    '/api/get-order',
    (req, res) => {

        res.json(
            currentOrder || {
                status:
                    'none'
            }
        );
    }
);

// =====================================================
// ORDER STATUS
// =====================================================

app.get(
    '/api/order-status',
    (req, res) => {

        res.json(
            currentOrder || {
                status:
                    'none'
            }
        );
    }
);

// =====================================================
// ACCEPT ORDER API
// =====================================================

app.post(
    '/api/accept-order',
    async (req, res) => {

        try {

            if (!currentOrder) {

                return res.status(404).json(
                    {
                        success:
                            false,

                        error:
                            'Активный заказ не найден'
                    }
                );
            }

            if (
                currentOrder.status !==
                'searching'
            ) {

                return res.status(400).json(
                    {
                        success:
                            false,

                        error:
                            'Заказ уже принят'
                    }
                );
            }

            const driverChatId =
                req.body.driverChatId;

            if (
                !driverChatId ||
                !isDriver(driverChatId)
            ) {

                return res.status(403).json(
                    {
                        success:
                            false,

                        error:
                            'Доступ водителя запрещён'
                    }
                );
            }

            const profile =
                await getDriverProfile(
                    driverChatId
                );

            if (!profile) {

                return res.status(400).json(
                    {
                        success:
                            false,

                        error:
                            'Профиль водителя не заполнен'
                    }
                );
            }

            currentOrder.status =
                'accepted';

            currentOrder.driverChatId =
                driverChatId;

            currentOrder.driverName =
                profile.name;

            currentOrder.driverCar =
                profile.car;

            currentOrder.driverNumber =
                profile.plate;

            currentOrder.driverPhone =
                profile.phone;

            currentOrder.driverRating =
                profile.rating;

            currentOrder.driverPhoto =
                profile.photo_file_id;

            currentOrder.acceptedAt =
                Date.now();

            if (
                currentOrder.passengerChatId
            ) {

                const passengerText =
                    '✅ ВОДИТЕЛЬ ПРИНЯЛ ВАШ ЗАКАЗ\n\n' +

                    `🚕 ${profile.car}\n` +
                    `👤 ${profile.name}\n` +
                    `🔢 ${profile.plate}\n` +
                    `📞 ${profile.phone || '-'}\n` +
                    `⭐ Рейтинг: ${profile.rating || '5.00'}\n\n` +

                    '🚗 Водитель едет к вам.';

                if (
                    profile.photo_file_id
                ) {

                    await telegram(
                        'sendPhoto',
                        {
                            chat_id:
                                currentOrder.passengerChatId,

                            photo:
                                profile.photo_file_id,

                            caption:
                                passengerText
                        }
                    );

                } else {

                    await telegram(
                        'sendMessage',
                        {
                            chat_id:
                                currentOrder.passengerChatId,

                            text:
                                passengerText
                        }
                    );
                }
            }

            res.json(
                {
                    success:
                        true,

                    order:
                        currentOrder
                }
            );

        } catch (error) {

            console.error(
                'Ошибка accept-order:',
                error
            );

            res.status(500).json(
                {
                    success:
                        false,

                    error:
                        'Ошибка принятия заказа'
                }
            );
        }
    }
);

// =====================================================
// DRIVER ARRIVED
// =====================================================

app.post(
    '/api/driver-arrived',
    (req, res) => {

        if (!currentOrder) {

            return res.status(404).json(
                {
                    success:
                        false,

                    error:
                        'Активный заказ не найден'
                }
            );
        }

        currentOrder.status =
            'arrived';

        currentOrder.arrivedAt =
            Date.now();

        res.json(
            {
                success:
                    true,

                order:
                    currentOrder
            }
        );
    }
);

// =====================================================
// START TRIP
// =====================================================

app.post(
    '/api/start-trip',
    (req, res) => {

        if (!currentOrder) {

            return res.status(404).json(
                {
                    success:
                        false,

                    error:
                        'Активный заказ не найден'
                }
            );
        }

        currentOrder.status =
            'trip';

        currentOrder.tripStartedAt =
            Date.now();

        res.json(
            {
                success:
                    true,

                order:
                    currentOrder
            }
        );
    }
);

// =====================================================
// COMPLETE ORDER
// =====================================================

app.post(
    '/api/complete-order',
    async (req, res) => {

        if (!currentOrder) {

            return res.status(404).json(
                {
                    success:
                        false,

                    error:
                        'Активный заказ не найден'
                }
            );
        }

        currentOrder.status =
            'completed';

        currentOrder.completedAt =
            Date.now();

        if (
            currentOrder.passengerChatId
        ) {

            await pool.query(
                `
                UPDATE passenger_orders
                SET status = $1
                WHERE telegram_id = $2
                AND order_id = $3
                `,
                [
                    'completed',
                    String(
                        currentOrder.passengerChatId
                    ),
                    String(
                        currentOrder.id || ''
                    )
                ]
            );
        }

        res.json(
            {
                success:
                    true,

                order:
                    currentOrder
            }
        );
    }
);

// =====================================================
// DRIVER PROFILE API
// =====================================================

app.get(
    '/api/driver-profile',
    async (req, res) => {

        try {

            const chatId =
                req.query.chatId;

            if (
                !chatId ||
                !isDriver(chatId)
            ) {

                return res.status(403).json(
                    {
                        success:
                            false,

                        error:
                            'Доступ запрещён'
                    }
                );
            }

            const profile =
                await getDriverProfile(
                    chatId
                );

            res.json(
                {
                    success:
                        true,

                    profile
                }
            );

        } catch (error) {

            console.error(error);

            res.status(500).json(
                {
                    success:
                        false,

                    error:
                        'Ошибка сервера'
                }
            );
        }
    }
);

// =====================================================
// MAIN
// =====================================================

app.get(
    '/',
    (req, res) => {

        res.sendFile(
            __dirname +
            '/public/index.html'
        );
    }
);

// =====================================================
// START SERVER
// =====================================================

const PORT =
    process.env.PORT || 3000;

app.listen(
    PORT,
    async () => {

        console.log(
            '================================='
        );

        console.log(
            `🚕 Такси Речица запущено: ${PORT}`
        );

        console.log(
            `👨‍✈️ Водителей: ${DRIVER_CHAT_IDS.length}`
        );

        console.log(
            '================================='
        );

        await initDatabase();

        await setupTelegramWebhook();

        await setTelegramCommands();

        await setDriverCommands();

        console.log(
            '✅ Система готова'
        );
    }
);
