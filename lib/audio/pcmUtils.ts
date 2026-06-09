import { fromByteArray } from 'base64-js';

export function float32ToInt16LE(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

export function int16ToFloat32(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i] / (samples[i] < 0 ? 0x8000 : 0x7fff);
  }
  return out;
}

export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return fromByteArray(bytes);
}

export function base64ToInt16LE(b64: string): Int16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

export function decodeInlineAudioData(data: string | Uint8Array | ArrayBuffer): Int16Array {
  if (typeof data === 'string') {
    return base64ToInt16LE(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Int16Array(data);
  }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}
