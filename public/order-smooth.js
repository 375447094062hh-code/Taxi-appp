(() => {
  function loadDriverOrdersFix() {
    if (document.getElementById('driverOrdersFixScript')) return;
    const s = document.createElement('script');
    s.id = 'driverOrdersFixScript';
    s.src = '/driver-orders-fix.js?v=3';
    s.onload = () => window.loadDriverOrders?.();
    s.onerror = () => console.error('Не загрузился driver-orders-fix.js');
    document.body.appendChild(s);
  }

  function boot() {
    loadDriverOrdersFix();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();