export function renderQrCode(container, text) {
  if (!window.qrcode) {
    container.hidden = true;
    container.innerHTML = '';
    return false;
  }
  try {
    const qr = window.qrcode(0, 'L');
    qr.addData(text);
    qr.make();
    container.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    container.hidden = false;
    return true;
  } catch (err) {
    console.error('QR render failed', err);
    container.hidden = true;
    container.innerHTML = '';
    return false;
  }
}
