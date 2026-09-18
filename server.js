const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const DRIVER_CHAT_IDS = Array.from(new Set(
  String(process.env.DRIVER_CHAT_IDS || "")
    .split(/[,;\n]+/).map(v => v.trim()).filter(Boolean)
));

const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
}) : null;

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public", {
  etag: false, maxAge: 0,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
  }
}));

const ACTIVE_STATUSES = ["searching","accepted","arrived","trip"];

const clean = v => v == null ? "" : String(v).trim();
const isDriver = id => DRIVER_CHAT_IDS.includes(clean(id));
const makeId = () => crypto.randomUUID();

async function db(sql, params=[]) {
  if (!pool) throw new Error("DATABASE_URL не задан.");
  return pool.query(sql, params);
}

async function migrate() {
  if (!pool) return console.log("DATABASE_URL не задан — PostgreSQL отключён.");

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
      rating_count INTEGER NOT NULL DEFAULT 0,
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
      distance_km NUMERIC(10,2) DEFAULT 0,
      amount NUMERIC(10,2) NOT NULL DEFAULT 3.00,
      status TEXT NOT NULL DEFAULT 'searching',
      driver_telegram_id TEXT,
      driver_name TEXT,
      driver_car TEXT,
      driver_plate TEXT,
      driver_phone TEXT,
      pickup_lat DOUBLE PRECISION,
      pickup_lng DOUBLE PRECISION,
      destination_lat DOUBLE PRECISION,
      destination_lng DOUBLE PRECISION,
      waiting_minutes INTEGER NOT NULL DEFAULT 0,
      waiting_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
      waiting_started_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_at TIMESTAMPTZ,
      arrived_at TIMESTAMPTZ,
      trip_started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS ratings (
      id BIGSERIAL PRIMARY KEY,
      order_id TEXT UNIQUE NOT NULL,
      passenger_telegram_id TEXT NOT NULL,
      driver_telegram_id TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      good JSONB NOT NULL DEFAULT '[]'::jsonb,
      bad JSONB NOT NULL DEFAULT '[]'::jsonb,
      comment TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db(`
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS rating_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS waiting_minutes INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS waiting_fee NUMERIC(10,2) NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS waiting_started_at TIMESTAMPTZ;
  `);
  console.log("PostgreSQL: таблицы готовы.");
}

async function telegram(method, body={}) {
  if (!BOT_TOKEN) return {ok:false, description:"TELEGRAM_BOT_TOKEN не задан"};
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)
  });
  return r.json();
}

async function sendTelegram(chatId, text, extra={}) {
  return telegram("sendMessage", {chat_id:chatId, text, ...extra});
}

async function notifyPassenger(order, text) {
  if (order?.passenger_telegram_id) await sendTelegram(order.passenger_telegram_id, text);
}

async function notifyDrivers(order) {
  if (!pool || !DRIVER_CHAT_IDS.length) return;
  const rows = (await db("SELECT * FROM drivers WHERE telegram_id=ANY($1::text[])", [DRIVER_CHAT_IDS])).rows;
  const appUrl = clean(process.env.APP_URL || process.env.RENDER_EXTERNAL_URL).replace(/\/$/,"");
  for (const d of rows) {
    if (order.child_seat && !d.has_child_seat) continue;
    const text = [
      "🚕 НОВЫЙ ЗАКАЗ",
      "",
      `📍 ${order.pickup}`,
      `🏁 ${order.destination}`,
      `💰 ${Number(order.amount).toFixed(2)} BYN`,
      order.scheduled_at ? `🕐 ${new Date(order.scheduled_at).toLocaleString("ru-RU")}` : "⚡ Сейчас",
      order.child_seat ? "👶 Нужно детское кресло" : "",
      "",
      "Откройте Mini App и примите заказ."
    ].filter(Boolean).join("\n");
    await sendTelegram(d.telegram_id, text, appUrl ? {
      reply_markup:{inline_keyboard:[[{text:"🚕 Открыть заказы",web_app:{url:appUrl}}]]}
    } : {});
  }
}

async function setTelegramMenu() {
  const url = clean(process.env.APP_URL || process.env.RENDER_EXTERNAL_URL).replace(/\/$/,"");
  if (!BOT_TOKEN || !url) return;
  await telegram("setChatMenuButton",{menu_button:{type:"web_app",text:"🚕 Такси Речица",web_app:{url}}});
  await telegram("setMyCommands",{commands:[
    {command:"start",description:"Открыть Такси Речица"},
    {command:"driverid",description:"Показать Telegram ID"}
  ]});
}

app.get("/api/health", async (req,res) => {
  let database=false;
  try { if(pool){await db("SELECT 1");database=true;} } catch(_){}
  res.json({success:true,database,telegram:Boolean(BOT_TOKEN),driversConfigured:DRIVER_CHAT_IDS.length,time:new Date().toISOString()});
});

app.get("/api/user-role", async (req,res) => {
  try {
    const telegramId=clean(req.query.telegramId);
    if(!telegramId) return res.status(400).json({success:false,error:"Telegram ID не указан."});
    if(isDriver(telegramId)){
      const r=await db("SELECT telegram_id,name,phone,car,plate,has_child_seat,rating,rating_count FROM drivers WHERE telegram_id=$1",[telegramId]);
      return res.json({success:true,role:"driver",driver:r.rows[0]||null,telegramId});
    }
    res.json({success:true,role:"passenger",driver:null,telegramId});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get("/api/passenger-profile", async (req,res)=>{
  try {
    const id=clean(req.query.telegramId);
    const r=await db("SELECT telegram_id,name,phone FROM passengers WHERE telegram_id=$1",[id]);
    res.json({success:true,profile:r.rows[0]||null});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post("/api/passenger-profile", async (req,res)=>{
  try {
    const telegramId=clean(req.body.telegramId), name=clean(req.body.name), phone=clean(req.body.phone);
    if(!telegramId||!name||!phone) return res.status(400).json({success:false,error:"Заполните имя и телефон."});
    const r=await db(`INSERT INTO passengers(telegram_id,name,phone) VALUES($1,$2,$3)
      ON CONFLICT(telegram_id) DO UPDATE SET name=$2,phone=$3,updated_at=NOW()
      RETURNING telegram_id,name,phone`,[telegramId,name,phone]);
    res.json({success:true,profile:r.rows[0]});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get("/api/driver-profile", async (req,res)=>{
  try {
    const telegramId=clean(req.query.telegramId);
    if(!isDriver(telegramId)) return res.status(403).json({success:false,error:"Нет доступа водителя."});
    const r=await db("SELECT telegram_id,name,phone,car,plate,has_child_seat,rating,rating_count FROM drivers WHERE telegram_id=$1",[telegramId]);
    res.json({success:true,profile:r.rows[0]||null});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post("/api/driver-profile", async (req,res)=>{
  try {
    const telegramId=clean(req.body.telegramId);
    if(!isDriver(telegramId)) return res.status(403).json({success:false,error:"Нет доступа водителя."});
    const name=clean(req.body.name), phone=clean(req.body.phone), car=clean(req.body.car), plate=clean(req.body.plate);
    if(!name||!phone||!car||!plate) return res.status(400).json({success:false,error:"Заполните имя, телефон, автомобиль и номер."});
    const child=Boolean(req.body.hasChildSeat);
    const r=await db(`INSERT INTO drivers(telegram_id,name,phone,car,plate,has_child_seat)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(telegram_id) DO UPDATE SET name=$2,phone=$3,car=$4,plate=$5,has_child_seat=$6,updated_at=NOW()
      RETURNING telegram_id,name,phone,car,plate,has_child_seat,rating,rating_count`,
      [telegramId,name,phone,car,plate,child]);
    res.json({success:true,profile:r.rows[0]});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post("/api/orders", async (req,res)=>{
  try {
    const passengerId=clean(req.body.telegramId);
    if(!passengerId||isDriver(passengerId)) return res.status(403).json({success:false,error:"Заказ может создать только пассажир."});
    const pickup=clean(req.body.pickup), destination=clean(req.body.destination);
    if(!pickup||!destination) return res.status(400).json({success:false,error:"Укажите точки А и Б."});
    const p=(await db("SELECT name,phone FROM passengers WHERE telegram_id=$1",[passengerId])).rows[0];
    if(!p?.name||!p?.phone) return res.status(400).json({success:false,error:"Сначала заполните профиль пассажира."});
    const scheduledAt=req.body.scheduledAt?new Date(req.body.scheduledAt):null;
    if(scheduledAt&&Number.isNaN(scheduledAt.getTime())) return res.status(400).json({success:false,error:"Неверная дата и время."});
    const km=Number(req.body.distanceKm);
    const distance=Number.isFinite(km)&&km>=0?km:0;
    const amount=3+Math.ceil(distance);
    const r=await db(`INSERT INTO orders
      (id,passenger_telegram_id,passenger_name,passenger_phone,pickup,destination,tariff,child_seat,scheduled_at,distance_km,amount,pickup_lat,pickup_lng,destination_lat,destination_lng)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [makeId(),passengerId,p.name,p.phone,pickup,destination,clean(req.body.tariff)||"Стандарт",Boolean(req.body.childSeat),scheduledAt,distance,amount,
       Number.isFinite(Number(req.body.pickupLat))?Number(req.body.pickupLat):null,
       Number.isFinite(Number(req.body.pickupLng))?Number(req.body.pickupLng):null,
       Number.isFinite(Number(req.body.destinationLat))?Number(req.body.destinationLat):null,
       Number.isFinite(Number(req.body.destinationLng))?Number(req.body.destinationLng):null]);
    await notifyDrivers(r.rows[0]);
    res.json({success:true,order:r.rows[0]});
  } catch(e){console.error(e);res.status(500).json({success:false,error:e.message});}
});

app.get("/api/orders/current", async (req,res)=>{
  try {
    const r=await db(`SELECT o.*, COALESCE(o.driver_phone,d.phone) AS driver_phone, d.rating AS driver_rating
      FROM orders o LEFT JOIN drivers d ON d.telegram_id=o.driver_telegram_id
      WHERE o.passenger_telegram_id=$1 AND o.status=ANY($2::text[])
      ORDER BY o.created_at DESC LIMIT 1`,[clean(req.query.telegramId),ACTIVE_STATUSES]);
    res.json({success:true,order:r.rows[0]||null});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get("/api/orders/history", async (req,res)=>{
  try {
    const id=clean(req.query.telegramId);
    if(isDriver(id)){
      const r=await db("SELECT * FROM orders WHERE driver_telegram_id=$1 AND status='completed' ORDER BY completed_at DESC LIMIT 100",[id]);
      return res.json({success:true,orders:r.rows});
    }
    const r=await db("SELECT * FROM orders WHERE passenger_telegram_id=$1 AND status='completed' ORDER BY completed_at DESC LIMIT 100",[id]);
    res.json({success:true,orders:r.rows});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get("/api/driver-orders", async (req,res)=>{
  try {
    const id=clean(req.query.telegramId);
    if(!isDriver(id)) return res.status(403).json({success:false,error:"Нет доступа водителя."});
    const r=await db(`SELECT * FROM orders WHERE status='searching'
      AND (child_seat=false OR child_seat=(SELECT has_child_seat FROM drivers WHERE telegram_id=$1))
      ORDER BY scheduled_at NULLS FIRST,created_at ASC`,[id]);
    res.json({success:true,orders:r.rows});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get("/api/driver-current", async (req,res)=>{
  try {
    const id=clean(req.query.telegramId);
    if(!isDriver(id)) return res.status(403).json({success:false,error:"Нет доступа водителя."});
    const r=await db("SELECT * FROM orders WHERE driver_telegram_id=$1 AND status=ANY($2::text[]) ORDER BY accepted_at DESC NULLS LAST LIMIT 1",[id,ACTIVE_STATUSES]);
    res.json({success:true,order:r.rows[0]||null});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post("/api/orders/:orderId/accept", async (req,res)=>{
  try {
    const driverId=clean(req.body.telegramId), orderId=clean(req.params.orderId);
    if(!isDriver(driverId)) return res.status(403).json({success:false,error:"Нет доступа водителя."});
    const d=(await db("SELECT * FROM drivers WHERE telegram_id=$1",[driverId])).rows[0];
    if(!d?.name||!d?.phone||!d?.car||!d?.plate) return res.status(400).json({success:false,error:"Сначала заполните профиль водителя."});
    const r=await db(`UPDATE orders SET status='accepted',driver_telegram_id=$1,driver_name=$2,driver_car=$3,driver_plate=$4,driver_phone=$5,accepted_at=NOW()
      WHERE id=$6 AND status='searching' RETURNING *`,[driverId,d.name,d.car,d.plate,d.phone,orderId]);
    if(!r.rows[0]) return res.status(409).json({success:false,error:"Заказ уже принят другим водителем."});
    await notifyPassenger(r.rows[0],"✅ Водитель подтвердил заказ.\n\n🚗 "+(d.car||"Автомобиль")+" "+(d.plate||"")+"\n👤 "+(d.name||"Водитель"));
    res.json({success:true,order:r.rows[0]});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post("/api/orders/:orderId/status", async (req,res)=>{
  try {
    const driverId=clean(req.body.telegramId), orderId=clean(req.params.orderId), next=clean(req.body.status);
    if(!isDriver(driverId)) return res.status(403).json({success:false,error:"Нет доступа водителя."});
    const allowed={arrived:["accepted"],trip:["arrived"],completed:["trip"]};
    if(!allowed[next]) return res.status(400).json({success:false,error:"Недопустимый статус."});
    const col={arrived:"arrived_at",trip:"trip_started_at",completed:"completed_at"}[next];
    if(next==="trip"||next==="completed"){
      await db(`UPDATE orders SET
        waiting_minutes=waiting_minutes+
          CASE WHEN waiting_started_at IS NULL THEN 0 ELSE GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (NOW()-waiting_started_at))/60)::int-waiting_minutes) END,
        waiting_fee=waiting_fee+
          CASE WHEN waiting_started_at IS NULL THEN 0 ELSE GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (NOW()-waiting_started_at))/60)::numeric*0.50-waiting_fee) END,
        waiting_started_at=NULL
        WHERE id=$1 AND driver_telegram_id=$2`,[orderId,driverId]);
    }
    const r=await db(`UPDATE orders SET status=$1,${col}=NOW() WHERE id=$2 AND driver_telegram_id=$3 AND status=ANY($4::text[]) RETURNING *`,
      [next,orderId,driverId,allowed[next]]);
    if(!r.rows[0]) return res.status(409).json({success:false,error:"Статус уже изменён."});
    const msg={arrived:"📍 Водитель на месте.",trip:"🚕 Поездка началась.",completed:"🏁 Поездка завершена."}[next];
    await notifyPassenger(r.rows[0],msg);
    res.json({success:true,order:r.rows[0]});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post("/api/orders/:orderId/waiting", async (req,res)=>{
  try {
    const driverId=clean(req.body.telegramId), orderId=clean(req.params.orderId);
    if(!isDriver(driverId)) return res.status(403).json({success:false,error:"Нет доступа водителя."});
    const current=(await db("SELECT * FROM orders WHERE id=$1 AND driver_telegram_id=$2 AND status IN ('arrived','trip')",[orderId,driverId])).rows[0];
    if(!current) return res.status(409).json({success:false,error:"Ожидание сейчас недоступно."});

    if(!current.waiting_started_at){
      const r=await db("UPDATE orders SET waiting_started_at=NOW() WHERE id=$1 AND driver_telegram_id=$2 RETURNING *",[orderId,driverId]);
      return res.json({success:true,action:"started",order:r.rows[0]});
    }

    const r=await db(`UPDATE orders
      SET waiting_minutes=waiting_minutes+
          GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (NOW()-waiting_started_at))/60)::int-waiting_minutes),
          waiting_fee=waiting_fee+
          GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (NOW()-waiting_started_at))/60)::numeric*0.50-waiting_fee),
          waiting_started_at=NULL
      WHERE id=$1 AND driver_telegram_id=$2
      RETURNING *`,[orderId,driverId]);
    const charged=Number(r.rows[0].waiting_minutes)-Number(current.waiting_minutes||0);
    if(charged>0) await notifyPassenger(r.rows[0],`⏱ Ожидание завершено: ${r.rows[0].waiting_minutes} мин • +${Number(r.rows[0].waiting_fee).toFixed(2)} BYN`);
    res.json({success:true,action:"stopped",order:r.rows[0]});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post("/api/orders/:orderId/cancel", async (req,res)=>{
  try {
    const uid=clean(req.body.telegramId), oid=clean(req.params.orderId);
    const r=await db(`UPDATE orders SET status='cancelled' WHERE id=$1 AND passenger_telegram_id=$2 AND status=ANY($3::text[]) RETURNING *`,[oid,uid,ACTIVE_STATUSES]);
    if(!r.rows[0]) return res.status(409).json({success:false,error:"Заказ нельзя отменить."});
    if(r.rows[0].driver_telegram_id) await notifyPassenger(r.rows[0],"❌ Заказ отменён.");
    res.json({success:true,order:r.rows[0]});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post("/api/passenger-feedback", async (req,res)=>{
  try {
    const passengerId=clean(req.body.telegramId), orderId=clean(req.body.orderId), rating=Number(req.body.rating);
    if(!passengerId||!orderId||rating<1||rating>5) return res.status(400).json({success:false,error:"Выберите оценку от 1 до 5."});
    const order=(await db("SELECT * FROM orders WHERE id=$1 AND passenger_telegram_id=$2 AND status='completed'",[orderId,passengerId])).rows[0];
    if(!order?.driver_telegram_id) return res.status(400).json({success:false,error:"Поездка не найдена."});
    const exists=await db("SELECT id FROM ratings WHERE order_id=$1",[orderId]);
    if(exists.rows[0]) return res.status(409).json({success:false,error:"Оценка уже оставлена."});
    await db("INSERT INTO ratings(order_id,passenger_telegram_id,driver_telegram_id,rating,good,bad,comment) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)",
      [orderId,passengerId,order.driver_telegram_id,rating,JSON.stringify(req.body.good||[]),JSON.stringify(req.body.bad||[]),clean(req.body.comment)]);
    await db(`UPDATE drivers SET rating=ROUND(((rating*rating_count)+$1)/NULLIF(rating_count+1,0),2),rating_count=rating_count+1 WHERE telegram_id=$2`,[rating,order.driver_telegram_id]);
    res.json({success:true});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get("/api/order-status", async (req,res)=>{
  try {
    const uid=clean(req.query.telegramId), oid=clean(req.query.id);
    const r=await db(`SELECT o.*,COALESCE(o.driver_phone,d.phone) AS driver_phone,d.rating AS driver_rating FROM orders o LEFT JOIN drivers d ON d.telegram_id=o.driver_telegram_id WHERE o.id=$1 AND (o.passenger_telegram_id=$2 OR o.driver_telegram_id=$2)`,[oid,uid]);
    if(!r.rows[0]) return res.status(404).json({success:false,error:"Заказ не найден."});
    res.json(r.rows[0]);
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get("/api/driver-stats", async (req,res)=>{
  try {
    const id=clean(req.query.telegramId);
    if(!isDriver(id)) return res.status(403).json({success:false,error:"Нет доступа водителя."});
    const month = /^\d{4}-\d{2}$/.test(clean(req.query.month)) ? clean(req.query.month) : new Date().toISOString().slice(0,7);
    const r=await db(`SELECT COUNT(*)::int AS orders,
      COALESCE(SUM(amount+waiting_fee),0)::numeric(10,2) AS earnings,
      COALESCE(SUM(waiting_minutes),0)::int AS waiting_minutes
      FROM orders WHERE driver_telegram_id=$1 AND status='completed' AND TO_CHAR(completed_at,'YYYY-MM')=$2`,[id,month]);
    res.json({success:true,month,stats:r.rows[0]});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get("*",(req,res)=>{
  if(req.path.startsWith("/api/")) return res.status(404).json({success:false,error:"API route not found."});
  res.sendFile(require("path").join(__dirname,"public","index.html"));
});

app.listen(PORT,"0.0.0.0",()=>{
  console.log(`Taxi Речица: server started on port ${PORT}`);
  migrate().then(setTelegramMenu).catch(e=>console.error("Startup:",e));
});
