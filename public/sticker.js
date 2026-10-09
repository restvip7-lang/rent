// A flat, printable design. The QR comes from the authenticated server endpoint.
export async function createSticker(apartment, complex, qrUrl) {
  const response = await fetch(qrUrl);
  if (!response.ok) throw new Error('Не удалось загрузить QR. Обновите страницу и войдите снова.');
  const qrBlob = await response.blob();
  const url = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(qrBlob); });
  const image = new Image();
  try {
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('Не удалось прочитать QR-код.')); image.src = url; });
    const canvas = document.createElement('canvas'); canvas.width = 1500; canvas.height = 2100;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f8f6f2'; ctx.fillRect(0, 0, 1500, 2100);
    ctx.textAlign = 'center'; ctx.fillStyle = '#202624';
    function text(value, y, size, family = 'Arial', color = '#202624', max = 1340) {
      ctx.fillStyle = color;
      do { ctx.font = `${size}px ${family}`; if (ctx.measureText(value).width <= max) break; size--; } while (size > 12);
      ctx.fillText(value, 750, y);
    }
    text('S T A Y   P R O P E R T Y', 130, 35);
    text('Ваш гид по квартире', 300, 100, 'Georgia');
    text('Your apartment guide', 380, 65, 'Georgia');
    const labels = [['Wi-Fi', 'Wi-Fi'], ['Инструкции', 'House guide'], ['Связь с менеджером', 'Contact your manager']];
    for (let i = 0; i < 3; i++) {
      const x = 300 + i * 450;
      ctx.strokeStyle = '#202624'; ctx.lineWidth = 7; ctx.lineCap = 'round';
      ctx.beginPath();
      if (i === 0) { for (const r of [32, 62, 92]) { ctx.moveTo(x + Math.cos(-2.35)*r, 595 + Math.sin(-2.35)*r); ctx.arc(x,595,r,-2.35,-.79); } }
      if (i === 1) { ctx.rect(x-43,490,86,108); for (const y of [520,545,570]) { ctx.moveTo(x-23,y); ctx.lineTo(x+23,y); } }
      if (i === 2) { ctx.roundRect(x-65,490,130,95,18); ctx.moveTo(x-40,585); ctx.lineTo(x-55,608); for (const dx of [-30,0,30]) { ctx.moveTo(x+dx,537); ctx.lineTo(x+dx+1,537); } }
      ctx.stroke(); ctx.fillStyle = '#202624'; ctx.font = 'bold 32px Arial'; ctx.fillText(labels[i][0],x,665); ctx.font = '27px Arial'; ctx.fillText(labels[i][1],x,712);
    }
    ctx.fillStyle = '#fff'; ctx.fillRect(340,795,820,820);
    ctx.imageSmoothingEnabled = false; ctx.drawImage(image,350,805,800,800);
    text('Наведите камеру телефона', 1735, 57, 'Arial', '#ec611b');
    text('Scan with your phone camera', 1800, 43);
    text('Всё для комфортного проживания', 1890, 34);
    ctx.strokeStyle = '#c9c0b2'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(140,1940); ctx.lineTo(1360,1940); ctx.stroke();
    text(apartment.name, 2005, 48, 'Georgia');
    text(complex?.name || '', 2060, 30, 'Arial', '#726a5d');
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Не удалось создать наклейку.');
    return blob;
  } finally { URL.revokeObjectURL(url); }
}
