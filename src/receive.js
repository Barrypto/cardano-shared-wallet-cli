import QRCode from 'qrcode';

export async function createTerminalQr(address) {
  return QRCode.toString(address, {
    type: 'terminal',
    errorCorrectionLevel: 'M',
    margin: 1,
    small: true,
  });
}
