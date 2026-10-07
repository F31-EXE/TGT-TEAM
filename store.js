// Слой данных: локальный режим (localStorage) или общая база Firebase.
// Оба хранилища предоставляют одинаковый набор методов, интерфейс не знает, с каким работает.

import { firebaseConfig } from './firebase-config.js';
import { uid, monthKey, normLogin } from './util.js';

// Звания по сумме баллов (порог → звание). Админ может поменять в настройках.
export const DEFAULT_RANKS = [
  [0, 'Рядовой'], [50, 'Ефрейтор'], [100, 'Младший сержант'], [150, 'Сержант'], [200, 'Старший сержант'],
  [250, 'Старшина'], [300, 'Старший прапорщик'], [350, 'Младший лейтенант'], [400, 'Лейтенант'],
  [450, 'Старший лейтенант'], [500, 'Капитан'], [550, 'Майор'], [600, 'Подполковник'], [650, 'Полковник'],
  [700, 'Генерал-майор'], [750, 'Генерал-лейтенант'], [800, 'Генерал-полковник'], [850, 'Генерал армии'], [900, 'Маршал'],
].map(([min, title]) => ({ min, title }));

export const emptyState = () => ({
  settings: {
    teamName: 'TGT Team', fee: 300, currency: '₽', startBalance: 0, fees: {},
    ranks: DEFAULT_RANKS, pointsMin: 18, reminderText: '', paymentDetails: '', reminderDays: [1, 22],
  },
  members: [],   // {id, name, callsign, number, group, groupLead, vk, birthday, status:'recruit'|'fighter'|'pause', pauses:[{from,to}], feeFrom, from, left, exempt, pointsBase, admin, login, uid}
  payments: {},  // {'YYYY-MM': {memberId: amount}}
  expenses: [],  // {id, date, title, amount, category, kind:'out'|'in'}
  events: [],    // {id, date, time, title, place, notes, attendance:{memberId:'yes'|'maybe'|'no'}}
  gear: [],      // {id, name, qty, holderId, note}
  points: [],    // {id, memberId, date, cat:'game'|'training'|'contribution'|'discipline'|'safety', amount, note}
});

/** Приводит данные старых версий и импортов к текущему виду. */
export function normalizeState(raw) {
  const s = Object.assign(emptyState(), raw || {});
  s.settings = Object.assign(emptyState().settings, s.settings);
  if (raw && raw.fees) s.settings.fees = { ...raw.fees, ...s.settings.fees };
  delete s.fees;
  s.members = s.members.map(normalizeMember);
  s.events = s.events.map((e) => ({ attendance: {}, ...e }));
  return s;
}

export function normalizeMember(m) {
  const out = {
    status: 'fighter', feeFrom: null, left: null, exempt: false, admin: false, vk: '', birthday: '', callsign: '',
    number: '', group: '', groupLead: false, pointsBase: 0, pauses: [], ...m,
  };
  if (!out.vk && m.phone) out.vk = m.phone; // v1: поле «Телефон / Telegram»
  delete out.phone;
  delete out.role;
  return out;
}

const COLLECTIONS = ['members', 'expenses', 'events', 'gear', 'points'];

/* ============================ Локальный режим ============================ */

const LOCAL_KEY = 'tgt-team-v1';

class LocalStore {
  constructor() {
    this.mode = 'local';
    this.me = { admin: true, memberId: null, local: true };
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(LOCAL_KEY)); } catch (e) { /* пусто */ }
    this.state = normalizeState(raw);
  }

  async start(onAuth) { onAuth(this.me); }
  subscribe(fn) { this.listener = fn; fn(this.state); }

  _commit() {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(this.state)); } catch (e) { throw new Error('Не удалось сохранить на устройстве'); }
    this.listener?.(this.state);
  }

  async saveSettings(patch) { Object.assign(this.state.settings, patch); this._commit(); }
  async setMonthFee(month, amount) { this.state.settings.fees[month] = amount; this._commit(); }

  async saveItem(coll, item) {
    const id = item.id || uid();
    const arr = this.state[coll];
    const i = arr.findIndex((x) => x.id === id);
    if (i >= 0) arr[i] = { ...arr[i], ...item, id }; else arr.push({ ...item, id });
    this._commit();
    return id;
  }

  async deleteItem(coll, id) {
    this.state[coll] = this.state[coll].filter((x) => x.id !== id);
    this._commit();
  }

  async deleteMember(m) {
    const s = this.state;
    s.members = s.members.filter((x) => x.id !== m.id);
    for (const mo of Object.values(s.payments)) delete mo[m.id];
    for (const ev of s.events) delete ev.attendance[m.id];
    for (const g of s.gear) if (g.holderId === m.id) g.holderId = '';
    s.points = s.points.filter((x) => x.memberId !== m.id);
    this._commit();
  }

  /** list: [{month, memberId, amount}] — amount 0 удаляет оплату. */
  async setPayments(list) {
    for (const { month, memberId, amount } of list) {
      const b = this.state.payments[month] || (this.state.payments[month] = {});
      if (amount > 0) b[memberId] = amount; else delete b[memberId];
    }
    this._commit();
  }

  async setAttendance(eventId, memberId, value) {
    const ev = this.state.events.find((e) => e.id === eventId);
    if (!ev) return;
    if (value) ev.attendance[memberId] = value; else delete ev.attendance[memberId];
    this._commit();
  }

  /** Добавляет/обновляет записи по id, ничего не удаляя. */
  async importBulk(data) {
    const s = this.state;
    for (const coll of COLLECTIONS) {
      for (const item of data[coll] || []) {
        const i = s[coll].findIndex((x) => x.id === item.id);
        if (i >= 0) s[coll][i] = { ...s[coll][i], ...item }; else s[coll].push(item);
      }
    }
    for (const [month, map] of Object.entries(data.payments || {})) s.payments[month] = { ...(s.payments[month] || {}), ...map };
    Object.assign(s.settings.fees, data.fees || {});
    if (data.settings) Object.assign(s.settings, data.settings, { fees: s.settings.fees });
    this._commit();
  }

  async replaceAll(data) { this.state = normalizeState(data); this._commit(); }
}

/* ============================ Общая база Firebase ============================ */

const SDK = './vendor/firebase/';
const EMAIL_DOMAIN = 'tgt-team.app';
const fakeEmail = () => `m${uid()}@${EMAIL_DOMAIN}`;

const AUTH_ERRORS = {
  'auth/invalid-credential': 'Неверный логин или PIN',
  'auth/wrong-password': 'Неверный логин или PIN',
  'auth/user-not-found': 'Неверный логин или PIN',
  'auth/too-many-requests': 'Слишком много попыток. Подождите несколько минут',
  'auth/network-request-failed': 'Нет связи с сервером',
  'auth/weak-password': 'PIN должен быть не короче 6 цифр',
  'permission-denied': 'Нет прав на это действие',
  'unavailable': 'Нет связи с сервером',
};
export const errorText = (e) => AUTH_ERRORS[e?.code] || e?.message || String(e);

class FirebaseStore {
  constructor() {
    this.mode = 'cloud';
    this.me = null;
    this.state = emptyState();
    this.unsubs = [];
  }

  async _load() {
    const [appMod, authMod, fsMod] = await Promise.all([
      import(`${SDK}firebase-app.js`), import(`${SDK}firebase-auth.js`), import(`${SDK}firebase-firestore.js`),
    ]);
    this.A = authMod;
    this.F = fsMod;
    this.app = appMod.initializeApp(firebaseConfig);
    // Второй экземпляр нужен, чтобы админ создавал аккаунты бойцов, не выходя из своего.
    this.app2 = appMod.initializeApp(firebaseConfig, 'accounts');
    this.auth = authMod.getAuth(this.app);
    this.auth2 = authMod.getAuth(this.app2);
    await authMod.setPersistence(this.auth2, authMod.inMemoryPersistence);
    let localCache;
    try { localCache = fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() }); } catch (e) { /* без офлайн-кэша */ }
    this.db = fsMod.initializeFirestore(this.app, localCache ? { localCache } : {});

    const emu = new URLSearchParams(location.search).get('emu');
    if (emu && ['localhost', '127.0.0.1'].includes(location.hostname)) {
      authMod.connectAuthEmulator(this.auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      authMod.connectAuthEmulator(this.auth2, 'http://127.0.0.1:9099', { disableWarnings: true });
      fsMod.connectFirestoreEmulator(this.db, '127.0.0.1', 8080);
    }
  }

  ref(...path) { return this.F.doc(this.db, ...path); }

  /** onAuth(me): me = null (не вошёл) | {noAccess:true} | {uid, memberId, admin}. */
  async start(onAuth) {
    await this._load();
    this.onAuth = onAuth;
    this.A.onAuthStateChanged(this.auth, (user) => { if (!this.bootstrapping) this._handleUser(user); });
  }

  async _handleUser(user) {
    this._stop();
    if (!user) { this.me = null; this.onAuth(null); return; }
    try {
      const snap = await this.F.getDoc(this.ref('users', user.uid));
      if (!snap.exists()) { this.me = { noAccess: true, uid: user.uid }; this.onAuth(this.me); return; }
    } catch (e) {
      this.me = { noAccess: true, uid: user.uid, error: errorText(e) }; this.onAuth(this.me); return;
    }
    // Права могут поменяться во время сессии — следим за своей записью.
    this.unsubs.push(this.F.onSnapshot(this.ref('users', user.uid), (snap) => {
      if (!snap.exists()) { this.me = { noAccess: true, uid: user.uid }; this._stop(); this.onAuth(this.me); return; }
      const d = snap.data();
      const first = !this.me || this.me.noAccess || this.me.uid !== user.uid;
      this.me = { uid: user.uid, memberId: d.memberId, admin: !!d.admin };
      if (first) this._listen();
      this.onAuth(this.me);
    }, () => {}));
  }

  _listen() {
    const { F } = this;
    const emit = () => this.listener?.(this.state);
    this.unsubs.push(F.onSnapshot(this.ref('settings', 'main'), (snap) => {
      this.state.settings = Object.assign(emptyState().settings, snap.data() || {});
      emit();
    }, () => {}));
    this.unsubs.push(F.onSnapshot(F.collection(this.db, 'payments'), (qs) => {
      const p = {};
      qs.forEach((d) => { p[d.id] = d.data(); });
      this.state.payments = p;
      emit();
    }, () => {}));
    for (const coll of COLLECTIONS) {
      this.unsubs.push(F.onSnapshot(F.collection(this.db, coll), (qs) => {
        const arr = [];
        qs.forEach((d) => arr.push({ ...d.data(), id: d.id }));
        this.state[coll] = coll === 'members' ? arr.map(normalizeMember) : coll === 'events' ? arr.map((e) => ({ attendance: {}, ...e })) : arr;
        emit();
      }, () => {}));
    }
  }

  _stop() { this.unsubs.forEach((u) => u()); this.unsubs = []; this.state = emptyState(); }

  subscribe(fn) { this.listener = fn; fn(this.state); }

  /* ---------- Вход ---------- */

  async login(login, pin) {
    const snap = await this.F.getDoc(this.ref('logins', normLogin(login)));
    if (!snap.exists()) throw new Error('Неверный логин или PIN');
    await this.A.signInWithEmailAndPassword(this.auth, snap.data().email, pin);
  }

  async logout() { await this.A.signOut(this.auth); }

  /** Первый запуск: создаёт команду и первого администратора. */
  async bootstrap({ teamName, fee, name, callsign, login, pin }) {
    const { A, F } = this;
    const key = normLogin(login);
    const email = fakeEmail();
    this.bootstrapping = true;
    try {
      const cred = await A.createUserWithEmailAndPassword(this.auth, email, pin);
      const memberId = uid();
      const b = F.writeBatch(this.db);
      b.set(this.ref('settings', 'main'), { teamName, fee, currency: '₽', startBalance: 0, fees: {} });
      b.set(this.ref('members', memberId), normalizeMember({ name, callsign, from: monthKey(), admin: true, login: login.trim(), uid: cred.user.uid }));
      b.set(this.ref('users', cred.user.uid), { memberId, admin: true });
      b.set(this.ref('logins', key), { email, memberId });
      try {
        await b.commit();
      } catch (e) {
        await cred.user.delete().catch(() => {});
        throw new Error('Команда уже создана — войдите по логину и PIN от администратора');
      }
      this.bootstrapping = false;
      await this._handleUser(cred.user);
    } finally {
      this.bootstrapping = false;
    }
  }

  /** Создаёт (или пересоздаёт со сменой PIN) доступ бойца в приложение. */
  async grantAccess(member, login, pin, admin) {
    const { A, F } = this;
    const key = normLogin(login);
    if (!key) throw new Error('Укажите логин');
    if (!/^\d{6,}$/.test(pin)) throw new Error('PIN — минимум 6 цифр');
    const taken = await F.getDoc(this.ref('logins', key));
    if (taken.exists() && taken.data().memberId !== member.id) throw new Error('Такой логин уже занят');

    const email = fakeEmail();
    const cred = await A.createUserWithEmailAndPassword(this.auth2, email, pin);
    await A.signOut(this.auth2);

    const b = F.writeBatch(this.db);
    if (member.uid) b.delete(this.ref('users', member.uid));
    if (member.login && normLogin(member.login) !== key) b.delete(this.ref('logins', normLogin(member.login)));
    b.set(this.ref('users', cred.user.uid), { memberId: member.id, admin: !!admin });
    b.set(this.ref('logins', key), { email, memberId: member.id });
    b.set(this.ref('members', member.id), { uid: cred.user.uid, login: login.trim(), admin: !!admin }, { merge: true });
    await b.commit();
  }

  async revokeAccess(member) {
    const b = this.F.writeBatch(this.db);
    if (member.uid) b.delete(this.ref('users', member.uid));
    if (member.login) b.delete(this.ref('logins', normLogin(member.login)));
    b.set(this.ref('members', member.id), { uid: null, login: null, admin: false }, { merge: true });
    await b.commit();
  }

  async setAdmin(member, admin) {
    if (!member.uid) throw new Error('Сначала выдайте бойцу доступ');
    const b = this.F.writeBatch(this.db);
    b.update(this.ref('users', member.uid), { admin });
    b.set(this.ref('members', member.id), { admin }, { merge: true });
    await b.commit();
  }

  /* ---------- Данные ---------- */

  async saveSettings(patch) { await this.F.setDoc(this.ref('settings', 'main'), patch, { merge: true }); }

  async setMonthFee(month, amount) {
    await this.F.updateDoc(this.ref('settings', 'main'), new this.F.FieldPath('fees', month), amount);
  }

  async saveItem(coll, item) {
    const id = item.id || uid();
    const data = { ...item };
    delete data.id;
    for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
    await this.F.setDoc(this.ref(coll, id), data, { merge: true });
    return id;
  }

  async deleteItem(coll, id) { await this.F.deleteDoc(this.ref(coll, id)); }

  async deleteMember(m) {
    const { F } = this;
    const ops = [];
    if (m.uid) ops.push((b) => b.delete(this.ref('users', m.uid)));
    if (m.login) ops.push((b) => b.delete(this.ref('logins', normLogin(m.login))));
    for (const [month, map] of Object.entries(this.state.payments)) {
      if (m.id in map) ops.push((b) => b.update(this.ref('payments', month), { [m.id]: F.deleteField() }));
    }
    for (const ev of this.state.events) {
      if (ev.attendance && m.id in ev.attendance) ops.push((b) => b.update(this.ref('events', ev.id), new F.FieldPath('attendance', m.id), F.deleteField()));
    }
    for (const g of this.state.gear) if (g.holderId === m.id) ops.push((b) => b.update(this.ref('gear', g.id), { holderId: '' }));
    for (const p of this.state.points) if (p.memberId === m.id) ops.push((b) => b.delete(this.ref('points', p.id)));
    ops.push((b) => b.delete(this.ref('members', m.id)));
    await this._batched(ops);
  }

  async setPayments(list) {
    const { F } = this;
    await this._batched(list.map(({ month, memberId, amount }) => (b) =>
      b.set(this.ref('payments', month), { [memberId]: amount > 0 ? amount : F.deleteField() }, { merge: true })));
  }

  async setAttendance(eventId, memberId, value) {
    const { F } = this;
    await F.updateDoc(this.ref('events', eventId), new F.FieldPath('attendance', memberId), value || F.deleteField());
  }

  async importBulk(data) {
    const ops = [];
    for (const coll of COLLECTIONS) {
      for (const item of data[coll] || []) {
        const d = { ...item };
        delete d.id;
        if (coll === 'members') { delete d.uid; delete d.login; delete d.admin; }
        ops.push((b) => b.set(this.ref(coll, item.id), d, { merge: true }));
      }
    }
    for (const [month, map] of Object.entries(data.payments || {})) {
      if (Object.keys(map).length) ops.push((b) => b.set(this.ref('payments', month), map, { merge: true }));
    }
    const settings = { ...(data.settings || {}) };
    if (data.fees && Object.keys(data.fees).length) settings.fees = data.fees;
    if (Object.keys(settings).length) ops.push((b) => b.set(this.ref('settings', 'main'), settings, { merge: true }));
    await this._batched(ops);
  }

  /** Firestore ограничивает пакет 500 операциями. */
  async _batched(ops) {
    for (let i = 0; i < ops.length; i += 400) {
      const b = this.F.writeBatch(this.db);
      ops.slice(i, i + 400).forEach((op) => op(b));
      await b.commit();
    }
  }
}

export const cloudConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
export const store = cloudConfigured ? new FirebaseStore() : new LocalStore();
