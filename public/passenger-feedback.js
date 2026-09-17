(() => {
  const tg = window.Telegram?.WebApp;
  const userId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : '';
  let shownFor = '';

  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function styles(){
    if(document.getElementById('feedbackCss')) return;
    const s=document.createElement('style'); s.id='feedbackCss';
    s.textContent=`
      .feedback-overlay{position:fixed;inset:0;z-index:99999;background:rgba(2,6,15,.78);backdrop-filter:blur(10px);display:flex;align-items:flex-end;justify-content:center;padding:14px}
      .feedback-modal{width:min(100%,410px);max-height:92vh;overflow:auto;border-radius:28px;background:linear-gradient(180deg,#182235,#101725);border:1px solid #2b3850;box-shadow:0 24px 70px rgba(0,0,0,.55);padding:22px 18px 18px;animation:feedbackUp .22s ease-out}
      @keyframes feedbackUp{from{transform:translateY(35px);opacity:0}to{transform:translateY(0);opacity:1}}
      .feedback-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
      .feedback-title{font-size:20px;font-weight:900;color:#fff}.feedback-close{width:34px;height:34px;border-radius:11px;background:#0d1421;border:1px solid #2a374d;color:#9aa8bd;font-size:18px}
      .feedback-sub{font-size:12px;color:#8794a8;line-height:1.5;margin-bottom:14px}
      .feedback-stars{display:flex;justify-content:center;gap:8px;margin:8px 0 18px}.feedback-star{width:48px;height:48px;border-radius:14px;background:#0d1421;border:1px solid #2a374d;color:#4b5a70;font-size:25px}.feedback-star.active{background:rgba(250,204,21,.12);border-color:#facc15;color:#facc15}
      .feedback-section{margin-top:15px}.feedback-label{display:block;font-size:10px;color:#8491a5;font-weight:900;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px}
      .feedback-options{display:grid;grid-template-columns:1fr 1fr;gap:8px}.feedback-option{min-height:43px;padding:8px 10px;border-radius:13px;background:#0d1421;border:1px solid #26344a;color:#cbd5e1;font-size:11px;font-weight:700;text-align:left}.feedback-option.active{border-color:#facc15;background:rgba(250,204,21,.09);color:#fff}
      .feedback-option.good.active{border-color:#22c55e;background:rgba(34,197,94,.09)}.feedback-option.bad.active{border-color:#ef4444;background:rgba(239,68,68,.08)}
      .feedback-comment{box-sizing:border-box;width:100%;min-height:88px;resize:vertical;border-radius:14px;padding:11px;background:#0d1421;border:1px solid #26344a;color:#fff;outline:none;font-size:12px}
      .feedback-send{width:100%;height:48px;margin-top:14px;border-radius:15px;background:#facc15;color:#17120a;border:0;font-weight:900;font-size:13px}.feedback-send:disabled{opacity:.45}
      .feedback-skip{width:100%;height:42px;margin-top:7px;border-radius:13px;background:transparent;color:#8491a5;border:0;font-weight:700;font-size:12px}
      .feedback-thanks{text-align:center;padding:24px 6px 12px}.feedback-thanks-icon{font-size:42px;margin-bottom:8px}
    `;
    document.head.appendChild(s);
  }

  function closeModal(){
    const el=document.getElementById('passengerFeedbackOverlay');
    if(el) el.remove();
  }

  function card(orderId){
    closeModal();
    const overlay=document.createElement('div');
    overlay.id='passengerFeedbackOverlay';
    overlay.className='feedback-overlay';
    overlay.innerHTML=`
      <div class="feedback-modal" role="dialog" aria-modal="true">
        <div class="feedback-head">
          <div class="feedback-title">⭐ Оцените поездку</div>
          <button type="button" class="feedback-close" id="feedbackClose">×</button>
        </div>
        <div class="feedback-sub">Поездка завершена. Расскажите, как всё прошло.</div>

        <div class="feedback-stars" id="feedbackStars">
          ${[1,2,3,4,5].map(n=>`<button type="button" class="feedback-star" data-rating="${n}" aria-label="${n} из 5">★</button>`).join('')}
        </div>

        <div class="feedback-section">
          <span class="feedback-label">Что понравилось</span>
          <div class="feedback-options" id="feedbackGood">
            ${['Приехал вовремя','Вежливый водитель','Чистота в салоне','Приятный запах','Комфортная поездка','Спокойная езда','Автомобиль в хорошем состоянии','Помог с багажом'].map(x=>`<button type="button" class="feedback-option good" data-value="${esc(x)}">✓ ${esc(x)}</button>`).join('')}
          </div>
        </div>

        <div class="feedback-section">
          <span class="feedback-label">Что можно улучшить</span>
          <div class="feedback-options" id="feedbackBad">
            ${['Приехал с опозданием','Грубость','Грязный салон','Неприятный запах','Резкая езда','Долго ехал','Другое'].map(x=>`<button type="button" class="feedback-option bad" data-value="${esc(x)}">× ${esc(x)}</button>`).join('')}
          </div>
        </div>

        <div class="feedback-section">
          <span class="feedback-label">Комментарий</span>
          <textarea id="feedbackComment" class="feedback-comment" maxlength="1000" placeholder="Напишите комментарий, если хотите..."></textarea>
        </div>

        <button id="feedbackSend" class="feedback-send" disabled>Оставить оценку</button>
        <button id="feedbackSkip" class="feedback-skip" type="button">Пропустить</button>
      </div>`;
    document.body.appendChild(overlay);

    let rating=0;
    const send=overlay.querySelector('#feedbackSend');

    overlay.querySelector('#feedbackClose').onclick=closeModal;
    overlay.querySelector('#feedbackSkip').onclick=closeModal;
    overlay.addEventListener('click',e=>{if(e.target===overlay)closeModal()});

    overlay.querySelectorAll('.feedback-star').forEach(b=>b.onclick=()=>{
      rating=Number(b.dataset.rating);
      overlay.querySelectorAll('.feedback-star').forEach(x=>x.classList.toggle('active',Number(x.dataset.rating)<=rating));
      send.disabled=false;
    });

    overlay.querySelectorAll('.feedback-option').forEach(b=>b.onclick=()=>b.classList.toggle('active'));

    send.onclick=async()=>{
      send.disabled=true;
      send.textContent='⏳ Сохраняем...';
      const good=[...overlay.querySelectorAll('#feedbackGood .active')].map(x=>x.dataset.value);
      const bad=[...overlay.querySelectorAll('#feedbackBad .active')].map(x=>x.dataset.value);
      try{
        const r=await fetch('/api/passenger-feedback',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            telegramId:userId,
            orderId,
            rating,
            good,
            bad,
            comment:overlay.querySelector('#feedbackComment').value.trim()
          })
        });
        const d=await r.json();
        if(!r.ok) throw Error(d.error||'Не удалось сохранить оценку');
        overlay.querySelector('.feedback-modal').innerHTML=`
          <div class="feedback-thanks">
            <div class="feedback-thanks-icon">✅</div>
            <div class="feedback-title">Спасибо за оценку!</div>
            <div class="feedback-sub" style="margin-top:8px">Ваш отзыв сохранён. Он поможет улучшать работу «Такси Речица».</div>
            <button id="feedbackDone" class="feedback-send">Готово</button>
          </div>`;
        overlay.querySelector('#feedbackDone').onclick=closeModal;
        setTimeout(closeModal,2200);
      }catch(e){
        send.disabled=false;
        send.textContent='Оставить оценку';
        if(window.toast)window.toast(e.message,true);
      }
    };
  }

  async function inspect(orderId){
    if(!userId||!orderId||shownFor===String(orderId)) return;
    try{
      const r=await fetch(`/api/order-status?id=${encodeURIComponent(orderId)}&t=${Date.now()}`,{cache:'no-store'});
      if(!r.ok)return;
      const d=await r.json();
      if(d?.status!=='completed')return;
      shownFor=String(orderId);
      card(String(orderId));
    }catch(_){}
  }

  function patchFetch(){
    if(window.__feedbackFetchPatched)return;
    window.__feedbackFetchPatched=true;
    const original=window.fetch.bind(window);
    window.fetch=async(...args)=>{
      const response=await original(...args);
      try{
        const url=String(args[0]||'');
        if(url.includes('/api/order-status')){
          const clone=response.clone();
          const data=await clone.json();
          if(data?.status==='completed') inspect(data.id||new URL(url,location.origin).searchParams.get('id'));
        }
      }catch(_){}
      return response;
    };
  }

  function boot(){styles();patchFetch();}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();