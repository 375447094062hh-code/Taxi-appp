(() => {
  const tg = window.Telegram?.WebApp;
  const userId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : '';
  let shownFor = '';

  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function styles(){
    if(document.getElementById('feedbackCss')) return;
    const s=document.createElement('style'); s.id='feedbackCss';
    s.textContent=`
      .feedback-card{margin-top:12px;padding:17px;border-radius:22px;background:rgba(17,24,39,.96);border:1px solid #202b3e}
      .feedback-title{font-size:16px;font-weight:900;margin-bottom:6px}.feedback-sub{font-size:11px;color:#7f8ca3;line-height:1.45}
      .feedback-stars{display:flex;justify-content:center;gap:6px;margin:15px 0 12px}.feedback-star{width:42px;height:42px;border-radius:12px;background:#0d1421;border:1px solid #293449;color:#536177;font-size:22px}.feedback-star.active{background:rgba(250,204,21,.10);border-color:#facc15;color:#facc15}
      .feedback-section{margin-top:13px}.feedback-label{display:block;font-size:10px;color:#7f8ca3;font-weight:800;margin-bottom:8px;text-transform:uppercase}
      .feedback-options{display:grid;grid-template-columns:1fr 1fr;gap:7px}.feedback-option{min-height:39px;padding:7px 9px;border-radius:11px;background:#0d1421;border:1px solid #243044;color:#cbd5e1;font-size:10px;font-weight:700;text-align:left}.feedback-option.active{border-color:#facc15;background:rgba(250,204,21,.08);color:#fff}
      .feedback-comment{width:100%;min-height:82px;resize:vertical;border-radius:13px;padding:11px;background:#0d1421;border:1px solid #243044;color:#fff;outline:none;font-size:11px}
      .feedback-send{width:100%;height:46px;margin-top:12px;border-radius:14px;background:#facc15;color:#17120a;font-weight:900;font-size:12px}.feedback-send:disabled{opacity:.5}
    `;document.head.appendChild(s);
  }

  function card(orderId){
    let el=document.getElementById('passengerFeedbackCard');
    if(el) el.remove();
    el=document.createElement('div'); el.id='passengerFeedbackCard'; el.className='feedback-card';
    el.innerHTML=`
      <div class="feedback-title">⭐ Как прошла поездка?</div>
      <div class="feedback-sub">Оцените поездку и помогите нам сделать сервис лучше.</div>
      <div class="feedback-stars" id="feedbackStars">
        ${[1,2,3,4,5].map(n=>`<button type="button" class="feedback-star" data-rating="${n}">★</button>`).join('')}
      </div>
      <div class="feedback-section"><span class="feedback-label">Что устроило</span><div class="feedback-options" id="feedbackGood">
        ${['Приехал вовремя','Вежливый водитель','Чистый автомобиль','Спокойная езда'].map(x=>`<button type="button" class="feedback-option" data-value="${esc(x)}">✓ ${esc(x)}</button>`).join('')}
      </div></div>
      <div class="feedback-section"><span class="feedback-label">Что не устроило</span><div class="feedback-options" id="feedbackBad">
        ${['Опоздал','Грубость','Грязный салон','Резкая езда','Другое'].map(x=>`<button type="button" class="feedback-option" data-value="${esc(x)}">✕ ${esc(x)}</button>`).join('')}
      </div></div>
      <div class="feedback-section"><span class="feedback-label">Комментарий</span><textarea id="feedbackComment" class="feedback-comment" maxlength="1000" placeholder="Напишите, что понравилось или что нужно улучшить..."></textarea></div>
      <button id="feedbackSend" class="feedback-send" disabled>Оставить оценку</button>`;
    const anchor=document.getElementById('orderForm') || document.getElementById('tripCard') || document.getElementById('passengerScreen');
    anchor.parentNode.insertBefore(el,anchor.nextSibling);

    let rating=0;
    el.querySelectorAll('.feedback-star').forEach(b=>b.onclick=()=>{rating=Number(b.dataset.rating);el.querySelectorAll('.feedback-star').forEach(x=>x.classList.toggle('active',Number(x.dataset.rating)<=rating));el.querySelector('#feedbackSend').disabled=false});
    el.querySelectorAll('.feedback-option').forEach(b=>b.onclick=()=>b.classList.toggle('active'));
    el.querySelector('#feedbackSend').onclick=async()=>{
      const btn=el.querySelector('#feedbackSend'); btn.disabled=true; btn.textContent='⏳ Отправляем...';
      const good=[...el.querySelectorAll('#feedbackGood .active')].map(x=>x.dataset.value);
      const bad=[...el.querySelectorAll('#feedbackBad .active')].map(x=>x.dataset.value);
      try{
        const r=await fetch('/api/passenger-feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telegramId:userId,orderId,rating,good,bad,comment:el.querySelector('#feedbackComment').value.trim()})});
        const d=await r.json(); if(!r.ok) throw Error(d.error||'Не удалось сохранить оценку');
        el.innerHTML='<div class="feedback-title">✅ Спасибо за оценку!</div><div class="feedback-sub">Ваш отзыв сохранён. Он поможет улучшать работу Такси Речица.</div>';
      }catch(e){btn.disabled=false;btn.textContent='Оставить оценку';if(window.toast)window.toast(e.message,true);}
    };
  }

  async function inspect(orderId){
    if(!userId||!orderId||shownFor===String(orderId)) return;
    try{
      const r=await fetch(`/api/order-status?id=${encodeURIComponent(orderId)}`); if(!r.ok)return;
      const d=await r.json(); if(d?.status!=='completed')return;
      shownFor=String(orderId); card(String(orderId));
    }catch(_){ }
  }

  function patchFetch(){
    if(window.__feedbackFetchPatched)return; window.__feedbackFetchPatched=true;
    const original=window.fetch.bind(window);
    window.fetch=async(...args)=>{
      const response=await original(...args);
      try{
        const url=String(args[0]||'');
        if(url.includes('/api/order-status')){
          const clone=response.clone(); const data=await clone.json();
          if(data?.status==='completed') inspect(data.id||new URL(url,location.origin).searchParams.get('id'));
        }
      }catch(_){ }
      return response;
    };
  }

  function boot(){styles();patchFetch();}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
