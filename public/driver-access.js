(() => {
  async function check() {
    const tg=window.Telegram?.WebApp;
    const id=tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : '';
    if(!id) return;

    const taxi=document.getElementById('passengerTaxiButton');
    const driver=document.getElementById('driverModeButton');

    try {
      const r=await fetch('/api/user-role?telegramId='+encodeURIComponent(id)+'&t='+Date.now(),{
        cache:'no-store',
        headers:{'Cache-Control':'no-cache','Pragma':'no-cache'}
      });
      const data=await r.json().catch(()=>null);

      if(!r.ok || data?.role!=='driver'){
        if(taxi) taxi.classList.remove('hidden');
        if(driver) driver.classList.add('hidden');
        window.taxiIsDriver=false;
        return;
      }

      if(taxi) taxi.classList.add('hidden');
      if(driver) driver.classList.remove('hidden');
      window.taxiIsDriver=true;
    } catch(e) {
      console.log('Driver access check:',e.message);
    }
  }

  function boot(){
    check();
    setTimeout(check,1200);
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot);
  else boot();
})();