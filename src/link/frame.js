import { crc16 } from './crc.js';

/**
 * A frame is what one chirp carries:
 *
 *   header   1 byte   message type (high 4 bits), payload length in bytes (low 4 bits)
 *   payload  0-15 bytes
 *   check    2 bytes  CRC-16 over header and payload, started from a key
 *
 * Before two devices are paired the key is DEFAULT_KEY. After pairing they use a
 * key derived from the pairing nonce, so chirps from another pair of players in
 * the same room fail the check and are ignored.
 */
export const DEFAULT_KEY = 0xffff;
export const MAX_PAYLOAD = 15;
export const MAX_FRAME_BYTES = 1 + MAX_PAYLOAD + 2;

/** Total frame length in bytes, read from the header byte. */
export const frameBytes = (header) => 1 + (header & 0x0f) + 2;

export function encodeFrame(type, payload, key = DEFAULT_KEY) {
  if (!Number.isInteger(type) || type < 0 || type > 15) throw new RangeError('frame type must be 0-15');
  if (payload.length > MAX_PAYLOAD) throw new RangeError('frame payload is too long');
  const bytes = new Uint8Array(1 + payload.length + 2);
  bytes[0] = (type << 4) | payload.length;
  bytes.set(payload, 1);
  const crc = crc16(bytes.subarray(0, bytes.length - 2), key);
  bytes[bytes.length - 2] = crc >> 8;
  bytes[bytes.length - 1] = crc & 0xff;
  return bytes;
}

/** Returns { type, payload }, or null if the bytes are not a valid frame for this key. */
export function decodeFrame(bytes, key = DEFAULT_KEY) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 3 || bytes.length !== frameBytes(bytes[0])) return null;
  const body = bytes.subarray(0, bytes.length - 2);
  const crc = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  if (crc16(body, key) !== crc) return null;
  return { type: bytes[0] >> 4, payload: bytes.slice(1, bytes.length - 2) };
}
