/** CRC-16/CCITT (polynomial 0x1021). `init` doubles as the session key. */
export function crc16(bytes, init = 0xffff) {
  let crc = init & 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
