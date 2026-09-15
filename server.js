const express = require('express');
const app = express();

app.use(express.json());
app.use(express.static('public'));

let currentOrder = null;

// ========================================
// ПАССАЖИР СОЗДАЁТ ЗАКАЗ
// ========================================
app.post('/api/send-order', (req, res) => {
    try {
        currentOrder = {
            ...req.body,
            status: 'searching',
            createdAt: Date.now()
        };

        console.log('Новый заказ:', currentOrder);

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


// ========================================
// ВОДИТЕЛЬ ПОЛУЧАЕТ АКТИВНЫЙ ЗАКАЗ
// ========================================
app.get('/api/get-order', (req, res) => {

    if (!currentOrder) {
        return res.json({
            status: 'none'
        });
    }

    res.json(currentOrder);
});


// ========================================
// ВОДИТЕЛЬ ПРИНИМАЕТ ЗАКАЗ
// ========================================
app.post('/api/accept-order', (req, res) => {

    if (!currentOrder) {
        return res.status(404).json({
            success: false,
            error: 'Активный заказ не найден'
        });
    }

    // Проверяем ID, если он передан
    if (
        req.body.orderId &&
        currentOrder.id &&
        req.body.orderId !== currentOrder.id
    ) {
        return res.status(400).json({
            success: false,
            error: 'Этот заказ уже неактивен'
        });
    }

    currentOrder.status = 'accepted';

    // Данные водителя
    currentOrder.driverName =
        req.body.driverName || 'Александр Иванов';

    currentOrder.driverCar =
        req.body.driverCar || 'Toyota Corolla';

    currentOrder.driverNumber =
        req.body.driverNumber || '3-TAP-1234';

    currentOrder.acceptedAt = Date.now();

    console.log('Заказ принят водителем:', currentOrder);

    res.json({
        success: true,
        order: currentOrder
    });
});


// ========================================
// ПАССАЖИР ПРОВЕРЯЕТ СТАТУС ЗАКАЗА
// ========================================
app.get('/api/order-status', (req, res) => {

    if (!currentOrder) {
        return res.json({
            status: 'none'
        });
    }

    res.json(currentOrder);
});


// ========================================
// ЗАПУСК СЕРВЕРА
// ========================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
```
