(() => {
  const LOGO_BASE = 'https://cdn.jsdelivr.net/gh/vehiclespecs/brand-logos@main/';

  const BRANDS = [
    'Abarth','Acura','Aion','Alfa Romeo','Alpine','Aston Martin','Audi','BAIC','Bentley','BMW','BYD','Cadillac','Changan','Chery','Chevrolet','Citroen','Cupra','Dacia','Daewoo','Daihatsu','Dodge','DS','Ferrari','Fiat','Ford','Geely','Genesis','GMC','Great Wall','Haval','Honda','Hongqi','Hyundai','Infiniti','Isuzu','Jaguar','Jeep','Kia','Koenigsegg','Lada','Lamborghini','Land Rover','Lexus','Lincoln','Lotus','Lucid','Maserati','Mazda','McLaren','Mercedes-Benz','MG','Mini','Mitsubishi','Nissan','Opel','Peugeot','Polestar','Porsche','RAM','Renault','Rivian','Rolls-Royce','Saab','Seat','Skoda','Smart','Subaru','Suzuki','Tesla','Toyota','Volkswagen','Volvo','Voyah','XPeng','Zeekr'
  ];

  const slug = name => name.toLowerCase()
    .replace(/ё/g,'е').replace(/&/g,'and').replace(/\+/g,'plus')
    .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

  function addStyles(){
    if(document.getElementById('driverVehicleCatalogCss')) return;
    const s=document.createElement('style');s.id='driverVehicleCatalogCss';
    s.textContent=`
      .driver-brand-wrap{margin-top:12px;padding:16px;border-radius:20px;background:#0d1421;border:1px solid #263247}
      .driver-brand-title{font-size:14px;font-weight:900;margin-bottom:5px}
      .driver-brand-subtitle{font-size:10px;color:#7f8ca3;margin-bottom:12px}
      .driver-brand-search{width:100%;height:44px;border-radius:13px;padding:0 12px;background:#111a29;border:1px solid #29364d;color:#fff;outline:none;margin-bottom:10px}
      .driver-brand-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;max-height:360px;overflow:auto;padding-right:2px}
      .driver-brand{min-height:78px;border-radius:13px;background:#111a29;border:1px solid #243044;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:7px 4px}
      .driver-brand.active{border-color:#facc15;background:rgba(250,204,21,.08);box-shadow:0 0 0 1px rgba(250,204,21,.15)}
      .driver-brand img{width:38px;height:32px;object-fit:contain;filter:brightness(1.15)}
      .driver-brand-name{font-size:9px;font-weight:800;text-align:center;line-height:1.1}
      .driver-brand-other{grid-column:1/-1;min-height:42px;border-radius:12px;background:#151f2f;border:1px dashed #3a4961;color:#cbd5e1;font-size:11px;font-weight:800}
      .driver-selected-brand{margin-top:10px;padding:10px 12px;border-radius:12px;background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.16);font-size:11px;color:#a7b4c7}
      .driver-selected-brand b{color:#fff}
    `;document.head.appendChild(s);
  }

  function findDriverArea(){
    const nodes=[...document.querySelectorAll('input,button,.card,.driver-card')];
    return nodes.find(x=>/режим водителя|анкета водителя|профиль водителя/i.test(x.textContent||x.placeholder||''))?.closest('.card') || document.querySelector('.driver-card');
  }

  function render(){
    if(document.getElementById('driverBrandCatalog')) return;
    const area=findDriverArea();
    if(!area) return;

    const wrap=document.createElement('div');wrap.id='driverBrandCatalog';wrap.className='driver-brand-wrap';
    wrap.innerHTML=`<div class="driver-brand-title">🚗 Марка автомобиля</div>
      <div class="driver-brand-subtitle">Выберите марку — логотип сохранится вместе с анкетой</div>
      <input class="driver-brand-search" id="driverBrandSearch" placeholder="🔎 Поиск марки..." autocomplete="off">
      <div class="driver-brand-grid" id="driverBrandGrid"></div>
      <div class="driver-selected-brand" id="driverSelectedBrand">Марка не выбрана</div>`;
    area.appendChild(wrap);

    const grid=wrap.querySelector('#driverBrandGrid');
    const search=wrap.querySelector('#driverBrandSearch');
    const selected=wrap.querySelector('#driverSelectedBrand');

    function draw(filter=''){
      grid.innerHTML='';
      const list=BRANDS.filter(x=>x.toLowerCase().includes(filter.toLowerCase()));
      list.forEach(name=>{
        const b=document.createElement('button');b.type='button';b.className='driver-brand';b.dataset.brand=name;
        const img=document.createElement('img');img.loading='lazy';img.src=LOGO_BASE+slug(name)+'-logo.svg';img.alt=name;
        img.onerror=()=>{img.src=LOGO_BASE+slug(name)+'-logo.png';img.onerror=()=>{img.style.display='none'}};
        const label=document.createElement('span');label.className='driver-brand-name';label.textContent=name;
        b.append(img,label);b.onclick=()=>{grid.querySelectorAll('.driver-brand').forEach(x=>x.classList.remove('active'));b.classList.add('active');selected.innerHTML='Выбрано: <b>'+name+'</b>';window.taxiSelectedCarBrand=name;document.dispatchEvent(new CustomEvent('taxi-driver-brand-change',{detail:{brand:name}}));};
        grid.appendChild(b);
      });
      const other=document.createElement('button');other.type='button';other.className='driver-brand-other';other.textContent='Другая марка';other.onclick=()=>{const name=prompt('Введите марку автомобиля');if(name){selected.innerHTML='Выбрано: <b>'+name+'</b>';window.taxiSelectedCarBrand=name;document.dispatchEvent(new CustomEvent('taxi-driver-brand-change',{detail:{brand:name}}));}};grid.appendChild(other);
    }
    search.oninput=()=>draw(search.value);draw();
  }

  function boot(){addStyles();render();}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
  new MutationObserver(()=>render()).observe(document.body,{childList:true,subtree:true});
})();
