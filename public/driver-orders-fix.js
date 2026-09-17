(() => {
  let busy = false;
  let timer = null;

  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));

  function container(){ return document.getElementById('driverOrders'); }

  function message(title, text, icon='✓'){
    const c=container();
    if(!c) return;
    c.innerHTML=`<div class="status-box"><div class="status-icon">${icon}</div><div class="status-title">${title}</div><div class="status-text">${text}</div></div>`;
  }

  function orderCard(o){
    const status=String(o.status||'accepted');
    const badge=status==='arrived'?'На месте':status==='trip'?'В поездке':'Принят';
    let button='';
    if(status==='accepted') button=`<button class="arrived" onclick="driverArrived('${esc(String(o.id))}')">🚕 Я на месте</button>`;
    if(status==='arrived') button=`<button class="start" onclick="startTrip('${esc(String(o.id))}')">▶ Начать поездку</button>`;
    if(status==='trip') button=`<button class="complete" onclick="completeOrder('${esc(String(o.id))}')">✓ Завершить поездку</button>`;
    return `<div class="driver-order"><div class="driver-order-head"><div class="order-number">Заказ №${esc(o.id)}</div><div class="order-badge">${badge}</div></div><div class="route"><div class="route-line"><div class="route-dot"></div><div class="route-text">${esc(o.addressA||'Адрес подачи')}</div></div><div class="route-line"><div class="route-dot end"></div><div class="route-text">${esc(o.addressB||'Адрес назначения')}</div></div></div><div class="driver-details"><div class="detail"><span>Время</span><strong>${esc(o.scheduled||'Сейчас')}</strong></div><div class="detail"><span>Тариф</span><strong>${esc(o.tariff||'Эконом')}</strong></div><div class="detail"><span>Детское кресло</span><strong>${o.childSeat?'👶 Нужно':'Не нужно'}</strong></div><div class="detail"><span>Клиент</span><strong>${esc(o.passengerName||'Пассажир')}</strong></div></div><div class="driver-buttons">${button}</div></div>`;
  }

  async function load(){
    if(busy) return;
    const c=container();
    if(!c || !window.telegramUserId) return;
    busy=true;
    c.innerHTML='<div class="status-box"><div class="loader"></div><div class="status-title">Загружаем заказы</div><div class="status-text">Получаем актуальные заявки…</div></div>';
    const controller=new AbortController();
    timer=setTimeout(()=>controller.abort(),8000);
    try{
      const r=await fetch(`/api/driver-orders?telegramId=${encodeURIComponent(window.telegramUserId)}`,{cache:'no-store',signal:controller.signal});
      if(r.status===401||r.status===403){message('Нет доступа водителя','Проверьте Telegram ID водителя и DRIVER_CHAT_IDS в Render.','🔒');return;}
      if(!r.ok) throw new Error(`Сервер ответил ${r.status}`);
      const data=await r.json();
      const orders=Array.isArray(data)?data:(Array.isArray(data.orders)?data.orders:[]);
      if(!orders.length){message('Активных заказов нет','Когда появится новый заказ, он автоматически появится здесь.','✓');return;}
      c.innerHTML=orders.map(orderCard).join('');
    }catch(e){
      console.error('DRIVER ORDERS:',e);
      message('Не удалось загрузить заказы',e.name==='AbortError'?'Сервер не ответил за 8 секунд.':'Проверьте интернет или сервер.','!');
    }finally{
      clearTimeout(timer);timer=null;busy=false;
    }
  }

  function boot(){
    window.loadDriverOrders=load;
    const c=container();
    if(c && !c.dataset.fixReady) c.dataset.fixReady='1';
    if(window.__isTaxiDriver) load();
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else setTimeout(boot,100);
})();
