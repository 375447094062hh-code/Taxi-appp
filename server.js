const express = require('express');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Эти переменные Render возьмет из своих настроек (безопасно)
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

app.post('/api/send-order', async (req, res) => {
  const order = req.body;

  const messageText = `🚖 Новая заявка #${order.id}!\n` +
                      `📍 Откуда: ${order.addressA}\n` +
                      `🏁 Куда: ${order.addressB}\n` +
                      `🏷 Тариф: ${order.tariff}\n` +
                      `⏰ Время: ${order.scheduled}` +
                      (order.childSeat ? `\n👶 С детским креслом` : '') +
                      (order.isWeekend ? `\n⭐ Тариф выходного дня` : '');

  try {
    const telegramResponse = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: messageText,
        parse_mode: 'Markdown'
      })
    });
    
    const data = await telegramResponse.json();
    res.json({ success: true, data });
  } catch (error) {
    console.error('Ошибка отправки в Telegram:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});