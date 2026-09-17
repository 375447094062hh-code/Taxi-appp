(() => {
  function boot(){
    if(document.getElementById('driverModeButton')) return;
    const hero=document.querySelector('#passengerScreen .hero .quick-buttons');
    if(!hero) return;
    const b=document.createElement('button');
    b.id='driverModeButton'; b.className='quick-btn secondary'; b.textContent='🚗 Режим водителя';
    b.onclick=()=>window.openDriverMode?.();
    hero.appendChild(b);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();
  new MutationObserver(boot).observe(document.body,{childList:true,subtree:true});
})();