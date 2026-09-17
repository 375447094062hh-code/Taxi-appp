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
// POSTGRESQL
// =====================================================

let pool = null;

if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    });

    pool.on('error', (error) => {
        console.error('PostgreSQL error:', error);
    });
} else {
    console.log('⚠️ DATABASE_URL не найден');
}

// =====================================================
// СПИСОК ВОДИТЕЛЕЙ
// =====================================================

const DRIVER_CHAT_IDS = (process.env.DRIVER_CHAT_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

// =====================================================
// СЕССИИ ЗАПОЛНЕНИЯ ПРОФИЛЯ
// =====================================================

const profileSessions = new Map();
const profileEditSessions = new Map();

// =====================================================
// ПРОВЕРКА ВОДИТЕЛЯ
// =====================================================

function isDriver(chatId) {
    return DRIVER_CHAT_IDS.includes(String(chatId));
}

// =====================================================
// POSTGRESQL: СОЗДАНИЕ ТАБЛИЦЫ
// =====================================================

async function initDatabase() {
    if (!pool) {
        console.log('⚠️ PostgreSQL не подключён');
        return;
    }

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

        console.log('✅ Таблица drivers готова');
    } catch (error) {
        console.error('❌ Ошибка создания таблицы drivers:', error);
    }
}

// =====================================================
// ПОЛУЧИТЬ ПРОФИЛЬ ВОДИТЕЛЯ
// =====================================================

async function getDriverProfile(chatId) {
    if (!pool) {
        return null;
    }

    try {
        const result = await pool.query(
            `
            SELECT *
            FROM drivers
            WHERE telegram_id = $1
            `,
            [String(chatId)]
        );

        return result.rows[0] || null;

    } catch (error) {
        console.error('Ошибка получения профиля:', error);
        return null;
    }
}

// =====================================================
// СОХРАНИТЬ ПОЛНЫЙ ПРОФИЛЬ
// =====================================================

async function saveDriverProfile(chatId, data) {
    if (!pool) {
        return null;
    }

    try {
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
                updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, NOW())

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

    } catch (error) {
        console.error('Ошибка сохранения профиля:', error);
        return null;
    }
}

// =====================================================
// ИЗМЕНИТЬ ОДНО ПОЛЕ
// =====================================================

async function updateDriverField(chatId, field, value) {
    if (!pool) {
        return null;
    }

    const allowedFields = {
        name: 'name',
        car: 'car',
        plate: 'plate',
        phone: 'phone',
        photo: 'photo_file_id'
    };

    const column = allowedFields[field];

    if (!column) {
        return null;
    }

    try {
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

    } catch (error) {
        console.error('Ошибка изменения профиля:', error);
        return null;
    }
}

// =====================================================
// ТЕКСТ ПРОФИЛЯ
// =====================================================

function profileText(profile) {
    if (!profile) {
        return '❌ Профиль водителя ещё не создан.';
    }

    return (
        '👤 МОЙ ПРОФИЛЬ\n\n' +

        `👤 Имя: ${profile.name || '-'}\n` +

        `🚕 Автомобиль: ${profile.car || '-'}\n` +

        `🔢 Госномер: ${profile.plate || '-'}\n` +

        `📞 Телефон: ${profile.phone || '-'}\n` +

        `⭐ Рейтинг: ${profile.rating || '5.00'}\n\n` +

        'Здесь можно изменить данные водителя.'
    );
}

// =====================================================
// КНОПКИ ПРОФИЛЯ
// =====================================================

function profileKeyboard() {
    return {
        inline_keyboard: [
            [
                {
                    text: '🚕 Изменить автомобиль',
                    callback_data: 'profile_edit:car'
                },
                {
                    text: '🔢 Изменить госномер',
                    callback_data: 'profile_edit:plate'
                }
            ],

            [
                {
                    text: '📞 Изменить телефон',
                    callback_data: 'profile_edit:phone'
                },
                {
                    text: '👤 Изменить имя',
                    callback_data: 'profile_edit:name'
                }
            ],

            [
                {
                    text: '📷 Изменить фото',
                    callback_data: 'profile_edit:photo'
                }
            ]
        ]
    };
}

// =====================================================
// ПОКАЗАТЬ ПРОФИЛЬ
// =====================================================

async function sendDriverProfile(chatId) {
    const profile = await getDriverProfile(chatId);

    if (!profile) {
        await telegram(
            'sendMessage',
            {
                chat_id: chatId,

                text:
                    '❌ Профиль водителя ещё не создан.\n\n' +
                    'Для создания профиля используйте:\n' +
                    '/profile'
            }
        );

        return;
    }

    if (profile.photo_file_id) {
        await telegram(
            'sendPhoto',
            {
                chat_id: chatId,

                photo: profile.photo_file_id,

                caption: profileText(profile),

                reply_markup: profileKeyboard()
            }
        );

    } else {
        await telegram(
            'sendMessage',
            {
                chat_id: chatId,

                text: profileText(profile),

                reply_markup: profileKeyboard()
            }
        );
    }
}

// =====================================================
// TELEGRAM API
// =====================================================

async function telegram(method, data) {
    if (!TELEGRAM_BOT_TOKEN) {
        console.error(
            'TELEGRAM_BOT_TOKEN не найден в Render'
        );

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
            console.error(
                'Ошибка Telegram:',
                result
            );
        }

        return result;

    } catch (error) {
        console.error(
            'Ошибка соединения с Telegram:',
            error
        );

        return null;
    }
}

// =====================================================
// WEBHOOK
// =====================================================

async function setupTelegramWebhook() {
    if (!TELEGRAM_BOT_TOKEN) {
        console.log(
            'Telegram token не установлен'
        );

        return;
    }

    if (!RENDER_URL) {
        console.log(
            'RENDER_EXTERNAL_URL пока недоступен'
        );

        return;
    }

    const webhookUrl =
        `${RENDER_URL}/telegram/webhook`;

    const result =
        await telegram(
            'setWebhook',
            {
                url: webhookUrl
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

            const update = req.body;

            // =================================================
            // НОВОЕ СООБЩЕНИЕ
            // =================================================

            if (update.message) {

                const message =
                    update.message;

                const chatId =
                    message.chat.id;

                const text =
                    message.text || '';

                console.log(
                    'Telegram сообщение:',
                    chatId,
                    text
                );

                // =================================================
                // ПРОВЕРКА ПРОФИЛЯ ВОДИТЕЛЯ
                // =================================================

                if (isDriver(chatId)) {

                    // =================================================
                    // СОЗДАНИЕ / ПОЛНОЕ ИЗМЕНЕНИЕ ПРОФИЛЯ
                    // =================================================

                    if (profileSessions.has(String(chatId))) {

                        const session =
                            profileSessions.get(String(chatId));

                        // -----------------------------------------
                        // ИМЯ
                        // -----------------------------------------

                        if (session.step === 'name') {

                            if (!text || text.length < 2) {

                                await telegram(
                                    'sendMessage',
                                    {
                                        chat_id: chatId,
                                        text:
                                            '❌ Введите нормальное имя.'
                                    }
                                );

                                return res.sendStatus(200);
                            }

                            session.name =
                                text.trim();

                            session.step =
                                'car';

                            await telegram(
                                'sendMessage',
                                {
                                    chat_id: chatId,

                                    text:
                                        '🚕 Напишите марку и модель автомобиля.\n\n' +
                                        'Например:\n' +
                                        'Toyota Corolla'
                                }
                            );

                            return res.sendStatus(200);
                        }

                        // -----------------------------------------
                        // АВТОМОБИЛЬ
                        // -----------------------------------------

                        if (session.step === 'car') {

                            if (!text) {

                                await telegram(
                                    'sendMessage',
                                    {
                                        chat_id: chatId,
                                        text:
                                            '❌ Напишите автомобиль.'
                                    }
                                );

                                return res.sendStatus(200);
                            }

                            session.car =
                                text.trim();

                            session.step =
                                'plate';

                            await telegram(
                                'sendMessage',
                                {
                                    chat_id: chatId,

                                    text:
                                        '🔢 Напишите госномер автомобиля.\n\n' +
                                        'Например:\n' +
                                        '1234 AB-7'
                                }
                            );

                            return res.sendStatus(200);
                        }

                        // -----------------------------------------
                        // ГОСНОМЕР
                        // -----------------------------------------

                        if (session.step === 'plate') {

                            if (!text) {

                                await telegram(
                                    'sendMessage',
                                    {
                                        chat_id: chatId,
                                        text:
                                            '❌ Напишите госномер.'
                                    }
                                );

                                return res.sendStatus(200);
                            }

                            session.plate =
                                text.trim();

                            session.step =
                                'phone';

                            await telegram(
                                'sendMessage',
                                {
                                    chat_id: chatId,

                                    text:
                                        '📞 Напишите номер телефона водителя.\n\n' +
                                        'Например:\n' +
                                        '+375 29 123-45-67'
                                }
                            );

                            return res.sendStatus(200);
                        }

                        // -----------------------------------------
                        // ТЕЛЕФОН
                        // -----------------------------------------

                        if (session.step === 'phone') {

                            if (!text) {

                                await telegram(
                                    'sendMessage',
                                    {
                                        chat_id: chatId,
                                        text:
                                            '❌ Напишите номер телефона.'
                                    }
                                );

                                return res.sendStatus(200);
                            }

                            session.phone =
                                text.trim();

                            session.step =
                                'photo';

                            await telegram(
                                'sendMessage',
                                {
                                    chat_id: chatId,

                                    text:
                                        '📷 Теперь отправьте фотографию автомобиля.\n\n' +
                                        'Если фотографию добавлять не хотите, напишите:\n' +
                                        '/skip'
                                }
                            );

                            return res.sendStatus(200);
                        }

                        // -----------------------------------------
                        // ФОТО
                        // -----------------------------------------

                        if (session.step === 'photo') {

                            if (text === '/skip') {

                                const saved =
                                    await saveDriverProfile(
                                        chatId,
                                        session
                                    );

                                profileSessions.delete(
                                    String(chatId)
                                );

                                if (!saved) {

                                    await telegram(
                                        'sendMessage',
                                        {
                                            chat_id: chatId,

                                            text:
                                                '❌ Не удалось сохранить профиль.'
                                        }
                                    );

                                    return res.sendStatus(200);
                                }

                                await telegram(
                                    'sendMessage',
                                    {
                                        chat_id: chatId,

                                        text:
                                            '✅ Профиль водителя сохранён!\n\n' +
                                            profileText(saved),

                                        reply_markup:
                                            profileKeyboard()
                                    }
                                );

                                return res.sendStatus(200);
                            }

                            if (
                                message.photo &&
                                message.photo.length > 0
                            ) {

                                const photo =
                                    message.photo[
                                        message.photo.length - 1
                                    ];

                                session.photo_file_id =
                                    photo.file_id;

                                const saved =
                                    await saveDriverProfile(
                                        chatId,
                                        session
                                    );

                                profileSessions.delete(
                                    String(chatId)
                                );

                                if (!saved) {

                                    await telegram(
                                        'sendMessage',
                                        {
                                            chat_id: chatId,

                                            text:
                                                '❌ Не удалось сохранить профиль.'
                                        }
                                    );

                                    return res.sendStatus(200);
                                }

                                await telegram(
                                    'sendMessage',
                                    {
                                        chat_id: chatId,

                                        text:
                                            '✅ Профиль водителя сохранён!\n\n' +
                                            profileText(saved),

                                        reply_markup:
                                            profileKeyboard()
                                    }
                                );

                                return res.sendStatus(200);
                            }

                            await telegram(
                                'sendMessage',
                                {
                                    chat_id: chatId,

                                    text:
                                        '📷 Пожалуйста, отправьте фотографию автомобиля или напишите /skip.'
                                }
                            );

                            return res.sendStatus(200);
                        }
                    }

                    // =================================================
                    // ИЗМЕНЕНИЕ ОДНОГО ПОЛЯ
                    // =================================================

                    if (profileEditSessions.has(String(chatId))) {

                        const field =
                            profileEditSessions.get(
                                String(chatId)
                            );

                        // -----------------------------------------
                        // ИЗМЕНЕНИЕ ФОТО
                        // -----------------------------------------

                        if (field === 'photo') {

                            if (
                                message.photo &&
                                message.photo.length > 0
                            ) {

                                const photo =
                                    message.photo[
                                        message.photo.length - 1
                                    ];

                                const saved =
                                    await updateDriverField(
                                        chatId,
                                        'photo',
                                        photo.file_id
                                    );

                                profileEditSessions.delete(
                                    String(chatId)
                                );

                                if (!saved) {

                                    await telegram(
                                        'sendMessage',
                                        {
                                            chat_id: chatId,

                                            text:
                                                '❌ Не удалось изменить фото.'
                                        }
                                    );

                                    return res.sendStatus(200);
                                }

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

                            await telegram(
                                'sendMessage',
                                {
                                    chat_id: chatId,

                                    text:
                                        '📷 Отправьте фотографию автомобиля.'
                                }
                            );

                            return res.sendStatus(200);
                        }

                        // -----------------------------------------
                        // ТЕКСТОВОЕ ПОЛЕ
                        // -----------------------------------------

                        if (!text) {

                            await telegram(
                                'sendMessage',
                                {
                                    chat_id: chatId,

                                    text:
                                        '❌ Введите значение текстом.'
                                }
                            );

                            return res.sendStatus(200);
                        }

                        let fieldName =
                            field;

                        const saved =
                            await updateDriverField(
                                chatId,
                                fieldName,
                                text.trim()
                            );

                        profileEditSessions.delete(
                            String(chatId)
                        );

                        if (!saved) {

                            await telegram(
                                'sendMessage',
                                {
                                    chat_id: chatId,

                                    text:
                                        '❌ Не удалось изменить данные.'
                                }
                            );

                            return res.sendStatus(200);
                        }

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '✅ Данные успешно изменены.'
                            }
                        );

                        await sendDriverProfile(
                            chatId
                        );

                        return res.sendStatus(200);
                    }
                }

                // =================================================
                // /CANCEL
                // =================================================

                if (text === '/cancel') {

                    profileSessions.delete(
                        String(chatId)
                    );

                    profileEditSessions.delete(
                        String(chatId)
                    );

                    await telegram(
                        'sendMessage',
                        {
                            chat_id: chatId,

                            text:
                                '❌ Изменение отменено.'
                        }
                    );

                    return res.sendStatus(200);
                }

                // =================================================
                // /PROFILE
                // =================================================

                if (text === '/profile') {

                    if (!isDriver(chatId)) {

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '❌ Доступ водителя запрещён.'
                            }
                        );

                        return res.sendStatus(200);
                    }

                    profileEditSessions.delete(
                        String(chatId)
                    );

                    profileSessions.set(
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
                                '👤 СОЗДАНИЕ ПРОФИЛЯ ВОДИТЕЛЯ\n\n' +

                                'Сейчас мы заполним профиль.\n\n' +

                                'Сначала напишите ваше имя.\n\n' +

                                'Например:\n' +
                                'Александр Иванов\n\n' +

                                'Для отмены:\n' +
                                '/cancel'
                        }
                    );

                    return res.sendStatus(200);
                }

                // =================================================
                // /MYPROFILE
                // =================================================

                if (text === '/myprofile') {

                    if (!isDriver(chatId)) {

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '❌ Доступ водителя запрещён.'
                            }
                        );

                        return res.sendStatus(200);
                    }

                    await sendDriverProfile(
                        chatId
                    );

                    return res.sendStatus(200);
                }

                // =================================================
                // /DRIVER
                // =================================================

                if (text === '/driver') {

                    if (!isDriver(chatId)) {

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '❌ Доступ водителя запрещён.\n\n' +
                                    'Этот аккаунт не зарегистрирован как водитель.'
                            }
                        );

                        console.log(
                            'Попытка получить доступ водителя:',
                            chatId
                        );

                        return res.sendStatus(200);
                    }

                    const profile =
                        await getDriverProfile(
                            chatId
                        );

                    let driverText =
                        '✅ ДОСТУП ВОДИТЕЛЯ ПОДТВЕРЖДЁН\n\n' +

                        '🚕 Вы зарегистрированы как водитель.\n\n';

                    if (profile) {

                        driverText +=
                            `👤 ${profile.name}\n` +
                            `🚕 ${profile.car}\n` +
                            `🔢 ${profile.plate}\n` +
                            `📞 ${profile.phone}\n\n`;
                    } else {

                        driverText +=
                            '⚠️ Профиль ещё не заполнен.\n\n' +
                            'Используйте /profile\n\n';
                    }

                    driverText +=
                        'Новые заказы будут приходить сюда.\n\n' +
                        '🟢 Ожидаем новые заказы...';

                    await telegram(
                        'sendMessage',
                        {
                            chat_id: chatId,

                            text: driverText,

                            reply_markup:
                                profile
                                    ? profileKeyboard()
                                    : undefined
                        }
                    );

                    return res.sendStatus(200);
                }

                // =================================================
                // /START
                // =================================================

                if (text === '/start') {

                    if (isDriver(chatId)) {

                        const profile =
                            await getDriverProfile(
                                chatId
                            );

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '🚕 Такси Речица\n\n' +

                                    '👨‍✈️ Ваш аккаунт зарегистрирован как водитель.\n\n' +

                                    (
                                        profile
                                            ? `👤 ${profile.name}\n🚕 ${profile.car}\n🔢 ${profile.plate}\n\n`
                                            : '⚠️ Профиль ещё не заполнен.\n\n'
                                    ) +

                                    '📋 Команды:\n' +
                                    '/driver — режим водителя\n' +
                                    '/profile — заполнить профиль\n' +
                                    '/myprofile — мой профиль'
                            }
                        );

                    } else {

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '🚕 Добро пожаловать в Такси Речица!\n\n' +
                                    'Используйте приложение для заказа такси.'
                            }
                        );
                    }

                    return res.sendStatus(200);
                }
            }

            // =====================================================
            // INLINE-КНОПКИ
            // =====================================================

            if (update.callback_query) {

                const callback =
                    update.callback_query;

                const callbackData =
                    callback.data;

                const chatId =
                    callback.message.chat.id;

                console.log(
                    'Нажата кнопка:',
                    callbackData,
                    'водитель:',
                    chatId
                );

                // =================================================
                // ПРОВЕРКА ВОДИТЕЛЯ
                // =================================================

                if (!isDriver(chatId)) {

                    await telegram(
                        'answerCallbackQuery',
                        {
                            callback_query_id:
                                callback.id,

                            text:
                                '❌ У вас нет доступа водителя.'
                        }
                    );

                    return res.sendStatus(200);
                }

                // =================================================
                // РЕДАКТИРОВАНИЕ ПРОФИЛЯ
                // =================================================

                if (
                    callbackData.startsWith(
                        'profile_edit:'
                    )
                ) {

                    const field =
                        callbackData.split(':')[1];

                    const fieldNames = {
                        name: '👤 имя',
                        car: '🚕 автомобиль',
                        plate: '🔢 госномер',
                        phone: '📞 номер телефона',
                        photo: '📷 фотографию автомобиля'
                    };

                    profileEditSessions.set(
                        String(chatId),
                        field
                    );

                    await telegram(
                        'answerCallbackQuery',
                        {
                            callback_query_id:
                                callback.id,

                            text:
                                'Готово'
                        }
                    );

                    let instruction = '';

                    if (field === 'name') {

                        instruction =
                            '👤 Напишите новое имя.\n\n' +
                            'Например:\n' +
                            'Александр Иванов';

                    } else if (field === 'car') {

                        instruction =
                            '🚕 Напишите новый автомобиль.\n\n' +
                            'Например:\n' +
                            'Toyota Corolla';

                    } else if (field === 'plate') {

                        instruction =
                            '🔢 Напишите новый госномер.\n\n' +
                            'Например:\n' +
                            '1234 AB-7';

                    } else if (field === 'phone') {

                        instruction =
                            '📞 Напишите новый номер телефона.\n\n' +
                            'Например:\n' +
                            '+375 29 123-45-67';

                    } else if (field === 'photo') {

                        instruction =
                            '📷 Отправьте новую фотографию автомобиля.';
                    }

                    instruction +=
                        '\n\nДля отмены:\n/cancel';

                    await telegram(
                        'sendMessage',
                        {
                            chat_id: chatId,

                            text: instruction
                        }
                    );

                    return res.sendStatus(200);
                }

                // =================================================
                // ПРИНЯТЬ ЗАКАЗ
                // =================================================

                if (
                    callbackData.startsWith(
                        'accept_order:'
                    )
                ) {

                    if (!currentOrder) {

                        await telegram(
                            'answerCallbackQuery',
                            {
                                callback_query_id:
                                    callback.id,

                                text:
                                    'Заказ уже недоступен'
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
                                    'Этот заказ уже принят'
                            }
                        );

                        return res.sendStatus(200);
                    }

                    const orderId =
                        callbackData.split(':')[1];

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
                                    'Этот заказ уже недоступен'
                            }
                        );

                        return res.sendStatus(200);
                    }

                    // =================================================
                    // ПОЛУЧАЕМ ПРОФИЛЬ ВОДИТЕЛЯ
                    // =================================================

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
                                    'Сначала заполните профиль: /profile'
                            }
                        );

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '⚠️ Нельзя принять заказ без профиля.\n\n' +
                                    'Сначала заполните профиль водителя:\n' +
                                    '/profile'
                            }
                        );

                        return res.sendStatus(200);
                    }

                    // =================================================
                    // ЗАКАЗ ПРИНЯТ
                    // =================================================

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

                    console.log(
                        '================================='
                    );

                    console.log(
                        'ВОДИТЕЛЬ ПРИНЯЛ ЗАКАЗ:',
                        chatId
                    );

                    console.log(
                        currentOrder
                    );

                    console.log(
                        '================================='
                    );

                    // =================================================
                    // УБИРАЕМ КНОПКИ
                    // =================================================

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

                    // =================================================
                    // ОТВЕТ НА КНОПКУ
                    // =================================================

                    await telegram(
                        'answerCallbackQuery',
                        {
                            callback_query_id:
                                callback.id,

                            text:
                                '✅ Заказ принят!'
                        }
                    );

                    // =================================================
                    // ВОДИТЕЛЮ
                    // =================================================

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

                                'Пассажир получил уведомление.'
                        }
                    );

                    // =================================================
                    // ПАССАЖИРУ
                    // =================================================

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

                        if (profile.photo_file_id) {

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

                    // =================================================
                    // ОСТАЛЬНЫМ ВОДИТЕЛЯМ
                    // =================================================

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
                // ОТКЛОНИТЬ ЗАКАЗ
                // =================================================

                if (
                    callbackData.startsWith(
                        'reject_order:'
                    )
                ) {

                    if (!currentOrder) {

                        await telegram(
                            'answerCallbackQuery',
                            {
                                callback_query_id:
                                    callback.id,

                                text:
                                    'Заказ уже недоступен'
                            }
                        );

                        return res.sendStatus(200);
                    }

                    const orderId =
                        callbackData.split(':')[1];

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
                                    'Этот заказ уже недоступен'
                            }
                        );

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
                'Ошибка Telegram webhook:',
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

            console.log(
                '================================='
            );

            console.log(
                'НОВЫЙ ЗАКАЗ'
            );

            console.log(
                currentOrder
            );

            console.log(
                '================================='
            );

            // =================================================
            // ОТПРАВЛЯЕМ ВСЕМ ВОДИТЕЛЯМ
            // =================================================

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

                            `🔢 Заказ #${currentOrder.id}\n\n` +

                            `📍 ОТКУДА:\n${currentOrder.addressA || '-'}\n\n` +

                            `📍 КУДА:\n${currentOrder.addressB || '-'}\n\n` +

                            `💰 Тариф: ${currentOrder.tariff || '-'}\n` +

                            `🕐 Время: ${currentOrder.scheduled || 'Сейчас'}\n\n` +

                            (
                                currentOrder.childSeat
                                    ? '👶 Детское кресло\n'
                                    : ''
                            ) +

                            (
                                currentOrder.isWeekend
                                    ? '📅 Выходной день\n'
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

                console.log(
                    'Заказ отправлен водителю:',
                    driverId
                );
            }

            if (
                DRIVER_CHAT_IDS.length === 0
            ) {

                console.log(
                    '⚠️ Нет разрешённых водителей.'
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
// ПОЛУЧИТЬ ТЕКУЩИЙ ЗАКАЗ
// =====================================================

app.get(
    '/api/get-order',
    (req, res) => {

        if (!currentOrder) {

            return res.json(
                {
                    status:
                        'none'
                }
            );
        }

        res.json(
            currentOrder
        );
    }
);

// =====================================================
// СТАТУС ЗАКАЗА
// =====================================================

app.get(
    '/api/order-status',
    (req, res) => {

        if (!currentOrder) {

            return res.json(
                {
                    status:
                        'none'
                }
            );
        }

        res.json(
            currentOrder
        );
    }
);

// =====================================================
// ПРЯМОЕ ПРИНЯТИЕ ЗАКАЗА ИЗ MINI APP
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
                            'Этот заказ уже принят'
                    }
                );
            }

            const driverChatId =
                req.body.driverChatId;

            let profile = null;

            if (
                driverChatId &&
                isDriver(driverChatId)
            ) {

                profile =
                    await getDriverProfile(
                        driverChatId
                    );
            }

            if (!profile) {

                return res.status(400).json(
                    {
                        success:
                            false,

                        error:
                            'Профиль водителя не найден'
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

                if (profile.photo_file_id) {

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
                'Ошибка принятия заказа:',
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
// ВОДИТЕЛЬ ПРИЕХАЛ
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
// НАЧАЛО ПОЕЗДКИ
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
// ЗАВЕРШЕНИЕ
// =====================================================

app.post(
    '/api/complete-order',
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
            'completed';

        currentOrder.completedAt =
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
// ПОЛУЧИТЬ ПРОФИЛЬ ВОДИТЕЛЯ ЧЕРЕЗ API
// =====================================================

app.get(
    '/api/driver-profile',
    async (req, res) => {

        try {

            const chatId =
                req.query.chatId;

            if (!chatId) {

                return res.status(400).json(
                    {
                        success:
                            false,

                        error:
                            'chatId обязателен'
                    }
                );
            }

            if (!isDriver(chatId)) {

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

                    profile:
                        profile
                }
            );

        } catch (error) {

            console.error(
                'Ошибка API профиля:',
                error
            );

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
// ГЛАВНАЯ
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
// ЗАПУСК
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
            `Такси Речица запущено на порту ${PORT}`
        );

        console.log(
            `Разрешённых водителей: ${DRIVER_CHAT_IDS.length}`
        );

        console.log(
            '================================='
        );

        await initDatabase();

        await setupTelegramWebhook();
    }
);
