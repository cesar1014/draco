/**
 * Redução de ruído espectral, na thread de áudio.
 *
 * Ganho de Wiener com SNR a priori dirigido pela decisão (Ephraim-Malah). Janela
 * de 512 com salto de 128, o mesmo bloco que o worklet entrega por chamada,
 * então cada `process` é exatamente um quadro de STFT. Atraso: 384 amostras.
 */

const N = 512;
const HOP = 128;
const BINS = N / 2 + 1;

class FFT {
  constructor(n) {
    this.n = n;
    const bits = Math.log2(n) | 0;
    this.rev = new Uint16Array(n);
    for (let i = 0; i < n; i += 1) {
      let r = 0;
      for (let b = 0; b < bits; b += 1) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i += 1) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
  }

  run(re, im, inverse) {
    const n = this.n;
    for (let i = 0; i < n; i += 1) {
      const j = this.rev[i];
      if (j <= i) continue;
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j += 1, k += step) {
          const c = this.cos[k];
          const s = inverse ? -this.sin[k] : this.sin[k];
          const a = i + j;
          const b = a + half;
          const tre = re[b] * c - im[b] * s;
          const tim = re[b] * s + im[b] * c;
          re[b] = re[a] - tre;
          im[b] = im[a] - tim;
          re[a] += tre;
          im[a] += tim;
        }
      }
    }
    if (!inverse) return;
    for (let i = 0; i < n; i += 1) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

class Denoise extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const preset = options?.processorOptions ?? {};
    this.tune(preset);
    this.port.onmessage = ({ data }) => this.tune(data);

    this.fft = new FFT(N);
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i += 1) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    // Hann aplicada na análise e na síntese com 4x de sobreposição soma 1,5.
    this.norm = 1 / 1.5;

    this.inBuf = new Float32Array(N);
    this.outBuf = new Float32Array(N);
    this.re = new Float32Array(N);
    this.im = new Float32Array(N);
    this.power = new Float32Array(BINS);
    this.noise = new Float32Array(BINS);
    this.snr = new Float32Array(BINS).fill(1);
    this.gain = new Float32Array(BINS).fill(1);
    this.smooth = new Float32Array(BINS);
    this.frames = 0;
    this.open = 1;

    this.lo = Math.max(1, Math.round((250 * N) / sampleRate));
    this.hi = Math.min(BINS - 1, Math.round((3800 * N) / sampleRate));
  }

  /**
   * `floor` é o quanto sobra do ruído fora da banda de voz, e `voiceFloor` o
   * quanto sobra dentro dela. Os dois existem separados porque é aí que mora a
   * diferença entre "forte" e "ilegível": cortar 24 dB numa consoante surda
   * (s, f, ch, t) apaga a consoante, e a frase passa a soar mastigada. Fora de
   * 250–3800 Hz não há fala pra preservar, e ali o corte pode ser fundo.
   *
   * `gate` é o quanto sobra entre as frases.
   */
  tune(preset) {
    if (typeof preset?.floor === "number") this.floor = preset.floor;
    if (typeof preset?.voiceFloor === "number") this.voiceFloor = preset.voiceFloor;
    if (typeof preset?.gate === "number") this.gate = preset.gate;
    this.floor ??= 0.16;
    this.voiceFloor ??= 0.2;
    this.gate ??= 0.24;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (!input) {
      output.fill(0);
      return true;
    }

    this.inBuf.copyWithin(0, HOP);
    this.inBuf.set(input, N - HOP);

    for (let i = 0; i < N; i += 1) {
      this.re[i] = this.inBuf[i] * this.win[i];
      this.im[i] = 0;
    }
    this.fft.run(this.re, this.im, false);

    this.frames += 1;
    let bandSum = 0;
    let bandCount = 0;

    for (let k = 0; k < BINS; k += 1) {
      const raw = this.re[k] * this.re[k] + this.im[k] * this.im[k] + 1e-12;
      if (this.frames === 1) {
        this.power[k] = raw;
        this.noise[k] = raw;
      }
      // Um quadro só tem 2 graus de liberdade: no valor cru cada bin de ruído
      // varia num fator de 10, e decidir "é voz?" nisso fabrica chuvisco.
      this.power[k] = 0.8 * this.power[k] + 0.2 * raw;

      const post = this.power[k] / this.noise[k];
      /**
       * O piso aprende a média do ruído e congela onde há voz: congelar por
       * limiar só funciona sobre o valor suavizado, senão o piso vira a média
       * dos quadros mais fracos, sai menor que o ruído e o ganho nunca fecha.
       * Congelado ainda sobe um fio (ventilador que liga no meio da frase) e
       * desce rápido quando está alto demais (microfone que abre já falando).
       */
      const learn = this.frames < 8 ? 0 : post > 2 ? 0.9995 : post < 0.5 ? 0.8 : 0.96;
      this.noise[k] = learn * this.noise[k] + (1 - learn) * this.power[k];

      const prio = 0.98 * this.snr[k] + 0.02 * Math.max(post - 1, 0);
      // Dentro da banda de voz o piso é mais alto: é lá que estão as consoantes
      // surdas, que têm pouca energia e viram silêncio se o corte for fundo.
      const inVoice = k >= this.lo && k <= this.hi;
      const g = Math.max(inVoice ? this.voiceFloor : this.floor, prio / (1 + prio));
      this.gain[k] = g;
      this.snr[k] = g * g * post;
      // O portão olha o valor cru: média de 35 bins já é estável, e reage no
      // primeiro quadro da palavra em vez de esperar a suavização subir.
      if (inVoice) {
        bandSum += raw / this.noise[k];
        bandCount += 1;
      }
    }

    // Só um fio entre vizinhos: mais que isso derruba 2 dB dos harmônicos da
    // voz, e o pouco aqui já mata o bin solto que passa e soa como apito.
    for (let k = 0; k < BINS; k += 1) {
      const a = this.gain[k === 0 ? 0 : k - 1];
      const c = this.gain[k === BINS - 1 ? k : k + 1];
      this.smooth[k] = 0.1 * a + 0.8 * this.gain[k] + 0.1 * c;
    }

    const target = (bandCount ? bandSum / bandCount : 0) > 1.7 ? 1 : this.gate;
    // Abre rápido pra não comer o início da palavra, fecha devagar pra não bombear.
    this.open += (target - this.open) * (target > this.open ? 0.5 : 0.02);

    for (let k = 0; k < BINS; k += 1) {
      const g = this.smooth[k] * this.open;
      this.re[k] *= g;
      this.im[k] *= g;
      if (k === 0 || k === N / 2) continue;
      this.re[N - k] = this.re[k];
      this.im[N - k] = -this.im[k];
    }

    this.fft.run(this.re, this.im, true);

    for (let i = 0; i < N; i += 1) this.outBuf[i] += this.re[i] * this.win[i] * this.norm;
    output.set(this.outBuf.subarray(0, HOP));
    this.outBuf.copyWithin(0, HOP);
    this.outBuf.fill(0, N - HOP);

    return true;
  }
}

registerProcessor("draco-denoise", Denoise);
