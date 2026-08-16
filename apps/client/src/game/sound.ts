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
 * Общая громкость. Подбиралась по отрисовке в файл: прибор говорит вполголоса
 * и не спорит с тем, что человек слушает параллельно.
 */
const LEVEL = 1.9;

/** Сколько звука уходит в отражения. Комната приборная, маленькая. */
const WET = 0.32;

/** Длина отражений, с. Дольше — уже зал, а не лаборатория. */
const ROOM = 1.1;

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
    limiter.threshold.value = -10;
    limiter.knee.value = 10;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.18;
    limiter.connect(ctx.destination);

    // Отражения. Без них синтезированный звук слышен как писк из телефона,
    // а с ними — как прибор, стоящий в комнате: у каждого сигнала есть
    // место, где он прозвучал. Отдельной комнаты не нужно, хватает короткой.
    const room = ctx.createConvolver();
    room.buffer = this.impulse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = WET;
    // Верх в отражениях режем: стены поглощают его первыми, и без этого
    // хвост шипит.
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2600;

    master.connect(limiter);
    master.connect(room).connect(damp).connect(wet).connect(limiter);
    this.master = master;
  }

  /**
   * Отклик комнаты: затухающий шум. Настоящую запись сюда класть незачем —
   * файл ради полутора секунд хвоста дороже, чем весь остальной звук.
   */
  private impulse(ctx: BaseAudioContext): AudioBuffer {
    const frames = Math.ceil(ctx.sampleRate * ROOM);
    const buffer = ctx.createBuffer(2, frames, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      let smooth = 0;
      for (let i = 0; i < frames; i++) {
        const fade = (1 - i / frames) ** 3.2;
        // Однополюсный фильтр прямо в буфере: отражения глухие с самого
        // начала, иначе комната звенит песком.
        smooth += 0.22 * ((Math.random() * 2 - 1) - smooth);
        data[i] = smooth * fade;
      }
    }
    return buffer;
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

  /**
   * Огибающая. Атака не мгновенная нарочно: острый фронт и есть та резкость,
   * от которой звук колет ухо, а полтора десятка миллисекунд её убирают,
   * не съедая отклика.
   */
  private envelope(gain: GainNode, at: number, peak: number, dur: number, attack = 0.012): void {
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(peak, at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  }

  /**
   * Тон: короткая нота, при желании со скольжением к другой частоте. Синус
   * по умолчанию: у прямоугольника и пилы верхние гармоники режут ухо на
   * телефонном динамике, а прибору хватает чистого тона.
   */
  private tone(
    at: number,
    freq: number,
    dur: number,
    peak: number,
    type: OscillatorType = 'sine',
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
   * Колокол: несущая, чуть подкрашенная модуляцией. Индекс маленький —
   * нужен тёплый призвук, а не металлический звон.
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
    mod.frequency.value = freq * 2;
    modGain.gain.setValueAtTime(freq * 0.5, at);
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
    this.tone(t, note(index), 0.11, 0.055, 'sine', undefined, 3000);
  }

  /**
   * Цепочка засчитана. Щелчок реле оставлен намеренно тихим: он тут не
   * награда, а отметка о том, что ход принят, — награда звучит выше.
   */
  chain(dots: number, multiplier: number, at?: number): void {
    const t = this.when(at);
    this.hiss(t, 900, 0.01, 0.025, 0.8);
    this.tone(t, 132 - Math.min(dots, 12) * 3, 0.2, 0.075, 'sine', 82, 700);
    // Множитель слышен отдельной нотой: он и есть награда за линзы.
    if (multiplier > 1) this.bell(t + 0.06, 440 * multiplier, 0.4, 0.055);
  }

  /** Линза отшлифована: чистый тон, ради которого цепочку и тянули. */
  lens(at?: number): void {
    const t = this.when(at);
    this.bell(t, 880, 0.52, 0.07);
  }

  /** Открылось окно заказа: прибор звенит цветом. */
  window(at?: number): void {
    const t = this.when(at);
    this.tone(t, 660, 0.12, 0.06, 'sine', undefined, 2400);
    this.tone(t + 0.11, 880, 0.16, 0.06, 'sine', undefined, 2400);
  }

  /** Касание в заказах: заказ закрыт (награда) или группы не хватило. */
  order(size: number, reward: number, at?: number): void {
    const t = this.when(at);
    if (reward > 0) {
      this.tone(t, 440, 0.24, 0.06, 'sine', 990, 3000);
      this.bell(t + 0.14, 880, 0.6, 0.075);
      // Крупная группа звенит дважды: её слышно, а не только видно.
      if (size >= 30) this.bell(t + 0.3, 1320, 0.6, 0.06);
    } else {
      // Отказ слышен, но не бьёт: на нём кончается окно, а не заход.
      this.tone(t, 220, 0.3, 0.07, 'sine', 155, 800);
    }
  }

  /** Окно упущено: низкий гудок сбоя. */
  miss(at?: number): void {
    const t = this.when(at);
    this.tone(t, 165, 0.44, 0.07, 'sine', 98, 700);
  }

  /** Заявка на цвет: своя идёт вверх, чужая — вниз. */
  claim(mine: boolean, at?: number): void {
    const t = this.when(at);
    if (mine) {
      this.tone(t, 700, 0.1, 0.05, 'sine', undefined, 2400);
      this.tone(t + 0.09, 1050, 0.14, 0.05, 'sine', undefined, 2400);
    } else {
      this.tone(t, 1050, 0.1, 0.045, 'sine', undefined, 1800);
      this.tone(t + 0.09, 620, 0.16, 0.045, 'sine', undefined, 1800);
    }
  }

  /** Последние секунды: тихий отсчёт, не будильник. */
  tick(at?: number): void {
    const t = this.when(at);
    this.tone(t, 1046, 0.05, 0.035, 'sine', undefined, 2600);
  }

  /**
   * Конец: победа — три ступени вверх, поражение и конец захода — сирена.
   * Сирена одна и та же: прибор не злорадствует, он просто выключается.
   */
  over(win: boolean, at?: number): void {
    const t = this.when(at);
    if (win) {
      this.bell(t, 784, 0.42, 0.075);
      this.bell(t + 0.16, 1046, 0.42, 0.075);
      this.bell(t + 0.32, 1568, 0.7, 0.08);
    } else {
      this.tone(t, 520, 0.44, 0.065, 'sine', 300, 1400);
      this.tone(t + 0.42, 460, 0.6, 0.06, 'sine', 240, 1200);
    }
  }
}
