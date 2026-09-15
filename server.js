const express = require('express');
const app = express();

app.use(express.json());
app.use(express.static('public')); // Указывает, где лежит ваш HTML-сайт

let currentOrder = null;

// Пассажир отправляет заказ
app.post('/api/send-order', (req, res) => {
    currentOrder = req.body;
    console.log('Получен новый заказ:', currentOrder);
    res.json({ success: true });
});

// Водитель запрашивает заказ
app.get('/api/get-order', (req, res) => {
    res.json(currentOrder || { status: 'none' });
});

// Водитель принимает заказ
app.post('/api/accept-order', (req, res) => {
    if (currentOrder) {
        currentOrder.status = 'accepted';
    }
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
