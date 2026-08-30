import type { TrackProfile } from "@/rtc/engine";
import type { PeerStats } from "@/rtc/stats";

/**
 * Qualidade adaptativa do lado de quem envia.
 *
 * O navegador já reduz sozinho quando a rede aperta, mas ele reage devagar e
 * dentro do teto que a gente deu. Se o teto for 4 Mbps numa linha que só
 * entrega 1,5, o resultado é uma transmissão travando aos poucos em vez de uma
 * transmissão menor e fluida. Aqui a gente mexe no teto.
 *
 * A escada é discreta de propósito, e a subida exige um período bom de calma:
 * teto que oscila a cada amostra produz vídeo que respira, que incomoda mais que
 * vídeo consistentemente menor.
 */

/** Degraus multiplicando o teto escolhido pela pessoa. */
const STEPS = [1, 0.7, 0.45, 0.3, 0.2] as const;

/** Divisor de resolução por degrau: baixar banda sem baixar tamanho só borra. */
const SCALE = [1, 1, 1.5, 2, 2] as const;

/** Perda relatada pelo outro lado a partir da qual a rede está claramente saturada. */
const LOSS_DOWN = 4;
/** Abaixo disso a rede está confortável, e só então vale tentar subir. */
const LOSS_UP = 1;
const RTT_DOWN = 300;

/** Amostras seguidas boas antes de subir um degrau. A ~1 s cada, uns 16 segundos. */
const CALM_SAMPLES = 16;
/** Depois de descer, ignora as próximas amostras: a rede ainda está se acomodando. */
const COOLDOWN_SAMPLES = 3;

export interface AdaptiveDecision {
  /** Degrau atual, 0 é o teto cheio. */
  step: number;
  /** Multiplicador de banda e divisor de resolução do degrau. */
  factor: number;
  scale: number;
  /** Mudou de degrau agora: só então vale reaplicar o perfil. */
  changed: boolean;
}

/**
 * Uma instância por transmissão. Recebe as amostras de todos os destinos e
 * decide por um degrau só: em malha o teto é compartilhado, então quem manda é
 * a pior conexão: não dá pra mandar 1080p pra um e 480p pra outro na mesma
 * trilha.
 */
export class AdaptiveController {
  #step = 0;
  #calm = 0;
  #cooldown = 0;

  get step(): number {
    return this.#step;
  }

  /** Degrau vigente, sem observar nada. Serve pra reaplicar um perfil novo. */
  current(): AdaptiveDecision {
    return this.#decision(this.#step);
  }

  /** Volta ao teto cheio. Chamado quando a transmissão recomeça. */
  reset(): void {
    this.#step = 0;
    this.#calm = 0;
    this.#cooldown = 0;
  }

  /**
   * `samples` são as leituras desta rodada, uma por destino. Sem amostra nenhuma
   * não há decisão a tomar: manter o degrau é mais seguro que adivinhar.
   */
  observe(samples: PeerStats[]): AdaptiveDecision {
    const before = this.#step;
    if (samples.length === 0) return this.#decision(before);

    const worstLoss = Math.max(...samples.map((sample) => sample.sendLoss));
    const worstRtt = Math.max(...samples.map((sample) => sample.rtt ?? 0));
    // A banda que o navegador estima; `Infinity` quando ninguém informou, pra não
    // interpretar "não sei" como "não tem banda".
    const headroom = Math.min(
      ...samples.map((sample) => (sample.available === null ? Infinity : sample.available)),
    );
    const sending = Math.max(...samples.map((sample) => sample.up));

    // Estourar a banda estimada é sinal mais direto que perda: a perda só aparece
    // depois de a fila encher.
    const overBudget = headroom !== Infinity && sending > headroom * 1.15;
    const struggling = worstLoss >= LOSS_DOWN || worstRtt >= RTT_DOWN || overBudget;

    if (this.#cooldown > 0) this.#cooldown -= 1;

    if (struggling) {
      this.#calm = 0;
      if (this.#cooldown === 0 && this.#step < STEPS.length - 1) {
        this.#step += 1;
        this.#cooldown = COOLDOWN_SAMPLES;
      }
      return this.#decision(before);
    }

    const comfortable = worstLoss <= LOSS_UP && worstRtt < RTT_DOWN && !overBudget;
    if (!comfortable) {
      this.#calm = 0;
      return this.#decision(before);
    }

    this.#calm += 1;
    if (this.#calm >= CALM_SAMPLES && this.#step > 0 && this.#cooldown === 0) {
      this.#step -= 1;
      this.#calm = 0;
    }
    return this.#decision(before);
  }

  #decision(before: number): AdaptiveDecision {
    return {
      step: this.#step,
      factor: STEPS[this.#step],
      scale: SCALE[this.#step],
      changed: this.#step !== before,
    };
  }
}

/** Aplica o degrau sobre o perfil que a pessoa escolheu. */
export function scaleProfile(profile: TrackProfile, decision: AdaptiveDecision): TrackProfile {
  return {
    ...profile,
    maxBitrate: Math.round(profile.maxBitrate * decision.factor),
    scaleResolutionDownBy: (profile.scaleResolutionDownBy ?? 1) * decision.scale,
  };
}
