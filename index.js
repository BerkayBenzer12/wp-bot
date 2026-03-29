require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const { google } = require('googleapis');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const auth = new google.auth.GoogleAuth({
  credentials: credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const konusmalar = {};
const calisanlar = {};
const isimBekleyenler = {};

async function calisanKaydet(numara, isim) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'Çalışanlar!A:B',
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[numara, isim]] }
  });
  calisanlar[numara] = isim;
}

async function calisanlariYukle() {
  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'Çalışanlar!A:B'
    });
    const rows = result.data.values || [];
    rows.forEach(r => { if (r[0] && r[1] && r[0] !== 'Numara') calisanlar[r[0]] = r[1]; });
    console.log('Çalışanlar yüklendi:', calisanlar);
  } catch (e) {
    console.log('Çalışanlar sayfası henüz yok.');
  }
}

async function tabloyaEkle(isim, cihaz, marka, model, durum) {
  const tarih = new Date().toLocaleString('tr-TR');
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'Kayıtlar!A:F',
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[tarih, isim, cihaz, marka, model, durum]] }
  });
}

async function kisininAktifEkipmanlari(isim) {
  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'Kayıtlar!A:F'
    });
    const rows = result.data.values || [];
    if (rows.length <= 1) return [];
    
    const kisininKayitlari = rows.slice(1).filter(r => r[1] === isim);
    
    const aktifler = {};
    kisininKayitlari.forEach(r => {
      const anahtar = r[2];
      if (r[5] === 'Atölyeden çıktı') {
        aktifler[anahtar] = { cihaz: r[2], marka: r[3], model: r[4] };
      } else if (r[5] === 'İade edildi') {
        delete aktifler[anahtar];
      }
    });
    
    return Object.values(aktifler);
  } catch (e) {
    return [];
  }
}

async function stokuGetir() {
  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'Kayıtlar!A:F'
    });
    const rows = result.data.values || [];
    if (rows.length <= 1) return 'Henüz kayıt yok.';
    return rows.slice(1).map(r => `• ${r[2]} (${r[3]}) — ${r[1]}, ${r[5]}, ${r[0]}`).join('\n');
  } catch (e) {
    return 'Kayıtlar alınamadı.';
  }
}

app.post('/webhook', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body || '';
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;

  console.log('Mesaj geldi:', from, body, mediaUrl);

  try {
    let reply = '';

    if (isimBekleyenler[from]) {
      const isim = body.trim();
      await calisanKaydet(from, isim);
      delete isimBekleyenler[from];
      konusmalar[from] = [];
      const ad = isim.split(' ')[0];
      reply = `Hoş geldin ${ad}! ⚡ Atölyeden çıkardığın ekipmanın fotoğrafını gönderebilir veya adını yazabilirsin, ben kaydederim.`;
      await twilioClient.messages.create({ from: process.env.TWILIO_WHATSAPP_NUMBER, to: from, body: reply });
      return res.status(200).send('OK');
    }

    if (!calisanlar[from]) {
      isimBekleyenler[from] = true;
      reply = `Merhaba! 👋 Ben Volt. Seni daha önce görmedim, adın ve soyadın nedir? Kayıtlara doğru isimle geçebilmek için soruyorum. 😊`;
      await twilioClient.messages.create({ from: process.env.TWILIO_WHATSAPP_NUMBER, to: from, body: reply });
      return res.status(200).send('OK');
    }

    const isim = calisanlar[from];
    const ad = isim.split(' ')[0];

    if (!konusmalar[from]) konusmalar[from] = [];

    let mesajIcerigi = [];

    if (mediaUrl && mediaType && mediaType.startsWith('image/')) {
      const authHeader = 'Basic ' + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64');
      const imageResponse = await fetch(mediaUrl, { headers: { 'Authorization': authHeader } });
      const imageBuffer = await imageResponse.arrayBuffer();
      const base64Image = Buffer.from(imageBuffer).toString('base64');
      mesajIcerigi = [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
        { type: 'text', text: body || 'Bu ekipmanı atölyeden çıkarmak istiyorum.' }
      ];
    } else {
      mesajIcerigi = [{ type: 'text', text: body }];
    }

    konusmalar[from].push({ role: 'user', content: mesajIcerigi });
    if (konusmalar[from].length > 20) konusmalar[from] = konusmalar[from].slice(-20);

    const stok = await stokuGetir();
    const aktifEkipmanlar = await kisininAktifEkipmanlari(isim);
    const aktifListesi = aktifEkipmanlar.length > 0
      ? aktifEkipmanlar.map(e => `• ${e.cihaz} (${e.marka})`).join('\n')
      : 'Şu an üzerinde kayıtlı ekipman yok.';

    const systemPrompt = `Sen Volt adlı, nazik ve samimi bir atölye ekipman takip botusun. Çalışanın adı "${ad}" (tam isim: ${isim}).

"Alet" kelimesini hiçbir zaman kullanma, bunun yerine "cihaz" veya "ekipman" de.
Konuşurken sadece ilk adını kullan. Tam ismi sadece kayıt sırasında kullan.

Görevin:
- Çalışan atölyeden cihaz veya ekipman çıkardığında onay alıp kaydetmek
- Ekipman iade edildiğinde kaydı güncellemek
- Hangi ekipmanın kimde olduğunu takip etmek
- Elektrik, elektronik, mekanik ve teknik sorulara yardımcı olmak

Çıkış süreci:
1. Fotoğraf veya yazıyla ekipman gelince "görünüşe göre X, doğru mu?" diye sor
2. Kullanıcı onaylarsa veya düzeltme yaparsa, marka ve model bilinmiyorsa "üzerinde bir marka veya seri numarası var mı?" diye sor
3. Kullanıcı bilgi verince veya "yok" diyince KAYIT_ET satırını yaz
4. Kaydettikten sonra "Kaydettim ${ad}! Hata olduğunu düşünürsen bana yazman yeterli." de

İade süreci:
- Kullanıcı iade ettiğini belirtince, üzerindeki aktif ekipman listesine bak
- Listede birden fazla ekipman varsa hangisini iade ettiğini sor
- Listede tek ekipman varsa direkt KAYIT_ET satırını yaz
- Hangi ekipmanı iade ettiği belirsizse sor

KAYIT_ET satırı her zaman tek satırda olsun:
KAYIT_ET: alet=XXX, marka=XXX, model=XXX, durum=Atölyeden çıktı
veya
KAYIT_ET: alet=XXX, marka=XXX, model=XXX, durum=İade edildi

Fotoğraf okurken:
- Emin olmadığın marka/model için "üzerinde X yazıyor" de
- "görünüşe göre", "sanırım" gibi ifadeler kullan ama fazla abartma

Tamamen kişisel konularda: "Bu konuda yardımcı olamam ama teknik konularda buradayım!"

${ad} adlı çalışanın şu an üzerindeki ekipmanlar:
${aktifListesi}

Tüm kayıtlar:
${stok}

Kurallar:
- Türkçe konuş
- Kısa ve sıcak mesajlar
- Madde madde listeleme yapma`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 512,
      system: systemPrompt,
      messages: konusmalar[from]
    });

    reply = response.content[0].text;
    console.log('Claude cevabi:', reply);

    konusmalar[from].push({ role: 'assistant', content: reply });

    if (reply.includes('KAYIT_ET:')) {
      const kayitKismi = reply.match(/KAYIT_ET:\s*alet=([^,]+),\s*marka=([^,]+),\s*model=([^,\n]+),\s*durum=([^\n]+)/);
      if (kayitKismi) {
        try {
          await tabloyaEkle(isim, kayitKismi[1].trim(), kayitKismi[2].trim(), kayitKismi[3].trim(), kayitKismi[4].trim());
          console.log('Sheets kaydedildi:', kayitKismi[1].trim(), kayitKismi[4].trim());
        } catch (sheetsHata) {
          console.error('Sheets hatasi:', sheetsHata.message);
        }
      }
    }

    reply = reply.replace(/KAYIT_ET:[^\n]*/g, '').trim();

    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: reply
    });

    res.status(200).send('OK');
  } catch (error) {
    console.error('Hata:', error);
    res.status(500).send('Hata olustu');
  }
});

app.get('/', (req, res) => {
  res.send('Volt çalışıyor! ⚡');
});

calisanlariYukle();

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Volt ${PORT} portunda çalışıyor`);
});
