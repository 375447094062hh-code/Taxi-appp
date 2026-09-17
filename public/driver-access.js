(() => {
  async function check() {
    const tg=window.Telegram?.WebApp;
    const id=tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : '';
    if(!id) return;
    try {
      const r=await fetch('/api/driver-profile?telegramId='+encodeURIComponent(id));
      const taxi=document.getElementById('passengerTaxiButton');
      const driver=document.getElementById('driverModeButton');
      if(r.status===403 || !r.ok){
        if(taxi) taxi.classList.remove('hidden');
        if(driver) driver.classList.add('hidden');
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
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();
})();
