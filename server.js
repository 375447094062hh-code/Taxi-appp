const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();

const DRIVER_CHAT_IDS = Array.from(new Set(
  String(process.env.DRIVER_CHAT_IDS || "")
    .split(/[,;\n]+/)
    .map(v => v.trim().replace(/^[\"']+|[\"']+$/g, ""))
    .filter(Boolean)
));

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public", {
  etag: false,
  maxAge: 0,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
  }
}));

const ACTIVE_STATUSES = ["searching", "accepted", "arrived", "trip"];

function id(v) {
  return v == null ? "" : String(v).trim();
}

function isDriver(telegramId) {
  return DRIVER_CHAT_IDS.includes(id(telegramId));
}

function makeOrderId() {
  return crypto.randomUUID();
}

async function db(sql, params = []) {
  if (!pool) throw new Error("DATABASE_URL не задан.");
  return pool.query(sql, params);
}

async function migrate() {
  if (!pool) {
    console.log("DATABASE_URL не задан — PostgreSQL отключён.");
    return;
  }

  await db(`
    CREATE TABLE IF NOT EXISTS passengers (
      telegram_id TEXT PRIMARY KEY,
      name TEXT,
      phone TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS drivers (
      telegram_id TEXT PRIMARY KEY,
      name TEXT,
      phone TEXT,
      car TEXT,
      plate TEXT,
      has_child_seat BOOLEAN NOT NULL DEFAULT FALSE,
      rating NUMERIC(3,2) NOT NULL DEFAULT 5.00,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      passenger_telegram_id TEXT NOT NULL,
      passenger_name TEXT,
      passenger_phone TEXT,
      pickup TEXT NOT NULL,
      destination TEXT NOT NULL,
      tariff TEXT NOT NULL DEFAULT 'Стандарт',
      child_seat BOOLEAN NOT NULL DEFAULT FALSE,
      scheduled_at TIMESTAMPTZ,
      distance_km NUMERIC(10,2),
      amount NUMERIC(10,2) NOT NULL DEFAULT 3.00,
      status TEXT NOT NULL DEFAULT 'searching',
      driver_telegram_id TEXT,
      driver_name TEXT,
      driver_car TEXT,
      driver_plate TEXT,
      driver_phone TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_at TIMESTAMPTZ,
      arrived_at TIMESTAMPTZ,
      trip_started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    );
  `);

  console.log("PostgreSQL: таблицы готовы.");
}

async function telegram(method, body = {}) {
  if (!BOT_TOKEN) return { ok: false, description: "TELEGRAM_BOT_TOKEN не задан" };

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  return response.json();
}

async function sendTelegram(chatId, text, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    ...extra
  });
}

async function notifyPassenger(order, text) {
  if (order?.passenger_telegram_id) {
    await sendTelegram(order.passenger_telegram_id, text);
  }
}

async function notifyEligibleDrivers(order) {
  if (!pool || DRIVER_CHAT_IDS.length === 0) return;

  const result = await db(
    "SELECT * FROM drivers WHERE telegram_id = ANY($1::text[]) ORDER BY created_at ASC",
    [DRIVER_CHAT_IDS]
  );

  for (const driver of result.rows) {
    if (order.child_seat && !driver.has_child_seat) continue;

    const appUrl = String(
      process.env.APP_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      ""
    ).trim().replace(/\/$/, "");

    const text = [
      "🚕 НОВЫЙ ЗАКАЗ",
      "",
      `📍 Откуда: ${order.pickup}`,
      `🏁 Куда: ${order.destination}`,
      `💰 ${Number(order.amount).toFixed(2)} BYN`,
      order.distance_km != null ? `📏 ${Number(order.distance_km).toFixed(1)} км` : "",
      order.scheduled_at ? `🕐 ${new Date(order.scheduled_at).toLocaleString("ru-RU")}` : "⚡ Сейчас",
      order.child_seat ? "👶 Нужно детское кресло" : "",
      "",
      "Нажмите кнопку ниже, чтобы открыть заказы и принять этот заказ."
    ].filter(Boolean).join("\n");

    const extra = appUrl
      ? {
          reply_markup: {
            inline_keyboard: [[
              { text: "🚕 Открыть заказы", web_app: { url: appUrl } }
            ]]
          }
        }
      : {};

    await sendTelegram(driver.telegram_id, text, extra);
  }
}

async function setTelegramMenu() {
  if (!BOT_TOKEN) return;

  const appUrl = String(
    process.env.APP_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    ""
  ).trim();

  if (!appUrl) {
    console.log("APP_URL/RENDER_EXTERNAL_URL не задан — кнопка Mini App не устанавливается.");
    return;
  }

  const url = appUrl.replace(/\/$/, "");

  await telegram("setChatMenuButton", {
    menu_button: {
      type: "web_app",
      text: "🚕 Такси Речица",
      web_app: { url }
    }
  });

  await telegram("setMyCommands", {
    commands: [
      { command: "start", description: "Открыть Такси Речица" },
      { command: "driverid", description: "Показать Telegram ID" }
    ]
  });

  console.log("Telegram: Mini App menu button configured.");
}

async function pollTelegram() {
  if (!BOT_TOKEN) {
    console.log("TELEGRAM_BOT_TOKEN не задан — polling отключён.");
    return;
  }

  let offset = 0;

  while (true) {
    try {
      const result = await telegram("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message"]
      });

      if (!result.ok) {
        console.error("Telegram polling:", result.description);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      for (const update of result.result || []) {
        offset = update.update_id + 1;

        if (!update.message?.text) continue;

        const chatId = update.message.chat.id;
        const userId = update.message.from?.id;
        const text = update.message.text.trim();

        if (text === "/driverid") {
          await sendTelegram(
            chatId,
            `🆔 Ваш Telegram ID:\n\n${userId}\n\n` +
            "Добавьте это число в Render → Environment → DRIVER_CHAT_IDS."
          );
          continue;
        }

        if (text.startsWith("/start")) {
          if (isDriver(userId)) {
            await sendTelegram(
              chatId,
              "🚕 Такси Речица\n\nВы определены как ВОДИТЕЛЬ.\nОткройте Mini App через кнопку меню."
            );
          } else {
            await sendTelegram(
              chatId,
              "🚕 Такси Речица\n\nВы определены как ПАССАЖИР.\nОткройте Mini App через кнопку меню."
            );
          }
        }
      }
    } catch (error) {
      console.error("Telegram polling error:", error.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ------------------------------------------------------------
// ROLE
// ------------------------------------------------------------

app.get("/api/user-role", async (req, res) => {
  try {
    const telegramId = id(req.query.telegramId);

    if (!telegramId) {
      return res.status(400).json({
        success: false,
        error: "Telegram ID не указан."
      });
    }

    if (isDriver(telegramId)) {
      let driver = null;

      if (pool) {
        const result = await db(
          "SELECT telegram_id, name, phone, car, plate, has_child_seat, rating FROM drivers WHERE telegram_id=$1",
          [telegramId]
        );
        driver = result.rows[0] || null;
      }

      return res.json({
        success: true,
        role: "driver",
        driver,
        telegramId
      });
    }

    return res.json({
      success: true,
      role: "passenger",
      driver: null,
      telegramId
    });
  } catch (error) {
    console.error("/api/user-role:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ------------------------------------------------------------
// PASSENGER PROFILE
// ------------------------------------------------------------

app.get("/api/passenger-profile", async (req, res) => {
  try {
    const telegramId = id(req.query.telegramId);

    if (!telegramId) {
      return res.status(400).json({ success: false, error: "Telegram ID не указан." });
    }

    const result = await db(
      "SELECT telegram_id, name, phone FROM passengers WHERE telegram_id=$1",
      [telegramId]
    );

    res.json({
      success: true,
      profile: result.rows[0] || null
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/passenger-profile", async (req, res) => {
  try {
    const telegramId = id(req.body.telegramId);
    const name = id(req.body.name);
    const phone = id(req.body.phone);

    if (!telegramId || !name || !phone) {
      return res.status(400).json({
        success: false,
        error: "Заполните имя и телефон."
      });
    }

    const result = await db(
      `INSERT INTO passengers (telegram_id, name, phone)
       VALUES ($1,$2,$3)
       ON CONFLICT (telegram_id)
       DO UPDATE SET name=$2, phone=$3, updated_at=NOW()
       RETURNING telegram_id, name, phone`,
      [telegramId, name, phone]
    );

    res.json({ success: true, profile: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ------------------------------------------------------------
// DRIVER PROFILE
// ------------------------------------------------------------

app.get("/api/driver-profile", async (req, res) => {
  try {
    const telegramId = id(req.query.telegramId);

    if (!isDriver(telegramId)) {
      return res.status(403).json({
        success: false,
        error: "Нет доступа водителя."
      });
    }

    const result = await db(
      "SELECT telegram_id, name, phone, car, plate, has_child_seat, rating FROM drivers WHERE telegram_id=$1",
      [telegramId]
    );

    res.json({
      success: true,
      profile: result.rows[0] || null
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/driver-profile", async (req, res) => {
  try {
    const telegramId = id(req.body.telegramId);

    if (!isDriver(telegramId)) {
      return res.status(403).json({ success: false, error: "Нет доступа водителя." });
    }

    const name = id(req.body.name);
    const phone = id(req.body.phone);
    const car = id(req.body.car);
    const plate = id(req.body.plate);
    const hasChildSeat = Boolean(req.body.hasChildSeat);

    if (!name || !phone || !car || !plate) {
      return res.status(400).json({
        success: false,
        error: "Заполните имя, телефон, автомобиль и номер."
      });
    }

    const result = await db(
      `INSERT INTO drivers (telegram_id,name,phone,car,plate,has_child_seat)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (telegram_id)
       DO UPDATE SET name=$2,phone=$3,car=$4,plate=$5,has_child_seat=$6,updated_at=NOW()
       RETURNING telegram_id,name,phone,car,plate,has_child_seat,rating`,
      [telegramId,name,phone,car,plate,hasChildSeat]
    );

    res.json({ success: true, profile: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ------------------------------------------------------------
// ORDERS
// ------------------------------------------------------------

app.post("/api/orders", async (req, res) => {
  try {
    const passengerId = id(req.body.telegramId);

    if (!passengerId || isDriver(passengerId)) {
      return res.status(403).json({
        success: false,
        error: "Заказ может создать только пассажир."
      });
    }

    const pickup = id(req.body.pickup);
    const destination = id(req.body.destination);
    const tariff = id(req.body.tariff) || "Стандарт";
    const childSeat = Boolean(req.body.childSeat);
    const scheduledAt = req.body.scheduledAt ? new Date(req.body.scheduledAt) : null;

    if (!pickup || !destination) {
      return res.status(400).json({
        success: false,
        error: "Укажите адрес подачи и адрес назначения."
      });
    }

    if (scheduledAt && Number.isNaN(scheduledAt.getTime())) {
      return res.status(400).json({
        success: false,
        error: "Неверная дата и время."
      });
    }

    const passenger = await db(
      "SELECT name,phone FROM passengers WHERE telegram_id=$1",
      [passengerId]
    );

    const p = passenger.rows[0];

    if (!p?.name || !p?.phone) {
      return res.status(400).json({
        success: false,
        error: "Сначала заполните профиль пассажира."
      });
    }

    // Базовый тариф по текущему правилу пользователя:
    // посадка 3 BYN + 1 BYN за каждый км.
    // Пока координаты не переданы, сохраняем минимальную сумму 3 BYN.
    const distanceKm = Number(req.body.distanceKm);
    const safeDistance = Number.isFinite(distanceKm) && distanceKm >= 0 ? distanceKm : 0;
    const amount = 3 + Math.ceil(safeDistance) * 1;

    const orderId = makeOrderId();

    const result = await db(
      `INSERT INTO orders
       (id,passenger_telegram_id,passenger_name,passenger_phone,pickup,destination,tariff,child_seat,scheduled_at,distance_km,amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        orderId,
        passengerId,
        p.name,
        p.phone,
        pickup,
        destination,
        tariff,
        childSeat,
        scheduledAt,
        safeDistance,
        amount
      ]
    );

    const order = result.rows[0];

    await notifyEligibleDrivers(order);

    res.json({
      success: true,
      order
    });
  } catch (error) {
    console.error("/api/orders:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/orders/current", async (req, res) => {
  try {
    const telegramId = id(req.query.telegramId);

    const result = await db(
      `SELECT * FROM orders
       WHERE passenger_telegram_id=$1
         AND status = ANY($2::text[])
       ORDER BY created_at DESC
       LIMIT 1`,
      [telegramId, ACTIVE_STATUSES]
    );

    res.json({
      success: true,
      order: result.rows[0] || null
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/driver-orders", async (req, res) => {
  try {
    const telegramId = id(req.query.telegramId);

    if (!isDriver(telegramId)) {
      return res.status(403).json({
        success: false,
        error: "Нет доступа водителя."
      });
    }

    const result = await db(
      `SELECT * FROM orders
       WHERE status='searching'
       AND (child_seat=false OR child_seat=(SELECT has_child_seat FROM drivers WHERE telegram_id=$1))
       ORDER BY scheduled_at NULLS FIRST, created_at ASC`,
      [telegramId]
    );

    res.json({ success: true, orders: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/orders/:orderId/accept", async (req, res) => {
  try {
    const telegramId = id(req.body.telegramId);
    const orderId = id(req.params.orderId);

    if (!isDriver(telegramId)) {
      return res.status(403).json({ success: false, error: "Нет доступа водителя." });
    }

    const driverResult = await db(
      "SELECT * FROM drivers WHERE telegram_id=$1",
      [telegramId]
    );

    const driver = driverResult.rows[0];

    if (!driver) {
      return res.status(400).json({
        success: false,
        error: "Сначала заполните профиль водителя."
      });
    }

    const result = await db(
      `UPDATE orders
       SET status='accepted',
           driver_telegram_id=$1,
           driver_name=$2,
           driver_car=$3,
           driver_plate=$4,
           driver_phone=$5,
           accepted_at=NOW()
       WHERE id=$6 AND status='searching'
       RETURNING *`,
      [telegramId,driver.name,driver.car,driver.plate,driver.phone,orderId]
    );

    if (!result.rows[0]) {
      return res.status(409).json({
        success: false,
        error: "Заказ уже принят другим водителем."
      });
    }

    const order = result.rows[0];

    await notifyPassenger(
      order,
      [
        "🚕 ВОДИТЕЛЬ НАЙДЕН",
        "",
        `👤 ${order.driver_name || "Водитель"}`,
        `🚗 ${order.driver_car || "-"}`,
        `🔢 ${order.driver_plate || "-"}`,
        `📞 ${order.driver_phone || "-"}`,
        "",
        "Водитель направляется к вам."
      ].join("\n")
    );

    res.json({ success: true, order });
  } catch (error) {
    console.error("accept:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/orders/:orderId/status", async (req, res) => {
  try {
    const telegramId = id(req.body.telegramId);
    const orderId = id(req.params.orderId);
    const nextStatus = id(req.body.status);

    if (!isDriver(telegramId)) {
      return res.status(403).json({ success: false, error: "Нет доступа водителя." });
    }

    const allowed = {
      arrived: ["accepted"],
      trip: ["arrived"],
      completed: ["trip"]
    };

    if (!allowed[nextStatus]) {
      return res.status(400).json({ success: false, error: "Недопустимый статус." });
    }

    const column = {
      arrived: "arrived_at",
      trip: "trip_started_at",
      completed: "completed_at"
    }[nextStatus];

    const result = await db(
      `UPDATE orders
       SET status=$1, ${column}=NOW()
       WHERE id=$2 AND driver_telegram_id=$3 AND status = ANY($4::text[])
       RETURNING *`,
      [nextStatus,orderId,telegramId,allowed[nextStatus]]
    );

    if (!result.rows[0]) {
      return res.status(409).json({
        success: false,
        error: "Статус заказа уже изменён."
      });
    }

    const order = result.rows[0];

    const messages = {
      arrived: "📍 Водитель прибыл к месту подачи.",
      trip: "🚕 Поездка началась.",
      completed: "✅ Поездка завершена. Спасибо!"
    };

    await notifyPassenger(order, messages[nextStatus]);

    res.json({ success: true, order });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ------------------------------------------------------------
// HEALTH
// ------------------------------------------------------------

app.get("/api/health", async (req,res) => {
  let database = false;

  try {
    if (pool) {
      await db("SELECT 1");
      database = true;
    }
  } catch (_) {}

  res.json({
    success: true,
    database,
    telegram: Boolean(BOT_TOKEN),
    driversConfigured: DRIVER_CHAT_IDS.length,
    time: new Date().toISOString()
  });
});

app.get("*", (req,res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ success:false,error:"API route not found." });
  }
  res.sendFile(require("path").join(__dirname,"public","index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Taxi Речица: server started on port ${PORT}`);
  console.log(`Driver IDs configured: ${DRIVER_CHAT_IDS.length}`);

  migrate()
    .then(setTelegramMenu)
    .then(() => pollTelegram())
    .catch(error => console.error("Startup:", error));
});
