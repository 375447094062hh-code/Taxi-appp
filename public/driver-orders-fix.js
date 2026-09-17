(() => {
  let busy = false;
  let timer = null;
  let lastSignature = '';
  let started = false;

  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  const container = () => document.getElementById('driverOrders');
  const id = () => window.telegramUserId || window.Telegram?.WebApp?.initDataUnsafe?.user?.id || '';

  function message(title,text,icon='✓'){
    const c=container(); if(!c)return;
    const html=`<div class="status-box"><div class="status-icon">${icon}</div><div class="status-title">${title}</div><div class="status-text">${text}</div></div>`;
    if(c.innerHTML!==html)c.innerHTML=html;
  }

  function orderCard(o,available=false){
    const status=String(o.status||'accepted');
    const badge=available?'Новый заказ':status==='arrived'?'На месте':status==='trip'?'В поездке':'Принят';
    let button='';
    if(available) button=`<button class="arrived" style="background:#facc15;color:#17120a" onclick="acceptDriverOrder('${esc(String(o.id))}',this)">✅ Принять заказ</button>`;
    else if(status==='accepted') button=`<button class="arrived" onclick="driverArrived('${esc(String(o.id))}')">🚕 Я на месте</button>`;
    else if(status==='arrived') button=`<button class="start" onclick="startTrip('${esc(String(o.id))}')">▶ Начать поездку</button>`;
    else if(status==='trip') button=`<button class="complete" onclick="completeOrder('${esc(String(o.id))}')">✓ Завершить поездку</button>`;
    return `<div class="driver-order"><div class="driver-order-head"><div class="order-number">Заказ №${esc(o.id)}</div><div class="order-badge">${badge}</div></div><div class="route"><div class="route-line"><div class="route-dot"></div><div class="route-text">${esc(o.addressA||'Адрес подачи')}</div></div><div class="route-line"><div class="route-dot end"></div><div class="route-text">${esc(o.addressB||'Адрес назначения')}</div></div></div><div class="driver-details"><div class="detail"><span>Время</span><strong>${esc(o.scheduled||'Сейчас')}</strong></div><div class="detail"><span>Тариф</span><strong>${esc(o.tariff||'Эконом')}</strong></div><div class="detail"><span>Детское кресло</span><strong>${o.childSeat?'👶 Нужно':'Не нужно'}</strong></div><div class="detail"><span>Пассажир</span><strong>${esc(o.passengerName||'Пассажир')}</strong></div></div><div class="driver-buttons">${button}</div></div>`;
  }

  function render(active,available){
    const c=container(); if(!c)return;
    if(!active.length&&!available.length){message('Заказов нет','Новые заявки появятся здесь автоматически.','✓');return;}
    let html='';
    if(available.length){
      html+=`<div style="font-size:13px;font-weight:900;margin:2px 0 10px;color:#facc15">🔥 Новые заявки</div>`;
      html+=available.map(o=>orderCard(o,true)).join('');
    }
    if(active.length){
      html+=`<div style="font-size:13px;font-weight:900;margin:14px 0 10px">🚕 Мои активные заказы</div>`;
      html+=active.map(o=>orderCard(o,false)).join('');
    }
    if(c.innerHTML!==html)c.innerHTML=html;
  }

  async function load(){
    if(busy)return;
    const c=container(); if(!c||!id())return;
    busy=true;
    const controller=new AbortController();
    timer=setTimeout(()=>controller.abort(),7000);
    try{
      const q=encodeURIComponent(String(id()));
      const [a,b]=await Promise.all([
        fetch(`/api/driver-orders?telegramId=${q}`,{cache:'no-store',signal:controller.signal}),
        fetch(`/api/driver-available-orders?telegramId=${q}`,{cache:'no-store',signal:controller.signal})
      ]);
      if(a.status===401||a.status===403||b.status===401||b.status===403){message('Нет доступа водителя','Проверьте доступ водителя в Render.','🔒');return;}
      if(!a.ok||!b.ok)throw new Error('Сервер ответил с ошибкой');
      const activeData=await a.json();
      const availableData=await b.json();
      const active=Array.isArray(activeData)?activeData:[];
      const available=Array.isArray(availableData)?availableData:[];
      const signature=JSON.stringify({a:active.map(x=>[x.id,x.status]),b:available.map(x=>[x.id,x.status])});
      if(signature!==lastSignature){lastSignature=signature;render(active,available)}
    }catch(e){
      console.error('DRIVER ORDERS:',e);
      if(!lastSignature)message('Не удалось загрузить заказы',e.name==='AbortError'?'Сервер не ответил за 7 секунд.':'Проверьте интернет или сервер.','!');
    }finally{clearTimeout(timer);timer=null;busy=false}
  }

  async function acceptDriverOrder(orderId,button){
    if(!id())return;
    if(button){button.disabled=true;button.textContent='⏳ Принимаем…'}
    try{
      const r=await fetch('/api/accept-order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderId:String(orderId),telegramId:String(id())})});
      const d=await r.json();
      if(!r.ok)throw new Error(d.error||'Не удалось принять заказ');
      lastSignature='';
      if(window.toast)window.toast('✅ Заказ принят');
      await load();
    }catch(e){
      if(window.toast)window.toast(e.message,true);else alert(e.message);
      if(button){button.disabled=false;button.textContent='✅ Принять заказ'}
    }
  }

  window.acceptDriverOrder=acceptDriverOrder;
  window.loadDriverOrders=load;

  function boot(){
    if(started)return;started=true;
    const c=container(); if(c)c.dataset.fixReady='1';
    if(window.__isTaxiDriver||window.taxiIsDriver)load();
    clearInterval(window.__driverOrdersFixTimer);
    window.__driverOrdersFixTimer=setInterval(()=>{if(window.__isTaxiDriver||window.taxiIsDriver)load()},3000);
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else setTimeout(boot,100);
})();