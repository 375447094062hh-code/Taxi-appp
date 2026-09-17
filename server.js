const express = require('express');

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
// СПИСОК РАЗРЕШЁННЫХ ВОДИТЕЛЕЙ
// =====================================================
//
// В Render создаём переменную:
//
// DRIVER_CHAT_IDS
//
// Например:
//
// 123456789,222222222,333333333
//
// Можно добавить 20, 50 и больше водителей.
//

const DRIVER_CHAT_IDS = (process.env.DRIVER_CHAT_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);


// =====================================================
// ПРОВЕРКА: ЯВЛЯЕТСЯ ЛИ ПОЛЬЗОВАТЕЛЬ РАЗРЕШЁННЫМ ВОДИТЕЛЕМ
// =====================================================

function isDriver(chatId) {
    return DRIVER_CHAT_IDS.includes(String(chatId));
}


// =====================================================
// ОТПРАВКА ЗАПРОСА В TELEGRAM
// =====================================================

async function telegram(method, data) {

    if (!TELEGRAM_BOT_TOKEN) {
        console.error('TELEGRAM_BOT_TOKEN не найден в Render');
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

        console.error(
            'Ошибка соединения с Telegram:',
            error
        );

        return null;
    }
}


// =====================================================
// УСТАНОВКА WEBHOOK
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
                // КОМАНДА /DRIVER
                // =================================================

                if (text === '/driver') {

                    // ---------------------------------------------
                    // ПРОВЕРКА ДОСТУПА
                    // ---------------------------------------------

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


                    // ---------------------------------------------
                    // ВОДИТЕЛЬ РАЗРЕШЁН
                    // ---------------------------------------------

                    await telegram(
                        'sendMessage',
                        {
                            chat_id: chatId,

                            text:
                                '✅ ДОСТУП ВОДИТЕЛЯ ПОДТВЕРЖДЁН\n\n' +
                                '🚕 Вы зарегистрированы как водитель.\n\n' +
                                'Новые заказы будут приходить сюда.\n\n' +
                                '🟢 Ожидаем новые заказы...'
                        }
                    );


                    console.log(
                        'Разрешённый водитель вошёл:',
                        chatId
                    );
                }


                // =================================================
                // /START
                // =================================================

                else if (text === '/start') {

                    if (isDriver(chatId)) {

                        await telegram(
                            'sendMessage',
                            {
                                chat_id: chatId,

                                text:
                                    '🚕 Такси Речица\n\n' +
                                    '👨‍✈️ Ваш аккаунт зарегистрирован как водитель.\n\n' +
                                    'Новые заказы будут приходить сюда.'
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
                }
            }


            // =====================================================
            // НАЖАТИЕ INLINE-КНОПКИ
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


                    // ---------------------------------------------
                    // ПРОВЕРЯЕМ СТАТУС
                    // ---------------------------------------------

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


                    // ---------------------------------------------
                    // ID ЗАКАЗА ИЗ КНОПКИ
                    // ---------------------------------------------

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


                    // ---------------------------------------------
                    // ЗАКАЗ ПРИНЯТ
                    // ---------------------------------------------

                    currentOrder.status =
                        'accepted';

                    currentOrder.driverChatId =
                        chatId;

                    currentOrder.driverName =
                        'Александр Иванов';

                    currentOrder.driverCar =
                        'Toyota Corolla';

                    currentOrder.driverNumber =
                        '3-TAP-1234';

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


                    // ---------------------------------------------
                    // УБИРАЕМ КНОПКИ
                    // ---------------------------------------------

                    await telegram(
                        'editMessageReplyMarkup',
                        {
                            chat_id:
                                chatId,

                            message_id:
                                callback.message.message_id,

                            reply_markup: {
                                inline_keyboard: []
                            }
                        }
                    );


                    // ---------------------------------------------
                    // ОТВЕТ НА НАЖАТИЕ
                    // ---------------------------------------------

                    await telegram(
                        'answerCallbackQuery',
                        {
                            callback_query_id:
                                callback.id,

                            text:
                                '✅ Заказ принят!'
                        }
                    );


                    // ---------------------------------------------
                    // СООБЩЕНИЕ ВОДИТЕЛЮ
                    // ---------------------------------------------

                    await telegram(
                        'sendMessage',
                        {
                            chat_id:
                                chatId,

                            text:
                                '✅ ЗАКАЗ ПРИНЯТ\n\n' +

                                `🚕 Заказ #${currentOrder.id}\n\n` +

                                `📍 Откуда:\n${currentOrder.addressA || '-'}\n\n` +

                                `📍 Куда:\n${currentOrder.addressB || '-'}\n\n` +

                                '🚗 Toyota Corolla\n' +

                                '👤 Александр Иванов\n' +

                                '🔢 3-TAP-1234\n\n' +

                                'Пассажир получил уведомление.'
                        }
                    );


                    // ---------------------------------------------
                    // СООБЩЕНИЕ ПАССАЖИРУ
                    // ---------------------------------------------

                    if (
                        currentOrder.passengerChatId
                    ) {

                        await telegram(
                            'sendMessage',
                            {
                                chat_id:
                                    currentOrder.passengerChatId,

                                text:
                                    '✅ ВОДИТЕЛЬ ПРИНЯЛ ВАШ ЗАКАЗ\n\n' +

                                    '🚕 Toyota Corolla\n' +

                                    '👤 Александр Иванов\n' +

                                    '🔢 3-TAP-1234\n\n' +

                                    '🚗 Водитель едет к вам.'
                            }
                        );
                    }


                    // ---------------------------------------------
                    // УВЕДОМЛЯЕМ ОСТАЛЬНЫХ ВОДИТЕЛЕЙ
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
                            chat_id:
                                chatId,

                            message_id:
                                callback.message.message_id,

                            text:
                                '❌ Вы отклонили заказ.'
                        }
                    );
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
            // ОТПРАВЛЯЕМ ЗАКАЗ ВСЕМ ВОДИТЕЛЯМ
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


            currentOrder.status =
                'accepted';


            currentOrder.driverName =
                req.body.driverName ||
                'Александр Иванов';


            currentOrder.driverCar =
                req.body.driverCar ||
                'Toyota Corolla';


            currentOrder.driverNumber =
                req.body.driverNumber ||
                '3-TAP-1234';


            currentOrder.acceptedAt =
                Date.now();


            if (
                currentOrder.passengerChatId
            ) {

                await telegram(
                    'sendMessage',
                    {
                        chat_id:
                            currentOrder.passengerChatId,

                        text:
                            '✅ ВОДИТЕЛЬ ПРИНЯЛ ВАШ ЗАКАЗ\n\n' +

                            `🚕 ${currentOrder.driverCar}\n` +

                            `👤 ${currentOrder.driverName}\n` +

                            `🔢 ${currentOrder.driverNumber}\n\n` +

                            '🚗 Водитель едет к вам.'
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

        await setupTelegramWebhook();
    }
);
