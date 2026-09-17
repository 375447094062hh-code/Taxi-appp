(() => {
  let lastStatus = '';
  let smoothTimer = null;

  async function stableCheckOrderStatus() {
    const id = window.currentOrderId;
    if (!id) return;
    try {
      const response = await fetch(`/api/order-status?id=${encodeURIComponent(id)}&t=${Date.now()}`, {cache:'no-store'});
      if (!response.ok) return;
      const data = await response.json();
      if (!data) return;
      const status = String(data.status || '');
      if (!status || status === lastStatus) return;
      lastStatus = status;
      if (status === 'searching') { window.showWaiting?.(); return; }
      if (status === 'accepted') { window.showDriver?.(data); return; }
      if (status === 'arrived') { window.hidePassengerCards?.(); document.getElementById('arrivedCard')?.classList.remove('hidden'); return; }
      if (status === 'trip') { window.hidePassengerCards?.(); document.getElementById('tripCard')?.classList.remove('hidden'); return; }
      if (status === 'completed') { window.stopPassengerPolling?.(); localStorage.removeItem('taxi_current_order_id'); window.currentOrderId=''; window.hidePassengerCards?.(); document.getElementById('orderForm')?.classList.remove('hidden'); window.toast?.('Поездка завершена.'); }
    } catch (e) { console.log('Stable order polling:', e.message); }
  }

  function stableStartPassengerPolling() {
    stableStopPassengerPolling();
    lastStatus = '';
    stableCheckOrderStatus();
    smoothTimer = setInterval(stableCheckOrderStatus, 3000);
    window.passengerPolling = smoothTimer;
  }

  function stableStopPassengerPolling() {
    if (smoothTimer) { clearInterval(smoothTimer); smoothTimer = null; }
    if (window.passengerPolling) { clearInterval(window.passengerPolling); window.passengerPolling = null; }
  }

  function loadDriverOrdersFix() {
    if (document.getElementById('driverOrdersFixScript')) return;
    const s=document.createElement('script');
    s.id='driverOrdersFixScript';
    s.src='/driver-orders-fix.js?v=2';
    s.onload=()=>window.loadDriverOrders?.();
    s.onerror=()=>console.error('Не загрузился driver-orders-fix.js');
    document.body.appendChild(s);
  }

  function boot() {
    if (window.passengerPolling) clearInterval(window.passengerPolling);
    window.startPassengerPolling = stableStartPassengerPolling;
    window.stopPassengerPolling = stableStopPassengerPolling;
    loadDriverOrdersFix();
    if (window.currentOrderId) stableStartPassengerPolling();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
