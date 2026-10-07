// Эффекты в стиле Pip-Boy: загрузочный экран терминала и щелчок при нажатиях.
// Звук синтезируется на лету (Web Audio), отдельные файлы не нужны.

const SOUND_KEY = 'tgt-sound';
let ctx = null;

export const soundOn = () => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch (e) { return true; } };
export const setSound = (on) => { try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch (e) { /* без сохранения */ } };

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

/** Короткий механический щелчок: всплеск шума через полосовой фильтр. */
export function click(strength = 1) {
  if (!soundOn()) return;
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime;
  const len = Math.floor(ac.sampleRate * 0.03);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 6);
  const src = ac.createBufferSource();
  src.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2600;
  bp.Q.value = 1.2;
  const g = ac.createGain();
  g.gain.value = 0.5 * strength;
  src.connect(bp).connect(g).connect(ac.destination);
  src.start(t);
}

/** Щелчок на любое нажатие кнопки, вкладки или строки списка. */
export function initClicks() {
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('button, [data-act], .tabbar button, label.toggle, select');
    if (el && !el.disabled) click(el.closest('.tabbar') ? 1.3 : 1);
  }, { passive: true });
}

const BOOT_LINES = [
  'TGT-CO INDUSTRIES UNIFIED OPERATING SYSTEM',
  'COPYRIGHT 2075-2077 TGT-CO INDUSTRIES',
  '-SERVER 1-',
  '',
  '> SET TERMINAL/INQUIRE',
  '> TGT-V300',
  '> SET FILE/PROTECTION=OWNER:RWED ACCOUNTS.F',
  '> SET HALT RESTART/MAINT',
  '',
  'Загрузка личных дел ........... OK',
  'Синхронизация казны ........... OK',
  'Проверка боекомплекта ......... OK',
  '',
  '> ДОБРО ПОЖАЛОВАТЬ, БОЕЦ',
];

/** Загрузочный экран терминала: один раз за сессию, пропускается касанием. */
export function boot() {
  try { if (sessionStorage.getItem('tgt-booted')) return; sessionStorage.setItem('tgt-booted', '1'); } catch (e) { /* показываем каждый раз */ }
  const fast = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const el = document.createElement('div');
  el.className = 'boot';
  el.innerHTML = '<pre></pre><div class="boot-skip">коснитесь, чтобы пропустить</div>';
  document.body.appendChild(el);
  const pre = el.querySelector('pre');
  let line = 0, ch = 0, done = false, timer;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    el.classList.add('boot-out');
    setTimeout(() => el.remove(), 350);
  };
  const step = () => {
    if (done) return;
    if (line >= BOOT_LINES.length) { timer = setTimeout(finish, 500); return; }
    const text = BOOT_LINES[line];
    if (fast || ch >= text.length) {
      pre.textContent += `${fast ? text : ''}\n`;
      line++;
      ch = 0;
      timer = setTimeout(step, fast ? 20 : 60);
      return;
    }
    const n = Math.min(text.length - ch, 3);
    pre.textContent += text.slice(ch, ch + n);
    ch += n;
    timer = setTimeout(step, 12);
  };
  el.addEventListener('pointerdown', finish);
  step();
}

/** Сжимает фото (чек, подтверждение) до JPEG ~100 КБ для хранения в базе. */
export function compressImage(file, maxSide = 1100, quality = 0.62) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const k = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      let q = quality;
      let data = c.toDataURL('image/jpeg', q);
      while (data.length > 600000 && q > 0.3) { q -= 0.1; data = c.toDataURL('image/jpeg', q); }
      resolve(data);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось открыть изображение')); };
    img.src = url;
  });
}
