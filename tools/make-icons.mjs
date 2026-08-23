import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Gera os ícones PNG do aplicativo instalável.
 *
 * Escrever um codificador de PNG à mão parece exagero, mas a alternativa era
 * adicionar `sharp` ou `canvas` ao projeto — dependências nativas que precisam
 * compilar — só pra desenhar um microfone. Aqui não há dependência nenhuma: PNG
 * sem interlace é cabeçalho, `deflate` e CRC32, e o `zlib` já vem no Node.
 *
 * Rode com `npm run icons`. Os arquivos vão pra `client/public/icons/`, que o
 * Vite copia pra raiz da build.
 */
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "client", "public", "icons");

/** Blurple do Discord, o mesmo `--blurple` do CSS. */
const BRAND = [0x58, 0x65, 0xf2];

/** Amostras por eixo dentro de cada pixel. 3×3 já deixa a borda lisa. */
const SUPERSAMPLE = 3;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let c = -1;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Um chunk de PNG: tamanho, tipo, dados e o CRC de (tipo + dados). */
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    // Byte 0 de cada linha é o filtro; 0 = nenhum. O `deflate` comprime bem
    // mesmo sem filtro, e ícone não é arquivo grande.
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Retângulo de cantos redondos: a distância do ponto até o retângulo interno
 * (o original encolhido pelo raio) tem que caber no raio. Um teste só resolve
 * cantos, laterais e miolo, sem casos especiais.
 */
function insideRoundedRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * O microfone, em coordenadas de 0 a 1. `scale` encolhe em torno do centro —
 * é o que mantém o desenho dentro da área segura do ícone mascarável, que o
 * Android e o Windows recortam em círculo ou em quadrado arredondado.
 */
function insideMic(x, y, scale) {
  const gx = (x - 0.5) / scale + 0.5;
  const gy = (y - 0.5) / scale + 0.5;

  // Corpo: cápsula vertical.
  if (insideRoundedRect(gx, gy, 0.42, 0.18, 0.58, 0.5, 0.08)) return true;

  // Berço: meia-lua aberta em cima, mais larga que o corpo.
  const dx = gx - 0.5;
  const dy = gy - 0.46;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dy >= 0 && dist <= 0.225 && dist >= 0.18) return true;

  // Haste e base.
  if (insideRoundedRect(gx, gy, 0.478, 0.66, 0.522, 0.775, 0.022)) return true;
  if (insideRoundedRect(gx, gy, 0.375, 0.755, 0.625, 0.8, 0.022)) return true;

  return false;
}

function render(size, radius, glyphScale) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let background = 0;
      let glyph = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size;
          if (insideRoundedRect(x, y, 0, 0, 1, 1, radius)) background += 1;
          if (insideMic(x, y, glyphScale)) glyph += 1;
        }
      }

      const g = glyph / samples;
      const i = (py * size + px) * 4;
      // Branco por cima do blurple; o alfa é a silhueta do fundo.
      rgba[i] = Math.round(BRAND[0] * (1 - g) + 255 * g);
      rgba[i + 1] = Math.round(BRAND[1] * (1 - g) + 255 * g);
      rgba[i + 2] = Math.round(BRAND[2] * (1 - g) + 255 * g);
      rgba[i + 3] = Math.round((background / samples) * 255);
    }
  }

  return encodePng(size, rgba);
}

const variants = [
  // Cantos redondos e glifo cheio: é assim que aparece na lista de aplicativos.
  { file: "icon-192.png", size: 192, radius: 0.2, glyphScale: 0.78 },
  { file: "icon-512.png", size: 512, radius: 0.2, glyphScale: 0.78 },
  // Mascarável: quadrado inteiro, glifo menor. Quem recorta é o sistema, e ele
  // pode cortar até 20% de cada lado — desenho grande sairia sem as pontas.
  { file: "icon-maskable-512.png", size: 512, radius: 0, glyphScale: 0.62 },
];

mkdirSync(outDir, { recursive: true });
for (const { file, size, radius, glyphScale } of variants) {
  const png = render(size, radius, glyphScale);
  writeFileSync(join(outDir, file), png);
  console.log(`  ${file}  ·  ${size}×${size}  ·  ${(png.length / 1024).toFixed(1)} kB`);
}
