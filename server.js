const express = require('express');

const app = express();

app.use(express.json());
app.use(express.static('public'));

let currentOrder = null;

// ================================
// СОЗДАНИЕ НОВОГО ЗАКАЗА
// ================================
app.post('/api/send-order', (req, res) => {
    try {
        const order = req.body || {};

        currentOrder = {
            ...order,
            status: 'searching',
            createdAt: Date.now()
        };

        console.log('=================================');
        console.log('НОВЫЙ ЗАКАЗ');
        console.log(currentOrder);
        console.log('=================================');

        res.json({
            success: true,
            order: currentOrder
        });

    } catch (error) {
        console.error('Ошибка создания заказа:', error);

        res.status(500).json({
            success: false,
            error: 'Ошибка создания заказа'
        });
    }
});


// ================================
// ПОЛУЧИТЬ ТЕКУЩИЙ ЗАКАЗ
// ================================
app.get('/api/get-order', (req, res) => {
    try {
        if (!currentOrder) {
            return res.json({
                status: 'none'
            });
        }

        res.json(currentOrder);

    } catch (error) {
        console.error('Ошибка получения заказа:', error);

        res.status(500).json({
            success: false,
            error: 'Ошибка получения заказа'
        });
    }
});


// ================================
// ВОДИТЕЛЬ ПРИНИМАЕТ ЗАКАЗ
// ================================
app.post('/api/accept-order', (req, res) => {
    try {
        if (!currentOrder) {
            return res.status(404).json({
                success: false,
                error: 'Активный заказ не найден'
            });
        }

        // Проверяем ID заказа
        if (
            req.body &&
            req.body.orderId &&
            currentOrder.id &&
            String(req.body.orderId) !== String(currentOrder.id)
        ) {
            return res.status(400).json({
                success: false,
                error: 'Этот заказ уже неактивен'
            });
        }

        // Меняем статус
        currentOrder.status = 'accepted';

        // Данные водителя
        currentOrder.driverName =
            req.body.driverName || 'Александр Иванов';

        currentOrder.driverCar =
            req.body.driverCar || 'Toyota Corolla';

        currentOrder.driverNumber =
            req.body.driverNumber || '3-TAP-1234';

        currentOrder.acceptedAt = Date.now();

        console.log('=================================');
        console.log('ВОДИТЕЛЬ ПРИНЯЛ ЗАКАЗ');
        console.log(currentOrder);
        console.log('=================================');

        res.json({
            success: true,
            order: currentOrder
        });

    } catch (error) {
        console.error('Ошибка принятия заказа:', error);

        res.status(500).json({
            success: false,
            error: 'Ошибка принятия заказа'
        });
    }
});


// ================================
// СТАТУС ЗАКАЗА ДЛЯ ПАССАЖИРА
// ================================
app.get('/api/order-status', (req, res) => {
    try {
        if (!currentOrder) {
            return res.json({
                status: 'none'
            });
        }

        res.json(currentOrder);

    } catch (error) {
        console.error('Ошибка проверки статуса:', error);

        res.status(500).json({
            success: false,
            error: 'Ошибка проверки статуса'
        });
    }
});


// ================================
// ВОДИТЕЛЬ ПРИЕХАЛ
// ================================
app.post('/api/driver-arrived', (req, res) => {
    try {
        if (!currentOrder) {
            return res.status(404).json({
                success: false,
                error: 'Активный заказ не найден'
            });
        }

        currentOrder.status = 'arrived';
        currentOrder.arrivedAt = Date.now();

        console.log('ВОДИТЕЛЬ ПРИЕХАЛ:', currentOrder);

        res.json({
            success: true,
            order: currentOrder
        });

    } catch (error) {
        console.error('Ошибка статуса прибытия:', error);

        res.status(500).json({
            success: false,
            error: 'Ошибка изменения статуса'
        });
    }
});


// ================================
// НАЧАЛО ПОЕЗДКИ
// ================================
app.post('/api/start-trip', (req, res) => {
    try {
        if (!currentOrder) {
            return res.status(404).json({
                success: false,
                error: 'Активный заказ не найден'
            });
        }

        currentOrder.status = 'trip';
        currentOrder.tripStartedAt = Date.now();

        console.log('ПОЕЗДКА НАЧАЛАСЬ:', currentOrder);

        res.json({
            success: true,
            order: currentOrder
        });

    } catch (error) {
        console.error('Ошибка начала поездки:', error);

        res.status(500).json({
            success: false,
            error: 'Ошибка начала поездки'
        });
    }
});


// ================================
// ЗАВЕРШЕНИЕ ПОЕЗДКИ
// ================================
app.post('/api/complete-order', (req, res) => {
    try {
        if (!currentOrder) {
            return res.status(404).json({
                success: false,
                error: 'Активный заказ не найден'
            });
        }

        currentOrder.status = 'completed';
        currentOrder.completedAt = Date.now();

        console.log('ЗАКАЗ ЗАВЕРШЁН:', currentOrder);

        res.json({
            success: true,
            order: currentOrder
        });

    } catch (error) {
        console.error('Ошибка завершения заказа:', error);

        res.status(500).json({
            success: false,
            error: 'Ошибка завершения заказа'
        });
    }
});


// ================================
// ГЛАВНАЯ СТРАНИЦА
// ================================
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});


// ================================
// ЗАПУСК СЕРВЕРА
// ================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log('=================================');
    console.log(`Такси Речица запущено на порту ${PORT}`);
    console.log('=================================');
});
