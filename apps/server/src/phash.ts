import sharp from 'sharp';

const HASH_SIZE = 8;
const IMG_SIZE = 32;

const COS_TABLE: number[][] = Array.from({ length: HASH_SIZE }, (_, u) =>
  Array.from({ length: IMG_SIZE }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * IMG_SIZE))),
);

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export async function computePHash(inputPath: string): Promise<string | null> {
  try {
    const data = await sharp(inputPath).resize(IMG_SIZE, IMG_SIZE, { fit: 'fill' }).grayscale().raw().toBuffer();
    if (data.length !== IMG_SIZE * IMG_SIZE) return null;

    const coeffs: number[] = [];
    for (let u = 0; u < HASH_SIZE; u += 1) {
      const cu = u === 0 ? 1 / Math.sqrt(2) : 1;
      for (let v = 0; v < HASH_SIZE; v += 1) {
        const cv = v === 0 ? 1 / Math.sqrt(2) : 1;
        let sum = 0;
        for (let x = 0; x < IMG_SIZE; x += 1) {
          const cosUx = COS_TABLE[u][x];
          for (let y = 0; y < IMG_SIZE; y += 1) {
            const idx = x * IMG_SIZE + y;
            sum += data[idx] * cosUx * COS_TABLE[v][y];
          }
        }
        coeffs.push(0.25 * cu * cv * sum);
      }
    }

    const mid = median(coeffs.slice(1));
    let hash = 0n;
    for (let i = 0; i < coeffs.length; i += 1) {
      if (coeffs[i] > mid) {
        hash |= 1n << BigInt(coeffs.length - 1 - i);
      }
    }
    return hash.toString(16).padStart(16, '0');
  } catch {
    return null;
  }
}

export function hammingDistanceHex(a: string, b: string): number {
  try {
    let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
    let count = 0;
    while (x) {
      count += Number(x & 1n);
      x >>= 1n;
    }
    return count;
  } catch {
    return 64;
  }
}
