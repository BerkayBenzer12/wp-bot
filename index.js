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

const calisanlar = {
  'whatsapp:+905425808521': 'Berkay'
};

async function tabloyaEkle(isim, alet, marka, model) {
  const tarih = new Date().toLocaleString('tr-TR');
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'A:E',
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[tarih, isim, alet, marka, model]]
    }
  });
  return tarih;
}

async function stokuGetir() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'A:E'
  });
  const rows = result.data.values || [];
  if (rows.length <= 1) return 'Stokta henüz kayıt yok.';
  const kayitlar = rows.slice(1).map(r => `• ${r[2]} (${r[3]}) — ${r[1]}, ${r[0]}`).join('\n');
  return kayitlar;
}

app.post('/webhook', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body || '';
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;
  const isim = calisanlar[from] || 'Arkadaş';

  console.log('Mesaj geldi:', from, body, mediaUrl);

  if (!konusmalar[from]) konusmalar[from] = [];

  try {
    let mesajIcerigi = [];

    if (mediaUrl && mediaType && mediaType.startsWith('image/')) {
      const authHeader = 'Basic ' + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64');
      const imageResponse = await fetch(mediaUrl, {
        headers: { 'Authorization': authHeader }
      });
      const imageBuffer = await imageResponse.arrayBuffer();
      const base64Image = Buffer.from(imageBuffer).toString('base64');

      mesajIcerigi = [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: base64Image }
        },
        {
          type: 'text',
          text: body || 'Bu fotoğraftaki aleti kaydetmek istiyorum.'
        }
      ];
    } else {
      mesajIcerigi = [{ type: 'text', text: body }];
    }

    konusmalar[from].push({ role: 'user', content: mesajIcerigi });

    if (konusmalar[from].length > 20) {
      konusmalar[from] = konusmalar[from].slice(-20);
    }

    const stok = await stokuGetir();

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 512,
      system: `Sen "${isim}" isimli çalışana yardım eden nazik ve samimi bir şirket içi alet takip botusun.

Görevin:
- Fotoğraf veya yazıyla gelen aletleri stoka eklemek
- Stok durumu hakkında bilgi vermek
- Şirketle ilgili sorulara yardımcı olmak

Stoka eklemek için kullanıcıdan onay al. Onay gelince şu formatta yanıt ver:
KAYIT_ET: alet=XXX, marka=XXX, model=XXX

Stokla alakasız kişisel sorulara nazikçe "Bu konuda yardımcı olamam ama alet ve ekipman konularında buradayım!" de.

Güncel stok listesi:
${stok}

Kurallar:
- Her zaman Türkçe konuş
- Kısa ve sıcak mesajlar yaz
- ${isim} ismiyle hitap et
- Madde madde listeleme yapma`,
      messages: konusmalar[from]
    });

    const reply = response.content[0].text;
    console.log('Claude cevabi:', reply);

    konusmalar[from].push({ role: 'assistant', content: reply });

    if (reply.includes('KAYIT_ET:')) {
      const kayitKismi = reply.match(/KAYIT_ET:\s*alet=([^,]+),\s*marka=([^,]+),\s*model=(.+)/);
      if (kayitKismi) {
        const alet = kayitKismi[1].trim();
        const marka = kayitKismi[2].trim();
        const model = kayitKismi[3].trim();
        try {
          await tabloyaEkle(isim, alet, marka, model);
          console.log('Sheets kaydedildi:', alet);
        } catch (sheetsHata) {
          console.error('Sheets hatasi:', sheetsHata.message);
        }
      }
    }

    const temizReply = reply.replace(/KAYIT_ET:[^\n]*/g, '').trim();

    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: temizReply
    });

    res.status(200).send('OK');
  } catch (error) {
    console.error('Hata:', error);
    res.status(500).send('Hata olustu');
  }
});

app.get('/', (req, res) => {
  res.send('WP Bot çalışıyor! 🤖');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Bot ${PORT} portunda çalışıyor`);
});
