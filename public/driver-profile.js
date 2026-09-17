(() => {
  const tg = window.Telegram?.WebApp;
  const userId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : '';

  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

  function addStyles() {
    if (document.getElementById('driverProfileCss')) return;
    const style = document.createElement('style');
    style.id = 'driverProfileCss';
    style.textContent = `
      .dp-card{margin-top:12px;padding:17px;border-radius:22px;background:rgba(17,24,39,.96);border:1px solid #202b3e}
      .dp-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:14px}
      .dp-title{font-size:15px;font-weight:900}.dp-badge{padding:6px 9px;border-radius:9px;font-size:10px;font-weight:800;background:rgba(250,204,21,.08);color:#facc15}
      .dp-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.dp-field{margin-bottom:10px}.dp-field.full{grid-column:1/-1}
      .dp-label{display:block;margin-bottom:6px;color:#7f8ca3;font-size:10px;font-weight:800}.dp-input{width:100%;height:45px;border-radius:13px;padding:0 11px;background:#0d1421;border:1px solid #293449;color:#fff;outline:none}
      .dp-input:focus{border-color:#facc15}.dp-select{width:100%;height:45px;border-radius:13px;padding:0 10px;background:#0d1421;border:1px solid #293449;color:#fff}
      .dp-photo{display:flex;align-items:center;gap:10px;padding:10px;border-radius:13px;background:#0d1421;border:1px solid #243044}.dp-photo input{display:none}.dp-photo-btn{padding:9px 11px;border-radius:10px;background:#1a2231;color:#fff;font-size:10px;font-weight:800}.dp-preview{width:48px;height:48px;border-radius:12px;object-fit:cover;background:#1a2231;display:none}
      .dp-seat{display:flex;justify-content:space-between;align-items:center;padding:12px;border-radius:13px;background:#0d1421;border:1px solid #243044}.dp-seat-text b{display:block;font-size:12px}.dp-seat-text span{font-size:10px;color:#718097}
      .dp-switch{width:44px;height:24px;position:relative}.dp-switch input{display:none}.dp-switch span{position:absolute;inset:0;background:#273247;border-radius:20px}.dp-switch span:before{content:'';position:absolute;width:18px;height:18px;left:3px;top:3px;border-radius:50%;background:#fff;transition:.2s}.dp-switch input:checked+span{background:#facc15}.dp-switch input:checked+span:before{transform:translateX(20px);background:#17120a}
      .dp-profile{display:grid;grid-template-columns:76px 1fr;gap:12px;align-items:center}.dp-avatar{width:76px;height:76px;border-radius:20px;object-fit:cover;background:#202a3a}.dp-info div{font-size:12px;margin:4px 0}.dp-info span{color:#718097}.dp-buttons{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.dp-btn{height:44px;border-radius:13px;font-size:11px;font-weight:900}.dp-edit{background:#1a2231;color:#fff;border:1px solid #293449}.dp-save{background:#facc15;color:#17120a}.dp-message{text-align:center;padding:15px;color:#7f8ca3;font-size:12px}
    `;
    document.head.appendChild(style);
  }

  function area() { return document.getElementById('driverScreen'); }

  function fileToData(file) {
    return new Promise((resolve,reject) => {
      if (!file) return resolve('');
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function renderForm(profile = {}) {
    const root = document.getElementById('driverProfilePanel');
    if (!root) return;
    root.innerHTML = `
      <div class="dp-head"><div class="dp-title">👤 Анкета водителя</div><div class="dp-badge">Заполнение в приложении</div></div>
      <div class="dp-grid">
        <div class="dp-field full"><label class="dp-label">ИМЯ</label><input id="dpName" class="dp-input" maxlength="100" value="${escapeHtml(profile.name)}" placeholder="Ваше имя"></div>
        <div class="dp-field full"><label class="dp-label">ТЕЛЕФОН</label><input id="dpPhone" class="dp-input" type="tel" maxlength="30" value="${escapeHtml(profile.phone)}" placeholder="+375 XX XXX-XX-XX"></div>
        <div class="dp-field full" id="dpBrandSlot"></div>
        <div class="dp-field"><label class="dp-label">МОДЕЛЬ</label><input id="dpModel" class="dp-input" maxlength="80" value="${escapeHtml(profile.carModel)}" placeholder="Например, Camry"></div>
        <div class="dp-field"><label class="dp-label">ГОД</label><input id="dpYear" class="dp-input" inputmode="numeric" maxlength="4" value="${escapeHtml(profile.carYear)}" placeholder="2022"></div>
        <div class="dp-field"><label class="dp-label">ЦВЕТ</label><input id="dpColor" class="dp-input" maxlength="40" value="${escapeHtml(profile.carColor)}" placeholder="Чёрный"></div>
        <div class="dp-field"><label class="dp-label">ГОСНОМЕР</label><input id="dpPlate" class="dp-input" maxlength="20" value="${escapeHtml(profile.plate)}" placeholder="1234 AB-1"></div>
        <div class="dp-field full"><label class="dp-label">ФОТО АВТОМОБИЛЯ</label><div class="dp-photo"><img id="dpCarPreview" class="dp-preview"><label class="dp-photo-btn">📷 Выбрать фото<input id="dpCarPhoto" type="file" accept="image/*"></label><span id="dpCarPhotoText" style="font-size:10px;color:#718097">Не выбрано</span></div></div>
        <div class="dp-field full"><label class="dp-label">ФОТО ВОДИТЕЛЯ</label><div class="dp-photo"><img id="dpDriverPreview" class="dp-preview"><label class="dp-photo-btn">📷 Выбрать фото<input id="dpDriverPhoto" type="file" accept="image/*"></label><span id="dpDriverPhotoText" style="font-size:10px;color:#718097">Не выбрано</span></div></div>
        <div class="dp-field full"><div class="dp-seat"><div class="dp-seat-text"><b>👶 Детское кресло</b><span>Можно принимать заказы с ребёнком</span></div><label class="dp-switch"><input id="dpSeat" type="checkbox" ${profile.hasChildSeat ? 'checked' : ''}><span></span></label></div></div>
      </div>
      <button id="dpSave" class="dp-btn dp-save" style="width:100%;margin-top:4px">💾 Сохранить профиль</button>
    `;

    const brandSlot = document.getElementById('dpBrandSlot');
    brandSlot.innerHTML = `<label class="dp-label">МАРКА</label><input id="dpBrand" class="dp-input" value="${escapeHtml(profile.carBrand)}" placeholder="Выберите марку выше или введите вручную">`;
    if (window.taxiSelectedCarBrand) document.getElementById('dpBrand').value = window.taxiSelectedCarBrand;

    ['dpCarPhoto','dpDriverPhoto'].forEach(id => document.getElementById(id).addEventListener('change', e => {
      const file = e.target.files?.[0]; if (!file) return;
      const preview = id === 'dpCarPhoto' ? document.getElementById('dpCarPreview') : document.getElementById('dpDriverPreview');
      const text = id === 'dpCarPhoto' ? document.getElementById('dpCarPhotoText') : document.getElementById('dpDriverPhotoText');
      preview.src = URL.createObjectURL(file); preview.style.display='block'; text.textContent=file.name;
    }));
    document.getElementById('dpSave').onclick = save;
  }

  function renderSaved(profile) {
    const root = document.getElementById('driverProfilePanel');
    if (!root) return;
    const photo = profile.driverPhotoData || profile.photoFileId || '';
    root.innerHTML = `
      <div class="dp-head"><div class="dp-title">👤 Профиль водителя</div><div class="dp-badge">Заполнен</div></div>
      <div class="dp-profile">
        ${photo ? `<img class="dp-avatar" src="${escapeHtml(photo)}">` : `<div class="dp-avatar" style="display:flex;align-items:center;justify-content:center;font-size:30px">👤</div>`}
        <div class="dp-info"><div><span>Имя:</span> ${escapeHtml(profile.name || '—')}</div><div><span>Телефон:</span> ${escapeHtml(profile.phone || '—')}</div><div><span>Авто:</span> ${escapeHtml([profile.carBrand,profile.carModel].filter(Boolean).join(' ') || profile.car || '—')}</div><div><span>Номер:</span> ${escapeHtml(profile.plate || '—')}</div><div><span>Кресло:</span> ${profile.hasChildSeat ? 'есть' : 'нет'}</div></div>
      </div>
      <div class="dp-buttons"><button class="dp-btn dp-edit" id="dpEdit">✏️ Редактировать</button><button class="dp-btn dp-save" id="dpRefresh">↻ Обновить</button></div>
    `;
    document.getElementById('dpEdit').onclick = () => renderForm(profile);
    document.getElementById('dpRefresh').onclick = load;
  }

  async function load() {
    const root = document.getElementById('driverProfilePanel');
    if (!root || !userId) return;
    root.innerHTML = '<div class="dp-message">Загружаем профиль водителя...</div>';
    try {
      const response = await fetch(`/api/driver-profile?telegramId=${encodeURIComponent(userId)}`);
      const data = await response.json();
      if (!response.ok) { root.innerHTML = `<div class="dp-message">${escapeHtml(data.error || 'Нет доступа водителя.')}</div>`; return; }
      if (data.profile) renderSaved(data.profile); else renderForm({});
    } catch (e) { root.innerHTML = '<div class="dp-message">Не удалось загрузить профиль.</div>'; }
  }

  async function save() {
    const button = document.getElementById('dpSave');
    const carPhoto = document.getElementById('dpCarPhoto')?.files?.[0];
    const driverPhoto = document.getElementById('dpDriverPhoto')?.files?.[0];
    button.disabled = true; button.textContent='⏳ Сохраняем...';
    try {
      const body = {
        telegramId:userId,
        name:document.getElementById('dpName').value.trim(),
        phone:document.getElementById('dpPhone').value.trim(),
        carBrand:document.getElementById('dpBrand').value.trim(),
        carModel:document.getElementById('dpModel').value.trim(),
        carYear:document.getElementById('dpYear').value.trim(),
        carColor:document.getElementById('dpColor').value.trim(),
        plate:document.getElementById('dpPlate').value.trim(),
        hasChildSeat:document.getElementById('dpSeat').checked
      };
      if (carPhoto) body.carPhotoData=await fileToData(carPhoto);
      if (driverPhoto) body.driverPhotoData=await fileToData(driverPhoto);
      if (!body.name || !body.phone || !body.carBrand || !body.carModel || !body.plate) throw new Error('Заполните имя, телефон, марку, модель и госномер.');
      const response=await fetch('/api/driver-profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const data=await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось сохранить профиль.');
      renderSaved(data.profile); if (typeof window.toast==='function') window.toast('✅ Профиль водителя сохранён.');
    } catch(e) { if (typeof window.toast==='function') window.toast(e.message,true); else alert(e.message); }
    finally { button.disabled=false; button.textContent='💾 Сохранить профиль'; }
  }

  function openDriverMode() {
    if (!userId) { if(typeof window.toast==='function') window.toast('Откройте Mini App через Telegram.',true); return; }
    document.getElementById('passengerScreen')?.classList.add('hidden');
    document.getElementById('driverScreen')?.classList.remove('hidden');
    load();
    if (typeof window.loadDriverOrders === 'function') window.loadDriverOrders();
  }

  window.openDriverMode=openDriverMode;
  window.loadDriverProfile=load;

  function boot() {
    addStyles();
    const screen=area(); if(!screen) return;
    if(!document.getElementById('driverProfilePanel')) { const panel=document.createElement('div'); panel.id='driverProfilePanel'; panel.className='dp-card'; screen.insertBefore(panel,screen.firstChild); }
    if(window.taxiSelectedCarBrand) document.addEventListener('taxi-driver-brand-change',e=>{ const input=document.getElementById('dpBrand'); if(input) input.value=e.detail.brand; });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();
})();