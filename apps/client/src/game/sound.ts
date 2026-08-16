/**
 * Голос прибора.
 *
 * Звуки не лежат файлами, а собираются на месте из осцилляторов и шума.
 * Причина не в весе: прибор электромеханический, и его язык — щелчки реле,
 * писк сигнальной цепи и гудение накала. Такое проще синтезировать, чем
 * искать, а главное — синтез слышит игру: цепочка поёт вверх по ступеням,
 * и на слух видно, насколько она длинная, ещё до того как палец отпущен.
 * Сэмплом это стоило бы десятка файлов.
 *
 * Класс работает с любым контекстом Web Audio, включая offline: тот же код
 * можно отрисовать в файл и послушать, не запуская игру.
 */

/** Ступени, по которым поёт растущая цепочка. Мажорная пентатоника: в ней
 *  нет ни одного неприятного соседства, а цепочка бывает длинной. */
const LADDER = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28];

/** Нижняя нота цепочки, Гц. Соль малой октавы — низко, но не гудит. */
const ROOT = 196;

/** Сколько голосов звучит одновременно. Больше — каша, особенно на телефоне. */
const VOICES = 8;

/**
 * Общая громкость. Подбиралась по отрисовке в файл: с ней пик набора
 * ложится чуть ниже половины шкалы — телефону слышно, запаса до перегруза
 * хватает, а лимитер ниже страхует совпадения голосов.
 */
const LEVEL = 3.2;

function note(step: number): number {
  const index = Math.min(Math.max(step, 0), LADDER.length - 1);
  return ROOT * 2 ** (LADDER[index]! / 12);
}

export interface SoundOptions {
  /** Готовый контекст — для отрисовки в файл. Обычной игре он не нужен. */
  context?: BaseAudioContext;
  muted?: boolean;
}

export class Sound {
  private ctx: BaseAudioContext | null;
  private master: GainNode | null = null;
  private on: boolean;
  /**
   * Когда доиграет каждый заведённый голос. Считаем по расписанию, а не по
   * событию `ended`: то приходит с задержкой, а при отрисовке в файл не
   * приходит вовсе — и запас голосов молча закрывал бы весь набор.
   */
  private ends: number[] = [];

  constructor(options: SoundOptions = {}) {
    this.ctx = options.context ?? null;
    this.on = options.muted !== true;
    if (this.ctx) this.setup(this.ctx);
  }

  get muted(): boolean {
    return !this.on;
  }

  setMuted(muted: boolean): void {
    this.on = !muted;
    if (this.master) this.master.gain.value = muted ? 0 : LEVEL;
  }

  /**
   * Будит звук. Система пускает его только с первого касания экрана, и до
   * этого момента контекст создавать бессмысленно: он родится спящим.
   */
  wake(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.setup(this.ctx);
    }
    const live = this.ctx as AudioContext;
    if (typeof live.resume === 'function' && live.state === 'suspended') void live.resume();
  }

  private setup(ctx: BaseAudioContext): void {
    const master = ctx.createGain();
    master.gain.value = this.on ? LEVEL : 0;
    // Лимитер на выходе: голоса иногда совпадают (щелчок реле и колокол
    // множителя в одном ходу), и без него такой стык щёлкал бы перегрузом.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    master.connect(limiter).connect(ctx.destination);
    this.master = master;
  }

  /** Время, к которому привязывается звук; own — для отрисовки в файл. */
  private when(at?: number): number {
    return at ?? (this.ctx?.currentTime ?? 0);
  }

  /** Есть ли свободный голос к этому моменту; занимает его, если есть. */
  private take(at: number): boolean {
    if (!this.ctx || !this.master || !this.on) return false;
    this.ends = this.ends.filter((end) => end > at);
    if (this.ends.length >= VOICES) return false;
    this.ends.push(at);
    return true;
  }

  /** Уточняет, до какого момента занят последний взятый голос. */
  private hold(until: number): void {
    this.ends[this.ends.length - 1] = until;
  }

  /** Огибающая: мгновенная атака, спад до нуля. Щелчок так и устроен. */
  private envelope(gain: GainNode, at: number, peak: number, dur: number, attack = 0.004): void {
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(peak, at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  }

  /** Тон: короткая нота, при желании со скольжением к другой частоте. */
  private tone(
    at: number,
    freq: number,
    dur: number,
    peak: number,
    type: OscillatorType = 'square',
    to?: number,
    cutoff = 2600,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.take(at)) return;
    this.hold(at + dur);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (to !== undefined) osc.frequency.exponentialRampToValueAtTime(to, at + dur);
    this.envelope(gain, at, peak, dur);
    osc.connect(filter).connect(gain).connect(this.master);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  /** Шум через полосовой фильтр — из него получаются щелчки и сирены. */
  private hiss(at: number, freq: number, dur: number, peak: number, q = 1.4): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.take(at)) return;
    this.hold(at + dur);
    const frames = Math.max(1, Math.ceil(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = freq;
    band.Q.value = q;
    const gain = ctx.createGain();
    this.envelope(gain, at, peak, dur, 0.001);
    source.connect(band).connect(gain).connect(this.master);
    source.start(at);
    source.stop(at + dur + 0.02);
  }

  /**
   * Колокол: несущая, подкрашенная быстрой модуляцией. Металлический
   * призвук берётся отсюда, а не из фильтра, — так он живее.
   */
  private bell(at: number, freq: number, dur: number, peak: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.take(at)) return;
    this.hold(at + dur);
    const carrier = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const modGain = ctx.createGain();
    const gain = ctx.createGain();
    carrier.type = 'sine';
    carrier.frequency.value = freq;
    mod.type = 'sine';
    mod.frequency.value = freq * 3.5;
    modGain.gain.setValueAtTime(freq * 1.6, at);
    modGain.gain.exponentialRampToValueAtTime(1, at + dur * 0.6);
    this.envelope(gain, at, peak, dur, 0.002);
    mod.connect(modGain).connect(carrier.frequency);
    carrier.connect(gain).connect(this.master);
    mod.start(at);
    mod.stop(at + dur + 0.02);
    carrier.start(at);
    carrier.stop(at + dur + 0.02);
  }

  // ---------- Голоса прибора ----------

  /** Палец лёг на очередную точку: цепочка растёт и поёт. */
  step(index: number, at?: number): void {
    const t = this.when(at);
    this.hiss(t, 2400, 0.012, 0.09);
    this.tone(t, note(index), 0.05, 0.1, 'square', undefined, 2200);
  }

  /** Цепочка засчитана: щелчок реле, и тем ниже, чем длиннее цепочка. */
  chain(dots: number, multiplier: number, at?: number): void {
    const t = this.when(at);
    this.hiss(t, 1700, 0.02, 0.22, 1.1);
    this.tone(t, 120 - Math.min(dots, 12) * 3, 0.11, 0.16, 'triangle', 70, 900);
    // Множитель слышен отдельной нотой: он и есть награда за линзы.
    if (multiplier > 1) this.bell(t + 0.05, 520 * multiplier, 0.26, 0.12);
  }

  /** Линза отшлифована: чистый звон, ради которого цепочку и тянули. */
  lens(at?: number): void {
    const t = this.when(at);
    this.bell(t, 880, 0.34, 0.16);
    this.hiss(t, 5200, 0.03, 0.06);
  }

  /** Открылось окно заказа: прибор звенит цветом. */
  window(at?: number): void {
    const t = this.when(at);
    this.tone(t, 660, 0.07, 0.13, 'square', undefined, 1800);
    this.tone(t + 0.09, 880, 0.09, 0.13, 'square', undefined, 1800);
  }

  /** Касание в заказах: заказ закрыт (награда) или группы не хватило. */
  order(size: number, reward: number, at?: number): void {
    const t = this.when(at);
    if (reward > 0) {
      this.hiss(t, 1700, 0.02, 0.2, 1.1);
      this.tone(t, 420, 0.18, 0.14, 'square', 1240, 3000);
      this.bell(t + 0.12, 1046, 0.4, 0.16);
      // Крупная группа звенит дважды: её слышно, а не только видно.
      if (size >= 30) this.bell(t + 0.26, 1568, 0.42, 0.12);
    } else {
      // Отказ должен быть слышен так же ясно, как награда: на нём кончается
      // окно, ради которого игрок и рисковал.
      this.hiss(t, 700, 0.05, 0.12, 0.9);
      this.tone(t, 190, 0.2, 0.19, 'sawtooth', 140, 700);
    }
  }

  /** Окно упущено: низкий гудок сбоя. */
  miss(at?: number): void {
    const t = this.when(at);
    this.tone(t, 140, 0.3, 0.14, 'sawtooth', 90, 600);
    this.hiss(t, 300, 0.22, 0.05);
  }

  /** Заявка на цвет: своя идёт вверх, чужая — вниз. */
  claim(mine: boolean, at?: number): void {
    const t = this.when(at);
    if (mine) {
      this.tone(t, 700, 0.06, 0.1, 'square', undefined, 2000);
      this.tone(t + 0.07, 1050, 0.09, 0.1, 'square', undefined, 2000);
    } else {
      this.tone(t, 1050, 0.06, 0.09, 'square', undefined, 1400);
      this.tone(t + 0.07, 620, 0.11, 0.09, 'square', undefined, 1400);
    }
  }

  /** Последние секунды: сухой щелчок раз в секунду. */
  tick(at?: number): void {
    const t = this.when(at);
    this.hiss(t, 1900, 0.012, 0.22);
  }

  /**
   * Конец: победа — три ступени вверх, поражение и конец захода — сирена.
   * Сирена одна и та же: прибор не злорадствует, он просто выключается.
   */
  over(win: boolean, at?: number): void {
    const t = this.when(at);
    if (win) {
      this.bell(t, 784, 0.3, 0.16);
      this.bell(t + 0.14, 1046, 0.3, 0.16);
      this.bell(t + 0.28, 1568, 0.5, 0.18);
    } else {
      this.tone(t, 620, 0.34, 0.13, 'sawtooth', 300, 1200);
      this.tone(t + 0.36, 560, 0.44, 0.12, 'sawtooth', 240, 1000);
    }
  }
}
