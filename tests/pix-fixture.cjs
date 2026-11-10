// Intentionally fake payee; never use this code to receive a real payment.
function pix(amount) {
  const field = (tag, value) => tag + String(value.length).padStart(2, '0') + value;
  const account = field('00', 'br.gov.bcb.pix') + field('01', 'fixture@example.test');
  const value = field('00', '01') + field('26', account) + field('52', '0000') + field('53', '986') + field('54', Number(amount).toFixed(2)) + field('58', 'BR') + field('59', 'FIXTURE MR1') + field('60', 'SAO PAULO') + field('62', field('05', '***')) + '6304';
  let crc = 65535;
  for (const byte of Buffer.from(value)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc & 32768) ? (crc << 1) ^ 4129 : crc << 1) & 65535;
  }
  return value + crc.toString(16).toUpperCase().padStart(4, '0');
}
module.exports = { pix };
