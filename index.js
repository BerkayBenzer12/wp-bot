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

const bekleyenOnaylar = {};

const calisanlar = {
  'whatsapp:+905425808521': 'Berkay'
};

async function tabloyaEkle(tarih, isim, alet, marka, model) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'A:F',
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[tarih, isim, alet, marka, model, '']]
    }
  });
}

app.post('/webhook', async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || '').trim().toLowerCase();
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;
  const isim = calisanlar[from] || 'Arkadaş';

  console.log('Mesaj geldi:', from, body, mediaUrl);

  try {
    let reply = '';

    if (bekleyenOnaylar[from]) {
      const bekleyen = bekleyenOnaylar[from];
      if (body === 'evet' || body === 'e') {
        const tarih = new Date().toLocaleString('tr-TR');
        try {
          await tabloyaEkle(tarih, isim, bekleyen.alet, bekleyen.marka, bekleyen.model);
          console.log('Sheets kaydedildi');
        } catch (sheetsHata) {
          console.error('Sheets hatasi:', sheetsHata.message);
        }
        delete bekleyenOnaylar[from];
        reply = `✅ Tamam ${isim}, stoka eklendi.`;
      } else if (body === 'hayır' || body === 'hayir' || body === 'h') {
        delete bekleyenOnaylar[from];
        reply = `❌ İptal edildi ${isim}.`;
      } else {
        reply = `${isim}, lütfen sadece *Evet* veya *Hayır* yaz.`;
      }

    } else if (mediaUrl && mediaType && mediaType.startsWith('image/')) {
      const authHeader = 'Basic ' + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64');
      const imageResponse = await fetch(mediaUrl, {
        headers: { 'Authorization': authHeader }
      });
      const imageBuffer = await imageResponse.arrayBuffer();
      const base64Image = Buffer.from(imageBuffer).toString('base64');

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: base64Image
              }
            },
            {
              type: 'text',
              text: `Bu fotoğraftaki aleti tanımla. Sadece şu formatta cevap ver, başka hiçbir şey yazma:
ALET: (alet adı)
MARKA: (marka, bilinmiyorsa Bilinmiyor)
MODEL: (model, bilinmiyorsa Bilinmiyor)
Fotoğrafta alet yoksa sadece ALET DEĞİL yaz.`
            }
          ]
        }]
      });

      const cevap = response.content[0].text;
      console.log('Claude cevabi:', cevap);

      if (cevap.includes('ALET DEĞİL')) {
        reply = `${isim}, fotoğrafta alet göremedim. Tekrar çeker misin?`;
      } else {
        const alet = (cevap.match(/ALET:\s*(.+)/) || [])[1]?.trim() || 'Bilinmiyor';
        const marka = (cevap.match(/MARKA:\s*(.+)/) || [])[1]?.trim() || 'Bilinmiyor';
        const model = (cevap.match(/MODEL:\s*(.+)/) || [])[1]?.trim() || 'Bilinmiyor';

        bekleyenOnaylar[from] = { alet, marka, model };

        reply = `${isim}, şunu ekleyeyim mi?\n\n🔧 ${alet}\n🏷️ ${marka} - ${model}\n\n*Evet* veya *Hayır*`;
      }

  } else {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 256,
        system: `Sen bir şirket içi alet ve ekipman takip botusun. 
Eğer kullanıcı bir alet veya cihaz adı yazıyorsa, şu formatta cevap ver:
ALET: (alet adı)
MARKA: Bilinmiyor
MODEL: Bilinmiyor

Eğer şirketle alakasız bir soru soruyorsa sadece "Bu konuda yardımcı olamam." de.
Başka hiçbir şey yazma. Türkçe konuş.`,
        messages: [{ role: 'user', content: body }]
      });

      const cevap = response.content[0].text;

      if (cevap.includes('ALET:')) {
        const alet = (cevap.match(/ALET:\s*(.+)/) || [])[1]?.trim() || body;
        const marka = (cevap.match(/MARKA:\s*(.+)/) || [])[1]?.trim() || 'Bilinmiyor';
        const model = (cevap.match(/MODEL:\s*(.+)/) || [])[1]?.trim() || 'Bilinmiyor';

        bekleyenOnaylar[from] = { alet, marka, model };
        reply = `${isim}, şunu ekleyeyim mi?\n\n🔧 ${alet}\n🏷️ ${marka} - ${model}\n\n*Evet* veya *Hayır*`;
      } else {
        reply = 'Bu konuda yardımcı olamam.';
      }
    }


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
  res.send('WP Bot çalışıyor! 🤖');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Bot ${PORT} portunda çalışıyor`);
});

