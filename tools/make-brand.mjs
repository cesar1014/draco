import { deflateSync, inflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Gera os arquivos de marca a partir da arte original.
 *
 * A arte vem com fundo branco. Aqui ele é recortado e o resto é reduzido para os
 * tamanhos que o site, o PWA e o executável pedem. Sem `sharp` nem `canvas`: PNG
 * sem interlace é cabeçalho, deflate e CRC32, e o zlib já vem no Node.
 *
 * Uso: `npm run brand -- "caminho/da/arte.png"`
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = process.argv[2] ?? join(root, "brand", "logo-source.png");

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

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Decodifica PNG RGBA de 8 bits sem interlace — o que qualquer editor exporta. */
function decodePng(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  const parts = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        throw new Error("A arte precisa ser PNG RGBA de 8 bits, sem interlace.");
      }
    } else if (type === "IDAT") {
      parts.push(data);
    } else if (type === "IEND") {
      break;
    }

    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(parts));
  const rgba = Buffer.alloc(width * height * 4);
  const stride = width * 4;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));

    for (let x = 0; x < stride; x += 1) {
      const a = x >= 4 ? rgba[y * stride + x - 4] : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? rgba[(y - 1) * stride + x - 4] : 0;
      let value = line[x];

      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }

      rgba[y * stride + x] = value & 0xff;
    }
  }

  return { width, height, rgba };
}

/**
 * Recorta o fundo pelas bordas, não por cor.
 *
 * Cortar "tudo que é branco" comeria os brancos de dentro do desenho — dentes,
 * miolo do escudo. Espalhando a partir da borda, só sai o que está de fato fora.
 * O tom entre 200 e 255 vira alfa parcial, e é isso que mantém a borda lisa em
 * vez de serrada.
 */
function cutBackground({ width, height, rgba }) {
  const seen = new Uint8Array(width * height);
  const queue = [];

  const luma = (i) => 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];

  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = y * width + x;
    if (seen[i] || luma(i) < 200) return;
    seen[i] = 1;
    queue.push(i);
  };

  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y);
    push(width - 1, y);
  }

  while (queue.length) {
    const i = queue.pop();
    const x = i % width;
    const y = (i - x) / width;

    // 255 sai inteiro, 200 fica pela metade: a transição é a antialias da arte.
    rgba[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(((255 - luma(i)) * 255) / 55)));

    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }

  return { width, height, rgba };
}

/** Reduz por média de área, com cor pré-multiplicada pelo alfa. */
function resize(image, size) {
  const out = Buffer.alloc(size * size * 4);
  const scale = image.width / size;

  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor(y * scale);
    const y1 = Math.min(image.height, Math.ceil((y + 1) * scale));

    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.min(image.width, Math.ceil((x + 1) * scale));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;

      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * image.width + sx) * 4;
          const alpha = image.rgba[i + 3] / 255;
          r += image.rgba[i] * alpha;
          g += image.rgba[i + 1] * alpha;
          b += image.rgba[i + 2] * alpha;
          a += image.rgba[i + 3];
          n += 1;
        }
      }

      const i = (y * size + x) * 4;
      const alpha = a / n;
      const weight = alpha > 0 ? n * (alpha / 255) : 1;
      out[i] = Math.round(r / weight);
      out[i + 1] = Math.round(g / weight);
      out[i + 2] = Math.round(b / weight);
      out[i + 3] = Math.round(alpha);
    }
  }

  return { width: size, height: size, rgba: out };
}

function insideRoundedRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * Ícone de aplicativo: fundo escuro com degradê e a arte por cima.
 *
 * Fundo escuro e não colorido porque a arte já é azul — azul sobre azul sumiria
 * na barra de tarefas. `inset` reserva a área que o Android e o Windows recortam.
 */
function appIcon(art, size, { radius, inset }) {
  const canvas = Buffer.alloc(size * size * 4);
  const inner = Math.round(size * (1 - inset * 2));
  const scaled = resize(art, inner);
  const origin = Math.round((size - inner) / 2);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const t = (x / size + y / size) / 2;
      canvas[i] = Math.round(14 + t * 29);
      canvas[i + 1] = Math.round(16 + t * 32);
      canvas[i + 2] = Math.round(42 + t * 79);
      canvas[i + 3] = radius
        ? insideRoundedRect((x + 0.5) / size, (y + 0.5) / size, radius)
          ? 255
          : 0
        : 255;
    }
  }

  for (let y = 0; y < inner; y += 1) {
    for (let x = 0; x < inner; x += 1) {
      const src = (y * inner + x) * 4;
      const alpha = scaled.rgba[src + 3] / 255;
      if (!alpha) continue;

      const dst = ((y + origin) * size + x + origin) * 4;
      for (let c = 0; c < 3; c += 1) {
        canvas[dst + c] = Math.round(scaled.rgba[src + c] * alpha + canvas[dst + c] * (1 - alpha));
      }
      canvas[dst + 3] = Math.max(canvas[dst + 3], scaled.rgba[src + 3]);
    }
  }

  return encodePng(size, size, canvas);
}

const art = cutBackground(decodePng(readFileSync(source)));

const brandDir = join(root, "client", "public", "brand");
const iconDir = join(root, "client", "public", "icons");
mkdirSync(brandDir, { recursive: true });
mkdirSync(iconDir, { recursive: true });

const files = [];

for (const size of [1024, 512, 256, 128, 64]) {
  const image = size === art.width ? art : resize(art, size);
  files.push([join(brandDir, `logo-${size}.png`), encodePng(size, size, image.rgba)]);
}

files.push([join(iconDir, "icon-192.png"), appIcon(art, 192, { radius: 0.22, inset: 0.08 })]);
files.push([join(iconDir, "icon-512.png"), appIcon(art, 512, { radius: 0.22, inset: 0.08 })]);
files.push([
  join(iconDir, "icon-maskable-512.png"),
  appIcon(art, 512, { radius: 0, inset: 0.19 }),
]);
// O executável do Windows usa o mesmo ícone do PWA.
files.push([join(root, "desktop", "icon.png"), appIcon(art, 512, { radius: 0.22, inset: 0.08 })]);

for (const [path, data] of files) {
  writeFileSync(path, data);
  console.log(`  ${path.replace(root, ".")}  ·  ${(data.length / 1024).toFixed(1)} kB`);
}
