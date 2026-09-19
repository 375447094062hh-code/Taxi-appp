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
const OWNER_CHAT_ID = clean(process.env.OWNER_CHAT_ID);
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
      waiting_seconds INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS support_messages (
      id BIGSERIAL PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      order_id TEXT,
      reply_text TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      replied_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS saved_addresses (
      id BIGSERIAL PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      label TEXT NOT NULL,
      address TEXT NOT NULL,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(telegram_id,label)
    );
  `);

  await db(`
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS rating_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS waiting_minutes INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS waiting_fee NUMERIC(10,2) NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS waiting_seconds INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS waiting_started_at TIMESTAMPTZ;
    UPDATE orders SET waiting_seconds=waiting_minutes*60 WHERE waiting_seconds=0 AND waiting_minutes>0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS rejected_by_driver_telegram_id TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_notified_at TIMESTAMPTZ;
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
  if (order?.scheduled_at && new Date(order.scheduled_at).getTime() > Date.now()) return;
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
      "Откройте Mini App — заказ уже будет на главной странице водителя."
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


// ---------- Встроенная поддержка ----------
const supportReplyTargets = new Map();
let telegramPollingStarted = false;
let telegramUpdateOffset = 0;

function supportKindLabel(kind){
  return ({
    idea:"💡 Идея / улучшение",
    bug:"🐛 Ошибка в приложении",
    trip:"🚕 Проблема с поездкой",
    message:"💬 Сообщение"
  })[clean(kind)] || "💬 Сообщение";
}

async function buildSupportOrder(orderId, telegramId){
  if(!orderId) return null;
  const r=await db(
    "SELECT id,pickup,destination,status,amount,waiting_fee,scheduled_at FROM orders WHERE id=$1 AND (passenger_telegram_id=$2 OR driver_telegram_id=$2)",
    [orderId,telegramId]
  );
  return r.rows[0] || null;
}

app.post("/api/support", async (req,res)=>{
  try{
    if(!OWNER_CHAT_ID) return res.status(503).json({success:false,error:"Поддержка ещё не настроена владельцем сервиса."});
    const telegramId=clean(req.body.telegramId);
    const kind=clean(req.body.kind);
    const message=clean(req.body.message);
    const orderId=clean(req.body.orderId);
    if(!telegramId||!message) return res.status(400).json({success:false,error:"Напишите сообщение."});
    if(message.length>4000) return res.status(400).json({success:false,error:"Сообщение слишком длинное. Максимум 4000 символов."});

    const passenger=(await db("SELECT name,phone FROM passengers WHERE telegram_id=$1",[telegramId])).rows[0];
    const driver=(await db("SELECT name,phone,car,plate FROM drivers WHERE telegram_id=$1",[telegramId])).rows[0];
    const role=isDriver(telegramId)?"Водитель":"Пассажир";
    const profile=driver||passenger||{};
    const order=await buildSupportOrder(orderId,telegramId);

    const lines=[
      "🆘 НОВОЕ ОБРАЩЕНИЕ",
      "",
      "📌 Тема: "+supportKindLabel(kind),
      "👤 Роль: "+role,
      "🙍 Имя: "+(profile.name||"Не указано"),
      "📞 Телефон: "+(profile.phone||"Не указан"),
      "🆔 Telegram ID: "+telegramId,
      order ? "" : "",
      order ? "🚕 ПОЕЗДКА" : "",
      order ? "🆔 Заказ: "+order.id : "",
      order ? "📍 "+order.pickup : "",
      order ? "🏁 "+order.destination : "",
      order ? "📊 Статус: "+order.status : "",
      order ? "💳 Сумма: "+(Number(order.amount||0)+Number(order.waiting_fee||0)).toFixed(2)+" BYN" : "",
      order?.scheduled_at ? "🕐 "+new Date(order.scheduled_at).toLocaleString("ru-RU") : "",
      "",
      "💬 Сообщение:",
      message
    ].filter(Boolean).join("\n");

    const saved=(await db(`INSERT INTO support_messages(telegram_id,role,kind,message,order_id) VALUES($1,$2,$3,$4,$5) RETURNING id`,[telegramId,role,kind,message,order?.id||null])).rows[0];
    supportReplyTargets.set(telegramId,{telegramId,orderId:order?.id||"",name:profile.name||"",supportId:saved?.id||null});
    const sent=await sendTelegram(OWNER_CHAT_ID,lines,{
      reply_markup:{inline_keyboard:[[{text:"↩️ Ответить пользователю",callback_data:"support_reply:"+telegramId+":"+(saved?.id||"")}]]}
    });
    if(!sent.ok) throw new Error(sent.description||"Не удалось отправить обращение владельцу.");
    res.json({success:true});
  }catch(e){
    console.error("Support:",e);
    res.status(500).json({success:false,error:e.message||"Не удалось отправить обращение."});
  }
});

async function handleTelegramUpdate(update){
  if(update.callback_query){
    const q=update.callback_query;
    const adminChatId=clean(q.from?.id);
    if(adminChatId!==OWNER_CHAT_ID) {
      await telegram("answerCallbackQuery",{callback_query_id:q.id,text:"Нет доступа."});
      return;
    }
    const data=clean(q.data);
    if(data.startsWith("support_reply:")){
      const parts=data.slice("support_reply:".length).split(":");
      const targetId=clean(parts[0]);
      const supportId=Number(parts[1]||0);
      if(!targetId){
        await telegram("answerCallbackQuery",{callback_query_id:q.id,text:"Пользователь не найден."});
        return;
      }
      supportReplyTargets.set(OWNER_CHAT_ID,{telegramId:targetId,supportId:Number.isInteger(supportId)&&supportId>0?supportId:null});
      await telegram("answerCallbackQuery",{callback_query_id:q.id,text:"Напишите следующий текст — он уйдёт пользователю."});
      await sendTelegram(OWNER_CHAT_ID,"✍️ Напишите ответ следующим сообщением.\n\nОн будет отправлен пользователю "+targetId+".");
    }
    return;
  }

  const msg=update.message;
  if(!msg?.chat?.id) return;
  const chatId=clean(msg.chat.id);
  const text=clean(msg.text);
  if(chatId!==OWNER_CHAT_ID) return;

  const pending=supportReplyTargets.get(OWNER_CHAT_ID);
  if(pending?.telegramId && text && !text.startsWith("/")){
    const sent=await sendTelegram(pending.telegramId,"💬 Ответ от Такси Речица:\n\n"+text);
    if(sent.ok){
      if(pending.supportId) await db("UPDATE support_messages SET reply_text=$1,replied_at=NOW() WHERE id=$2",[text,pending.supportId]);
      await sendTelegram(OWNER_CHAT_ID,"✅ Ответ отправлен пользователю.");
      supportReplyTargets.delete(OWNER_CHAT_ID);
    }else{
      await sendTelegram(OWNER_CHAT_ID,"❌ Не удалось отправить ответ: "+(sent.description||"пользователь недоступен."));
    }
    return;
  }

  if(text==="/start"){
    const url=clean(process.env.APP_URL || process.env.RENDER_EXTERNAL_URL).replace(/\/$/,"");
    await sendTelegram(OWNER_CHAT_ID,url?"🚕 Такси Речица\n\nОткройте Mini App через кнопку меню Telegram.":"🚕 Такси Речица");
  }
}

async function telegramPoll(){
  if(!BOT_TOKEN||!OWNER_CHAT_ID||telegramPollingStarted)return;
  telegramPollingStarted=true;
  try{
    await telegram("deleteWebhook",{drop_pending_updates:false});
  }catch(e){console.error("Telegram webhook:",e.message);}
  const loop=async()=>{
    try{
      const r=await telegram("getUpdates",{offset:telegramUpdateOffset,timeout:25,allowed_updates:["message","callback_query"]});
      if(r.ok){
        for(const update of r.result||[]){
          telegramUpdateOffset=Math.max(telegramUpdateOffset,Number(update.update_id)+1);
          try{await handleTelegramUpdate(update);}catch(e){console.error("Telegram update:",e.message);}
        }
      }else{
        console.error("Telegram polling:",r.description||"unknown error");
      }
    }catch(e){console.error("Telegram polling:",e.message);}
    setTimeout(loop,1000);
  };
  loop();
}

async function notifyDueScheduledOrders(){
  if(!pool || !DRIVER_CHAT_IDS.length) return;
  try{
    const r=await db(`SELECT * FROM orders WHERE status='searching' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW() + INTERVAL '30 minutes' AND scheduled_at > NOW() - INTERVAL '2 hours' AND driver_notified_at IS NULL ORDER BY scheduled_at ASC LIMIT 20`);
    for(const order of r.rows){ await notifyDrivers(order); await db("UPDATE orders SET driver_notified_at=NOW() WHERE id=$1",[order.id]); }
  }catch(e){console.error("Scheduled dispatch:",e.message);}
}
setInterval(notifyDueScheduledOrders,30000);
setTimeout(notifyDueScheduledOrders,5000);

app.get("/api/owner-orders", async (req,res)=>{
  try{
    const owner=clean(req.query.telegramId);
    if(!owner||owner!==OWNER_CHAT_ID) return res.status(403).json({success:false,error:"Нет доступа."});
    const r=await db(`SELECT o.*, COALESCE(d.phone,o.driver_phone) AS driver_phone FROM orders o LEFT JOIN drivers d ON d.telegram_id=o.driver_telegram_id ORDER BY o.created_at DESC LIMIT 100`);
    res.json({success:true,orders:r.rows});
  }catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post("/api/owner-orders/:orderId/cancel", async (req,res)=>{
  try{
    const owner=clean(req.body.telegramId), orderId=clean(req.params.orderId);
    if(!owner||owner!==OWNER_CHAT_ID) return res.status(403).json({success:false,error:"Нет доступа."});
    const r=await db(`UPDATE orders SET status='cancelled',waiting_started_at=NULL WHERE id=$1 AND status=ANY($2::text[]) RETURNING *`,[orderId,ACTIVE_STATUSES]);
    if(!r.rows[0]) return res.status(404).json({success:false,error:"Активный заказ не найден."});
    await notifyPassenger(r.rows[0],"❌ Заказ отменён владельцем сервиса.");
    if(r.rows[0].driver_telegram_id) await sendTelegram(r.rows[0].driver_telegram_id,"❌ Заказ отменён владельцем сервиса.");
    res.json({success:true,order:r.rows[0]});
  }catch(e){res.status(500).json({success:false,error:e.message});}
});
app.get("/api/owner-dashboard", async (req,res)=>{
  try{
    const owner=clean(req.query.telegramId), period=clean(req.query.period)||"month", selected=clean(req.query.date)||"";
    if(!owner||owner!==OWNER_CHAT_ID) return res.status(403).json({success:false,error:"Нет доступа."});
    // Month picker sends YYYY-MM, while PostgreSQL date expects YYYY-MM-DD.
    // Normalize the selected period before using it in SQL.
    const selectedDate=period==="month" && /^\\d{4}-\\d{2}$/.test(selected) ? selected+"-01" : selected;
    const stats=period==="day"
      ? (await db("SELECT COUNT(*)::int AS orders,COALESCE(SUM(amount+waiting_fee),0)::numeric AS revenue FROM orders WHERE status='completed' AND completed_at >= COALESCE(NULLIF($1,'')::date,CURRENT_DATE) AND completed_at < COALESCE(NULLIF($1,'')::date,CURRENT_DATE)+INTERVAL '1 day'",[selectedDate])).rows[0]
      : (await db("SELECT COUNT(*)::int AS orders,COALESCE(SUM(amount+waiting_fee),0)::numeric AS revenue FROM orders WHERE status='completed' AND completed_at >= date_trunc('month',COALESCE(NULLIF($1,'')::date,CURRENT_DATE)) AND completed_at < date_trunc('month',COALESCE(NULLIF($1,'')::date,CURRENT_DATE))+INTERVAL '1 month'",[selectedDate])).rows[0];
    const chartMonth=(selectedDate||new Date().toISOString().slice(0,7)).slice(0,7);
    const daily=(await db("SELECT EXTRACT(DAY FROM completed_at)::int AS day,COUNT(*)::int AS orders,COALESCE(SUM(amount+waiting_fee),0)::numeric AS revenue FROM orders WHERE status='completed' AND completed_at >= date_trunc('month',$1::date) AND completed_at < date_trunc('month',$1::date)+INTERVAL '1 month' GROUP BY 1 ORDER BY 1",[chartMonth+"-01"])).rows;
    const monthly=(await db("SELECT TO_CHAR(date_trunc('month',completed_at),'YYYY-MM') AS month,COUNT(*)::int AS orders,COALESCE(SUM(amount+waiting_fee),0)::numeric AS revenue FROM orders WHERE status='completed' AND completed_at >= date_trunc('month',$1::date)-INTERVAL '11 months' AND completed_at < date_trunc('month',$1::date)+INTERVAL '1 month' GROUP BY 1 ORDER BY 1",[chartMonth+"-01"])).rows;
    const active=(await db(`SELECT id,status,passenger_name,pickup,destination,amount,waiting_fee,distance_km,waiting_seconds,scheduled_at,created_at FROM orders WHERE status=ANY($1::text[]) ORDER BY created_at DESC LIMIT 1`,[ACTIVE_STATUSES])).rows[0]||null;
    const ratings=(await db(`SELECT COUNT(*)::int AS count,COALESCE(AVG(rating),0)::numeric AS avg FROM ratings`)).rows[0];
    const ratingDist=(await db(`SELECT rating,COUNT(*)::int AS count FROM ratings GROUP BY rating ORDER BY rating DESC`)).rows;
    const liked=(await db(`SELECT item,COUNT(*)::int AS count FROM ratings r CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.good)='array' THEN r.good ELSE '[]'::jsonb END) item GROUP BY item ORDER BY count DESC,item`)).rows;
    const comments=(await db(`SELECT rating,good,comment,created_at FROM ratings WHERE comment IS NOT NULL AND TRIM(comment)<>'' ORDER BY created_at DESC LIMIT 30`)).rows;
    const support=(await db(`SELECT COUNT(*) FILTER(WHERE replied_at IS NULL)::int AS open,COUNT(*)::int AS total FROM support_messages`)).rows[0];
    const recent=(await db(`SELECT id,status,passenger_name,passenger_phone,pickup,destination,amount,waiting_fee,distance_km,waiting_seconds,scheduled_at,created_at,completed_at,driver_name,driver_car,driver_plate FROM orders ORDER BY created_at DESC LIMIT 100`)).rows;
    res.json({success:true,period,selectedDate:selected||null,stats,daily,monthly,active,ratings,ratingDist,liked,comments,support,recent});
  }catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get("/api/owner-support", async (req,res)=>{
  try{
    const owner=clean(req.query.telegramId);
    if(!owner||owner!==OWNER_CHAT_ID) return res.status(403).json({success:false,error:"Нет доступа."});
    const r=await db(`SELECT id,telegram_id,role,kind,message,order_id,reply_text,created_at,replied_at FROM support_messages ORDER BY created_at DESC LIMIT 100`);
    res.json({success:true,messages:r.rows});
  }catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get("/api/health", async (req,res) => {
  let database=false;
  try { if(pool){await db("SELECT 1");database=true;} } catch(_){}
  res.json({success:true,database,telegram:Boolean(BOT_TOKEN),driversConfigured:DRIVER_CHAT_IDS.length,supportConfigured:Boolean(OWNER_CHAT_ID),time:new Date().toISOString()});
});

app.get("/api/user-role", async (req,res) => {
  try {
    const telegramId=clean(req.query.telegramId);
    if(!telegramId) return res.status(400).json({success:false,error:"Telegram ID не указан."});
    if(isDriver(telegramId)){
      const r=await db("SELECT telegram_id,name,phone,car,plate,has_child_seat,rating,rating_count FROM drivers WHERE telegram_id=$1",[telegramId]);
      return res.json({success:true,role:"driver",driver:r.rows[0]||null,telegramId,isOwner:telegramId===OWNER_CHAT_ID});
    }
    res.json({success:true,role:"passenger",driver:null,telegramId,isOwner:telegramId===OWNER_CHAT_ID});
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

app.get("/api/saved-addresses", async (req,res)=>{
  try{
    const id=clean(req.query.telegramId);
    if(!id||isDriver(id)) return res.status(403).json({success:false,error:"Нет доступа."});
    const r=await db("SELECT id,label,address,lat,lng FROM saved_addresses WHERE telegram_id=$1 ORDER BY CASE label WHEN 'Дом' THEN 1 WHEN 'Работа' THEN 2 ELSE 3 END, label",[id]);
    res.json({success:true,addresses:r.rows});
  }catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post("/api/saved-addresses", async (req,res)=>{
  try{
    const id=clean(req.body.telegramId), label=clean(req.body.label), address=clean(req.body.address);
    if(!id||isDriver(id)) return res.status(403).json({success:false,error:"Нет доступа."});
    if(!label||!address) return res.status(400).json({success:false,error:"Укажите название и адрес."});
    if(label.length>30||address.length>300) return res.status(400).json({success:false,error:"Слишком длинное название или адрес."});
    const lat=Number(req.body.lat), lng=Number(req.body.lng);
    const r=await db(`INSERT INTO saved_addresses(telegram_id,label,address,lat,lng)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(telegram_id,label) DO UPDATE SET address=$3,lat=$4,lng=$5,updated_at=NOW()
      RETURNING id,label,address,lat,lng`,
      [id,label,address,Number.isFinite(lat)?lat:null,Number.isFinite(lng)?lng:null]);
    res.json({success:true,address:r.rows[0]});
  }catch(e){res.status(500).json({success:false,error:e.message});}
});

app.delete("/api/saved-addresses/:id", async (req,res)=>{
  try{
    const id=clean(req.query.telegramId), addressId=Number(req.params.id);
    if(!id||isDriver(id)||!Number.isInteger(addressId)) return res.status(403).json({success:false,error:"Нет доступа."});
    const r=await db("DELETE FROM saved_addresses WHERE id=$1 AND telegram_id=$2 RETURNING id",[addressId,id]);
    if(!r.rows[0]) return res.status(404).json({success:false,error:"Адрес не найден."});
    res.json({success:true});
  }catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post("/api/orders", async (req,res)=>{
  try {
    const passengerId=clean(req.body.telegramId);
    if(!passengerId||isDriver(passengerId)) return res.status(403).json({success:false,error:"Заказ может создать только пассажир."});
    const pickup=clean(req.body.pickup), destination=clean(req.body.destination);
    if(!pickup||!destination) return res.status(400).json({success:false,error:"Укажите точки А и Б."});
    const p=(await db("SELECT name,phone FROM passengers WHERE telegram_id=$1",[passengerId])).rows[0];
    if(!p?.name||!p?.phone) return res.status(400).json({success:false,error:"Сначала заполните профиль пассажира."});
    const activeOrder=(await db("SELECT id,status FROM orders WHERE passenger_telegram_id=$1 AND status=ANY($2::text[]) ORDER BY created_at DESC LIMIT 1",[passengerId,ACTIVE_STATUSES])).rows[0];
    if(activeOrder) return res.status(409).json({success:false,error:"У вас уже есть активный заказ. Сначала завершите или отмените его."});
    const scheduledAt=req.body.scheduledAt?new Date(req.body.scheduledAt):null;
    if(scheduledAt&&Number.isNaN(scheduledAt.getTime())) return res.status(400).json({success:false,error:"Неверная дата и время."});
    if(scheduledAt && scheduledAt.getTime() <= Date.now()) return res.status(400).json({success:false,error:"Дата предварительного заказа должна быть в будущем."});
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
    const r=await db(`SELECT o.*, COALESCE(d.phone,o.driver_phone) AS driver_phone, d.rating AS driver_rating
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
    const r=await db(`SELECT * FROM orders WHERE status='searching' AND (scheduled_at IS NULL OR scheduled_at <= NOW() + INTERVAL '30 minutes')
      AND (rejected_by_driver_telegram_id IS NULL OR rejected_by_driver_telegram_id<>$1)
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
    const busy=(await db("SELECT id FROM orders WHERE driver_telegram_id=$1 AND status=ANY($2::text[]) LIMIT 1",[driverId,ACTIVE_STATUSES])).rows[0];
    if(busy) return res.status(409).json({success:false,error:"У вас уже есть текущая поездка. Сначала завершите её."});
    const r=await db(`UPDATE orders SET status='accepted',driver_telegram_id=$1,driver_name=$2,driver_car=$3,driver_plate=$4,driver_phone=$5,accepted_at=NOW()
      WHERE id=$6 AND status='searching' AND NOT EXISTS (
        SELECT 1 FROM orders x WHERE x.driver_telegram_id=$1 AND x.status=ANY($7::text[])
      ) RETURNING *`,[driverId,d.name,d.car,d.plate,d.phone,orderId,ACTIVE_STATUSES]);
    if(!r.rows[0]) return res.status(409).json({success:false,error:"Заказ уже принят или у водителя уже есть текущая поездка."});
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
    const current=(await db("SELECT status,scheduled_at,waiting_started_at FROM orders WHERE id=$1 AND driver_telegram_id=$2",[orderId,driverId])).rows[0];
    if(!current) return res.status(404).json({success:false,error:"Заказ не найден или он уже не принадлежит вам."});
    if(!allowed[next].includes(current.status)) return res.status(409).json({success:false,error:"Сейчас этот переход статуса недоступен."});
    if(next==="completed"){
      await db(`UPDATE orders SET
        waiting_seconds=waiting_seconds+
          CASE WHEN waiting_started_at IS NULL THEN 0 ELSE GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (NOW()-waiting_started_at)))::int) END,
        waiting_minutes=GREATEST(0,CEIL((
          waiting_seconds+
          CASE WHEN waiting_started_at IS NULL THEN 0 ELSE FLOOR(EXTRACT(EPOCH FROM (NOW()-waiting_started_at)))::int END
        )/10)::int),
        waiting_fee=GREATEST(0,CEIL((
          waiting_seconds+
          CASE WHEN waiting_started_at IS NULL THEN 0 ELSE FLOOR(EXTRACT(EPOCH FROM (NOW()-waiting_started_at)))::int END
        )::numeric/10)*0.10),
        waiting_started_at=NULL
        WHERE id=$1 AND driver_telegram_id=$2`,[orderId,driverId]);
    }
    const r=await db(`UPDATE orders SET status=$1,${col}=NOW() WHERE id=$2 AND driver_telegram_id=$3 AND status=ANY($4::text[]) RETURNING *`,
      [next,orderId,driverId,allowed[next]]);
    if(!r.rows[0]) return res.status(409).json({success:false,error:"Статус уже изменён."});
    const msg=next==="completed"
      ? `🏁 Поездка завершена.\\n\\n💰 Поездка: ${Number(r.rows[0].amount).toFixed(2)} BYN\\n⏱ Ожидание: ${Number(r.rows[0].waiting_fee||0).toFixed(2)} BYN\\n💳 Итого: ${(Number(r.rows[0].amount)+Number(r.rows[0].waiting_fee||0)).toFixed(2)} BYN`
      : {arrived:"📍 Водитель на месте.",trip:"🚕 Поездка началась."}[next];
    await notifyPassenger(r.rows[0],msg);
    res.json({success:true,order:r.rows[0]});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post("/api/orders/:orderId/waiting", async (req,res)=>{
  try {
    const driverId=clean(req.body.telegramId), orderId=clean(req.params.orderId);
    if(!isDriver(driverId)) return res.status(403).json({success:false,error:"Нет доступа водителя."});
    const current=(await db("SELECT * FROM orders WHERE id=$1 AND driver_telegram_id=$2 AND status='trip'",[orderId,driverId])).rows[0];
    if(!current) return res.status(409).json({success:false,error:"Ожидание сейчас недоступно."});
    if(current.scheduled_at) return res.status(409).json({success:false,error:"Ожидание доступно только для заказа «Сейчас»."});

    if(!current.waiting_started_at){
      const r=await db("UPDATE orders SET waiting_started_at=NOW(), waiting_minutes=GREATEST(1,waiting_minutes), waiting_fee=GREATEST(0.10,waiting_fee) WHERE id=$1 AND driver_telegram_id=$2 RETURNING *",[orderId,driverId]);
      return res.json({success:true,action:"started",order:r.rows[0]});
    }

    const r=await db(`UPDATE orders
      SET waiting_seconds=waiting_seconds+
          GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (NOW()-waiting_started_at)))::int),
          waiting_minutes=GREATEST(0,CEIL((
            waiting_seconds+
            GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (NOW()-waiting_started_at)))::int)
          )/60)::int),
          waiting_fee=GREATEST(0,CEIL((
            waiting_seconds+
            GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (NOW()-waiting_started_at)))::int)
          )::numeric/10)*0.10),
          waiting_started_at=NULL
      WHERE id=$1 AND driver_telegram_id=$2
      RETURNING *`,[orderId,driverId]);
    const charged=Number(r.rows[0].waiting_minutes)-Number(current.waiting_minutes||0);
    if(charged>0) await notifyPassenger(r.rows[0],`⏱ Ожидание: начислено ${charged} мин • +${(charged*0.60).toFixed(2)} BYN. Всего ${r.rows[0].waiting_minutes} мин • ${Number(r.rows[0].waiting_fee).toFixed(2)} BYN`);
    res.json({success:true,action:"stopped",order:r.rows[0]});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post("/api/orders/:orderId/reject", async (req,res)=>{
  try {
    const driverId=clean(req.body.telegramId), orderId=clean(req.params.orderId);
    if(!isDriver(driverId)) return res.status(403).json({success:false,error:"Нет доступа водителя."});
    const r=await db(`UPDATE orders
      SET status='cancelled',rejected_by_driver_telegram_id=$1,rejected_at=NOW()
      WHERE id=$2 AND status='searching' RETURNING *`,[driverId,orderId]);
    if(!r.rows[0]) return res.status(409).json({success:false,error:"Заказ уже недоступен."});
    await notifyPassenger(r.rows[0],"❌ Водитель отклонил заказ. Пожалуйста, оформите новый заказ.");
    res.json({success:true,order:r.rows[0]});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post("/api/orders/:orderId/cancel", async (req,res)=>{
  try {
    const uid=clean(req.body.telegramId), oid=clean(req.params.orderId);
    const current=(await db("SELECT * FROM orders WHERE id=$1 AND passenger_telegram_id=$2 AND status IN ('searching','accepted','arrived')",[oid,uid])).rows[0];
    if(!current) return res.status(409).json({success:false,error:"Заказ уже нельзя отменить после начала поездки."});
    if(current.waiting_started_at){
      await db(`UPDATE orders SET
        waiting_seconds=waiting_seconds+GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (NOW()-waiting_started_at)))::int),
        waiting_minutes=GREATEST(0,CEIL((waiting_seconds+GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (NOW()-waiting_started_at)))::int))/10)::int),
        waiting_fee=GREATEST(0,CEIL(((waiting_seconds+GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (NOW()-waiting_started_at)))::int))::numeric)/10)*0.10),
        waiting_started_at=NULL
        WHERE id=$1`,[oid]);
    }
    const r=await db("UPDATE orders SET status='cancelled' WHERE id=$1 AND passenger_telegram_id=$2 AND status IN ('searching','accepted','arrived') RETURNING *",[oid,uid]);
    if(!r.rows[0]) return res.status(409).json({success:false,error:"Заказ уже изменён."});
    if(r.rows[0].driver_telegram_id) await sendTelegram(r.rows[0].driver_telegram_id,"❌ Пассажир отменил заказ.");
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
  migrate().then(async()=>{await setTelegramMenu();await telegramPoll();}).catch(e=>console.error("Startup:",e));
});
