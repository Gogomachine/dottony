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
 * Каждый голос собран из трёх частей, как настоящий звук: щелчок (первые
 * миллисекунды, самое яркое место), тело (то, что поёт) и хвост (отражения
 * комнаты). Одна голая синусоида, какой прибор говорил раньше, слышится
 * пищалкой из открытки именно потому, что у неё нет ни щелчка, ни хвоста.
 *
 * Класс работает с любым контекстом Web Audio, включая offline: тот же код
 * можно отрисовать в файл и послушать, не запуская игру.
 */

/**
 * Ступени пентатоники внутри октавы. Пентатоника выбрана потому, что в ней
 * нет ни одного неприятного соседства, а цепочка бывает какой угодно
 * длины: соседние ноты обязаны ложиться друг на друга при любом темпе.
 */
const LADDER = [0, 2, 4, 7, 9];

/**
 * Нижняя нота, Гц. Около ре большой октавы: снизу оставлен весь запас, потому
 * что расти цепочке некуда, если начинать высоко.
 */
const ROOT = 72;

/**
 * Длина цепочки, на которой спад громкости ступени доходит до конца. Высоту
 * она больше не ограничивает — за неё отвечает потолок цепочки ниже, — но
 * шкалой «коротко / длинно» остаётся: на поле 6×6 столько точек и собирают.
 */
const LADDER_TOP = 20;

/** Сколько событий звучит одновременно. Больше — каша, особенно на телефоне. */
const VOICES = 10;

/**
 * Общая громкость. Прибор говорит вполголоса: запас до потолка нужен не
 * ради тишины, а ради того, чтобы совпавшие голоса не упирались в предел
 * чужого динамика.
 */
const LEVEL = 1.4;

/** Сколько звука уходит в отражения и насколько они задержаны. */
const WET = 0.1;
const ROOM = 1.9;
/**
 * Предзадержка отражений выключена: хвост начинается там же, где сам звук.
 * При такой малой доле отражений разделять их с прибором нечем — комната
 * слышна не как отдельное место, а как продолжение самого сигнала.
 */
const PRE_DELAY = 0;

/** Повтор: время до первого эха и сколько от него возвращается обратно. */
const ECHO = 0.13;
const ECHO_BACK = 0.42;
const ECHO_SEND = 0.3;

/**
 * Нота ступени лестницы. Лестница не кончается на списке: она идёт теми же
 * ступенями октава за октавой, поэтому длинная цепочка растёт, а не упирается
 * в потолок списка.
 *
 * Через неё же считаются все остальные голоса прибора. Раньше награды
 * звучали на круглых частотах вроде 523 Гц, до которых лестнице дела нет, и
 * набор слышался собранным из чужих кусков, а не сыгранным одним прибором.
 */
function deg(index: number): number {
  const step = Math.max(0, index);
  const octave = Math.floor(step / LADDER.length);
  const degree = LADDER[step % LADDER.length]!;
  return ROOT * 2 ** (octave + degree / 12);
}

/**
 * Докуда цепочка поднимается. Дальше нота не идёт совсем: восемнадцать точек
 * проходили две с лишним октавы за две секунды, и конец такого жеста сидел
 * ровно там, где ухо чувствительнее всего. Две октавы подъёма читаются не
 * хуже четырёх, а резать перестают.
 */
const CHAIN_CAP = 10;

/**
 * За сколько ступеней сверх потолка длинная цепочка доходит до своего
 * предела. Дальше она не меняется вовсе: расти ей больше некуда, и это
 * нарочно — предел должен быть слышен как предел, а не как бесконечность.
 */
const CHAIN_SPREAD = 8;

/** Нота цепочки: та же лестница, но с потолком. */
function chainNote(index: number): number {
  return deg(Math.min(Math.max(index, 0), CHAIN_CAP));
}

/**
 * Насколько далеко цепочка ушла за потолок: 0 у обычной, 1 у совсем длинной.
 * Через неё идёт всё, что отличает длинную цепочку от короткой, — потому что
 * высотой она больше не отличается ничем.
 */
function chainOver(index: number): number {
  return Math.min(1, Math.max(0, (index - CHAIN_CAP) / CHAIN_SPREAD));
}

/**
 * Обертоны ступени. У короткой цепочки это обычное тело: нота и её кратные.
 * У длинной под ноту подходит нижняя октава, а кратные над ней сходят почти
 * на нет — тело тяжелеет и глохнет. Звонкость длинной цепочки жила именно
 * здесь: выше потолка нота стоит на месте, но её вторая и третья кратные
 * никуда не девались и звенели вместо неё.
 */
function chainPartials(over: number): [number, number][] {
  if (over <= 0) return PARTIALS;
  return [
    [0.5, 0.12 + 0.48 * over],
    [1, 1],
    [2, PARTIALS[1]![1] - 0.14 * over],
    [3, PARTIALS[2]![1] - 0.07 * over],
  ];
}

/**
 * Громкость ступени. Низкие ноты на телефонном динамике слышны хуже
 * высоких — это свойство динамика, а не звука, — поэтому низ идёт громче,
 * и вся лестница звучит ровно.
 */
function stepLevel(step: number): number {
  const climb = Math.min(Math.max(step, 0), LADDER_TOP) / LADDER_TOP;
  // Спад не прямой, а с ускорением: ухо чувствительнее всего к верхам, и
  // верхние ступени идут тише первой — но ровно настолько, чтобы конец
  // длинной цепочки не пропадал, а звучал наравне с её началом.
  return 0.09 - 0.03 * climb ** 1.15;
}

/**
 * Громкость щелчков — общей долей на все голоса сразу. Щелчок нужен как
 * признак того, что звук начался, а не как сам звук: стоит ему выйти
 * вперёд тела, и прибор начинает клацать. Одна ручка на весь набор
 * держит их в одинаковом отношении к телам.
 */
const CLICK = 0.4;

/**
 * Наклон верха на шине, дБ. Верхние гармоники и щелчки нужны — но не в
 * той мере, в какой их даёт синтез: у настоящего прибора верх съедает
 * корпус, стол и воздух. Полка отыгрывает это одним движением на всё,
 * не трогая соотношений внутри голосов.
 */
const TILT_HZ = 1200;
const TILT_DB = -13;

/**
 * Обертоны тела. Синус — это чистая частота и ничего больше; живой звук
 * всегда несёт над основной нотой её кратные, поэтому тело собирается из
 * трёх: сама нота, октава и дуодецима, каждая тише предыдущей.
 */
const PARTIALS: [number, number][] = [
  [1, 1],
  [2, 0.22],
  [3, 0.09],
];

/**
 * Сумма их весов. По ней выравнивается громкость октавной стопки: в ней
 * слагаемых вдвое больше, и без этого длинная цепочка выходила бы громче
 * короткой на ровном месте.
 */
const PARTIAL_SUM = PARTIALS.reduce((total, [, weight]) => total + weight, 0);

/**
 * Обертоны колокола. У колокола они не кратные — оттого он и слышен
 * колоколом, а не флейтой. Отношения взяты близкими к настоящему:
 * второй партиал почти на терцдециму выше основного.
 */
const BELL_PARTIALS: [number, number, number][] = [
  // отношение, громкость, доля общей длительности
  [1, 1, 1],
  [2.76, 0.4, 0.7],
  [5.4, 0.16, 0.42],
];

export interface SoundOptions {
  /** Готовый контекст — для отрисовки в файл. Обычной игре он не нужен. */
  context?: BaseAudioContext;
  muted?: boolean;
}

export class Sound {
  private ctx: BaseAudioContext | null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private on: boolean;
  /**
   * Когда доиграет каждое заведённое событие. Считаем по расписанию, а не
   * по событию `ended`: то приходит с задержкой, а при отрисовке в файл не
   * приходит вовсе — и запас голосов молча закрывал бы весь набор.
   *
   * Считаются события, а не слои: у одного щелчка реле их три, и если бы
   * запас тратился слоями, половина звука отваливалась бы на ровном месте.
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
      const Ctor =
        window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
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

    /**
     * Насыщение. Мягкое ограничение добавляет к чистым тонам их кратные —
     * те самые, которых у синуса нет, — и на телефонном динамике это
     * слышно как «тёплый», а не «пластмассовый» звук. Кривая пологая: это
     * подкраска, а не перегруз.
     */
    const drive = ctx.createWaveShaper();
    drive.curve = this.saturation();
    drive.oversample = '2x';

    // Лимитер на выходе: голоса иногда совпадают (щелчок реле и колокол
    // множителя в одном ходу), и без него такой стык щёлкал бы перегрузом.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -9;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.16;
    // Запас до потолка. Лимитер держит громкие места, но упирать их в самый
    // край нельзя: у чужого динамика свой предел, и на нём это захрипит.
    const ceiling = ctx.createGain();
    ceiling.gain.value = 0.56;
    drive.connect(limiter);
    limiter.connect(ceiling).connect(ctx.destination);

    // Отражения. Без них синтезированный звук слышен как писк из телефона,
    // а с ними — как прибор, стоящий в комнате: у каждого сигнала есть
    // место, где он прозвучал.
    const pre = ctx.createDelay(0.2);
    pre.delayTime.value = PRE_DELAY;
    const room = ctx.createConvolver();
    // Нормализацию выключаем: с ней громкость хвоста считает браузер, и
    // ранние отражения, у которых уровень задан нарочно, превращались в
    // щелчок — короткий и втрое громче самого звука.
    room.normalize = false;
    room.buffer = this.impulse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = WET;
    // Верх в отражениях режем: стены поглощают его первыми, и без этого
    // хвост шипит.
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 3400;

    // Повтор. Эхо в приборе — не украшение: короткие сигналы без него
    // кончаются слишком резко, а с ним у каждого есть спад.
    const echo = ctx.createDelay(1);
    echo.delayTime.value = ECHO;
    const back = ctx.createGain();
    back.gain.value = ECHO_BACK;
    const echoDamp = ctx.createBiquadFilter();
    echoDamp.type = 'lowpass';
    echoDamp.frequency.value = 2000;
    const send = ctx.createGain();
    send.gain.value = ECHO_SEND;
    // Каждый следующий повтор глуше предыдущего: фильтр стоит в самой петле.
    echo.connect(echoDamp);
    echoDamp.connect(back).connect(echo);
    echoDamp.connect(send);

    // Полка стоит сразу за общим уровнем, до всех посылок: наклон верха
    // должен быть одинаковым и у самого звука, и у его отражений.
    const tilt = ctx.createBiquadFilter();
    tilt.type = 'highshelf';
    tilt.frequency.value = TILT_HZ;
    tilt.gain.value = TILT_DB;

    master.connect(tilt);
    tilt.connect(drive);
    tilt.connect(echo);
    tilt.connect(pre).connect(room).connect(damp).connect(wet).connect(drive);
    send.connect(drive);
    send.connect(pre);
    this.master = master;

    // Шум держим одним буфером на весь сеанс: щелчков за партию сотни, и
    // сочинять каждому свой отрезок случайных чисел незачем.
    const frames = Math.ceil(ctx.sampleRate * 2);
    const noise = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = noise;
  }

  /** Пологая кривая мягкого ограничения — тангенс гиперболический. */
  private saturation(): Float32Array<ArrayBuffer> {
    const size = 1024;
    const curve = new Float32Array(new ArrayBuffer(size * 4));
    const amount = 1.3;
    for (let i = 0; i < size; i++) {
      const x = (i / (size - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
    }
    return curve;
  }

  /**
   * Отклик комнаты: ранние отражения плюс затухающий шум. Настоящую запись
   * сюда класть незачем — файл ради двух секунд хвоста дороже, чем весь
   * остальной звук.
   *
   * Каналы считаются врозь: одинаковый шум слева и справа сложился бы в
   * точку посередине, и вся комната схлопнулась бы обратно в моно.
   */
  private impulse(ctx: BaseAudioContext): AudioBuffer {
    const rate = ctx.sampleRate;
    const frames = Math.ceil(rate * ROOM);
    const buffer = ctx.createBuffer(2, frames, rate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      let smooth = 0;
      for (let i = 0; i < frames; i++) {
        const fade = (1 - i / frames) ** 3;
        // Однополюсный фильтр прямо в буфере: отражения глухие с самого
        // начала, иначе комната звенит песком.
        smooth += 0.24 * (Math.random() * 2 - 1 - smooth);
        data[i] = smooth * fade * 0.5;
      }
      // Ранние отражения — несколько отдельных ударов в первые сорок
      // миллисекунд. Именно по ним ухо считывает размер помещения; без них
      // хвост звучит как «ревербератор», а не как стены.
      //
      // Каждый удар — короткий всплеск с плавным краем, а не одиночный
      // отсчёт: одиночный это щелчок во весь спектр, слышный отдельно от
      // звука. Слева и справа они смещены — так пара ушей и различает,
      // что комната шире головы.
      for (const [at, gain] of [
        [0.0075, 0.3],
        [0.0131, 0.22],
        [0.0208, 0.17],
        [0.0342, 0.12],
      ] as const) {
        const start = Math.floor((at + channel * 0.0013) * rate);
        const span = Math.max(2, Math.floor(rate * 0.0016));
        for (let i = 0; i < span && start + i < frames; i++) {
          // Полуволна косинуса: всплеск начинается и кончается нулём.
          const shape = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / span);
          data[start + i]! += (Math.random() * 2 - 1) * gain * shape;
        }
      }
    }
    // Приводим отклик к своему потолку, а не к мощности, как это делает
    // браузер. Свёртка отдаёт на коротком щелчке ровно самый громкий
    // отсчёт отклика, помноженный на щелчок, — значит потолок отклика и
    // есть предел, во сколько раз комната может усилить резкий звук.
    // С мерой по мощности этот предел оказывался больше единицы, и каждый
    // щелчок вылезал из отражений отдельным треском.
    let energy = 0;
    let loudest = 0;
    for (let channel = 0; channel < 2; channel++) {
      for (const value of buffer.getChannelData(channel)) {
        energy += value * value;
        loudest = Math.max(loudest, Math.abs(value));
      }
    }
    // Мощность задаёт громкость хвоста, потолок — во сколько раз комната
    // усилит короткий щелчок. Нужны оба: берём то, что строже.
    const scale = Math.min(1 / Math.sqrt(Math.max(energy / 2, 1e-9)), 0.05 / Math.max(loudest, 1e-9));
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < frames; i++) data[i]! *= scale;
    }
    return buffer;
  }

  /** Время, к которому привязывается звук; own — для отрисовки в файл. */
  private when(at?: number): number {
    return at ?? this.ctx?.currentTime ?? 0;
  }

  /**
   * Занимает голос под целое событие. Слои внутри него уже ничего не
   * занимают: событие либо звучит целиком, либо не звучит вовсе.
   */
  private slot(at: number, dur: number): boolean {
    if (!this.ctx || !this.master || !this.on) return false;
    this.ends = this.ends.filter((end) => end > at);
    if (this.ends.length >= VOICES) return false;
    this.ends.push(at + dur);
    return true;
  }

  /**
   * Разброс высоты, доля от ноты. Живой прибор не попадает в одну и ту же
   * частоту дважды, и десяток центов разницы — это разница между «сыграно»
   * и «выдано автоматом».
   */
  private wobble(cents = 9): number {
    return 2 ** (((Math.random() * 2 - 1) * cents) / 1200);
  }

  /** Куда посадить звук в панораме. Голоса врозь — прибор шире телефона. */
  private out(pan: number): AudioNode {
    const ctx = this.ctx!;
    if (typeof ctx.createStereoPanner !== 'function') return this.master!;
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    panner.connect(this.master!);
    return panner;
  }

  /**
   * Огибающая. Атака не мгновенная нарочно: острый фронт и есть та резкость,
   * от которой звук колет ухо, а несколько миллисекунд её убирают, не съедая
   * отклика.
   */
  private envelope(gain: GainNode, at: number, peak: number, dur: number, attack = 0.008): void {
    // Гасим узел до всякой автоматизации. Своя громкость у него по умолчанию
    // единица, а назначение действует ровно с указанного времени — и когда
    // время старта из-за округления оказывалось чуть раньше первого
    // назначенного отсчёта, один отсчёт успевал пройти в полный голос. На
    // слух это редкий щелчок в разы громче соседей: тот самый, что выбивался.
    gain.gain.value = 0.0001;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(peak, at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  }

  /**
   * Тело: нота со своими обертонами, при желании со скольжением к другой
   * частоте. Фильтр открыт на атаке и закрывается к концу — так звучит
   * любой ударенный предмет, и именно этого движения не хватало ровному
   * срезу.
   */
  private body(
    at: number,
    freq: number,
    dur: number,
    peak: number,
    options: {
      to?: number;
      cutoff?: number;
      open?: number;
      pan?: number;
      partials?: [number, number][];
      attack?: number;
    } = {},
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const cutoff = options.cutoff ?? 2600;
    const out = this.out(options.pan ?? 0);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.7;
    filter.frequency.setValueAtTime(options.open ?? cutoff * 2.2, at);
    filter.frequency.exponentialRampToValueAtTime(cutoff, at + dur * 0.7);
    const gain = ctx.createGain();
    this.envelope(gain, at, peak, dur, options.attack);
    filter.connect(gain).connect(out);

    const detune = this.wobble();
    for (const [ratio, weight] of options.partials ?? PARTIALS) {
      const osc = ctx.createOscillator();
      const part = ctx.createGain();
      part.gain.value = weight;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * ratio * detune, at);
      if (options.to !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(options.to * ratio * detune, at + dur);
      }
      osc.connect(part).connect(filter);
      osc.start(at);
      osc.stop(at + dur + 0.02);
    }
  }

  /**
   * Щелчок: очень короткий отрезок шума. Всё, что ухо считывает как
   * «дорого», живёт в первых десяти миллисекундах — там и только там
   * прибору позволен верх, потому что резать ухо ему нечем: он кончается
   * раньше, чем ухо успевает возмутиться.
   */
  private click(
    at: number,
    freq: number,
    dur: number,
    peak: number,
    options: { q?: number; pan?: number; high?: boolean } = {},
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noiseBuffer) return;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    const band = ctx.createBiquadFilter();
    band.type = options.high ? 'highpass' : 'bandpass';
    band.frequency.value = freq;
    band.Q.value = options.q ?? 1.4;
    const gain = ctx.createGain();
    this.envelope(gain, at, peak * CLICK, dur, 0.0008);
    source.connect(band).connect(gain).connect(this.out(options.pan ?? 0));
    // Играем случайный кусок общего буфера: два одинаковых щелчка подряд
    // ухо слышит как повтор записи.
    source.start(at, Math.random() * 1.5, dur + 0.02);
  }

  /**
   * Колокол: несколько некратных призвуков, каждый со своим спадом. Верхние
   * гаснут первыми — так гаснет и настоящий металл.
   */
  private bell(at: number, freq: number, dur: number, peak: number, pan = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const out = this.out(pan);
    const detune = this.wobble(6);
    // Удар языка: без него колокол начинается ниоткуда.
    this.click(at, freq * 6, 0.005, peak * 0.55, { q: 0.8, pan, high: true });
    for (const [ratio, weight, span] of BELL_PARTIALS) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * ratio * detune;
      this.envelope(gain, at, peak * weight, dur * span, 0.003);
      osc.connect(gain).connect(out);
      osc.start(at);
      osc.stop(at + dur * span + 0.02);
    }
  }

  /**
   * Мягкий тон: то же тело, но с медленной атакой, кратными обертонами и
   * длинным спадом. У колокола призвуки некратные — оттого он и слышен
   * металлом; здесь над нотой стоят только её собственные кратные, и
   * металла в них нет. Вместо удара языка — короткий выдох, так что звук
   * начинается не с точки, а с наплыва.
   */
  private soft(at: number, freq: number, dur: number, peak: number, pan = 0): void {
    if (!this.ctx || !this.master) return;
    // Выдох: полоса ставится по самой ноте, а не выше неё, поэтому он слышен
    // как воздух внутри звука, а не как щелчок перед ним.
    this.click(at, freq * 1.5, 0.03, peak * 0.16, { q: 0.7, pan });
    this.body(at, freq, dur, peak, {
      cutoff: freq * 3.2,
      open: freq * 5,
      pan,
      attack: 0.03,
      partials: [
        [1, 1],
        [2, 0.18],
        [3, 0.05],
      ],
    });
    // Октава сверху — тише, короче и с другой стороны: она даёт свет, но не
    // звон. Вступает с запозданием, чтобы не слипнуться с основным тоном.
    this.body(at + 0.05, freq * 2, dur * 0.55, peak * 0.2, {
      cutoff: freq * 3,
      open: freq * 4,
      pan: -pan * 0.6,
      attack: 0.05,
      partials: [
        [1, 1],
        [2, 0.08],
      ],
    });
  }

  // ---------- Голоса прибора ----------

  /**
   * Палец лёг на очередную точку: цепочка растёт и поёт.
   *
   * До потолка это обычная нота лестницы. Дальше нота стоит на месте, а рост
   * цепочки берут на себя тембр и место: тело тяжелеет нижней октавой, верх
   * над нотой сходит на нет, щелчок пропадает совсем, фильтр закрывается,
   * звук длиннее и шире по панораме, и вся ступень идёт тише. Длинная
   * цепочка становится не выше короткой, а глубже и спокойнее.
   */
  step(index: number, at?: number): void {
    const t = this.when(at);
    const over = chainOver(index);
    const dur = 0.19 + 0.13 * over;
    if (!this.slot(t, dur)) return;
    // Длинная цепочка идёт ещё и тише: к её концу подряд звучит вдвое больше
    // нот, чем в короткой, и на прежней громкости они складывались в стену.
    const level = stepLevel(index) * (1 - 0.3 * over);
    // Цепочка идёт по полю — пусть идёт и по панораме: ноты расходятся
    // веером, и длинная цепочка на слух шире короткой.
    const pan = Math.max(-0.5, Math.min(0.5, ((index % 7) - 3) * 0.16)) * (1 + 0.6 * over);
    const partials = chainPartials(over);
    const sum = partials.reduce((total, [, weight]) => total + weight, 0);
    // Щелчок к концу длинной цепочки уходит совсем: он весь живёт выше двух
    // килогерц, и звенело в первую очередь оттуда, а не из самой ноты.
    this.click(t, 2400, 0.005, level * 0.35 * (1 - over), { q: 0.8, pan, high: true });
    this.body(t, chainNote(index), dur, (level * PARTIAL_SUM) / sum, {
      cutoff: 2800 - 1900 * over,
      open: 5200 - 3400 * over,
      pan,
      partials,
    });
  }

  /**
   * Цепочка засчитана. Щелчок реле оставлен намеренно тихим: он тут не
   * награда, а отметка о том, что ход принят, — награда звучит выше.
   */
  chain(dots: number, multiplier: number, at?: number): void {
    const t = this.when(at);
    if (!this.slot(t, multiplier > 1 ? 0.8 : 0.6)) return;
    // Два щелчка подряд в паре миллисекунд — это язычок реле и его упор.
    this.click(t, 3600, 0.004, 0.034, { q: 0.7, high: true });
    this.click(t + 0.004, 950, 0.012, 0.038, { q: 1.1 });
    // Ниже сотни герц телефонный динамик уже нем, поэтому низ щелчка не
    // опускаем вместе с остальными: он и так у самого пола.
    this.body(t, 123.5 - Math.min(dots, 12) * 1.5, 0.26, 0.075, {
      to: 98,
      cutoff: 700,
      open: 1400,
      partials: [
        [1, 1],
        [2, 0.12],
      ],
    });
    // Множитель слышен отдельной нотой: он и есть награда за вспышки.
    if (multiplier > 1) this.soft(t + 0.08, deg(9 + multiplier), 0.7, 0.055, 0.18);
  }

  /** Вспышка заряжена: чистый тон, ради которого цепочку и тянули. */
  flash(at?: number): void {
    const t = this.when(at);
    if (!this.slot(t, 1)) return;
    this.soft(t, deg(11), 0.95, 0.07, -0.12);
  }

  /** Открылось окно заказа: прибор звенит цветом. */
  window(at?: number): void {
    const t = this.when(at);
    if (!this.slot(t, 0.4)) return;
    this.click(t, 2600, 0.005, 0.016, { high: true, pan: -0.2 });
    this.body(t, deg(9), 0.16, 0.065, { cutoff: 2400, open: 4200, pan: -0.2 });
    this.body(t + 0.12, deg(11), 0.2, 0.065, { cutoff: 2600, open: 4600, pan: 0.2 });
  }

  /** Касание в заказах: заказ закрыт (награда) или группы не хватило. */
  order(size: number, reward: number, at?: number): void {
    const t = this.when(at);
    if (!this.slot(t, reward > 0 ? 1.4 : 0.4)) return;
    if (reward > 0) {
      // Подъём перед тоном — это и есть само сгорание группы. Раньше он вёл
      // к удару колокола, теперь к наплыву, поэтому и сам стал мягче: щелчок
      // тише и ниже, скольжение длиннее, верх прикрыт.
      this.click(t, 1600, 0.008, 0.012, { q: 0.9 });
      this.body(t, deg(6), 0.34, 0.06, { to: deg(10), cutoff: 1800, open: 3200, attack: 0.02 });
      this.soft(t + 0.2, deg(11), 0.95, 0.075, 0.1);
      // Крупная группа отзывается дважды: её слышно, а не только видно.
      if (size >= 30) this.soft(t + 0.42, deg(14), 0.9, 0.055, -0.16);
    } else {
      // Отказ слышен, но не бьёт: на нём кончается окно, а не заход.
      this.click(t, 700, 0.008, 0.016, { q: 1.2 });
      this.body(t, deg(3), 0.34, 0.075, { to: ROOT * 1.12, cutoff: 800, open: 1600 });
    }
  }

  /** Окно упущено: низкий гудок сбоя. */
  miss(at?: number): void {
    const t = this.when(at);
    if (!this.slot(t, 0.6)) return;
    this.click(t, 480, 0.01, 0.018, { q: 1.1 });
    this.body(t, deg(2), 0.5, 0.08, { to: ROOT * 0.84, cutoff: 700, open: 1500 });
  }

  /** Заявка на цвет: своя идёт вверх, чужая — вниз. */
  claim(mine: boolean, at?: number): void {
    const t = this.when(at);
    if (!this.slot(t, 0.4)) return;
    const pan = mine ? -0.22 : 0.22;
    this.click(t, 2400, 0.004, 0.012, { high: true, pan });
    if (mine) {
      this.body(t, deg(9), 0.14, 0.055, { cutoff: 2400, open: 4200, pan });
      this.body(t + 0.1, deg(12), 0.18, 0.055, { cutoff: 2600, open: 4400, pan });
    } else {
      this.body(t, deg(12), 0.14, 0.05, { cutoff: 1900, open: 3200, pan });
      this.body(t + 0.1, deg(8), 0.2, 0.05, { cutoff: 1700, open: 3000, pan });
    }
  }

  /** Последние секунды: тихий отсчёт, не будильник. */
  tick(at?: number): void {
    const t = this.when(at);
    if (!this.slot(t, 0.14)) return;
    // Отсчёт звучит десять раз подряд и последним, что человек слышит в
    // заходе: ему верх не нужен вовсе, хватает короткой ноты.
    this.click(t, 2800, 0.004, 0.009, { high: true, pan: 0.14 });
    this.body(t, deg(12), 0.08, 0.04, { cutoff: 2200, open: 3400, pan: 0.14 });
  }

  /**
   * Конец: победа — три ступени вверх, поражение и конец захода — сирена.
   * Сирена одна и та же: прибор не злорадствует, он просто выключается.
   */
  over(win: boolean, at?: number): void {
    const t = this.when(at);
    if (!this.slot(t, win ? 1.4 : 1.3)) return;
    if (win) {
      this.bell(t, deg(10), 0.55, 0.075, -0.2);
      this.bell(t + 0.18, deg(12), 0.55, 0.075, 0.2);
      this.bell(t + 0.36, deg(15), 0.9, 0.08, 0);
    } else {
      this.click(t, 600, 0.012, 0.016, { q: 1.2 });
      this.body(t, deg(7), 0.52, 0.07, { to: deg(2), cutoff: 1200, open: 2200, pan: -0.1 });
      this.body(t + 0.46, deg(5), 0.7, 0.065, { to: ROOT * 1.02, cutoff: 1000, open: 1900, pan: 0.1 });
    }
  }
}
